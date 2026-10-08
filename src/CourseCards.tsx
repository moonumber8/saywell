import { useState } from 'react'
import { ArrowUpRight, BookOpen, Search } from 'lucide-react'

export type Course = { id: string; title: string; level: string; pageStart?: number; pageEnd?: number; filename?: string; preview?: string; topic?: string; demoReady?: boolean; structured?: boolean; structuredTitle?: string; structuredUnits?: number; structuredRevision?: string; lessonNumber?: number; isGuide?: boolean; structuredError?: string; goals?: number; vocabulary?: number; sourceSections?: number; planningStatus?: string; planningOrigin?: string; planningCompleted?: number; planningTotal?: number }

function progressFor(course: Course) {
  try {
    const saved = JSON.parse(localStorage.getItem(`saywell-course:${course.id}`) || 'null')
    if (saved?.revision !== course.structuredRevision || !saved.results || !course.structuredUnits) return 0
    return Math.min(course.structuredUnits, Object.values(saved.results).filter((result) => (result as { passed?: boolean }).passed === true).length)
  } catch { return 0 }
}

export default function CourseCards({ documents, selectedId, disabled, onSelect }: { documents: Course[]; selectedId: string; disabled: boolean; onSelect: (id: string) => void }) {
  const [search, setSearch] = useState('')
  const [all, setAll] = useState(false)
  const ordered = [...documents].sort((a, b) => Number(Boolean(b.structured)) - Number(Boolean(a.structured)) || (a.lessonNumber ?? 999) - (b.lessonNumber ?? 999))
  const chapters = documents.filter((course) => course.structured)
  const completed = chapters.filter((course) => progressFor(course) === course.structuredUnits).length
  const filtered = ordered.filter((document) => `${document.title} ${document.topic || ''}`.toLowerCase().includes(search.toLowerCase()))
  const visible = search || all ? filtered : filtered.slice(0, 6)
  return <>
    {chapters.length > 0 && <div className="whole-course-overview"><div><span className="section-kicker">YOUR CURRICULUM</span><h3>เรียนตามหลักสูตร {chapters.length} บท</h3><p>เริ่มจากบทแรกหรือเลือกบทที่ต้องการ ทุกบทมีเป้าหมาย เนื้อหา แบบฝึก และทบทวนของตัวเอง</p></div><div><strong>{completed} / {chapters.length}</strong><span>บทที่ผ่านความเข้าใจครบ</span></div><progress value={completed} max={chapters.length} aria-label="บทที่ผ่านในหลักสูตร" /></div>}
    <label className="course-search"><Search size={18} aria-hidden="true" /><input aria-label="ค้นหาบทเรียน" placeholder="ค้นหาบท เช่น Lesson 1 หรือชื่อหัวข้อ" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
    <div className="course-grid">{visible.map((document) => <button className={`course-card${document.demoReady ? ' course-ready' : ''}`} key={document.id} type="button" aria-pressed={selectedId === document.id} disabled={disabled} onClick={() => onSelect(document.id)}>
      <div className="course-card-top"><BookOpen size={22} aria-hidden="true" /><span>{document.level}</span>{document.structured ? <em>{progressFor(document) === document.structuredUnits ? 'ผ่านครบหัวข้อแล้ว' : progressFor(document) ? 'เรียนต่อได้' : 'เรียนตามหลักสูตร'}</em> : document.isGuide ? <em>คู่มือหลักสูตร</em> : document.demoReady && <em>พร้อมฝึกทันที</em>}</div>
      <small>{document.title.replace(/^.*?—\s*/, '')}</small><h3>{document.topic || document.title.replace(/^.*?—\s*/, '')}</h3>
      <p lang="en">{document.preview || 'เลือกบทนี้เพื่อดูหัวข้อและตัวอย่างจากหลักสูตร'}</p>
      <div className="course-card-bottom"><span>{document.structured ? `${progressFor(document)} / ${document.structuredUnits} หัวข้อ · ${document.planningOrigin === 'ai-import' ? 'AI จัดแผนไว้แล้ว' : 'มีเกณฑ์ผ่าน'}` : ['queued', 'planning'].includes(document.planningStatus || '') ? `AI กำลังจัดแผน${document.planningTotal ? ` ${document.planningCompleted}/${document.planningTotal}` : ''}` : document.isGuide ? 'แนวทางเรียนและใช้หลักสูตร' : document.structuredError ? 'ต้องตรวจเนื้อหาก่อนเริ่มเรียน' : 'ฝึกเสริม'}{document.pageStart ? ` · หน้า ${document.pageStart}–${document.pageEnd}` : ''}</span><ArrowUpRight size={22} aria-hidden="true" /></div>
    </button>)}</div>
    {!filtered.length && <p role="status">{!documents.length ? 'ยังไม่มีหลักสูตร อัปโหลดไฟล์จากหน้าจัดการเพื่อเริ่มต้น' : 'ไม่พบบทเรียนที่ตรงกับคำค้นหรือระดับที่เลือก'}</p>}
    {!search && filtered.length > 6 && <button className="example-button" type="button" onClick={() => setAll(!all)}>{all ? 'แสดงเฉพาะบทแนะนำ' : `ดูทั้งหมด ${filtered.length} บท`}</button>}
  </>
}
