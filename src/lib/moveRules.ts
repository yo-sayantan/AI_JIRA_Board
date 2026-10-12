import type { LinkRef, PullRequest, Ticket } from '../types'
import { isNextSprint, prListOf } from './format'
import { isQaInProgress, targetLabel, type MoveTarget } from './columns'
import rules from '../../jira-intern/move_rules.json'

// Every rule a drag-and-drop move answers to, in one place: the drop zones (dimmed, with the reason),
// the readiness dots on cards, demo mode and the move hook all ask here. MIRRORED server-side in
// jira-intern/transition.py (`is_qa_ticket`, `lane_blocker`, `evaluate`) — the server judges live Jira,
// this side judges the cached dump. Change one, change the other; both have tests.
//
//  • The QA lane — QA and QA In Progress hold QA tickets (raised by the user or linked to their work).
//    Only a QA ticket may enter them, and a QA ticket — wherever it sits — moves only to QA, QA In
//    Progress, Blocked, On Hold or Done. Everything else moves freely outside the lane.
//  • Next Sprint — a sprint assignment, not a status. Only To Do, Blocked, QA (ready shelf, not QA In Progress)
//    and On Hold tickets can be moved into it (Jira: the nearest dated future sprint, else READY, else
//    REFINEMENT; status To Do); a ticket in it can only move back to To Do (Jira: the active sprint).
//    Nothing else. Overrides the QA lane for that one hop.
//  • In Review — needs a pull request (open or merged), or for a sub-ticket an OPEN PR on its parent —
//    except for the issue types in jira-intern/move_rules.json (Support): those are worked without a PR.
//  • Done — needs no PR still open (each merged or declined), at least one PR (a sub-ticket may have
//    none of its own), and a QA ticket raised (a sub-ticket's parent's QA ticket counts). QA tickets
//    themselves close freely.
//
// The lane is structural and can never be forced. The PR / QA gates can, with ⌥ on drop — the cached
// data may be behind Jira.

const QA_LANE: ReadonlySet<MoveTarget> = new Set<MoveTarget>(['qa', 'qaip', 'blocked', 'hold', 'done', 'next'])
/** Where a ticket must be sitting to be moved into Next Sprint. */
const NEXT_FROM: ReadonlySet<MoveTarget> = new Set<MoveTarget>(['todo', 'blocked', 'qa', 'hold'])
const LANE_NAMES = 'QA, QA In Progress, Blocked, On Hold, Next Sprint or Done'

/** Issue types that need no pull request to reach In Review (jira-intern/move_rules.json, shared with the server). */
export const isPrOptional = (type: string | null | undefined): boolean =>
  !!type && rules.prOptionalTypes.some((x) => x.toLowerCase() === type.trim().toLowerCase())

/** Loose guess for LINKED issues, whose type is often unknown: the title mentions QA / test / verify. */
export function looksLikeQa(type: string | null | undefined, title: string | null | undefined): boolean {
  const text = `${type ?? ''} ${title ?? ''}`.toLowerCase()
  return text.includes('qa') || text.includes('test') || text.includes('verif')
}

/**
 * A label that marks the ticket ITSELF as a QA ticket: "QA", "qa-ticket", "qa_task", "testing"… Not a
 * label about a dev ticket's QA ("qa-failed", "needs-qa", "qa-passed") — those are a dev ticket's state.
 */
export const QA_LABEL = /^(qa|qa[-_ ]?(ticket|task|test|testing)|test(ing)?([-_ ]?(ticket|task))?)$/i

/**
 * A QA ticket — one that belongs to the QA lane: its type says QA / Test, a Jira label marks it
 * (`QA_LABEL`), or its title leads with a QA prefix ("QA: …", "[QA] …"). Stricter
 * than `looksLikeQa` because it LOCKS the ticket into the lane; a dev ticket that merely says "verify"
 * is not one. Mirror: transition.py::is_qa_ticket.
 */
