import 'dotenv/config'
import { fileURLToPath } from 'node:url'
import { backupMachine, restoreMachine } from './machine-transfer.mjs'

const [command, option, directory, ...extra] = process.argv.slice(2)
if (!['backup', 'restore'].includes(command) || option !== (command === 'backup' ? '--out' : '--from') || !directory || extra.length) {
  console.error('Usage: npm run move:backup -- --out <new-folder>  OR  npm run move:restore -- --from <backup-folder>')
  process.exitCode = 1
} else {
  const config = {
    projectDir: fileURLToPath(new URL('.', import.meta.url)),
    qdrantUrl: process.env.QDRANT_URL ?? 'http://127.0.0.1:6333',
    qdrantApiKey: process.env.QDRANT_API_KEY,
    collectionPrefix: process.env.QDRANT_COLLECTION ?? 'saywell_curriculum',
    embeddingModel: process.env.OLLAMA_EMBEDDING_MODEL ?? 'qwen3-embedding:4b',
  }
  try {
    const result = command === 'backup'
      ? await backupMachine({ ...config, outDir: directory })
      : await restoreMachine({ ...config, fromDir: directory })
    console.log(JSON.stringify(result, null, 2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
