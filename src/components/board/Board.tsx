import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { BOARD_COLUMNS } from '../../lib/columns'
import { ALL_SECTIONS, type BoardSections } from '../../lib/boardView'
import type { ColumnKey, Ticket } from '../../types'
import type { MoveTarget } from '../../lib/columns'
import type { TicketLookup } from '../../lib/moveRules'
import { compareFutureSprints, futureSprintOf, priorityMeta } from '../../lib/format'
import { Column } from './Column'

// Within a column: most urgent first, then most recently touched. The Done column
// instead shows the freshest win on top (priority is moot once it's shipped).
const byUrgency = (a: Ticket, b: Ticket) =>
  priorityMeta(b.priority).rank - priorityMeta(a.priority).rank ||
  (b.lastUpdate ?? '').localeCompare(a.lastUpdate ?? '')
const byRecency = (a: Ticket, b: Ticket) =>
  (b.resolved ?? b.lastUpdate ?? '').localeCompare(a.resolved ?? a.lastUpdate ?? '')

/** How long the board stays calm after a drag ends — long enough for the columns to snap and the cards to settle. */
const SETTLE_MS = 450
/** How long the first-paint cascade class stays on — longer than the last card's delay + duration. */
const INTRO_MS = 900
let introPlayed = false

export const Board = memo(function Board({
  tickets,
  now,
  onOpen,
  focus,
  onArchive,
  onRefreshTicket,
  refreshingKeys,
  onMove,
  movingKeys,
  bottomOrder,
  held,
  nextSprint,
  sections = ALL_SECTIONS,
  lookup,
  readiness = false,
}: {
  tickets: Ticket[]
  now: number
  onOpen: (key: string) => void
  focus?: ColumnKey | null
  onArchive?: (key: string) => void
  onRefreshTicket?: (key: string) => void
  refreshingKeys?: ReadonlySet<string>
  /** Drag-and-drop status change, written through to Jira. `force`: ⌥ was held — past a PR / QA gate. */
  onMove?: (key: string, to: MoveTarget, force?: boolean) => void
  movingKeys?: ReadonlySet<string>
  /** Cards dropped by hand sit at the bottom of their column, in drop order, below the sorted rest. */
  bottomOrder?: ReadonlyMap<string, number>
  /** On Hold tickets, shown as their own space under Blocked. Undefined = Settings → On Hold is off. */
  held?: Ticket[]
  /** To Do tickets whose sprint has not started, shown as their own space at the end of To Do. Undefined = Settings → Next Sprint is off. */
  nextSprint?: Ticket[]
  /** Which optional sections are on (Settings → Board sections). */
  sections?: BoardSections
  /** Every ticket the board knows — the move rules read a sub-ticket's parent from it. */
  lookup?: TicketLookup
  /** Show the In Review / Done readiness dots on cards. */
  readiness?: boolean
}) {
  const byColumn = useMemo(() => {
    const groups = new Map<ColumnKey, Ticket[]>(BOARD_COLUMNS.map((c) => [c.key, []]))
    for (const t of tickets) groups.get(t.column)?.push(t)
    const pin = (t: Ticket) => bottomOrder?.get(t.key) ?? 0
    for (const [key, list] of groups) {
      const natural = key === 'done' ? byRecency : byUrgency
      list.sort((a, b) => pin(a) - pin(b) || natural(a, b))
    }
    return groups
  }, [tickets, bottomOrder])
  const sortedSpace = (list?: Ticket[]) => {
    if (!list) return undefined
    const pin = (t: Ticket) => bottomOrder?.get(t.key) ?? 0
    return [...list].sort((a, b) => pin(a) - pin(b) || byUrgency(a, b))
  }
  const heldSorted = useMemo(() => sortedSpace(held), [held, bottomOrder]) // eslint-disable-line react-hooks/exhaustive-deps
  // Next Sprint: grouped by sprint (soonest first, undated grooming buckets last) so each group gets its caption.
  const queuedSorted = useMemo(() => {
    const list = sortedSpace(nextSprint)
    if (!list) return undefined
    const sp = (t: Ticket) => futureSprintOf(t.sprint, now)
    return list.sort((a, b) => {
      const x = sp(a)
      const y = sp(b)
      return x && y ? compareFutureSprints(x, y) : 0
    })
  }, [nextSprint, bottomOrder, now]) // eslint-disable-line react-hooks/exhaustive-deps
  // Blocked is also the home of the On Hold space: with Blocked off and On Hold on the column stays, as On Hold alone.
  const shown = BOARD_COLUMNS.filter((c) => c.key !== 'blocked' || sections.blocked || held !== undefined)
  const cols = focus ? shown.filter((c) => c.key === focus) : shown
  // Card drags start inside this element and bubble up, so one pair of listeners tells every
  // column that a drag is in flight — empty columns open from a rail to a compact drop zone.
  // The ticket being carried, so each zone can tell whether it may land there (QA lane rules).
  const [dragKey, setDragKey] = useState<string | null>(null)
  const dragActive = dragKey !== null
  // For a moment after a drag ends the board stays "calm": the full columns keep their extra give (so the empty
  // ones fold back without a second re-flow) and cards do not animate their position. Dropping a card where it
  // already was changes nothing in Jira, but the empty columns still fold back and every card shifts with them —
  // with card springs on top of the width easing that read as stutter.
  const [settling, setSettling] = useState(false)
  const settleTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const endDrag = () => {
    setDragKey(null)
    setSettling(true)
    clearTimeout(settleTimer.current)
    settleTimer.current = setTimeout(() => setSettling(false), SETTLE_MS)
  }
  useEffect(() => () => clearTimeout(settleTimer.current), [])
  // The board's first paint cascades in, lane by lane (index.css `.jb-board-intro`) — once per page
  // load: clearing a search or switching views remounts the board, and that must not replay it.
  const [intro, setIntro] = useState(() => !introPlayed)
  useEffect(() => {
    if (!intro) return
    introPlayed = true
    const t = setTimeout(() => setIntro(false), INTRO_MS)
    return () => clearTimeout(t)
  }, [intro])
  const calm = dragActive || settling
  const dragged = useMemo(
    () => (dragKey ? ([...tickets, ...(held ?? []), ...(nextSprint ?? [])].find((t) => t.key === dragKey) ?? lookup?.get(dragKey)) : undefined),
    [dragKey, tickets, held, nextSprint, lookup],
  )
  return (
    <div
      // Columns overlap their neighbours' gap by 6px a side (Column.tsx), so drop areas touch; the
      // container's matching padding keeps the first and last from being clipped. It is NOT a scroll container itself
      // (no overflow): App's <main> scrolls the board both ways, so the lanes' sticky titles stick to it. While a drag is in
      // flight (jb-dragging) the full columns may give up more width, unevenly — the wide ones most — and
      // every width eases (index.css `.jb-col`), so the empty columns opening to drop zones never make the
      // board overflow or the cards jump; cards hold still (calm) while that happens.
      role="region"
      aria-label="Ticket board"
      className={`-mx-1.5 flex min-w-fit items-stretch gap-3 px-1.5 pb-3 ${calm ? 'jb-dragging' : ''} ${intro ? 'jb-board-intro' : ''}`}
      onDragStart={(e) => setDragKey((e.target as HTMLElement).closest?.('[data-ticket-key]')?.getAttribute('data-ticket-key') ?? '')}
      onDragEnd={endDrag}
      onDrop={endDrag}
    >
      {cols.map((meta) => (
        <Column
          key={meta.key}
          meta={meta}
          dragActive={dragActive}
          calm={calm}
          dragged={dragged}
          focused={cols.length === 1}
          tickets={byColumn.get(meta.key) ?? []}
          now={now}
          onOpen={onOpen}
          // Only Done cards can be moved to Completed (off the board, into the archive).
          onArchive={meta.key === 'done' ? onArchive : undefined}
          // Per-ticket refresh only for in-flight columns (the card also guards on column).
          onRefreshTicket={meta.key === 'done' ? undefined : onRefreshTicket}
          refreshingKeys={refreshingKeys}
          onMove={onMove}
          movingKeys={movingKeys}
          held={meta.key === 'blocked' ? heldSorted : undefined}
          queued={meta.key === 'todo' ? queuedSorted : undefined}
          hideOwn={meta.key === 'blocked' && !sections.blocked}
          showQaInProgress={sections.qaInProgress}
          lookup={lookup}
          readiness={readiness}
        />
      ))}
    </div>
  )
})
