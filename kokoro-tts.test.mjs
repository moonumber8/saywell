import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKokoroTts, createKokoroWorker } from './kokoro-tts.mjs'

function fixture() {
  const workers = [], requests = []
  function spawnWorker() {
    const worker = new EventEmitter()
    worker.stdin = new PassThrough(); worker.stdout = new PassThrough(); worker.stderr = new PassThrough()
    worker.stdin.on('data', bytes => requests.push({ worker, ...JSON.parse(bytes.toString()) }))
    worker.send = value => worker.stdout.write(JSON.stringify(value) + '\n')
    worker.kill = () => { worker.killed = true; queueMicrotask(() => worker.emit('close')) }
    workers.push(worker)
    queueMicrotask(() => worker.send({ ready: true }))
    return worker
  }
  return { workers, requests, spawnWorker }
}
const turn = () => new Promise(resolve => setImmediate(resolve))
function wav() {
  const bytes = Buffer.alloc(46)
  bytes.write('RIFF'); bytes.writeUInt32LE(38, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36); bytes.writeUInt32LE(2, 40); bytes.writeInt16LE(1000, 44)
  return bytes
}
test('worker serializes inference and reuses one loaded model', async t => {
  const f = fixture(), worker = createKokoroWorker(f)
  t.after(worker.close)
  const first = worker({ text: 'Hello', voice: 'af_heart', speed: 1 }, new AbortController().signal)
  const second = worker({ text: 'Welcome', voice: 'af_heart', speed: 0.75 }, new AbortController().signal)
  await turn()
  assert.equal(f.workers.length, 1); assert.equal(f.requests.length, 1)
  f.workers[0].send({ id: f.requests[0].id, audio: wav().toString('base64') })
  assert.deepEqual(await first, wav())
  assert.equal(f.requests.length, 2)
  f.workers[0].send({ id: f.requests[1].id, audio: wav().toString('base64') })
  assert.deepEqual(await second, wav())
})
test('canceling inference restarts the worker for another queued learner', async t => {
  const f = fixture(), worker = createKokoroWorker(f), controller = new AbortController()
  t.after(worker.close)
  const first = worker({ text: 'Hello' }, controller.signal)
  const canceled = assert.rejects(first, { name: 'AbortError' })
  const second = worker({ text: 'Welcome' }, new AbortController().signal)
  await turn(); controller.abort(); await canceled; await turn()
  assert.equal(f.workers[0].killed, true); assert.equal(f.workers.length, 2)
  f.workers[1].send({ id: f.requests[1].id, audio: wav().toString('base64') })
  assert.deepEqual(await second, wav())
})
test('canceling a queued request leaves the current voice playing', async t => {
  const f = fixture(), worker = createKokoroWorker(f), controller = new AbortController()
  t.after(worker.close)
  const first = worker({ text: 'Hello' }, new AbortController().signal)
  const second = worker({ text: 'Welcome' }, controller.signal)
  const canceled = assert.rejects(second, { name: 'AbortError' })
  await turn(); controller.abort(); await canceled
  assert.equal(f.workers[0].killed, undefined)
  f.workers[0].send({ id: f.requests[0].id, audio: wav().toString('base64') })
  await first; assert.equal(f.requests.length, 1)
})
test('hung inference times out and the next request can restart', async t => {
  const f = fixture(), worker = createKokoroWorker({ ...f, timeoutMs: 20 })
  t.after(worker.close)
  await assert.rejects(worker({ text: 'Hello' }, new AbortController().signal), { name: 'TimeoutError' })
  await turn()
  const next = worker({ text: 'Welcome' }, new AbortController().signal)
  await turn()
  f.workers.at(-1).send({ id: f.requests.at(-1).id, audio: wav().toString('base64') })
  assert.deepEqual(await next, wav())
})
test('Kokoro caches persist and separate voices, delivery speeds and providers', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kokoro-test-'))
  t.after(() => rm(directory, { force: true, recursive: true }))
  const calls = [], worker = async input => { calls.push(input); return wav() }
  const synthesize = createKokoroTts({ worker, directory })
  assert.equal((await synthesize({ text: 'Hello' })).cached, false)
  assert.equal((await createKokoroTts({ worker, directory })({ text: 'Hello' })).cached, true)
  await synthesize({ text: 'Hello', speed: 'slow' })
  await createKokoroTts({ worker, directory, voice: 'af_sarah' })({ text: 'Hello' })
  assert.deepEqual(calls.map(input => [input.voice, input.speed]), [['af_heart', 1], ['af_heart', 0.75], ['af_sarah', 1]])
  const invalid = createKokoroTts({ worker: async () => Buffer.from('broken'), directory })
  await assert.rejects(invalid({ text: 'Another phrase' }), /WAV/)
})
