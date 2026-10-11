// Per-service health files — jira-intern/.health/<serviceId>.json. The SAME files and shape the
// Python clients write (jira-intern/_health.py: read its header for the record and the rules).
//
// This side: reads every file for GET /api/keys/health, and writes one when the dialog's Test
// button finishes (source 'test'). One file per service; a writer touches only its own, replacing
// it atomically (temp file + rename), so Python and Node never corrupt each other's records.
// A record never carries a secret: `detail` is scrubbed of URL queries, auth values and key-like blobs.
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const HEALTH_DIR = process.env.JB_HEALTH_DIR || join(import.meta.dirname, '..', 'jira-intern', '.health')

const SERVICE_RE = /^[a-z][a-z0-9-]{0,31}$/
const STATUSES = ['auth-failed', 'forbidden', 'unreachable', 'tls', 'not-found', 'error']
const KEY_STATUSES = ['auth-failed', 'forbidden']
const SOURCES = ['fetch', 'worker', 'test']
const DETAIL_MAX = 160
export const THROTTLE_MS = 60_000

/** 'ok' (green) | 'key' (red: credentials rejected) | 'attention' (orange) | 'none'. Mirrors _health.tone_of. */
export function toneOf(rec) {
  if (!rec || typeof rec !== 'object') return 'none'
  if (rec.state === 'ok') return 'ok'
  if (rec.state === 'attention') return KEY_STATUSES.includes(rec.status) ? 'key' : 'attention'
  return 'none'
}

/** One line, no control characters, no URL query, no auth values, no long opaque blobs; ≤ 160 chars. */
export function scrubDetail(text) {
  let out = String(text ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ')
  out = out.replace(/\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{6,}/gi, '$1 •••')
  out = out.replace(/(authorization|x-api-key|api[_-]?key|token|secret|password)\s*[:=]\s*\S+/gi, '$1 •••')
  out = out.replace(/(\bhttps?:\/\/[^\s?#]+)[?#]\S*/g, '$1')
  out = out.replace(/(?<![A-Za-z0-9])[A-Za-z0-9+/=_-]{32,}(?![A-Za-z0-9])/g, '•••')
  out = out.replace(/\?\S*/g, '')
  return out.replace(/\s+/g, ' ').trim().slice(0, DETAIL_MAX)
}

function valid(rec) {
  return rec && typeof rec === 'object' && (rec.state === 'ok' || rec.state === 'attention')
}

export async function readHealth(dir, service) {
  if (!dir || !SERVICE_RE.test(String(service))) return null
  try {
    const rec = JSON.parse(await readFile(join(dir, `${service}.json`), 'utf8'))
    return valid(rec) ? rec : null
  } catch {
    return null
  }
}

/** { serviceId: record } for every readable file; a missing folder or a corrupt file is just absent. */
export async function readAllHealth(dir = HEALTH_DIR) {
  const out = {}
  let names = []
  try {
    names = await readdir(dir)
  } catch {
    return out
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const rec = await readHealth(dir, name.slice(0, -5))
    if (rec) out[name.slice(0, -5)] = rec
  }
  return out
}

const stamp = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z')

/**
 * Record one outcome: { ok, status?, httpStatus?, detail?, source? }. Returns the record written, or
 * null (throttled, bad id, or any error — never throws). A 'test' outcome is never throttled: the
 * user just pressed the button and wants to see it land.
 */
export async function writeHealth(dir, service, outcome, now = new Date()) {
  try {
    if (!dir || !SERVICE_RE.test(String(service))) return null
    const ok = !!outcome?.ok
    const source = SOURCES.includes(outcome?.source) ? outcome.source : 'fetch'
    const state = ok ? 'ok' : 'attention'
    const status = ok ? undefined : STATUSES.includes(outcome?.status) ? outcome.status : 'error'
    const prior = await readHealth(dir, service)
    if (source !== 'test' && prior && prior.state === state && prior.status === status) {
      const age = now.getTime() - Date.parse(prior.checkedAt)
      if (age >= 0 && age < THROTTLE_MS) return null
    }
    const at = stamp(now)
    const rec = { service, state, checkedAt: at }
    if (ok) rec.lastOkAt = at
    else {
      if (prior?.lastOkAt) rec.lastOkAt = prior.lastOkAt
      rec.failingSince = prior?.state === 'attention' && prior.failingSince ? prior.failingSince : at
      rec.status = status
      if (Number.isInteger(outcome?.httpStatus)) rec.httpStatus = outcome.httpStatus
    }
    rec.detail = scrubDetail(outcome?.detail)
    rec.source = source
    await mkdir(dir, { recursive: true })
    const tmp = join(dir, `.${service}.${process.pid}.${Date.now()}.tmp`)
    try {
      await writeFile(tmp, JSON.stringify(rec, null, 2) + '\n', { mode: 0o644 })
      await rename(tmp, join(dir, `${service}.json`))
    } catch (e) {
      await unlink(tmp).catch(() => {})
      throw e
    }
    return rec
  } catch {
    return null
  }
}
