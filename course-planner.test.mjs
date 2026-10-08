import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createCoursePlanner, planningSections, validateSectionAnalysis, assemblePlannedCourse, loadPlannedCourse, sourceCandidates, resolveSectionSelection, isTeacherGuide } from './course-planner.mjs'
import { buildStructuredCourse, structuredMetadata, gradeUnit } from './structured-course.mjs'

const document = { id: 'new-pdf-1', title: 'New travel course', level: 'A2', content: 'Goals: Ask for travel information.\nConversation\nWhere is the station?\nI need a ticket.\nThank you for your help.', pageStart: 1, pageEnd: 2 }
function analysis(source = document.content) {
  const target = source.match(/Where is the station\?/i)?.[0] || source.match(/Hello there\./i)?.[0] || 'I need a ticket.'
  return { summary: 'เนื้อหาสอนการถามและขอข้อมูลอย่างสุภาพ', referenceReason: '', units: [{ title: 'ถามข้อมูลการเดินทาง', kind: 'conversation', explanation: 'ใช้ Where is เพื่อถามสถานที่ และอ่านประโยคจากต้นฉบับก่อนลองฝึก', objectives: [{ text: 'ถามข้อมูลสถานที่จากตัวอย่างในบท', evidence: target }], examples: [{ target, translation: 'สถานีอยู่ที่ไหน' }], practiceTask: 'อ่านตัวอย่างแล้วลองพูดตามช้า ๆ', requiresMedia: false }] }
}
function response(input, options) {
  const { sourceCandidates: candidates } = JSON.parse(JSON.parse(options.body).messages[1].content)
  const selection = { ...input, units: input.units.map(unit => ({ ...unit,
    objectives: unit.objectives.map(objective => ({ goalThai: objective.text, evidenceId: candidates.find(candidate => candidate.text === objective.evidence)?.id || 'invented' })),
    examples: unit.examples.map(example => ({ sourceId: candidates.find(candidate => candidate.example && candidate.text === example.target)?.id || 'invented', translation: example.translation })),
  })) }
  return Response.json({ message: { content: JSON.stringify(selection) } })
}
async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'saywell-planner-'))
  t.after(() => rm(path, { force: true, recursive: true }))
  return path
}

test('planning reads every extracted character without a retrieval window, overlap or truncation', () => {
  const content = ('Hello there.\n' + 'x'.repeat(4700) + '😀\n').repeat(3)
  const sections = planningSections({ ...document, content })
  assert.ok(sections.length > 3)
  assert.equal(sections.map(section => section.text).join(''), content)
  assert.equal(sections[0].start, 0)
  assert.equal(sections.at(-1).end, content.length)
  for (let index = 0; index < sections.length; index++) {
    assert.equal(sections[index].end - sections[index].start, sections[index].text.length)
    if (index) assert.equal(sections[index].start, sections[index - 1].end)
    assert.ok(!/[\uD800-\uDBFF]$/.test(sections[index].text))
  }
  assert.throws(() => planningSections(document, 0))
})

test('AI plans reject invented evidence, phrases, duplicate examples, missing Thai and skipped teaching sections', () => {
  const section = planningSections(document)[0]
  assert.equal(validateSectionAnalysis(analysis(), section).units.length, 1)
  const invalidKind = analysis()
  invalidKind.units[0].kind = 'test'
  assert.throws(() => validateSectionAnalysis(invalidKind, section), /kind.*vocabulary.*review/)
  const reading = analysis()
  reading.units[0].kind = 'reading'
  assert.equal(validateSectionAnalysis(reading, section).units[0].kind, 'reading')
  for (const change of [
    item => { item.units[0].objectives[0].evidence = 'Invented source goal' },
    item => { item.units[0].examples[0].target = 'Where is my hotel?' },
    item => { item.units[0].examples[0].target = 'he' },
    item => { item.units[0].examples.push(item.units[0].examples[0]) },
    item => { item.units[0].examples[0].translation = 'English only' },
    item => { item.units = []; item.referenceReason = 'ไม่มีเนื้อหาการเรียน' },
  ]) {
    const item = analysis()
    change(item)
    assert.throws(() => validateSectionAnalysis(item, section))
  }
})

