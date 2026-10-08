import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import test from 'node:test'
import { backupMachine, restoreMachine } from './machine-transfer.mjs'

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'saywell-move-test-'))
  const collections = new Set(['saywell_curriculum_abc', 'unrelated'])
  const uploads = []
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname
    response.setHeader('Content-Type', 'application/json')
    if (pathname === '/collections') response.end(JSON.stringify({ result: { collections: [...collections].map((name) => ({ name })) } }))
    else if (request.method === 'POST' && pathname === '/collections/saywell_curriculum_abc/snapshots') response.end(JSON.stringify({ result: { name: 'test.snapshot' } }))
    else if (pathname === '/collections/saywell_curriculum_abc/snapshots/test.snapshot') {
      response.setHeader('Content-Type', 'application/octet-stream')
      response.end('qdrant-snapshot-content')
    } else if (request.method === 'POST' && pathname === '/collections/saywell_curriculum_abc/snapshots/upload') {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      uploads.push(Buffer.concat(chunks).toString())
      collections.add('saywell_curriculum_abc')
      response.end(JSON.stringify({ result: true }))
    } else { response.statusCode = 404; response.end('{}') }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const config = { qdrantUrl: `http://127.0.0.1:${server.address().port}`, collectionPrefix: 'saywell_curriculum', embeddingModel: 'qwen3-embedding:4b' }
  try { await run({ root, config, collections, uploads }) }
  finally { server.close(); await once(server, 'close'); await rm(root, { recursive: true, force: true }) }
}

test('moves local course data and Qdrant collection snapshot, excluding unrelated collections', async () => {
  await fixture(async ({ root, config, collections, uploads }) => {
    const original = join(root, 'original')
    const destination = join(root, 'destination')
    const backup = join(root, 'backups', 'move-1')
    await mkdir(join(original, 'data', 'course-plans'), { recursive: true })
    await writeFile(join(original, 'data', 'curriculum.json'), '[{"title":"Course"}]')
    await writeFile(join(original, 'data', 'course-plans', 'one.json'), '{"ready":true}')
    await writeFile(join(original, '.env'), 'QWEN_API_KEY=private')
    const saved = await backupMachine({ ...config, projectDir: original, outDir: backup })
    assert.equal(saved.files, 2)
    assert.equal(saved.collections, 1)
    const manifest = JSON.parse(await readFile(join(backup, 'manifest.json'), 'utf8'))
    assert.deepEqual(manifest.collections, ['saywell_curriculum_abc'])
    assert.equal(manifest.files.some((file) => file.path.includes('.env')), false)
    collections.delete('saywell_curriculum_abc')
    const restored = await restoreMachine({ ...config, projectDir: destination, fromDir: backup })
    assert.equal(restored.files, 2)
    assert.equal(restored.collections, 1)
    assert.equal(await readFile(join(destination, 'data', 'curriculum.json'), 'utf8'), '[{"title":"Course"}]')
    assert.equal(await readFile(join(destination, 'data', 'course-plans', 'one.json'), 'utf8'), '{"ready":true}')
    assert.equal(uploads.length, 1)
    assert.match(uploads[0], /qdrant-snapshot-content/)
  })
})

test('detects tampering and refuses to overwrite existing data', async () => {
  await fixture(async ({ root, config, collections }) => {
    const original = join(root, 'original')
    const destination = join(root, 'destination')
    const backup = join(root, 'backup')
    await mkdir(join(original, 'data'), { recursive: true })
    await writeFile(join(original, 'data', 'curriculum.json'), 'original')
    await backupMachine({ ...config, projectDir: original, outDir: backup })
    collections.delete('saywell_curriculum_abc')
    await writeFile(join(backup, 'data', 'curriculum.json'), 'tampered')
    await assert.rejects(restoreMachine({ ...config, projectDir: destination, fromDir: backup }), /checksum mismatch/)
    await writeFile(join(backup, 'data', 'curriculum.json'), 'original')
    await mkdir(join(destination, 'data'), { recursive: true })
    await writeFile(join(destination, 'data', 'curriculum.json'), 'keep me')
    await assert.rejects(restoreMachine({ ...config, projectDir: destination, fromDir: backup }), /not empty/)
    assert.equal(await readFile(join(destination, 'data', 'curriculum.json'), 'utf8'), 'keep me')
  })
})
