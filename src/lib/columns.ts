import type { ColumnKey } from '../types'
import moveTargets from '../../jira-intern/move_targets.json'

export interface ColumnMeta {
  key: ColumnKey
  label: string
  /** Accent color (the column's identity). */
  accent: string
  /** Lowercased Jira statuses that fold into this column. */
  statuses: string[]
  emoji: string
  /** A side state (Blocked, On Hold) rather than a lifecycle stage — left out of a ticket's progress pipeline. */
  aside?: boolean
  /**
   * The edges of the flow (start, hand-off, finish) carry the least on their cards, so they are drawn
   * thinner and the spare width goes to the columns in between, where cards have more to say.
   */
  slim?: boolean
  /**
   * Work that is not the user's to push right now (To Do: not started; QA: handed to someone else). Its
   * colour is a muted grey / grey-teal and its cards carry only a whisper of tint, so the columns that
   * need attention are the ones that stand out.
   */
  quiet?: boolean
}

// The six board columns, left → right. Blocked sits between To Do and In Progress: work that is
// stuck, droppable like any other column (it IS a Jira status), but not a pipeline stage.
// "In Review" intentionally folds in Ready4Review + Code Review + In Review.
export const BOARD_COLUMNS: ColumnMeta[] = [
  {
    key: 'todo',
    label: 'To Do',
    accent: '#8b94a8',
    emoji: '📋',
    slim: true,
    quiet: true,
    statuses: ['to do', 'todo', 'open', 'backlog', 'reopened', 'selected for development', 'new'],
  },
  {
    key: 'blocked',
    label: 'Blocked',
    accent: '#fb3f5f',
    emoji: '⛔',
    statuses: ['blocked', 'impeded', 'blocker', 'stuck'],
    aside: true,
  },
  {
    key: 'prog',
    label: 'In Progress',
    accent: '#2f86ff',
    emoji: '⚙️',
    statuses: ['in progress', 'dev in progress', 'work in progress', 'in development', 'development', 'implementing'],
  },
  {
    key: 'rev',
    label: 'In Review',
    accent: '#b05cff',
    emoji: '👀',
    statuses: ['in review', 'code review', 'ready4review', 'ready for review', 'review', 'peer review', 'pr review'],
  },
  {
    key: 'qa',
    label: 'QA',
    accent: '#6aa9a1',
    emoji: '🧪',
    slim: true,
    quiet: true,
    statuses: [
      'qa',
      'in qa',
      'under qa',
      'ready for qa',
      'ready4qa',
      'awaiting qa',
      'testing',
      'in test',
      'in testing',
      'test',
      'verification',
      'verify',
      'validation',
      'in validation',
    ],
  },
  {
    key: 'done',
    label: 'Done',
    accent: '#2fcf6f',
    emoji: '✅',
    slim: true,
    // Mirrors jira-intern/_jira.py `_STATUS_COLUMNS`: a ticket closed as won't-fix or cancelled is
    // finished work, not a card stuck in progress.
    statuses: ['done', 'completed', 'closed', 'resolved', 'shipped', 'released', "won't fix", 'wont fix', 'won’t fix', 'cancelled', 'canceled', 'rejected'],
  },
]

// Not a column of its own: its own space in the Blocked column, under Blocked and separate from it
// (Column.tsx / OnHold.tsx) — a place to see parked work and a drop target to park a card.
// Settings → "On Hold" off folds held tickets into To Do.
export const HOLD_COLUMN: ColumnMeta = {
  key: 'hold',
  label: 'On Hold',
  accent: '#ff8a1f',
  emoji: '⏸️',
  statuses: ['on hold', 'hold', 'waiting', 'parked', 'paused', 'stalled'],
}

/** The lifecycle stages a ticket moves through — the board columns minus the side states. */
export const PIPELINE_COLUMNS: ColumnMeta[] = BOARD_COLUMNS.filter((c) => !c.aside)

/**
 * QA has a sub-division: "QA In Progress" — tickets the QA team has picked up. It is not a column
 * and never a drop target: developers drop a card on QA (transition.py picks a ready-for-QA status),
 * and only QA moves it further in Jira. Any QA-column status that is not a waiting word counts.
 */
export const QA_IN_PROGRESS = { label: 'QA In Progress', accent: '#5f9a93' } as const
const QA_READY = ['qa', 'ready for qa', 'ready4qa', 'awaiting qa', 'qa ready', 'ready for testing', 'ready for test', 'to test', 'to be tested']
const QA_WAITING_WORDS = new Set(['ready', 'awaiting', 'pending', 'queued', 'moved', 'handed', 'for'])

export function isQaInProgress(status: string | null | undefined): boolean {
  const s = (status ?? '').trim().toLowerCase()
  if (!s || QA_READY.includes(s)) return false
  return !s.split(/[^a-z0-9]+/).some((w) => QA_WAITING_WORDS.has(w))
}

/** Which QA shelf a ticket sits on; null outside the QA column. */
export function qaStage(t: { column: ColumnKey; status?: string | null }): 'ready' | 'inprogress' | null {
  if (t.column !== 'qa') return null
  return isQaInProgress(t.status) ? 'inprogress' : 'ready'
}

// NOT a column — a *partition* of the To Do column. Tickets keep `column: 'todo'`; they're
// pulled out of the To Do box by isNextSprint() (see lib/format.ts) because their sprint
// hasn't started, and rendered in their own space at the end of the To Do column.
export const NEXT_SPRINT_SECTION = {
  label: 'Next Sprint',
  accent: '#ec4899',
  emoji: '🗓️',
} as const