test('prepared courses reuse the course player and server grading without a live AI call', () => {
  const plan = assemblePlannedCourse(document, [analysis()], 'test-model')
  assert.equal(plan.origin, 'ai-import')
  assert.equal(plan.contentStats.analyzedCharacters, document.content.length)
  assert.equal(plan.contentStats.mappedCharacters, document.content.length)
  assert.equal(plan.sourceSections[0].text, document.content)
  assert.equal(plan.units[0].assessment[0].audio, 'Where is the station?')
  assert.equal(plan.units[0].assessment[0].options.length, 3)
  const unit = plan.units[0]
  const answers = Object.fromEntries(unit.assessment.map(question => [question.id, question.answer]))
  assert.equal(gradeUnit(plan, unit.id, answers).passed, true)
  assert.equal(gradeUnit(plan, unit.id, {}).passed, false)
  const writing = analysis()
  writing.units[0].kind = 'writing'; writing.units[0].requiresMedia = true
  const writingPlan = assemblePlannedCourse(document, [writing], 'test-model')
  assert.match(writingPlan.units[0].mediaNote, /ภาพ/)
  assert.throws(() => gradeUnit(writingPlan, 'unit-1', answers), /บันทึก/)
  assert.equal(gradeUnit(writingPlan, 'unit-1', answers, 'My practice draft').reflectionStatus, 'recorded-not-assessed')
  assert.throws(() => assemblePlannedCourse(document, [], 'test-model'), /ครบ/)
})

test('reference material is analyzed and preserved without claiming graded teaching coverage', () => {
  const reference = { ...document, content: 'Copyright 2025. All rights reserved. See publisher website.' }
  const referenceAnalysis = { summary: 'ข้อมูลลิขสิทธิ์และเว็บไซต์ของสำนักพิมพ์', referenceReason: 'เป็นข้อมูลประกอบ ไม่มีเนื้อหาการฝึกภาษา', units: [] }
  assert.equal(assemblePlannedCourse(reference, [referenceAnalysis], 'test-model'), null)
})

test('a teacher guide with Writing headings remains reference material; learner lessons cannot skip headings', async t => {
  const guide = { ...document, title: 'random-upload-name — Introduction', content: "Let's Learn English\tHow-To Guide\t1\nWriting\nThe writing assignment for each lesson set is related to the topic and goals of the lesson.\nHave students practice the phrases in the Main Video Script box." }
  const reference = { summary: 'คู่มือครูอธิบายการใช้กิจกรรมเขียนและการฝึกพูด', referenceReason: 'เป็นวิธีใช้หลักสูตรสำหรับผู้สอน ไม่มีบทเรียนสำหรับผู้เรียนในส่วนนี้', units: [] }
  assert.equal(isTeacherGuide(guide), true)
  assert.throws(() => validateSectionAnalysis(reference, planningSections(guide)[0]))
  assert.equal(assemblePlannedCourse(guide, [reference], 'test-model'), null)
  const learner = { ...guide, content: guide.content + "\nLet's Learn English\tLesson 1\t4\nGoals\nGrammar: Verb BE\nConversation\nHello there." }
  assert.equal(isTeacherGuide(learner), false)
  assert.throws(() => assemblePlannedCourse(learner, [reference], 'test-model'))
  const path = await directory(t)
  const planner = createCoursePlanner({ directory: path, baseUrl: 'http://test-ai', model: 'test-model', fetcher: (_url, options) => {
    assert.match(JSON.parse(JSON.parse(options.body).messages[1].content).documentPurpose, /teacher how-to guide/)
    return Response.json({ message: { content: JSON.stringify(reference) } })
  } })
  assert.equal((await planner.prepare(guide)).isGuide, true)
  assert.equal(planner.snapshot(guide).status, 'ready')
  assert.equal(planner.snapshot(guide).course, null)
})

test('planner repairs invalid output once and persists source-validated plans across restarts', async t => {
  const path = await directory(t)
  let calls = 0
  const planner = createCoursePlanner({ directory: path, baseUrl: 'http://test-ai', model: 'test-model', fetcher: async (_url, options) => {
    calls++
    const payload = JSON.parse(options.body)
    assert.equal(payload.think, false)
    assert.equal(JSON.parse(payload.messages[1].content).source, document.content)
    const item = analysis()
    if (calls === 1) item.units[0].examples[0].target = 'An invented sentence.'
    else assert.match(JSON.parse(payload.messages[1].content).correction, /ต้นฉบับ/)
    return response(item, options)
  } })
  const progress = []
  assert.equal((await planner.prepare(document, update => progress.push(update))).units, 1)
  assert.equal(calls, 2)
  assert.ok(progress.some(update => update.attempt === 2))
  assert.equal(planner.snapshot(document).status, 'ready')
  assert.equal(buildStructuredCourse(document, path).units.length, 1)
  assert.equal(structuredMetadata(document, path).planningOrigin, 'ai-import')
  const restarted = createCoursePlanner({ directory: path, baseUrl: 'http://test-ai', model: 'test-model', fetcher: () => { throw new Error('Must reuse persisted plan') } })
  assert.equal((await restarted.prepare(document)).units, 1)
  assert.equal(loadPlannedCourse({ ...document, content: document.content + '\nNew goal.' }, path).status, 'stale')
  assert.equal(buildStructuredCourse({ ...document, content: document.content + '\nNew goal.' }, path), null)
  assert.match(structuredMetadata({ ...document, content: document.content + '\nNew goal.' }, path).structuredError, /ต้นฉบับเปลี่ยน/)
})

