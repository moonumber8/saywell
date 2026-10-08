import 'dotenv/config'
import express from 'express'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { createRag } from './rag.mjs'
import multer from 'multer'
import { extname } from 'node:path'
import { extractCurriculumFile, supportedExtensions, maxFileBytes } from './curriculum-files.mjs'
import { createBookImporter } from './book-import.mjs'
import { createSpeechCoach, validateSpeechInput } from './speech-coach.mjs'
import { loadDemo } from './demo.mjs'
import { buildStructuredCourse, structuredMetadata, gradeUnit } from './structured-course.mjs'
import { createCoursePlanner } from './course-planner.mjs'
import { buildStructuredCourse as reviewedCourse } from './full-course.mjs'
import { createAiProvider, createCourseAiProvider, createAiFetch } from './ai-provider.mjs'
import { createQwenTranscriber, createTranscriptionRouter } from './qwen-transcription.mjs'
import { createKokoroTts, kokoroModel } from './kokoro-tts.mjs'
import { createTtsRouter } from './example-audio.mjs'

const app = express()
const port = Number(process.env.PORT ?? 3001)
const ollamaBaseUrl = (process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434').replace(/\/+$/, '')
const ollamaModel = process.env.OLLAMA_MODEL ?? 'qwen3.5:9b'
const ai = createAiProvider()
const aiFetch = createAiFetch(ai, ollamaBaseUrl)
const courseAi = createCourseAiProvider()
const courseAiFetch = createAiFetch(courseAi, ollamaBaseUrl)
let dataRevision
try { dataRevision = JSON.parse(readFileSync(new URL('./data/reset.json', import.meta.url), 'utf8')).revision } catch { /* No reset yet. */ }

app.use(express.json({ limit: '128kb' }))
// ASR is independent of the text-generation provider. This lets the app use
// the dedicated recognizer without requiring the Omni realtime model.
const asrModel = process.env.QWEN_ASR_MODEL || 'qwen3-asr-flash-realtime'
const transcribe = process.env.QWEN_API_KEY && (process.env.QWEN_REALTIME_URL || process.env.QWEN_WORKSPACE_ID)
  ? createQwenTranscriber({ apiKey: process.env.QWEN_API_KEY, endpoint: process.env.QWEN_REALTIME_URL, workspaceId: process.env.QWEN_WORKSPACE_ID, region: process.env.QWEN_REGION, model: asrModel })
  : null
app.use('/api/speaking', createTranscriptionRouter(transcribe))
const exampleAudio = createKokoroTts()
app.use('/api/speaking', createTtsRouter(exampleAudio, kokoroModel))

const speechCoach = createSpeechCoach({ baseUrl: ollamaBaseUrl, model: ai.model, fetcher: aiFetch })
app.post('/api/speaking/advice', async (req, res) => {
  let input
  try { input = validateSpeechInput(req.body) }
  catch (error) { return res.status(400).json({ error: error.message }) }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error('AI แนะนำช้าเกินไป กดฝึกต่อหรือลองขอคำแนะนำใหม่ได้')), 60000)
  const disconnected = () => { if (!res.writableEnded) controller.abort() }
  res.on('close', disconnected)
  try {
    const advice = await speechCoach(input, controller.signal)
    if (!res.destroyed) res.json(advice)
  } catch (error) {
    if (!res.destroyed) res.status(controller.signal.aborted ? 504 : 503).json({ error: controller.signal.aborted ? 'AI แนะนำช้าเกินไป กดฝึกต่อหรือลองขอคำแนะนำใหม่ได้' : error.message || 'เชื่อมต่อ AI ไม่ได้ กรุณาลองใหม่' })
  } finally { clearTimeout(timeout); res.off('close', disconnected) }
})

