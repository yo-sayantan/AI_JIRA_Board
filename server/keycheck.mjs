// "Does this key work?" — the API keys dialog's Test button (POST /api/keys/test).
//
// One lightweight, authenticated READ per service, using the SAVED values: setup/.env through the
// same parser as server/secrets.mjs (environment variables win, like the Python side), base URLs
// from the saved *_URL keys, else the config's endpoints. Nothing is written anywhere.
//
// Safety rules, all enforced here:
//   • https only (http only for a localhost base); a URL with a user, password, ? or # is refused
//   • redirects are never followed — a 3xx is reported as "Redirected to <host>", auth never resent
//   • 10 s timeout, response body capped, one test per service at a time
//   • TLS always verified; JIRA_CA_BUNDLE (else ~/.ai/ca-bundle.pem) is ADDED to the system roots;
//     JIRA_INSECURE_TLS=1 relaxes verification for the Jira / Confluence / Bitbucket hosts only;
//     JENKINS_INSECURE_TLS=1 for Jenkins only (the same switches the fetch honours)
//   • the result's detail is built from safe identity fields only (display name, login, a count),
//     and any saved secret is scrubbed from it; logs carry the service and the status, nothing else
// The HTTP layer is injected (`request`) so tests never touch the network.
import { readFile } from 'node:fs/promises'
import { request as httpRequestRaw } from 'node:http'
import { request as httpsRequestRaw } from 'node:https'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { rootCertificates } from 'node:tls'

export const KEY_TEST_SERVICES = ['jira', 'confluence', 'bitbucket', 'atlassian', 'jenkins', 'checkmarx', 'claude', 'cursor', 'gemini', 'openai', 'github']

const TIMEOUT_MS = 10_000
const MAX_BYTES = 256 * 1024
const DEFAULT_CA_BUNDLE = join(homedir(), '.ai', 'ca-bundle.pem')
/** The on-prem hosts JIRA_INSECURE_TLS may relax — the same set _jira.py's ssl_context serves. */
const ON_PREM = new Set(['jira', 'confluence', 'bitbucket'])
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])
/** Same client id jira-intern/checkmarx.py uses for the refresh-token exchange. */
const CHECKMARX_CLIENT_ID = 'ast-app'

/** setup/.env values with the environment on top: a non-blank environment variable wins. */
export function mergeSettings(fileValues, env = process.env) {
  const out = { ...fileValues }
  for (const [k, v] of Object.entries(env || {})) {
    if (typeof v === 'string' && v.trim()) out[k] = v.trim()
  }
  return out
}

/** Read a response stream up to `maxBytes`; past that, stop and say it was truncated. */
export function collectBody(stream, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let done = false
    const finish = (truncated) => {
      if (done) return
      done = true
      resolve({ text: Buffer.concat(chunks).toString('utf8'), truncated })
    }
    stream.on('data', (chunk) => {
      if (done) return
      const room = maxBytes - size
      if (chunk.length > room) {
        if (room > 0) chunks.push(chunk.subarray(0, room))
        size = maxBytes
        finish(true)
        stream.destroy?.()
        return
      }
      chunks.push(chunk)
      size += chunk.length
    })
    stream.on('end', () => finish(false))
    stream.on('error', (e) => (done ? undefined : ((done = true), reject(e))))
  })
}

/**
 * The real HTTP layer: one request, no redirect handling at all (node's http never follows them),
 * a hard timeout and a body cap. → { status, headers, body, truncated }; network errors reject.
 */
