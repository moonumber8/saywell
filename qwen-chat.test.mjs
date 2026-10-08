import test from 'node:test'
import assert from 'node:assert/strict'
import { createQwenChat, qwenChatEndpoint } from './qwen-chat.mjs'
import { createAiProvider, createCourseAiProvider, createAiFetch } from './ai-provider.mjs'

const key = 'sk-ws-test-only-secret'
const env = { AI_PROVIDER: 'qwen-realtime', QWEN_MODEL: 'qwen3.8-omni-flash-realtime', QWEN_API_KEY: key, QWEN_WORKSPACE_ID: 'ws-test', QWEN_REGION: 'ap-southeast-1', COURSE_AI_PROVIDER: 'qwen-chat', COURSE_AI_MODEL: 'qwen3.8-max' }
const format = { type: 'object', properties: { title: { type: 'string' }, sourceId: { type: 'string', enum: ['c1', 'c2'] } }, required: ['title', 'sourceId'], additionalProperties: false }
const input = { messages: [{ role: 'system', content: 'Return JSON using the supplied source only.' }, { role: 'user', content: 'c1: Hello' }], format, options: { temperature: 0, num_predict: 4500 } }
const completed = content => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }))

test('HTTP generation uses the workspace HTTPS endpoint and rejects insecure credentials in URLs', () => {
  assert.equal(qwenChatEndpoint({ workspaceId: 'ws-test' }), 'https://ws-test.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions')
  assert.equal(qwenChatEndpoint({ workspaceId: 'ws-test', region: 'cn-beijing' }), 'https://ws-test.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions')
  assert.equal(qwenChatEndpoint({ baseUrl: 'https://example.com/compatible-mode/v1/' }), 'https://example.com/compatible-mode/v1/chat/completions')
  for (const config of [{}, { workspaceId: 'invalid/path' }, { baseUrl: 'http://example.com' }, { baseUrl: 'https://secret@example.com' }, { baseUrl: 'https://example.com/?key=secret' }]) assert.throws(() => qwenChatEndpoint(config))
})

