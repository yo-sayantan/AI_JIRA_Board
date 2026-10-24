import type { CompletedTicket, TakenFromMe, TakenReason } from '../types'
import { fmtDate } from './format'

/**
 * "Taken from you" — the archive's verdict (jira-intern/taken.py → `takenFromMe`) turned into words and colours.
 * One table, read by the Completed view's banner / filter / stat tile and the ticket drawer.
 */
export const TAKEN_COLOR = '#f97316'

export const TAKEN_META: Record<TakenReason, { label: string; short: string; color: string; hint: string }> = {
  cancelled: { label: 'Called off', short: 'Called off', color: '#64748b', hint: 'Closed as cancelled, won’t do, rejected or duplicate — the work was stopped, not delivered.' },
  'pr-declined': { label: 'PR declined', short: 'PR declined', color: '#e11d48', hint: 'Your pull requests on it were declined and none was merged.' },
  backlog: { label: 'Back to the backlog', short: 'Unassigned', color: '#f59e0b', hint: 'Someone else took your name off it — back to the backlog, or for another team to pick up.' },
  'taken-over': { label: 'Taken over mid-work', short: 'Taken over', color: '#f97316', hint: 'Someone else gave it to another person after it was In Progress or In Review on your name.' },
  reassigned: { label: 'Reassigned before you started', short: 'Reassigned', color: '#8b5cf6', hint: 'Someone else gave it to another person while it was still To Do on your name.' },
  released: { label: 'You handed it back', short: 'Handed back', color: '#14b8a6', hint: 'You took your own name off it (or passed it on) before it reached QA.' },
}

/** In the order the archive weighs them — chips are listed this way. */
export const TAKEN_ORDER: TakenReason[] = ['cancelled', 'pr-declined', 'backlog', 'taken-over', 'reassigned', 'released']

export const isTaken = (it: { takenFromMe?: TakenFromMe | null }): boolean => !!it.takenFromMe?.reason

/** Meta for a stored reason — an unknown word from a newer archive falls back to the family colour, never throws. */
export function takenMeta(reason: string | null | undefined) {
  return (reason && TAKEN_META[reason as TakenReason]) || { label: 'Taken from you', short: 'Taken', color: TAKEN_COLOR, hint: 'No longer assigned to you.' }
}

/**
 * Did I work on it? The one question that tells two kinds of taken ticket apart at a glance: one I put real work into (a
 * PR, time In Progress on my name, comments, sub-tickets I raised) and one that was only ever assigned to me.
 */
export const WORK_COLOR = '#16a34a'
export const NO_WORK_COLOR = '#94a3b8'

export const workedOn = (t: TakenFromMe): boolean => !!t.worked

/** "You worked on it" / "No work of yours" — and a one-line tooltip with the evidence. */
export function workLabel(t: TakenFromMe): { label: string; hint: string } {
  if (workedOn(t)) return { label: 'You worked on it', hint: (t.workedOn ?? []).join(' · ') || 'Work of yours is recorded on it.' }
  return { label: 'No work of yours', hint: 'Assigned to you, but no pull request, comment of yours or time In Progress is recorded on it.' }
}

export type WorkFilter = null | 'worked' | 'none'

/** How many rows per reason (headline reason only, so the counts add up to the total), and how many you worked on. */
export function takenCounts(rows: CompletedTicket[]): Record<TakenReason, number> & { total: number; worked: number; none: number } {
  const out = { total: 0, worked: 0, none: 0 } as Record<TakenReason, number> & { total: number; worked: number; none: number }
  for (const r of TAKEN_ORDER) out[r] = 0
  for (const it of rows) {
    const t = it.takenFromMe
    if (!t?.reason) continue
    out.total++
    if (t.reason in out) out[t.reason]++
    if (workedOn(t)) out.worked++
    else out.none++
  }
  return out
}

/** Does a row match the "Taken from you" filter: `any` = every taken row, a reason = rows that have it at all. */
export function matchesTaken(it: CompletedTicket, filter: null | 'any' | TakenReason, work: WorkFilter = null): boolean {
  if (!filter && !work) return true
  const t = it.takenFromMe
  if (!t?.reason) return false
  if (work === 'worked' && !workedOn(t)) return false
  if (work === 'none' && workedOn(t)) return false
  return !filter || filter === 'any' || t.reason === filter || (t.reasons ?? []).includes(filter)
}

/** How many top-level tickets were taken from me — what the board's Completed button points at. */
export function countTaken(rows: Array<{ parentKey?: string | null; mine?: boolean; takenFromMe?: TakenFromMe | null }>): { total: number; worked: number } {
  let total = 0
  let worked = 0
  for (const r of rows) {
    if (r.parentKey || r.mine === false || !r.takenFromMe?.reason) continue
    total++
    if (workedOn(r.takenFromMe)) worked++
  }
  return { total, worked }
}

/** Where a row sits on the timeline: when it closed, else (still open, taken from me) when it left me. */
export const rowDate = (it: CompletedTicket): string | null | undefined => it.resolved ?? it.takenFromMe?.when

const firstName = (who?: string | null) => (who ?? '').split(' (')[0].trim()

/** One line: who did what, and when — "Unassigned by Roe, Sam · 22 Oct 2026", "Given to Tester, Tess by Roe, Sam". */
export function takenLine(t: TakenFromMe): string {
  const when = t.when ? fmtDate(t.when) : ''
  const by = firstName(t.by)
  const to = firstName(t.to)
  let what: string
  if (t.stillMine) what = t.reason === 'pr-declined' ? `${(t.declinedPrs ?? []).join(', ') || 'Your PR'} declined` : `Closed as ${t.resolution || 'cancelled'}`
  else if (t.byMe) what = to ? `You passed it to ${to}` : 'You un-assigned yourself'
  else if (!to) what = by ? `Unassigned by ${by}` : 'Unassigned'
  else what = by ? `Given to ${to} by ${by}` : `Given to ${to}`
  if (!t.stillMine && t.reasons?.includes('cancelled')) what += ` · later ${t.resolution ? `closed as ${t.resolution}` : 'called off'}`
  return [what, when].filter(Boolean).join(' · ')
}

/** "Roe, Sam wrote, when it moved:" or "Next comment — Tester, Tess:" — the comment is evidence, never claimed as the reason. */
export function whyLabel(t: TakenFromMe): string | null {
  const w = t.why
  if (!w?.text) return null
  const who = firstName(w.author) || 'Someone'
  return w.byMover ? `${who} wrote, when it moved` : `Next comment — ${who}`
}
