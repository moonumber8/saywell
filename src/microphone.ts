export type MicRecording = { stop(): ArrayBuffer; cancel(): void }

export function encodePcm(samples: Float32Array, sampleRate: number): ArrayBuffer {
  if (!Number.isFinite(sampleRate) || sampleRate < 16000) throw new Error('อัตรารับเสียงไม่รองรับ')
  const ratio = sampleRate / 16000
  const count = Math.min(30 * 16000, Math.floor(samples.length / ratio))
  const output = new ArrayBuffer(count * 2)
  const view = new DataView(output)
  for (let i = 0; i < count; i++) {
    // Average each input interval before downsampling; preserve signed PCM16 LE.
    const start = Math.floor(i * ratio), end = Math.floor((i + 1) * ratio)
    let total = 0
    for (let j = start; j < end; j++) total += samples[j]
    const value = Math.max(-1, Math.min(1, total / (end - start)))
    view.setInt16(i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true)
  }
  return output
}

export async function recordMicrophone({ signal, onReady, onLevel, onError }: { signal: AbortSignal; onReady: () => void; onLevel: (level: number) => void; onError: (error: Error) => void }): Promise<MicRecording> {
  signal.throwIfAborted()
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('ไมค์ต้องใช้เว็บ HTTPS กรุณาเปิดลิงก์เผยแพร่โดยตรง')
  const AudioConstructor = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioConstructor) throw new Error('เบราว์เซอร์นี้ไม่รองรับการอัดเสียง')
  // Create and resume during the tap, before a permission prompt takes control.
  const context = new AudioConstructor()
  let stream: MediaStream | undefined, source: MediaStreamAudioSourceNode | undefined
  let processor: AudioWorkletNode | ScriptProcessorNode | undefined, gain: GainNode | undefined
  let ready = false, closed = false, count = 0, lastLevel = 0
  let chunks: Float32Array[] = []
  let readyTimer: ReturnType<typeof setTimeout> | undefined
  function cleanup() {
    if (closed) return
    closed = true
    clearTimeout(readyTimer)
    signal.removeEventListener('abort', cleanup)
    if (processor && 'port' in processor) { processor.port.onmessage = null; processor.port.close() }
    else if (processor) processor.onaudioprocess = null
    processor?.disconnect(); source?.disconnect(); gain?.disconnect()
    stream?.getTracks().forEach(track => { track.onended = null; track.stop() })
    void context.close().catch(() => {})
  }
  function fail(error: Error) { cleanup(); chunks = []; onError(error) }
  function receive(samples: Float32Array) {
    if (closed) return
    if (!ready) { ready = true; clearTimeout(readyTimer); onReady() }
    const available = Math.max(0, 30 * context.sampleRate - count)
    if (available) { const chunk = samples.slice(0, available); chunks.push(chunk); count += chunk.length }
    const now = performance.now()
    if (now - lastLevel > 120) {
      let power = 0
      for (const value of samples) power += value * value
      onLevel(Math.min(1, Math.sqrt(power / samples.length) * 5))
      lastLevel = now
    }
  }
  signal.addEventListener('abort', cleanup, { once: true })
  try {
    const resumed = context.resume()
    void resumed.catch(() => {})
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false })
    if (closed || signal.aborted) { stream.getTracks().forEach(track => track.stop()); signal.throwIfAborted(); throw new Error('ยกเลิกการอัดเสียงแล้ว') }
    await resumed
    signal.throwIfAborted()
    source = context.createMediaStreamSource(stream)
    if (context.audioWorklet) {
      try {
        await context.audioWorklet.addModule('/mic-processor.js')
        signal.throwIfAborted()
        processor = new AudioWorkletNode(context, 'saywell-mic')
        processor.port.onmessage = event => receive(event.data)
      } catch (error) { if (signal.aborted) throw error }
    }
    if (!processor) {
      processor = context.createScriptProcessor(2048, 1, 1)
      processor.onaudioprocess = event => receive(event.inputBuffer.getChannelData(0))
    }
    gain = context.createGain(); gain.gain.value = 0
    source.connect(processor); processor.connect(gain); gain.connect(context.destination)
    stream.getTracks().forEach(track => { track.onended = () => fail(new Error('ไมค์ถูกตัดการเชื่อมต่อ กรุณาลองอัดใหม่')) })
    readyTimer = setTimeout(() => fail(new Error('ไมค์ยังไม่ส่งเสียง ลองปิดแอปที่ใช้ไมค์แล้วกดใหม่')), 10000)
    return {
      cancel() { cleanup(); chunks = [] },
      stop() {
        if (closed) throw new Error('การอัดเสียงสิ้นสุดแล้ว กรุณาลองใหม่')
        const samples = new Float32Array(count)
        let offset = 0
        for (const chunk of chunks) { samples.set(chunk, offset); offset += chunk.length }
        cleanup(); chunks = []
        if (count < context.sampleRate * 0.2) throw new Error('เสียงสั้นเกินไป กรุณาพูดก่อนกดส่งตรวจ')
        if (!samples.some(value => Math.abs(value) > 0.00001)) throw new Error('ไมค์ไม่มีเสียงเข้า ตรวจสิทธิ์ไมค์แล้วลองอัดใหม่')
        return encodePcm(samples, context.sampleRate)
      },
    }
  } catch (error) { cleanup(); chunks = []; throw error }
}
