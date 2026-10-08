import { CircleCheck, CircleX, Info } from 'lucide-react'

export type AnswerResult = 'correct' | 'incorrect' | 'error' | null

export default function AnswerFeedback({ result, message }: { result: AnswerResult; message: string }) {
  const Icon = result === 'correct' ? CircleCheck : result === 'incorrect' ? CircleX : Info
  return <div className={`answer-feedback${result ? ` feedback-${result}` : ''}`} role="status" aria-live="polite" aria-atomic="true">
    {result && <Icon size={32} aria-hidden="true" />}
    <div>{result && <strong>{result === 'correct' ? 'ถูกต้อง!' : result === 'incorrect' ? 'ยังไม่ถูก ลองอีกครั้ง' : 'ยังตรวจคำตอบไม่ได้'}</strong>}<p>{message}</p></div>
  </div>
}