const rag = createRag({
  baseUrl: ollamaBaseUrl,
  chatModel: ai.model,
  fetcher: aiFetch,
  embeddingModel: process.env.OLLAMA_EMBEDDING_MODEL ?? 'qwen3-embedding:4b',
  documentsPath: fileURLToPath(new URL('./data/curriculum.json', import.meta.url)),
  legacyIndexPath: fileURLToPath(new URL('./data/embedding-index.json', import.meta.url)),
  qdrantUrl: process.env.QDRANT_URL ?? 'http://127.0.0.1:6333',
  collectionPrefix: process.env.QDRANT_COLLECTION ?? 'saywell_curriculum',
  qdrantApiKey: process.env.QDRANT_API_KEY,
})

const coursePlanner = createCoursePlanner({ baseUrl: ollamaBaseUrl, model: courseAi.model, fetcher: courseAiFetch, reviewedPlan: document => {
  if (/VOA.*Learn.*English/i.test(document.title) && document.title.endsWith('Introduction')) return { units: [] }
  return reviewedCourse(document)
} })
const bookImporter = createBookImporter({ rag, planner: coursePlanner, directory: fileURLToPath(new URL('./data/imports/', import.meta.url)) })
await bookImporter.resume()
const demoPath = fileURLToPath(new URL('./data/demo-lessons.json', import.meta.url))
const demos = async () => loadDemo(demoPath, await rag.documents(), ai.model)

app.get('/api/curriculum', async (_req, res) => {
  try {
    const prepared = await demos()
    const documents = (await rag.documents()).map(({ id, title, level, pageStart, pageEnd, filename, content, requiresPlanning }) => {
      const demo = prepared.find((entry) => entry.documentId === id)
      const topic = demo?.topics[0]?.label || content.match(/Topics\s*\n([^\n]+)/i)?.[1]?.trim()
      const preview = demo?.lesson.exercises.slice(0, 2).map((phrase) => phrase.target).join(' · ')
      const document = { id, title, level, pageStart, pageEnd, filename, content, requiresPlanning }
      const isGuide = /VOA.*Learn.*English/i.test(title) && title.endsWith('Introduction')
      let metadata
      let structuredError
      try { metadata = structuredMetadata(document) } catch (error) { structuredError = error.message }
      return { id, title, level, pageStart, pageEnd, filename, characters: content.length, topic, preview, demoReady: Boolean(demo), structured: false, isGuide, ...(structuredError ? { structuredError } : {}), ...metadata }
    })
    res.json({ documents, canManage: true, audioTranscription: Boolean(transcribe), activeImport: bookImporter.active(), ...(dataRevision ? { dataRevision } : {}) })
  } catch { res.status(503).json({ error: 'อ่านหลักสูตรไม่ได้ กรุณาตรวจสอบไฟล์หลักสูตร' }) }
})

app.get('/api/curriculum/documents/:id', async (req, res) => {
  try {
    const document = (await rag.documents()).find((item) => item.id === req.params.id)
    if (!document) return res.status(404).json({ error: 'ไม่พบเนื้อหาหลักสูตรนี้' })
    res.json(document)
  } catch { res.status(503).json({ error: 'อ่านเนื้อหาหลักสูตรไม่ได้ กรุณาลองใหม่' }) }
})

app.get('/api/curriculum/structured/:id', async (req, res) => {
  try {
    const course = buildStructuredCourse((await rag.documents()).find((item) => item.id === req.params.id))
    if (!course) return res.status(404).json({ error: 'ส่วนนี้เป็นคู่มือหรือยังไม่มีโครงสร้างหลักสูตรที่ตรวจสอบแล้ว' })
    res.json(course)
  } catch (error) { res.status(503).json({ error: error.message }) }
})
app.post('/api/curriculum/structured/:id/check', async (req, res) => {
  try {
    const course = buildStructuredCourse((await rag.documents()).find((item) => item.id === req.params.id))
    if (!course) return res.status(404).json({ error: 'ไม่พบหลักสูตร' })
    if (req.body?.revision !== course.revision) return res.status(409).json({ error: 'เนื้อหาหลักสูตรเปลี่ยนแล้ว กรุณารีเฟรชเพื่อเรียนฉบับใหม่' })
    res.json(gradeUnit(course, req.body.unitId, req.body.answers, req.body.reflection))
  } catch (error) { res.status(400).json({ error: error.message }) }
})

