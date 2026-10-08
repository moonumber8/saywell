import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { buildStructuredCourse, structuredMetadata, gradeUnit } from './structured-course.mjs'
import { parseCourseSource, normalizeSource, readableSource } from './course-source.mjs'

const documents = JSON.parse(await readFile('data/curriculum.json', 'utf8'))
const chapters = documents.filter((document) => /Lesson \d+$/.test(document.title))
const plans = chapters.map(buildStructuredCourse)

test('all 52 imported chapters have individual source-backed courses and the introduction stays a guide', () => {
  assert.equal(plans.length, 52)
  assert.deepEqual(plans.map((plan) => plan.lessonNumber), Array.from({ length: 52 }, (_, i) => i + 1))
  assert.equal(buildStructuredCourse(documents.find((document) => document.title.endsWith('Introduction'))), null)
  assert.equal(buildStructuredCourse({ title: 'My own course', content: 'Example', level: 'A1' }), null)
  assert.equal(new Set(plans.map((plan) => plan.title)).size, 52)
  for (const [index, plan] of plans.entries()) {
    const metadata = structuredMetadata(chapters[index])
    assert.equal(metadata.structured, true)
    assert.equal(metadata.structuredUnits, plan.units.length)
    assert.equal(metadata.structuredRevision, plan.revision)
    assert.ok(plan.units.find((unit) => unit.kind === 'writing').originalTasks)
    assert.ok(plan.units.find((unit) => unit.kind === 'listening').originalTasks)
  }
})

test('every character of every chapter and every stated goal maps to actual study units', () => {
  for (const [index, plan] of plans.entries()) {
    const document = chapters[index]
    assert.equal(plan.sourceSections.map((section) => section.text).join(''), document.content, `Lesson ${plan.lessonNumber} preserves the whole source`)
    assert.equal(plan.contentStats.sourceCharacters, plan.contentStats.mappedCharacters)
    assert.equal(plan.sourceSections[0].start, 0)
    assert.equal(plan.sourceSections.at(-1).end, document.content.length)
    for (const section of plan.sourceSections) {
      assert.ok(section.unitIds.length)
      assert.ok(section.unitIds.every((id) => plan.units.some((unit) => unit.id === id && unit.sourceSectionIds.includes(section.id))))
    }
    for (const goal of plan.goalCoverage) {
      assert.ok(goal.unitIds.length, `Lesson ${plan.lessonNumber}: ${goal.text}`)
      assert.ok(goal.unitIds.every((id) => plan.units.some((unit) => unit.id === id)))
    }
    assert.ok(plan.goalCoverage.some((goal) => goal.category.includes('Grammar')))
    assert.ok(plan.goalCoverage.some((goal) => goal.category.includes('Speaking')))
    assert.ok(plan.goalCoverage.some((goal) => goal.category.includes('Pronunciation')))
  }
})

test('every key word sense and conversation turn is taught with a prepared Thai meaning', () => {
  for (const [index, plan] of plans.entries()) {
    const source = parseCourseSource(chapters[index])
    const vocabulary = plan.units.filter((unit) => unit.kind === 'vocabulary').flatMap((unit) => unit.examples)
    const dialogue = plan.units.filter((unit) => unit.kind === 'conversation').flatMap((unit) => unit.examples)
    assert.deepEqual(vocabulary.map((entry) => entry.target), source.vocabulary.map((entry) => entry.target))
    assert.deepEqual(dialogue.map((entry) => entry.target), source.turns.map((entry) => entry.target))
    assert.equal(plan.translations.vocabulary, vocabulary.length)
    assert.equal(plan.translations.dialogue, dialogue.length)
    assert.ok([...vocabulary, ...dialogue].every((entry) => /[ก-๙]/u.test(entry.translation)))
    assert.ok(dialogue.every((entry) => normalizeSource(readableSource(chapters[index].content)).includes(normalizeSource(entry.target))))
    assert.equal(plan.units.filter((unit) => unit.kind === 'vocabulary').reduce((count, unit) => count + unit.assessment.length, 0), vocabulary.length)
    assert.equal(plan.units.filter((unit) => unit.kind === 'conversation').reduce((count, unit) => count + unit.assessment.length, 0), dialogue.length)
  }
  const source = parseCourseSource(chapters.find((document) => document.title.endsWith('Lesson 19')))
  assert.ok(source.vocabulary.some((word) => word.target === 'mean'), 'handles printed v.. typo')
  assert.equal(plans[3].contentStats.vocabulary, 11, 'Lesson 4 retains all eleven Key Words')
  assert.ok(plans[16].units.some((unit) => unit.examples.some((entry) => entry.target === 'will')), 'modal/trademark entries remain included')
})

