import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSpeechCoach, validateSpeechInput } from './speech-coach.mjs'

const input = { target: 'Nice to meet you', translation: 'ยินดีที่ได้รู้จัก', transcript: 'Nice meet you' }
const response = (advice) => ({ ok: true, json: async () => ({ message: { content: JSON.stringify(advice) } }) })

test('speaking advice uses transcript data, preserves original practice words and requests no pronunciation score', async () => {
  const coach = createSpeechCoach({ baseUrl: 'http://test', model: 'test', fetcher: async (url, options) => {
    assert.equal(url, 'http://test/api/chat')
    const body = JSON.parse(options.body)
    assert.deepEqual(JSON.parse(body.messages[1].content.slice(body.messages[1].content.indexOf('{'))), input)
    assert.match(body.messages[1].content, /เป็นภาษาไทย 2 ประโยค/)
    assert.match(body.messages[0].content, /NOT heard audio/)
    assert.match(body.messages[0].content, /never give a pronunciation score/)
    return response({ tip: 'ระบบยังไม่ได้ยินคำว่า to ลองฝึกช่วง to meet ช้า ๆ ค่ะ', practice: 'to meet' })
  } })
  assert.deepEqual(await coach(input), { tip: 'ระบบยังไม่ได้ยินคำว่า to ลองฝึกช่วง to meet ช้า ๆ ค่ะ', practice: 'to meet' })
})

test('unsupported or partial-word practice phrases fall back to the original target', async () => {
  for (const practice of ['Invented phrase', 'Nice to meat you', 'mee', '', '!!!']) {
    const coach = createSpeechCoach({ baseUrl: 'http://test', model: 'test', fetcher: async () => response({ tip: 'ลองพูดตามโจทย์ช้า ๆ ค่ะ', practice }) })
    assert.equal((await coach(input)).practice, input.target)
  }
})

test('bad inputs and cancelled requests do not call AI', async () => {
  let calls = 0
  const coach = createSpeechCoach({ baseUrl: 'http://test', model: 'test', fetcher: async () => { calls++; return response({}) } })
  for (const value of [null, { ...input, target: '' }, { ...input, transcript: '' }, { ...input, transcript: 'a'.repeat(501) }, { ...input, translation: undefined }]) {
    assert.throws(() => validateSpeechInput(value))
    await assert.rejects(coach(value))
  }
  const controller = new AbortController()
  controller.abort(new Error('cancelled'))
  await assert.rejects(coach(input, controller.signal), /cancelled/)
  assert.equal(calls, 0)
})

test('invalid AI responses are surfaced without affecting answer validation', async () => {
  for (const advice of [{}, { tip: 'English only', practice: 'meet' }, null]) {
    const coach = createSpeechCoach({ baseUrl: 'http://test', model: 'test', fetcher: async () => response(advice) })
    await assert.rejects(coach(input), /AI ส่งคำแนะนำไม่ครบ/)
  }
  const coach = createSpeechCoach({ baseUrl: 'http://test', model: 'test', fetcher: async () => ({ ok: false, json: async () => ({ error: 'model offline' }) }) })
  await assert.rejects(coach(input), /model offline/)
})
