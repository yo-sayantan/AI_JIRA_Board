// Optional local server for the board. Zero dependencies.
//
//   node server/serve.mjs     (or: npm run serve)
//
// Serving the board (http://localhost:4321) unlocks the live Refresh button, per-ticket refresh,
// the archive rebuild and PR report generation. Without it the board still works from file://.
//
// ── API ────────────────────────────────────────────────────────────────────────────────────────
// Responses are JSON unless noted; errors are { ok: false, error: '<short reason>' }. K is a Jira
// ticket key (e.g. ABC-123, any case; normalised to upper case). Query params unless `body:`.
//
// Guards on every request
//   Host must be loopback (localhost, 127.0.0.1, [::1], *.localhost), the BIND_HOST address, or
//   listed in ALLOWED_HOSTS (comma-separated host[:port])          → else 403 'forbidden host'
//   Non-GET/HEAD: Origin (or Referer) host must equal Host, and Sec-Fetch-Site, when sent, must be
//   same-origin or none                                             → else 403 'forbidden origin'
//   POST /api/settings, /api/keys, /api/keys/test, /api/ai-models/pull, /api/ai-jobs need Content-Type: application/json
//                                                                   → else 415 'unsupported media type'
//   Undecodable path → 400 'bad url'. Unknown /api/* → 404. Non-GET on a static path → 405.
//   HEAD behaves like GET without a body. Every response carries X-Content-Type-Options: nosniff
//   and Referrer-Policy: no-referrer; API responses add Cache-Control: no-store.
//
// Static
//   GET  /                                 302 → /dist/index.html
//   GET  /help  /help/                     302 → /help/00-start-here.html (the help guide)
//   GET  /dist/*  /help/*  /docs/*  /setup/*  file (ETag / 304, gzip, Cache-Control: no-cache)
//   GET  /ai-intern/models|cursor-prices|cloud-models.json  file (the help guide reads them live)
//   GET  /jira-intern/data.json|data.js    file, Cache-Control: no-store (Jira data never hits disk cache)
//   GET  /jira-intern/reports/index.js     file, Cache-Control: no-store
//   GET  /jira-intern/demo/data.json       file, the Demo-mode sample board
//
// Data writers (daily fetch, archive rebuild, per-ticket refresh — one data.json writer at a time)
//   POST /api/run-intern                   202 { ok, started:true, runAt } · 409 { ok:false, running:true }
//   POST /api/run-archive?scope=all|year|since|key [&year=YYYY | &since=YYYY-MM-DD | &key=K]
//                                          202 { ok, started:true, runAt } · 400 'bad scope|year|since|key' · 409 running
//   POST /api/run-archive/stop             200 { ok, stopped:bool } — only a rebuild this server started
//   POST /api/refresh-ticket?key=K         202 { ok, queued:true, started:bool | already:true, key, active, position, pending[] }
//                                          · 400 'bad key' · 429 'queue full' (50 waiting)
//
// PR readiness reports
//   GET  /api/reports                      200 { reports:{ K: summary }, generating:[K], exits:{ K: code } }
//   GET  /api/reports/:key                 200 full report JSON · 400 'bad key' · 404 'no report yet'
//   POST /api/report?key=K                 202 { ok, queued:true | already:true [, external:true], key, pending[] }
//                                          · 400 'bad key' · 429 'queue full' (500 waiting)
//   POST /api/reports/bulk?scope=all|year|since|keys [&year= | &since= | &keys=K,K,…] [&force=1]
//                                          202 { ok, scope, matched, queued:[K], pending:[K] [, full:true] }
//                                          · 400 'bad year|since date'. keys= is capped at the queue size.
//   POST /api/reports/stop                 200 { ok, stopped:true }
//
// Settings
//   GET  /api/settings                     200 { ok, settings }
//   POST /api/settings   body: partial settings object, ≤ 4 KB
//                                          200 { ok, settings } · 400 'bad json' | 'bad <field>' | 'aborted'
//                                          · 413 'too large' · 415 · 500 'save failed'
//
// AI intern (proxied to AI_INTERN_URL; 503 { ok:false, down:true } when it is unreachable)
//   GET  /api/keys                         200 { ok, keys:{ ENV:{ set, masked } } } — masked, never a full secret
//   POST /api/keys       body: { name, value } ≤ 8 KB; name from setup/api-keys.json, '' removes it
//                                          200 { ok, keys } · 400 { error } · 413 · 415 (only the named key changes)
//   GET  /api/keys/health                  200 { ok, health:{ <serviceId>:{ service, state:'ok'|'attention', checkedAt, lastOkAt?,
//                                                failingSince?, status?, httpStatus?, detail, source:'fetch'|'worker'|'test' } } }
//                                          — the latest REAL outcome per service (jira-intern/.health/*.json, written by every
//                                          fetch / worker call and by Test); no secret in it; Cache-Control: no-store
//   POST /api/keys/test  body: { service } ≤ 1 KB; service = a setup/api-keys.json id
//                                          200 { ok, service, status:'ok'|'auth-failed'|'forbidden'|'not-found'|
//                                                'unreachable'|'tls'|'not-configured'|'error', httpStatus?, ms, detail }
//                                          · 400 'bad json' | 'unknown service' · 409 'test already running' · 413 · 415
//                                          One authenticated read with the SAVED key (server/keycheck.mjs); detail never
//                                          holds a secret; redirects are not followed; 10 s timeout.
//   GET  /api/ai-status                    200 intern status + { queuedKeys:[K], queued }
//   GET  /api/ai-models                    200 intern /api/models, or { ok:false, down:true, catalog, installed, ollamaOk:false }
//   GET  /api/cloud-models                 200 intern /api/cloud-models
//   POST /api/ai-models/pull  body: { model, useHostOllama? }   intern reply · 400 'aborted' · 413 · 415
//   POST /api/ai-jobs         body: job object                   intern reply · 400 'aborted' · 413 · 415
//
// Polling
//   GET  /api/intern-status                200 { running, job:'daily'|'archive'|'external'|null, lastExit, lastRunAt,
//                                                startedAt, progress, dataModified, refreshingKeys[], refreshExits{},
//                                                reportsGenerating[], reportsEnriching[], ai }
// ───────────────────────────────────────────────────────────────────────────────────────────────
import { createServer } from 'node:http'
import { stat } from 'node:fs/promises'
import { ALLOWED_HOSTS, BOARD_PATH, HELP_PATH, DATE_RE, HOST, KEY_RE, PATHS, PORT, PROJECT_CONFIG, ROOT, STATIC_ALLOW, YEAR_RE } from './config.mjs'
import { readFile } from 'node:fs/promises'
import { createSecretsStore, parseEnv } from './secrets.mjs'
import { createKeyChecker, mergeSettings } from './keycheck.mjs'
import { HEALTH_DIR, readAllHealth, writeHealth } from './health.mjs'
import { SECURITY_HEADERS, createStaticHandler, json, readBody, readJson } from './http.mjs'
import { MOVE_TARGETS, moveTicket, runStatus, startArchive, startDaily, startRaised, stopArchive, ticketRefresh } from './jobs.mjs'
import { externalGenerating, readReport, reportQueue, reportsIndex, resolveReportKeys, stopReports } from './reports.mjs'
import { aiStatus, enrichingKeys, localCatalog, proxyAi } from './ai.mjs'
import { readBoardSettings, updateBoardSettings } from './settings.mjs'
import { startScheduler } from './schedule.mjs'
import { MODELS_DIR_LABEL, ensureOllamaReady, ollamaInfo, ollamaWanted, reconcileOllama } from './ollama.mjs'

