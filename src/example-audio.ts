export type AudioSpeed = 'normal' | 'slow'
type Callbacks = { onLoading?: () => void; onPlaying?: () => void; onStop?: () => void; onEnd?: () => void; onError?: (message: string) => void }
type Attempt = { controller: AbortController; context: AudioContext; source?: AudioBufferSourceNode; timer: ReturnType<typeof setTimeout>; onStop?: () => void }
let active: { stop: () => void } | null = null
const cache = new Map<string, ArrayBuffer>()

export function stopExampleAudio() { active?.stop() }
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', stopExampleAudio)
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopExampleAudio() })
}

export function createExampleAudio() {
  let attempt: Attempt | null = null
  const player = {
    stop() {
      const previous = attempt
      attempt = null
      if (active === player) active = null
      if (!previous) return
      clearTimeout(previous.timer)
      previous.controller.abort()
      if (previous.source) { previous.source.onended = null; try { previous.source.stop() } catch { /* Already ended. */ } previous.source.disconnect() }
      void previous.context.close().catch(() => {})
      previous.onStop?.()
    },
    async play(text: string, speed: AudioSpeed = 'normal', callbacks: Callbacks = {}) {
      stopExampleAudio()
      player.stop()
      let current: Attempt | null = null
      try {
        const Audio = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        if (!Audio) throw new Error('เบราว์เซอร์นี้ไม่รองรับการเล่นเสียง กรุณาเปิดด้วย Safari หรือ Chrome รุ่นปัจจุบัน')
        // Unlock audio inside the button gesture, before waiting for the API (iPhone).
        const context = new Audio()
        const controller = new AbortController()
        current = { context, controller, onStop: callbacks.onStop, timer: setTimeout(() => controller.abort(new Error('เตรียมเสียงนานเกินไป กรุณากดฟังอีกครั้ง')), 65000) }
        attempt = current
        active = player
        const resumed = context.resume()
        callbacks.onLoading?.()
        await resumed
        const key = JSON.stringify([text.trim(), speed])
        let bytes = cache.get(key)
        let downloaded = false
        if (!bytes) {
          const response = await fetch('/api/speaking/audio', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, speed }), signal: controller.signal })
          if (!response.ok) { const error = await response.json(); throw new Error(error.error || 'โหลดเสียงตัวอย่างไม่สำเร็จ') }
          if (!response.headers.get('content-type')?.startsWith('audio/wav')) throw new Error('บริการเสียงส่งข้อมูลไม่ถูกต้อง')
          bytes = await response.arrayBuffer()
          controller.signal.throwIfAborted()
          if (bytes.byteLength > 8 * 1024 * 1024) throw new Error('ไฟล์เสียงใหญ่เกินกำหนด')
          downloaded = true
        }
        const buffer = await context.decodeAudioData(bytes.slice(0))
        if (attempt !== current) return
        controller.signal.throwIfAborted()
        if (downloaded) { if (cache.size >= 20) cache.delete(cache.keys().next().value!); cache.set(key, bytes) }
        clearTimeout(current.timer)
        const source = context.createBufferSource()
        current.source = source
        source.buffer = buffer
        source.connect(context.destination)
        source.onended = () => { if (attempt === current) { player.stop(); callbacks.onEnd?.() } }
        source.start()
        callbacks.onPlaying?.()
      } catch (error) {
        if (current && attempt !== current) return
        const message = current?.controller.signal.aborted ? current.controller.signal.reason?.message : error instanceof Error ? error.message : ''
        player.stop()
        callbacks.onError?.(message || 'เล่นเสียงไม่สำเร็จ กรุณากดฟังอีกครั้ง')
      }
    },
  }
  return player
}
