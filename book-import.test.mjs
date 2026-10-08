import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout } from 'node:timers/promises'
import { createBookImporter } from './book-import.mjs'
import { createCoursePlanner } from './course-planner.mjs'
import { textPdf } from './test-fixtures/pdf.mjs'

test('large imports plan at most four chapters concurrently, isolate failures and reuse ready plans on retry', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'saywell-parallel-import-'))
  t.after(() => { assert.ok(directory.startsWith(join(tmpdir(), 'saywell-parallel-import-'))); return rm(directory, { recursive: true, force: true }) })
  let running = 0, peak = 0, calls = 0, fail = true, indexed = 0
  const ready = new Map(), saved = new Map()
  const planner = {
    sectionCount() { return 2 },
    async prepare(document, progress) {
      if (ready.has(document.id)) return ready.get(document.id)
      calls++; running++; peak = Math.max(peak, running)
      try {
        await progress({ completed: 0, total: 2, attempt: 1, timeoutSeconds: 120 })
        await setTimeout(20)
        if (fail && /Lesson 2\b/.test(document.title)) throw new Error('one chapter failed')
        await progress({ completed: 2, total: 2 })
        const result = { units: 1 }
        ready.set(document.id, result)
        return result
      } finally { running-- }
    },
  }
  const rag = {
    async addDocuments(documents) { for (const document of documents) saved.set(document.id, document); return { added: documents.length } },
    async index() { indexed++; assert.equal(ready.size, 6); return { collection: 'test' } },
  }
  const importer = createBookImporter({ rag, directory, planner })
  const job = await importer.create({ originalname: 'book.txt', buffer: Buffer.from(Array.from({ length: 6 }, (_, index) => `Lesson ${index + 1}\nHello there. Here is enough text for importing.`).join('\n')) }, 'A1')
  async function finished() {
    for (let index = 0; index < 300; index++) { const state = await importer.get(job.id); if (['complete', 'failed'].includes(state.status)) return state; await setTimeout(5) }
    throw new Error('Import did not finish')
  }
  const failed = await finished()
  assert.equal(failed.status, 'failed'); assert.equal(failed.failures.length, 1)
  assert.equal(failed.plannedLessons, 5); assert.equal(failed.readyLessons, 5); assert.equal(failed.readyDocumentIds.length, 5)
  assert.equal(peak, 4); assert.equal(calls, 6); assert.equal(indexed, 0); assert.equal(importer.active(), null)
  fail = false
  await importer.retry(job.id)
  assert.ok(importer.active())
  const complete = await finished()
  assert.equal(complete.status, 'complete'); assert.equal(complete.readyLessons, 6)
  assert.equal(calls, 7); assert.equal(indexed, 1); assert.equal(importer.active(), null)
  assert.throws(() => createBookImporter({ rag, directory, planner, planningConcurrency: 8 }))
})