app.post('/api/curriculum/topics', async (req, res) => {
  const { documentId, level } = req.body ?? {}
  if (typeof documentId !== 'string' || !documentId || documentId.length > 100 || !['A1', 'A2', 'B1', 'B2'].includes(level)) return res.status(400).json({ error: 'เลือกหลักสูตรและระดับภาษาก่อนให้ AI แนะนำ' })
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error('AI แนะนำหัวข้อใช้เวลานานเกินไป กรุณาลองอีกครั้ง')), 90000)
  const disconnected = () => { if (!res.writableEnded) controller.abort() }
  res.on('close', disconnected)
  try {
    const demo = (await demos()).find((entry) => entry.documentId === documentId && entry.lesson.level === level)
    const result = demo ? { documentId, topics: demo.topics, preparedLesson: demo.lesson, preparedQuery: demo.query } : await rag.topics({ documentId, level, signal: controller.signal })
    if (!res.destroyed) res.json(result)
  } catch (error) {
    if (!res.destroyed) res.status(controller.signal.aborted ? 504 : 503).json({ error: controller.signal.aborted ? 'AI แนะนำหัวข้อใช้เวลานานเกินไป กรุณาลองอีกครั้ง' : error.message })
  } finally { clearTimeout(timeout); res.off('close', disconnected) }
})

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxFileBytes, files: 1, fields: 1, fieldSize: 32, parts: 2 },
  fileFilter: (_req, file, callback) => {
    if (!supportedExtensions.has(extname(file.originalname).toLowerCase())) return callback(new Error('รองรับไฟล์ TXT, Markdown, PDF และ DOCX เท่านั้น'))
    callback(null, true)
  },
}).single('file')

app.post('/api/curriculum/upload', (req, res) => {
  upload(req, res, async (error) => {
    if (error) return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'ไฟล์ต้องไม่เกิน 50 MB' : error.message })
    if (!req.file || !['A1', 'A2', 'B1', 'B2'].includes(req.body?.level)) return res.status(400).json({ error: 'เลือกไฟล์และระดับภาษาก่อนอัปโหลด' })
    try {
      const extracted = await extractCurriculumFile(req.file)
      res.json({ title: extracted.title, content: extracted.content, translated: false, planningOnSave: true })
    } catch (caught) { res.status(400).json({ error: caught.message || 'อ่านไฟล์ไม่ได้ กรุณาตรวจสอบไฟล์' }) }
  })
})

app.post('/api/curriculum/import', (req, res) => {
  upload(req, res, async (error) => {
    if (error) return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'ไฟล์ต้องไม่เกิน 50 MB' : error.message })
    if (!req.file || !['A1', 'A2', 'B1', 'B2'].includes(req.body?.level)) return res.status(400).json({ error: 'เลือกไฟล์และระดับภาษาก่อนนำเข้า' })
    try { res.status(202).json(await bookImporter.create(req.file, req.body.level)) }
    catch (caught) { res.status(400).json({ error: caught.message }) }
  })
})
app.get('/api/curriculum/import/:id', async (req, res) => {
  try { res.json(await bookImporter.get(req.params.id)) }
  catch { res.status(404).json({ error: 'ไม่พบงานนำเข้านี้' }) }
})
app.post('/api/curriculum/import/:id/retry', async (req, res) => {
  try { res.status(202).json(await bookImporter.retry(req.params.id)) }
  catch (error) { res.status(400).json({ error: error.message }) }
})
app.post('/api/curriculum/documents/:id/prepare', async (req, res) => {
  try {
    const document = (await rag.documents()).find(item => item.id === req.params.id)
    if (!document) return res.status(404).json({ error: 'ไม่พบหลักสูตรนี้' })
    res.status(202).json(await bookImporter.createPlan(document))
  } catch (error) { res.status(400).json({ error: error.message }) }
})

