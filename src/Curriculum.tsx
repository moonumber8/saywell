import { useEffect, useRef, useState } from 'react'
import { displayCourseTitle } from './course-title'
import SpeakingPractice from './SpeakingPractice'
import CurriculumPreview from './CurriculumPreview'
import CurriculumTopics from './CurriculumTopics'
import ButtonPractice from './ButtonPractice'
import { practiceModes, type PracticeMode } from './lesson-activities'
import { readLessonStream } from './lesson-stream'
import CourseCards, { type Course } from './CourseCards'
import StructuredCourse from './StructuredCourse'
import { ArrowLeft, ArrowRight, BookOpen, Check, Settings2 } from 'lucide-react'

type Document = Course
type Lesson = { title: string; translated?: boolean; exercises: { target: string; translation: string; sourceId: string }[]; sources: { id: string; title: string; content: string; pageStart?: number; pageEnd?: number }[] }
type ImportJob = { id: string; status: string; message: string; completed: number; total: number; lessons?: number; error?: string; documentIds?: string[]; readyDocumentIds?: string[]; preparedUnits?: number; plannedLessons?: number; readyLessons?: number; stageStartedAt?: string; activeLessons?: { documentId: string; title: string; completed: number; total: number; attempt?: number; timeoutSeconds?: number; startedAt: string }[] }

