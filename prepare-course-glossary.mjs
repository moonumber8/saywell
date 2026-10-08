import 'dotenv/config'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { parseCourseSource, glossaryKey } from './course-source.mjs'
import { createCourseAiProvider, createAiFetch } from './ai-provider.mjs'
const ai = createCourseAiProvider()
const fetch = createAiFetch(ai, process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434')

const documents = JSON.parse(await readFile('data/curriculum.json', 'utf8'))
const path = 'data/course-glossary.json'
let glossary = {}
try { glossary = JSON.parse(await readFile(path, 'utf8')) } catch { /* A new glossary. */ }
const all = new Map(documents.flatMap((document) => parseCourseSource(document)?.vocabulary || []).map((entry) => [glossaryKey(entry), entry]))
const missing = [...all].filter(([key]) => !glossary[key])
console.log(`${all.size} distinct source definitions; ${missing.length} translations to prepare`)
for (let start = 0; start < missing.length; start += 24) {
  const batch = missing.slice(start, start + 24)
  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), 180000)
  try {
    const format = { type: 'object', properties: { translations: { type: 'array', minItems: batch.length, maxItems: batch.length, items: { type: 'object', properties: { id: { type: 'integer', enum: batch.map((_, id) => id) }, thai: { type: 'string', pattern: '^[ก-๙].*' } }, required: ['id', 'thai'], additionalProperties: false } } }, required: ['translations'], additionalProperties: false }
    const response = await fetch(`${(process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '')}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal, body: JSON.stringify({ model: process.env.OLLAMA_MODEL || 'qwen3.5:9b', stream: false, think: false, format, options: { temperature: 0, num_ctx: 8192, num_predict: 2000 }, keep_alive: '30m', messages: [{ role: 'system', content: 'Translate source vocabulary definitions into concise natural Thai for English learners. Preserve the exact sense described in each definition, not another meaning of that word. Return JSON only: {"translations":[{"id":0,"thai":"..."}]}. Each thai should be a short meaning, not the English definition. Keep every numeric id exactly, starting with zero. Do not omit any item.' }, { role: 'user', content: JSON.stringify(batch.map(([, entry], id) => ({ id, word: entry.target, definition: entry.definition }))) }] }) })
    if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`)
    const data = await response.json()
    const parsed = JSON.parse(data.message?.content || '{}')
    for (const item of parsed.translations || []) {
      if (Number.isInteger(item.id) && batch[item.id] && typeof item.thai === 'string' && /[ก-๙]/u.test(item.thai) && item.thai.length <= 300) glossary[batch[item.id][0]] = item.thai.trim()
    }
    await writeFile(`${path}.tmp`, JSON.stringify(glossary, null, 2) + '\n')
    await rename(`${path}.tmp`, path)
    console.log(`${Math.min(start + 24, missing.length)} / ${missing.length} prepared (${Object.keys(glossary).length} cached)`)
  } catch (error) { console.error(`Batch ${start}: ${error.message}`) }
  finally { clearTimeout(deadline) }
}
const remaining = [...all.keys()].filter((key) => !glossary[key])
if (remaining.length) { console.error(`${remaining.length} translations remain; rerun to resume`); process.exitCode = 1 }
