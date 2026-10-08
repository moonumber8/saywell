import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { extractCurriculumFile, splitCurriculumBook } from './curriculum-files.mjs'

export function createBookImporter({ rag, directory, planner, planningConcurrency = 4 }) {
  if (!Number.isInteger(planningConcurrency) || planningConcurrency < 1 || planningConcurrency > 4) throw new Error('Planning concurrency must be 1–4')
  const jobs = new Map()
  let queue = Promise.resolve()
  let writes = Promise.resolve()
  const jobPath = (id) => join(directory, `${id}.json`)
  async function persist(job) {
    job.updatedAt = new Date().toISOString()
    const snapshot = JSON.stringify(job)
    // Workers share a job, so serialize atomic writes without sharing temp files.
    const writing = writes.then(async () => {
      await writeFile(`${jobPath(job.id)}.tmp`, snapshot)
      await rename(`${jobPath(job.id)}.tmp`, jobPath(job.id))
    })
    writes = writing.catch(() => {})
    await writing
  }
  async function get(id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid import ID')
    if (!jobs.has(id)) jobs.set(id, JSON.parse(await readFile(jobPath(id), 'utf8')))
    return { ...jobs.get(id) }
  }
  async function run(job) {
    try {
      job.status = 'extracting'; job.phase = 'extracting'; job.stageStartedAt = new Date().toISOString(); job.message = 'กำลังอ่านไฟล์และแบ่งตามบท'; job.error = undefined
      job.startedAt ||= new Date().toISOString()
      await persist(job)
      const buffer = await readFile(join(directory, `${job.id}.source`))
      const extracted = job.type === 'plan' ? null : await extractCurriculumFile({ originalname: job.filename, buffer }, { large: true })
      const sections = extracted ? splitCurriculumBook(extracted) : []
      const hash = createHash('sha256').update(buffer).update(job.level).digest('hex').slice(0, 24)
      let documents = sections.map((section, index) => ({ ...section, id: `book-${hash}-${index}`, level: job.level, format: 'raw', filename: job.filename, ...(planner ? { requiresPlanning: true } : {}) }))
      if (job.type === 'plan') {
        const document = (await rag.documents()).find(item => item.id === job.documentId)
        if (!document) throw new Error('ไม่พบต้นฉบับสำหรับเตรียมแผน')
        documents = [document]
      }
      job.lessons = documents.length
      job.pages = extracted?.pages?.length
      job.status = 'saving'; job.message = `กำลังบันทึก ${documents.length} บท`
      await persist(job)
      job.added = (await rag.addDocuments(documents)).added
      job.documentIds = documents.map(document => document.id)
      if (planner) {
        job.status = 'planning'; job.phase = 'planning'; job.plannedLessons = 0; job.preparedUnits = 0; job.completed = 0
        job.stageStartedAt = new Date().toISOString(); job.readyLessons = 0; job.readyDocumentIds = []; job.failures = []
        job.total = documents.reduce((sum, document) => sum + planner.sectionCount(document), 0)
        const completed = new Map(documents.map(document => [document.id, 0]))
        const active = new Map()
        let next = 0
        async function update() {
          job.completed = [...completed.values()].reduce((sum, count) => sum + count, 0)
          job.activeLessons = [...active.values()]
          job.message = `อ่านไฟล์แล้ว${job.pages ? ` ${job.pages} หน้า` : ''} · AI จัดแผน ${job.plannedLessons}/${documents.length} ส่วน · พร้อมเรียน ${job.readyLessons} บท · วิเคราะห์ ${job.completed}/${job.total} ส่วนย่อย`
          await persist(job)
        }
        async function worker() {
          while (next < documents.length) {
            const index = next++, document = documents[index]
            try {
              const result = await planner.prepare(document, async progress => {
                completed.set(document.id, progress.completed)
                active.set(document.id, { documentId: document.id, title: document.title, completed: progress.completed, total: progress.total, attempt: progress.attempt, timeoutSeconds: progress.timeoutSeconds, startedAt: new Date().toISOString() })
                await update()
              })
              completed.set(document.id, planner.sectionCount(document))
              job.plannedLessons++; job.preparedUnits += result.units
              if (result.units) { job.readyLessons++; job.readyDocumentIds.push(document.id) }
            } catch (error) {
              job.failures.push({ documentId: document.id, title: document.title, error: error.message })
            } finally { active.delete(document.id); await update() }
          }
        }
        await update()
        await Promise.all(Array.from({ length: Math.min(planningConcurrency, documents.length) }, worker))
        if (job.failures.length) throw new Error(`จัดแผนไม่สำเร็จ ${job.failures.length}/${documents.length} ส่วน · พร้อมเรียนแล้ว ${job.readyLessons} บท · ${job.failures[0].title}: ${job.failures[0].error}`)
      }
      job.status = 'indexing'; job.phase = 'indexing'; job.message = 'แบบเรียนพร้อมแล้ว กำลังเตรียมค้นเนื้อหาเพิ่มเติม'; job.completed = 0; job.total = 0
      job.stageStartedAt = new Date().toISOString()
      await persist(job)
      const result = await rag.index(async (completed, total) => {
        job.completed = completed; job.total = total
        await persist(job)
      })
      job.collection = result.collection
      job.status = 'complete'; job.message = planner ? job.preparedUnits ? `นำเข้า ${documents.length} บท · เตรียมแบบเรียน ${job.preparedUnits} หัวข้อ พร้อมเรียนได้ทันที` : `นำเข้าข้อมูลประกอบ ${documents.length} ส่วน พร้อมอ่านต้นฉบับ` : `นำเข้า ${documents.length} บทและสร้างเวกเตอร์เรียบร้อย`
      await persist(job)
      await unlink(join(directory, `${job.id}.source`)).catch(() => {})
    } catch (error) {
      job.status = 'failed'; job.error = error.message; job.message = 'นำเข้ายังไม่สำเร็จ กดลองต่อได้'; await persist(job)
    }
  }
  function schedule(job) { queue = queue.then(() => run(job)).catch(() => {}) }
  async function enqueue(file, level, fields = {}) {
    await mkdir(directory, { recursive: true })
    const active = [...jobs.values()].filter(job => !['complete', 'failed'].includes(job.status))
    if (active.length >= 3) throw new Error('มีไฟล์กำลังนำเข้าอยู่ กรุณารอให้เสร็จก่อน')
    const job = { id: randomUUID(), filename: file.originalname, level, status: 'queued', message: 'รอนำเข้าและจัดแบบเรียน', completed: 0, total: 0, ...fields }
    await writeFile(join(directory, `${job.id}.source`), file.buffer)
    jobs.set(job.id, job)
    await persist(job)
    schedule(job)
    return { ...job }
  }
  return {
    get,
    active() { const pending = [...jobs.values()].filter(job => !['complete', 'failed'].includes(job.status)); return pending.find(job => job.status !== 'queued') || pending[0] || null },
    async create(file, level) {
      return enqueue(file, level)
    },
    async createPlan(document) {
      if (!planner) throw new Error('ยังไม่ได้เปิดการวิเคราะห์หลักสูตร')
      return enqueue({ originalname: document.filename || `${document.title}.txt`, buffer: Buffer.from(JSON.stringify({ documentId: document.id })) }, document.level, { type: 'plan', documentId: document.id })
    },
    async retry(id) {
      const job = await get(id)
      if (job.status !== 'failed') throw new Error('งานนี้ไม่ได้อยู่ในสถานะที่ลองต่อได้')
      job.status = 'queued'; job.error = undefined; job.message = 'รอนำเข้าต่อ'
      jobs.set(id, job)
      await persist(job); schedule(job)
      return { ...job }
    },
    async resume() {
      await mkdir(directory, { recursive: true })
      for (const name of await readdir(directory)) {
        if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue
        const job = JSON.parse(await readFile(join(directory, name), 'utf8'))
        jobs.set(job.id, job)
        if (!['complete', 'failed'].includes(job.status)) schedule(job)
      }
    },
  }
}