const ALL: ColumnMeta[] = [...BOARD_COLUMNS, HOLD_COLUMN]

export const COLUMN_META: Record<ColumnKey, ColumnMeta> = ALL.reduce(
  (acc, c) => {
    acc[c.key] = c
    return acc
  },
  {} as Record<ColumnKey, ColumnMeta>,
)

/** Safety net: derive a column from a raw status if the intern didn't set one. */
export function mapStatusToColumn(status: string | null | undefined): ColumnKey {
  const s = (status ?? '').trim().toLowerCase()
  if (!s) return 'todo'
  // Whole-word (token) match, NOT naive substring — otherwise "Awaiting Deployment" matches the
  // "waiting" hold keyword, and "Preview"/"Reopened" match "review"/"open". Boundaries are any
  // non-alphanumeric char (handles multi-word keywords like "on hold" / "in progress").
  const hasWord = (kw: string) =>
    new RegExp(`(^|[^a-z0-9])${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(s)
  // On Hold takes precedence so paused work surfaces in its own section.
  if (HOLD_COLUMN.statuses.some((x) => s === x || hasWord(x))) return 'hold'
  for (const col of BOARD_COLUMNS) {
    if (col.statuses.some((x) => s === x)) return col.key
  }
  // Word fallback in the SAME order as the Python intern (blocked → qa → review → progress), so
  // "QA In Progress" lands in QA on both sides instead of matching "in progress" first here.
  for (const key of WORD_FALLBACK_ORDER) {
    if (COLUMN_META[key].statuses.some((x) => hasWord(x))) return key
  }
  return 'todo'
}

const WORD_FALLBACK_ORDER: ColumnKey[] = ['blocked', 'qa', 'rev', 'prog', 'todo', 'done']

/**
 * Drag-and-drop targets — the SAME list the server (server/jobs.mjs) and transition.py read, from
 * jira-intern/move_targets.json, so a target cannot be offered here and refused there.
 */
export const MOVE_TARGETS: ReadonlySet<MoveTarget> = new Set(moveTargets as MoveTarget[])

/**
 * How wide a board column is drawn. A column with nothing in it has nothing to show, so it folds to a
 * slim labelled rail and its width goes to the columns that have cards; while a card is being
 * dragged it opens only to a compact drop zone (not full width — the board barely moves under the
 * cursor). A column shown alone (a stat chip focused the board on it) always stays full.
 */
export type ColumnMode = 'rail' | 'drop' | 'full'

export function columnMode(o: { count: number; held?: number; focused?: boolean; dragging?: boolean }): ColumnMode {
  if (o.focused || o.count + (o.held ?? 0) > 0) return 'full'
  return o.dragging ? 'drop' : 'rail'
}

// ── Column widths ────────────────────────────────────────────────────────────
// Every column carries 6px of invisible padding per side (Column.tsx) so the hit areas of neighbours touch — which is why
// each width is 0.75rem more than what is drawn. Full columns come in two weights: the slim edges (To Do · QA · Done) start
// narrower and grow less, so spare width goes to Blocked · In Progress · In Review, whose cards carry the most.
//
// While a card is dragged (or just after), every empty column opens from a 3.5rem rail to a 7.75rem drop zone, and that
// width has to come from somewhere. At rest the full columns sit within half a rem of their minimum, so they had nothing
// to give: the board overflowed sideways, a scrollbar came and went, and the rest of the layout jumped. So while "calm" the
// full columns may give up more — and they give it UNEVENLY: the wide ones (flex-shrink 1.6, a bigger basis) shed most of
// it, the slim ones only a little (0.75), so the cards that have room absorb the change and the narrow ones barely re-wrap.
// The widths are eased (index.css `.jb-col`), so the change flows instead of snapping.
export interface ColumnWidth {
  flex: string
  minWidth: string
}
const WIDTH: Record<ColumnMode, ColumnWidth> = {
  full: { flex: '1.45 1 15.75rem', minWidth: '15.25rem' },
  drop: { flex: '0 0 7.75rem', minWidth: '7.75rem' },
  rail: { flex: '0 0 3.5rem', minWidth: '3.5rem' },
}
const WIDTH_SLIM: ColumnWidth = { flex: '0.55 1 12.25rem', minWidth: '11.75rem' }
const WIDTH_CALM: ColumnWidth = { flex: '1.45 1.6 15.75rem', minWidth: '12.75rem' }
const WIDTH_SLIM_CALM: ColumnWidth = { flex: '0.55 0.75 12.25rem', minWidth: '10.75rem' }

export function columnWidth(mode: ColumnMode, o: { slim?: boolean; calm?: boolean } = {}): ColumnWidth {
  if (mode !== 'full') return WIDTH[mode]
  if (o.calm) return o.slim ? WIDTH_SLIM_CALM : WIDTH_CALM
  return o.slim ? WIDTH_SLIM : WIDTH.full
}

// ── Move targets ─────────────────────────────────────────────────────────────
// The rules that decide which moves are allowed (QA lane, Next Sprint, In Review / Done gates) live in
// lib/moveRules.ts.

/** Everything the board can move a ticket to: a column, On Hold, QA In Progress, or the Next Sprint space. */
export type MoveTarget = ColumnKey | 'qaip' | 'next'

export const targetLabel = (to: MoveTarget): string =>
  to === 'qaip' ? QA_IN_PROGRESS.label : to === 'next' ? NEXT_SPRINT_SECTION.label : COLUMN_META[to].label
