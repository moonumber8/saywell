import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createQwenTts, validateTtsInput, ttsEndpoint, createTtsRouter } from './qwen-tts.mjs'

function wav() {
  const bytes = Buffer.alloc(44 + 16000)
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40)
  return bytes
}
async function setup(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'saywell-tts-'))
  t.after(() => rm(directory, { force: true, recursive: true }))
  const calls = []
  const fetcher = async (url, options = {}) => {
    calls.push({ url, ...options })
    if (options.method === 'POST') return Response.json({ output: { audio: { url: 'http://result.oss-ap-southeast-1.aliyuncs.com/example.wav?Signature=private' } } })
    return new Response(wav(), { headers: { 'Content-Type': 'audio/wav' } })
  }
  const configuration = { apiKey: 'test-private-key', workspaceId: 'ws-example', region: 'ap-southeast-1', directory, fetcher, ...overrides }
  return { configuration, calls, synthesize: createQwenTts(configuration) }
}

test('TTS validates English text and speeds, with HTTPS workspace routing', () => {
  assert.equal(ttsEndpoint({ workspaceId: 'ws-example', region: 'ap-southeast-1' }), 'https://ws-example.ap-southeast-1.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation')
  assert.deepEqual(validateTtsInput({ text: '  Hello!  ' }), { text: 'Hello!', speed: 'normal' })
  assert.equal(validateTtsInput({ text: '12', speed: 'slow' }).speed, 'slow')
  for (const text of ['', '中文', 'สวัสดี', 'a'.repeat(601), {}, null]) assert.throws(() => validateTtsInput({ text }))
  assert.throws(() => validateTtsInput({ text: 'Hi', speed: 'fast' }))
  assert.throws(() => ttsEndpoint({ endpoint: 'http://example.com' }))
})
test('exact input, Instruct model, English and delivery instructions; WAV caches survive restart and separate speeds', async t => {
  const { configuration, calls, synthesize } = await setup(t)
  const first = await synthesize({ text: 'Hello there.', speed: 'normal' })
  assert.equal(first.cached, false)
  assert.deepEqual(first.bytes, wav())
  const body = JSON.parse(calls[0].body)
  assert.equal(body.model, 'qwen3-tts-instruct-flash')
  assert.equal(body.input.text, 'Hello there.')
  assert.equal(body.input.language_type, 'English')
  assert.match(body.input.instructions, /conversational pace/)
  assert.equal(calls[1].headers, undefined)
  assert.match(calls[1].url, /^https:/)
  assert.equal(calls[1].redirect, 'error')
  assert.equal((await createQwenTts(configuration)({ text: 'Hello there.' })).cached, true)
  assert.equal(calls.length, 2)
  await synthesize({ text: 'Hello there.', speed: 'slow' })
  assert.match(JSON.parse(calls[2].body).input.instructions, /slow pace/)
  assert.equal(calls.length, 4)
})
test('concurrent listeners share generation; cancelling one does not cancel the other', async t => {
  let posts = 0, release
  const waiting = new Promise(resolve => { release = resolve })
  const { synthesize } = await setup(t, { fetcher: async (_url, options = {}) => {
    if (options.method === 'POST') { posts++; await waiting; options.signal.throwIfAborted(); return Response.json({ output: { audio: { url: 'https://result.oss.aliyuncs.com/test.wav' } } }) }
    return new Response(wav())
  } })
  const controller = new AbortController()
  const first = synthesize({ text: 'Hello' }, controller.signal)
  const rejected = assert.rejects(first, /cancelled/)
  const second = synthesize({ text: 'Hello' })
  while (!posts) await new Promise(resolve => setTimeout(resolve, 1))
  await new Promise(resolve => setTimeout(resolve, 10))
  controller.abort(new Error('cancelled'))
  release()
  await rejected
  assert.equal((await second).bytes.length, wav().length)
  assert.equal(posts, 1)
})
test('last listener cancellation stops upstream generation; quota failures redact the key without fallback', async t => {
  let signal
  const { synthesize } = await setup(t, { fetcher: (_url, options) => {
    signal = options.signal
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  } })
  const controller = new AbortController()
  const pending = synthesize({ text: 'Hi' }, controller.signal)
  const rejected = assert.rejects(pending, /cancelled/)
  while (!signal) await new Promise(resolve => setTimeout(resolve, 1))
  controller.abort(new Error('cancelled'))
  await rejected
  assert.equal(signal.aborted, true)
  const quota = await setup(t, { fetcher: async () => Response.json({ code: 'AllocationQuota.FreeTierOnly', message: 'test-private-key' }, { status: 403 }) })
  await assert.rejects(quota.synthesize({ text: 'Hi' }), error => error.message.includes('AllocationQuota') && !error.message.includes('test-private-key'))
})
test('invalid downloaded files and external URLs never enter the cache', async t => {
  const invalid = await setup(t, { fetcher: async (_url, options = {}) => options.method === 'POST' ? Response.json({ output: { audio: { url: 'https://result.oss.aliyuncs.com/test.wav' } } }) : new Response('not audio') })
  await assert.rejects(invalid.synthesize({ text: 'Hi' }), /WAV/)
  let downloads = 0
  const external = await setup(t, { fetcher: async () => { downloads++; return Response.json({ output: { audio: { url: 'http://localhost:6333/' } } }) } })
  await assert.rejects(external.synthesize({ text: 'Hi' }), /ที่อยู่/)
  assert.equal(downloads, 1)
  const partial = await setup(t, { fetcher: async (_url, options = {}) => options.method === 'POST' ? Response.json({ output: { audio: { url: 'https://result.oss.aliyuncs.com/test.wav' } } }) : new Response(wav().subarray(0, 100)) })
  await assert.rejects(partial.synthesize({ text: 'Hi' }), /WAV/)
})
test('generation has a bounded timeout even when the provider never responds', async t => {
  const keepAlive = setInterval(() => {}, 1000)
  t.after(() => clearInterval(keepAlive))
  const { synthesize } = await setup(t, { timeoutMs: 20, fetcher: (_url, options) => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })) })
  await assert.rejects(synthesize({ text: 'Hi' }), error => error.name === 'TimeoutError')
})
test('HTTP audio returns WAV and cache status; malformed input never reaches provider', async t => {
  let calls = 0
  const app = express(); app.use(express.json()); app.use('/api/speaking', createTtsRouter(async () => { calls++; return { bytes: wav(), cached: true } }))
  const server = createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  const url = `http://127.0.0.1:${server.address().port}/api/speaking/audio`
  const request = body => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const response = await request({ text: 'Hello' })
  assert.equal(response.headers.get('x-audio-model'), 'qwen3-tts-instruct-flash')
  assert.equal(response.headers.get('x-audio-cache'), 'hit')
  assert.match(response.headers.get('content-type'), /audio\/wav/)
  assert.equal((await response.arrayBuffer()).byteLength, wav().length)
  assert.equal((await request({ text: 'Hi', speed: 'invalid' })).status, 400)
  assert.equal(calls, 1)
})