const serveStatic = createStaticHandler(ROOT, STATIC_ALLOW, { noStore: [/^\/jira-intern\//] })

// One store (it owns the write queue). The registry is read once, like the board's bundled copy:
// after editing setup/api-keys.json, rebuild and restart so the two agree.
const secrets = createSecretsStore({ file: PATHS.secrets, registry: await readJson(PATHS.apiKeys, { services: [] }) })

// The Test button: setup/.env re-read on every test (environment variables win, as in Python).
const keyChecker = createKeyChecker({
  loadSettings: async () =>
    mergeSettings(parseEnv(await readFile(PATHS.secrets, 'utf8').catch((e) => (e.code === 'ENOENT' ? '' : Promise.reject(e))))),
  config: PROJECT_CONFIG,
  // A finished test also lands in jira-intern/.health/<service>.json, like every real call (source 'test').
  recordHealth: (service, outcome) => writeHealth(HEALTH_DIR, service, { ...outcome, source: 'test' }),
})

const param = (url, name) => (url.searchParams.get(name) || '').trim()

async function reportsGenerating() {
  return [...new Set([...reportQueue.pending, ...(await externalGenerating())])]
}

/** Archive scope from the query string, or an error message. */
function archiveScope(url) {
  const scope = param(url, 'scope').toLowerCase() || 'all'
  const year = param(url, 'year')
  const since = param(url, 'since')
  const key = param(url, 'key').toUpperCase()
  if (!['all', 'year', 'since', 'key'].includes(scope)) return { error: 'bad scope' }
  if (scope === 'key' && !KEY_RE.test(key)) return { error: 'bad key' }
  if (scope === 'year' && !YEAR_RE.test(year)) return { error: 'bad year' }
  if (scope === 'since' && !DATE_RE.test(since)) return { error: 'bad since' }
  const env = { ARCHIVE_SCOPE: scope }
  if (scope === 'year') env.ARCHIVE_YEAR = year
  if (scope === 'since') env.ARCHIVE_SINCE = since
  if (scope === 'key') env.ARCHIVE_KEY = key
  return { env }
}

/** Ticket keys for a bulk report run, or an error message. */
async function bulkReportKeys(url) {
  const scope = param(url, 'scope') || 'all'
  const year = param(url, 'year')
  const since = param(url, 'since')
  if (scope === 'year' && !YEAR_RE.test(year)) return { error: 'bad year' }
  if (scope === 'since' && !DATE_RE.test(since)) return { error: 'bad since date' }
  // An explicit list (the dashboard's cards) still goes through needs-report, so tickets
  // without a PR are skipped and current reports are left alone unless forced.
  const keys =
    scope === 'keys'
      ? [...new Set(param(url, 'keys').split(',').map((s) => s.trim().toUpperCase()).filter((s) => KEY_RE.test(s)))]
      : null
  if (keys && (keys.length === 0 || keys.length > 500)) return { error: 'bad keys' }
  return {
    keys: await resolveReportKeys({
      year: scope === 'year' ? year : null,
      since: scope === 'since' ? since : null,
      keys,
      force: url.searchParams.get('force') === '1',
    }),
  }
}

const routes = {
  'POST /api/run-intern': async (req, res) => {
    const runAt = await startDaily()
    if (!runAt) return json(res, 409, { ok: false, running: true })
    json(res, 202, { ok: true, started: true, runAt })
  },

  'POST /api/run-archive': async (req, res, url) => {
    const { env, error } = archiveScope(url)
    if (error) return json(res, 400, { ok: false, error })
    const runAt = await startArchive(env)
    if (!runAt) return json(res, 409, { ok: false, running: true })
    json(res, 202, { ok: true, started: true, runAt })
  },

  'POST /api/run-archive/stop': async (req, res) => {
    const stopped = await stopArchive()
    json(res, 200, { ok: true, stopped })
  },

  // Raised-by-me only — the refresh button inside the Raised view. One quick JQL search.
  'POST /api/run-raised': async (req, res) => {
    const runAt = await startRaised()
    if (!runAt) return json(res, 409, { ok: false, running: true })
    json(res, 202, { ok: true, started: true, runAt })
  },

  // Already active or queued is an idempotent success, so the UI can keep watching.
  'POST /api/refresh-ticket': (req, res, url) => {
    const key = param(url, 'key').toUpperCase()
    if (!KEY_RE.test(key)) return json(res, 400, { ok: false, error: 'bad key' })
    const added = ticketRefresh.add(key)
    if (added === null) return json(res, 429, { ok: false, error: 'queue full' })
    const pending = ticketRefresh.pending
    json(res, 202, {
      ok: true,
      ...(added ? { queued: true, started: ticketRefresh.active === key } : { already: true }),
      key,
      active: ticketRefresh.active,
      position: pending.indexOf(key),
      pending,
    })
  },

  // Drag-and-drop: move a ticket to another column IN JIRA. Answers once Jira has, with the gate
  // verdict (moved / blocked / error) — the board moved the card optimistically and bounces it back
  // on anything but ok.
  'POST /api/move-ticket': async (req, res, url) => {
    const key = param(url, 'key').toUpperCase()
    const to = param(url, 'to').toLowerCase()
    if (!KEY_RE.test(key)) return json(res, 400, { ok: false, error: 'bad key' })
    if (!MOVE_TARGETS.has(to)) return json(res, 400, { ok: false, error: 'bad target' })
    const mode = param(url, 'mode') || 'normal'
    if (!['normal', 'force', 'undo'].includes(mode)) return json(res, 400, { ok: false, error: 'bad mode' })
    json(res, 200, { key, to, ...(await moveTicket(key, to, mode)) })
  },

  'GET /api/reports': async (req, res) => {
    const [reports, generating] = await Promise.all([reportsIndex(), reportsGenerating()])
    json(res, 200, { reports, generating, exits: Object.fromEntries(reportQueue.exits) })
  },

  // A report another process (terminal, cron backfill) is already building is reported as
  // `already` too: two writers on one report file would race.
  'POST /api/report': async (req, res, url) => {
    const key = param(url, 'key').toUpperCase()
    if (!KEY_RE.test(key)) return json(res, 400, { ok: false, error: 'bad key' })
    if ((await externalGenerating()).includes(key)) return json(res, 202, { ok: true, already: true, external: true, key, pending: reportQueue.pending })
    const added = reportQueue.add(key)
    if (added === null) return json(res, 429, { ok: false, error: 'queue full' })
    json(res, 202, { ok: true, ...(added ? { queued: true } : { already: true }), key, pending: reportQueue.pending })
  },

  // Queued through the same one-at-a-time pump as single reports, skipping anything already in
  // flight here or in a terminal/cron backfill.
  'POST /api/reports/bulk': async (req, res, url) => {
    const { keys, error } = await bulkReportKeys(url)
    if (error) return json(res, 400, { ok: false, error })
    const busy = new Set(await externalGenerating())
    const queued = []
    let full = false
    for (const key of keys) {
      if (busy.has(key)) continue
      const added = reportQueue.add(key)
      if (added) queued.push(key)
      else if (added === null) {
        full = true
        break
      }
    }
    json(res, 202, { ok: true, scope: param(url, 'scope') || 'all', matched: keys.length, queued, pending: reportQueue.pending, ...(full && { full }) })
  },

  'POST /api/reports/stop': async (req, res) => {
    await stopReports()
    json(res, 200, { ok: true, stopped: true })
  },

  'GET /api/settings': async (req, res) => {
    json(res, 200, { ok: true, settings: await readBoardSettings() })
  },

  'POST /api/settings': async (req, res) => {
    const body = await readBody(req, 4096)
    if (body === undefined) return json(res, 400, { ok: false, error: 'aborted' })
    if (body === null) return json(res, 413, { ok: false, error: 'too large' })
    let patch
    try {
      patch = JSON.parse(body || '{}')
    } catch {
      return json(res, 400, { ok: false, error: 'bad json' })
    }
    try {
      const before = await readBoardSettings()
      const { settings, error } = await updateBoardSettings(patch)
      if (error) return json(res, 400, { ok: false, error })
      const after = await readBoardSettings()
      // The AI-Ollama container follows its Settings toggle (and the models directory).
      // Answered immediately; Docker takes its time in the background.
      let ollama = 'unchanged'
      if (!!before.ollamaEnabled !== !!after.ollamaEnabled) {
        if (!after.ollamaEnabled) ollama = 'stopping'
        else ollama = (await ollamaWanted(after)) ? 'starting' : 'no-models'
        reconcileOllama(after).then((r) => console.log(`[ollama] settings → ${r}`), () => {})
      }
      json(res, 200, { ok: true, settings, ollama })
    } catch (e) {
      console.error('[settings] save failed', e)
      json(res, 500, { ok: false, error: 'save failed' })
    }
  },

  'GET /api/keys': async (req, res) => {
    try {
      json(res, 200, { ok: true, keys: await secrets.status() })
    } catch (e) {
      console.error('[keys] read failed', e.code || e.message)
      json(res, 500, { ok: false, error: 'could not read setup/.env' })
    }
  },

  'POST /api/keys': async (req, res) => {
    const body = await readBody(req, 8192)
    if (body === undefined) return json(res, 400, { ok: false, error: 'aborted' })
    if (body === null) return json(res, 413, { ok: false, error: 'too large' })
    let parsed
    try {
      parsed = JSON.parse(body || '{}')
    } catch {
      return json(res, 400, { ok: false, error: 'bad json' })
    }
    try {
      const { status, error } = await secrets.save(parsed?.name, parsed?.value)
      if (error) return json(res, 400, { ok: false, error })
      // Names only — never a value — so the log shows what changed.
      console.log(`[keys] ${parsed.value?.trim() ? 'saved' : 'removed'} ${parsed.name}`)
      json(res, 200, { ok: true, keys: status })
    } catch (e) {
      console.error('[keys] save failed', e.code || e.message)
      json(res, 500, { ok: false, error: 'could not write setup/.env' })
    }
  },

  'GET /api/keys/health': async (req, res) => {
    // Never throws: a missing folder just means nothing has been called yet.
    json(res, 200, { ok: true, health: await readAllHealth(HEALTH_DIR) })
  },

  'POST /api/keys/test': async (req, res) => {
    const body = await readBody(req, 1024)
    if (body === undefined) return json(res, 400, { ok: false, error: 'aborted' })
    if (body === null) return json(res, 413, { ok: false, error: 'too large' })
    let parsed
    try {
      parsed = JSON.parse(body || '{}')
    } catch {
      return json(res, 400, { ok: false, error: 'bad json' })
    }
    try {
      const result = await keyChecker.test(parsed?.service)
      if (result.unknown) return json(res, 400, { ok: false, error: 'unknown service' })
      if (result.busy) return json(res, 409, { ok: false, error: 'test already running' })
      json(res, 200, result)
    } catch (e) {
      console.error('[keys] test failed', e.code || 'error')
      json(res, 500, { ok: false, error: 'could not read setup/.env' })
    }
  },

  'GET /api/ai-status': async (req, res) => {
    const [ai, settings] = await Promise.all([aiStatus(), readBoardSettings()])
    json(res, 200, { ...ai, container: await ollamaInfo(settings) })
  },

  'GET /api/ai-models': async (req, res) => {
    const ai = await aiStatus()
    if (!ai.down) return proxyAi(req, res, '/api/models')
    json(res, 200, { ok: false, down: true, catalog: ai.catalog || (await localCatalog()), installed: ai.installedModels || [], ollamaOk: false })
  },

  'GET /api/cloud-models': (req, res) => proxyAi(req, res, '/api/cloud-models'),
  // Pulling a model needs the container up — start it on demand (a stopped Ollama has no models).
  'POST /api/ai-models/pull': async (req, res) => {
    const settings = await readBoardSettings()
    if (!settings.aiUseHostOllama && !(await ensureOllamaReady(settings))) {
      const error = settings.ollamaEnabled
        ? 'AI-Ollama container is not available'
        : 'Turn on the AI-Ollama container in Settings first'
      return json(res, 503, { ok: false, down: true, error })
    }
    return proxyAi(req, res, '/api/models/pull')
  },
  'POST /api/ai-jobs': (req, res) => proxyAi(req, res, '/api/jobs'),

  // One call carries everything the board polls for: run state, queues, reports, AI intern.
  'GET /api/intern-status': async (req, res) => {
    const [run, dataModified, ai, generating, settings] = await Promise.all([
      runStatus(),
      stat(PATHS.data).then((s) => s.mtimeMs, () => null),
      aiStatus(),
      reportsGenerating(),
      readBoardSettings(),
    ])
    const container = await ollamaInfo(settings)
    json(res, 200, {
      ...run,
      dataModified,
      refreshingKeys: ticketRefresh.pending,
      refreshExits: Object.fromEntries(ticketRefresh.exits),
      reportsGenerating: generating,
      reportsEnriching: [...new Set(enrichingKeys(ai))],
      ai: { ...ai, container },
    })
  },
}

// ── Request guards ─────────────────────────────────────────────────────────────────────────────

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])
const WILDCARD_BINDS = new Set(['', '0.0.0.0', '::', '[::]'])
// A specific bind address is as good as a loopback name: a rebinding page cannot make the
// browser send our IP literal as its Host.
const BIND_NAME = WILDCARD_BINDS.has(HOST) ? null : HOST.includes(':') ? `[${HOST.toLowerCase()}]` : HOST.toLowerCase()
const JSON_BODY_ROUTES = new Set(['POST /api/settings', 'POST /api/keys', 'POST /api/keys/test', 'POST /api/ai-models/pull', 'POST /api/ai-jobs'])
const warnedHosts = new Set()

const hostName = (host) => host.replace(/:\d+$/, '')

/** Host header check (DNS rebinding): loopback, our own bind address, or an ALLOWED_HOSTS entry. */
function hostAllowed(host) {
  if (!host) return false
  const full = host.toLowerCase()
  const name = hostName(full)
  if (LOOPBACK.has(name) || name.endsWith('.localhost') || name === BIND_NAME) return true
  return ALLOWED_HOSTS.has(full) || ALLOWED_HOSTS.has(name)
}

/**
 * Cross-site write check. Browsers name the page's origin on every POST, so it has to be ours;
 * a request with neither Origin nor Referer (curl, scripts) has no page to have been forged from.
 */
function originAllowed(req) {
  const site = req.headers['sec-fetch-site']
  if (site && site !== 'same-origin' && site !== 'none') return false
  const source = req.headers.origin || req.headers.referer
  if (!source) return true
  try {
    return new URL(source).host.toLowerCase() === (req.headers.host || '').toLowerCase()
  } catch {
    return false
  }
}

const isJsonType = (type) => /^application\/json\s*(;|$)/i.test(type || '')

function safeDecode(s) {
  try {
    return decodeURIComponent(s)
  } catch {
    return null
  }
}

// ── Dispatcher ─────────────────────────────────────────────────────────────────────────────────

async function handle(req, res) {
  const host = req.headers.host
  if (!hostAllowed(host)) {
    if (!warnedHosts.has(host) && warnedHosts.size < 20) {
      warnedHosts.add(host)
      console.warn(`[http] refused Host "${host ?? ''}" — add it to ALLOWED_HOSTS to serve the board under that name`)
    }
    return json(res, 403, { ok: false, error: 'forbidden host', hint: 'set ALLOWED_HOSTS=<host[:port]> to serve this name' })
  }
  const method = req.method === 'HEAD' ? 'GET' : req.method
  if (method !== 'GET' && !originAllowed(req)) return json(res, 403, { ok: false, error: 'forbidden origin' })

  let url
  try {
    url = new URL(req.url, 'http://localhost')
  } catch {
    return json(res, 400, { ok: false, error: 'bad url' })
  }
  const path = safeDecode(url.pathname)
  if (path === null) return json(res, 400, { ok: false, error: 'bad url' })
  if (path === '/') {
    res.writeHead(302, { Location: BOARD_PATH, ...SECURITY_HEADERS }).end()
    return
  }
  if (path === '/help' || path === '/help/') {
    res.writeHead(302, { Location: HELP_PATH, ...SECURITY_HEADERS }).end()
    return
  }

  const name = `${method} ${path}`
  if (JSON_BODY_ROUTES.has(name) && !isJsonType(req.headers['content-type'])) {
    return json(res, 415, { ok: false, error: 'unsupported media type' })
  }
  const route = routes[name]
  if (route) return route(req, res, url)

  if (method === 'GET' && path.startsWith('/api/reports/')) {
    const key = path.slice('/api/reports/'.length).trim().toUpperCase()
    if (!KEY_RE.test(key)) return json(res, 400, { ok: false, error: 'bad key' })
    let report
    try {
      report = await readReport(key)
    } catch {
      return json(res, 404, { ok: false, error: 'no report yet' })
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS }).end(report)
    return
  }
  if (path.startsWith('/api/')) return json(res, 404, { ok: false, error: 'not found' })
  if (method !== 'GET') return json(res, 405, { ok: false, error: 'method not allowed' })
  return serveStatic(req, res, path)
}