export function httpRequest({ method = 'GET', url, headers = {}, body, timeoutMs = TIMEOUT_MS, maxBytes = MAX_BYTES, tls = {} }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const send = u.protocol === 'https:' ? httpsRequestRaw : httpRequestRaw
    const options = { method, headers: { ...headers }, timeout: timeoutMs }
    if (u.protocol === 'https:') {
      options.rejectUnauthorized = tls.rejectUnauthorized !== false
      if (tls.ca) options.ca = tls.ca
      options.agent = false
    }
    if (body != null) options.headers['Content-Length'] = Buffer.byteLength(body)
    const timer = setTimeout(() => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })), timeoutMs)
    const req = send(u, options, (res) => {
      collectBody(res, maxBytes).then(
        ({ text, truncated }) => {
          clearTimeout(timer)
          resolve({ status: res.statusCode, headers: res.headers, body: text, truncated })
        },
        (e) => {
          clearTimeout(timer)
          reject(e)
        },
      )
    })
    req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })))
    req.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    if (body != null) req.write(body)
    req.end()
  })
}

const UNREACHABLE = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ECONNABORTED', 'EPERM', 'EACCES'])
const TIMEOUTS = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'ABORT_ERR'])

/** A thrown network error → { status, detail }. The error's own message is never echoed. */
export function classifyError(err, host) {
  const code = String(err?.code || '')
  const where = host ? ` ${host}` : ' the host'
  if (TIMEOUTS.has(code)) return { status: 'unreachable', detail: `Can't reach${where} — timed out after ${TIMEOUT_MS / 1000} s` }
  if (UNREACHABLE.has(code)) return { status: 'unreachable', detail: `Can't reach${where} (${code})` }
  if (/^(CERT_|UNABLE_TO_|ERR_TLS_|DEPTH_ZERO_SELF_SIGNED|SELF_SIGNED_CERT|ERR_SSL_)/.test(code)) {
    return { status: 'tls', detail: `Certificate of${where} not trusted (${code}) — add its CA with JIRA_CA_BUNDLE` }
  }
  return { status: 'error', detail: code ? `Request failed (${code})` : 'Request failed' }
}

/** A base URL a credential may go to → normalised (no trailing slash), or { error }. */
function baseUrl(value) {
  const raw = String(value || '').trim()
  if (!raw) return { error: 'empty' }
  let u
  try {
    u = new URL(raw)
  } catch {
    return { error: 'is not a URL' }
  }
  const local = LOOPBACK.has(u.hostname) || u.hostname.endsWith('.localhost')
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return { error: 'must start with https://' }
  if (u.username || u.password || u.search || u.hash || raw.includes('?') || raw.includes('#')) return { error: 'must not carry a user, ? or #' }
  // The tracked config ships placeholders under the reserved .example name.
  if (u.hostname === 'example' || u.hostname.endsWith('.example')) return { error: 'is still the example placeholder' }
  return { url: raw.replace(/\/+$/, ''), host: u.hostname }
}

