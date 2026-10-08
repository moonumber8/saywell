import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { Readable, Transform } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const directory = fileURLToPath(new URL('./models/kokoro/', import.meta.url))
const files = [
  { name: 'kokoro-v1.0.onnx', size: 325505369, sha256: 'beb0d1848dee9a49da392cc3df26958d46cfa35d321edf434f52949153f0df3a' },
  { name: 'voices-v1.0.bin', size: 28214398, sha256: 'bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d' },
]
await mkdir(directory, { recursive: true })
for (const file of files) {
  const path = join(directory, file.name)
  let existing = ''
  try { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); existing = hash.digest('hex') } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (existing === file.sha256) { console.log('Verified existing', file.name); continue }
  console.log('Downloading', file.name, Math.round(file.size / 1024 / 1024), 'MiB')
  const response = await fetch(`https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/${file.name}`, { signal: AbortSignal.timeout(300000) })
  if (!response.ok) throw new Error('Kokoro download HTTP ' + response.status)
  const hash = createHash('sha256')
  let size = 0, next = 50 * 1024 * 1024
  const check = new Transform({ transform(chunk, _encoding, done) { hash.update(chunk); size += chunk.length; if (size >= next) { console.log(file.name, Math.round(size / 1024 / 1024), 'MiB'); next += 50 * 1024 * 1024 } done(null, chunk) } })
  await pipeline(Readable.fromWeb(response.body), check, createWriteStream(path + '.download'))
  if (size !== file.size || hash.digest('hex') !== file.sha256) throw new Error('Kokoro download checksum mismatch: ' + file.name)
  await rename(path + '.download', path)
  console.log('Verified', file.name)
}
const license = await fetch('https://www.apache.org/licenses/LICENSE-2.0.txt', { signal: AbortSignal.timeout(30000) })
if (!license.ok) throw new Error('Unable to download Kokoro license')
await writeFile(join(directory, 'LICENSE'), await license.text())
// Record the runtime identity to keep audio caches separate from other voices/models.
await writeFile(join(directory, 'manifest.json'), JSON.stringify({ model: 'Kokoro-82M', version: '1.0', files, license: 'Apache-2.0', source: 'https://huggingface.co/hexgrad/Kokoro-82M' }, null, 2))
console.log('Kokoro-82M model files ready')
