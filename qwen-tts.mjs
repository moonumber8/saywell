import { createCachedTts, createTtsRouter as audioRouter } from './example-audio.mjs'
export { validateTtsInput } from './example-audio.mjs'
import { fileURLToPath } from 'node:url'
import { qwenRealtimeEndpoint } from './qwen-realtime.mjs'

export const ttsModel = 'qwen3-tts-instruct-flash'
const maxBytes = 8 * 1024 * 1024
const instructions = {
  normal: 'Read the supplied English text exactly as written. Use clear, natural American English pronunciation, a warm teaching voice, and a comfortable conversational pace. Preserve natural word stress and sentence intonation.',
  slow: 'Read the supplied English text exactly as written. Use clear American English pronunciation at a slow pace for a beginner repeating after a teacher. Use gentle pauses between meaningful phrases while keeping connected speech, word stress and sentence intonation natural.',
}
export function ttsEndpoint({ endpoint, workspaceId, region }) {
  if (endpoint) {
    const address = new URL(endpoint)
    if (address.protocol !== 'https:' || address.username || address.password || address.search || address.hash) throw new Error('QWEN_TTS_URL ต้องเป็น HTTPS ที่ไม่มีรหัสผ่านหรือ query')
    return address.href
  }
  const address = qwenRealtimeEndpoint({ workspaceId, region })
  address.protocol = 'https:'
  address.pathname = '/api/v1/services/aigc/multimodal-generation/generation'
  return address.href
}
export function createQwenTts({ apiKey, endpoint, workspaceId, region, voice = 'Cherry', directory = fileURLToPath(new URL('./data/tts-audio/', import.meta.url)), fetcher = fetch, timeoutMs = 60000 } = {}) {
  if (!apiKey?.trim()) throw new Error('กรุณาตั้งค่า QWEN_API_KEY ฝั่งเซิร์ฟเวอร์สำหรับเสียงตัวอย่าง')
  const address = ttsEndpoint({ endpoint, workspaceId, region })
  const safe = message => String(message || '').replaceAll(apiKey, '[redacted]').replace(/sk-[A-Za-z0-9_.-]+/g, '[redacted]').slice(0, 300)
  async function generate(input, signal) {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    const response = await fetcher(address, { method: 'POST', signal: deadline, headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: ttsModel, input: { text: input.text, voice, language_type: 'English', instructions: instructions[input.speed], optimize_instructions: false } }) })
    const body = await response.json()
    deadline.throwIfAborted()
    if (!response.ok || body.code || (body.status_code && body.status_code !== 200)) throw new Error(`Qwen TTS ${body.code || response.status}: ${safe(body.message || body.error?.message || 'request failed')}`)
    const url = new URL(body.output?.audio?.url)
    // Only download the provider's audio; never forward credentials or follow redirects.
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname.endsWith('.aliyuncs.com') || url.username || url.password || url.port) throw new Error('บริการเสียงส่งที่อยู่ไฟล์ไม่ถูกต้อง')
    url.protocol = 'https:'
    const audio = await fetcher(url.href, { signal: deadline, redirect: 'error' })
    if (!audio.ok || Number(audio.headers.get('content-length') || 0) > maxBytes) throw new Error('ดาวน์โหลดเสียงตัวอย่างไม่สำเร็จ')
    const reader = audio.body.getReader(), chunks = []
    let length = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        length += value.length
        if (length > maxBytes) throw new Error('ไฟล์เสียงตัวอย่างใหญ่เกินกำหนด')
        chunks.push(Buffer.from(value))
      }
    } catch (error) { await reader.cancel().catch(() => {}); throw error }
    deadline.throwIfAborted()
    const bytes = Buffer.concat(chunks)
    return bytes
  }
  return createCachedTts({ model: ttsModel, voice, revision: JSON.stringify(instructions), directory, generate })
}
export function createTtsRouter(synthesize) { return audioRouter(synthesize, ttsModel) }
