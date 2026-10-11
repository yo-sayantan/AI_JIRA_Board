import { open, readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { promisify } from 'node:util'
import { gzip } from 'node:zlib'

const gzipAsync = promisify(gzip)

/** On every response: no MIME sniffing of what we serve, and no Referer leaking out of the board. */
export const SECURITY_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }

export function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...SECURITY_HEADERS }).end(JSON.stringify(obj))
}

// How far past `limit` readBody keeps draining before it gives up on the connection instead.
const DRAIN_SLACK = 1024 * 1024

/**
 * Read a request body as UTF-8 text.
 *   string    → the complete body
 *   null      → more than `limit` bytes (declared or received); the surplus is drained, within
 *               reason, so the caller's 413 still reaches the client instead of a reset
 *   undefined → the client went away before the body was complete
 */
export function readBody(req, limit) {
  const declared = Number(req.headers['content-length'])
  if (declared > limit) return Promise.resolve(null)
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let settled = false
    const settle = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        chunks.length = 0
        settle(null)
        if (size > limit + DRAIN_SLACK) req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => settle(req.complete ? Buffer.concat(chunks).toString('utf8') : undefined))
    req.on('error', () => settle(undefined))
    req.on('close', () => settle(undefined))
  })
}

/** Parse a JSON file; `fallback` when it is missing, unreadable, or not valid JSON. */
export async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return fallback
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
}
const COMPRESSIBLE = /^(text\/|application\/json|image\/svg)/
const MAX_CACHED_BYTES = 8 * 1024 * 1024

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS }).end('Not found')
}

/**
 * Static files under `root`, limited to the `allow` patterns. The board bundle and data.js are
 * ~0.7 MB each and re-requested on every reload, so each file is kept in memory (plain + gzip)
 * until its mtime changes, and revalidated with an ETag instead of being re-sent. Paths matching
 * `noStore` (the Jira data) are sent with Cache-Control: no-store so the browser never writes them
 * to its disk cache; the ETag still answers a conditional request with a 304.
 */
export function createStaticHandler(root, allow, { noStore = [] } = {}) {
  const cache = new Map()

  async function load(file) {
    const fh = await open(file)
    try {
      const st = await fh.stat()
      if (!st.isFile()) return null
      const hit = cache.get(file)
      if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit
      const body = await fh.readFile()
      const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream'
      const entry = {
        mtimeMs: st.mtimeMs,
        size: st.size,
        type,
        etag: `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`,
        body,
        gz: COMPRESSIBLE.test(type) && body.length > 1024 ? await gzipAsync(body) : null,
      }
      if (body.length <= MAX_CACHED_BYTES) cache.set(file, entry)
      return entry
    } finally {
      await fh.close()
    }
  }

  return async function serveStatic(req, res, path) {
    // `path` is already percent-decoded. The allow-list is the guard: only paths matching one of
    // its patterns are ever opened. normalize() has collapsed any `..` segments by the time the
    // patterns run, so the leading-`..` strip and the root check below are defence in depth only.
    const safe = normalize(path).replace(/^(\.\.([/\\]|$))+/, '')
    const file = join(root, safe)
    // Dotfiles are never static content (setup/.env holds the API keys), whatever `allow` says.
    if (/(^|[/\\])\./.test(safe)) return notFound(res)
    if (!file.startsWith(root) || !allow.some((re) => re.test(safe))) return notFound(res)
    let entry
    try {
      entry = await load(file)
    } catch {
      entry = null
    }
    if (!entry) return notFound(res)
    const headers = {
      'Content-Type': entry.type,
      'Cache-Control': noStore.some((re) => re.test(safe)) ? 'no-store' : 'no-cache',
      ETag: entry.etag,
      Vary: 'Accept-Encoding',
      ...SECURITY_HEADERS,
    }
    if (req.headers['if-none-match'] === entry.etag) {
      res.writeHead(304, headers).end()
      return
    }
    const useGzip = entry.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '')
    const body = useGzip ? entry.gz : entry.body
    if (useGzip) headers['Content-Encoding'] = 'gzip'
    headers['Content-Length'] = body.length
    res.writeHead(200, headers).end(req.method === 'HEAD' ? undefined : body)
  }
}
