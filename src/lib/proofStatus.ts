// Pure helpers for the visible status of the proof sources (Checkmarx, Dynatrace; Jenkins next): what a ticket says
// when it has no fresh answer, what a scan's read looked like, and the API keys window's "Last fetch" line.
// The data comes from jira-intern/_sources.py via daily_fetch (src/types.ts: SourceStatus, ProofNote, VulnScanRead).
import type { ProofNote, SourceState, SourceStatus, VulnFixes, VulnScanRead } from '../types'
import { HEALTH_COLOR } from './apiKeys'
import { relTime } from './format'

/** Services whose API keys panel carries a "Last fetch" line (`data.proofSources[id]`). Jenkins joins here. */
export const PROOF_SOURCES: readonly string[] = ['checkmarx', 'dynatrace']

const NOTE_STATES: readonly string[] = ['not-configured', 'unreachable', 'auth-failed', 'budget-exhausted']
const SOURCE_STATES: readonly string[] = ['not-configured', 'no-candidates', 'read', 'unreachable', 'auth-failed', 'budget-exhausted']

/** `ticket.proofNotes[source]` when well formed — the reason a candidate ticket has no fresh answer — else null. */
export function proofNoteOf(
  t: { proofNotes?: { checkmarx?: ProofNote | null; jenkins?: ProofNote | null; dynatrace?: ProofNote | null } | null },
  source: 'checkmarx' | 'jenkins' | 'dynatrace',
): ProofNote | null {
  const n = t.proofNotes?.[source]
  if (!n || typeof n !== 'object' || !NOTE_STATES.includes(n.state) || typeof n.detail !== 'string' || !n.detail) return null
  return n
}

const mix = (r: VulnScanRead) =>
  ([['SCA', r.sca], ['SAST', r.sast], ['other', r.other]] as const)
    .filter(([, n]) => n > 0)
    .map(([label, n]) => `${label} ${n}`)
    .join(' · ')

/**
 * "Read 412 results on the branch scan (SCA 380 · SAST 18); 398 on the base scan (SCA 380 · SAST 18)" — what the
 * results API returned, so "Not found" can be told from "nothing was read". '' for dumps without `read`.
 */
export function vulnReadLine(vf: VulnFixes): string {
  const parts: string[] = []
  for (const [side, r] of [['branch', vf.read?.branch], ['base', vf.read?.base]] as const) {
    if (!r || typeof r.total !== 'number') continue
    const first = parts.length === 0
    const noun = first ? `${r.total} results` : `${r.total}`
    if (r.total === 0) {
      parts.push(`${noun} on the ${side} scan — the results API returned nothing for it`)
      continue
    }
    const partly = r.truncated ? ` — only part of the ${typeof r.reported === 'number' ? r.reported : 'results'} it holds` : ''
    parts.push(`${noun} on the ${side} scan (${mix(r)})${partly}`)
  }
  return parts.length ? `Read ${parts.join('; ')}` : ''
}

export interface LastFetchView {
  /** ok green · quiet (nothing to report, or not set up) · attention orange · key red. */
  tone: 'ok' | 'quiet' | 'attention' | 'key'
  /** One line: the run's sentence without the source's name, and how long ago. */
  text: string
  /** The dot colour, or null for a quiet line (no dot — not-configured is not a failure). */
  color: string | null
}

/** A proof source's last fetch → the line under its API keys panel. A record it does not understand reads as "Not run yet". */
export function lastFetchView(status: SourceStatus | null | undefined, now: number = Date.now()): LastFetchView {
  if (!status || typeof status !== 'object' || !SOURCE_STATES.includes(status.state) || typeof status.detail !== 'string' || !status.detail) {
    return { tone: 'quiet', text: 'Not run yet', color: null }
  }
  const state = status.state as SourceState
  const tone: LastFetchView['tone'] = state === 'read' ? 'ok' : state === 'auth-failed' ? 'key' : state === 'unreachable' || state === 'budget-exhausted' ? 'attention' : 'quiet'
  const ago = relTime(status.at, now)
  const text = status.detail.replace(/^[A-Z][\w ]{1,24}:\s+/, '')
  return { tone, text: ago ? `${text} · ${ago}` : text, color: tone === 'quiet' ? null : HEALTH_COLOR[tone === 'ok' ? 'ok' : tone] }
}