test('imports persist status, retry failures and preserve stable document IDs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'saywell-book-test-'))
  const saved = new Map()
  let fail = true
  const rag = {
    async addDocuments(documents) {
      let added = 0
      for (const document of documents) {
        assert.equal(document.format, 'raw')
        if (!saved.has(document.id)) { saved.set(document.id, document); added++ }
      }
      return { added }
    },
    async index(onProgress) {
      await onProgress(1, 2)
      if (fail) throw new Error('temporary embedding failure')
      await onProgress(2, 2)
      return { collection: 'test' }
    },
  }
  async function finished(importer, id) {
    for (let i = 0; i < 200; i++) {
      const job = await importer.get(id)
      if (job.status === 'failed' || job.status === 'complete') return job
      await setTimeout(10)
    }
    throw new Error('Import did not finish')
  }
  try {
    const importer = createBookImporter({ rag, directory })
    const file = { originalname: 'book.txt', buffer: Buffer.from('Lesson 1 Greetings\nHello. Thank you. Good morning.\nLesson 2 Travel\nWhere is the station. I need a taxi.') }
    const created = await importer.create(file, 'A1')
    const failed = await finished(importer, created.id)
    assert.equal(failed.status, 'failed')
    assert.equal(saved.size, 2)
    assert.equal(failed.completed, 1)
    const restarted = createBookImporter({ rag, directory })
    await restarted.resume()
    assert.equal((await restarted.get(created.id)).status, 'failed')
    fail = false
    await restarted.retry(created.id)
    assert.equal((await finished(restarted, created.id)).status, 'complete')
    assert.equal(saved.size, 2)
    const duplicate = await restarted.create(file, 'A1')
    assert.equal((await finished(restarted, duplicate.id)).added, 0)
    assert.equal(saved.size, 2)
    await assert.rejects(() => restarted.get('../invalid'))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('a real uploaded PDF is analyzed before indexing; retries and existing-course planning preserve sources and IDs', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'saywell-ai-import-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const saved = new Map()
  let fail = true
  let aiCalls = 0
  let indexed = 0
  const plannerOptions = { directory: join(directory, 'plans'), baseUrl: 'http://test-ai', model: 'test-model', fetcher: async (_url, options) => {
    aiCalls++
    if (fail) throw new Error('temporary AI failure')
    const input = JSON.parse(JSON.parse(options.body).messages[1].content)
    const sourceId = input.sourceCandidates.find(candidate => candidate.example && candidate.text === 'Where is the station?').id
    return Response.json({ message: { content: JSON.stringify({ summary: 'บทเรียนการถามเส้นทาง', referenceReason: '', units: [{
      title: 'ถามหาสถานี', kind: 'conversation', explanation: 'ใช้ Where is เพื่อถามว่าสถานที่อยู่ที่ไหน',
      objectives: [{ goalThai: 'ถามสถานที่อย่างสุภาพ', evidenceId: sourceId }],
      examples: [{ sourceId, translation: 'สถานีอยู่ที่ไหน' }], practiceTask: 'ฟังแล้วพูดตามตัวอย่าง', requiresMedia: false,
    }] }) } })
  } }
  let planner = createCoursePlanner(plannerOptions)
  const rag = {
    async documents() { return [...saved.values()] },
    async addDocuments(documents) {
      let added = 0
      for (const document of documents) if (!saved.has(document.id)) { saved.set(document.id, document); added++ }
      return { added }
    },
    async index(onProgress) {
      for (const document of saved.values()) assert.equal(planner.snapshot(document).status, 'ready', 'indexing starts after plans are ready')
      indexed++
      await onProgress(1, 1)
      return { collection: 'test' }
    },
  }
  async function finished(importer, id) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const job = await importer.get(id)
      if (['failed', 'complete'].includes(job.status)) return job
      await setTimeout(10)
    }
    throw new Error('Import did not finish')
  }
  let importer = createBookImporter({ rag, directory: join(directory, 'jobs'), planner })
  const file = { originalname: 'New-Travel-Course.pdf', buffer: textPdf(['Goals', 'Ask where places are.', 'Conversation', 'Where is the station?', 'Thank you for your help.']) }
  const created = await importer.create(file, 'A2')
  const failed = await finished(importer, created.id)
  assert.equal(failed.status, 'failed')
  assert.equal(indexed, 0)
  assert.equal(saved.size, 1)
  const source = [...saved.values()][0]
  assert.equal(source.requiresPlanning, true)
  assert.ok(source.content.includes('Where is the station?'))
  assert.equal(source.pageStart, 1)
  planner = createCoursePlanner(plannerOptions)
  importer = createBookImporter({ rag, directory: join(directory, 'jobs'), planner })
  await importer.resume()
  fail = false
  await importer.retry(created.id)
  const ready = await finished(importer, created.id)
  assert.equal(ready.status, 'complete')
  assert.equal(ready.preparedUnits, 1)
  assert.equal(ready.plannedLessons, 1)
  assert.deepEqual(ready.documentIds, [source.id])
  assert.equal(indexed, 1)
  assert.equal(planner.snapshot(source).course.contentStats.analyzedCharacters, source.content.length)
  const previousCalls = aiCalls
  const duplicate = await importer.create(file, 'A2')
  assert.equal((await finished(importer, duplicate.id)).added, 0)
  const existing = await importer.createPlan(source)
  assert.equal((await finished(importer, existing.id)).status, 'complete')
  assert.equal(saved.size, 1)
  assert.equal(aiCalls, previousCalls)
  assert.equal([...saved.values()][0].content, source.content)
})
