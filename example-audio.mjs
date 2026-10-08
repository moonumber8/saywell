import express from 'express'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, mkdir, writeFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const maxBytes = 8 * 1024 * 1024
export function validateTtsInput(input) {
  const text = typeof input?.text === 'string' ? input.text.trim() : ''
  const speed = input?.speed ?? 'normal'
  if (typeof text !== 'string' || !text || text.length > 600 || !/[A-Za-z0-9]/.test(text) || /[\p{L}&&[^\p{Script=Latin}]]/v.test(text) || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) throw new Error('เสียงตัวอย่างรองรับข้อความอังกฤษหรือเลข ความยาวไม่เกิน 600 ตัวอักษร')
  if (!['normal', 'slow'].includes(speed)) throw new Error('เลือกเสียงปกติหรือเสียงช้า')
  return { text, speed }
}
function wav(bytes) {
  if (bytes.length < 44 || bytes.length > maxBytes || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') return false
  const end = bytes.readUInt32LE(4) + 8
  if (end > bytes.length || end < 44) return false
  let format = false, data = false, offset = 12
  while (offset + 8 <= end) {
    const size = bytes.readUInt32LE(offset + 4), tag = bytes.toString('ascii', offset, offset + 4)
    if (offset + 8 + size > end) return false
    if (tag === 'fmt ') {
      if (size < 16) return false
      format = [1, 3].includes(bytes.readUInt16LE(offset + 8)) && [1, 2].includes(bytes.readUInt16LE(offset + 10)) && bytes.readUInt32LE(offset + 12) >= 8000
    }
    if (tag === 'data' && size > 0) data = true
    offset += 8 + size + size % 2
  }
  return format && data
}
export function createCachedTts({ model, voice, revision = '', generate, directory = fileURLToPath(new URL('./data/tts-audio/', import.meta.url)) }) {
  const active = new Map()
  async function save(input, path, signal) {
    const bytes = await generate(input, signal)
    signal.throwIfAborted()
    if (!wav(bytes)) throw new Error('บริการเสียงส่งไฟล์ WAV ไม่ครบ')
    await mkdir(directory, { recursive: true })
    const temporary = path + '.' + randomUUID() + '.tmp'
    try { await writeFile(temporary, bytes); await rename(temporary, path) }
    finally { await unlink(temporary).catch(() => {}) }
    return bytes
  }
  return async function synthesize(value, signal = new AbortController().signal) {
    signal.throwIfAborted()
    const input = validateTtsInput(value)
    const key = createHash('sha256').update(JSON.stringify([model, voice, revision, input.text, input.speed])).digest('hex')
    const path = join(directory, key + '.wav')
    try { const bytes = await readFile(path); signal.throwIfAborted(); if (wav(bytes)) return { bytes, cached: true } } catch (error) { if (error.code !== 'ENOENT') throw error }
    signal.throwIfAborted()
    let task = active.get(key)
    if (task?.controller.signal.aborted) { active.delete(key); task = null }
    if (!task) {
      if (active.size >= 3) throw new Error('บริการเสียงกำลังเตรียมหลายประโยค กรุณาลองอีกครั้ง')
      const controller = new AbortController()
      task = { controller, waiters: 0, promise: save(input, path, controller.signal).finally(() => { if (active.get(key) === task) active.delete(key) }) }
      active.set(key, task)
    }
    task.waiters++
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (error, bytes) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', abort)
        task.waiters--
        if (!task.waiters) task.controller.abort()
        if (error) reject(error); else resolve({ bytes, cached: false })
      }
      const abort = () => finish(signal.reason || new Error('หยุดเตรียมเสียงแล้ว'))
      signal.addEventListener('abort', abort, { once: true })
      task.promise.then(bytes => finish(null, bytes), error => finish(error))
      if (signal.aborted) abort()
    })
  }
}
export function createTtsRouter(synthesize, model = 'Kokoro-82M') {
  const router = express.Router()
  router.post('/audio', async (req, res) => {
    res.set('Cache-Control', 'no-store')
    let input
    try { input = validateTtsInput(req.body) } catch (error) { return res.status(400).json({ error: error.message }) }
    if (!synthesize) return res.status(503).json({ error: 'ยังไม่ได้ตั้งค่าบริการเสียง' })
    const controller = new AbortController()
    const disconnected = () => { if (!res.writableEnded) controller.abort() }
    res.on('close', disconnected)
    try {
      const { bytes, cached } = await synthesize(input, controller.signal)
      if (!res.destroyed) res.set({ 'Content-Type': 'audio/wav', 'X-Audio-Model': model, 'X-Audio-Cache': cached ? 'hit' : 'miss' }).send(bytes)
    } catch (error) {
      console.error('Example audio failed:', error.name, error.message)
      if (!res.destroyed) res.status(error.name === 'TimeoutError' ? 504 : 503).json({ error: error.message.includes('AllocationQuota') ? 'โควตาบริการเสียงหมด กรุณาแจ้งผู้ดูแลเพื่อเปิดใช้งานเสียง' : 'เตรียมเสียงไม่สำเร็จ กรุณากดฟังอีกครั้ง' })
    } finally { res.off('close', disconnected) }
  })
  return router
}
