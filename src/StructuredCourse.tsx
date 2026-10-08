import AudioButtons from './AudioButtons'
import { displayCourseTitle } from './course-title'
import { useEffect, useRef, useState } from 'react'
import { BookOpen, Check, Lock, Volume2, ArrowRight } from 'lucide-react'
import SpeakingPractice from './SpeakingPractice'
import AnswerFeedback from './AnswerFeedback'
import type { Course } from './CourseCards'
import { useExampleAudio } from './use-example-audio'
import { stopExampleAudio } from './example-audio'

type Example = { target: string; translation: string; originalDefinition?: string; translated?: boolean; speaker?: string }
type Question = { id: string; prompt: string; options: string[]; answer: string; explanation: string; audio?: string }
type Unit = { id: string; title: string; goal: string; explanation: string; evidence: string; examples: Example[]; questions: Question[]; assessment: Question[]; audioAssessment?: string; writingAssessment?: string; speechExercises: Example[]; kind: string; originalTasks?: string; mediaNote?: string; sourceSectionIds: string[]; reflection?: { prompt: string; minLength: number } }
type SourceSection = { id: string; title: string; start: number; end: number; text: string; unitIds: string[]; summary?: string; referenceReason?: string }
type Plan = { documentId: string; revision: string; title: string; sourceTitle: string; pageStart?: number; pageEnd?: number; origin?: string; units: Unit[]; passPercent: number; coverage: string[]; limitations: string[]; sourceSections: SourceSection[]; goalCoverage: { id: string; category: string; text: string; unitIds: string[] }[]; contentStats: { sourceSections: number; vocabulary: number; dialogueTurns: number; sourceCharacters: number; mappedCharacters: number; analyzedCharacters?: number; referenceCharacters?: number } }
type Grade = { unitId: string; score: number; passed: boolean; correct: string[]; total: number; review: { id: string; prompt: string; answer: string; explanation: string }[] }
type Progress = { revision: string; active: number; results: Record<string, Grade>; drafts: Record<string, string> }

function loadProgress(plan: Plan): Progress {
  try {
    const saved = JSON.parse(localStorage.getItem(`saywell-course:${plan.documentId}`) || 'null')
    if (saved?.revision === plan.revision && saved.results && Number.isInteger(saved.active) && saved.active >= 0 && saved.active < plan.units.length && Object.entries(saved.results).every(([id, result]) => {
      const grade = result as Grade
      return plan.units.some((unit) => unit.id === id) && typeof grade?.passed === 'boolean' && Number.isFinite(grade.score) && Array.isArray(grade.review) && Array.isArray(grade.correct)
    })) {
      const unlocked = plan.units.findIndex((unit) => !saved.results[unit.id]?.passed)
      const drafts = saved.drafts && typeof saved.drafts === 'object' && !Array.isArray(saved.drafts) ? Object.fromEntries(Object.entries(saved.drafts).filter(([id, draft]) => plan.units.some((unit) => unit.id === id) && typeof draft === 'string' && draft.length <= 6000)) : {}
      return { ...saved, drafts, active: unlocked >= 0 ? unlocked : saved.active }
    }
  } catch { /* Start a new record if browser storage is missing or invalid. */ }
  return { revision: plan.revision, active: 0, results: {}, drafts: {} }
}

export default function StructuredCourse({ documentId, nextCourse, onNextCourse, audioTranscription = false }: { documentId: string; nextCourse?: Course; onNextCourse: (id: string) => void; audioTranscription?: boolean }) {
  const [plan, setPlan] = useState<Plan | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    const start = setTimeout(() => { fetch(`/api/curriculum/structured/${encodeURIComponent(documentId)}`, { signal: controller.signal }).then(async (response) => {
      const data = await response.json()
      if (!response.ok) throw new Error(data.error)
      if (!controller.signal.aborted) setPlan(data)
    }).catch((caught) => { if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : 'โหลดหลักสูตรไม่ได้') }) }, 0)
    return () => { clearTimeout(start); controller.abort() }
  }, [documentId])
  if (error) return <p role="alert">{error}</p>
  if (!plan) return <p role="status">กำลังโหลดลำดับหลักสูตร…</p>
  return <CoursePlayer key={plan.revision} plan={plan} nextCourse={nextCourse} onNextCourse={onNextCourse} audioTranscription={audioTranscription} />
}

