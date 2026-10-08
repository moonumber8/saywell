import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPublishApp, learnerRoute } from './publish-server.mjs'

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${server.address().port}`
}

async function fixture(t, handler) {
  const directory = await mkdtemp(join(tmpdir(), 'saywell-publish-'))
  await writeFile(join(directory, 'index.html'), '<main>Saywell learner</main>')
  await writeFile(join(directory, 'app.js'), 'console.log("learner")')
  await writeFile(join(directory, '.env'), 'SECRET=private')
  const upstream = createServer(handler)
  const origin = await listen(upstream)
  const gateway = createServer(createPublishApp({ origin, directory }))
  const url = await listen(gateway)
  t.after(async () => {
    for (const server of [gateway, upstream]) {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    }
    await rm(directory, { recursive: true, force: true })
  })
  return { url, upstream }
}

test('public route allowlist permits learning and rejects management and aliases', () => {
  for (const [method, path] of [
    ['GET', '/api/curriculum'], ['HEAD', '/api/curriculum'],
    ['GET', '/api/curriculum/documents/lesson-4'],
    ['GET', '/api/curriculum/structured/lesson-52'],
    ['POST', '/api/curriculum/structured/lesson-52/check'],
    ['POST', '/api/curriculum/topics'], ['POST', '/api/curriculum/lesson'],
    ['POST', '/api/speaking/advice'],
    ['POST', '/api/speaking/transcribe'],
    ['POST', '/api/speaking/audio'],
  ]) assert.equal(learnerRoute(method, path), true, `${method} ${path}`)
  for (const [method, path] of [
    ['POST', '/api/curriculum'], ['POST', '/api/curriculum/upload'],
    ['POST', '/api/curriculum/import'], ['GET', '/api/curriculum/import/job'],
    ['POST', '/api/curriculum/documents/lesson-4/prepare'],
    ['POST', '/api/curriculum/index'], ['POST', '/api/ollama/chat'],
    ['DELETE', '/api/curriculum/documents/lesson-4'],
    ['GET', '/api/curriculum/'], ['GET', '/api/curriculum%2fupload'],
    ['GET', '/api/curriculum/documents/..%2f.env'],
  ]) assert.equal(learnerRoute(method, path), false, `${method} ${path}`)
})

test('public gateway relays example WAV bytes with the correct audio type', async t => {
  const audio = Buffer.from('RIFF-example-WAVE')
  const { url } = await fixture(t, (req, res) => {
    assert.equal(req.url, '/api/speaking/audio')
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => { assert.deepEqual(JSON.parse(body), { text: 'Hello', speed: 'slow' }); res.writeHead(200, { 'Content-Type': 'audio/wav' }); res.end(audio) })
  })
  const response = await fetch(url + '/api/speaking/audio', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Hello', speed: 'slow' }) })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /audio\/wav/)
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), audio)
})

test('public gateway preserves microphone PCM bytes and no-store transcription response', async t => {
  const audio = Buffer.alloc(32000, 124)
  const { url } = await fixture(t, async (req, res) => {
    assert.equal(req.url, '/api/speaking/transcribe')
    assert.equal(req.headers['content-type'], 'application/octet-stream')
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    assert.deepEqual(Buffer.concat(chunks), audio)
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify({ transcript: 'Nice to meet you.' }))
  })
  const response = await fetch(`${url}/api/speaking/transcribe`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: audio })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await response.json(), { transcript: 'Nice to meet you.' })
})

test('public catalog removes management capability; blocked requests never reach the API', async t => {
  const requests = []
  const { url } = await fixture(t, (req, res) => {
    requests.push(req.url)
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ documents: [{ id: 'lesson-4' }], canManage: true, activeImport: { id: 'owner-only-job' } }))
  })
  const response = await fetch(`${url}/api/curriculum`)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await response.json(), { documents: [{ id: 'lesson-4' }], canManage: false })
  for (const path of ['/api/curriculum/import', '/api/curriculum/upload', '/api/ollama/chat']) {
    assert.equal((await fetch(url + path, { method: 'POST', body: '{}' })).status, 403)
  }
  assert.deepEqual(requests, ['/api/curriculum'])
})

test('gateway preserves grading body, status and content type', async t => {
  const payload = { revision: 'revision-1', unitId: 'vocabulary', answers: { q1: 'a' }, reflection: 'ฝึกแล้ว' }
  const { url } = await fixture(t, async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    assert.equal(req.url, '/api/curriculum/structured/lesson-4/check')
    assert.equal(req.headers['content-type'], 'application/json')
    assert.deepEqual(JSON.parse(body), payload)
    res.writeHead(409, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'stale revision' }))
  })
  const response = await fetch(`${url}/api/curriculum/structured/lesson-4/check`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  })
  assert.equal(response.status, 409)
  assert.match(response.headers.get('content-type'), /application\/json/)
  assert.deepEqual(await response.json(), { error: 'stale revision' })
})

test('AI progress is delivered before generation completes', async t => {
  let complete
  const { url } = await fixture(t, (req, res) => {
    req.resume()
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
    res.write('{"type":"progress","stage":"generating"}\n')
    complete = () => res.end('{"type":"result","lesson":{"id":"ready"}}\n')
  })
  const response = await fetch(`${url}/api/curriculum/lesson`, {
    method: 'POST', headers: { accept: 'application/x-ndjson', 'Content-Type': 'application/json' }, body: '{}',
    signal: AbortSignal.timeout(5000),
  })
  const reader = response.body.getReader()
  const first = await reader.read()
  assert.equal(first.done, false)
  assert.equal(new TextDecoder().decode(first.value), '{"type":"progress","stage":"generating"}\n')
  complete()
  let remainder = ''
  for (;;) {
    const part = await reader.read()
    if (part.done) break
    remainder += new TextDecoder().decode(part.value)
  }
  assert.equal(remainder, '{"type":"result","lesson":{"id":"ready"}}\n')
})

test('canceling a learner stream disconnects the upstream generation', async t => {
  let disconnected
  const closed = new Promise(resolve => { disconnected = resolve })
  const { url } = await fixture(t, (req, res) => {
    req.resume()
    res.on('close', disconnected)
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
    res.write('{"type":"progress"}\n')
  })
  const controller = new AbortController()
  const response = await fetch(`${url}/api/curriculum/lesson`, { method: 'POST', body: '{}', signal: controller.signal })
  await response.body.getReader().read()
  controller.abort()
  await Promise.race([closed, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('Upstream did not disconnect')), 3000)
    timer.unref()
  })])
})

test('serves the production app without exposing dotfiles and handles offline API', async t => {
  const { url, upstream } = await fixture(t, (_req, res) => res.end('{}'))
  for (const path of ['/', '/learn']) {
    const response = await fetch(url + path)
    assert.equal(response.status, 200)
    assert.match(await response.text(), /Saywell learner/)
    assert.equal(response.headers.get('permissions-policy'), 'microphone=(self)')
  }
  assert.equal((await fetch(`${url}/app.js`)).status, 200)
  for (const path of ['/.env', '/server.mjs', '/missing.js']) assert.equal((await fetch(url + path)).status, 404)
  upstream.closeAllConnections()
  await new Promise(resolve => upstream.close(resolve))
  for (const [path, method] of [['/api/curriculum', 'GET'], ['/api/curriculum/lesson', 'POST']]) {
    const response = await fetch(url + path, { method })
    assert.equal(response.status, 502)
    assert.equal(typeof (await response.json()).error, 'string')
  }
})
