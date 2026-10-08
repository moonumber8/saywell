import 'dotenv/config'
import { fileURLToPath } from 'node:url'
import { createRag } from './rag.mjs'

const rag = createRag({
  baseUrl: process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434',
  embeddingModel: process.env.OLLAMA_EMBEDDING_MODEL ?? 'qwen3-embedding:4b',
  chatModel: process.env.OLLAMA_MODEL ?? 'qwen3.5:9b',
  documentsPath: fileURLToPath(new URL('./data/curriculum.json', import.meta.url)),
  legacyIndexPath: fileURLToPath(new URL('./data/embedding-index.json', import.meta.url)),
  qdrantUrl: process.env.QDRANT_URL ?? 'http://127.0.0.1:6333',
  collectionPrefix: process.env.QDRANT_COLLECTION ?? 'saywell_curriculum',
  qdrantApiKey: process.env.QDRANT_API_KEY,
})
try { console.log(JSON.stringify(await rag.index(), null, 2)) }
catch (error) { console.error(error.message); process.exitCode = 1 }