app.post('/api/curriculum/index', async (_req, res) => {
  try { res.json(await rag.index()) }
  catch (error) { res.status(503).json({ error: error.message }) }
})

app.post('/api/curriculum', async (req, res) => {
  const { title, level, content } = req.body ?? {}
  if (typeof title !== 'string' || !title.trim() || title.length > 120 || !['A1', 'A2', 'B1', 'B2'].includes(level) || typeof content !== 'string' || content.trim().length < 30 || content.length > 30000) return res.status(400).json({ error: 'ระบุชื่อ ระดับ และเนื้อหาหลักสูตร 30–30,000 ตัวอักษร' })
  try {
    res.status(202).json(await bookImporter.create({ originalname: `${title.trim().replace(/[\r\n\\/]/g, ' ')}.txt`, buffer: Buffer.from(content) }, level))
  }
  catch (error) { res.status(400).json({ error: error.message }) }
})

app.post('/api/curriculum/lesson', async (req, res) => {
  const { query, level, documentId } = req.body ?? {}
  if (typeof query !== 'string' || !query.trim() || query.length > 500 || !['A1', 'A2', 'B1', 'B2'].includes(level) || (documentId !== undefined && (typeof documentId !== 'string' || documentId.length > 100))) return res.status(400).json({ error: 'ระบุหัวข้อและระดับหลักสูตรให้ถูกต้อง' })
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error('สร้างบทเรียนเกิน 3 นาที กรุณาลองเลือกบทที่เฉพาะเจาะจงแล้วลองใหม่')), 180000)
  const disconnected = () => { if (!res.writableEnded) controller.abort(new Error('ยกเลิกการสร้างบทเรียนแล้ว')) }
  res.on('close', disconnected)
  const streaming = req.get('accept')?.includes('application/x-ndjson')
  const send = (event) => { if (!res.destroyed && !res.writableEnded) res.write(`${JSON.stringify(event)}\n`) }
  if (streaming) {
    res.set({ 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' })
    res.flushHeaders()
  }
  try {
    const lesson = await rag.lesson({ query: query.trim(), level, documentId, signal: controller.signal, onProgress: streaming ? (message) => send({ type: 'progress', message }) : undefined })
    if (streaming) { send({ type: 'lesson', lesson }); res.end() }
    else if (!res.destroyed) res.json(lesson)
  } catch (error) {
    const message = controller.signal.aborted ? controller.signal.reason.message : error.message || 'เชื่อมต่อ AI ไม่ได้ กรุณาลองใหม่'
    if (streaming) { send({ type: 'error', error: message }); res.end() }
    else if (!res.destroyed) res.status(controller.signal.aborted ? 504 : 503).json({ error: message })
  } finally { clearTimeout(timeout); res.off('close', disconnected) }
})

const allowedLevels = new Set(['A1', 'A2', 'B1', 'B2'])
const allowedLessons = new Set([
  'Everyday conversation',
  'Travel English',
  'Job interview practice',
  'Grammar and vocabulary',
])