const basic = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`

function parseJson(res) {
  if (res.truncated || !res.body) return null
  try {
    return JSON.parse(res.body)
  } catch {
    return null
  }
}

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '')
const signedIn = (name) => (name ? `Signed in as ${name}` : 'Key accepted')
const countOf = (list, noun) => (Array.isArray(list) ? `${list.length} ${noun}${list.length === 1 ? '' : 's'}` : 'Key accepted')

/**
 * Per service: what it needs and the one request it sends. `plan(s)` → { request, host, onOk } or
 * { notConfigured: 'reason' }. `s` is the merged settings; `cfg` the project config.
 */
const PLANS = {
  jira: (s, cfg) => onPrem(s, cfg, { token: 'JIRA_PERSONAL_TOKEN', urlKey: 'JIRA_URL', endpoint: 'jiraBase', path: '/rest/api/2/myself', ok: (j) => signedIn(str(j?.displayName)) }),
  confluence: (s, cfg) =>
    onPrem(s, cfg, { token: 'CONFLUENCE_PERSONAL_TOKEN', urlKey: 'CONFLUENCE_URL', endpoint: 'confluenceBase', path: '/rest/api/user/current', ok: (j) => signedIn(str(j?.displayName)) }),
  bitbucket: (s, cfg) =>
    onPrem(s, cfg, {
      token: s.BITBUCKET_PAT ? 'BITBUCKET_PAT' : 'ATLASSIAN_TOKEN',
      tokenLabel: 'BITBUCKET_PAT (or ATLASSIAN_TOKEN)',
      urlKey: 'BITBUCKET_URL',
      endpoint: 'bitbucketBase',
      path: '/rest/api/1.0/projects?limit=1',
      ok: (j) => (j && typeof j.size === 'number' ? (j.size ? 'Projects readable' : 'Signed in — no projects visible') : 'Key accepted'),
    }),
  atlassian: (s) => {
    if (!s.ATLASSIAN_TOKEN) return { notConfigured: 'needs ATLASSIAN_TOKEN' }
    if (!s.ATLASSIAN_EMAIL || !s.ATLASSIAN_SITE_URL) return { notConfigured: 'needs email + site URL' }
    const b = baseUrl(s.ATLASSIAN_SITE_URL)
    if (b.error) return { notConfigured: `site URL ${b.error}` }
    return {
      host: b.host,
      request: { method: 'GET', url: `${b.url}/rest/api/3/myself`, headers: { Authorization: basic(s.ATLASSIAN_EMAIL, s.ATLASSIAN_TOKEN), Accept: 'application/json' } },
      onOk: (j) => signedIn(str(j?.displayName)),
    }
  },
  jenkins: (s, cfg) => {
    if (!s.JENKINS_USER || !s.JENKINS_API_TOKEN) return { notConfigured: 'needs JENKINS_USER + JENKINS_API_TOKEN' }
    const job = firstJenkinsJob(cfg)
    if (!job) return { notConfigured: 'no https job URL in jenkins.jobs (config)' }
    const u = new URL(job)
    const url = `${job.endsWith('/') ? job : job + '/'}api/json?tree=name`
    return {
      host: u.hostname,
      request: { method: 'GET', url, headers: { Authorization: basic(s.JENKINS_USER, s.JENKINS_API_TOKEN), Accept: 'application/json' } },
      onOk: (j) => (str(j?.name) ? `Job ${str(j.name)} readable` : 'Key accepted'),
    }
  },
  checkmarx: (s, cfg) => {
    if (!s.CHECKMARX_API_KEY) return { notConfigured: 'needs CHECKMARX_API_KEY' }
    const urls = checkmarxUrls(s, cfg)
    if (!urls) return { notConfigured: 'needs a tenant API URL (CHECKMARX_BASE_URL or endpoints.checkmarxBase), https' }
    const body = new URLSearchParams({ grant_type: 'refresh_token', client_id: CHECKMARX_CLIENT_ID, refresh_token: s.CHECKMARX_API_KEY }).toString()
    return {
      host: new URL(urls.auth).hostname,
      request: { method: 'POST', url: urls.auth, headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body },
      onOk: (j) => (str(j?.access_token) ? 'Key accepted — token issued' : { status: 'error', detail: 'No access token in the reply' }),
      // Keycloak answers a bad or revoked refresh token with 400 invalid_grant.
      onStatus: (res) => {
        if (res.status !== 400) return null
        const err = str(parseJson(res)?.error)
        return err === 'invalid_grant' || err === 'invalid_client' || err === 'unauthorized_client' ? { status: 'auth-failed', detail: 'Key rejected' } : null
      },
    }
  },
  claude: (s) =>
    s.ANTHROPIC_API_KEY
      ? {
          host: 'api.anthropic.com',
          request: { method: 'GET', url: 'https://api.anthropic.com/v1/models', headers: { 'x-api-key': s.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', Accept: 'application/json' } },
          onOk: (j) => countOf(j?.data, 'model'),
        }
      : { notConfigured: 'needs ANTHROPIC_API_KEY' },
  // As ai-intern/worker.py list_cursor_models: basic auth, the key as user name, empty password.
  cursor: (s) =>
    s.CURSOR_API_KEY
      ? {
          host: 'api.cursor.com',
          request: { method: 'GET', url: 'https://api.cursor.com/v1/models', headers: { Authorization: basic(s.CURSOR_API_KEY, ''), Accept: 'application/json' } },
          onOk: (j) => countOf(j?.items || j?.models, 'model'),
        }
      : { notConfigured: 'needs CURSOR_API_KEY' },
  gemini: (s) =>
    s.GEMINI_API_KEY
      ? {
          host: 'generativelanguage.googleapis.com',
          request: { method: 'GET', url: 'https://generativelanguage.googleapis.com/v1beta/models', headers: { 'x-goog-api-key': s.GEMINI_API_KEY, Accept: 'application/json' } },
          onOk: (j) => countOf(j?.models, 'model'),
        }
      : { notConfigured: 'needs GEMINI_API_KEY' },
  openai: (s) =>
    s.OPENAI_API_KEY
      ? {
          host: 'api.openai.com',
          request: { method: 'GET', url: 'https://api.openai.com/v1/models', headers: { Authorization: `Bearer ${s.OPENAI_API_KEY}`, Accept: 'application/json' } },
          onOk: (j) => countOf(j?.data, 'model'),
        }
      : { notConfigured: 'needs OPENAI_API_KEY' },
  github: (s) =>
    s.GITHUB_TOKEN
      ? {
          host: 'api.github.com',
          request: {
            method: 'GET',
            url: 'https://api.github.com/user',
            headers: { Authorization: `Bearer ${s.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'jira-board-key-test' },
          },
          onOk: (j) => signedIn(str(j?.login)),
        }
      : { notConfigured: 'needs GITHUB_TOKEN' },
}

