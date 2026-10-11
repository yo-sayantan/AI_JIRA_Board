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
//     JENKINS_INSECURE_TLS=1 for Jenkins only; DYNATRACE_INSECURE_TLS=1 for Dynatrace only
//     (the same switches the fetch honours — one never relaxes another)
//   • Dynatrace sends one probe per configured tenant, and only to https://<tenant id>.apps.dynatrace.com:
//     the host is built from a validated id (lowercase letters, digits, -), never from a string the
//     user typed whole or anything a response says; a poll URL is rebuilt from that id too
//   • the result's detail is built from safe identity fields only (display name, login, a count),
//     and any saved secret is scrubbed from it; logs carry the service and the status, nothing else
// The HTTP layer is injected (`request`) so tests never touch the network.
import { readFile } from 'node:fs/promises'
import { request as httpRequestRaw } from 'node:http'
import { request as httpsRequestRaw } from 'node:https'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { rootCertificates } from 'node:tls'

export const KEY_TEST_SERVICES = ['jira', 'confluence', 'bitbucket', 'atlassian', 'jenkins', 'checkmarx', 'dynatrace', 'claude', 'cursor', 'gemini', 'openai', 'github']

const TIMEOUT_MS = 10_000
const MAX_BYTES = 256 * 1024
const DEFAULT_CA_BUNDLE = join(homedir(), '.ai', 'ca-bundle.pem')
/** The on-prem hosts JIRA_INSECURE_TLS may relax — the same set _jira.py's ssl_context serves. */
const ON_PREM = new Set(['jira', 'confluence', 'bitbucket'])
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])
/** Same client id jira-intern/checkmarx.py uses for the refresh-token exchange. */
const CHECKMARX_CLIENT_ID = 'ast-app'
/** A Dynatrace tenant id: the first label of <id>.apps.dynatrace.com — no dots, slashes, ports or userinfo. */
const TENANT_ID_RE = /^[a-z0-9][a-z0-9-]{1,62}$/
/** The label a user gives a tenant ("prod", "uat"): it is only ever shown, never put in a URL. */
const TENANT_LABEL_RE = /^[a-z0-9][a-z0-9_.-]{0,31}$/
const MAX_TENANTS = 8
/** Dynatrace's query API answers 202 while a query runs; poll at most this many times. */
const DYNATRACE_MAX_POLLS = 3
const DYNATRACE_QUERY_MS = 8000
const DYNATRACE_WINDOW_MS = 7 * 24 * 3600 * 1000

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
    // The token is checked against YOUR Cloud site; id.atlassian.com (where tokens are made) answers 403.
    if (!/\.(atlassian\.net|jira\.com)$/i.test(b.host))
      return { notConfigured: `site URL must be your Cloud site, e.g. https://your-org.atlassian.net (not ${b.host})` }
    return {
      host: b.host,
      // Scoped API tokens are rejected on the site URL and only work through Atlassian's gateway.
      gateway: { tenantInfo: `${b.url}/_edge/tenant_info`, myself: (cloudId) => `https://api.atlassian.com/ex/jira/${encodeURIComponent(cloudId)}/rest/api/3/myself` },
      hints: {
        401: 'Key rejected — use the email of your Atlassian account (not a directory address), and a token that is still valid',
        403: 'Access denied — check the email is the one the token belongs to, and that the site is your-org.atlassian.net',
      },
      request: { method: 'GET', url: `${b.url}/rest/api/3/myself`, headers: { Authorization: basic(s.ATLASSIAN_EMAIL, s.ATLASSIAN_TOKEN), Accept: 'application/json' } },
      onOk: (j) => signedIn(str(j?.displayName)),
    }
  },
  jenkins: (s, cfg) => {
    if (!s.JENKINS_USER || !s.JENKINS_API_TOKEN) return { notConfigured: 'needs JENKINS_USER + JENKINS_API_TOKEN' }
    // Projects folder saved (JENKINS_ROOT_URL, else config jenkins.root) → read it and count the folders in it —
    // the walk discovery does starts there. Else JENKINS_URL → "who am I"; else the first configured job.
    const root = str(s.JENKINS_ROOT_URL) || str(cfg?.jenkins?.root)
    if (root) {
      const b = baseUrl(root)
      if (b.error) return { notConfigured: `Projects folder ${b.error}` }
      return {
        host: b.host,
        request: { method: 'GET', url: `${b.url}/api/json?tree=name,jobs[name,_class]`, headers: { Authorization: basic(s.JENKINS_USER, s.JENKINS_API_TOKEN), Accept: 'application/json' } },
        onOk: (j) => {
          const jobs = Array.isArray(j?.jobs) ? j.jobs : []
          const folders = jobs.filter((x) => /folder/i.test(String(x?._class || ''))).length
          if (folders) return `Root readable · ${folders} folder${folders === 1 ? '' : 's'}`
          return jobs.length ? `Root readable · ${jobs.length} item${jobs.length === 1 ? '' : 's'}` : 'Root readable'
        },
      }
    }
    if (s.JENKINS_URL) {
      const b = baseUrl(s.JENKINS_URL)
      if (b.error) return { notConfigured: `Jenkins URL ${b.error}` }
      return {
        host: b.host,
        request: { method: 'GET', url: `${b.url}/me/api/json`, headers: { Authorization: basic(s.JENKINS_USER, s.JENKINS_API_TOKEN), Accept: 'application/json' } },
        onOk: (j) => signedIn(str(j?.fullName) || str(j?.id)),
      }
    }
    const job = firstJenkinsJob(cfg)
    if (!job) return { notConfigured: 'add the projects folder or Jenkins URL above (or a job link in jenkins.jobs)' }
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
  // One read-only query per configured tenant; the verdicts are merged in run() (runDynatrace).
  dynatrace: (s, cfg) => {
    if (!s.DYNATRACE_PAT) return { notConfigured: 'needs DYNATRACE_PAT' }
    const parsed = dynatraceTenants(s, cfg)
    if (parsed.error) return { notConfigured: parsed.error }
    return { probes: parsed.tenants.map(({ env, id }) => dynatraceProbe(env, id, s.DYNATRACE_PAT)) }
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

/**
 * The tenants to probe: DYNATRACE_TENANTS (setup/.env or the environment) — a JSON object
 * {"prod":"abc12345"} or the shorthand "prod=abc12345,uat=def67890" — else the config's
 * endpoints.dynatraceTenants ({env: id}, blank ids ignored). → { tenants: [{ env, id }] } or { error }.
 * Every id must be a bare tenant id (see TENANT_ID_RE); one that is not is refused, naming its label.
 */
function dynatraceTenants(s, cfg) {
  const hint = 'needs DYNATRACE_TENANTS (e.g. prod=abc12345) or endpoints.dynatraceTenants'
  const raw = str(s.DYNATRACE_TENANTS)
  let entries = []
  if (raw) {
    if (raw.startsWith('{')) {
      let obj
      try {
        obj = JSON.parse(raw)
      } catch {
        return { error: 'DYNATRACE_TENANTS is not valid JSON — use prod=abc12345,uat=def67890' }
      }
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { error: 'DYNATRACE_TENANTS must map environment names to tenant ids' }
      entries = Object.entries(obj)
    } else {
      for (const part of raw.split(',')) {
        if (!part.trim()) continue
        const at = part.indexOf('=')
        if (at < 1) return { error: 'DYNATRACE_TENANTS needs env=tenantid pairs, e.g. prod=abc12345,uat=def67890' }
        entries.push([part.slice(0, at), part.slice(at + 1)])
      }
    }
  } else {
    const fromConfig = cfg?.endpoints?.dynatraceTenants
    if (fromConfig && typeof fromConfig === 'object' && !Array.isArray(fromConfig)) entries = Object.entries(fromConfig)
    // The tracked config ships empty placeholders ({"prod": "", ...}): blank means not set.
    entries = entries.filter(([, id]) => str(id) !== '')
  }
  const tenants = new Map()
  for (const [rawLabel, rawId] of entries) {
    const env = String(rawLabel).trim().toLowerCase()
    if (!TENANT_LABEL_RE.test(env)) return { error: `environment name #${tenants.size + 1} must be letters, digits, - _ . (e.g. prod)` }
    const id = typeof rawId === 'string' ? rawId.trim().toLowerCase() : ''
    if (!TENANT_ID_RE.test(id)) return { error: `tenant id for ${env} must be just the id from your Dynatrace address (letters, digits, -) — no dots or slashes` }
    tenants.set(env, id)
  }
  if (!tenants.size) return { error: hint }
  if (tenants.size > MAX_TENANTS) return { error: `at most ${MAX_TENANTS} Dynatrace tenants` }
  return { tenants: [...tenants].map(([env, id]) => ({ env, id })) }
}

/** The two requests one tenant's probe may send. Every URL is built from the validated id and nothing else. */
function dynatraceProbe(env, id, pat) {
  const host = `${id}.apps.dynatrace.com`
  const base = `https://${host}/platform/storage/query/v1`
  const headers = { Authorization: `Bearer ${pat}`, Accept: 'application/json' }
  return {
    env,
    host,
    execute: (nowMs) => ({
      method: 'POST',
      url: `${base}/query:execute`,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'fetch dt.davis.problems | limit 1',
        defaultTimeframeStart: isoSeconds(nowMs - DYNATRACE_WINDOW_MS),
        defaultTimeframeEnd: isoSeconds(nowMs),
        maxResultRecords: 1,
        requestTimeoutMilliseconds: DYNATRACE_QUERY_MS,
      }),
    }),
    poll: (requestToken) => ({
      method: 'GET',
      url: `${base}/query:poll?request-token=${encodeURIComponent(requestToken)}&request-timeout-milliseconds=${DYNATRACE_QUERY_MS}`,
      headers,
    }),
  }
}

