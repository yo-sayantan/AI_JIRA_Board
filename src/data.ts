import type { CompletedTicket, JiraData, Ticket } from './types'
import { COLUMN_META, mapStatusToColumn } from './lib/columns'
import { qaColumn } from './lib/moveRules'
import { projectOf } from './lib/format'
import { fixture } from './fixtures'
import { DONE_BOARD_DAYS } from './lib/appConfig'

export type DataSource = 'live' | 'fixture' | 'empty' | 'demo'

/** The dump data.js injected at page load, if any. */
export function injectedDump(): JiraData | null {
  const raw = (window as unknown as { __JIRA_DATA__?: JiraData }).__JIRA_DATA__
  return raw && Array.isArray(raw.tickets) ? raw : null
}

/** A dump entry the board can render: an object with a string key. Anything else is skipped. */
function isTicketLike(t: unknown): t is Ticket {
  return typeof t === 'object' && t !== null && typeof (t as { key?: unknown }).key === 'string'
}

function normalizeTicket(t: Ticket): Ticket {
  // An unknown column would match no board column and the card would silently vanish. Own-property
  // check, not `in`: a column named "toString" or "constructor" must not pass as a real column.
  let column = typeof t.column === 'string' && Object.prototype.hasOwnProperty.call(COLUMN_META, t.column) ? t.column : mapStatusToColumn(t.status)
  // Dumps written before the Blocked column existed filed Blocked / Impeded under On Hold.
  if (column === 'hold' && mapStatusToColumn(t.status) === 'blocked') column = 'blocked'
  // A QA ticket (raised by me, worked by the QA team) lives in QA / QA In Progress, not among the dev stages.
  column = qaColumn({ column, type: t.type, title: t.title, labels: t.labels })
  return {
    ...t,
    title: typeof t.title === 'string' ? t.title : '',
    status: typeof t.status === 'string' ? t.status : '',
    column,
    done: t.done ?? column === 'done',
    onHold: t.onHold ?? column === 'hold',
  }
}

/** When did this ticket become Done? resolved is canonical; lastUpdate is the fallback
 *  (a Done ticket's last update IS the close, per the intern's refresh rules). */
function doneAt(t: Ticket): number | null {
  const when = t.resolved ?? t.lastUpdate
  if (!when) return null
  const ts = Date.parse(when)
  return Number.isNaN(ts) ? null : ts
}

/** A Done board ticket is already shaped like an archive row — just stamp project +
 *  make sure `resolved` is set so the archive groups it under the right year. */
function ticketToCompleted(t: Ticket): CompletedTicket {
  return { ...t, project: projectOf(t.key), resolved: t.resolved ?? t.lastUpdate ?? null }
}

// ── Manual "Move to Completed" (user action, persisted locally) ────────────
// The trophy button on a Done card / detail drawer adds the key here; those tickets
// take the SAME retirement path as time-expired ones on the next prepare().
const ARCHIVE_LS_KEY = 'jb-archived'

export function persistArchivedKeys(s: Set<string>): void {
  try {
    localStorage.setItem(ARCHIVE_LS_KEY, JSON.stringify([...s]))
  } catch {
    /* file:// localStorage may be blocked */
  }
}

/** Read the user-archived key set. Also migrates the legacy "jb-hidden" hide feature
 *  (same intent — off the board, lives in Completed) and prunes keys that have left
 *  the dump entirely (the intern dropped them; the weekly archive owns them now). */
export function loadArchivedKeys(raw: JiraData | null): Set<string> {
  try {
    const cur = new Set<string>(JSON.parse(localStorage.getItem(ARCHIVE_LS_KEY) || '[]'))
    const legacy: unknown = JSON.parse(localStorage.getItem('jb-hidden') || '[]')
    if (Array.isArray(legacy) && legacy.length) {
      for (const k of legacy) if (typeof k === 'string') cur.add(k)
      localStorage.removeItem('jb-hidden')
    }
    if (raw) {
      const live = new Set(raw.tickets.filter(isTicketLike).map((t) => t.key))
      for (const k of [...cur]) if (!live.has(k)) cur.delete(k)
    }
    persistArchivedKeys(cur)
    return cur
  } catch {
    return new Set()
  }
}

/**
 * Apply the board's lifecycle rules to a raw dump (live or fixture):
 *  • normalize every ticket (column/done/onHold fallbacks),
 *  • RETIRE Done tickets that are older than DONE_BOARD_DAYS *or* that the user
 *    manually moved to Completed — off the dashboard, into completed[]
 *    (deduped by key; the weekly archive's richer row wins if present).
 * Never mutates the input (the fixture is a shared module constant).
 */
function prepare(raw: JiraData, now: number, archivedKeys: ReadonlySet<string>): { data: JiraData; userArchived: string[] } {
  const tickets = (Array.isArray(raw.tickets) ? raw.tickets : []).filter(isTicketLike).map(normalizeTicket)
  const completed: CompletedTicket[] = Array.isArray(raw.completed) ? raw.completed.filter((c): c is CompletedTicket => isTicketLike(c)) : []
  const completedKeys = new Set(completed.map((c) => c.key))

  const board: Ticket[] = []
  const userArchived: string[] = []
  for (const t of tickets) {
    if (t.column === 'done') {
      const ts = doneAt(t)
      const expired = ts != null && now - ts > DONE_BOARD_DAYS * 86_400_000
      const byUser = archivedKeys.has(t.key)
      if (expired || byUser) {
        // Retired: lives on ONLY in the Completed archive (still openable from there).
        if (!expired) userArchived.push(t.key) // would still be on the board but for the user — undoable
        if (!completedKeys.has(t.key)) {
          completed.push(ticketToCompleted(t))
          completedKeys.add(t.key)
        }
        continue
      }
    }
    board.push(t)
  }

  return {
    data: {
      ...raw,
      tickets: board,
      completed,
      notes: Array.isArray(raw.notes) ? raw.notes : [],
    },
    userArchived,
  }
}

/**
 * Resolution order:
 *  1. the live dump   — data.js at load, or data.json after an in-place reload
 *  2. dev fixture     — only while running `npm run dev`, so the UI has something to render
 *  3. empty           — built file with no data yet (shows a friendly "run the intern" state)
 *
 * `userArchived` = keys the USER moved to Completed that would otherwise still be on
 * the board (drives the "· Undo" strip; time-expired retirements are not undoable).
 */
export function loadData(
  raw: JiraData | null,
  archivedKeys: ReadonlySet<string>,
): {
  data: JiraData
  source: DataSource
  userArchived: string[]
} {
  const now = Date.now()
  if (raw) return { ...prepare(raw, now, archivedKeys), source: 'live' }
  if (import.meta.env.DEV) return { ...prepare(fixture, now, archivedKeys), source: 'fixture' }
  return { data: { tickets: [], completed: [], notes: [] }, source: 'empty', userArchived: [] }
}