function onPrem(s, cfg, { token, tokenLabel, urlKey, endpoint, path, ok }) {
  if (!s[token]) return { notConfigured: `needs ${tokenLabel || token}` }
  const source = s[urlKey] || cfg?.endpoints?.[endpoint] || ''
  if (!source) return { notConfigured: `needs a base URL (${urlKey} or endpoints.${endpoint})` }
  const b = baseUrl(source)
  if (b.error) return { notConfigured: `base URL ${b.error}` }
  return { host: b.host, request: { method: 'GET', url: b.url + path, headers: { Authorization: `Bearer ${s[token]}`, Accept: 'application/json' } }, onOk: ok }
}

/** The first https job URL in config → jenkins.jobs (repo → env → URL), config order. */
function firstJenkinsJob(cfg) {
  for (const envs of Object.values(cfg?.jenkins?.jobs || {})) {
    for (const url of Object.values(envs || {})) {
      if (typeof url !== 'string') continue
      const v = url.trim()
      try {
        const u = new URL(v)
        if (u.protocol === 'https:' && !u.username && !u.password) return v
      } catch {
        /* not a URL — skip */
      }
    }
  }
  return null
}

/** jira-intern/checkmarx.py urls(): base from CHECKMARX_BASE_URL / CHECKMARX_URL / endpoints; token URL explicit or derived. */
function checkmarxUrls(s, cfg) {
  const strip = (v) => {
    const url = String(v || '').trim().replace(/\/+$/, '')
    return /^https:\/\/[^/\s]+/i.test(url) ? url : ''
  }
  const ep = cfg?.endpoints || {}
  const base = strip(s.CHECKMARX_BASE_URL || s.CHECKMARX_URL || ep.checkmarxBase)
  if (!base) return null
  let auth = strip(s.CHECKMARX_AUTH_URL || ep.checkmarxAuthUrl)
  if (!auth) {
    const tenant = (new URL(base).hostname || '').split('.')[0]
    if (!tenant) return null
    auth = `${base}/auth/realms/${encodeURIComponent(tenant)}/protocol/openid-connect/token`
  }
  try {
    new URL(auth)
  } catch {
    return null
  }
  return { base, auth }
}

function statusFor(code) {
  if (code === 401) return { status: 'auth-failed', detail: 'Key rejected' }
  if (code === 403) return { status: 'forbidden', detail: 'Key accepted but not allowed to read this' }
  if (code === 404) return { status: 'not-found', detail: 'Not found — check the base URL' }
  if (code === 429) return { status: 'error', detail: 'Rate limited — try again in a minute' }
  return { status: 'error', detail: `Unexpected HTTP ${code}` }
}