const isoSeconds = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

/**
 * One Dynatrace response → { running, token } while the query runs, { ok: true } when it finished, else
 * { status, httpStatus?, detail } for a failure. Detail is fixed text — nothing the server said is echoed.
 */
function dynatraceVerdict(res) {
  const code = Number(res.status)
  if (code >= 300 && code < 400) {
    const host = redirectHost(res.headers)
    return { status: 'error', httpStatus: code, detail: host ? `redirected to ${host}` : 'redirected — not followed' }
  }
  if (code >= 200 && code < 300) {
    const json = parseJson(res)
    const state = str(json?.state).toUpperCase()
    if (state === 'FAILED' || state === 'CANCELLED' || state === 'RESULT_GONE') return { status: 'error', detail: 'query failed' }
    if (code === 202 || state === 'RUNNING' || state === 'NOT_STARTED') {
      const token = str(json?.requestToken)
      return { running: true, token: token.length <= 4096 ? token : '' }
    }
    return { ok: true }
  }
  if (code === 401) return { status: 'auth-failed', httpStatus: 401, detail: 'token rejected' }
  if (code === 403) return { status: 'forbidden', httpStatus: 403, detail: 'token accepted but lacks a scope (storage:events:read)' }
  if (code === 404) return { status: 'not-found', httpStatus: 404, detail: 'not found — check the tenant id' }
  if (code === 429) return { status: 'error', httpStatus: 429, detail: 'rate limited — try again in a minute' }
  return { status: 'error', httpStatus: code, detail: `unexpected HTTP ${code}` }
}

