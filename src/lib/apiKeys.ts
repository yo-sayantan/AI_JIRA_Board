// The board's API keys, as the UI sees them. The list (services, their keys, why each is needed)
// is setup/api-keys.json — the same file the server validates names against. Values live in
// setup/.env and only ever reach the browser masked (server/secrets.mjs).
import registry from '../../setup/api-keys.json'
import { dtf, relTime } from './format'

/** secret: masked except its first and last characters (the default). url / email / text: shown in full. */
export type KeyKind = 'secret' | 'url' | 'email' | 'text'

export interface ApiKeyField {
  env: string
  label: string
  kind?: KeyKind
  optional?: boolean
  /** Can be saved now; the integration that reads it comes later. */
  planned?: boolean
  hint?: string
}

export const kindOf = (field: ApiKeyField): KeyKind => field.kind ?? 'secret'

export interface ApiGroup {
  id: string
  name: string
}

export interface ApiService {
  id: string
  name: string
  /** One of `groups[].id` — the dialog shows services clustered by group. */
  group: string
  /** The full explanation, shown when the row is opened (`why` is the one-line summary). */
  details: string
  color: string
  required: boolean
  why: string
  usedBy: string[]
  getIt: string
  keys: ApiKeyField[]
}

/** Per env name: is it set, and how the server shows it (masked secret, or the URL itself). */
export type KeyStatus = Record<string, { set: boolean; masked: string }>

export const API_SERVICES: ApiService[] = registry.services as ApiService[]
export const API_GROUPS: ApiGroup[] = registry.groups

/** Groups in registry order (empty ones dropped), services alphabetical by name inside each. */
export function groupedServices(): { group: ApiGroup; services: ApiService[] }[] {
  return API_GROUPS.map((group) => ({
    group,
    services: API_SERVICES.filter((s) => s.group === group.id).sort((a, b) => a.name.localeCompare(b.name)),
  })).filter((g) => g.services.length > 0)
}

/** The bullet run server/secrets.mjs puts in a mask. A value containing it is a mask, not a key. */
const MASK_BULLET = '•'

/** Lit when every non-optional key of the service is set. */
export function serviceReady(service: ApiService, status: KeyStatus | null): boolean {
  if (!status) return false
  return service.keys.filter((k) => !k.optional).every((k) => status[k.env]?.set)
}

/** Every key of the service is planned: nothing reads it yet. */
export function servicePlanned(service: ApiService): boolean {
  return service.keys.every((k) => k.planned)
}

/** Required services still missing a key. Empty until the status has loaded (no false alarm). */
export function missingRequired(status: KeyStatus | null): ApiService[] {
  if (!status) return []
  return API_SERVICES.filter((s) => s.required && !serviceReady(s, status))
}

export function keyCounts(status: KeyStatus | null): { ready: number; total: number } {
  return { ready: API_SERVICES.filter((s) => serviceReady(s, status)).length, total: API_SERVICES.length }
}

/**
 * Save is offered only for a real change. A secret's box starts empty (its mask is only the
 * placeholder), so anything typed is new; a URL's box holds the URL, so it must differ. A value
 * with mask bullets in it is never a key.
 */
export function canSave(draft: string, saved: { set: boolean; masked: string } | undefined, secret: boolean): boolean {
  const value = draft.trim()
  if (!value || value.includes(MASK_BULLET)) return false
  return secret || value !== (saved?.masked ?? '')
}

// ── The Test button (POST /api/keys/test, server/keycheck.mjs) ──────────────────────────────────

export type KeyTestStatus = 'ok' | 'auth-failed' | 'forbidden' | 'not-found' | 'unreachable' | 'tls' | 'not-configured' | 'error'

/** What the server answers for one test. `detail` is human text with no secret in it. */
export interface KeyTestResult {
  ok: boolean
  service: string
  status: KeyTestStatus
  httpStatus?: number
  ms: number
  detail: string
}

/** A key that can stand in for another when testing: Bitbucket falls back to the Atlassian token. */
const TEST_ALTERNATIVES: Record<string, string> = { BITBUCKET_PAT: 'ATLASSIAN_TOKEN' }