export default function Curriculum() {
  const [documents, setDocuments] = useState<Document[]>([])
  const [catalogLoading, setCatalogLoading] = useState(true)
  const [canManage, setCanManage] = useState(false)
  const [audioTranscription, setAudioTranscription] = useState(false)
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [structuredActive, setStructuredActive] = useState(false)
  const [supplementaryOpen, setSupplementaryOpen] = useState(false)
  const [level, setLevel] = useState('A1')
  const [documentId, setDocumentId] = useState('')
  const [query, setQuery] = useState('')
  const [lesson, setLesson] = useState<Lesson | null>(null)
  const [lessonVersion, setLessonVersion] = useState(0)
  const [practiceMode, setPracticeMode] = useState<PracticeMode>('mixed')
  const [loading, setLoading] = useState(false)
  const [lessonProgress, setLessonProgress] = useState('')
  const [elapsed, setElapsed] = useState(0)
  const [saving, setSaving] = useState(false)
  const [jobId, setJobId] = useState(() => localStorage.getItem('curriculum-import') ?? '')
  const [uploading, setUploading] = useState(Boolean(jobId))
  const [wholeBook, setWholeBook] = useState(true)
  const [importJob, setImportJob] = useState<ImportJob | null>(null)
  const [importSeconds, setImportSeconds] = useState(0)
  const [file, setFile] = useState<File | null>(null)
  const [needsIndex, setNeedsIndex] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const requestRef = useRef<AbortController | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!loading) return
    const started = Date.now()
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => clearInterval(timer)
  }, [loading])

  useEffect(() => {
    if (!uploading || !importJob?.stageStartedAt) return
    const started = Date.parse(importJob.stageStartedAt)
    if (!Number.isFinite(started)) return
    const timer = setInterval(() => setImportSeconds(Math.max(0, Math.floor((Date.now() - started) / 1000))), 1000)
    return () => clearInterval(timer)
  }, [uploading, importJob?.stageStartedAt])

  useEffect(() => {
    const controller = new AbortController()
    // Let StrictMode's initial setup/cleanup finish before starting the request.
    const start = setTimeout(() => {
      fetch('/api/curriculum', { signal: controller.signal }).then(async (response) => {
        const data = await response.json()
        if (!response.ok || !Array.isArray(data.documents)) throw new Error(data.error || 'ข้อมูลหลักสูตรไม่ถูกต้อง')
        if (!controller.signal.aborted) {
          try {
            if (typeof data.dataRevision === 'string' && localStorage.getItem('saywell-data-revision') !== data.dataRevision) {
              for (const key of Object.keys(localStorage)) if (key.startsWith('saywell-course:') || key === 'curriculum-import') localStorage.removeItem(key)
              localStorage.setItem('saywell-data-revision', data.dataRevision)
              setJobId(''); setUploading(false); setImportJob(null)
            }
          } catch { /* Browser storage may be unavailable. */ }
          setDocuments(data.documents)
          setCanManage(data.canManage === true)
          setAudioTranscription(data.audioTranscription === true)
          if (data.canManage === true && data.activeImport?.id) {
            setImportJob(data.activeImport); setJobId(data.activeImport.id); setUploading(true)
            localStorage.setItem('curriculum-import', data.activeImport.id)
          }
          if (data.canManage === false) { setJobId(''); setUploading(false) }
        }
      }).catch(() => { if (!controller.signal.aborted) setError('โหลดหลักสูตรไม่สำเร็จ กรุณารีเฟรชหรือลองใหม่อีกครั้ง') }).finally(() => { if (!controller.signal.aborted) setCatalogLoading(false) })
    }, 0)
    return () => { clearTimeout(start); controller.abort(); requestRef.current?.abort(); requestRef.current = null }
  }, [])

  useEffect(() => {
    if (!jobId || !canManage || !uploading) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    async function poll() {
      try {
        const response = await fetch(`/api/curriculum/import/${jobId}`, { signal: controller.signal })
        const job = await response.json()
        if (!response.ok) throw new Error(job.error)
        setImportJob(job)
        if (job.status === 'complete' || job.status === 'failed') {
          setUploading(false)
          localStorage.removeItem('curriculum-import')
          const catalogResponse = await fetch('/api/curriculum', { signal: controller.signal })
          const catalog = await catalogResponse.json()
          if (!catalogResponse.ok || !Array.isArray(catalog.documents)) throw new Error('โหลดหลักสูตรหลังนำเข้าไม่ได้ กรุณารีเฟรช')
          setDocuments(catalog.documents)
          if (job.status === 'complete') setNotice(job.message)
          else setError(job.error)
          return
        }
      } catch (caught) {
        if (controller.signal.aborted) return
        setError(caught instanceof Error ? caught.message : 'อ่านความคืบหน้าไม่ได้ จะลองใหม่')
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 1500)
    }
    void poll()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [jobId, canManage, uploading])

  useEffect(() => {
    if (!uploading && !documents.some(document => ['queued', 'planning'].includes(document.planningStatus || ''))) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    function poll() {
      fetch('/api/curriculum', { signal: controller.signal }).then(async response => {
        const catalog = await response.json()
        if (response.ok && Array.isArray(catalog.documents) && !controller.signal.aborted) {
          setDocuments(catalog.documents)
          if (catalog.canManage === true && catalog.activeImport?.id) {
            setImportJob(catalog.activeImport); setJobId(catalog.activeImport.id); setUploading(true)
            localStorage.setItem('curriculum-import', catalog.activeImport.id)
          }
        }
      }).catch(() => { /* Keep the current catalog and retry after a connection interruption. */ }).finally(() => {
        if (!controller.signal.aborted) timer = setTimeout(poll, 5000)
      })
    }
    timer = setTimeout(poll, 5000)
    return () => { clearTimeout(timer); controller.abort() }
  }, [documents, uploading])

  function followImport(job: ImportJob) {
    setImportJob(job); setUploading(true); setJobId(job.id)
    localStorage.setItem('curriculum-import', job.id)
  }

  async function prepareSelectedCourse() {
    if (!documentId) return
    setError(''); setSaving(true)
    try {
      const response = await fetch(`/api/curriculum/documents/${encodeURIComponent(documentId)}/prepare`, { method: 'POST' })
      const job = await response.json()
      if (!response.ok) throw new Error(job.error)
      followImport(job)
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'เริ่มจัดแบบเรียนไม่สำเร็จ') }
    finally { setSaving(false) }
  }

  async function generate() {
    if (requestRef.current || !documentId) return
    setLoading(true)
    setStructuredActive(false)
    setElapsed(0)
    setLessonProgress('กำลังเริ่มสร้างบทเรียน…')
    setError('')
    setNotice('')
    setLesson(null)
    const controller = new AbortController()
    requestRef.current = controller
    const timeout = setTimeout(() => controller.abort(new Error('สร้างบทเรียนเกิน 3 นาที กรุณาลองเลือกบทที่เฉพาะเจาะจงแล้วลองใหม่')), 185000)
    try {
      const response = await fetch('/api/curriculum/lesson', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, body: JSON.stringify({ query, level, ...(documentId ? { documentId } : {}) }), signal: controller.signal })
      const data = await readLessonStream<Lesson>(response, (message) => { if (requestRef.current === controller && !controller.signal.aborted) setLessonProgress(message) })
      controller.signal.throwIfAborted()
      if (!Array.isArray(data.exercises) || data.exercises.length < 3) throw new Error('บทเรียนไม่ครบ กรุณาลองใหม่')
      setLesson(data)
      setStep(3)
      setLessonVersion((version) => version + 1)
    } catch (caught) {
      if (requestRef.current === controller) setError(controller.signal.aborted ? controller.signal.reason?.message || 'ยกเลิกการสร้างบทเรียนแล้ว' : caught instanceof Error ? caught.message : 'สร้างบทเรียนไม่ได้ กรุณาลองใหม่')
    } finally {
      clearTimeout(timeout)
      if (requestRef.current === controller) { requestRef.current = null; setLoading(false) }
    }
  }

  async function save() {
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/curriculum', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, content, level }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error)
      followImport(data)
      setStep(1)
      setQuery('')
      setTitle('')
      setContent('')
      setLesson(null)
      setNeedsIndex(false)
      setNotice('เริ่มนำเข้าแล้ว AI จะวิเคราะห์ต้นฉบับและจัดแบบเรียนให้ก่อนเริ่มเรียน')
      setFile(null)
      if (fileInputRef.current) fileInputRef.current.value = ''
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'บันทึกไม่ได้') }
    finally { setSaving(false) }
  }

  async function readFile() {
    if (!file || uploading || saving || loading) return
    if (file.size > 50 * 1024 * 1024) { setError('ไฟล์ต้องไม่เกิน 50 MB'); return }
    setUploading(true)
    setImportJob(null); setImportSeconds(0)
    setError('')
    setNotice('')
    const body = new FormData()
    body.append('level', level)
    body.append('file', file)
    try {
      const response = await fetch(wholeBook ? '/api/curriculum/import' : '/api/curriculum/upload', { method: 'POST', body })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error)
      if (wholeBook) {
        setImportJob(data)
        localStorage.setItem('curriculum-import', data.id)
        setJobId(data.id)
        return
      }
      setTitle(data.title)
      setContent(data.content)
      setNotice('อ่านต้นฉบับแล้ว ตรวจเนื้อหาด้านล่าง เมื่อบันทึก AI จะวิเคราะห์และจัดแบบเรียนให้อัตโนมัติ')
    } catch (caught) { setUploading(false); setError(caught instanceof Error ? caught.message : 'อัปโหลดไม่ได้ กรุณาลองใหม่') }
    finally { if (!wholeBook) setUploading(false) }
  }

  async function retryImport() {
    if (!importJob) return
    setError('')
    try {
      const response = await fetch(`/api/curriculum/import/${importJob.id}/retry`, { method: 'POST' })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error)
      setImportJob(data)
      setUploading(true)
      localStorage.setItem('curriculum-import', data.id)
      setJobId('')
      setTimeout(() => setJobId(data.id), 0)
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'ลองนำเข้าต่อไม่ได้') }
  }

  async function retryIndex() {
    setSaving(true)
    setError('')
    try {
      const response = await fetch('/api/curriculum/index', { method: 'POST' })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error)
      setNeedsIndex(false)
      setNotice('สร้างเวกเตอร์สำเร็จแล้ว พร้อมฝึกพูด')
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'สร้างเวกเตอร์ไม่ได้') }
    finally { setSaving(false) }
  }

  const selectedCourse = documents.find((document) => document.id === documentId)
  const planning = ['queued', 'planning'].includes(selectedCourse?.planningStatus || '')
  const busy = loading || saving
  const sources = lesson?.sources.filter((source) => lesson.exercises.some((exercise) => exercise.sourceId === source.id)) || []
  const sourceBadges = sources.filter((source, index) => sources.findIndex((other) => other.title === source.title && other.pageStart === source.pageStart && other.pageEnd === source.pageEnd) === index)
  function selectCourse(id: string) { setDocumentId(id); setQuery(''); setError(''); setLesson(null); setStructuredActive(false); setSupplementaryOpen(false); setStep(2) }

  return <section className="curriculum-panel learning-flow" aria-label="หลักสูตรภาษาอังกฤษ">
    <div className={`flow-intro${step > 1 ? ' flow-compact' : ''}`}><span className="section-kicker">A LITTLE PRACTICE. EVERY DAY.</span>{step === 1 ? <><h1>เลือกบทที่ใช่<br /><em>แล้วลองพูดออกมา</em></h1><p>เรียนจากหลักสูตรจริง มี AI ช่วยเลือกหัวข้อและแนะนำระหว่างฝึก</p></> : <h1>{step === 2 ? 'เลือกสิ่งที่อยากฝึกวันนี้' : 'ฝึกทีละนิด พูดได้มากขึ้น'}</h1>}</div>
    <nav className="flow-steps" aria-label="ขั้นตอนการเรียน">{(['เลือกบท', 'เลือกหัวข้อ', 'ฝึกและทบทวน'] as const).map((label, i) => <button key={label} type="button" aria-current={step === i + 1 ? 'step' : undefined} disabled={busy || (i === 1 && !documentId) || (i === 2 && !lesson && !structuredActive)} onClick={() => setStep((i + 1) as 1 | 2 | 3)}><span>{step > i + 1 ? <Check size={18} /> : i + 1}</span><strong>{label}</strong></button>)}</nav>
    {uploading && importJob && <aside className="import-overview" role="status"><strong>{importJob.status === 'indexing' ? 'บทเรียนพร้อมแล้ว กำลังเตรียมการค้นหา' : 'ได้รับไฟล์แล้ว กำลังเตรียมแบบเรียน'}</strong><p>{importJob.message}</p>{importJob.stageStartedAt && <small>ขั้นตอนนี้ {Math.floor(importSeconds / 60)} นาที {importSeconds % 60} วินาที · ปิดหน้าเว็บแล้วกลับมาดูต่อได้</small>}{importJob.readyDocumentIds?.[0] && documents.some(document => document.id === importJob.readyDocumentIds?.[0] && document.structured) && <button className="example-button" type="button" onClick={() => selectCourse(importJob.readyDocumentIds![0])}>เริ่มเรียนบทที่พร้อมแล้ว</button>}</aside>}
    {error && <p className="error-message" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {step === 1 && <section className="flow-section">
      <div className="flow-section-heading"><div><span className="section-kicker">01 / FIND YOUR LESSON</span><h2>วันนี้เริ่มจากบทไหนดี?</h2><p>เลือกบทที่สนใจ บทที่มีป้ายพร้อมฝึกทันทีเริ่มได้โดยไม่ต้องรอ AI</p></div><label>ระดับภาษา<select value={level} disabled={busy} onChange={(event) => { setLevel(event.target.value); setDocumentId(''); setQuery(''); setError(''); setLesson(null) }}>{['A1', 'A2', 'B1', 'B2'].map((item) => <option key={item}>{item}</option>)}</select></label></div>
      {catalogLoading ? <p role="status">กำลังโหลดบทเรียน…</p> : <CourseCards key={level} documents={documents.filter((document) => document.level === level)} selectedId={documentId} disabled={busy} onSelect={selectCourse} />}
      {!catalogLoading && !documents.some((document) => document.level === level) && <p>ยังไม่มีบทเรียนระดับนี้ เพิ่มเนื้อหาได้ในจัดการหลักสูตรด้านล่าง</p>}
    </section>}
    {step === 2 && selectedCourse && <section className="flow-section">
      <button className="flow-back" type="button" disabled={busy} onClick={() => setStep(1)}><ArrowLeft size={18} />เลือกบทอื่น</button>
      <div className="selected-course"><BookOpen size={24} aria-hidden="true" /><div><span>{selectedCourse.level} · {displayCourseTitle(selectedCourse.title)}</span><h2>{selectedCourse.topic || 'เลือกสิ่งที่อยากฝึก'}</h2></div></div>
      {selectedCourse.structured && <div className="ready-lesson"><span className="section-kicker">LEARN THE WHOLE CHAPTER</span><h3>{displayCourseTitle(selectedCourse.structuredTitle || '')}</h3><p>{selectedCourse.structuredUnits} หัวข้อ · คำศัพท์ {selectedCourse.vocabulary} รายการ · เนื้อหาต้นฉบับ {selectedCourse.sourceSections} ส่วน มีสอน ฝึก ตรวจความเข้าใจ และทบทวน เกณฑ์ผ่านแต่ละหัวข้อ 80% พร้อมบันทึกความก้าวหน้า</p><button className="start-button" type="button" onClick={() => { setStructuredActive(true); setLesson(null); setStep(3) }}>เริ่มเรียนตามหลักสูตร<ArrowRight size={18} /></button></div>}
      {selectedCourse.planningOrigin === 'ai-import' && selectedCourse.structured && <p className="audio-source">AI วิเคราะห์ข้อความที่นำเข้าครบทุกส่วนและจัดแผนไว้แล้ว · แบบฝึกปรับจากตัวอย่างในต้นฉบับ · ควรตรวจทานแผนและคำแปลไทย</p>}
      {planning && <div className="ready-lesson" role="status"><h3>AI กำลังวิเคราะห์ต้นฉบับและจัดแบบเรียน</h3><p>{selectedCourse.planningTotal ? `${selectedCourse.planningCompleted} / ${selectedCourse.planningTotal} ส่วน` : 'รอวิเคราะห์'} · แผนจะปรากฏอัตโนมัติเมื่อพร้อม คุณอ่านต้นฉบับด้านล่างระหว่างรอได้</p></div>}
      {selectedCourse.isGuide && <div className="ready-lesson"><h3>{selectedCourse.planningOrigin === 'ai-import' ? 'ข้อมูลประกอบหลักสูตร' : 'คู่มือการใช้หลักสูตรทั้ง 52 บท'}</h3><p>อ่านแนวทางเรียนและกิจกรรมต้นฉบับในพรีวิวด้านล่าง ส่วนนี้เป็นคู่มือ จึงไม่มีแบบตรวจผ่านรายบท</p></div>}
      {selectedCourse.structuredError && <p className="error-message" role="alert">{selectedCourse.structuredError}</p>}
      {!selectedCourse.isGuide && !planning && <details className="supplementary-practice" open={!selectedCourse.structured || supplementaryOpen} onToggle={(event) => { if (selectedCourse.structured) setSupplementaryOpen(event.currentTarget.open) }}><summary>ฝึกเสริมด้วย AI · ไม่ใช้ตัดสินว่าเรียนครบหลักสูตร</summary>
      {(!selectedCourse.structured || supplementaryOpen) && <CurriculumTopics key={`${level}-${documentId}`} documentId={documentId} level={level} disabled={busy} onSelect={(topic) => { setQuery(topic); setLesson(null); setError('') }} onPrepared={(prepared, topic) => { setQuery(topic); setStructuredActive(false); setLesson(prepared); setLessonVersion((value) => value + 1); setError(''); setStep(3) }} />}
      <fieldset className="practice-mode-field"><legend>อยากเรียนแบบไหน?</legend><div className="practice-mode-options">{practiceModes.map((mode) => <button key={mode.id} type="button" aria-pressed={practiceMode === mode.id} disabled={busy} onClick={() => setPracticeMode(mode.id)}><strong>{mode.label}</strong><small>{mode.detail}</small></button>)}</div></fieldset>
      <details className="custom-topic"><summary>อยากฝึกหัวข้ออื่นในบทนี้?</summary><label className="curriculum-query">วันนี้อยากฝึกอะไร<input value={query} maxLength={500} disabled={busy} onChange={(event) => setQuery(event.target.value)} placeholder="เลือกหัวข้อแนะนำ หรือพิมพ์หัวข้อในบทนี้" /></label></details>
      {query && <p className="chosen-topic"><strong>หัวข้อที่เลือก:</strong> {query}</p>}
      <button className="start-button" type="button" disabled={busy || !query.trim()} onClick={generate}>{loading ? 'กำลังเตรียมบทเรียน…' : 'สร้างบทเรียนและเริ่มฝึก'}<ArrowRight size={18} /></button>
      {loading && <div className="lesson-loading"><p role="status">{lessonProgress} ({elapsed} วินาที) · รอสูงสุด 3 นาที</p><button className="example-button" type="button" onClick={() => requestRef.current?.abort(new Error('ยกเลิกการสร้างบทเรียนแล้ว สามารถลองใหม่ได้'))}>ยกเลิก</button></div>}
      </details>}
      <CurriculumPreview documents={documents.filter((document) => document.id === documentId)} selectedId={documentId} />
    </section>}
    {step === 3 && structuredActive && <><button className="flow-back" type="button" onClick={() => setStep(2)}><ArrowLeft size={18} />กลับไปดูบทเรียน</button><StructuredCourse key={documentId} documentId={documentId} audioTranscription={audioTranscription} nextCourse={documents.find((course) => course.structured && course.level === selectedCourse?.level && course.filename === selectedCourse?.filename && course.lessonNumber === (selectedCourse?.lessonNumber || 0) + 1)} onNextCourse={(id) => { selectCourse(id); setStructuredActive(true); setStep(3) }} /></>}
    {step === 3 && lesson && !structuredActive && <section className="flow-section practice-stage">
      <button className="flow-back" type="button" onClick={() => setStep(2)}><ArrowLeft size={18} />เปลี่ยนหัวข้อหรือรูปแบบฝึก</button>
      <div className="practice-context"><span className="section-kicker">03 / YOUR PRACTICE</span><h2>{lesson.title}</h2><div className="source-badges">{sourceBadges.map((source) => <span key={source.id}><BookOpen size={14} aria-hidden="true" />{source.title}{source.pageStart ? ` · หน้า ${source.pageStart}–${source.pageEnd}` : ''}</span>)}</div><p>{lesson.translated ? 'วลีภาษาอังกฤษจากต้นฉบับ · คำแปลไทยจัดทำโดย AI' : 'วลีและคำแปลจากหลักสูตรที่เลือก'}</p></div>
      {practiceMode === 'speak' ? <SpeakingPractice key={`${lessonVersion}-${practiceMode}`} exercises={lesson.exercises} audioTranscription={audioTranscription} /> : <ButtonPractice key={`${lessonVersion}-${practiceMode}`} exercises={lesson.exercises} mode={practiceMode} />}
      <details className="curriculum-sources"><summary>ดูต้นฉบับที่ใช้ในบทเรียน</summary>{sources.map((source) => <article key={source.id}><h3>{source.title}{source.pageStart ? ` · หน้า ${source.pageStart}–${source.pageEnd}` : ''}</h3><pre>{source.content}</pre></article>)}</details>
      <CurriculumPreview documents={documents.filter((document) => document.id === documentId)} selectedId={documentId} />
    </section>}
    {canManage && <details className="curriculum-management"><summary><Settings2 size={18} aria-hidden="true" />จัดการหลักสูตร{uploading ? ' · กำลังนำเข้า…' : ''}</summary><div className="management-content"><label>ระดับสำหรับนำเข้า<select value={level} disabled={busy} onChange={(event) => { setLevel(event.target.value); setDocumentId(''); setQuery(''); setLesson(null); setStep(1) }}>{['A1', 'A2', 'B1', 'B2'].map((item) => <option key={item}>{item}</option>)}</select></label>
      {selectedCourse && !selectedCourse.structured && !selectedCourse.isGuide && <button className="example-button" type="button" disabled={busy || uploading} onClick={prepareSelectedCourse}>ให้ AI เตรียมแบบเรียนจากต้นฉบับบทนี้</button>}
      {needsIndex && <button className="example-button" type="button" disabled={busy} onClick={retryIndex}>ลองเตรียมเนื้อหาอีกครั้ง</button>}

      <section className="curriculum-upload" aria-label="อัปโหลดไฟล์หลักสูตร">
        <h2>อัปโหลดไฟล์หลักสูตร</h2>
        <p>รองรับ TXT, Markdown, PDF ที่มีข้อความ และ Word (.docx) ขนาดไม่เกิน 50 MB เลือกระดับภาษาด้านบนก่อนนำเข้า</p>
        <p>เมื่อนำเข้า AI จะอ่านทุกส่วน วางเป้าหมาย จัดเนื้อหาสอน คำแปลไทย และแบบฝึกไว้ให้ เริ่มเรียนได้โดยไม่ต้องสร้างโจทย์ใหม่ทุกครั้ง</p>
        <label className="book-import-choice"><input type="checkbox" checked={wholeBook} disabled={uploading || loading || saving} onChange={(event) => setWholeBook(event.target.checked)} />นำเข้าทั้งเล่ม แบ่งตามบท และให้ AI จัดแบบเรียนอัตโนมัติ</label>
        <label>เลือกไฟล์<input ref={fileInputRef} type="file" accept=".txt,.md,.pdf,.docx" disabled={uploading || loading || saving} onChange={(event) => setFile(event.target.files?.[0] ?? null)} /></label>
        <button className="example-button" type="button" disabled={!file || uploading || loading || saving} onClick={readFile}>{uploading ? 'กำลังนำเข้า…' : wholeBook ? 'นำเข้าทั้งเล่ม' : 'อ่านไฟล์และแสดงตัวอย่าง'}</button>
        {importJob && <div className="book-import-progress" role="status"><p>{importJob.message}{importJob.lessons ? ` (${importJob.lessons} บท)` : ''}</p>{importJob.total > 0 && <><progress value={importJob.completed} max={importJob.total} aria-label="ความคืบหน้านำเข้า" /><span>{importJob.completed} / {importJob.total}</span></>}{importJob.status === 'failed' && <><p>ส่วนที่จัดแผนสำเร็จเก็บไว้แล้ว ลองต่อได้โดยไม่ต้องอัปโหลดซ้ำ</p><button className="example-button" type="button" disabled={uploading} onClick={retryImport}>ลองนำเข้าต่อ</button></>}{importJob.status === 'complete' && importJob.documentIds?.[0] && documents.some(document => document.id === importJob.documentIds?.[0]) && <button className="example-button" type="button" onClick={() => selectCourse(importJob.documentIds![0])}>ดูแบบเรียนที่นำเข้า</button>}</div>}
        {uploading && <p>ปิดหน้านี้แล้วกลับมาดูความคืบหน้าได้ ระบบจะจัดแบบเรียนต่อให้ งานใหญ่ใช้เวลาตามจำนวนบทและความเร็ว AI</p>}
        {uploading && importJob?.stageStartedAt && <p className="audio-source">ขั้นตอนนี้ใช้เวลา {Math.floor(importSeconds / 60)} นาที {importSeconds % 60} วินาที · บทที่พร้อมแล้วเปิดเรียนได้ทันที</p>}
        {uploading && importJob?.activeLessons?.map(active => <p className="audio-source" key={active.documentId}>{active.title.replace(/^.*?—\s*/, '')} · {active.completed}/{active.total} ส่วน{active.attempt ? ` · กำลังรอ AI ครั้งที่ ${active.attempt}/2` : ''}{active.timeoutSeconds ? ` · รอสูงสุด ${active.timeoutSeconds} วินาทีต่อครั้ง` : ''}</p>)}
        {importJob?.readyDocumentIds?.[0] && documents.some(document => document.id === importJob.readyDocumentIds?.[0] && document.structured) && <button className="example-button" type="button" onClick={() => selectCourse(importJob.readyDocumentIds![0])}>เริ่มเรียนบทที่พร้อมแล้ว</button>}
      </section>
      <details className="curriculum-import" open={Boolean(content) || undefined}><summary>เพิ่มเนื้อหาหลักสูตรของพี่</summary><p>ใส่เป้าหมายบทเรียน และตัวอย่างอย่างน้อย 3 คู่ บรรทัดละ English phrase | คำแปลไทย โดยใช้ระดับที่เลือกด้านบน</p><label>ชื่อหลักสูตร<input value={title} maxLength={120} disabled={saving || loading || uploading} onChange={(event) => setTitle(event.target.value)} /></label><label>เนื้อหาหลักสูตร<textarea value={content} maxLength={30000} rows={8} disabled={saving || loading || uploading} onChange={(event) => setContent(event.target.value)} placeholder={'Goal: ordering drinks politely\nWater | น้ำ\nCoffee | กาแฟ\nTea | ชา\nI would like some water | ฉันขอน้ำหน่อย'} /></label><button className="example-button" type="button" disabled={saving || loading || uploading || !title.trim() || content.trim().length < 30} onClick={save}>{saving ? 'กำลังบันทึกและสร้างเวกเตอร์…' : 'บันทึกหลักสูตร'}</button></details>
    </div></details>}
  </section>
}
