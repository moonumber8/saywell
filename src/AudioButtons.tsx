import { Turtle, Volume2 } from 'lucide-react'

type Props = {
  text: string
  onPlay: () => void
  onSlow: () => void
  disabled?: boolean
  normalLabel?: string
  labelWithText?: boolean
}

export default function AudioButtons({ text, onPlay, onSlow, disabled = false, normalLabel = 'ฟังเสียง', labelWithText = true }: Props) {
  return <div className="audio-actions" role="group" aria-label="เสียงตัวอย่าง">
    <button className="example-button audio-button-normal" type="button" disabled={disabled} aria-label={labelWithText ? `ฟัง ${text}` : normalLabel} onClick={onPlay}><Volume2 size={18} aria-hidden="true" /><span>{normalLabel}</span></button>
    <button className="example-button audio-button-slow" type="button" disabled={disabled} aria-label={labelWithText ? `ฟังช้า ${text}` : 'ฟังช้า'} onClick={onSlow}><Turtle size={18} aria-hidden="true" /><span>ฟังช้า</span></button>
  </div>
}