function redirectHost(headers) {
  const loc = headers?.location || headers?.Location
  try {
    return new URL(String(loc)).hostname || ''
  } catch {
    return ''
  }
}

/** Remove every saved secret value (and control characters) from a human string; cap it. */
function scrub(text, settings) {
  let out = String(text || '').replace(/[\x00-\x1f\x7f]/g, ' ')
  const secrets = Object.entries(settings)
    .filter(([k, v]) => /TOKEN|KEY|PAT|SECRET|PASSWORD/i.test(k) && typeof v === 'string' && v.length >= 4)
    .map(([, v]) => v)
  for (const v of secrets) out = out.split(v).join('•••')
  return out.slice(0, 160)
}

async function defaultReadCa(path) {
  return readFile(path, 'utf8')
}

/**
 * `loadSettings()` → merged values (setup/.env + environment); `config` the project config;
 * `request` the HTTP layer (defaults to httpRequest). `test(service)` resolves with the result,
 * `{ busy: true }` while that service's previous test is still running, or `{ unknown: true }`.
 */
export function createKeyChecker({ loadSettings, config, request = httpRequest, log = console.log, readCa = defaultReadCa, timeoutMs = TIMEOUT_MS, maxBytes = MAX_BYTES }) {
  const inFlight = new Set()

  async function tlsFor(service, s) {
    // Same opt-outs as the fetch: JIRA_INSECURE_TLS for the on-prem trio, JENKINS_INSECURE_TLS for Jenkins only.
    const insecure = (ON_PREM.has(service) && s.JIRA_INSECURE_TLS === '1') || (service === 'jenkins' && s.JENKINS_INSECURE_TLS === '1')
    const tls = { rejectUnauthorized: !insecure }
    const explicit = str(s.JIRA_CA_BUNDLE)
    const pem = await readCa(explicit || DEFAULT_CA_BUNDLE).catch(() => null)
    if (pem && pem.includes('BEGIN CERTIFICATE')) tls.ca = [...rootCertificates, pem]
    else if (explicit) return { error: 'JIRA_CA_BUNDLE could not be read as a PEM file' }
    return tls
  }

  async function run(service) {
    const s = await loadSettings()
    const started = Date.now()
    const done = (fields) => {
      const result = { ok: fields.status === 'ok', service, ...fields, ms: Date.now() - started }
      result.detail = scrub(result.detail, s)
      return result
    }
    const plan = PLANS[service](s, config || {})
    if (plan.notConfigured) return done({ status: 'not-configured', detail: plan.notConfigured })
    const tls = await tlsFor(service, s)
    if (tls.error) return done({ status: 'tls', detail: tls.error })
    let res
    try {
      res = await request({ ...plan.request, timeoutMs, maxBytes, tls })
    } catch (e) {
      return done(classifyError(e, plan.host))
    }
    const code = Number(res.status)
    if (code >= 300 && code < 400) {
      const host = redirectHost(res.headers)
      return done({ status: 'error', httpStatus: code, detail: host ? `Redirected to ${host}` : 'Redirected — not followed' })
    }
    const special = plan.onStatus?.(res)
    if (special) return done({ ...special, httpStatus: code })
    if (code >= 200 && code < 300) {
      const verdict = plan.onOk(parseJson(res))
      return done(typeof verdict === 'string' ? { status: 'ok', httpStatus: code, detail: verdict } : { ...verdict, httpStatus: code })
    }
    return done({ ...statusFor(code), httpStatus: code })
  }

  async function test(service) {
    if (typeof service !== 'string' || !Object.hasOwn(PLANS, service)) return { unknown: true }
    if (inFlight.has(service)) return { busy: true }
    inFlight.add(service)
    try {
      const result = await run(service)
      log(`[keys] test ${service} → ${result.status}`)
      return result
    } finally {
      inFlight.delete(service)
    }
  }

  return { test }
}
