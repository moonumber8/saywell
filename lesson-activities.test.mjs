import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildActivities, correctArrangement, practiceModes } from './src/lesson-activities.ts'

const phrases = [
  { target: 'Nice to meet you', translation: 'ยินดีที่ได้รู้จัก', sourceId: 'source:1' },
  { target: 'Are you John', translation: 'คุณชื่อจอห์นไหม', sourceId: 'source:1' },
  { target: 'Yes I am', translation: 'ใช่ ฉันเอง', sourceId: 'source:2' },
]

test('mixed lesson covers all five button activities without requiring a microphone', () => {
  const activities = buildActivities(phrases, 'mixed', () => 0.4)
  assert.deepEqual(activities.map((item) => item.kind), ['choice', 'listen', 'arrange', 'fill', 'match'])
  assert.ok(activities.every((activity) => phrases.includes(activity.phrase)))
  assert.equal(practiceModes.length, 7)
})

test('choice and listening have exactly one correct answer and distinct source-based options', () => {
  for (const mode of ['choice', 'listen']) {
    for (const activity of buildActivities(phrases, mode, () => 0.5)) {
      assert.equal(activity.options.filter((option) => option === activity.answer).length, 1)
      assert.equal(new Set(activity.options).size, activity.options.length)
      assert.ok(activity.options.every((option) => phrases.some((phrase) => phrase.translation === option)))
    }
  }
  const duplicateMeanings = [phrases[0], { ...phrases[1], translation: phrases[0].translation }, phrases[2]]
  assert.equal(buildActivities(duplicateMeanings, 'choice')[0].options.length, 2)
  assert.throws(() => buildActivities(phrases.map((phrase) => ({ ...phrase, translation: 'same' })), 'choice'))
})

test('fill options include missing word and arrangement preserves repeated token identities', () => {
  for (const activity of buildActivities(phrases, 'fill')) {
    assert.equal(activity.answer, activity.phrase.target.split(' ')[activity.blank])
    assert.ok(activity.options.includes(activity.answer))
    assert.ok(activity.options.every((option) => phrases.some((phrase) => phrase.target.split(' ').includes(option))))
  }
  const repeated = [{ ...phrases[0], target: 'very very good' }, ...phrases.slice(1)]
  const activity = buildActivities(repeated, 'arrange', () => 0.999)[0]
  assert.equal(new Set(activity.tokens.map((token) => token.id)).size, 3)
  assert.equal(correctArrangement(activity.phrase.target, activity.tokens.map((token) => token.word)), false)
  assert.equal(correctArrangement('very very good', ['very', 'very', 'good']), true)
  assert.equal(correctArrangement('very very good', ['very', 'good']), false)
  assert.equal(correctArrangement('Are you John', ['Are', 'John', 'you']), false)
  assert.equal(correctArrangement("I'm ready", ['I’m', 'ready']), true)
})

test('matching maps one English phrase to each unique meaning and shuffles complete pair indices', () => {
  const duplicate = [phrases[0], { ...phrases[1], translation: phrases[0].translation }, phrases[2]]
  const activity = buildActivities(duplicate, 'match')[0]
  assert.equal(activity.pairs.length, 2)
  assert.deepEqual([...activity.rightOrder].sort(), [0, 1])
  assert.equal(new Set(activity.pairs.map((pair) => pair.translation)).size, 2)
})
