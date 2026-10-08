import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createCachedTts } from './example-audio.mjs'

export const kokoroModel = 'Kokoro-82M'
const local = path => fileURLToPath(new URL(path, import.meta.url))

// Keep one CPU model in memory and serialize inference. Killing a canceled
// inference releases the worker; other queued requests continue on a new worker.
export function createKokoroWorker({ python = process.env.KOKORO_PYTHON || local(process.platform === 'win32' ? './.runtime/kokoro/Scripts/python.exe' : './.runtime/kokoro/bin/python'), workerPath = local('./kokoro-worker.py'), modelPath = process.env.KOKORO_MODEL_PATH || local('./models/kokoro/kokoro-v1.0.onnx'), voicesPath = process.env.KOKORO_VOICES_PATH || local('./models/kokoro/voices-v1.0.bin'), spawnWorker = spawn, startupMs = 30000, timeoutMs = 60000 } = {}) {
  let child, ready = false, current, disposed = false
  const queue = []
  function settle(job, error, bytes) {
    if (job.settled) return
    job.settled = true
    clearTimeout(job.timer)
    job.signal.removeEventListener('abort', job.abort)
    if (error) job.reject(error); else job.resolve(bytes)
  }
  function fail(error) {
    if (current) settle(current, error)
    current = undefined
    for (const job of queue.splice(0)) settle(job, error)
  }
  function pump() {
    if (disposed || current || !queue.length) return
    if (!child) { start(); return }
    if (!ready) return
    current = queue.shift()
    child.stdin.write(JSON.stringify({ id: current.id, ...current.input }) + '\n')
  }
  function start() {
    let worker
    try { worker = spawnWorker(python, [workerPath, modelPath, voicesPath], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }) }
    catch (error) { fail(error); return }
    child = worker
    ready = false
    let output = ''
    const startup = setTimeout(() => {
      if (child !== worker || ready) return
      fail(new DOMException('Kokoro initialization timed out', 'TimeoutError'))
      worker.kill()
    }, startupMs)
    worker.stdout.setEncoding('utf8')
    worker.stdout.on('data', chunk => {
      if (child !== worker) return
      output += chunk
      if (output.length > 12 * 1024 * 1024) { fail(new Error('Kokoro response too large')); worker.kill(); return }
      let end
      while ((end = output.indexOf('\n')) !== -1) {
        const line = output.slice(0, end); output = output.slice(end + 1)
        try {
          const response = JSON.parse(line)
          if (response.ready === true) { ready = true; clearTimeout(startup); pump() }
          else if (current && response.id === current.id) {
            const job = current; current = undefined
            if (response.error || typeof response.audio !== 'string') settle(job, new Error('Kokoro could not generate audio'))
            else settle(job, null, Buffer.from(response.audio, 'base64'))
            pump()
          }
        } catch { fail(new Error('Invalid Kokoro worker response')); worker.kill(); return }
      }
    })
    worker.stderr.on('data', chunk => console.error('Kokoro:', chunk.toString().trim().slice(0, 500)))
    worker.stdin.on('error', error => { if (child === worker) { fail(error); worker.kill() } })
    worker.on('error', error => { if (child === worker) fail(error) })
    worker.on('close', () => {
      clearTimeout(startup)
      if (child !== worker) return
      child = undefined; ready = false
      if (current) { settle(current, new Error('Kokoro worker stopped')); current = undefined }
      pump()
    })
  }
  function generate(input, signal) {
    signal.throwIfAborted()
    if (disposed) return Promise.reject(new Error('Kokoro worker is closed'))
    return new Promise((resolve, reject) => {
      const job = { id: randomUUID(), input, signal, resolve, reject, settled: false }
      job.abort = () => {
        settle(job, signal.reason || new DOMException('Audio canceled', 'AbortError'))
        const index = queue.indexOf(job)
        if (index !== -1) queue.splice(index, 1)
        if (current === job) { current = undefined; ready = false; child?.kill() }
      }
      job.timer = setTimeout(() => {
        settle(job, new DOMException('Kokoro generation timed out', 'TimeoutError'))
        const index = queue.indexOf(job)
        if (index !== -1) queue.splice(index, 1)
        if (current === job) { current = undefined; ready = false; child?.kill() }
      }, timeoutMs)
      signal.addEventListener('abort', job.abort, { once: true })
      queue.push(job)
      pump()
    })
  }
  generate.close = () => {
    disposed = true
    fail(new Error('Kokoro worker is closed'))
    child?.kill()
    process.removeListener('exit', exit)
  }
  const exit = () => child?.kill()
  process.once('exit', exit)
  return generate
}

export function createKokoroTts({ voice = process.env.KOKORO_VOICE || 'af_heart', directory, worker: suppliedWorker, ...options } = {}) {
  const worker = suppliedWorker || createKokoroWorker(options)
  const synthesize = createCachedTts({ model: kokoroModel, voice, revision: 'v1.0-pcm16-en-us-normal1-slow0.75', directory,
    generate: (input, signal) => worker({ text: input.text, voice, speed: input.speed === 'slow' ? 0.75 : 1.0 }, signal) })
  synthesize.close = () => worker.close?.()
  return synthesize
}
