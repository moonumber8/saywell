export type RecognitionResult = { isFinal: boolean; length: number; [index: number]: { transcript: string } }
export type Recognition = {
  lang: string; continuous: boolean; interimResults: boolean; maxAlternatives: number
  onstart: (() => void) | null; onaudiostart: (() => void) | null
  onresult: ((event: { results: ArrayLike<RecognitionResult> }) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void; stop(): void; abort(): void
}
export type SpeechWindow = Window & { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition }

export function startBrowserSpeech(recognition: Recognition, callbacks: { onReady(): void; onText(text: string): void; onProcessing(): void; onComplete(text: string): void; onError(error: Error): void }, durations = { opening: 60000, recording: 30000, ending: 7000 }) {
  let ended = false, ready = false, stopping = false, finalText = ''
  let timer: ReturnType<typeof setTimeout>
  function cleanup() {
    clearTimeout(timer)
    recognition.onstart = recognition.onaudiostart = recognition.onend = null
    recognition.onresult = recognition.onerror = null
  }
  function complete(error?: Error) {
    if (ended) return
    ended = true; cleanup()
    try { recognition.abort() } catch { /* Already ended. */ }
    if (error) callbacks.onError(error)
    else if (finalText.trim()) callbacks.onComplete(finalText.trim())
    else callbacks.onError(new Error('ยังไม่ได้ยินคำตอบชัด ลองกดไมค์อีกครั้ง'))
  }
  function stop() {
    if (ended || stopping) return
    stopping = true; clearTimeout(timer); callbacks.onProcessing()
    timer = setTimeout(() => complete(finalText.trim() ? undefined : new Error('ไม่ได้รับผลถอดเสียง ลองอัดเสียงแล้วตรวจด้วย AI')), durations.ending)
    try { recognition.stop() } catch { complete(new Error('หยุดไมค์ไม่สำเร็จ กรุณาลองใหม่')) }
  }
  function onReady() {
    if (ended || ready || stopping) return
    ready = true; clearTimeout(timer); callbacks.onReady()
    timer = setTimeout(stop, durations.recording)
  }
  recognition.lang = 'en-US'; recognition.continuous = true; recognition.interimResults = true; recognition.maxAlternatives = 1
  recognition.onstart = recognition.onaudiostart = onReady
  recognition.onresult = event => {
    if (ended) return
    const results = Array.from(event.results)
    finalText = results.filter(result => result.isFinal).map(result => result[0].transcript).join(' ')
    callbacks.onText(results.map(result => result[0].transcript).join(' '))
  }
  recognition.onend = () => complete()
  recognition.onerror = event => complete(new Error(
    ['not-allowed', 'service-not-allowed'].includes(event.error) ? 'กรุณาอนุญาตให้เว็บและ Chrome ใช้ไมโครโฟน แล้วลองใหม่'
      : event.error === 'audio-capture' ? 'เปิดไมค์ไม่ได้ ลองปิดแอปที่ใช้ไมค์แล้วกดใหม่'
      : event.error === 'network' ? 'เชื่อมต่อระบบรู้จำเสียงไม่ได้ ลองใช้โหมดอัดเสียงแล้วตรวจด้วย AI'
      : 'ยังไม่ได้ยินคำตอบชัด ลองกดไมค์อีกครั้ง'))
  timer = setTimeout(() => complete(new Error('เปิดไมค์นานเกินไป ตรวจสิทธิ์ไมค์แล้วกดใหม่')), durations.opening)
  try { recognition.start() } catch { complete(new Error('เปิดไมค์ไม่ได้ กรุณาตรวจสิทธิ์ไมค์แล้วลองใหม่')) }
  return { stop, cancel() { if (!ended) { ended = true; cleanup(); try { recognition.abort() } catch { /* Already ended. */ } } } }
}