export function isQaTicket(t: { type?: string | null; title?: string | null; labels?: string[] | null }): boolean {
  const type = t.type ?? ''
  const title = t.title ?? ''
  return (
    /(^|[^a-z0-9])qa([^a-z0-9]|$)/i.test(type) ||
    /test/i.test(type) ||
    (t.labels ?? []).some((l) => QA_LABEL.test(l.trim())) ||
    /^\s*\[?\s*qa\b/i.test(title) ||
    /\bqa\s*[:\-–—]/i.test(title)
  )
}

type LaneTicket = {
  column: Ticket['column']
  status?: string | null
  sprint?: string | null
  queued?: boolean
  type?: string | null
  title?: string | null
  labels?: string[] | null
}

/** Where a displayed ticket sits as a move target — QA splits in two (both column 'qa') and Next Sprint is a space of To Do. */
export function moveTargetOf(t: LaneTicket, now: number = Date.now()): MoveTarget {
  if (isNextSprint(t, now)) return 'next'
  return t.column === 'qa' ? (isQaInProgress(t.status) ? 'qaip' : 'qa') : t.column
}

/** Anything sitting in QA / QA In Progress is the lane's, whatever its type or title says. */
export const inQaLane = (t: LaneTicket) => t.column === 'qa' || isQaTicket(t)

export const DONE_LOCKED = 'A Done ticket stays in Done — it can’t be moved to another column.'

/** Why the QA lane or the Next Sprint rule forbids moving `t` to `to` — null when it allows it. */
export function laneBlocker(t: LaneTicket, to: MoveTarget, now: number = Date.now()): string | null {
  const from = moveTargetOf(t, now)
  // Finished work stays finished: a Done ticket cannot be dragged anywhere (only the Undo right after the move can reopen it).
  if (from === 'done') return DONE_LOCKED
  // Next Sprint is a one-way street in and out: nothing but To Do leaves it, and only four places enter it.
  if (from === 'next') return to === 'todo' ? null : `A Next Sprint ticket can only be moved back to To Do — not to ${targetLabel(to)}.`
  if (to === 'next') {
    return NEXT_FROM.has(from) ? null : `Only To Do, Blocked, QA and On Hold tickets can be moved to Next Sprint — not ones in ${targetLabel(from)}.`
  }
  const qa = inQaLane(t)
  if ((to === 'qa' || to === 'qaip') && !qa) return `Only QA tickets can be moved to ${targetLabel(to)} — this ticket is not one.`
  if (qa && !QA_LANE.has(to)) return `A QA ticket can only be moved to ${LANE_NAMES} — not to ${targetLabel(to)}.`
  return null
}

const isMerged = (p: PullRequest) => !!p.merged || p.state === 'merged'
const isDeclined = (p: PullRequest) => p.state === 'declined'
/** Still in review: neither merged nor declined. */
export const isOpenPr = (p: PullRequest) => !isMerged(p) && !isDeclined(p) && p.state !== 'none'
const prName = (p: PullRequest) => (p.id ? `#${p.id}` : 'a PR')

export interface QaIssue {
  key: string
  status?: string | null
}

/** The ticket's QA tickets: QA-ish sub-tasks plus QA-ish linked issues. */
export function qaIssuesOf(t: Ticket): QaIssue[] {
  const found = new Map<string, QaIssue>()
  for (const s of t.subtasks ?? []) {
    if (s.key && (isQaTicket(s) || looksLikeQa(s.type, s.title))) found.set(s.key, { key: s.key, status: s.status })
  }
  for (const r of (t.related ?? []) as LinkRef[]) {
    if (r.key && !found.has(r.key) && r.relation !== 'parent' && r.relation !== 'epic' && looksLikeQa(null, r.title ?? r.summary)) {
      found.set(r.key, { key: r.key, status: r.status })
    }
  }
  return [...found.values()]
}

export interface MoveCheck {
  /** `lane`: never allowed. `gate`: a PR / QA rule — ⌥ on drop forces past it. null: allowed. */
  kind: 'lane' | 'gate' | null
  reason: string | null
  /** Soft notes — the move still happens. */
  warnings: string[]
}

const OK: MoveCheck = { kind: null, reason: null, warnings: [] }

/** Finds tickets the board knows (to read a sub-ticket's parent). Missing parent = can't tell here; the server decides. */
export type TicketLookup = ReadonlyMap<string, Ticket>

/** Everything that decides whether `t` may be moved to `to`, judged from the cached dump. */
export function checkMove(t: Ticket, to: MoveTarget, lookup?: TicketLookup): MoveCheck {
  const lane = laneBlocker(t, to)
  if (lane) return { kind: 'lane', reason: lane, warnings: [] }
  // A QA ticket is someone else's test: no PR or QA ticket of its own to wait for. A Next Sprint hop only
  // reassigns the sprint — no PR or QA gate applies to it.
  if (inQaLane(t) || to === 'next' || moveTargetOf(t) === 'next') return OK

  const prs = prListOf(t)
  const open = prs.filter(isOpenPr)
  const parent = t.parentKey ? lookup?.get(t.parentKey) : undefined
  const warnings: string[] = []
  if (to === 'hold' && open.length) {
    warnings.push(`${open.map(prName).join(', ')} is still open — it will wait unreviewed while the ticket is on hold.`)
  }

  if (to === 'rev') {
    if (prs.some((p) => !isDeclined(p) && p.state !== 'none') || isPrOptional(t.type)) return { ...OK, warnings }
    if (t.parentKey) {
      // Unknown parent: the server reads it live.
      if (!parent || prListOf(parent).some(isOpenPr)) return { ...OK, warnings }
      return { kind: 'gate', reason: `Can't move to In Review: no pull request of its own, and its parent ${t.parentKey} has no open one.`, warnings }
    }
    return { kind: 'gate', reason: "Can't move to In Review: no pull request raised yet.", warnings }
  }

  if (to === 'done') {
    const problems: string[] = []
    if (open.length) problems.push(`${open.map(prName).join(', ')} still open (merge or decline it)`)
    else if (prs.length === 0 && !t.parentKey) problems.push('no pull request raised')
    const qa = qaIssuesOf(t)
    const parentQa = parent ? qaIssuesOf(parent) : []
    const qaUnknown = !!t.parentKey && !parent
    if (qa.length === 0 && parentQa.length === 0 && !qaUnknown) problems.push(t.parentKey ? 'no QA ticket raised (on it or its parent)' : 'no QA ticket raised')
    if (problems.length) return { kind: 'gate', reason: `Can't move to Done: ${problems.join('; ')}.`, warnings }
  }
  return { ...OK, warnings }
}

/**
 * The readiness dots on a card: can it go to In Review / Done right now? Null = no dots — Done, QA
 * tickets, and To Do (work not started would only ever show "not yet").
 */
export function readinessOf(t: Ticket, lookup?: TicketLookup): { rev: MoveCheck | null; done: MoveCheck } | null {
  if (t.column === 'done' || t.column === 'todo' || inQaLane(t)) return null
  const beforeReview = t.column === 'prog' || t.column === 'blocked' || t.column === 'hold'
  return { rev: beforeReview ? checkMove(t, 'rev', lookup) : null, done: checkMove(t, 'done', lookup) }
}

/** A refusal in a few words, for a narrow drop zone. The full reason is the zone's tooltip. */
export function shortReason(c: MoveCheck): string {
  if (!c.reason) return ''
  if (c.kind === 'lane') {
    if (c.reason.startsWith('Only QA')) return 'QA tickets only'
    if (c.reason === DONE_LOCKED) return 'Done is final'
    if (c.reason.includes('Next Sprint ticket')) return 'Next Sprint: back to To Do only'
    if (c.reason.startsWith('Only To Do')) return 'Not from here'
    return 'QA tickets stay in the QA lane'
  }
  const s = c.reason.replace(/^Can't move to [^:]+:\s*/, '').replace(/\.$/, '')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** The answer when nothing is being dragged, or the move is allowed. */
export const MOVE_OK: MoveCheck = OK
