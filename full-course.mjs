import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { blueprints, rules, strategyNotes } from './course-content.mjs'
import { parseCourseSource, glossaryKey, normalizeSource, readableSource } from './course-source.mjs'

const readCache = (path) => { try { return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) } catch { return {} } }
const glossary = readCache('./data/course-glossary.json')
const dialogueTranslations = readCache('./data/course-dialogue-translations.json')
const reviewedGoals = readCache('./data/course-goals.json')
const digest = (text) => createHash('sha256').update(text).digest('hex').slice(0, 20)
const groups = (items, size) => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size))
const distinctOptions = (answer, others) => [...new Set([answer, ...others])].slice(0, 3)
const question = (id, prompt, answer, others, explanation, audio) => ({ id, prompt, answer, options: distinctOptions(answer, others), explanation, ...(audio ? { audio } : {}) })
const authoredQuestion = (id, input, explanation) => ({ id, ...input, explanation })

const patterns = {
  be: /\b(?:am|are)\b/i, location: /\b(?:where|in|at)\b/i, noun: /\b(?:is|am|are)\b/i, subject: /\b(?:he|she|we|they)\b/i, here: /\b(?:here|there)\b/i,
  adjective: /\b(?:big|little|tall|short|good|new|blue|beautiful)\b/i, negation: /\bnot\b/i, have: /\bhave\b/i, prepositions: /\b(?:behind|next to|across|between|under|in front|on)\b/i,
  continuous: /\b(?:am|is|are|I'm|we're|she's)\b.*\b\w+ing\b/i, clarify: /\b(?:mean|understand|hear|say|what)\b/i, short: /\b(?:yes|no)\b/i, routine: /\b(?:every|always|usually|work|eat|take)\b/i,
  imperative: /\b(?:turn|walk|go|stop|take|look)\b/i, there: /\bthere\b/i, cardinal: /\b(?:one|two|three|four|five|many|number|\d+)\b/i, plural: /\b\w+s\b/i,
  do: /\b(?:do|does|make|makes)\b/i, frequency: /\b(?:always|usually|sometimes|often|never)\b/i, cause: /\b(?:because|so|reason)\b/i, put: /\b(?:put on|take off)\b/i, tag: /\b(?:isn't|aren't|don't|doesn't).*\?/i,
  nationality: /\b(?:from|language|speak|country|American|Canadian)\b/i, future: /\b(?:will|going to|'ll)\b/i, object: /\b(?:him|them|her|us|me)\b/i, ordinal: /\b(?:first|second|third|fourth)\b/i,
  which: /\bwhich\b/i, next: /\b(?:next|every)\b/i, can: /\b(?:can|can't|cannot)\b/i, obligation: /\b(?:have to|has to|then)\b/i, going: /\bgoing to\b/i, want: /\bwant\b/i,
  regular: /\b\w+ed\b/i, should: /\bshould\b/i, ought: /\bought\b/i, irregular: /\b(?:went|was|were|saw|had|did|said|got|took|made)\b/i, pastbe: /\b(?:was|were)\b/i, infinitive: /\bto \w+\b/i,
  compare: /\b(?:than|more|better|bigger|larger|faster|earlier)\b/i, super: /\b(?:best|most|\w+est)\b/i, much: /\b(?:much|many)\b/i, count: /\b(?:some|any|water|food|crab)\b/i,
  indirect: /\b(?:give|show|tell|send|bring)\b/i, interjection: /\b(?:oh|wow|hey|oops)\b/i, agent: /\b\w+er\b/i, might: /\b(?:might|will)\b/i, measure: /\bof\b/i,
  possessive: /\b(?:mine|yours|hers|ours|theirs)\b/i, prefix: /\b(?:un\w+|im\w+|dis\w+|incredible)\b/i, adverb: /\b\w+ly\b/i, compareadverb: /\b(?:more|earlier)\b/i,
  conditional: /\bif\b/i, reflexive: /\b(?:myself|yourself|herself|himself|ourselves|themselves)\b/i, while: /\bwhile\b/i, pastcontinuous: /\b(?:was|were)\b.*\b\w+ing\b/i,
  request: /\b(?:could|would|may)\b/i, timedmodal: /\b(?:could|would|will|had to)\b/i, permission: /\b(?:may|can)\b/i, must: /\b(?:must|mustn't|don't have to)\b/i, futurecontinuous: /\b(?:will|I'll|you'll|we'll).*\bbe\b.*\b\w+ing\b/i,
  borrow: /\b(?:borrow|lend|loan)\b/i, perfect: /\b(?:have|has|I've|you've|he's|she's|ever)\b/i, tenses: /\b(?:was|were|did|have|has|had|will)\b/i, perfectcontinuous: /\bbeen\b.*\b\w+ing\b/i,
  gerund: /\b\w+ing\b/i, phrasal: /\b(?:take off|taken off|come back|find out|get around)\b/i,
}

export function buildStructuredCourse(document) {
  if (!Object.keys(reviewedGoals).length) return null
  const source = parseCourseSource(document)
  if (!source) return null
  // A clean upload must be analyzed when its prepared course data was reset.
  if (!reviewedGoals[source.number]) return null
  if (JSON.stringify(reviewedGoals[source.number]) !== JSON.stringify({ goals: source.goals, strategy: source.strategy })) throw new Error(`เป้าหมาย Lesson ${source.number} เปลี่ยนจากแผนที่ตรวจไว้ กรุณาตรวจแผนให้ตรงกับต้นฉบับใหม่`)
  const [topic, ruleKeys, pronunciationTip, pronunciationAnswer] = blueprints[source.number]
  const units = []
  const add = (id, title, goal, explanation, examples, questions, assessment, extra = {}) => { const item = { id, title, goal, explanation, evidence: '', examples, questions, assessment, sourceSectionIds: [], ...extra }; units.push(item); return item }
  const wordExamples = source.vocabulary.map((entry) => ({ ...entry, translation: glossary[glossaryKey(entry)] || entry.definition, originalDefinition: entry.definition, translated: Boolean(glossary[glossaryKey(entry)]) }))
  const wordLabel = (entry) => `${entry.target} (${entry.definition.match(/^[^. ]+\.?/)?.[0] || 'word'})`
  for (const [index, batch] of groups(wordExamples, 6).entries()) {
    add(`vocabulary-${index + 1}`, `คำศัพท์ ${index * 6 + 1}–${index * 6 + batch.length}`, `เรียนคำศัพท์ครบชุดของบท (${wordExamples.length} รายการ รวมความหมายต่างกันของคำเดียวกัน)`, 'อ่านคำ ความหมายไทย และคำจำกัดความต้นฉบับ แล้วฟังเสียงตัวอย่าง คำที่มีหลายความหมายแยกตามบริบทและชนิดคำ', batch,
      batch.map((entry) => question(`${entry.id}-practice`, `“${wordLabel(entry)}” · ${entry.originalDefinition} · เลือกความหมายในบริบทนี้`, entry.translation, wordExamples.filter((other) => other.id !== entry.id).map((other) => other.translation), `${entry.target} = ${entry.translation}`)),
      batch.map((entry) => question(`${entry.id}-check`, `เลือกคำที่ตรงกับ “${entry.translation}”`, wordLabel(entry), wordExamples.filter((other) => other.id !== entry.id).map(wordLabel), `${entry.target}: ${entry.originalDefinition}`)), { kind: 'vocabulary' })
  }
  const turns = source.turns.map((turn) => ({ ...turn, translation: dialogueTranslations[digest(turn.target)] || `ผู้พูด: ${turn.speaker} · อ่านข้อความอังกฤษจากต้นฉบับ`, translated: Boolean(dialogueTranslations[digest(turn.target)]) }))
  const grammarExamples = [...new Map(ruleKeys.flatMap((key) => turns.filter((turn) => patterns[key]?.test(normalizeSource(turn.target))).slice(0, 2)).map((turn) => [turn.id, turn])).values()]
  const grammar = add('grammar', 'ไวยากรณ์และโครงสร้างครบเป้าหมาย', source.goals.filter((goal) => /Grammar/.test(goal.category)).map((goal) => goal.text).join(' · '), ruleKeys.map((key) => `${rules[key].title}: ${rules[key].explanation}`).join('\n\n'), grammarExamples,
    ruleKeys.map((key) => authoredQuestion(`${key}-practice`, rules[key].practice, rules[key].explanation)), ruleKeys.map((key) => authoredQuestion(`${key}-check`, rules[key].check, rules[key].explanation)), { kind: 'grammar', concepts: ruleKeys })

  if (source.number === 1) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
    const numbers = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty']
    add('alphabet-numbers', 'ตัวอักษรและเลข 1–20', 'ทบทวนตัวอักษรทั้งหมด สะกดชื่อ และนับ 1–20 ตามเป้าหมายบท', 'ฟังชื่ออักษรแล้วลองสะกดชื่อของตัวเอง จากนั้นฟังและนับเลข 1–20', [...alphabet.map((target) => ({ target, translation: `ตัวอักษร ${target}` })), ...numbers.map((target, index) => ({ target, translation: `${index + 1}` }))], numbers.map((target, index) => question(`number-${index}-practice`, `เลข ${index + 1} พูดว่าอะไร?`, target, numbers.filter((other) => other !== target), `${index + 1} = ${target}`)), numbers.map((target, index) => question(`number-${index}-check`, 'ฟังตัวเลขแล้วเลือกจำนวน', `${index + 1}`, numbers.map((_, other) => `${other + 1}`).filter((value) => value !== `${index + 1}`), `${target} = ${index + 1}`, target)), { kind: 'review', reflection: { prompt: 'เขียนชื่อของคุณ แล้วสะกดเป็นตัวอักษรอังกฤษ', minLength: 2, assessment: 'recorded-only' } })
  }

  if (source.number === 18) {
    const ordinals = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth']
    add('ordinal-cards', 'เลขบอกลำดับครบชุดการ์ด', 'ใช้เลขลำดับ first–tenth จากการ์ดกิจกรรมต้นฉบับ', 'ฟังแล้วจับคู่คำกับลำดับ จากนั้นลองใช้เล่าลำดับเรื่องหรือกิจกรรม', ordinals.map((target, index) => ({ target, translation: `ลำดับที่ ${index + 1}` })), ordinals.map((target, index) => question(`ordinal-${index}-practice`, `ลำดับที่ ${index + 1} ใช้คำใด?`, target, ordinals.filter((other) => other !== target), `${target} = ลำดับที่ ${index + 1}`)), ordinals.map((target, index) => question(`ordinal-${index}-check`, 'ฟังแล้วเลือกลำดับ', `${index + 1}`, ordinals.map((_, other) => `${other + 1}`).filter((value) => value !== `${index + 1}`), `${target} = ${index + 1}`, target)), { kind: 'review' })
  }
  if ([19, 22].includes(source.number)) {
    const seasons = [['spring', 'ฤดูใบไม้ผลิ'], ['summer', 'ฤดูร้อน'], ['fall', 'ฤดูใบไม้ร่วง'], ['winter', 'ฤดูหนาว']]
    const months = [['January', 'มกราคม'], ['February', 'กุมภาพันธ์'], ['March', 'มีนาคม'], ['April', 'เมษายน'], ['May', 'พฤษภาคม'], ['June', 'มิถุนายน'], ['July', 'กรกฎาคม'], ['August', 'สิงหาคม'], ['September', 'กันยายน'], ['October', 'ตุลาคม'], ['November', 'พฤศจิกายน'], ['December', 'ธันวาคม']]
    const items = source.number === 19 ? [...months, ...seasons] : seasons
    add('calendar', source.number === 19 ? 'เดือนทั้ง 12 และฤดูกาล' : 'ฤดูกาลและแผนวันหยุด', 'เรียนชื่อเดือนและฤดูกาลเพื่อใช้บอกเวลาหรือแผนตามหัวข้อของบท', 'ฤดูกาลและช่วงเดือนอาจต่างกันตามพื้นที่ ใช้ชื่อเดือนบอกเวลาชัดเจน และใช้รูปอนาคตหรือคำบอกเวลาให้ตรงกับแผน', items.map(([target, translation]) => ({ target, translation })), items.map(([target, translation], index) => question(`calendar-${index}-practice`, `“${target}” หมายถึงอะไร?`, translation, items.filter(([other]) => other !== target).map(([, meaning]) => meaning), `${target} = ${translation}`)), items.map(([target, translation], index) => question(`calendar-${index}-check`, 'ฟังชื่อเดือนหรือฤดูกาลแล้วเลือกความหมาย', translation, items.filter(([other]) => other !== target).map(([, meaning]) => meaning), `${target} = ${translation}`, target)), { kind: 'review' })
  }
  if (source.number === 23) {
    const bank = [question('time-money-1', 'บทสนทนาระบุเวลา 11:50 ข้อใดตรงกับเวลานี้?', 'eleven-fifty', ['eleven-fifteen', 'twelve-fifty'], '11:50 = eleven-fifty'), question('time-money-2', 'จ่าย $10 ซื้ออาหารราคา $7 ได้เงินทอนเท่าไรตามบท?', '$3', ['$7', '$10'], '10 − 7 = 3'), question('time-money-3', 'ซื้ออาหารราคา $5 ด้วยเงิน $10 ได้เงินทอนเท่าไร?', '$5', ['$10', '$15'], '10 − 5 = 5')]
    add('time-money', 'บอกเวลาและนับเงินทอน', 'อ่านเวลาและคำนวณเงินทอนจากตัวอย่างในบท', 'แยกชั่วโมงกับนาที และตรวจเงินทอนจากเงินที่จ่ายลบราคาอาหาร ตามตัวอย่าง Jonathan และ Anna', [], bank.map((item) => ({ ...item, id: `${item.id}-practice` })), bank.map((item) => ({ ...item, id: `${item.id}-check` })), { kind: 'review' })
  }

  const speakingUnits = []
  for (const [index, batch] of groups(turns, 6).entries()) {
    const questions = batch.map((turn) => {
      const first = (turn.target.match(/[A-Za-z0-9][\s\S]*/)?.[0] || turn.target).split(/(?<=[.!?])\s+/)[0]
      const words = [...first.matchAll(/[A-Za-z0-9]+(?:[’'][A-Za-z]+)?/g)]
      const word = [...words].reverse().find((match) => match[0].length > 2) || words[0]
      if (!word) throw new Error(`อ่านประโยค ${turn.id} ไม่ได้`)
      const blank = `${first.slice(0, word.index)}____${first.slice(word.index + word[0].length)}`
      const distractors = turns.flatMap((other) => other.target.match(/[A-Za-z]+(?:[’'][A-Za-z]+)?/g) || []).filter((other) => other.toLowerCase() !== word[0].toLowerCase())
      return question(`${turn.id}-practice`, `${turn.speaker}: ${blank} · เติมคำตามตัวอย่างในบท`, word[0], distractors, `${first}${turn.translated ? ` · ${turn.translation}` : ''}`)
    })
    const assessment = questions.map((item, turnIndex) => ({ ...item, id: item.id.replace('-practice', '-check'), prompt: `ฟัง ${batch[turnIndex].speaker} แล้วเลือกคำที่หายไป: ${item.prompt.split(' · ')[0]}`, audio: (batch[turnIndex].target.match(/[A-Za-z0-9][\s\S]*/)?.[0] || batch[turnIndex].target).split(/(?<=[.!?])\s+/)[0] }))
    speakingUnits.push(add(`conversation-${index + 1}`, `บทสนทนา ${index + 1}/${Math.ceil(turns.length / 6)}`, 'อ่าน ฟัง และฝึกใช้บทสนทนาครบทุกช่วงของบท', 'ดูว่าใครพูดกับใคร อ่านความหมายในบริบท แล้วฝึกเติมคำจากตัวอย่าง ก่อนตรวจด้วยเสียงอ่าน สามารถฝึกพูดผ่านไมโครโฟนเพิ่มเติมได้', batch, questions, assessment, { kind: 'conversation' }))
  }
  const pronunciation = add('pronunciation', 'เสียงและจังหวะการพูด', source.goals.filter((goal) => /Pronunciation/.test(goal.category)).map((goal) => goal.text).join(' · '), pronunciationTip, [],
    [question('pronunciation-practice', 'ข้อใดตรงกับสิ่งที่บทนี้ให้ฝึก?', pronunciationAnswer, ['ใช้เสียงจากภาษาอื่นแทนทุกคำ', 'อ่านทุกคำโดยไม่ดูบริบทหรือน้ำเสียง'], pronunciationTip)],
    [question('pronunciation-check', 'หลังเรียนหัวข้อนี้ ควรนำหลักการใดไปฝึกกับตัวอย่าง?', pronunciationAnswer, ['ทุกคำต้องออกเสียงเหมือนตัวสะกดทุกตัว', 'เสียงและจังหวะไม่มีผลต่อการฟัง'], pronunciationTip)], { kind: 'pronunciation', audioAssessment: 'not-assessed', originalTasks: source.pronunciationText })
  const note = strategyNotes.find(([pattern]) => pattern.test(source.strategy))
  if (!note) throw new Error(`ยังไม่ได้ตรวจกลยุทธ์การเรียน Lesson ${source.number}`)
  const strategy = add('strategy', `กลยุทธ์: ${note[1]}`, `นำ ${source.strategy} ไปใช้กับการเรียนบทนี้`, note[2], [],
    [question('strategy-practice', `วิธีใดตรงกับกลยุทธ์ ${source.strategy}?`, note[2], ['ทำต่อไปโดยไม่สนใจว่าตัวเองเข้าใจหรือไม่', 'หลีกเลี่ยงการใช้สิ่งที่เพิ่งเรียน'], note[2])],
    [question('strategy-check', 'ควรนำกลยุทธ์ของบทนี้ไปใช้แบบใด?', note[2], ['อ่านเพียงชื่อกลยุทธ์แล้วหยุดฝึก', 'ใช้วิธีเดิมทุกครั้งโดยไม่ดูเป้าหมาย'], note[2])], { kind: 'strategy', reflection: { prompt: `จะใช้ “${note[1]}” ในการฝึกครั้งนี้อย่างไร? จดแผนของตัวเอง`, minLength: 5, assessment: 'recorded-only' } })
  const activity = add('activities', 'กิจกรรมประยุกต์ของบท', 'นำโครงสร้างและบทสนทนาไปใช้กับสถานการณ์ของตัวเอง', 'อ่านกิจกรรมจากต้นฉบับด้านล่าง เลือกทำกับเพื่อนหรือปรับเป็นการฝึกด้วยตัวเอง แล้วจดว่าลองใช้คำและโครงสร้างใด แบบตรวจนี้วัดความเข้าใจหลักการ ส่วนการทำกิจกรรมจริงเป็นบันทึกการฝึก', [], grammar.questions.map((item) => ({ ...item, id: `activity-${item.id}` })), grammar.assessment.map((item) => ({ ...item, id: `activity-${item.id}` })), { kind: 'activities', reflection: { prompt: 'เลือกกิจกรรมหนึ่งจากต้นฉบับ แล้วบันทึกสิ่งที่ลองทำหรือประโยคที่ลองใช้', minLength: 5, assessment: 'recorded-only' } })
  const writing = add('writing', 'เขียนจากหัวข้อของบท', 'เขียนตามโจทย์ Writing ของบท ไม่ใช้โจทย์เดียวกันทุกบท', 'อ่านหัวข้องานเขียนต้นฉบับ เขียนร่างในช่องด้านล่าง แล้วตรวจคำและโครงสร้างที่เรียน แบบตรวจวัดความรู้โครงสร้างเท่านั้น ร่างงานเขียนบันทึกเพื่อทบทวนและยังไม่ได้ประเมินคุณภาพ', [], grammar.questions.map((item) => ({ ...item, id: `writing-${item.id}` })), grammar.assessment.map((item) => ({ ...item, id: `writing-${item.id}` })), { kind: 'writing', writingAssessment: 'guided-only', originalTasks: source.writingText, reflection: { prompt: 'เขียนร่างภาษาอังกฤษตามโจทย์ต้นฉบับของบทนี้', minLength: 10, assessment: 'recorded-only' } })
  const listeningExamples = turns.filter((turn) => turn.translated && turn.target.length > 15)
  const selected = listeningExamples.filter((_, index) => index % Math.max(1, Math.floor(listeningExamples.length / 6)) === 0).slice(0, 6)
  // These are labelled adapted listening checks. The original quiz is preserved
  // in full for study, including questions requiring the original video/images.
  const listeningBank = selected.length >= 2 ? selected.map((turn, index) => question(`listening-${index}`, 'ฟังข้อความ แล้วเลือกความหมายที่ตรงกับสิ่งที่ได้ยิน', turn.translation, listeningExamples.filter((other) => other.id !== turn.id).map((other) => other.translation), `${turn.target} · ${turn.translation}`, turn.target)) : speakingUnits.flatMap((item) => item.assessment).slice(0, 6).map((item, index) => ({ ...item, id: `listening-${index}` }))
  const listening = add('listening', 'ฟังและทบทวนท้ายบท', 'เข้าใจข้อความในบทและทบทวน Listening Quiz ต้นฉบับครบชุด', 'ข้อฟังในแอปปรับจากบทสนทนาของบทนี้ ใช้เสียงอ่านแทนวิดีโอ ด้านล่างมีโจทย์ท้ายบทต้นฉบับครบชุดไว้ทำต่อ ข้อที่ต้องดูภาพหรือวิดีโอต้นฉบับยังไม่ได้ตรวจคะแนนในแอป', [], listeningBank.map((item) => ({ ...item, id: `${item.id}-practice` })), listeningBank.map((item) => ({ ...item, id: `${item.id}-check` })), { kind: 'listening', originalTasks: source.quizText })

  for (const section of source.sourceSections) {
    let owners
    if (/^Key Words$/.test(section.title)) owners = units.filter((item) => item.kind === 'vocabulary')
    else if (/^Pronunciation Practice/.test(section.title)) owners = [pronunciation]
    else if (/^Writing$/.test(section.title)) owners = [writing]
    else if (/^(Listening Quiz|Quiz\s*[-–])/.test(section.title)) owners = [listening]
    else if (/^Conversation$/.test(section.title)) owners = [grammar, ...speakingUnits]
    else if (/^Learning Strategy/.test(section.title) && section.start > document.content.indexOf('Goals')) owners = [strategy]
    else if (/^(Goals|Speaking Practice|Main Video Script)/.test(section.title)) owners = [grammar, ...speakingUnits]
    else owners = [activity]
    section.unitIds = owners.map((item) => item.id)
    for (const owner of owners) owner.sourceSectionIds.push(section.id)
  }
  // Additional review units use the actual resource/teaching sections of their
  // chapter. This also keeps their original instructions one click away.
  for (const item of units.filter((unit) => unit.kind === 'review')) {
    item.sourceSectionIds = [...new Set([...grammar.sourceSectionIds, ...activity.sourceSectionIds])]
    for (const section of source.sourceSections.filter((section) => item.sourceSectionIds.includes(section.id))) if (!section.unitIds.includes(item.id)) section.unitIds.push(item.id)
  }
  activity.originalTasks = readableSource(source.sourceSections.filter((section) => /^Activity/.test(section.title)).map((section) => section.text).join('\n\n'))
  const goalCoverage = source.goals.map((goal) => ({ ...goal, unitIds: /Review/.test(goal.category) ? ['alphabet-numbers'] : [...new Set([...(goal.category.includes('Grammar') ? [grammar.id] : []), ...(goal.category.includes('Speaking') ? speakingUnits.map((item) => item.id) : []), ...(goal.category.includes('Pronunciation') ? [pronunciation.id] : [])])] }))
  for (const item of units) {
    item.evidence = item.kind === 'vocabulary' ? 'Key Words' : item.kind === 'conversation' ? 'Conversation' : item.kind === 'grammar' ? source.goals.filter((goal) => /Grammar/.test(goal.category)).map((goal) => goal.text).join(' · ') : item.kind === 'strategy' ? `Learning Strategy: ${source.strategy}` : item.kind === 'review' ? 'Review alphabet and numbers 1-20' : item.kind === 'pronunciation' ? pronunciation.goal : item.kind === 'writing' ? 'Writing' : item.kind === 'listening' ? 'Listening Quiz / Quiz' : 'Classroom activities and resources'
    item.speechExercises = item.examples.filter((example) => example.translated && example.target.length <= 120 && example.translation.length <= 200).map(({ target, translation }) => ({ target: target.replace(/[’‘]/g, "'").replace(/[^A-Za-z' ]/g, ' ').replace(/\s+/g, ' ').trim(), translation })).filter((example) => /^[A-Za-z]+(?:'[A-Za-z]+)?(?: [A-Za-z]+(?:'[A-Za-z]+)?)*$/.test(example.target))
    if (item.questions.some((q) => q.options.length < 2) || item.assessment.some((q) => q.options.length < 2)) throw new Error(`ตัวเลือกไม่ครบใน ${item.id}`)
  }
  const revision = digest(JSON.stringify({ content: document.content, units, version: 3 }))
  return { documentId: document.id, revision, lessonNumber: source.number, level: document.level, title: `Lesson ${source.number} — ${topic}`, sourceTitle: document.title, pageStart: document.pageStart, pageEnd: document.pageEnd, units, passPercent: 80, coverage: goalCoverage.map((goal) => goal.text), goalCoverage, sourceSections: source.sourceSections, contentStats: { sourceCharacters: document.content.length, mappedCharacters: source.sourceSections.reduce((count, section) => count + section.text.length, 0), sourceSections: source.sourceSections.length, vocabulary: wordExamples.length, dialogueTurns: turns.length, goals: goalCoverage.length }, translations: { vocabulary: wordExamples.filter((item) => item.translated).length, dialogue: turns.filter((item) => item.translated).length }, limitations: ['ตรวจความเข้าใจตามเป้าหมาย ไม่ใช่ใบรับรองทักษะทั้งหมด', 'เสียงอ่านจากเบราว์เซอร์ ยังไม่ประเมินการออกเสียงจากเสียงจริง', 'กิจกรรมและร่างงานเขียนบันทึกเพื่อทบทวน ยังไม่ประเมินคุณภาพงานอิสระ', 'คำแปลไทยเตรียมด้วย AI มีคำจำกัดความและข้อความอังกฤษต้นฉบับให้ตรวจเทียบ', 'โจทย์ฟังในแอปปรับจากบทสนทนา ข้อสอบต้นฉบับที่ต้องใช้ภาพหรือวิดีโอยังไม่ได้ตรวจคะแนน'] }
}

export function structuredMetadata(document) {
  const plan = buildStructuredCourse(document)
  if (!plan) return null
  const source = parseCourseSource(document)
  return { structured: true, lessonNumber: source.number, structuredTitle: plan.title, structuredUnits: plan.units.length, structuredRevision: plan.revision, topic: blueprints[source.number][0], preview: source.turns.slice(0, 2).map((turn) => turn.target).join(' · '), goals: source.goals.length, vocabulary: source.vocabulary.length, sourceSections: source.sourceSections.length }
}

export function gradeUnit(course, unitId, answers, reflection = '') {
  const unit = course.units.find((item) => item.id === unitId)
  if (!unit || !answers || typeof answers !== 'object' || Array.isArray(answers)) throw new Error('ข้อมูลแบบตรวจความเข้าใจไม่ถูกต้อง')
  if (unit.reflection && (typeof reflection !== 'string' || reflection.trim().length < unit.reflection.minLength || reflection.length > 6000)) throw new Error('บันทึกการฝึกหรือร่างงานเขียนก่อนส่งตรวจความเข้าใจ')
  const correct = unit.assessment.filter((q) => answers[q.id] === q.answer).map((q) => q.id)
  const ratio = correct.length / unit.assessment.length * 100
  return { unitId, revision: course.revision, score: Math.round(ratio), passed: ratio >= course.passPercent, correct, total: unit.assessment.length, ...(unit.reflection ? { reflectionStatus: 'recorded-not-assessed' } : {}), review: unit.assessment.filter((q) => !correct.includes(q.id)).map(({ id, prompt, answer, explanation }) => ({ id, prompt, answer, explanation })) }
}
