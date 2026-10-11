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

export interface ApiService {
  id: string
  name: string
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