test('failed analysis resumes after restart without regenerating completed source slices', async t => {
  const path = await directory(t)
  const large = { ...document, content: ('Hello there.\n' + 'Practice notes. '.repeat(380)) }
  const sections = planningSections(large)
  assert.ok(sections.length > 1)
  let calls = 0
  const first = createCoursePlanner({ directory: path, baseUrl: 'http://test-ai', model: 'test-model', fetcher: async (_url, options) => {
    const source = JSON.parse(JSON.parse(options.body).messages[1].content).source
    calls++
    if (calls > 1) throw new Error('temporary AI outage')
    return response(analysis(source), options)
  } })
  await assert.rejects(first.prepare(large), /temporary AI outage/)
  assert.equal(first.snapshot(large).status, 'failed')
  assert.equal(first.snapshot(large).completed, 1)
  let resumedCalls = 0
  const restarted = createCoursePlanner({ directory: path, baseUrl: 'http://test-ai', model: 'test-model', fetcher: async (_url, options) => {
    const source = JSON.parse(JSON.parse(options.body).messages[1].content).source
    resumedCalls++
    return response({ summary: 'บันทึกประกอบการฝึก', referenceReason: 'เป็นบันทึกประกอบ ไม่มีตัวอย่างใหม่', units: [] }, options)
  } })
  await restarted.prepare(large)
  assert.equal(resumedCalls, sections.length - 1)
  assert.equal(restarted.snapshot(large).status, 'ready')
  const plan = restarted.snapshot(large).course
  assert.equal(plan.contentStats.analyzedCharacters, large.content.length)
  assert.ok(plan.contentStats.referenceCharacters > 0)
  assert.equal(plan.sourceSections.map(section => section.text).join(''), large.content)
})

test('concurrent preparation shares one generation; reviewed courses skip AI and remain available', async t => {
  const path = await directory(t)
  let calls = 0
  const planner = createCoursePlanner({ directory: path, baseUrl: 'http://test-ai', model: 'test-model', fetcher: async (_url, options) => { calls++; return response(analysis(), options) } })
  await Promise.all([planner.prepare(document), planner.prepare(document)])
  assert.equal(calls, 1)
  const reviewed = createCoursePlanner({ directory: path, reviewedPlan: () => ({ units: [{ id: 'known' }] }), fetcher: () => { throw new Error('Reviewed course should not call AI') } })
  assert.deepEqual(await reviewed.prepare(document), { units: 1, mode: 'reviewed' })
})

test('snapshot corruption never exposes an invalid ready course and can be repaired', async t => {
  const path = await directory(t)
  const planner = createCoursePlanner({ directory: path, baseUrl: 'http://test-ai', model: 'test-model', fetcher: async (_url, options) => response(analysis(), options) })
  await planner.prepare(document)
  const snapshotName = (await readdir(path)).find(name => name.endsWith('.json'))
  const snapshot = JSON.parse(await readFile(join(path, snapshotName), 'utf8'))
  snapshot.analyses[0].units[0].examples[0].target = 'Invented source.'
  const { writeFile } = await import('node:fs/promises')
  await writeFile(join(path, snapshotName), JSON.stringify(snapshot))
  assert.equal(loadPlannedCourse(document, path).status, 'failed')
  await planner.prepare(document)
  assert.equal(loadPlannedCourse(document, path).status, 'ready')
})

test('AI selects source IDs so it cannot supply invented English examples or evidence', () => {
  const section = { text: 'Conversation\nCustomer: Where is the station?\nHello | สวัสดี' }
  const candidates = sourceCandidates(section)
  const sentence = candidates.find(item => item.example && item.text === 'Where is the station?')
  assert.ok(sentence)
  assert.equal(sentence.speaker, 'Customer')
  const paired = candidates.find(item => item.example && item.text === 'Hello')
  const selected = { ...analysis(), units: [{ ...analysis().units[0], objectives: [{ goalThai: 'ถามสถานที่', evidenceId: sentence.id }], examples: [{ sourceId: sentence.id, translation: 'สถานีอยู่ที่ไหน' }, { sourceId: paired.id, translation: 'คำแปลที่ AI เปลี่ยน' }, { sourceId: sentence.id, translation: 'ซ้ำ' }] }] }
  const resolved = resolveSectionSelection(selected, candidates)
  assert.equal(resolved.units[0].examples.length, 2)
  assert.equal(resolved.units[0].examples[0].target, sentence.text)
  assert.equal(resolved.units[0].examples[1].translation, 'สวัสดี')
  validateSectionAnalysis(resolved, section)
  selected.units[0].examples[0].sourceId = 'invented'
  assert.throws(() => resolveSectionSelection(selected, candidates), /ต้นฉบับ/)
})
