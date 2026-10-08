import { CircleCheck, RotateCcw, ArrowRight } from 'lucide-react'

export type ReviewPhrase = { target: string; translation: string }

export default function PracticeSummary({ completed, retries, review, onReview, onRestart, speaking = false }: { completed: number; retries: number; review: ReviewPhrase[]; onReview: () => void; onRestart: () => void; speaking?: boolean }) {
  return <div className="practice-summary">
    <CircleCheck size={52} aria-hidden="true" /><span className="section-kicker">SESSION COMPLETE</span>
    <h2>วันนี้ก้าวหน้าอีกขั้นแล้ว!</h2><p>ฝึกจบแล้ว เก็บคำที่ยังติดขัดไว้ทบทวนต่อได้เลย</p>
    <div className="summary-stats"><div><strong>{completed}</strong><span>ข้อที่ผ่าน</span></div><div><strong>{retries}</strong><span>ครั้งที่ลองใหม่</span></div><div><strong>{review.length}</strong><span>วลีที่ควรทบทวน</span></div></div>
    {review.length ? <section className="summary-review"><h3>เก็บไว้ฝึกอีกนิด</h3>{review.map((phrase) => <article key={phrase.target}><strong lang="en">{phrase.target}</strong><span>{phrase.translation}</span></article>)}<button className="start-button" type="button" onClick={onReview}>ฝึกวลีเหล่านี้อีกครั้ง<ArrowRight size={18} /></button></section> : <p className="summary-clean">ผ่านทุกข้อโดยไม่ต้องลองใหม่ เยี่ยมเลย!</p>}
    <button className="example-button" type="button" onClick={onRestart}><RotateCcw size={18} />ทบทวนทั้งบท</button>
    {speaking && <small>สรุปจากคำที่ระบบถอดเสียง ยังไม่ได้ประเมินความแม่นยำของสำเนียง</small>}
  </div>
}
