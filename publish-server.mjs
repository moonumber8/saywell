import 'dotenv/config'
import express from 'express'
import { request } from 'node:http'
import { existsSync } from 'node:fs'
import { extname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export function learnerRoute(method, path) {
  if (['GET', 'HEAD'].includes(method)) return /^\/api\/curriculum$/.test(path) || /^\/api\/curriculum\/(?:documents|structured)\/[A-Za-z0-9_-]{1,100}$/.test(path)
  if (method !== 'POST') return false
  return ['/api/curriculum/topics', '/api/curriculum/lesson', '/api/speaking/advice', '/api/speaking/transcribe', '/api/speaking/audio'].includes(path) || /^\/api\/curriculum\/structured\/[A-Za-z0-9_-]{1,100}\/check$/.test(path)
}

export function createPublishApp({ origin = `http://127.0.0.1:${process.env.PORT || 3001}`, directory = fileURLToPath(new URL('./dist/', import.meta.url)) } = {}) {
  const app = express()
  app.disable('x-powered-by')
  app.use((_req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'Permissions-Policy': 'microphone=(self)' })
    next()
  })
  app.get('/healthz', (_req, res) => res.json({ status: 'ok', mode: 'learner' }))
  app.use('/api', async (req, res) => {
    const path = req.originalUrl.split('?')[0]
    if (!learnerRoute(req.method, path)) return res.status(403).json({ error: 'จัดการหลักสูตรได้จากเครื่องเจ้าของแอปเท่านั้น' })
    if (path === '/api/curriculum' && ['GET', 'HEAD'].includes(req.method)) {
      try {
        const upstream = await fetch(new URL(req.originalUrl, origin), { signal: AbortSignal.timeout(15000) })
        const body = await upstream.json()
        delete body.activeImport
        return res.status(upstream.status).set('Cache-Control', 'no-store').json({ ...body, canManage: false })
      } catch { return res.status(502).json({ error: 'เชื่อมต่อบริการหลักสูตรไม่ได้ กรุณาลองใหม่' }) }
    }
    // Relay streams directly: NDJSON progress must reach learners as it arrives.
    // Management endpoints and arbitrary local service URLs are never forwarded.
    const headers = { accept: req.get('accept') || 'application/json' }
    if (req.get('content-type')) headers['content-type'] = req.get('content-type')
    if (req.get('content-length')) headers['content-length'] = req.get('content-length')
    const upstream = request(new URL(req.originalUrl, origin), { method: req.method, headers }, (incoming) => {
      res.status(incoming.statusCode || 502)
      if (incoming.headers['content-type']) res.set('Content-Type', incoming.headers['content-type'])
      for (const header of ['x-audio-model', 'x-audio-cache']) if (incoming.headers[header]) res.set(header, incoming.headers[header])
      res.set({ 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' })
      incoming.on('error', () => res.destroy())
      res.flushHeaders()
      incoming.pipe(res)
    })
    upstream.setTimeout(200000, () => upstream.destroy(new Error('Upstream timeout')))
    upstream.on('error', () => {
      if (res.destroyed) return
      if (res.headersSent) res.destroy()
      else res.status(502).json({ error: 'เชื่อมต่อบริการบทเรียนไม่ได้ กรุณาลองใหม่' })
    })
    req.on('aborted', () => upstream.destroy())
    res.on('close', () => { if (!res.writableEnded) upstream.destroy() })
    req.pipe(upstream)
  })
  app.use((req, res, next) => {
    let path
    try { path = decodeURIComponent(req.path) } catch { return res.sendStatus(400) }
    if (path.split('/').some(segment => segment.startsWith('.'))) return res.sendStatus(404)
    next()
  })
  app.use(express.static(directory, { index: 'index.html', dotfiles: 'deny', setHeaders: (res, path) => res.set('Cache-Control', path.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600') }))
  app.use((req, res) => {
    if (!['GET', 'HEAD'].includes(req.method) || extname(req.path)) return res.sendStatus(404)
    res.set('Cache-Control', 'no-cache').sendFile('index.html', { root: directory })
  })
  return app
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = fileURLToPath(new URL('./dist/', import.meta.url))
  if (!existsSync(`${directory}index.html`)) throw new Error('Build the app first: npm run build')
  const port = Number(process.env.PUBLIC_PORT || 4173)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PUBLIC_PORT must be a valid port')
  createPublishApp({ directory }).listen(port, '127.0.0.1', () => console.log(`Saywell learner site ready at http://127.0.0.1:${port}`))
}
