import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { openAsBlob } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'

const collectionName = /^[A-Za-z0-9_-]{1,255}$/
const hashName = /^[a-f0-9]{64}$/

function within(parent, child) {
  const path = relative(parent, child)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

function safePath(root, name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('Invalid backup file path')
  const path = resolve(root, ...name.split('/'))
  if (!within(root, path)) throw new Error('Backup file escapes its directory')
  return path
}

async function rejectSymlinkParents(root, name) {
  let current = root
  for (const part of name.split('/')) {
    current = join(current, part)
    if ((await lstat(current)).isSymbolicLink()) throw new Error(`Symbolic link in backup: ${name}`)
  }
}

async function filesIn(root, current = root) {
  const result = []
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not supported in data/: ${path}`)
    if (entry.isDirectory()) result.push(...await filesIn(root, path))
    else if (entry.isFile()) result.push(relative(root, path).split(sep).join('/'))
    else throw new Error(`Unsupported data entry: ${path}`)
  }
  return result.sort()
}

async function digest(path) {
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of createReadStream(path)) { hash.update(chunk); size += chunk.length }
  return { sha256: hash.digest('hex'), size }
}

async function qdrantRequest(url, apiKey, path, options = {}) {
  let response
  try {
    response = await fetch(`${url.replace(/\/+$/, '')}${path}`, {
      ...options,
      headers: { ...(apiKey ? { 'api-key': apiKey } : {}), ...options.headers },
      signal: AbortSignal.timeout(600000),
    })
  } catch (error) { throw new Error(`Cannot reach Qdrant: ${error.message}`) }
  if (!response.ok) throw new Error(`Qdrant ${response.status}: ${(await response.text()).slice(0, 300)}`)
  return response
}

async function listCollections(url, apiKey) {
  const response = await qdrantRequest(url, apiKey, '/collections')
  const body = await response.json()
  if (!Array.isArray(body.result?.collections)) throw new Error('Invalid Qdrant collection list')
  return body.result.collections.map((item) => item.name)
}

export async function backupMachine({ projectDir, outDir, qdrantUrl, qdrantApiKey, collectionPrefix, embeddingModel }) {
  const project = resolve(projectDir)
  const output = resolve(outDir)
  const dataDir = join(project, 'data')
  if (within(dataDir, output) || within(output, dataDir)) throw new Error('Backup directory must be separate from data/')
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(collectionPrefix)) throw new Error('Invalid collection prefix')
  if (await stat(output).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error })) throw new Error('Backup destination already exists')
  const collections = (await listCollections(qdrantUrl, qdrantApiKey)).filter((name) => name.startsWith(`${collectionPrefix}_`))
  if (collections.some((name) => !collectionName.test(name))) throw new Error('Invalid Qdrant collection name')
  const dataFiles = await stat(dataDir).then(() => filesIn(dataDir), (error) => { if (error.code === 'ENOENT') return []; throw error })
  if (!dataFiles.length && !collections.length) throw new Error('No Saywell data or Qdrant collections to back up')
  await mkdir(dirname(output), { recursive: true })
  const temp = await mkdtemp(join(dirname(output), '.saywell-backup-'))
  try {
    const entries = []
    for (const name of dataFiles) {
      const backupName = `data/${name}`
      const destination = safePath(temp, backupName)
      await mkdir(dirname(destination), { recursive: true })
      await copyFile(safePath(dataDir, name), destination)
      entries.push({ path: backupName, ...await digest(destination) })
    }
    for (const name of collections) {
      const encoded = encodeURIComponent(name)
      const created = await qdrantRequest(qdrantUrl, qdrantApiKey, `/collections/${encoded}/snapshots`, { method: 'POST' })
      const snapshotName = (await created.json()).result?.name
      if (typeof snapshotName !== 'string' || !snapshotName || snapshotName.includes('/')) throw new Error('Invalid Qdrant snapshot response')
      const downloaded = await qdrantRequest(qdrantUrl, qdrantApiKey, `/collections/${encoded}/snapshots/${encodeURIComponent(snapshotName)}`)
      if (!downloaded.body) throw new Error('Qdrant snapshot download was empty')
      const backupName = `snapshots/${name}.snapshot`
      const destination = safePath(temp, backupName)
      await mkdir(dirname(destination), { recursive: true })
      await pipeline(downloaded.body, createWriteStream(destination))
      entries.push({ path: backupName, ...await digest(destination) })
    }
    const manifest = { format: 'saywell-machine-backup', version: 1, createdAt: new Date().toISOString(), collectionPrefix, embeddingModel, collections, files: entries }
    await writeFile(join(temp, 'manifest.json'), JSON.stringify(manifest, null, 2))
    await rename(temp, output)
    return { path: output, files: dataFiles.length, collections: collections.length }
  } catch (error) { await rm(temp, { recursive: true, force: true }); throw error }
}

export async function restoreMachine({ projectDir, fromDir, qdrantUrl, qdrantApiKey, collectionPrefix, embeddingModel }) {
  const project = resolve(projectDir)
  const source = resolve(fromDir)
  const dataDir = join(project, 'data')
  if (within(dataDir, source) || within(source, dataDir)) throw new Error('Backup directory must be separate from data/')
  const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'))
  if (manifest.format !== 'saywell-machine-backup' || manifest.version !== 1 || !Array.isArray(manifest.collections) || !Array.isArray(manifest.files)) throw new Error('Unsupported backup format')
  if (manifest.collectionPrefix !== collectionPrefix || manifest.embeddingModel !== embeddingModel) throw new Error('Qdrant prefix or embedding model differs from the backup; configure .env to match first')
  if (manifest.collections.some((name) => !collectionName.test(name) || !name.startsWith(`${collectionPrefix}_`)) || new Set(manifest.collections).size !== manifest.collections.length) throw new Error('Invalid collections in backup')
  const names = new Set()
  for (const file of manifest.files) {
    if (!file || typeof file.path !== 'string' || (!file.path.startsWith('data/') && !file.path.startsWith('snapshots/')) || names.has(file.path) || !hashName.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0) throw new Error('Invalid backup manifest')
    names.add(file.path)
    const path = safePath(source, file.path)
    await rejectSymlinkParents(source, file.path)
    if (!(await lstat(path)).isFile()) throw new Error(`Backup entry is not a regular file: ${file.path}`)
    const actual = await digest(path)
    if (actual.size !== file.size || actual.sha256 !== file.sha256) throw new Error(`Backup checksum mismatch: ${file.path}`)
  }
  if (manifest.collections.some((name) => !names.has(`snapshots/${name}.snapshot`)) || [...names].some((name) => name.startsWith('snapshots/') && !manifest.collections.some((collection) => name === `snapshots/${collection}.snapshot`))) throw new Error('Backup snapshot list is incomplete')
  const existingData = await lstat(dataDir).then((entry) => { if (!entry.isDirectory()) throw new Error('Destination data/ is not a regular directory'); return true }, (error) => { if (error.code === 'ENOENT') return false; throw error })
  if (existingData && (await readdir(dataDir)).length) throw new Error('Destination data/ is not empty; restore only into a fresh installation')
  const existingCollections = new Set(await listCollections(qdrantUrl, qdrantApiKey))
  const conflicts = manifest.collections.filter((name) => existingCollections.has(name))
  if (conflicts.length) throw new Error(`Destination Qdrant already has backup collections: ${conflicts.join(', ')}`)
  for (const name of manifest.collections) {
    const blob = await openAsBlob(safePath(source, `snapshots/${name}.snapshot`))
    const form = new FormData()
    form.append('snapshot', blob, basename(`${name}.snapshot`))
    await qdrantRequest(qdrantUrl, qdrantApiKey, `/collections/${encodeURIComponent(name)}/snapshots/upload?priority=snapshot`, { method: 'POST', body: form })
  }
  for (const file of manifest.files.filter((item) => item.path.startsWith('data/'))) {
    const target = safePath(project, file.path)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(safePath(source, file.path), target)
  }
  return { files: manifest.files.filter((item) => item.path.startsWith('data/')).length, collections: manifest.collections.length }
}
