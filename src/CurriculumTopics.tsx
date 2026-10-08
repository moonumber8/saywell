import { useEffect, useRef, useState } from 'react'

type Topic = { label: string; examples: { target: string; sourceId: string }[] }
export type PreparedLesson = { title: string; level: string; translated?: boolean; exercises: { target: string; translation: string; sourceId: string }[]; sources: { id: string; title: string; content: string; pageStart?: number; pageEnd?: number }[] }

export default function CurriculumTopics({ documentId, level, disabled, onSelect, onPrepared }: { documentId: string; level: string; disabled: boolean; onSelect: (query: string) => void; onPrepared: (lesson: PreparedLesson, query: string) => void }) {
  const [topics, setTopics] = useState<Topic[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [selected, setSelected] = useState('')
  const requestRef = useRef<AbortController | null>(null)
  const [prepared, setPrepared] = useState<{ lesson: PreparedLesson; query: string } | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    requestRef.current = controller
    const timeout = setTimeout(() => controller.abort(new Error('AI แนะนำหัวข้อใช้เวลานานเกินไป กรุณาลองอีกครั้ง')), 95000)
    const start = setTimeout(async () => {
      try {
        const response = await fetch('/api/curriculum/topics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ documentId, level }), signal: controller.signal })
        const data = await response.json()
        if (!response.ok) throw new Error(data.error)
        if (data.documentId !== documentId || !Array.isArray(data.topics)) throw new Error('โหลดหัวข้อแนะนำไม่ได้ กรุณาลองใหม่')
        if (!controller.signal.aborted) { setTopics(data.topics); if (data.preparedLesson) setPrepared({ lesson: data.preparedLesson, query: data.preparedQuery }) }
      } catch (caught) {
        if (requestRef.current === controller) setError(controller.signal.aborted ? controller.signal.reason?.message || 'ยกเลิกการแนะนำแล้ว' : caught instanceof Error ? caught.message : 'แนะนำหัวข้อไม่ได้ กรุณาลองใหม่')
      } finally {
        clearTimeout(timeout)
        if (requestRef.current === controller) { requestRef.current = null; setLoading(false) }
      }
    }, 250)
    return () => { requestRef.current = null; controller.abort(); clearTimeout(start); clearTimeout(timeout) }
  }, [documentId, level, retry])

  function reload() { setLoading(true); setError(''); setRetry((value) => value + 1) }

  return <section className="curriculum-topics" aria-label="หัวข้อแนะนำจากหลักสูตร">
    <strong>หัวข้อที่ AI แนะนำจากบทนี้</strong>
    {loading ? <><p role="status">กำลังอ่านบทที่เลือกและแนะนำหัวข้อ… รอสูงสุด 90 วินาที</p><button className="example-button" type="button" onClick={() => requestRef.current?.abort(new Error('ยกเลิกการแนะนำแล้ว'))}>ยกเลิกการแนะนำ</button></> : <>
      {error && <p role="alert">{error}</p>}
      {prepared && <div className="ready-lesson"><span className="section-kicker">READY TO PRACTICE</span><h3>{prepared.lesson.title}</h3><p>บทเรียนที่ AI เตรียมไว้และผ่านการตรวจวลีกับต้นฉบับ พร้อมเริ่มโดยไม่ต้องรอสร้างใหม่</p><button className="start-button" type="button" disabled={disabled} onClick={() => onPrepared(prepared.lesson, prepared.query)}>เริ่มฝึกทันที</button></div>}
      <div className="topic-options">{topics.map((topic) => <button key={topic.label} type="button" aria-pressed={selected === topic.label} disabled={disabled} onClick={() => { setSelected(topic.label); onSelect(`${topic.label}: ${topic.examples.map((example) => example.target).join(' / ')}`) }}>
        <strong>{topic.label}</strong><span lang="en">{topic.examples.map((example) => example.target).join(' · ')}</span>
      </button>)}</div>
      {topics.length > 0 && <p>ตัวอย่างภาษาอังกฤษผ่านการตรวจว่ามีในบทที่เลือก กดหัวข้อเพื่อใช้สร้างบทเรียน หรือพิมพ์หัวข้อเองได้</p>}
      <button className="example-button" type="button" disabled={disabled} onClick={reload}>{topics.length ? 'ให้ AI แนะนำอีกครั้ง' : 'ลองแนะนำหัวข้ออีกครั้ง'}</button>
    </>}
  </section>
}
