import { createQwenRealtime } from './qwen-realtime.mjs'
import { createQwenChat } from './qwen-chat.mjs'

export function createAiProvider(env = process.env, fetcher = fetch) {
  const provider = env.AI_PROVIDER || 'ollama'
  if (provider === 'qwen-chat') {
    const model = env.QWEN_MODEL || 'qwen3.8-max'
    return { provider, model, generate: createQwenChat({ apiKey: env.QWEN_API_KEY, baseUrl: env.QWEN_CHAT_BASE_URL, workspaceId: env.QWEN_WORKSPACE_ID, region: env.QWEN_REGION || 'ap-southeast-1', structuredMode: env.QWEN_STRUCTURED_MODE || 'json_schema', model, fetcher }) }
  }
  if (provider === 'qwen-realtime') {
    const model = env.QWEN_MODEL || 'qwen3.8-omni-flash-realtime'
    return { provider, model, generate: createQwenRealtime({ apiKey: env.QWEN_API_KEY, endpoint: env.QWEN_REALTIME_URL, workspaceId: env.QWEN_WORKSPACE_ID, region: env.QWEN_REGION || 'ap-southeast-1', model }) }
  }
  if (provider !== 'ollama') throw new Error('AI_PROVIDER ต้องเป็น ollama, qwen-realtime หรือ qwen-chat')
  const model = env.OLLAMA_MODEL || 'qwen3.5:9b'
  return { provider, model, async generate(body, signal) {
    const timeout = AbortSignal.timeout(120000)
    const response = await fetcher(`${(env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '')}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, model, stream: false, think: false, keep_alive: '10m' }), signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || 'AI ไม่พร้อมใช้งาน')
    return data
  } }
}

export function createCourseAiProvider(env = process.env, fetcher = fetch) {
  if (!env.COURSE_AI_PROVIDER) return createAiProvider(env, fetcher)
  return createAiProvider({ ...env, AI_PROVIDER: env.COURSE_AI_PROVIDER,
    QWEN_MODEL: env.COURSE_AI_MODEL || (env.COURSE_AI_PROVIDER === 'qwen-chat' ? 'qwen3.8-max' : env.QWEN_MODEL),
    QWEN_CHAT_BASE_URL: env.COURSE_AI_BASE_URL || env.QWEN_CHAT_BASE_URL,
    QWEN_API_KEY: env.COURSE_AI_KEY || env.QWEN_API_KEY,
    QWEN_STRUCTURED_MODE: env.COURSE_AI_STRUCTURED_MODE || env.QWEN_STRUCTURED_MODE,
    ...(env.COURSE_AI_PROVIDER === 'ollama' && env.COURSE_AI_MODEL ? { OLLAMA_MODEL: env.COURSE_AI_MODEL } : {}),
  }, fetcher)
}

// Existing callers keep their schemas, deadlines and source validators.
// Text generation changes provider; embeddings remain local.
export function createAiFetch(ai, baseUrl, fetcher = fetch) {
  const chatUrl = `${baseUrl.replace(/\/+$/, '')}/api/chat`
  return async (url, options) => {
    if (String(url) !== chatUrl || ai.provider === 'ollama') return fetcher(url, options)
    const body = JSON.parse(options.body)
    let result
    try { result = await ai.generate(body, options.signal) }
    catch (error) {
      if (!body.format || error.code !== 'AI_INVALID_JSON') throw error
      options.signal?.throwIfAborted()
      result = await ai.generate({ ...body, messages: [...body.messages, { role: 'user', content: 'Your previous response was not valid JSON. Return a single complete compact JSON object matching the supplied schema exactly. No prose, markdown, function-name wrappers or incomplete output. Keep explanations concise.' }] }, options.signal)
    }
    return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
}
