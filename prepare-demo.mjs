import 'dotenv/config'
import { writeFile, rename } from 'node:fs/promises'
import { createRag } from './rag.mjs'
import { courseFingerprint } from './demo.mjs'
import { createAiProvider, createAiFetch } from './ai-provider.mjs'

const ai = createAiProvider()
const model = ai.model
const baseUrl = process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434'
const rag = createRag({ baseUrl, chatModel: model, fetcher: createAiFetch(ai, baseUrl), embeddingModel: process.env.OLLAMA_EMBEDDING_MODEL ?? 'qwen3-embedding:4b', documentsPath: 'data/curriculum.json', qdrantUrl: process.env.QDRANT_URL ?? 'http://127.0.0.1:6333', collectionPrefix: process.env.QDRANT_COLLECTION ?? 'saywell_curriculum', qdrantApiKey: process.env.QDRANT_API_KEY })
const entries = []
for (const number of [1, 2, 3]) {
  const document = (await rag.documents()).find((item) => item.level === 'A1' && /VOA/i.test(item.title) && item.title.endsWith(`Lesson ${number}`))
  if (!document) throw new Error(`Missing VOA Lesson ${number}`)
  const { topics } = await rag.topics({ documentId: document.id, level: document.level, signal: AbortSignal.timeout(90000) })
  const query = `${topics[0].label}: ${topics[0].examples.map((example) => example.target).join(' / ')}`
  const lesson = await rag.lesson({ documentId: document.id, level: document.level, query, signal: AbortSignal.timeout(180000) })
  entries.push({ documentId: document.id, fingerprint: courseFingerprint(document), query, topics, lesson })
  console.log(`Prepared Lesson ${number}: ${topics[0].label} (${lesson.exercises.length} phrases)`)
}
await writeFile('data/demo-lessons.json.tmp', JSON.stringify({ model, entries }, null, 2))
await rename('data/demo-lessons.json.tmp', 'data/demo-lessons.json')