test('calendar, alphabet, numbers, ordinal cards and money activities are covered', () => {
  assert.equal(plans[0].units.find((unit) => unit.id === 'alphabet-numbers').examples.length, 46)
  assert.equal(plans[17].units.find((unit) => unit.id === 'ordinal-cards').examples.length, 10)
  assert.equal(plans[18].units.find((unit) => unit.id === 'calendar').examples.length, 16)
  assert.equal(plans[21].units.find((unit) => unit.id === 'calendar').examples.length, 4)
  assert.equal(plans[22].units.find((unit) => unit.id === 'time-money').assessment.length, 3)
})

test('all checkpoints grade on the server, retain explanations and enforce 80% without rounding up', () => {
  for (const plan of plans) for (const unit of plan.units) {
    const answers = Object.fromEntries(unit.assessment.map((question) => [question.id, question.answer]))
    const result = gradeUnit(plan, unit.id, answers, 'My practice note for this chapter.')
    assert.equal(result.score, 100)
    assert.equal(result.passed, true)
    assert.deepEqual(result.review, [])
    const missing = gradeUnit(plan, unit.id, {}, 'My practice note for this chapter.')
    assert.equal(missing.passed, false)
    assert.equal(missing.score, 0)
    assert.equal(missing.review.length, unit.assessment.length)
    assert.equal(gradeUnit(plan, unit.id, { passed: true, score: 100 }, 'My practice note for this chapter.').passed, false)
    assert.ok(unit.assessment.every((question) => new Set(question.options).size === question.options.length && question.options.includes(question.answer) && question.explanation))
  }
  const plan = plans[3]
  const unit = plan.units[0]
  const five = Object.fromEntries(unit.assessment.slice(0, 5).map((question) => [question.id, question.answer]))
  const four = Object.fromEntries(unit.assessment.slice(0, 4).map((question) => [question.id, question.answer]))
  assert.equal(gradeUnit(plan, unit.id, five).passed, true)
  assert.equal(gradeUnit(plan, unit.id, four).passed, false)
  assert.throws(() => gradeUnit(plan, 'unknown', {}))
  assert.throws(() => gradeUnit(plan, unit.id, []))
  const large = { ...plan, units: [{ ...unit, assessment: Array.from({ length: 500 }, (_, index) => ({ ...unit.assessment[0], id: `${index}` })) }] }
  const borderline = Object.fromEntries(large.units[0].assessment.slice(0, 399).map((question) => [question.id, question.answer]))
  assert.equal(gradeUnit(large, unit.id, borderline).score, 80)
  assert.equal(gradeUnit(large, unit.id, borderline).passed, false)
})

test('free work must be recorded but is never misrepresented as graded writing or pronunciation', () => {
  for (const plan of plans) {
    const pronunciation = plan.units.find((unit) => unit.kind === 'pronunciation')
    const writing = plan.units.find((unit) => unit.kind === 'writing')
    assert.equal(pronunciation.audioAssessment, 'not-assessed')
    assert.equal(writing.writingAssessment, 'guided-only')
    const answers = Object.fromEntries(writing.assessment.map((question) => [question.id, question.answer]))
    assert.throws(() => gradeUnit(plan, writing.id, answers, ''), /บันทึก/)
    const result = gradeUnit(plan, writing.id, answers, 'I am practicing my writing.')
    assert.equal(result.reflectionStatus, 'recorded-not-assessed')
    assert.equal('writingScore' in result, false)
    assert.equal('pronunciationScore' in result, false)
  }
})

test('source changes invalidate progress, and missing or mismatched source structure is rejected', () => {
  const document = chapters[3]
  assert.equal(buildStructuredCourse(document).revision, plans[3].revision)
  assert.notEqual(buildStructuredCourse({ ...document, content: `${document.content}\nSource revision` }).revision, plans[3].revision)
  assert.throws(() => buildStructuredCourse({ ...document, content: '' }), /ต้นฉบับ/)
  assert.throws(() => buildStructuredCourse({ ...document, title: 'VOA-Lets-Learn-English — Lesson 52' }), /ไม่ตรง/)
  assert.throws(() => buildStructuredCourse({ ...document, content: document.content.replace(/^Key Words$/m, 'Removed vocabulary') }), /ไม่ครบ/)
  assert.throws(() => buildStructuredCourse({ ...document, content: document.content.replace(/^Goals$/m, 'Removed goals') }), /ไม่ครบ/)
  assert.throws(() => buildStructuredCourse({ ...document, content: document.content.replace('Grammar: BE + Noun', 'Grammar: New unreviewed topic') }), /เป้าหมาย/)
})
