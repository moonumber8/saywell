import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chunkDocument, cosine, collectGroundedExercises, createRag, validateLesson, validateTopics } from './rag.mjs'

const document = { id: 'test-a1', title: 'Greetings', level: 'A1', content: 'Hello | สวัสดี\nThanks | ขอบคุณ\nGood morning | สวัสดีตอนเช้า' }
const source = chunkDocument(document)[0]
const lesson = { title: 'ทักทาย', exercises: [
  { target: 'Hello', translation: 'สวัสดี', sourceId: source.id },
  { target: 'Thanks', translation: 'ขอบคุณ', sourceId: source.id },
  { target: 'Good morning', translation: 'สวัสดีตอนเช้า', sourceId: source.id },
] }

test('reject invented phrases, mismatched translations, citations and duplicates', () => {
  assert.equal(validateLesson(lesson, [source]), lesson)
  for (const change of [{ target: 'Hello there' }, { translation: 'ขอบคุณ' }, { sourceId: 'missing' }, { target: 'Thanks', translation: 'ขอบคุณ' }]) {
    assert.throws(() => validateLesson({ ...lesson, exercises: lesson.exercises.map((item, index) => index === 0 ? { ...item, ...change } : item) }, [source]))
  }
})

test('vectors and chunk limits reject invalid input', () => {
  assert.equal(cosine([1, 0], [1, 0]), 1)
  assert.equal(cosine([1, 0], [0, 1]), 0)
  assert.throws(() => cosine([1], [1, 2]))
  assert.throws(() => cosine([0], [0]))
  assert.throws(() => chunkDocument({ ...document, content: 'x'.repeat(1201) }))
})

test('topics require three distinct examples grounded in selected sources', () => {
  const topic = { label: 'ทักทาย', examples: lesson.exercises.map(({ target, sourceId }) => ({ target, sourceId })) }
  assert.equal(validateTopics([topic], [source]).length, 1)
  assert.equal(validateTopics([topic, topic], [source]).length, 1)
  for (const change of [{ target: 'Invented phrase' }, { sourceId: 'other-course' }, { target: 'Hello' }]) {
    assert.deepEqual(validateTopics([{ ...topic, examples: topic.examples.map((item, i) => i === 1 ? { ...item, ...change } : item) }], [source]), [])
  }
  assert.deepEqual(validateTopics([null, { ...topic, label: 'x'.repeat(81) }], [source]), [])
})

