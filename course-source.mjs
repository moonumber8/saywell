// Read the imported teacher's guide without a retrieval window or AI truncation.
import { createHash } from 'node:crypto'
export const glossaryKey = (entry) => createHash('sha256').update(`${entry.target}\n${entry.definition}`).digest('hex').slice(0, 20)
const pageHeader = /^Let[’']s Learn English[^\n]*$/gm
export const normalizeSource = (text) => text.replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim()
export const readableSource = (text) => text.replace(pageHeader, '').replace(/^Day \d+\s*$/gm, '').replace(/\n{3,}/g, '\n\n').trim()
const block = (content, heading, end) => content.match(new RegExp(`^${heading}\\s*\\n([\\s\\S]*?)(?=^${end}|$(?![\\s\\S]))`, 'm'))?.[1] || ''

export function parseCourseSource(document) {
  const number = Number(document?.title?.match(/Lesson (\d+)$/)?.[1])
  if (!number || number > 52 || !/VOA.*Learn.*English/i.test(document.title)) return null
  const content = document.content
  if (typeof content !== 'string' || !new RegExp(`Let[’']s Learn English\\s+Lesson ${number}\\s+\\d+`).test(content)) throw new Error(`เนื้อหาต้นฉบับไม่ตรงกับ Lesson ${number}`)
  const goalsText = block(content, 'Goals', '(?:Level 1|Let[’\']s Learn English|Teach Key Words)')
  const topics = normalizeSource(block(content, 'Topics', 'Prepare Before Class'))
  const strategy = normalizeSource(block(content, 'Learning Strategy', 'Goals'))
  const goals = [...goalsText.matchAll(/^(Grammar(?: and Speaking)?|Speaking(?: and Pronunciation)?|Pronunciation):\s*([\s\S]*?)(?=^(?:Grammar(?: and Speaking)?|Speaking(?: and Pronunciation)?|Pronunciation):|$(?![\s\S]))/gm)].map((match, index) => ({ id: `goal-${index + 1}`, category: match[1], text: normalizeSource(match[2]) }))
  if (/Review alphabet and numbers 1-20/i.test(goalsText)) goals.push({ id: 'goal-alphabet-numbers', category: 'Review', text: 'Review alphabet and numbers 1-20' })
  const vocabularyText = readableSource(block(content, 'Key Words', '(?:Conversation|Resources|Quiz\\s*[-–]|Activity|Past tense verbs|America[’\']s Presidents|American Presidents[^\\n]*|Let[’\']s Learn English\\s+Additional Resources)'))
  const entryStart = /^([^\n]+?)\s*[-–]\s*((?:n|v|adj|adv|prep|pron|interjection|expression|phrase|phrasal verb|proper noun|conj|conjunction|modal verb|modal|noun phrase|idiom|trademark|abbrev|p)(?:\.+\s*|\s+)|(?:to|a|an|the|used|made or done)\b)/gm
  const starts = [...vocabularyText.matchAll(entryStart)]
  const vocabulary = starts.map((match, index) => ({ id: `word-${index + 1}`, target: match[1].trim().replace(/\s*[-–]\s*$/, ''), definition: normalizeSource(vocabularyText.slice(match.index + match[0].length - match[2].length, starts[index + 1]?.index ?? vocabularyText.length).replace(/^\* This word[^\n]*/gm, '')) }))
  const conversationText = readableSource(block(content, 'Conversation', '(?:Key Words|Resources|Quiz\\s*[-–]|Activity)'))
  const turns = []
  for (const line of conversationText.split('\n')) {
    const speaker = line.match(/^([A-Z][A-Za-z .’'-]{0,30})(?::\s*|\s*\t\s*)(.*)$/)
    if (speaker) turns.push({ id: `line-${turns.length + 1}`, speaker: speaker[1].trim(), target: speaker[2].trim() })
    else if (turns.length && line.trim() && !/^Resources$/.test(line)) turns.at(-1).target += ` ${line.trim()}`
  }
  // Consecutive, lossless source slices make the coverage inspectable. A slice
  // always belongs to a study unit, including classroom instructions/resources.
  const boundaries = [0, ...[...content.matchAll(/^(?:Topics|Prepare Before Class|Learning Strategy(?:[^\n]*)|Goals|Introduce the Lesson(?: Topic)?|Present the Conversation|Teach (?:the )?Key Words|Main Video Script[^\n]*|Speaking Practice(?:[^\n]*)|Pronunciation Practice(?:[^\n]*)|Activity[^\n]*|Writing|Listening Quiz|Conversation(?: Review| Activity)?|Key Words|Past tense verbs|America[’']s Presidents|American Presidents[^\n]*|Resources|Quiz\s*[-–][^\n]*|Review(?:[^\n]*)|Additional\nResources)\s*$/gm)].map((match) => match.index).filter((index) => index > 0), content.length]
  const sourceSections = boundaries.slice(0, -1).map((start, index) => {
    const text = content.slice(start, boundaries[index + 1])
    return { id: `source-${index + 1}`, title: text.split('\n')[0].trim(), start, end: boundaries[index + 1], text }
  })
  const pronunciationText = readableSource(sourceSections.filter((section) => /^Pronunciation Practice/.test(section.title)).map((section) => section.text).join('\n\n'))
  const writingText = readableSource(sourceSections.filter((section) => section.title === 'Writing').map((section) => section.text).join('\n\n'))
  const quizText = readableSource(sourceSections.filter((section) => /^Quiz\s*[-–]/.test(section.title)).map((section) => section.text).join('\n\n'))
  if (!goals.length || !goals.some((goal) => goal.category.includes('Grammar')) || !goals.some((goal) => goal.category.includes('Speaking')) || !goals.some((goal) => goal.category.includes('Pronunciation')) || !topics || !strategy || !vocabulary.length || !turns.length || !writingText || !quizText) throw new Error(`อ่านโครงสร้าง Lesson ${number} ไม่ครบ กรุณาตรวจต้นฉบับก่อนจัดหลักสูตร`)
  return { number, topics, strategy, goals, vocabulary, turns, pronunciationText, writingText, quizText, sourceSections }
}
