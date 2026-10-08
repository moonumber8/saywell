import test from 'node:test'
import assert from 'node:assert/strict'
import { matchSpeech, speechPassThreshold } from './src/speech-match.ts'

test('speaking accepts at least 85% word agreement without calling it an accent score', () => {
  assert.equal(speechPassThreshold, 85)
  const target = 'I would like to book a table for two tonight'
  const close = matchSpeech(target, 'I would like to book table for two tonight')
  assert.equal(close.score, 90)
  assert.equal(close.passed, true)
  assert.equal(close.matched.filter(Boolean).length, 9)

  const unclear = matchSpeech(target, 'I like to cook a table tonight')
  assert.ok(unclear.score < speechPassThreshold)
  assert.equal(unclear.passed, false)
})

test('short phrases still require understandable words and correct order', () => {
  assert.deepEqual(matchSpeech('Nice to meet you', 'Nice to meet you!').passed, true)
  assert.equal(matchSpeech('Nice to meet you', 'Nice meet you').passed, false)
  assert.equal(matchSpeech('Nice to meet you', 'Nice to meet you today').passed, false)
  assert.equal(matchSpeech('Nice to meet you', '').passed, false)
  assert.equal(matchSpeech('go go home', 'go home go').passed, false)
})
