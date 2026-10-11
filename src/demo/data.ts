// Loads the Demo-mode sample board from `jira-intern/demo/data.json`.
//
// That folder is the source of truth — it sits beside the real dump so the sample tickets can be
// read, and edited, by hand (see its README). This module only does two things: compile a copy
// into the bundle so Demo mode also works from `file://`, and re-date it on load.
//
// Re-dating: the file stores real timestamps anchored to `_demoNow`. Every date is shifted by the
// gap between that anchor and the current time, so the sample board always looks as if it were
// fetched minutes ago — the active sprint is still active, Next Sprint still has not started, and
// the Done card that "archives in 1d" still does.
import type { JiraData } from '../types'
import bundled from '../../jira-intern/demo/data.json'

const DAY = 86_400_000
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
const dayOf = (ms: number) => iso(ms).slice(0, 10)

// Full timestamps shift by the exact gap; bare YYYY-MM-DD values (update logs, the dates inside a
// sprint label) shift by whole days, so a day label never lands mid-day. That covers every Dynatrace stamp too
// (`dynatrace.fetchedAt`, each item's `fetchedAt` and `window`, a problem's start / end, `proofNotes.dynatrace.at`,
// `proofSources.dynatrace.at`); the times written INSIDE a Dynatrace link's URL are text and stay as they are.
const STAMP = /"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)"/g
const DATE = /\d{4}-\d{2}-\d{2}(?!T)/g

/** Re-date a raw demo dump onto `now`, and drop the file's own metadata keys. */
export function rebaseDemoDump(raw: unknown, now: number): JiraData {
  const anchor = Date.parse((raw as { _demoNow?: string } | null)?._demoNow ?? '')
  let text = JSON.stringify(raw)
  if (!Number.isNaN(anchor)) {
    const shift = now - anchor
    const dayShift = Math.round(shift / DAY) * DAY
    text = text
      .replace(STAMP, (_m, d: string) => `"${iso(Date.parse(d) + shift)}"`)
      .replace(DATE, (d) => dayOf(Date.parse(`${d}T00:00:00Z`) + dayShift))
  }
  const out = JSON.parse(text) as JiraData & { _readme?: unknown; _demoNow?: unknown }
  delete out._readme
  delete out._demoNow
  return out
}

/** The copy compiled into the bundle. Always available — no server, no network. */
export function bundledDemoDump(now: number = Date.now()): JiraData {
  return rebaseDemoDump(bundled, now)
}

/**
 * The copy on disk, so edits to `jira-intern/demo/data.json` show up on a reload without a
 * rebuild. Served mode only; null when it cannot be read (then the bundled copy stands).
 */
export async function fetchDemoDump(): Promise<JiraData | null> {
  try {
    const r = await fetch('/jira-intern/demo/data.json', { cache: 'no-cache' })
    if (!r.ok) return null
    const raw: unknown = await r.json()
    if (!Array.isArray((raw as JiraData | null)?.tickets)) return null
    return rebaseDemoDump(raw, Date.now())
  } catch {
    return null
  }
}
