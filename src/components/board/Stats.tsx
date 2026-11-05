import { memo } from 'react'
import { BOARD_COLUMNS } from '../../lib/columns'
import type { ColumnKey, Ticket } from '../../types'

import { MegaphoneIcon, MoveIcon, TrophyIcon, TicketGlyph } from '../common/Icons'

/**
 * What the top chip row currently has selected. A column key filters the board to that column;
 * null is "All" — the whole board, selected by default. Picking a column chip again returns to All.
 */
export type StatSelection = ColumnKey | null

const COUNT = new Intl.NumberFormat()

/** A count that updates in place, like a departure board: no ticker. */
function AnimatedNumber({ value }: { value: number }) {
  return <span className="tabular-nums">{COUNT.format(value)}</span>
}

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
  // On Hold is a space inside the Blocked column, so the Blocked chip counts it — the chips then add up to All.
  const counts = (k: ColumnKey) => tickets.filter((t) => t.column === k || (k === 'blocked' && t.column === 'hold')).length
  const total = tickets.length

  return (
    // Above the board's scroll area. Same side inset as the board below. The filters are a choice set of square cells
    // sharing their borders (Wayfind); the destinations sit at the right edge, Completed as an ink plate with its figure.
    <div className="relative z-[25] mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 px-3 text-[12px]">
      <div role="toolbar" aria-label="Board filters" className="wf-seg">
        {/* "All" — the whole board; first in the row and selected by default. */}
        <button type="button" onClick={() => onSelect(null)} aria-pressed={active === null} title="Show every column">
          <TicketGlyph size={13} /> All <b>
            <AnimatedNumber value={total} />
          </b>
        </button>

        {BOARD_COLUMNS.filter((c) => !(hideBlocked && c.key === 'blocked')).map((c) => {
          const isActive = active === c.key
          return (
            <button key={c.key} type="button" aria-pressed={isActive} onClick={() => onSelect(isActive ? null : c.key)}>
              <span aria-hidden className="wf-swatch" style={{ ['--sw' as string]: c.accent }} />
              {c.label}
              <b>
                <AnimatedNumber value={counts(c.key)} />
              </b>
            </button>
          )
        })}
      </div>

      {(completedCount != null || raisedCount != null) && (
        <div role="toolbar" aria-label="Board destinations" className="ml-auto flex flex-wrap items-center gap-2">
          {raisedCount != null && (
            <div className="wf-seg">
              <button
                type="button"
                onClick={onOpenRaised}
                title={`Tickets you raised (sub-tickets excluded) — ${raisedCount.open} of ${raisedCount.total} still open. See each one's status, who holds it now, and every hand-off.`}
              >
                <MegaphoneIcon size={13} color="currentColor" />
                Raised{' '}
                <b>
                  <AnimatedNumber value={raisedCount.open} />
                </b>
                <span className="-ml-1 text-[var(--muted)]">of {COUNT.format(raisedCount.total)}</span>
              </button>
            </div>
          )}

          {/* Where the tickets taken from me live: in Completed, with a pill each. */}
          {completedCount != null && takenCount && takenCount.total > 0 && (
            <div className="wf-seg">
              <button
                type="button"
                onClick={() => onOpenCompleted?.({ taken: true })}
                title={`${takenCount.total} ticket${takenCount.total === 1 ? ' was' : 's were'} assigned to you and then taken away (un-assigned, reassigned, called off or its PR declined) — ${takenCount.worked} of them after you had worked on ${takenCount.worked === 1 ? 'it' : 'them'}. They are listed in Completed with the reason.`}
                data-taken-chip
              >
                <MoveIcon size={12} color="currentColor" /> Taken from you{' '}
                <b>
                  <AnimatedNumber value={takenCount.total} />
                </b>
              </button>
            </div>
          )}

          {completedCount != null && (
            <button
              type="button"
              onClick={() => onOpenCompleted?.()}
              title="View all completed tickets"
              className="wf-plate wf-plate-btn inline-flex h-9 items-center gap-2 px-3 text-[13px] font-extrabold"
            >
              <TrophyIcon size={16} /> Completed{' '}
              <b className="wf-figure">
                <AnimatedNumber value={completedCount} />
              </b>
            </button>
          )}
        </div>
      )}
    </div>
  )
})
