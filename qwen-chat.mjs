import { qwenRealtimeEndpoint } from './qwen-realtime.mjs'

export function qwenChatEndpoint({ baseUrl, workspaceId, region }) {
  let url
  try {
    if (baseUrl) url = new URL(baseUrl)
    else { url = qwenRealtimeEndpoint({ workspaceId, region }); url.protocol = 'https:'; url.pathname = '/compatible-mode/v1' }
  } catch { throw new Error('กรุณาตรวจ QWEN_CHAT_BASE_URL หรือ workspace ของ Qwen') }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('QWEN_CHAT_BASE_URL ต้องเป็น HTTPS ที่ไม่มีรหัสผ่านหรือ query ใน URL')
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/chat/completions`
  return url.href
}

export function createQwenChat({ apiKey, baseUrl, workspaceId, region, model = 'qwen3.8-max', structuredMode = 'json_schema', timeoutMs = 120000, fetcher = fetch }) {
  const endpoint = qwenChatEndpoint({ baseUrl, workspaceId, region })
  if (!apiKey?.trim()) throw new Error('กรุณาตั้งค่า QWEN_API_KEY ฝั่งเซิร์ฟเวอร์')
  if (!['json_schema', 'json_object'].includes(structuredMode)) throw new Error('QWEN_STRUCTURED_MODE ต้องเป็น json_schema หรือ json_object')
  const safe = value => String(value || '').replaceAll(apiKey, '[redacted]').replace(/sk-[A-Za-z0-9_.-]+/g, '[redacted]').slice(0, 400)
  return async function generate({ messages, format, options = {} }, signal) {
    signal?.throwIfAborted()
    const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
    let response
    try {
      response = await fetcher(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, signal: deadline,
        body: JSON.stringify({ model, messages: format && structuredMode === 'json_object' ? [{ role: 'system', content: `Return only one complete JSON object matching this JSON Schema exactly. Keep Thai explanations concise and natural. Write explanations, goals, translations and task instructions in Thai with English learning terms where needed; avoid unrelated foreign scripts. Preserve all required fields, nested objects and allowed enum values. JSON_SCHEMA=${JSON.stringify(format)}` }, ...messages] : messages, stream: false, enable_thinking: false,
          ...(/^qwen3\.8-(?:max|flash|27b)(?:-|$)/.test(model) ? { reasoning_effort: 'none' } : {}),
          temperature: options.temperature ?? 0, max_tokens: options.num_predict || 4500,
          ...(format ? { response_format: structuredMode === 'json_object' ? { type: 'json_object' } : { type: 'json_schema', json_schema: { name: 'course_result', strict: true, schema: format } } } : {}),
        }),
      })
    } catch {
      deadline.throwIfAborted()
      throw new Error('เชื่อมต่อ Qwen API ไม่ได้ กรุณาตรวจ endpoint และการเชื่อมต่อ')
    }
    let body
    try { body = await response.json() } catch {
      deadline.throwIfAborted()
      throw new Error('Qwen API ส่งข้อมูลไม่ครบ กรุณาลองใหม่')
    }
    deadline.throwIfAborted()
    if (!response.ok) throw new Error(`Qwen API HTTP ${response.status}: ${safe(body.error?.message || body.message || body.error?.code || 'request failed')}`)
    const choice = body.choices?.[0]
    if (choice?.finish_reason !== 'stop') throw new Error('Qwen API ส่งคำตอบไม่ครบ กรุณาลองใหม่')
    const content = choice.message?.content
    if (typeof content !== 'string' || !content.trim()) throw new Error('Qwen API ไม่ส่งคำตอบ กรุณาลองใหม่')
    if (format) {
      try { JSON.parse(content) } catch { throw Object.assign(new Error('Qwen API ส่ง JSON ไม่ครบ กรุณาลองใหม่'), { code: 'AI_INVALID_JSON' }) }
    }
    return { message: { role: 'assistant', content }, model }
  }
}
