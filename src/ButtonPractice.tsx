import AudioButtons from './AudioButtons'
import { useMemo, useState } from 'react'
import { Check, X, Volume2 } from 'lucide-react'
import AnswerFeedback, { type AnswerResult } from './AnswerFeedback'
import PracticeSummary, { type ReviewPhrase } from './PracticeSummary'
import { buildActivities, correctArrangement, practiceModes, type Activity, type Phrase, type PracticeMode } from './lesson-activities'
import { useExampleAudio } from './use-example-audio'

function Question({ activity, onAttempt }: { activity: Activity; onAttempt: (correct: boolean, phrase?: ReviewPhrase) => void }) {
  const audio = useExampleAudio()
  const [selected, setSelected] = useState('')
  const [chosen, setChosen] = useState<number[]>([])
  const [feedback, setFeedback] = useState('')
  const [result, setResult] = useState<AnswerResult>(null)
  const [wrongPair, setWrongPair] = useState<number[] | null>(null)
  const [passed, setPassed] = useState(false)
  const [left, setLeft] = useState<number | null>(null)
  const [matched, setMatched] = useState<number[]>([])
  const [heard, setHeard] = useState(false)
  const { kind, phrase } = activity

  function play() {
    audio.play(phrase.target, 'normal', () => setHeard(true))
  }

  function check() {
    const correct = kind === 'arrange'
      ? correctArrangement(phrase.target, chosen.map((id) => activity.tokens.find((token) => token.id === id)!.word))
      : selected === activity.answer
    setPassed(correct)
    setResult(correct ? 'correct' : 'incorrect')
    setFeedback(correct ? 'เก่งมาก กดข้อต่อไปได้เลย' : kind === 'arrange' ? 'ลำดับคำยังไม่ตรง ลองเปลี่ยนลำดับแล้วตรวจอีกครั้ง' : 'คำตอบที่เลือกยังไม่ตรง เลือกคำตอบใหม่แล้วตรวจอีกครั้ง')
    onAttempt(correct, phrase)
  }

  function match(right: number) {
    if (left === null || passed) return
    if (left !== right) { setResult('incorrect'); setWrongPair([left, right]); setFeedback('คำอังกฤษกับความหมายไทยคู่นี้ยังไม่ตรงกัน ลองจับคู่ใหม่'); onAttempt(false, activity.pairs[left]); setLeft(null); return }
    setResult('correct')
    setWrongPair(null)
    const next = [...matched, left]
    setMatched(next)
    setLeft(null)
    if (next.length === activity.pairs.length) { setPassed(true); setFeedback('จับคู่ถูกครบแล้ว!'); onAttempt(true) }
    else setFeedback('ถูกต้อง! เลือกคู่ถัดไป')
  }

  const instruction = { choice: 'ประโยคนี้หมายความว่าอะไร?', listen: 'ฟังเสียงแล้วเลือกความหมาย', arrange: 'กดคำเพื่อเรียงประโยคตามความหมาย', fill: 'เลือกคำที่หายไป', match: 'เลือกคำอังกฤษ แล้วเลือกความหมายไทยที่ตรงกัน' }[kind]
  return <>
    <p className="activity-instruction">{instruction}</p>
    {kind === 'choice' && <h2 className="activity-target" lang="en">{phrase.target}</h2>}
    {kind === 'listen' && <><button className="example-button" type="button" onClick={play}><Volume2 size={20} />ฟังประโยค</button>{audio.state !== 'idle' && <p role="status">{audio.state === 'loading' ? 'กำลังเตรียมเสียง…' : 'กำลังเล่นเสียง…'} <button type="button" onClick={audio.stop}>หยุดเสียง</button></p>}{audio.error && <p role="alert">{audio.error}</p>}</>}
    {(kind === 'arrange' || kind === 'fill') && <p className="activity-meaning">{phrase.translation}</p>}
    {kind === 'fill' && <h2 className="activity-target" lang="en">{phrase.target.split(' ').map((word, i) => i === activity.blank ? '____' : word).join(' ')}</h2>}
    {(kind === 'choice' || kind === 'listen' || kind === 'fill') && <div className="answer-options">{activity.options.map((option, i) => <button key={option} type="button" className={selected === option && (result === 'correct' || result === 'incorrect') ? `answer-${result}` : ''} aria-pressed={selected === option} disabled={passed || (kind === 'listen' && !heard)} onClick={() => { setSelected(option); setFeedback(''); setResult(null) }}><span>{i + 1}</span>{option}{selected === option && result === 'correct' && <Check className="answer-mark" size={24} aria-label="ตอบถูก" />}{selected === option && result === 'incorrect' && <X className="answer-mark" size={24} aria-label="ตอบผิด" />}</button>)}</div>}
    {kind === 'arrange' && <>
      <div className={`arranged-answer${result === 'correct' || result === 'incorrect' ? ` answer-${result}` : ''}`} aria-label="ประโยคที่เรียงแล้ว">{chosen.length ? chosen.map((id, i) => <button type="button" key={id} disabled={passed} aria-label={`เอาคำ ${activity.tokens.find((token) => token.id === id)!.word} ออก`} onClick={() => { setChosen(chosen.filter((_, position) => position !== i)); setFeedback(''); setResult(null) }}>{activity.tokens.find((token) => token.id === id)!.word}</button>) : <span>กดคำด้านล่างเพื่อเริ่มเรียง</span>}</div>
      <div className="word-bank">{activity.tokens.map((token) => <button key={token.id} type="button" disabled={passed || chosen.includes(token.id)} onClick={() => { setChosen([...chosen, token.id]); setFeedback(''); setResult(null) }}>{token.word}</button>)}</div>
      <button className="example-button" type="button" disabled={passed || !chosen.length} onClick={() => { setChosen([]); setFeedback(''); setResult(null) }}>เริ่มเรียงใหม่</button>
    </>}
    {kind === 'match' && <div className="matching-columns"><div>{activity.pairs.map((pair, i) => <button key={pair.target} type="button" aria-pressed={left === i} className={matched.includes(i) ? 'pair-matched' : wrongPair?.[0] === i ? 'answer-incorrect' : ''} disabled={matched.includes(i)} onClick={() => { setLeft(i); setWrongPair(null); setResult(null); setFeedback('') }}>{pair.target}{matched.includes(i) && <Check size={24} aria-label="จับคู่ถูก" />}{wrongPair?.[0] === i && <X size={24} aria-label="จับคู่ผิด" />}</button>)}</div><div>{activity.rightOrder.map((i) => <button key={i} type="button" className={matched.includes(i) ? 'pair-matched' : wrongPair?.[1] === i ? 'answer-incorrect' : ''} disabled={left === null || matched.includes(i)} onClick={() => match(i)}>{activity.pairs[i].translation}{matched.includes(i) && <Check size={24} aria-label="จับคู่ถูก" />}{wrongPair?.[1] === i && <X size={24} aria-label="จับคู่ผิด" />}</button>)}</div></div>}
    <AnswerFeedback result={result} message={feedback || (kind === 'listen' && !heard ? 'กดฟังให้จบก่อนเลือกคำตอบ' : kind === 'match' ? 'เลือกคำอังกฤษ แล้วเลือกความหมายไทย' : 'เลือกคำตอบแล้วตรวจได้เลย')} />
    {passed && kind !== 'match' && <p className="activity-answer" lang="en">{phrase.target}<br /><span lang="th">{phrase.translation}</span></p>}
    {kind !== 'match' && <button className="start-button" type="button" disabled={passed || (kind === 'arrange' ? chosen.length !== activity.tokens.length : !selected) || (kind === 'listen' && !heard)} onClick={check}>{passed ? 'ตอบถูกแล้ว' : 'ตรวจคำตอบ'}</button>}
  </>
}

