import { memo } from 'react'
import { BOARD_COLUMNS } from '../../lib/columns'
import type { ColumnKey, Ticket } from '../../types'

import { TAKEN_COLOR as TAKEN } from '../../lib/taken'
import { lift } from '../../lib/tone'

// Identity of the Raised-by-me view — indigo, deliberately not a red/alarm family.
const RAISED = '#6366f1'

/**
 * What the top chip row currently has selected. A column key filters the board to that column;
 * null is "All" — the whole board, selected by default. Picking a column chip again returns to All.
 */
export type StatSelection = ColumnKey | null

export const Stats = memo(function Stats({
  tickets,
  hideBlocked = false,
  completedCount,
  takenCount = null,
  raisedCount,
  active,
  onSelect,
  onOpenCompleted,
  onOpenRaised,
}: {
  /** Every ticket on the board, On Hold and Next Sprint included (they are spaces inside the Blocked and To Do columns). */
  tickets: Ticket[]
  /** Settings → Blocked section off: no Blocked chip. */
  hideBlocked?: boolean
  /** null hides the Completed chip entirely (Settings → Completed archive off). */
  completedCount: number | null
  /** Tickets that were mine and were taken away (un-assigned, reassigned, called off, PR declined). null/0 hides the chip. */
  takenCount?: { total: number; worked: number } | null
  /** Tickets I reported: open/total. null hides the chip (feature off or nothing raised). */
  raisedCount: { total: number; open: number } | null
  active: StatSelection
  onSelect: (key: StatSelection) => void
  /** `taken`: open Completed already filtered to the tickets taken from me. */
  onOpenCompleted?: (opts?: { taken?: boolean }) => void
  onOpenRaised?: () => void
}) {
  const counts = (k: ColumnKey) => tickets.filter((t) => t.column === k).length
  const total = tickets.length

  return (
    <nav className="jb-board-tools mb-3 flex min-w-0 items-center gap-3" aria-label="Board controls">
      <div role="toolbar" aria-label="Board filters" className="flex min-w-max items-center gap-1.5">
        {/* "All" — the whole board; first in the row and selected by default. */}
        <button
          type="button"
          aria-pressed={active === null}
          onClick={() => onSelect(null)}
          title="Show every column"
          className="jb-filter-button inline-flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-semibold"
          style={{ ['--filter-accent' as string]: 'var(--ink)' }}
        >
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[var(--muted)]" />
          <span>All</span>
          <span className="tabular-nums">{total}</span>
        </button>

        {BOARD_COLUMNS.filter((c) => !(hideBlocked && c.key === 'blocked')).map((c) => {
          const n = counts(c.key)
          const isActive = active === c.key
          return (
            <button
              key={c.key}
              type="button"
              aria-pressed={isActive}
              onClick={() => onSelect(isActive ? null : c.key)}
              className="jb-filter-button inline-flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-semibold"
              style={{ ['--filter-accent' as string]: lift(c.accent) }}
            >
              <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: c.accent }} />
              <span>{c.label}</span>
              <span className="tabular-nums" style={{ color: lift(c.accent) }}>{n}</span>
            </button>
          )
        })}
      </div>

      {(completedCount != null || raisedCount != null) && (
        <div role="toolbar" aria-label="Board destinations" className="ml-auto flex min-w-max items-center gap-1.5 border-l border-[var(--line)] pl-3">
          {raisedCount != null && (
            <button
              type="button"
              onClick={onOpenRaised}
              title={`Tickets you raised (sub-tickets excluded) — ${raisedCount.open} of ${raisedCount.total} still open. See each one's status, who holds it now, and every hand-off.`}
              className="jb-filter-button inline-flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-semibold"
              style={{ ['--filter-accent' as string]: lift(RAISED) }}
            >
              <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: RAISED }} />
              <span>Raised</span>
              <span className="tabular-nums" style={{ color: lift(RAISED) }}>{raisedCount.open}</span>
              <span className="-ml-0.5 text-[11px] tabular-nums opacity-60">/ {raisedCount.total}</span>
            </button>
          )}

          {completedCount != null && takenCount && takenCount.total > 0 && (
            <button
              type="button"
              onClick={() => onOpenCompleted?.({ taken: true })}
              title={`${takenCount.total} ticket${takenCount.total === 1 ? ' was' : 's were'} assigned to you and then taken away (un-assigned, reassigned, called off or its PR declined) — ${takenCount.worked} of them after you had worked on ${takenCount.worked === 1 ? 'it' : 'them'}. They are listed in Completed with the reason.`}
              className="jb-filter-button inline-flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-semibold"
              style={{ ['--filter-accent' as string]: lift(TAKEN) }}
              data-taken-chip
            >
              <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: TAKEN }} />
              <span>Taken from you</span>
              <span className="tabular-nums" style={{ color: lift(TAKEN) }}>{takenCount.total}</span>
            </button>
          )}

          {completedCount != null && (
            <button
              type="button"
              onClick={() => onOpenCompleted?.()}
              title="View all completed tickets"
              className="jb-filter-button inline-flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-semibold"
              style={{ ['--filter-accent' as string]: 'var(--muted)' }}
            >
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[var(--muted)]" />
              <span>Completed</span>
              <span className="tabular-nums">{completedCount}</span>
            </button>
          )}
        </div>
      )}
    </nav>
  )
})
