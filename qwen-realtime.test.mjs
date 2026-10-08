import test from 'node:test'
import assert from 'node:assert/strict'
import WebSocket, { WebSocketServer } from 'ws'
import { createQwenRealtime, qwenRealtimeEndpoint } from './qwen-realtime.mjs'
import { createAiFetch, createAiProvider } from './ai-provider.mjs'

const key = 'sk-ws-test-only-secret'
const request = { messages: [{ role: 'system', content: 'Teach in Thai.' }, { role: 'user', content: 'Hello' }], options: { num_predict: 200 } }
const schema = { type: 'object', properties: { tip: { type: 'string' } }, required: ['tip'] }
async function fixture(t, respond, timeoutMs = 1500) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise(resolve => server.once('listening', resolve))
  t.after(() => new Promise(resolve => { for (const client of server.clients) client.terminate(); server.close(resolve) }))
  const observed = []
  server.on('connection', (socket, req) => {
    assert.equal(req.headers.authorization, `Bearer ${key}`)
    assert.equal(new URL(req.url, 'http://localhost').searchParams.get('model'), 'qwen3.8-omni-flash-realtime')
    socket.on('message', bytes => {
      const event = JSON.parse(bytes)
      observed.push(event)
      if (event.type === 'session.update') socket.send(JSON.stringify({ type: 'session.updated' }))
      else respond(socket, event)
    })
  })
  const generate = createQwenRealtime({ apiKey: key, workspaceId: 'ws-test', timeoutMs,
    socketFactory(url, options) { const query = new URL(url).search; return new WebSocket(`ws://127.0.0.1:${server.address().port}/${query}`, options) },
  })
  return { generate, observed, server }
}
const send = (socket, event) => socket.send(JSON.stringify(event))

test('workspace endpoints require TLS and valid server configuration', () => {
  assert.equal(qwenRealtimeEndpoint({ workspaceId: 'ws-example' }).href, 'wss://ws-example.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/realtime')
  assert.match(qwenRealtimeEndpoint({ workspaceId: 'ws-example', region: 'cn-beijing' }).href, /cn-beijing/)
  for (const config of [{}, { workspaceId: 'bad/id' }, { workspaceId: 'ws-ok', region: 'unknown' }, { endpoint: 'http://example.com' }, { endpoint: 'wss://key@example.com' }]) assert.throws(() => qwenRealtimeEndpoint(config))
  assert.throws(() => createQwenRealtime({ workspaceId: 'ws-ok' }), /QWEN_API_KEY/)
})

test('text generation sends instructions on response.create and isolates concurrent learners', async t => {
  const { generate, observed } = await fixture(t, (socket, event) => {
    assert.equal(event.type, 'response.create')
    assert.match(event.response.instructions, /Teach in Thai/)
    send(socket, { type: 'response.text.delta', delta: 'สวัสดี' })
    send(socket, { type: 'response.text.delta', delta: 'ค่ะ' })
    send(socket, { type: 'response.done', response: { status: 'completed' } })
  })
  const replies = await Promise.all([generate(request), generate({ ...request, messages: [...request.messages.slice(0, 1), { role: 'user', content: 'Learner 2' }] })])
  assert.ok(replies.every(reply => reply.message.content === 'สวัสดีค่ะ'))
  const sessions = observed.filter(event => event.type === 'session.update')
  assert.equal(sessions.length, 2)
  assert.ok(sessions.every(event => event.session.modalities.length === 1 && event.session.modalities[0] === 'text' && event.session.turn_detection === null))
  assert.equal(sessions.filter(event => event.session.instructions.includes('Learner 2')).length, 1)
})

test('structured function results are collected through response.done', async t => {
  const { generate, observed } = await fixture(t, socket => {
    send(socket, { type: 'response.function_call_arguments.delta', call_id: 'call1', delta: '{"tip":' })
    send(socket, { type: 'response.function_call_arguments.delta', call_id: 'call1', delta: '"ฝึกช้าๆ"}' })
    send(socket, { type: 'response.function_call_arguments.done', call_id: 'call1', name: 'submit_result' })
    send(socket, { type: 'response.done', response: { status: 'completed' } })
  })
  assert.deepEqual(JSON.parse((await generate({ ...request, format: schema })).message.content), { tip: 'ฝึกช้าๆ' })
  assert.deepEqual(observed[0].session.tools[0].function.parameters, schema)
})