test('topic recommendations read only chosen course, cache validated output and invalidate changed content', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'saywell-topics-'))
  try {
    const documentsPath = join(directory, 'curriculum.json')
    const unrelated = { ...document, id: 'other', content: 'Not selected | ไม่ได้เลือก' }
    await writeFile(documentsPath, JSON.stringify([document, unrelated]))
    let calls = 0
    const fetcher = async (url, options) => {
      assert.ok(url.endsWith('/api/chat'), 'topic recommendations need no vector indexing')
      calls++
      const request = JSON.parse(JSON.parse(options.body).messages[1].content)
      assert.ok(request.candidates.every((item) => item.sourceId.startsWith(`${document.id}:`)))
      const topics = [{ label: 'ทักทาย', exampleIds: request.candidates.slice(0, 3).map((item) => item.id) }]
      return { ok: true, json: async () => ({ message: { content: JSON.stringify({ topics }) } }) }
    }
    const rag = createRag({ baseUrl: 'http://test', chatModel: 'test', documentsPath, fetcher })
    const input = { documentId: document.id, level: 'A1' }
    await assert.rejects(rag.topics({ ...input, documentId: '' }), /เลือกหลักสูตร/)
    await assert.rejects(rag.topics({ ...input, level: 'B2' }), /เลือกหลักสูตร/)
    const result = await rag.topics(input)
    assert.equal(result.documentId, document.id)
    assert.equal(result.topics.length, 1)
    assert.deepEqual(await rag.topics(input), result)
    assert.equal(calls, 1)
    await writeFile(documentsPath, JSON.stringify([{ ...document, content: `${document.content}\nGoal: greetings` }, unrelated]))
    await rag.topics(input)
    assert.equal(calls, 2)
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await assert.rejects(rag.topics({ ...input, signal: controller.signal }), /cancelled/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('keep valid exercises, repair verified citations and reject duplicates and invented words', () => {
  const raw = { ...source, id: 'raw:0', format: 'raw', content: 'Hello there. Nice to meet you! I’m Mary. Watermelon.' }
  const input = [
    { target: 'Hello there!', translation: 'สวัสดี', sourceId: 'wrong' },
    { target: 'Nice to meet you', translation: 'ยินดีที่ได้รู้จัก', sourceId: raw.id },
    { target: 'Nice to meet you', translation: 'ยินดีที่ได้รู้จัก', sourceId: raw.id },
    { target: 'I am Mary', translation: 'ฉันชื่อแมรี่', sourceId: raw.id },
    { target: 'Water', translation: 'น้ำ', sourceId: raw.id },
    { target: 'I’m Mary.', translation: 'ฉันชื่อแมรี่', sourceId: raw.id },
    null,
    { target: 'Hello there', translation: 'Hello there', sourceId: raw.id },
  ]
  const result = collectGroundedExercises(input, [raw])
  assert.deepEqual(result.map((item) => item.target), ['Hello there', 'Nice to meet you', "I'm Mary"])
  assert.ok(result.every((item) => item.sourceId === raw.id))
  assert.equal(validateLesson({ title: 'ทักทาย', exercises: result }, [raw]).exercises.length, 3)
  assert.deepEqual(collectGroundedExercises([{ ...lesson.exercises[0], translation: 'ขอบคุณ' }], [source]), [])
  assert.equal(collectGroundedExercises(lesson.exercises, [{ ...source, content: source.content.replaceAll(' | ', '|') }]).length, 3)
})

test('retry once when valid exercises are insufficient, retain verified items and fail clearly if still insufficient', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'saywell-rag-'))
  try {
    const documentsPath = join(directory, 'curriculum.json')
    await writeFile(documentsPath, JSON.stringify([document]))
    let chatCalls = 0
    let alwaysInvalid = false
    const fetcher = async (url, options) => {
      const result = (value) => ({ ok: true, json: async () => ({ result: value }) })
      if (url.endsWith('/points/count')) return result({ count: 1 })
      if (url.endsWith('/points/query')) return result({ points: [{ payload: source, score: 1 }] })
      if (url.includes('/collections/')) return result({ config: { params: { vectors: { size: 2 } } } })
      if (url.endsWith('/api/embed')) return { ok: true, json: async () => ({ embeddings: [[1, 0]] }) }
      chatCalls++
      if (chatCalls % 2 === 0) assert.equal(JSON.parse(options.body).messages.length, 3)
      const generated = alwaysInvalid ? { title: 'ลองใหม่', exercises: [{ target: 'Invented', translation: 'แต่งขึ้น', sourceId: source.id }] } : { ...lesson, exercises: chatCalls % 2 === 1 ? [lesson.exercises[0], { ...lesson.exercises[1], target: 'Invented' }] : lesson.exercises.slice(1) }
      return { ok: true, json: async () => ({ message: { content: JSON.stringify(generated) } }) }
    }
    const rag = createRag({ baseUrl: 'http://test', embeddingModel: 'test', documentsPath, fetcher })
    const progress = []
    const generated = await rag.lesson({ query: 'greetings', level: 'A1', onProgress: (message) => progress.push(message) })
    assert.equal(chatCalls, 2)
    assert.deepEqual(generated.exercises, lesson.exercises)
    assert.ok(progress.some((message) => message.includes('อัตโนมัติ')))
    alwaysInvalid = true
    await assert.rejects(rag.lesson({ query: 'greetings', level: 'A1' }), /ไม่ครบ 3 ข้อ/)
    assert.equal(chatCalls, 4, 'retry is bounded to one additional chat call')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('raw curriculum accepts punctuation and curly apostrophes but rejects invented text', () => {
  const raw = { ...source, format: 'raw', content: 'Hi, I’m Mary. Nice to meet you! Are you John?' }
  const generated = { title: 'ทักทาย', exercises: [
    { target: 'Hi, I’m Mary.', translation: 'สวัสดี ฉันชื่อแมรี่', sourceId: raw.id },
    { target: 'Nice to meet you!', translation: 'ยินดีที่ได้รู้จัก', sourceId: raw.id },
    { target: 'Are you John?', translation: 'คุณชื่อจอห์นไหม', sourceId: raw.id },
  ] }
  assert.equal(validateLesson(generated, [raw]).exercises[0].target, "Hi I'm Mary")
  generated.exercises[0].target = 'Invented greeting'
  assert.throws(() => validateLesson(generated, [raw]))
})

test('Qdrant retrieval filters levels, persists vectors, reuses index and versions after import', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'saywell-rag-'))
  try {
    const documentsPath = join(directory, 'curriculum.json')
    await writeFile(documentsPath, JSON.stringify([document, { ...document, id: 'test-b2', level: 'B2' }]))
    let documentEmbeds = 0
    let failAt = -1
    const collections = new Map()
    const result = (value) => ({ ok: true, json: async () => ({ result: value }) })
    const fetcher = async (url, options) => {
      const body = options.body ? JSON.parse(options.body) : undefined
      if (url.startsWith('http://qdrant')) {
        const name = new URL(url).pathname.split('/')[2]
        if (options.method === 'GET') {
          return collections.has(name) ? result({ config: { params: { vectors: collections.get(name).vectors } } }) : { ok: false, status: 404 }
        }
        if (url.endsWith('/points/count')) return result({ count: collections.get(name).points.size })
        if (url.endsWith('/points')) return result(body.ids.filter((id) => collections.get(name).points.has(id)).map((id) => ({ id })))
        if (url.endsWith('/points/query')) {
          assert.equal(body.with_vector, false)
          const points = [...collections.get(name).points.values()].filter((point) => body.filter.must.every((condition) => point.payload[condition.key] === condition.match.value))
          return result({ points: points.slice(0, body.limit).map((point) => ({ payload: point.payload, score: 0.9 })) })
        }
        if (url.endsWith('/points?wait=true')) {
          for (const point of body.points) {
            assert.match(point.id, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/)
            collections.get(name).points.set(point.id, point)
          }
          return result({ status: 'completed' })
        }
        if (url.endsWith('/index?wait=true')) return result({ status: 'completed' })
        if (body.vectors) { collections.set(name, { vectors: body.vectors, points: new Map() }); return result(true) }
        throw new Error(`Unexpected request ${url}`)
      }
      if (url.endsWith('/api/embed')) {
        if (!body.input[0].startsWith('Instruct:')) {
          documentEmbeds++
          if (documentEmbeds === failAt) throw new Error('temporary embedding failure')
        }
        return { ok: true, json: async () => ({ embeddings: body.input.map(() => [1, 0]) }) }
      }
      const request = JSON.parse(body.messages[1].content)
      assert.ok(request.sources.every((item) => item.level === 'A1'))
      return { ok: true, json: async () => ({ message: { content: JSON.stringify(lesson) } }) }
    }
    const config = { baseUrl: 'http://test', qdrantUrl: 'http://qdrant', embeddingModel: 'test-embedding', chatModel: 'test-chat', documentsPath, fetcher }
    const rag = createRag(config)
    const stages = []
    await rag.lesson({ query: 'greetings', level: 'A1', onProgress: (message) => stages.push(message) })
    assert.ok(stages.some((message) => message.includes('ดัชนี')))
    assert.ok(stages.some((message) => message.includes('ค้นเนื้อหา')))
    assert.ok(stages.some((message) => message.includes('คำแปลไทย')))
    assert.ok(stages.at(-1).includes('ตรวจคำตอบ'))
    const cancelled = new AbortController()
    cancelled.abort(new Error('cancelled'))
    await assert.rejects(rag.lesson({ query: 'hello', level: 'A1', signal: cancelled.signal }), /cancelled/)
    await rag.lesson({ query: 'hello', level: 'A1' })
    assert.equal(documentEmbeds, 1)
    assert.equal(collections.size, 1)
    assert.equal([...collections.values()][0].points.size, 2)
    await createRag(config).lesson({ query: 'hello', level: 'A1', documentId: 'test-a1' })
    assert.equal(documentEmbeds, 1)
    await rag.addDocument({ title: 'More', level: 'A1', content: document.content })
    await rag.index()
    assert.equal(documentEmbeds, 2)
    assert.equal(collections.size, 2)
    await assert.rejects(() => rag.lesson({ query: 'travel', level: 'A2' }), /ยังไม่มีเนื้อหา/)
    await rag.addDocuments(Array.from({ length: 10 }, (_, index) => ({ ...document, id: `bulk-${index}` })))
    failAt = documentEmbeds + 2
    await assert.rejects(() => rag.index(), /temporary embedding failure/)
    const afterFailure = documentEmbeds
    const progress = []
    await rag.index((completed, total) => { progress.push([completed, total]) })
    assert.equal(documentEmbeds, afterFailure + 1, 'completed first batch must be reused')
    assert.deepEqual(progress.at(-1), [13, 13])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('cancelling a lesson interrupts embedding and prevents queued chat generation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'saywell-rag-'))
  try {
    const documentsPath = join(directory, 'curriculum.json')
    await writeFile(documentsPath, JSON.stringify([document]))
    const controller = new AbortController()
    let chatCalls = 0
    const fetcher = async (url, options) => {
      if (url.endsWith('/points/count')) return { ok: true, json: async () => ({ result: { count: 1 } }) }
      if (url.includes('/collections/')) return { ok: true, json: async () => ({ result: { config: { params: { vectors: { size: 2 } } } } }) }
      if (url.endsWith('/api/embed')) {
        return new Promise((_, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
          controller.abort(new Error('lesson timeout'))
        })
      }
      chatCalls++
      throw new Error('chat should not run')
    }
    const rag = createRag({ baseUrl: 'http://test', embeddingModel: 'test', documentsPath, fetcher })
    await assert.rejects(rag.lesson({ query: 'hello', level: 'A1', signal: controller.signal }), /lesson timeout/)
    assert.equal(chatCalls, 0)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('Qdrant connection failures are reported without falling back to file vectors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'saywell-rag-'))
  try {
    const documentsPath = join(directory, 'curriculum.json')
    await writeFile(documentsPath, JSON.stringify([document]))
    const rag = createRag({ baseUrl: 'http://test', embeddingModel: 'test', documentsPath, fetcher: async () => { throw new Error('offline') } })
    await assert.rejects(() => rag.index(), /Qdrant/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