export default function ButtonPractice({ exercises, mode }: { exercises: Phrase[]; mode: Exclude<PracticeMode, 'speak'> }) {
  const audio = useExampleAudio()
  const [prepared] = useState(() => {
    try { return { activities: buildActivities(exercises, mode), error: '' } }
    catch (caught) { return { activities: [], error: caught instanceof Error ? caught.message : 'เตรียมแบบฝึกไม่ได้' } }
  })
  const [teaching, setTeaching] = useState(true)
  const [index, setIndex] = useState(0)
  const [passed, setPassed] = useState(false)
  const [finished, setFinished] = useState(false)
  const [mistakes, setMistakes] = useState(0)
  const [session, setSession] = useState(0)
  const [review, setReview] = useState<ReviewPhrase[]>([])
  const [reviewing, setReviewing] = useState<string[] | null>(null)
  const activities = useMemo(() => reviewing ? buildActivities(exercises, 'choice').filter((activity) => reviewing.includes(activity.phrase.target)) : prepared.activities, [reviewing, exercises, prepared.activities])
  const studyPhrases = reviewing ? exercises.filter((phrase) => reviewing.includes(phrase.target)) : exercises
  function restart(onlyReview = false) {
    audio.stop()
    setReviewing(onlyReview ? review.map((phrase) => phrase.target) : null)
    setReview([]); setIndex(0); setPassed(false); setFinished(false); setMistakes(0); setSession(session + 1); setTeaching(true)
  }
  function play(text: string) { audio.play(text) }
  function next() {
    if (!passed) return
    audio.stop()
    if (index === activities.length - 1) setFinished(true)
    else { setIndex(index + 1); setPassed(false) }
  }
  if (prepared.error) return <p className="error-message" role="alert">{prepared.error}</p>
  return <section className="button-practice" aria-label="บทเรียนแบบกดตอบ">
    <small className="audio-source">เสียงตัวอย่างโดย Kokoro-82M</small>
    {teaching && audio.state !== 'idle' && <p role="status">{audio.state === 'loading' ? 'กำลังเตรียมเสียง…' : 'กำลังเล่นเสียง…'} <button type="button" onClick={audio.stop}>หยุดเสียง</button></p>}
    {teaching ? <div className="speaking-card"><span className="section-kicker">LEARN FIRST</span><h2>เรียนรู้ก่อน แล้วค่อยลองตอบ</h2><p>อ่านความหมายและฟังเสียงตัวอย่าง ก่อนเริ่มแบบฝึก</p><div className="teaching-phrases">{studyPhrases.map((phrase) => <article key={phrase.target}><div><strong lang="en">{phrase.target}</strong><p>{phrase.translation}</p></div><AudioButtons text={phrase.target} onPlay={() => play(phrase.target)} onSlow={() => audio.play(phrase.target, 'slow')} /></article>)}</div>{audio.error && <p role="alert">{audio.error}</p>}<button className="start-button" type="button" onClick={() => { audio.stop(); setTeaching(false) }}>เริ่มทำแบบฝึก</button></div> : <div className="speaking-card">
      <div className="speaking-progress"><span>{finished ? activities.length : index + 1} / {activities.length}</span><progress value={finished ? activities.length : index + Number(passed)} max={activities.length} aria-label="จำนวนข้อที่ผ่าน" /></div>
      {finished ? <PracticeSummary completed={activities.length} retries={mistakes} review={review} onReview={() => restart(true)} onRestart={() => restart()} /> : <>
        <p className="section-kicker">{practiceModes.find((item) => item.id === activities[index].kind)?.label}</p>
        <Question key={`${session}-${index}`} activity={activities[index]} onAttempt={(correct, phrase) => { if (correct) setPassed(true); else { setMistakes((count) => count + 1); if (phrase) setReview((items) => items.some((item) => item.target === phrase.target) ? items : [...items, phrase]) } }} />
        <button className="next-word activity-next" type="button" disabled={!passed} onClick={next}>{index === activities.length - 1 ? 'ดูผล' : 'ข้อต่อไป'}</button>
      </>}
    </div>}
  </section>
}
