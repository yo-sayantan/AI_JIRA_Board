// The board's API keys, as the UI sees them. The list (services, their keys, why each is needed)
// is setup/api-keys.json — the same file the server validates names against. Values live in
// setup/.env and only ever reach the browser masked (server/secrets.mjs).
import registry from '../../setup/api-keys.json'

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