test('course preparation selects Max independently of the realtime interactive provider', async () => {
  const interactive = createAiProvider(env)
  let calls = 0
  const course = createCourseAiProvider(env, async (url, request) => {
    calls++
    assert.match(url, /^https:\/\/ws-test\.ap-southeast-1\.maas\.aliyuncs\.com\//)
    assert.equal(request.headers.Authorization, `Bearer ${key}`)
    const body = JSON.parse(request.body)
    assert.equal(body.model, 'qwen3.8-max')
    assert.equal(body.reasoning_effort, 'none')
    assert.equal(body.stream, false)
    assert.equal(body.enable_thinking, false)
    assert.equal(body.max_tokens, 4500)
    assert.equal(body.temperature, 0)
    assert.deepEqual(body.messages, input.messages)
    assert.deepEqual(body.response_format, { type: 'json_schema', json_schema: { name: 'course_result', strict: true, schema: format } })
    assert.ok(!('options' in body) && !('keep_alive' in body) && !('think' in body))
    return completed('{"title":"ทักทาย","sourceId":"c1"}')
  })
  assert.equal(interactive.model, 'qwen3.8-omni-flash-realtime')
  assert.equal(interactive.provider, 'qwen-realtime')
  assert.equal(course.model, 'qwen3.8-max')
  const result = await course.generate(input)
  assert.equal(result.model, course.model)
  assert.equal(JSON.parse(result.message.content).sourceId, 'c1')
  assert.equal(calls, 1)
  const transport = createAiFetch(course, 'http://localhost:11434')
  assert.equal((await (await transport('http://localhost:11434/api/chat', { body: JSON.stringify(input) })).json()).model, 'qwen3.8-max')
  assert.equal(calls, 2)
  assert.equal(createCourseAiProvider({ ...env, COURSE_AI_PROVIDER: '' }).model, interactive.model)
  assert.equal(createCourseAiProvider({ AI_PROVIDER: 'ollama', COURSE_AI_PROVIDER: 'ollama', COURSE_AI_MODEL: 'my-local-course-model' }).model, 'my-local-course-model')
})

test('a separate course credential and endpoint do not change the interactive configuration', async () => {
  const settings = { ...env, COURSE_AI_KEY: 'course-secret', COURSE_AI_BASE_URL: 'https://course.example/compatible-mode/v1' }
  const course = createCourseAiProvider(settings, async (url, request) => {
    assert.equal(url, 'https://course.example/compatible-mode/v1/chat/completions')
    assert.equal(request.headers.Authorization, 'Bearer course-secret')
    return completed('{"title":"ทักทาย","sourceId":"c1"}')
  })
  await course.generate(input)
  assert.equal(settings.QWEN_API_KEY, key)
  assert.equal(createAiProvider(settings).model, env.QWEN_MODEL)
})

test('JSON object mode supplies the full schema in the prompt and keeps the actual source unchanged', async () => {
  const course = createCourseAiProvider({ ...env, COURSE_AI_STRUCTURED_MODE: 'json_object' }, async (_url, request) => {
    const body = JSON.parse(request.body)
    assert.deepEqual(body.response_format, { type: 'json_object' })
    assert.ok(body.messages[0].content.includes(JSON.stringify(format)))
    assert.deepEqual(body.messages.slice(1), input.messages)
    assert.equal(body.model, 'qwen3.8-max')
    return completed('{"title":"ทักทาย","sourceId":"c1"}')
  })
  assert.equal(JSON.parse((await course.generate(input)).message.content).sourceId, 'c1')
  assert.throws(() => createQwenChat({ apiKey: key, workspaceId: 'ws-test', structuredMode: 'invalid' }), /STRUCTURED_MODE/)
})

test('upstream permission errors redact the key and never substitute another model', async () => {
  let calls = 0
  const course = createCourseAiProvider(env, async () => { calls++; return new Response(JSON.stringify({ error: { message: `No access for ${key}` } }), { status: 403 }) })
  await assert.rejects(course.generate(input), error => error.message.includes('403') && error.message.includes('[redacted]') && !error.message.includes(key))
  assert.equal(calls, 1)
})

test('truncated or empty output fails; malformed JSON triggers the shared bounded repair', async () => {
  const invalid = [{ choices: [{ finish_reason: 'length', message: { content: '{"title":' } }] }, { choices: [{ finish_reason: 'stop', message: { content: '' } }] }]
  const course = createCourseAiProvider(env, async () => new Response(JSON.stringify(invalid.shift())))
  await assert.rejects(course.generate(input), /ไม่ครบ/)
  await assert.rejects(course.generate(input), /ไม่ส่งคำตอบ/)
  let attempts = 0
  const repairable = createCourseAiProvider(env, async (_url, request) => {
    if (++attempts === 1) return completed('{"title":')
    assert.match(JSON.parse(request.body).messages.at(-1).content, /single complete compact JSON/)
    return completed('{"title":"ทักทาย","sourceId":"c1"}')
  })
  const fetcher = createAiFetch(repairable, 'http://localhost:11434')
  const response = await fetcher('http://localhost:11434/api/chat', { body: JSON.stringify(input) })
  assert.equal(JSON.parse((await response.json()).message.content).sourceId, 'c1')
  assert.equal(attempts, 2)
})

test('cancelled and timed out generation stops the HTTP request', async () => {
  let calls = 0
  const course = createQwenChat({ apiKey: key, workspaceId: 'ws-test', timeoutMs: 25, fetcher: async (_url, request) => {
    calls++
    return new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }))
  } })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(course(input, controller.signal), { name: 'AbortError' })
  assert.equal(calls, 0)
  const keepAlive = setTimeout(() => {}, 1000)
  try { await assert.rejects(course(input), { name: 'TimeoutError' }) } finally { clearTimeout(keepAlive) }
  assert.equal(calls, 1)
})