test('structured results accept final output and text JSON fallback without parsing reasoning', async t => {
  let count = 0
  const { generate } = await fixture(t, socket => {
    send(socket, { type: 'response.reasoning.delta', delta: 'private reasoning' })
    send(socket, { type: 'response.done', response: { status: 'completed', output: ++count === 1 ? [{ type: 'function_call', name: 'submit_result', arguments: '{"tip":"สวัสดี"}' }] : [{ type: 'message', content: [{ text: '```json\n{"tip":"ขอบคุณ"}\n```' }] }] } })
  })
  assert.equal(JSON.parse((await generate({ ...request, format: schema })).message.content).tip, 'สวัสดี')
  assert.equal(JSON.parse((await generate({ ...request, format: schema })).message.content).tip, 'ขอบคุณ')
})

test('truncated, malformed and empty completions fail instead of marking a plan ready', async t => {
  const responses = [ { status: 'incomplete' }, { status: 'completed', output: [{ content: [{ text: '{"tip":' }] }] }, { status: 'completed' } ]
  const { generate } = await fixture(t, socket => send(socket, { type: 'response.done', response: responses.shift() }))
  await assert.rejects(generate({ ...request, format: schema }), /ไม่ครบ/)
  await assert.rejects(generate({ ...request, format: schema }), /JSON ไม่ครบ/)
  await assert.rejects(generate(request), /ไม่ส่งคำตอบ/)
})

test('upstream errors redact credentials and early disconnects fail', async t => {
  let count = 0
  const { generate } = await fixture(t, socket => {
    if (++count === 1) send(socket, { type: 'error', error: { message: `Invalid ${key}` } })
    else socket.close()
  })
  await assert.rejects(generate(request), error => error.message.includes('[redacted]') && !error.message.includes(key))
  await assert.rejects(generate(request), /ปิดการเชื่อมต่อ/)
})

test('timeouts and aborts close stalled sessions; already aborted requests do not connect', async t => {
  const { generate, observed } = await fixture(t, () => {}, 80)
  await assert.rejects(generate(request), { name: 'TimeoutError' })
  const controller = new AbortController()
  const pending = generate(request, controller.signal)
  controller.abort(new DOMException('Cancelled', 'AbortError'))
  await assert.rejects(pending, { name: 'AbortError' })
  const before = observed.length
  await assert.rejects(generate(request, controller.signal), { name: 'AbortError' })
  assert.equal(observed.length, before)
})

test('AI transport changes only text chat; embedding and database calls retain their original transport', async () => {
  const calls = [], ai = { provider: 'qwen-realtime', async generate(body) { calls.push(body); return { message: { content: '{"tip":"ฝึก"}' } } } }
  const fetcher = createAiFetch(ai, 'http://localhost:11434', async url => { calls.push(url); return new Response('{}') })
  const response = await fetcher('http://localhost:11434/api/chat', { body: JSON.stringify({ format: schema, messages: request.messages }) })
  assert.equal((await response.json()).message.content, '{"tip":"ฝึก"}')
  await fetcher('http://localhost:11434/api/embed', {})
  await fetcher('http://localhost:6333/collections', {})
  assert.equal(calls[1], 'http://localhost:11434/api/embed')
  assert.equal(calls[2], 'http://localhost:6333/collections')
  assert.throws(() => createAiProvider({ AI_PROVIDER: 'unknown' }), /AI_PROVIDER/)
})

test('invalid structured JSON is repaired once; connection errors and cancellations are never retried', async () => {
  let calls = 0
  const ai = { provider: 'qwen-realtime', async generate(body) {
    if (++calls === 1) throw Object.assign(new Error('Invalid JSON'), { code: 'AI_INVALID_JSON' })
    assert.match(body.messages.at(-1).content, /single complete compact JSON/)
    return { message: { content: '{"tip":"ฝึก"}' } }
  } }
  const options = { body: JSON.stringify({ ...request, format: schema }) }
  const fetcher = createAiFetch(ai, 'http://localhost:11434')
  assert.equal((await (await fetcher('http://localhost:11434/api/chat', options)).json()).message.content, '{"tip":"ฝึก"}')
  assert.equal(calls, 2)
  let failedCalls = 0
  const disconnected = createAiFetch({ provider: 'qwen-realtime', async generate() { failedCalls++; throw new Error('Disconnected') } }, 'http://localhost:11434')
  await assert.rejects(disconnected('http://localhost:11434/api/chat', options), /Disconnected/)
  assert.equal(failedCalls, 1)
  const cancelled = new AbortController()
  const cancelling = createAiFetch({ provider: 'qwen-realtime', async generate() { cancelled.abort(); throw Object.assign(new Error('Invalid JSON'), { code: 'AI_INVALID_JSON' }) } }, 'http://localhost:11434')
  await assert.rejects(cancelling('http://localhost:11434/api/chat', { ...options, signal: cancelled.signal }), { name: 'AbortError' })
})