/**
 * Why Test is not offered yet, or null when it is. Every non-optional key must be saved — except
 * URL keys, which the config's endpoints can supply (the server says so if neither is there).
 * Planned keys count like any other, so a planned-only service is testable once its key is saved.
 */
export function testBlocker(service: ApiService, status: KeyStatus | null): string | null {
  if (!status) return 'Loading the saved keys…'
  const missing = service.keys.filter((k) => {
    if (k.optional || kindOf(k) === 'url') return false
    const alt = TEST_ALTERNATIVES[k.env]
    return !status[k.env]?.set && !(alt && status[alt]?.set)
  })
  return missing.length ? `Save ${missing.map((k) => k.label).join(' and ')} first` : null
}

export type TestTone = 'ok' | 'bad' | 'warn' | 'idle'
export const TEST_TONE_COLOR: Record<TestTone, string> = { ok: '#17c47a', bad: '#e11d48', warn: '#ff9f1c', idle: '#8b94a8' }

/** A test result → the inline pill: tone, short text, and the full detail for its tooltip. */
export function testResultView(r: KeyTestResult): { tone: TestTone; text: string; title: string } {
  const code = r.httpStatus ? ` (${r.httpStatus})` : ''
  const title = [r.detail, r.ms ? `${r.ms} ms` : ''].filter(Boolean).join(' · ')
  switch (r.status) {
    case 'ok':
      return { tone: 'ok', text: ['✓ Connected', r.detail, `${r.ms} ms`].filter(Boolean).join(' · '), title }
    case 'auth-failed':
      return { tone: 'bad', text: `✗ Key rejected${code}`, title }
    case 'forbidden':
      return { tone: 'bad', text: `✗ Access denied${code}`, title }
    case 'not-found':
      return { tone: 'bad', text: `✗ Not found${code} — check the URL`, title }
    case 'unreachable':
      return { tone: 'warn', text: "Can't reach host", title }
    case 'tls':
      return { tone: 'warn', text: 'Certificate not trusted', title }
    case 'not-configured':
      return { tone: 'idle', text: `Not configured: ${r.detail}`, title }
    default:
      return { tone: 'bad', text: `✗ ${r.detail || 'Test failed'}`, title }
  }
}

// ── Health: the permanent dot per service (GET /api/keys/health) ────────────────────────────────
//
// The latest REAL outcome of each service's calls, whoever made them (the fetch, the AI worker, the
// Test button): jira-intern/.health/<id>.json, written by jira-intern/_health.py and
// server/health.mjs. No secret is ever in a record.

export type HealthStatus = 'auth-failed' | 'forbidden' | 'unreachable' | 'tls' | 'not-found' | 'error'

export interface HealthRecord {
  service: string
  state: 'ok' | 'attention'
  /** ISO, UTC (…Z). */
  checkedAt: string
  lastOkAt?: string
  failingSince?: string
  status?: HealthStatus
  httpStatus?: number
  detail: string
  source: 'fetch' | 'worker' | 'test'
}

export type HealthMap = Record<string, HealthRecord>

/** green working · red the KEY is the problem · orange needs attention (URL, network, server) · none never called. */
export type HealthTone = 'ok' | 'key' | 'attention' | 'none'

export const HEALTH_COLOR = { ok: '#17c47a', key: '#e11d48', attention: '#ff8a1f' } as const

/** ONE mapping, mirrored by `_health.tone_of` (Python) and `toneOf` (server/health.mjs): both tests pin it. */
export function healthTone(rec: HealthRecord | null | undefined): HealthTone {
  if (!rec) return 'none'
  if (rec.state === 'ok') return 'ok'
  if (rec.state === 'attention') return rec.status === 'auth-failed' || rec.status === 'forbidden' ? 'key' : 'attention'
  return 'none'
}

/** "09:14" for today, "Jan 3, 09:14" for another day — in the board's configured zone. */
function sinceText(iso: string, now: number): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const sameDay = dtf('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(d) === dtf('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now))
  const time = dtf('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }).format(d)
  return sameDay ? time : `${dtf('en-US', { month: 'short', day: 'numeric' }).format(d)}, ${time}`
}

