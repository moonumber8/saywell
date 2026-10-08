import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { chunkDocument, validateLesson, validateTopics } from './rag.mjs'

export const courseFingerprint = (document) => createHash('sha256').update(JSON.stringify(document)).digest('hex')

export async function loadDemo(path, documents, model) {
  let file
  try { file = JSON.parse(await readFile(path, 'utf8')) } catch { return [] }
  if (file.model !== model || !Array.isArray(file.entries)) return []
  return file.entries.flatMap((entry) => {
    const document = documents.find((item) => item.id === entry.documentId)
    if (!document || entry.fingerprint !== courseFingerprint(document)) return []
    try {
      const chunks = chunkDocument(document)
      const sources = entry.lesson.sources.map((source) => chunks.find((chunk) => chunk.id === source.id)).filter(Boolean)
      const lesson = validateLesson(structuredClone(entry.lesson), sources)
      const topics = validateTopics(entry.topics, chunks)
      if (!topics.length) return []
      return [{ documentId: document.id, topics, query: entry.query, lesson: { ...lesson, sources }, prepared: true }]
    } catch { return [] }
  })
}
