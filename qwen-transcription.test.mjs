import test from 'node:test'
import assert from 'node:assert/strict'
import WebSocket, { WebSocketServer } from 'ws'
import express from 'express'
import { createQwenTranscriber, createTranscriptionRouter, maxAudioBytes } from './qwen-transcription.mjs'

async function fixture(t, respond, timeoutMs = 1500) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise(resolve => server.once('listening', resolve))
  t.after(() => new Promise(resolve => { for (const client of server.clients) client.terminate(); server.close(resolve) }))
  const events = []
  server.on('connection', (socket, req) => {
    assert.equal(req.headers.authorization, 'Bearer test-secret')
    assert.equal(new URL(req.url, 'http://localhost').searchParams.get('model'), 'qwen3-asr-flash-realtime')
    socket.on('message', bytes => {
      const event = JSON.parse(bytes); events.push(event)
      if (event.type === 'session.update') socket.send(JSON.stringify({ type: 'session.updated' }))
      else if (event.type === 'input_audio_buffer.commit') respond(socket)
    })
  })
  const transcribe = createQwenTranscriber({ apiKey: 'test-secret', workspaceId: 'ws-test', timeoutMs, socketFactory: (url, options) => new WebSocket(`ws://127.0.0.1:${server.address().port}/${new URL(url).search}`, options) })
  return { transcribe, events, server }
}
test('ASR uses audio only, preserves binary, and ignores assistant and interim text', async t => {
  const { transcribe, events } = await fixture(t, socket => {
    for (const event of [{ type: 'response.text.done', text: 'Invented correct answer' }, { type: 'conversation.item.input_audio_transcription.delta', text: 'Draft' }, { type: 'conversation.item.input_audio_transcription.completed', transcript: 'Nice meet you.' }]) socket.send(JSON.stringify(event))
  })
  const audio = Buffer.alloc(32000, 34)
  assert.equal(await transcribe(audio), 'Nice meet you.')
  assert.deepEqual(events[0].session.input_audio_transcription, { language: 'en' })
  assert.equal(events[0].session.sample_rate, 16000)
  assert.equal(events[0].session.turn_detection, null)
  assert.equal(events.some(event => event.type === 'response.create'), false)
  assert.equal(events[0].session.instructions, undefined)
  assert.deepEqual(Buffer.concat(events.filter(event => event.type === 'input_audio_buffer.append').map(event => Buffer.from(event.audio, 'base64'))), audio)
})
test('ASR reports exhausted quota instead of a generic disconnect', async t => {
  const { transcribe } = await fixture(t, socket => {
    socket.send(JSON.stringify({ code: 'AllocationQuota.FreeTierOnly', message: 'The free quota has been exhausted.' }))
    socket.close()
  })
  await assert.rejects(transcribe(Buffer.alloc(6400)), { code: 'ASR_QUOTA_EXHAUSTED' })
})
test('ASR bounds audio, timeout and cancellation and does not expose provider errors', async t => {
  const failure = await fixture(t, socket => socket.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.failed', error: { message: 'test-secret' } })))
  await assert.rejects(failure.transcribe(Buffer.alloc(6400)), error => !error.message.includes('test-secret'))
  for (const audio of [Buffer.alloc(6398), Buffer.alloc(6401), Buffer.alloc(maxAudioBytes + 2)]) await assert.rejects(failure.transcribe(audio))
  const timeout = await fixture(t, () => {}, 30)
  await assert.rejects(timeout.transcribe(Buffer.alloc(6400)), { name: 'TimeoutError' })
  const aborted = await fixture(t, () => {})
  const controller = new AbortController()
  const pending = aborted.transcribe(Buffer.alloc(6400), controller.signal)
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
})
test('transcription HTTP endpoint rejects invalid uploads and returns only transcript', async t => {
  const received = []
  const app = express().use('/api/speaking', createTranscriptionRouter(async audio => { received.push(audio); return 'Hello.' }))
  const server = app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const url = `http://127.0.0.1:${server.address().port}/api/speaking/transcribe`
  const post = audio => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: audio })
  assert.equal((await post(Buffer.alloc(10))).status, 400)
  assert.equal((await post(Buffer.alloc(maxAudioBytes + 2))).status, 413)
  assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 400)
  const audio = Buffer.alloc(6400, 127)
  const response = await post(audio)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await response.json(), { transcript: 'Hello.' })
  assert.deepEqual(received, [audio])
})