function failureLabel(rec: HealthRecord): string {
  const code = rec.httpStatus ? ` (${rec.httpStatus})` : ''
  switch (rec.status) {
    case 'auth-failed':
      return `Key rejected${code}`
    case 'forbidden':
      return `Access denied${code}`
    case 'unreachable':
      return "Can't reach host"
    case 'tls':
      return 'Certificate not trusted'
    case 'not-found':
      return `Not found${code} — check the base URL`
    default:
      return rec.httpStatus ? `Server error (${rec.httpStatus})` : 'Request failed'
  }
}

export interface HealthView {
  tone: HealthTone
  /** Short, for the panel line. */
  label: string
  /** Longer, for tooltips and screen readers. */
  detail: string
  /** The dot colour, or null when there is nothing to show (reserve the space, draw no dot). */
  color: string | null
}

/** A health record → how the dialog words and colours it. `now` is injected (tests, stable renders). */
export function healthView(rec: HealthRecord | null | undefined, now: number = Date.now()): HealthView {
  const tone = healthTone(rec)
  if (!rec || tone === 'none') return { tone: 'none', label: 'Not called yet', detail: 'Not called yet — no request has been made with this key', color: null }
  if (tone === 'ok') {
    const when = relTime(rec.lastOkAt ?? rec.checkedAt, now)
    return { tone, label: 'Working', detail: when ? `Working · last OK ${when}` : 'Working', color: HEALTH_COLOR.ok }
  }
  const label = failureLabel(rec)
  const since = rec.failingSince ? sinceText(rec.failingSince, now) : ''
  const lastOk = rec.lastOkAt ? relTime(rec.lastOkAt, now) : ''
  const core = tone === 'key' ? label : `Needs attention · ${label.charAt(0).toLowerCase()}${label.slice(1)}`
  const detail = [since ? `${core} since ${since}` : core, lastOk ? `last OK ${lastOk}` : ''].filter(Boolean).join(' · ')
  return { tone, label, detail, color: HEALTH_COLOR[tone] }
}

/**
 * A Test the user just ran → the same record shape, so it shows at once (the server records it too,
 * a moment later). 'not-configured' made no call, so it is nothing.
 */
export function recordFromTest(r: KeyTestResult, at: number = Date.now()): HealthRecord | null {
  if (r.status === 'not-configured') return null
  const iso = new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z')
  if (r.status === 'ok') return { service: r.service, state: 'ok', checkedAt: iso, lastOkAt: iso, detail: '', source: 'test' }
  return { service: r.service, state: 'attention', checkedAt: iso, failingSince: iso, status: r.status as HealthStatus, httpStatus: r.httpStatus, detail: '', source: 'test' }
}

/** The newer of two records for one service (the server's, and this session's Test). */
export function latestHealth(server: HealthRecord | undefined, test: HealthRecord | null | undefined): HealthRecord | undefined {
  if (!test) return server
  if (!server) return test
  return Date.parse(test.checkedAt) >= Date.parse(server.checkedAt) ? test : server
}

/**
 * The records worth showing: only services whose keys are saved (a stale record of a removed key
 * would mislead), and nothing before the saved-key status has loaded. Demo mode shows its constant
 * sample whatever is saved.
 */
export function visibleHealth(health: HealthMap, status: KeyStatus | null, demo: boolean): HealthMap {
  if (demo) return health
  if (!status) return {}
  const out: HealthMap = {}
  for (const service of API_SERVICES) {
    const rec = health[service.id]
    if (rec && testBlocker(service, status) === null) out[service.id] = rec
  }
  return out
}

/** The header key button's dot: red when any key is rejected, else orange when any needs attention. */
export function keysBadge(health: HealthMap): { key: number; attention: number; color: string; label: string } | null {
  let key = 0
  let attention = 0
  for (const rec of Object.values(health)) {
    const tone = healthTone(rec)
    if (tone === 'key') key++
    else if (tone === 'attention') attention++
  }
  if (!key && !attention) return null
  const parts = [
    key ? `${key} ${key === 1 ? 'key' : 'keys'} rejected` : '',
    attention ? `${attention} ${attention === 1 ? 'needs' : 'need'} attention` : '',
  ].filter(Boolean)
  return { key, attention, color: key ? HEALTH_COLOR.key : HEALTH_COLOR.attention, label: parts.join(', ') }
}
