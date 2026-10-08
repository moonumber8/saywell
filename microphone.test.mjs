import test from 'node:test'
import assert from 'node:assert/strict'
import { startBrowserSpeech } from './src/browser-speech.ts'
import { encodePcm, recordMicrophone } from './src/microphone.ts'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
function mockGlobal(t, name, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name)
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  t.after(() => { if (previous) Object.defineProperty(globalThis, name, previous); else delete globalThis[name] })
}
function recognitionFixture(durations) {
  const events = []
  const recognition = { start() { events.push('start') }, stop() { events.push('stop') }, abort() { events.push('abort') } }
  const session = startBrowserSpeech(recognition, { onReady: () => events.push('ready'), onText: text => events.push(['preview', text]), onProcessing: () => events.push('processing'), onComplete: text => events.push(['complete', text]), onError: error => events.push(['error', error.message]) }, durations)
  const results = (...parts) => recognition.onresult?.({ results: parts.map(([transcript, isFinal]) => ({ isFinal, 0: { transcript } })) })
  return { recognition, session, events, results }
}
test('browser microphone deadline starts after permission; fragments are graded only at completion', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { recognition, session, events, results } = recognitionFixture({ opening: 60000, recording: 30000, ending: 7000 })
  t.mock.timers.tick(20000)
  assert.deepEqual(events, ['start'])
  recognition.onstart(); recognition.onaudiostart()
  results(['Nice', true], ['to', false])
  assert.equal(events.filter(event => event === 'ready').length, 1)
  assert.equal(events.some(event => event[0] === 'complete'), false)
  results(['Nice', true], ['to meet you.', true])
  t.mock.timers.tick(29999)
  assert.equal(events.includes('stop'), false)
  session.stop()
  assert.equal(events.at(-1), 'stop')
  recognition.onend()
  assert.deepEqual(events.at(-1), ['complete', 'Nice to meet you.'])
  t.mock.timers.tick(90000)
  assert.equal(events.filter(event => event[0] === 'complete').length, 1)
})
test('cancellation detaches callbacks and prevents stale grading', () => {
  const { recognition, session, events } = recognitionFixture()
  session.cancel()
  assert.equal(recognition.onend, null); assert.equal(recognition.onresult, null)
  assert.deepEqual(events, ['start', 'abort'])
  session.cancel()
  assert.deepEqual(events, ['start', 'abort'])
})
test('browser errors release the mic immediately; missing end events are bounded', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const first = recognitionFixture()
  first.recognition.onerror({ error: 'not-allowed' })
  assert.equal(first.recognition.onend, null)
  assert.match(first.events.at(-1)[1], /Chrome/)
  const second = recognitionFixture({ opening: 60, recording: 30, ending: 7 })
  second.recognition.onstart(); second.session.stop(); t.mock.timers.tick(7)
  assert.equal(second.events.at(-1)[0], 'error')
  const third = recognitionFixture({ opening: 60, recording: 30, ending: 7 })
  third.results(['unfinished', false]); third.recognition.onend()
  assert.equal(third.events.at(-1)[0], 'error')
})
test('PCM downsampling preserves sample count, signed LE and clips safely', () => {
  const view = new DataView(encodePcm(Float32Array.from([-1,-1,-1, 0,0,0, 1,1,1, 2,2,2]), 48000))
  assert.equal(view.byteLength, 8)
  assert.deepEqual([0,2,4,6].map(offset => view.getInt16(offset, true)), [-32768, 0, 32767, 32767])
  assert.equal(encodePcm(new Float32Array(44100), 44100).byteLength, 32000)
  assert.equal(encodePcm(new Float32Array(31 * 16000), 16000).byteLength, 30 * 32000)
})
test('canceling while the permission dialog is open stops the late stream', async t => {
  let resolveStream, stopped = 0, closed = 0
  const stream = { getTracks: () => [{ stop: () => stopped++ }] }
  class Context { resume() { return Promise.resolve() } close() { closed++; return Promise.resolve() } }
  mockGlobal(t, 'window', { isSecureContext: true, AudioContext: Context })
  mockGlobal(t, 'navigator', { mediaDevices: { getUserMedia: () => new Promise(resolve => { resolveStream = resolve }) } })
  const controller = new AbortController()
  const recording = recordMicrophone({ signal: controller.signal, onReady: () => assert.fail('not ready'), onLevel() {}, onError() {} })
  controller.abort(); resolveStream(stream)
  await assert.rejects(recording, { name: 'AbortError' })
  assert.equal(stopped, 1); assert.equal(closed, 1)
})
test('recording reports ready only after samples arrive and stops all resources', async t => {
  let processor, stopped = 0, closed = 0, ready = 0, disconnected = 0
  class Context {
    sampleRate = 48000
    destination = {}
    resume() { return Promise.resolve() }
    close() { closed++; return Promise.resolve() }
    createMediaStreamSource() { return { connect() {}, disconnect() { disconnected++ } } }
    createGain() { return { gain: {}, connect() {}, disconnect() { disconnected++ } } }
    createScriptProcessor() { processor = { connect() {}, disconnect() { disconnected++ } }; return processor }
  }
  const track = { stop() { stopped++ } }
  mockGlobal(t, 'window', { isSecureContext: true, AudioContext: Context })
  mockGlobal(t, 'navigator', { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track] }) } })
  const recording = await recordMicrophone({ signal: new AbortController().signal, onReady: () => ready++, onLevel() {}, onError: error => assert.fail(error.message) })
  assert.equal(ready, 0)
  processor.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(48000).fill(0.1) } })
  assert.equal(ready, 1)
  assert.equal(recording.stop().byteLength, 32000)
  recording.cancel(); await delay(0)
  assert.equal(stopped, 1); assert.equal(closed, 1); assert.equal(disconnected, 3)
  assert.equal(processor.onaudioprocess, null)
})
