import { completedToTicket, raisedToTicket, type JiraData, type Ticket } from '../types'
import { isQaInProgress } from './columns'
import { isNextSprint, prListOf } from './format'
import { matches, type Term } from './search'

/** Which optional board sections are switched on (Settings → Board sections). */
export interface BoardSections {
  blocked: boolean
  onHold: boolean
  qaInProgress: boolean
}
export const ALL_SECTIONS: BoardSections = { blocked: true, onHold: true, qaInProgress: true }

/** A ticket that lives in a section the user switched off is not on the board at all — no card, no count. */
export function inHiddenSection(t: Pick<Ticket, 'column' | 'status'>, s: BoardSections): boolean {
  if (t.column === 'blocked') return !s.blocked
  if (t.column === 'hold') return !s.onHold
  if (t.column === 'qa') return !s.qaInProgress && isQaInProgress(t.status)
  return false
}

export interface BoardView {
  /** Every active ticket the search matched, wherever it renders. */
  matched: Ticket[]
  /** The kanban columns. */
  board: Ticket[]
  /** On Hold — its own space under Blocked. Empty when that section is off. */
  hold: Ticket[]
  /** To Do tickets whose sprint has not started. */
  nextSprint: Ticket[]
}

export function splitBoard(tickets: Ticket[], terms: Term[], now: number, sections: BoardSections = ALL_SECTIONS): BoardView {
  const view: BoardView = { matched: [], board: [], hold: [], nextSprint: [] }
  for (const t of tickets) {
    if (inHiddenSection(t, sections) || !matches(t, terms)) continue
    view.matched.push(t)
    if (isNextSprint(t, now)) view.nextSprint.push(t)
    else if (t.column === 'hold') view.hold.push(t)
    else view.board.push(t)
  }
  return view
}

/**
 * Ignores next sprint's queue, or finishing a sprint would never earn the empty-board celebration.
 * Held tickets DO count: they sit on the board (their own space under Blocked), so a board holding
 * only parked work is not an empty board. So do tickets in a section the user switched off — hiding
 * a section must not turn the board into a "nothing left to do" celebration.
 */
export function hasActiveWork(tickets: Ticket[], now: number): boolean {
  return tickets.some((t) => !isNextSprint(t, now))
}

/**
 * Every ticket by key: board tickets, archive rows, and all nested sub-tasks. Standalone rows win
 * over nested copies, because the archive holds a sub-ticket both as its own row and under its master.
 */
export function indexByKey(data: JiraData): Map<string, Ticket> {
  const index = new Map<string, Ticket>()
  const nested: Ticket[] = []
  // Raised rows come LAST: a ticket that is also on the board / in the archive keeps its
  // richer object (code, comments, subtasks) — the compact raised row is only a fallback.
  for (const t of [...data.tickets, ...data.completed.map(completedToTicket), ...(data.raised ?? []).map(raisedToTicket)]) {
    if (!index.has(t.key)) index.set(t.key, t)
    if (t.subtasks?.length) nested.push(...t.subtasks)
  }
  const addNested = (list: Ticket[]) => {
    for (const t of list) {
      if (!index.has(t.key)) index.set(t.key, t)
      if (t.subtasks?.length) addNested(t.subtasks)
    }
  }
  addNested(nested)
  return index
}

/** Mirrors pr_report.py's iter_tickets, so the menu's count matches what a bulk run produces. */
export function countTicketsWithPr(data: JiraData): number {
  const keys = new Set<string>()
  for (const t of data.tickets) {
    if (prListOf(t).length > 0) keys.add(t.key)
    for (const s of t.subtasks ?? []) if (s.key && prListOf(s).length > 0) keys.add(s.key)
  }
  for (const c of data.completed) if (prListOf(c).length > 0) keys.add(c.key)
  return keys.size
}

/**
 * The dashboard's own cards with a pull request: open work (On Hold and Next Sprint included) plus
 * the Done column's recently completed tickets. The Completed archive and nested sub-tasks of
 * other people are not on the dashboard, so they are left out.
 */
export function dashboardPrTickets(tickets: Ticket[]): { keys: string[]; open: number; done: number } {
  const keys: string[] = []
  let done = 0
  for (const t of tickets) {
    if (prListOf(t).length === 0 || keys.includes(t.key)) continue
    keys.push(t.key)
    if (t.column === 'done') done++
  }
  return { keys, open: keys.length - done, done }
}

export function countMyCompleted(data: JiraData): number {
  // A ticket taken from me (un-assigned, reassigned, called off, PR declined) is listed in Completed but is not done work.
  return data.completed.filter((c) => c.mine !== false && !c.parentKey && !c.takenFromMe?.reason).length
}

/** The Raised chip shows open/total: "still needs fixing" is the number that matters. */
export function countRaised(data: JiraData): { total: number; open: number } {
  const rows = data.raised ?? []
  return { total: rows.length, open: rows.filter((r) => !(r.done ?? r.column === 'done')).length }
}