async function warmOllama() {
  try {
    const response = await fetch(`${ollamaBaseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ollamaModel,
        messages: [],
        think: false,
        options: { num_ctx: 8192, num_predict: 256 },
        keep_alive: '30m',
      }),
      signal: AbortSignal.timeout(180_000),
    })

    if (!response.ok) {
      console.warn(`Ollama model warmup failed with HTTP ${response.status}.`)
      return
    }

    console.log(`Ollama model ${ollamaModel} is ready for chat.`)
  } catch {
    console.warn('Ollama is not reachable; local Qwen chat will be unavailable until it starts.')
  }
}

app.post('/api/ollama/chat', async (req, res) => {
  const { message, history = [], level, lesson, thaiSupport = true } = req.body ?? {}

  if (typeof message !== 'string' || !message.trim() || message.length > 1000) {
    return res.status(400).json({ error: 'Enter a message up to 1,000 characters.' })
  }
  if (!allowedLevels.has(level) || !allowedLessons.has(lesson) || typeof thaiSupport !== 'boolean') {
    return res.status(400).json({ error: 'Choose a valid level, lesson topic, and language setting.' })
  }
  if (!Array.isArray(history) || history.length > 12) {
    return res.status(400).json({ error: 'Chat history is invalid. Start a new lesson and try again.' })
  }

  const safeHistory = []
  for (const item of history) {
    if (
      !item ||
      !['user', 'assistant'].includes(item.role) ||
      typeof item.content !== 'string' ||
      item.content.length > 1000
    ) {
      return res.status(400).json({ error: 'Chat history contains an invalid message.' })
    }
    safeHistory.push({ role: item.role, content: item.content })
  }

  const languageRule = thaiSupport
    ? 'You are a female teacher. Answer the learner’s request when it is relevant to the selected lesson, not with a generic greeting. Explain in Thai and provide the specific English phrase or information requested with its Thai meaning. If the request is unrelated, acknowledge briefly and guide the learner back to the lesson. Use ค่ะ for polite statements and คะ for polite questions naturally. Never use ครับ, ผม, or กระผม, and do not force a particle at the end of every sentence.'
    : 'Answer the learner’s exact question directly in simple English. Never change the topic or add unrelated advice.'
  const systemPrompt = [
    'You are a concise, patient English tutor.',
    `The learner's CEFR level is ${level}; today's topic is ${lesson}.`,
    languageRule,
    'Treat this as one continuous lesson. Use the conversation history to remember what the learner has already said, which examples you taught, and what they are practicing now. Build on prior turns instead of restarting, repeating greetings, or repeating completed exercises.',
    'Stay focused on the selected lesson topic. If the learner goes off-topic, acknowledge briefly and gently guide them back to the current exercise. Keep each reply to at most three short sentences and ask at most one follow-up question that advances the lesson.',
    'Correct only one useful error at a time. Be kind. Do not use markdown or lists.',
  ].join(' ')

  try {
    const upstream = await aiFetch(`${ollamaBaseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ai.model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...safeHistory,
          {
            role: 'user',
            content: thaiSupport
              ? `Selected lesson topic: ${lesson}. Learner level: ${level}. Learner message: "${message.trim()}". Keep the reply within the selected lesson. If this message is unrelated, politely redirect to the lesson. If it is relevant, answer in Thai and give one relevant English example with its Thai translation when useful.`
              : `Answer this question directly in English: ${message.trim()}`,
          },
        ],
        stream: false,
        think: false,
        options: { temperature: 0.3, num_ctx: 8192, num_predict: 256 },
        keep_alive: '30m',
      }),
      signal: AbortSignal.timeout(180_000),
    })
    const data = await upstream.json().catch(() => ({}))

    if (!upstream.ok) {
      const error = data.error ?? 'Ollama could not generate a reply.'
      return res.status(upstream.status === 404 ? 503 : upstream.status).json({ error })
    }

    const reply = data.message?.content?.trim()
    if (!reply) return res.status(502).json({ error: 'Qwen returned an empty reply.' })

    return res.json({ reply, model: ai.model })
  } catch (caught) {
    if (caught.name === 'TimeoutError') {
      return res.status(504).json({ error: 'Qwen took too long to reply. Please try again.' })
    }
    return res.status(503).json({ error: caught.message || 'Cannot reach the AI service. Please try again.' })
  }
})

app.listen(port, () => {
  console.log(`Saywell API listening on http://localhost:${port}`)
  console.log(`Text generation: ${ai.provider} / ${ai.model}`)
  console.log(`Course preparation: ${courseAi.provider} / ${courseAi.model}`)
  if (ai.provider === 'ollama') void warmOllama()
})