function CoursePlayer({ plan, nextCourse, onNextCourse, audioTranscription }: { plan: Plan; nextCourse?: Course; onNextCourse: (id: string) => void; audioTranscription: boolean }) {
  const audio = useExampleAudio()
  const [progress, setProgress] = useState(() => loadProgress(plan))
  const [phase, setPhase] = useState<'study' | 'practice' | 'check' | 'review'>('study')
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [practiceAnswers, setPracticeAnswers] = useState<Record<string, string>>({})
  const [heard, setHeard] = useState<string[]>([])
  const [grade, setGrade] = useState<Grade | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const audioGeneration = useRef(0)
  const unit = plan.units[progress.active]
  const passed = plan.units.filter((item) => progress.results[item.id]?.passed).length
  const reviewCount = Object.values(progress.results).reduce((count, item) => count + item.review.length, 0)
  const draft = progress.drafts[unit.id] || ''
  const reflectionComplete = !unit.reflection || draft.trim().length >= unit.reflection.minLength
  const speechExercises = unit.speechExercises || []
  const originalSections = plan.sourceSections.filter((section) => unit.sourceSectionIds.includes(section.id))

  useEffect(() => {
    let warning: ReturnType<typeof setTimeout> | undefined
    try { localStorage.setItem(`saywell-course:${plan.documentId}`, JSON.stringify(progress)) }
    catch { warning = setTimeout(() => setError('บันทึกความก้าวหน้าในเบราว์เซอร์ไม่ได้ การเรียนยังทำต่อได้'), 0) }
    return () => { if (warning) clearTimeout(warning) }
  }, [progress, plan.documentId])
  function stopAudio() { audioGeneration.current++; stopExampleAudio(); audio.stop() }

  function select(index: number) {
    stopAudio()
    setProgress((value) => ({ ...value, active: index })); setPhase('study'); setAnswers({}); setPracticeAnswers({}); setHeard([]); setGrade(null); setError('')
  }
  function play(text: string, id?: string) {
    stopAudio()
    const generation = audioGeneration.current
    audio.play(text, 'normal', () => { if (generation === audioGeneration.current && id) setHeard((items) => items.includes(id) ? items : [...items, id]) })
  }
  async function submit() {
    stopAudio()
    setSaving(true); setError('')
    try {
      const response = await fetch(`/api/curriculum/structured/${encodeURIComponent(plan.documentId)}/check`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: plan.revision, unitId: unit.id, answers, reflection: draft }), signal: AbortSignal.timeout(15000) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error)
      setGrade(result); setPhase('review')
      setProgress((value) => ({ ...value, results: { ...value.results, [unit.id]: result } }))
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'ตรวจคำตอบไม่ได้ ลองส่งใหม่') }
    finally { setSaving(false) }
  }
  const practiceComplete = unit.questions.every((question) => practiceAnswers[question.id] === question.answer)
  const checkComplete = reflectionComplete && unit.assessment.every((question) => answers[question.id] && (!question.audio || heard.includes(question.id)))

  return <section className="structured-course" aria-label="เรียนตามหลักสูตร">
    <div className="structured-header"><span className="section-kicker">{plan.origin === 'ai-import' ? 'AI PREPARED CURRICULUM' : 'GUIDED CURRICULUM'}</span><h2>{displayCourseTitle(plan.title)}</h2><p>{plan.origin === 'ai-import' ? 'เรียนตามแผนที่ AI จัดจากต้นฉบับตั้งแต่นำเข้า' : 'เรียนตามลำดับครบเป้าหมายของบท'} ผ่านแต่ละหัวข้อเมื่อได้อย่างน้อย {plan.passPercent}%</p><span className="source-badges"><span><BookOpen size={16} />{displayCourseTitle(plan.sourceTitle)}{plan.pageStart ? ` · หน้า ${plan.pageStart}–${plan.pageEnd}` : ''}</span></span><progress value={passed} max={plan.units.length} aria-label="หัวข้อที่ผ่าน" /><p>{passed} / {plan.units.length} หัวข้อผ่าน · {reviewCount} ข้อที่ควรทบทวน</p><small>ความก้าวหน้าบันทึกในเบราว์เซอร์นี้ · ไม่ใช่ใบรับรองหรือคะแนนสำเนียง</small></div>
    <details className="course-coverage"><summary>ดูเป้าหมายและเนื้อหาทั้งบท · คำศัพท์ {plan.contentStats.vocabulary} รายการ · บทสนทนา {plan.contentStats.dialogueTurns} ช่วง</summary><p>{plan.origin === 'ai-import' ? `AI วิเคราะห์ข้อความครบ ${plan.contentStats.sourceSections} ส่วน (${plan.contentStats.analyzedCharacters?.toLocaleString()} / ${plan.contentStats.sourceCharacters.toLocaleString()} ตัวอักษร) ส่วนที่ใช้จัดหัวข้อเรียน ${plan.contentStats.mappedCharacters.toLocaleString()} ตัวอักษร และข้อมูลประกอบ ${plan.contentStats.referenceCharacters?.toLocaleString()} ตัวอักษร แบบฝึกใช้ตัวอย่างที่เลือกจากต้นฉบับ` : `ใช้เนื้อหาที่นำเข้าทั้ง ${plan.contentStats.sourceSections} ส่วน (${plan.contentStats.mappedCharacters.toLocaleString()} / ${plan.contentStats.sourceCharacters.toLocaleString()} ตัวอักษร) แต่ละส่วนเชื่อมกับหัวข้อเรียนด้านล่าง`}</p><ul>{plan.goalCoverage.map((goal) => <li key={goal.id}><strong>{goal.category}: {goal.text}</strong><span>{goal.unitIds.every((id) => progress.results[id]?.passed) ? 'ผ่านการตรวจความเข้าใจแล้ว' : 'ยังมีหัวข้อให้เรียนและตรวจความเข้าใจ'}</span></li>)}</ul>{plan.sourceSections.filter(section => !section.unitIds.length).map(section => <details key={section.id}><summary>{section.title}</summary><p>{section.summary}</p><p>{section.referenceReason}</p><pre>{section.text}</pre></details>)}<p>เนื้อหากิจกรรมในห้องเรียนและโจทย์ที่ต้องใช้ภาพหรือวิดีโอมีต้นฉบับให้ทำต่อ การผ่านในแอปนับเฉพาะแบบตรวจที่ระบบประเมินได้</p></details>
    {passed === plan.units.length && <div className="course-complete"><Check size={30} /><h3>ผ่านการตรวจความเข้าใจครบทุกหัวข้อแล้ว!</h3><p>{reviewCount ? 'ยังมีข้อที่ควรทบทวน เลือกหัวข้อด้านล่างเพื่อฝึกต่อได้' : 'กลับมาทบทวนหัวข้อใดก็ได้'}</p><p>การออกเสียงจริงและงานเขียนอิสระยังไม่ได้ประเมิน</p>{nextCourse && <button className="start-button" type="button" onClick={() => onNextCourse(nextCourse.id)}>เรียนบทถัดไป · Lesson {nextCourse.lessonNumber}<ArrowRight size={18} /></button>}</div>}
    <div className="structured-layout"><nav className="unit-list" aria-label="หัวข้อในหลักสูตร">{plan.units.map((item, index) => {
      const completed = progress.results[item.id]?.passed
      const unlocked = index === 0 || plan.units.slice(0, index).every((prior) => progress.results[prior.id]?.passed)
      return <button key={item.id} type="button" disabled={!unlocked || saving} aria-current={progress.active === index ? 'step' : undefined} onClick={() => select(index)}><span>{completed ? <Check size={18} /> : unlocked ? index + 1 : <Lock size={16} />}</span><div><strong>{item.title}</strong><small>{completed ? `ผ่าน ${progress.results[item.id].score}%` : unlocked ? 'พร้อมเรียน' : 'ผ่านหัวข้อก่อนหน้าก่อน'}{item.audioAssessment ? ' · เสียงจริงยังไม่ประเมิน' : item.writingAssessment ? ' · ตรวจเฉพาะโครงสร้าง' : ''}</small></div></button>
    })}</nav><div className="unit-player">
      <span className="section-kicker">หัวข้อ {progress.active + 1} / {plan.units.length}</span><h3>{unit.title}</h3><p className="unit-goal">เป้าหมาย: {unit.goal}</p>
      <ol className="unit-phases">{['สอน', 'ฝึก', 'ตรวจความเข้าใจ', 'ทบทวน'].map((label, index) => <li key={label} aria-current={['study', 'practice', 'check', 'review'][index] === phase ? 'step' : undefined}>{label}</li>)}</ol>
      {error && <p role="alert">{error}</p>}{audio.error && <p role="alert">{audio.error}</p>}{audio.state !== 'idle' && <p role="status">{audio.state === 'loading' ? 'กำลังเตรียมเสียง…' : 'กำลังเล่นเสียง…'} <button type="button" onClick={stopAudio}>หยุดเสียง</button></p>}
      {phase === 'study' && <><p className="unit-explanation">{unit.explanation}</p><div className="unit-examples">{unit.examples.map((example, index) => <article key={`${index}-${example.target}`}><div>{example.speaker && <small>{example.speaker}</small>}<strong lang="en">{example.target}</strong><p>{example.translation}</p>{example.originalDefinition && <small lang="en">ต้นฉบับ: {example.originalDefinition}</small>}</div><AudioButtons text={example.target} onPlay={() => play(example.target)} onSlow={() => audio.play(example.target, 'slow')} /></article>)}</div>{unit.originalTasks && <div className="original-task"><strong>{plan.origin === 'ai-import' ? 'กิจกรรมที่ AI แนะนำจากหลักสูตร' : unit.kind === 'writing' ? 'โจทย์เขียนจากหลักสูตร' : 'แนวทางและโจทย์ต้นฉบับ'}</strong><pre lang={plan.origin === 'ai-import' ? 'th' : 'en'}>{unit.originalTasks}</pre></div>}{unit.mediaNote && <p>{unit.mediaNote}</p>}{unit.kind === 'pronunciation' && <p>แบบตรวจวัดความเข้าใจเรื่องเสียงและจังหวะ ยังไม่ได้วิเคราะห์เสียงพูดจริง</p>}<p className="audio-source">เสียงตัวอย่างโดย Kokoro-82M · แบบฝึกปรับจากเป้าหมายต้นฉบับ · คำแปลไทยเตรียมด้วย AI</p><button className="start-button" type="button" onClick={() => { stopAudio(); setHeard([]); setPhase('practice') }}>เริ่มฝึก<ArrowRight size={18} /></button></>}
      {(phase === 'practice' || phase === 'check') && <><p>{phase === 'practice' ? 'ฝึกจนตอบถูกครบทุกข้อ มีเฉลยให้เรียนรู้ก่อนตรวจความเข้าใจ' : 'ตอบทุกข้อแล้วส่งตรวจ เฉลยจะแสดงเมื่อส่งครบ ไม่มีคำใบ้ระหว่างตรวจ'}</p>{(phase === 'practice' ? unit.questions : unit.assessment).map((question, index) => {
        const selected = phase === 'practice' ? practiceAnswers[question.id] : answers[question.id]
        const canAnswer = !question.audio || heard.includes(question.id)
        return <article className="unit-question" key={question.id}><h4>{index + 1}. {question.prompt}</h4>{question.audio && <button className="example-button" type="button" onClick={() => play(question.audio!, question.id)}><Volume2 size={18} />ฟังให้จบก่อนตอบ</button>}<div className="answer-options">{[...question.options].sort((a, b) => a.localeCompare(b)).map((option) => <button key={option} type="button" disabled={!canAnswer || saving} aria-pressed={selected === option} onClick={() => phase === 'practice' ? setPracticeAnswers((value) => ({ ...value, [question.id]: option })) : setAnswers((value) => ({ ...value, [question.id]: option }))}>{option}</button>)}</div>{phase === 'practice' && selected && <AnswerFeedback result={selected === question.answer ? 'correct' : 'incorrect'} message={question.explanation} />}</article>
      })}{phase === 'practice' ? <button className="start-button" type="button" disabled={!practiceComplete} onClick={() => { setAnswers({}); setHeard([]); setPhase('check') }}>พร้อมแล้ว ตรวจความเข้าใจ</button> : <button className="start-button" type="button" disabled={!checkComplete || saving} onClick={submit}>{saving ? 'กำลังตรวจ…' : 'ส่งคำตอบทั้งหมด'}</button>}</>}
      {phase === 'review' && grade && <><AnswerFeedback result={grade.passed ? 'correct' : 'incorrect'} message={`ได้ ${grade.score}% · ผ่านเมื่อได้อย่างน้อย ${plan.passPercent}%`} />{grade.review.map((question) => <article className="unit-review" key={question.id}><strong>{question.prompt}</strong><p>คำตอบ: {question.answer}</p><p>{question.explanation}</p></article>)}{unit.audioAssessment && <p>ผลนี้ตรวจความเข้าใจเรื่องเสียงและจังหวะ ยังไม่ใช่ผลประเมินการออกเสียงจริง</p>}{unit.writingAssessment && <p>ผลนี้ตรวจความเข้าใจโครงสร้าง ร่างงานเขียนบันทึกไว้แล้วแต่ยังไม่ได้ประเมินคุณภาพงาน</p>}<div className="unit-actions"><button className="example-button" type="button" onClick={() => { setPhase('study'); setPracticeAnswers({}); setAnswers({}); setHeard([]) }}>ทบทวนและตรวจใหม่</button>{grade.passed && progress.active < plan.units.length - 1 && <button className="start-button" type="button" onClick={() => select(progress.active + 1)}>หัวข้อถัดไป<ArrowRight size={18} /></button>}</div></>}
      {unit.reflection && <label className="unit-reflection"><strong>{unit.reflection.prompt}</strong><textarea aria-label="บันทึกการฝึก" value={draft} disabled={saving} maxLength={6000} rows={4} onChange={(event) => setProgress((value) => ({ ...value, drafts: { ...value.drafts, [unit.id]: event.target.value } }))} /><small>บันทึกในเบราว์เซอร์เพื่อกลับมาทบทวน · ยังไม่ได้ตรวจคุณภาพคำตอบอิสระ{!reflectionComplete ? ` · เขียนอย่างน้อย ${unit.reflection.minLength} ตัวอักษรก่อนส่งตรวจ` : ''}</small></label>}
      {speechExercises.length > 0 && !unit.audioAssessment && <details className="extra-speaking"><summary>ฝึกพูดเพิ่มเติมกับ AI · ไม่ใช้ตัดสินผ่านหัวข้อนี้</summary><SpeakingPractice key={unit.id} exercises={speechExercises} audioTranscription={audioTranscription} /></details>}
      <details className="unit-original"><summary>เนื้อหาต้นฉบับที่ใช้ในหัวข้อนี้ ({originalSections.length} ส่วน)</summary>{originalSections.map((section) => <article key={section.id}><h4>{section.title}</h4><pre lang="en">{section.text}</pre></article>)}</details>
      <details className="unit-evidence"><summary>ที่มาและขอบเขตการตรวจ</summary><p>หัวข้ออ้างอิง: {unit.evidence}</p><ul>{plan.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul></details>
    </div></div>
  </section>
}
