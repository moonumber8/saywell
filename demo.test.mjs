import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadDemo } from './demo.mjs'
import { buildActivities } from './src/lesson-activities.ts'

test('all three prepared demo lessons have validated sources and usable practice modes', async () => {
  const documents = JSON.parse(await readFile('data/curriculum.json', 'utf8'))
  const { model } = JSON.parse(await readFile('data/demo-lessons.json', 'utf8'))
  assert.ok(typeof model === 'string' && model.length > 0)
  const entries = await loadDemo('data/demo-lessons.json', documents, model)
  assert.equal(entries.length, 3)
  for (const entry of entries) {
    assert.ok(entry.topics.length > 0)
    assert.ok(entry.lesson.sources.every((source) => source.documentId === entry.documentId && source.pageStart))
    for (const mode of ['mixed', 'choice', 'listen', 'arrange', 'fill', 'match']) assert.ok(buildActivities(entry.lesson.exercises, mode).length)
  }
  assert.deepEqual(await loadDemo('data/demo-lessons.json', documents, 'different-model'), [])
  assert.deepEqual(await loadDemo('data/demo-lessons.json', documents.map((document) => ({ ...document, content: `${document.content}\nChanged` })), model), [])
})

test('prepared lessons are checked against actual curriculum, not stored source text', async () => {
  const documents = JSON.parse(await readFile('data/curriculum.json', 'utf8'))
  const file = JSON.parse(await readFile('data/demo-lessons.json', 'utf8'))
  const directory = await mkdtemp(join(tmpdir(), 'saywell-demo-'))
  try {
    const entry = file.entries[0]
    entry.lesson.exercises[0].target = 'Invented phrase'
    entry.lesson.sources.forEach((source) => { source.content += '\nInvented phrase' })
    const path = join(directory, 'demo.json')
    await writeFile(path, JSON.stringify({ ...file, entries: [entry] }))
    assert.deepEqual(await loadDemo(path, documents, file.model), [])
  } finally { await rm(directory, { recursive: true, force: true }) }
})
