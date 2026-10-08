export type Phrase = { target: string; translation: string; sourceId: string }
export type PracticeMode = 'mixed' | 'choice' | 'listen' | 'arrange' | 'fill' | 'match' | 'speak'
export const practiceModes: { id: PracticeMode; label: string; detail: string }[] = [
  { id: 'mixed', label: 'หลายรูปแบบ', detail: 'สลับแบบฝึกด้วยปุ่ม' },
  { id: 'choice', label: 'เลือกคำตอบ', detail: 'เลือกความหมายที่ถูกต้อง' },
  { id: 'listen', label: 'ฟังแล้วเลือก', detail: 'ฟังอังกฤษ เลือกความหมาย' },
  { id: 'arrange', label: 'เรียงประโยค', detail: 'กดคำตามลำดับ' },
  { id: 'fill', label: 'เติมคำ', detail: 'เลือกคำที่หายไป' },
  { id: 'match', label: 'จับคู่', detail: 'จับคู่อังกฤษกับไทย' },
  { id: 'speak', label: 'ฝึกพูด', detail: 'พูดผ่านไมโครโฟน' },
]
export type Activity = {
  kind: Exclude<PracticeMode, 'mixed' | 'speak'>
  phrase: Phrase
  options: string[]
  answer: string
  tokens: { id: number; word: string }[]
  blank: number
  pairs: Phrase[]
  rightOrder: number[]
}

export function shuffled<T>(values: T[], random = Math.random): T[] {
  const result = [...values]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    const temporary = result[i]
    result[i] = result[j]
    result[j] = temporary
  }
  return result
}

const englishKey = (text: string) => text.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim()
export function correctArrangement(target: string, chosen: string[]) {
  return englishKey(target) === englishKey(chosen.join(' '))
}

export function buildActivities(phrases: Phrase[], mode: Exclude<PracticeMode, 'speak'>, random = Math.random): Activity[] {
  if (phrases.length < 3) throw new Error('ต้องมีอย่างน้อย 3 ประโยค')
  const kinds: Activity['kind'][] = mode === 'mixed' ? ['choice', 'listen', 'arrange', 'fill', 'match'] : phrases.map(() => mode)
  return kinds.map((kind, index) => {
    const phrase = phrases[index % phrases.length]
    const words = phrase.target.split(' ')
    const blank = Math.floor(random() * words.length)
    const answer = kind === 'fill' ? words[blank] : phrase.translation
    const pool = kind === 'fill' ? phrases.flatMap((item) => item.target.split(' ')) : phrases.map((item) => item.translation)
    const unique = [...new Map(pool.map((item) => [englishKey(item), item])).values()]
    const distractors = shuffled(unique.filter((item) => englishKey(item) !== englishKey(answer)), random).slice(0, 3)
    if ((kind === 'choice' || kind === 'listen' || kind === 'fill') && !distractors.length) throw new Error('เนื้อหาชุดนี้ยังมีตัวเลือกไม่พอ กรุณาสร้างบทเรียนใหม่')
    const pairs = phrases.filter((item, i) => phrases.findIndex((other) => englishKey(other.translation) === englishKey(item.translation)) === i).slice(0, 4)
    if (kind === 'match' && pairs.length < 2) throw new Error('ต้องมีความหมายต่างกันอย่างน้อย 2 คู่ กรุณาสร้างบทเรียนใหม่')
    const tokens = shuffled(words.map((word, id) => ({ id, word })), random)
    if (words.length > 1 && correctArrangement(phrase.target, tokens.map((item) => item.word))) {
      const different = tokens.findIndex((item) => englishKey(item.word) !== englishKey(tokens[0].word))
      if (different > 0) [tokens[0], tokens[different]] = [tokens[different], tokens[0]]
    }
    return { kind, phrase, answer, options: shuffled([answer, ...distractors], random), blank, tokens, pairs, rightOrder: shuffled(pairs.map((_, i) => i), random) }
  })
}