/** Which failure to report when tenants disagree: a rejected key first, then the network, then the rest. */
const WORST_FIRST = ['auth-failed', 'forbidden', 'tls', 'unreachable', 'not-found', 'error']

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
 * `recordHealth(service, { ok, status, httpStatus, detail })` (optional) is told how each finished test
 * went — except 'not-configured', which made no call — so the dialog's dots follow Test as well as real calls.
 */
export function createKeyChecker({ loadSettings, config, request = httpRequest, log = console.log, readCa = defaultReadCa, timeoutMs = TIMEOUT_MS, maxBytes = MAX_BYTES, recordHealth, now = Date.now }) {
  const inFlight = new Set()

  async function tlsFor(service, s) {
    // Same opt-outs as the fetch: JIRA_INSECURE_TLS for the on-prem trio, and one of its own for Jenkins and for Dynatrace.
    const insecure =
      (ON_PREM.has(service) && s.JIRA_INSECURE_TLS === '1') ||
      (service === 'jenkins' && s.JENKINS_INSECURE_TLS === '1') ||
      (service === 'dynatrace' && s.DYNATRACE_INSECURE_TLS === '1')
    const tls = { rejectUnauthorized: !insecure }
    const explicit = str(s.JIRA_CA_BUNDLE)
    const pem = await readCa(explicit || DEFAULT_CA_BUNDLE).catch(() => null)
    if (pem && pem.includes('BEGIN CERTIFICATE')) tls.ca = [...rootCertificates, pem]
    else if (explicit) return { error: 'JIRA_CA_BUNDLE could not be read as a PEM file' }
    return tls
  }

  /** Retry an Atlassian "who am I" through the gateway; the display name on success, else null. */
  async function tryGateway(plan, tls) {
    try {
      const info = await request({ method: 'GET', url: plan.gateway.tenantInfo, headers: { Accept: 'application/json' }, timeoutMs, maxBytes, tls })
      const cloudId = Number(info.status) === 200 ? str(parseJson(info)?.cloudId) : ''
      if (!cloudId || !/^[\w-]{8,64}$/.test(cloudId)) return null
      const res = await request({ ...plan.request, url: plan.gateway.myself(cloudId), timeoutMs, maxBytes, tls })
      if (Number(res.status) < 200 || Number(res.status) >= 300) return null
      return plan.onOk(parseJson(res))
    } catch {
      return null
    }
  }

  /** One tenant: execute, then poll while Dynatrace says RUNNING. → { env, ok, running?, status?, httpStatus?, detail? }. */
  async function probeTenant(probe, tls, startedMs) {
    const send = async (req) => {
      try {
        return { res: await request({ ...req, timeoutMs, maxBytes, tls }) }
      } catch (e) {
        return { failure: classifyError(e, probe.host) }
      }
    }
    let sent = await send(probe.execute(startedMs))
    for (let polls = 0; ; polls++) {
      if (sent.failure) return { env: probe.env, ...sent.failure }
      const verdict = dynatraceVerdict(sent.res)
      if (verdict.ok) return { env: probe.env, ok: true }
      if (!verdict.running) return { env: probe.env, ...verdict }
      // Still running: ask again, up to DYNATRACE_MAX_POLLS times. Without a token there is nothing to poll with.
      if (!verdict.token || polls >= DYNATRACE_MAX_POLLS) return { env: probe.env, ok: true, running: true }
      sent = await send(probe.poll(verdict.token))
    }
  }

  /** Every tenant at once → one result: all fine, or the worst failure with each failing tenant named. */
  async function runDynatrace(plan, tls) {
    const startedMs = Number(now())
    const results = await Promise.all(plan.probes.map((probe) => probeTenant(probe, tls, startedMs)))
    const failed = results.filter((r) => !r.ok)
    if (!failed.length) {
      const n = results.length
      const note = results.some((r) => r.running) ? ' · token accepted — query still running' : ''
      return { status: 'ok', httpStatus: 200, detail: `${n} tenant${n === 1 ? '' : 's'}${note}` }
    }
    const rank = (r) => {
      const i = WORST_FIRST.indexOf(r.status)
      return i < 0 ? WORST_FIRST.length : i
    }
    const worst = failed.reduce((a, b) => (rank(b) < rank(a) ? b : a))
    const detail = results.map((r) => `${r.env}: ${r.ok ? (r.running ? 'OK, query still running' : 'OK') : r.detail}`).join(' · ')
    return { status: worst.status, ...(worst.httpStatus ? { httpStatus: worst.httpStatus } : {}), detail }
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
    if (plan.probes) return done(await runDynatrace(plan, tls))
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
    // 401 on the site: a scoped token (ATATT…) works only via api.atlassian.com/ex/jira/<cloudId>. The cloud
    // id is public (anonymous tenant_info), so look it up and retry the same call there before giving up.
    if (code === 401 && plan.gateway) {
      const viaGateway = await tryGateway(plan, tls)
      if (viaGateway) return done({ status: 'ok', httpStatus: 200, detail: `${viaGateway} · scoped token, via api.atlassian.com` })
      const mapped401 = statusFor(401)
      mapped401.detail = `${plan.hints?.[401] ?? mapped401.detail} · also tried the scoped-token gateway`
      return done({ ...mapped401, httpStatus: 401 })
    }
    const mapped = statusFor(code)
    // A probe may explain a refusal better than the generic text (e.g. Atlassian's usual 403 causes).
    if (plan.hints?.[code]) mapped.detail = plan.hints[code]
    return done({ ...mapped, httpStatus: code })
  }

  async function test(service) {
    if (typeof service !== 'string' || !Object.hasOwn(PLANS, service)) return { unknown: true }
    if (inFlight.has(service)) return { busy: true }
    inFlight.add(service)
    try {
      const result = await run(service)
      log(`[keys] test ${service} → ${result.status}`)
      if (recordHealth && result.status !== 'not-configured') {
        try {
          await recordHealth(service, { ok: result.ok, status: result.status, httpStatus: result.httpStatus, detail: result.detail })
        } catch {
          /* the dots are a convenience; a test result is still returned */
        }
      }
      return result
    } finally {
      inFlight.delete(service)
    }
  }

  return { test }
}
