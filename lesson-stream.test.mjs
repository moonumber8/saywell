import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readLessonStream } from './src/lesson-stream.ts'

function response(text, truncate = false) {
  const bytes = new TextEncoder().encode(text)
  return new Response(new ReadableStream({ start(controller) {
    // Split inside UTF-8 characters as well as JSON records.
    for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7))
    controller.close()
  } }), { headers: { 'content-type': truncate ? 'application/json' : 'application/x-ndjson' } })
}

test('lesson stream decodes fragmented Thai progress and final lesson', async () => {
  const stages = []
  const lesson = { title: 'ทักทาย', exercises: [] }
  const result = await readLessonStream(response(`${JSON.stringify({ type: 'progress', message: 'กำลังค้นเนื้อหา…' })}\n${JSON.stringify({ type: 'lesson', lesson })}\n`), (message) => stages.push(message))
  assert.deepEqual(result, lesson)
  assert.deepEqual(stages, ['กำลังค้นเนื้อหา…'])
})

test('lesson stream reports upstream errors and premature disconnects', async () => {
  await assert.rejects(readLessonStream(response('{"type":"error","error":"หมดเวลารอ"}\n'), () => {}), /หมดเวลารอ/)
  await assert.rejects(readLessonStream(response('{"type":"progress","message":"รอ"}\n'), () => {}), /การเชื่อมต่อขาด/)
  assert.deepEqual(await readLessonStream(response('{"title":"legacy"}', true), () => {}), { title: 'legacy' })
})
