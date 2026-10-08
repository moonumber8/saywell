import { useEffect, useRef, useState } from 'react'
import { Sparkles, Volume2 } from 'lucide-react'
import { useExampleAudio } from './use-example-audio'

type Advice = { tip: string; practice: string }

export default function SpeakingAdvice({ target, translation, transcript }: { target: string; translation: string; transcript: string }) {
  const audio = useExampleAudio()
  const [advice, setAdvice] = useState<Advice | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const requestRef = useRef<AbortController | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    requestRef.current = controller
    const timeout = setTimeout(() => controller.abort(new Error('AI แนะนำช้าเกินไป กดไมค์ฝึกต่อได้เลย')), 65000)
    const start = setTimeout(async () => {
      try {
        const response = await fetch('/api/speaking/advice', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target, translation, transcript: transcript.slice(0, 500) }), signal: controller.signal })
        const data = await response.json()
        if (!response.ok) throw new Error(data.error)
        if (typeof data.tip !== 'string' || typeof data.practice !== 'string') throw new Error('โหลดคำแนะนำไม่ได้ กรุณาลองใหม่')
        if (requestRef.current === controller && !controller.signal.aborted) setAdvice(data)
      } catch (caught) {
        if (requestRef.current === controller) setError(controller.signal.aborted ? controller.signal.reason?.message || 'หยุดรอคำแนะนำแล้ว กดไมค์ฝึกต่อได้เลย' : caught instanceof Error ? caught.message : 'โหลดคำแนะนำไม่ได้')
      } finally {
        clearTimeout(timeout)
        if (requestRef.current === controller) { requestRef.current = null; setLoading(false) }
      }
    }, 250)
    return () => { requestRef.current = null; controller.abort(); clearTimeout(start); clearTimeout(timeout) }
  }, [target, translation, transcript, retry])

  function play() {
    if (advice) audio.play(advice.practice, 'slow')
  }

  return <section className="speaking-advice" aria-label="คำแนะนำฝึกพูดจาก AI">
    <h3><Sparkles size={22} aria-hidden="true" />AI ช่วยฝึกพูด</h3>
    <div role="status" aria-live="polite">{loading ? <p>กำลังดูคำที่ระบบได้ยินและแนะนำวิธีฝึก… กดไมค์ลองใหม่ได้ทันที</p> : advice && <p>{advice.tip}</p>}</div>
    {advice && <div className="advice-practice"><span>ลองฝึกช่วงนี้: <strong lang="en">{advice.practice}</strong></span><button className="example-button" type="button" onClick={play}><Volume2 size={18} />ฟังช้า ๆ</button></div>}
    {error && <p role="alert">{error}</p>}
    {audio.state !== 'idle' && <p role="status">{audio.state === 'loading' ? 'กำลังเตรียมเสียง…' : 'กำลังเล่นเสียง…'} <button type="button" onClick={audio.stop}>หยุดเสียง</button></p>}
    {audio.error && <p role="alert">{audio.error}</p>}
    {loading ? <button className="example-button" type="button" onClick={() => requestRef.current?.abort(new Error('หยุดรอคำแนะนำแล้ว กดไมค์ฝึกต่อได้เลย'))}>หยุดรอคำแนะนำ</button> : error && <button className="example-button" type="button" onClick={() => { setError(''); setLoading(true); setRetry((value) => value + 1) }}>ขอคำแนะนำอีกครั้ง</button>}
    <small>คำแนะนำอิงข้อความที่ระบบถอดเสียง ระบบอาจฟังคลาดเคลื่อน และยังไม่ได้วิเคราะห์เสียงจริง</small>
  </section>
}
