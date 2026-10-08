import WebSocket from 'ws'
import { randomUUID } from 'node:crypto'
import express from 'express'
import { qwenRealtimeEndpoint } from './qwen-realtime.mjs'

export const maxAudioBytes = 30 * 16000 * 2

// Keep ASR on its dedicated model. The Omni realtime model is only needed for
// full duplex voice conversations, not for recording one learner response.
export function createQwenTranscriber({ apiKey, endpoint, workspaceId, region, model = 'qwen3-asr-flash-realtime', timeoutMs = 60000, socketFactory = (url, options) => new WebSocket(url, options) }) {
  const address = qwenRealtimeEndpoint({ endpoint, workspaceId, region })
  if (!apiKey?.trim()) throw new Error('ต้องตั้งค่า QWEN_API_KEY ที่เซิร์ฟเวอร์')
  address.searchParams.set('model', model)
  return async (audio, signal) => {
    signal?.throwIfAborted()
    if (!Buffer.isBuffer(audio) || audio.length < 6400 || audio.length > maxAudioBytes || audio.length % 2) throw new Error('เสียงต้องเป็น PCM16 mono 16 kHz ความยาว 0.2–30 วินาที')
    return new Promise((resolve, reject) => {
      let socket, finished = false, committed = false
      const timer = setTimeout(() => finish(new DOMException('ถอดเสียงนานเกินกำหนด กรุณาลองใหม่', 'TimeoutError')), timeoutMs)
      const abort = () => finish(signal.reason || new DOMException('Aborted', 'AbortError'))
      function finish(error, transcript) {
        if (finished) return
        finished = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        socket?.terminate()
        if (error) reject(error)
        else resolve(transcript)
      }
      function send(event) { socket.send(JSON.stringify({ event_id: `event_${randomUUID()}`, ...event })) }
      try {
        socket = socketFactory(address.href, { headers: { Authorization: `Bearer ${apiKey}` }, handshakeTimeout: Math.min(timeoutMs, 30000), maxPayload: 1024 * 1024 })
        socket.on('error', () => finish(new Error('เชื่อมต่อระบบถอดเสียงไม่ได้ กรุณาลองใหม่')))
        socket.on('unexpected-response', (_request, response) => { response.resume(); finish(new Error('บริการถอดเสียงยังไม่พร้อม กรุณาลองใหม่')) })
        socket.on('close', () => { if (!finished) finish(new Error('การเชื่อมต่อถอดเสียงขาด กรุณาลองใหม่')) })
        socket.on('open', () => {
          if (!finished) send({ type: 'session.update', session: { input_audio_format: 'pcm', sample_rate: 16000, input_audio_transcription: { language: 'en' }, turn_detection: null } })
        })
        socket.on('message', bytes => {
          if (finished) return
          try {
            const event = JSON.parse(bytes.toString())
            // This provider can send quota failures without an event type and
            // then close the socket. Surface the real cause before close fires.
            if (typeof event.code === 'string' && /AllocationQuota\.FreeTierOnly|quota.*exhausted/i.test(event.code)) {
              const error = new Error('โควตาถอดเสียง Qwen หมดแล้ว ลองใช้ระบบรู้จำเสียงของเบราว์เซอร์')
              error.code = 'ASR_QUOTA_EXHAUSTED'
              return finish(error)
            }
            if (event.type === 'error' || event.type === 'conversation.item.input_audio_transcription.failed') return finish(new Error('ระบบถอดเสียงไม่สำเร็จ กรุณาลองใหม่'))
            if (event.type === 'session.updated' && !committed) {
              committed = true
              // Never send the exercise or expected answer to the recognizer.
              for (let offset = 0; offset < audio.length; offset += 16000) send({ type: 'input_audio_buffer.append', audio: audio.subarray(offset, offset + 16000).toString('base64') })
              send({ type: 'input_audio_buffer.commit' })
            }
            // Assistant response text is never treated as the learner's speech.
            if (committed && event.type === 'conversation.item.input_audio_transcription.completed') {
              const transcript = typeof event.transcript === 'string' ? event.transcript.trim() : ''
              if (!transcript || transcript.length > 4000) return finish(new Error('ยังไม่ได้ยินคำพูดชัด ลองอัดใหม่ในที่เงียบ'))
              finish(null, transcript)
            }
            if (event.type === 'session.finished') finish(new Error('ยังไม่ได้ยินคำพูดชัด ลองอัดใหม่ในที่เงียบ'))
          } catch { finish(new Error('ระบบถอดเสียงส่งข้อมูลไม่ถูกต้อง กรุณาลองใหม่')) }
        })
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) abort()
      } catch { finish(new Error('เปิดบริการถอดเสียงไม่ได้ กรุณาลองใหม่')) }
    })
  }
}

export function createTranscriptionRouter(transcribe) {
  const router = express.Router()
  router.post('/transcribe', express.raw({ type: 'application/octet-stream', limit: maxAudioBytes }), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    if (!transcribe) return res.status(503).json({ error: 'ยังไม่ได้ตั้งค่าบริการถอดเสียง ลองใช้ระบบของเบราว์เซอร์' })
    if (!Buffer.isBuffer(req.body) || req.body.length < 6400 || req.body.length > maxAudioBytes || req.body.length % 2) return res.status(400).json({ error: 'กรุณาอัดเสียง 0.2–30 วินาทีแล้วส่งเป็น PCM16 mono 16 kHz' })
    const controller = new AbortController()
    const disconnected = () => { if (!res.writableEnded) controller.abort() }
    res.on('close', disconnected)
    try {
      const transcript = await transcribe(req.body, controller.signal)
      if (!res.destroyed) res.json({ transcript })
    } catch (error) {
      console.error('Microphone transcription failed:', error.name, error.message)
      if (!res.destroyed) res.status(error.name === 'TimeoutError' ? 504 : 503).json({
        error: error.code === 'ASR_QUOTA_EXHAUSTED' ? error.message : 'ถอดเสียงไม่สำเร็จ กรุณาลองใหม่ในที่เงียบ หรือลองระบบของเบราว์เซอร์',
        ...(error.code === 'ASR_QUOTA_EXHAUSTED' ? { code: error.code } : {}),
      })
    } finally { res.off('close', disconnected) }
  })
  router.use((error, _req, res, next) => {
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'เสียงยาวเกิน 30 วินาที กรุณาอัดใหม่' })
    next(error)
  })
  return router
}