const server = createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error('[http]', req.method, req.url, e)
    if (!res.headersSent) json(res, 500, { ok: false, error: 'internal error' })
    else res.destroy()
  })
})

process.on('unhandledRejection', (e) => console.error('[unhandled]', e))

/** `docker stop` / Ctrl+C: stop accepting, drop idle keep-alive sockets, exit. */
function shutdown(signal) {
  console.log(`\n  ${signal} received — shutting down`)
  server.close(() => process.exit(0))
  server.closeAllConnections()
  setTimeout(() => process.exit(0), 2000).unref()
}
process.once('SIGTERM', () => shutdown('SIGTERM'))
process.once('SIGINT', () => shutdown('SIGINT'))

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? 'localhost' : HOST
  console.log(`\n  🎫  My Jira Board  →  http://${shown}:${PORT}${BOARD_PATH}`)
  console.log(`      Live Refresh enabled (runs the intern). Press Ctrl+C to stop.\n`)
  startScheduler().catch((e) => console.error('[schedule] failed to start', e))
  // AI-Ollama follows its Settings toggle, and only runs when jira-intern/models/ holds a model.
  readBoardSettings()
    .then(reconcileOllama)
    .then((r) => console.log(`[ollama] boot → ${r} (models dir: ${MODELS_DIR_LABEL})`), (e) => console.error('[ollama] boot reconcile failed', e))
})
