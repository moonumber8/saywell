import AudioButtons from './AudioButtons'
import { useEffect, useRef, useState } from 'react'
import { Check, Mic, Square, X } from 'lucide-react'
import { matchSpeech, speechPassThreshold } from './speech-match'
import { recordMicrophone, type MicRecording } from './microphone'
import { startBrowserSpeech, type SpeechWindow } from './browser-speech'
import AnswerFeedback, { type AnswerResult } from './AnswerFeedback'
import SpeakingAdvice from './SpeakingAdvice'
import PracticeSummary, { type ReviewPhrase } from './PracticeSummary'
import { useExampleAudio } from './use-example-audio'
import { stopExampleAudio } from './example-audio'

type Phase = 'idle' | 'opening' | 'listening' | 'processing'
type Attempt = { controller: AbortController; recording?: MicRecording; browser?: ReturnType<typeof startBrowserSpeech>; timer?: ReturnType<typeof setTimeout>; clock?: ReturnType<typeof setInterval> }
function dispose(attempt: Attempt) {
  clearTimeout(attempt.timer); clearInterval(attempt.clock)
  attempt.controller.abort(); attempt.recording?.cancel(); attempt.browser?.cancel()
}

export default function SpeakingPractice({ exercises, audioTranscription = false }: { exercises: { target: string; translation: string }[]; audioTranscription?: boolean }) {
  const audio = useExampleAudio()
  const [index, setIndex] = useState(0)
  const [transcript, setTranscript] = useState('')
  const [passed, setPassed] = useState(false)
  const [phase, setPhase] = useState<Phase>('idle')
  const [seconds, setSeconds] = useState(0)
  const [level, setLevel] = useState(0)
  const [method, setMethod] = useState<'ai' | 'browser'>(audioTranscription ? 'ai' : 'browser')
  const [finished, setFinished] = useState(false)
  const [message, setMessage] = useState('')
  const [result, setResult] = useState<AnswerResult>(null)
  const [review, setReview] = useState<ReviewPhrase[]>([])
  const [retries, setRetries] = useState(0)
  const [reviewing, setReviewing] = useState<string[] | null>(null)
  const attemptRef = useRef<Attempt | null>(null)
  const SpeechRecognition = (window as SpeechWindow).SpeechRecognition ?? (window as SpeechWindow).webkitSpeechRecognition
  const activeExercises = reviewing ? exercises.filter(exercise => reviewing.includes(exercise.target)) : exercises
  const items = activeExercises.map(exercise => [exercise.target, exercise.translation])
  const [target, translation] = items[index]
  const speechResult = matchSpeech(target, transcript)
  const matches = speechResult.matched
  const busy = phase !== 'idle'
  const available = method === 'ai' ? audioTranscription && Boolean(navigator.mediaDevices?.getUserMedia) && window.isSecureContext : Boolean(SpeechRecognition)

  useEffect(() => {
    function interrupt() {
      const attempt = attemptRef.current
      if (!attempt) return
      attemptRef.current = null; dispose(attempt)
      setPhase('idle'); setResult('error'); setMessage('หยุดไมค์แล้ว เพราะออกจากหน้าเว็บหรือพักหน้าจอ กดเพื่ออัดใหม่')
    }
    const hidden = () => { if (document.hidden) interrupt() }
    document.addEventListener('visibilitychange', hidden)
    window.addEventListener('pagehide', interrupt)
    return () => {
      document.removeEventListener('visibilitychange', hidden); window.removeEventListener('pagehide', interrupt)
      if (attemptRef.current) dispose(attemptRef.current)
      attemptRef.current = null
      stopExampleAudio()
    }
  }, [])

  function cancel() {
    stopExampleAudio()
    if (attemptRef.current) dispose(attemptRef.current)
    attemptRef.current = null; setPhase('idle'); setLevel(0); setResult(null); setMessage('ยกเลิกแล้ว กดไมค์เพื่อลองใหม่')
  }
  function reset(onlyReview = false) {
    cancel(); setReviewing(onlyReview ? review.map(phrase => phrase.target) : null)
    setReview([]); setRetries(0); setIndex(0); setTranscript(''); setPassed(false); setFinished(false); setMessage(''); setResult(null)
    audio.stop()
  }
  function fail(attempt: Attempt, error: unknown) {
    if (attemptRef.current !== attempt) return
    attemptRef.current = null; dispose(attempt); setPhase('idle'); setLevel(0); setResult('error')
    const name = error instanceof Error ? error.name : ''
    setMessage(name === 'NotAllowedError' ? 'กรุณาอนุญาตให้เว็บและ Chrome ใช้ไมโครโฟน แล้วกดใหม่'
      : name === 'NotFoundError' || name === 'NotReadableError' ? 'เปิดไมค์ไม่ได้ ลองปิดแอปที่ใช้ไมค์แล้วกดใหม่'
      : name === 'TimeoutError' ? 'ถอดเสียงนานเกินไป ตรวจอินเทอร์เน็ตแล้วลองใหม่'
      : error instanceof Error ? error.message : 'เปิดไมค์ไม่สำเร็จ กรุณาลองใหม่')
  }
  function grade(attempt: Attempt, text: string) {
    if (attemptRef.current !== attempt) return
    if (!text.trim()) { fail(attempt, new Error('ยังไม่ได้ยินคำพูดชัด ลองอัดใหม่ในที่เงียบ')); return }
    attemptRef.current = null; dispose(attempt); setPhase('idle'); setLevel(0); setTranscript(text)
    const { passed: correct, score } = matchSpeech(target, text)
    if (!correct) {
      setRetries(count => count + 1)
      setReview(items => items.some(item => item.target === target) ? items : [...items, { target, translation }])
    }
    setPassed(correct); setResult(correct ? 'correct' : 'incorrect')
    setMessage(correct ? `ข้อความที่ระบบได้ยินตรงกับโจทย์ ${score}% ผ่านเกณฑ์ ${speechPassThreshold}% แล้ว กดข้อต่อไปได้เลย` : `ข้อความที่ระบบได้ยินตรงกับโจทย์ ${score}% ยังไม่ถึงเกณฑ์ ${speechPassThreshold}% ดูคำที่ยังไม่ตรงแล้วลองใหม่`)
  }
  async function submitRecording(attempt: Attempt) {
    if (attemptRef.current !== attempt || !attempt.recording) return
    clearTimeout(attempt.timer); clearInterval(attempt.clock); setPhase('processing'); setLevel(0)
    try {
      const audio = attempt.recording.stop()
      attempt.timer = setTimeout(() => attempt.controller.abort(new DOMException('ถอดเสียงนานเกินไป', 'TimeoutError')), 60000)
      const response = await fetch('/api/speaking/transcribe', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: audio, signal: attempt.controller.signal })
      const data = await response.json()
      if (!response.ok) {
        if (data.code === 'ASR_QUOTA_EXHAUSTED' && SpeechRecognition) {
          setMethod('browser')
          throw new Error('โควตาถอดเสียง Qwen หมดแล้ว เปลี่ยนเป็นระบบรู้จำเสียงของเบราว์เซอร์ให้แล้ว กดไมค์เพื่อพูดอีกครั้ง')
        }
        throw new Error(data.error || 'ถอดเสียงไม่สำเร็จ กรุณาลองใหม่')
      }
      if (typeof data.transcript !== 'string') throw new Error('ไม่ได้รับข้อความถอดเสียง กรุณาลองใหม่')
      grade(attempt, data.transcript)
    } catch (error) { fail(attempt, attempt.controller.signal.aborted ? attempt.controller.signal.reason : error) }
  }
  function listen() {
    if (!available || attemptRef.current || passed) return
    stopExampleAudio()
    audio.stop()
    const attempt: Attempt = { controller: new AbortController() }
    attemptRef.current = attempt
    setTranscript(''); setMessage(''); setResult(null); setSeconds(0); setLevel(0); setPhase('opening')
    const ready = () => {
      if (attemptRef.current !== attempt) return
      clearTimeout(attempt.timer); setPhase('listening')
      const started = Date.now()
      attempt.clock = setInterval(() => { if (attemptRef.current === attempt) setSeconds(Math.floor((Date.now() - started) / 1000)) }, 1000)
      if (method === 'ai') attempt.timer = setTimeout(() => { void submitRecording(attempt) }, 30000)
    }
    if (method === 'ai') {
      attempt.timer = setTimeout(() => fail(attempt, new Error('เปิดไมค์นานเกินไป ตรวจสิทธิ์ไมค์แล้วกดใหม่')), 60000)
      void recordMicrophone({ signal: attempt.controller.signal, onReady: ready, onLevel: value => { if (attemptRef.current === attempt) setLevel(value) }, onError: error => fail(attempt, error) }).then(recording => {
        if (attemptRef.current === attempt) attempt.recording = recording
        else recording.cancel()
      }).catch(error => fail(attempt, error))
    } else if (SpeechRecognition) {
      try {
        attempt.browser = startBrowserSpeech(new SpeechRecognition(), { onReady: ready, onText: text => { if (attemptRef.current === attempt) setTranscript(text) }, onProcessing: () => { if (attemptRef.current === attempt) { clearInterval(attempt.clock); setPhase('processing') } }, onComplete: text => grade(attempt, text), onError: error => fail(attempt, error) })
      } catch (error) { fail(attempt, error) }
    }
  }
  function playExample() {
    audio.play(target)
  }
  function next() {
    if (!passed || busy) return
    audio.stop()
    if (index === items.length - 1) setFinished(true)
    else { setIndex(index + 1); setTranscript(''); setPassed(false); setMessage(''); setResult(null) }
  }
  const statusMessage = phase === 'opening' ? 'กำลังเปิดไมค์… ถ้ามีคำขอสิทธิ์ ให้กดอนุญาตก่อนเริ่มพูด'
    : phase === 'listening' ? `กำลังรับเสียง · ${seconds} / 30 วินาที · พูดครบแล้วกดหยุดและตรวจ`
    : phase === 'processing' ? 'กำลังถอดเสียงและตรวจคำพูด… รอสูงสุด 1 นาที'
    : message || 'พร้อมแล้ว กดไมค์และรอให้ขึ้น “กำลังรับเสียง” ก่อนพูด'

  return <section className="speaking-practice" aria-label="ฝึกพูดภาษาอังกฤษ">
    <div className="speaking-heading"><span className="section-kicker">SPEAK & CHECK</span><h1>พูดทีละคำ<br /><em>ถูกแล้วไปต่อ</em></h1><p>พูดตามโจทย์ คำที่ระบบถอดเสียงได้ตรงกันจะขึ้นสีเขียว</p></div>
    <div className="speaking-card">
      <div className="speaking-progress"><span>{finished ? items.length : index + 1} / {items.length}</span><progress aria-label="จำนวนข้อที่ผ่าน" value={finished ? items.length : index + Number(passed)} max={items.length} /></div>
      {finished ? <PracticeSummary completed={items.length} retries={retries} review={review} onReview={() => reset(true)} onRestart={() => reset()} speaking /> : <>
        <p className="speaking-instruction">พูดภาษาอังกฤษตามนี้</p>
        <h2 className="speaking-target">{target.split(' ').map((word, wordIndex) => <span key={wordIndex} className={matches[wordIndex] ? 'word-correct' : ''}>{word}</span>)}</h2>
        <p className="speaking-translation">{translation}</p>
        <AudioButtons text={target} onPlay={playExample} onSlow={() => audio.play(target, 'slow')} disabled={busy} normalLabel="ฟังตัวอย่าง" labelWithText={false} />
        {audio.state !== 'idle' && <p role="status">{audio.state === 'loading' ? 'กำลังเตรียมเสียง…' : 'กำลังเล่นเสียง…'} <button type="button" onClick={audio.stop}>หยุดเสียง</button></p>}
        {audio.error && <p role="alert">{audio.error}</p>}
        <small className="audio-source">เสียงตัวอย่างโดย Kokoro-82M</small>
        {audioTranscription && <label className="microphone-method">วิธีรับเสียง<select value={method} disabled={busy} onChange={event => { setMethod(event.target.value as 'ai' | 'browser'); setResult(null); setMessage('') }}><option value="ai">อัดเสียงแล้วตรวจด้วย AI · แนะนำบนมือถือ</option>{SpeechRecognition && <option value="browser">รู้จำเสียงของเบราว์เซอร์ · แสดงคำระหว่างพูด</option>}</select></label>}
        {method === 'ai' && phase === 'listening' && <div className="microphone-level"><span>ระดับเสียงไมค์</span><meter aria-label="ระดับเสียงไมค์" min={0} max={1} value={level} /><small>พูดใกล้ไมค์ หากแถบไม่ขยับ ให้ตรวจว่าไมค์ถูกปิดหรือไม่</small></div>}
        <div className="speaking-feedback">{transcript && <p>ได้ยินว่า: <span lang="en">{transcript}</span> · ความตรงของคำ {speechResult.score}%</p>}<AnswerFeedback result={busy ? null : result} message={statusMessage} /></div>
        <div className="speaking-actions"><button className={`start-button${phase === 'listening' ? ' is-listening' : ''}`} type="button" onClick={phase === 'opening' || phase === 'processing' ? cancel : phase === 'listening' ? () => { if (method === 'ai' && attemptRef.current) void submitRecording(attemptRef.current); else attemptRef.current?.browser?.stop() } : listen} disabled={!available || passed}>{phase === 'opening' || phase === 'processing' ? <X size={20} /> : phase === 'listening' ? <Square size={20} /> : <Mic size={20} />}{phase === 'opening' || phase === 'processing' ? 'ยกเลิก' : phase === 'listening' ? 'หยุดและตรวจ' : passed ? 'พูดถูกแล้ว' : 'กดเพื่อพูด'}</button><button className="next-word" type="button" disabled={!passed || busy} onClick={next}>{index === items.length - 1 ? 'ดูผล' : 'ข้อต่อไป'}<Check size={18} /></button></div>
        {result === 'incorrect' && !busy && transcript.trim() && <SpeakingAdvice key={`${index}-${transcript}`} target={target} translation={translation} transcript={transcript} />}
        {!available && <p role="alert" className="error-message">เปิดลิงก์ HTTPS โดยตรงใน Chrome หรือ Safari และอนุญาตให้ใช้ไมโครโฟน</p>}
        {result === 'error' && <p className="microphone-help">บน iPhone ให้ตรวจสิทธิ์ไมค์ของ Chrome ในการตั้งค่า และสิทธิ์ของเว็บไซต์ หากเปิดจากแอปอื่น ให้เปิดลิงก์ใน Chrome โดยตรง</p>}
      </>}
    </div>
    <p className="speaking-note">ผ่านเมื่อคำที่ถอดเสียงตรงกับโจทย์อย่างน้อย {speechPassThreshold}% · ตัวเลขนี้ไม่ใช่คะแนนสำเนียงหรือคุณภาพการออกเสียง · {method === 'ai' ? 'ส่งเสียงให้ Qwen API หลังหยุดอัด ใช้อินเทอร์เน็ต และแอปไม่บันทึกไฟล์เสียง' : 'ระบบรู้จำเสียงของเบราว์เซอร์อาจใช้อินเทอร์เน็ต'}</p>
  </section>
}
