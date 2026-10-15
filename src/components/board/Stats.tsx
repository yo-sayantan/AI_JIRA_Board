import { memo, useEffect, useState } from 'react'
import { motion, useSpring } from 'motion/react'
import { BOARD_COLUMNS } from '../../lib/columns'
import type { ColumnKey, Ticket } from '../../types'
import { hexToRgba } from '../../lib/format'
import { MegaphoneIcon, TrophyIcon, TicketGlyph } from '../common/Icons'

// Identity of the Raised-by-me view — indigo, deliberately not a red/alarm family.
const RAISED = '#6366f1'

/**
 * What the top chip row currently has selected. A column key filters the board to that column;
 * null is "All" — the whole board, selected by default. Picking a column chip again returns to All.
 */
export type StatSelection = ColumnKey | null

function AnimatedNumber({ value }: { value: number }) {
  const spring = useSpring(value, { stiffness: 110, damping: 22 })
  const [display, setDisplay] = useState(value)
  useEffect(() => {
    spring.set(value)
  }, [value, spring])
  useEffect(() => spring.on('change', (v) => setDisplay(Math.round(v))), [spring])
  return <span className="tabular-nums">{display}</span>
}

export const Stats = memo(function Stats({
  tickets,
  hideBlocked = false,
  completedCount,
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
  /** Tickets I reported: open/total. null hides the chip (feature off or nothing raised). */
  raisedCount: { total: number; open: number } | null
  active: StatSelection
  onSelect: (key: StatSelection) => void
  onOpenCompleted?: () => void
  onOpenRaised?: () => void
}) {
  const counts = (k: ColumnKey) => tickets.filter((t) => t.column === k).length
  const total = tickets.length

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      {/* "All" — the whole board; first in the row and selected by default. */}
      <button
        onClick={() => onSelect(null)}
        aria-pressed={active === null}
        title="Show every column"
        className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-semibold transition-all ${
          active === null
            ? 'border-transparent bg-[var(--ink)] text-[var(--bg)]'
            : 'border-[var(--line)] bg-[var(--surface-solid)] text-[var(--ink-soft)] hover:border-[var(--muted)]'
        }`}
      >
        <TicketGlyph size={13} /> All <b className="tabular-nums"><AnimatedNumber value={total} /></b>
      </button>

      {BOARD_COLUMNS.filter((c) => !(hideBlocked && c.key === 'blocked')).map((c) => {
        const n = counts(c.key)
        const isActive = active === c.key
        return (
          <motion.button
            key={c.key}
            whileHover={{ scale: 1.05, y: -1 }}
            whileTap={{ scale: 0.95 }}
            transition={{ type: 'spring', stiffness: 400, damping: 22 }}
            onClick={() => onSelect(isActive ? null : c.key)}
            className="flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-semibold transition-colors"
            style={{
              borderColor: isActive ? c.accent : 'var(--line)',
              background: isActive ? hexToRgba(c.accent, 0.16) : 'var(--surface-solid)',
              color: isActive ? c.accent : 'var(--ink-soft)',
              boxShadow: isActive ? `0 0 0 1px ${hexToRgba(c.accent, 0.4)}` : 'none',
            }}
          >
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: c.accent }} />
            {c.label}
            <b style={{ color: c.accent }}>
              <AnimatedNumber value={n} />
            </b>
          </motion.button>
        )
      })}

      {(completedCount != null || raisedCount != null) && (
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {/* Deliberately quieter than the gold Completed trophy: the board's flat chip
              pattern (thin outline, tinted fill) in the view's indigo. open/total because
              "still needs fixing" is the number this view exists for. */}
          {raisedCount != null && (
            <motion.button
              whileHover={{ scale: 1.03, y: -1 }}
              whileTap={{ scale: 0.96 }}
              transition={{ type: 'spring', stiffness: 400, damping: 22 }}
              onClick={onOpenRaised}
              title={`Tickets you raised (sub-tickets excluded) — ${raisedCount.open} of ${raisedCount.total} still open. See each one's status, who holds it now, and every hand-off.`}
              className="inline-flex items-center gap-1.5 rounded-full border px-3.5 py-[7.5px] text-[12.5px] font-bold transition-colors"
              style={{ borderColor: hexToRgba(RAISED, 0.45), color: RAISED, background: hexToRgba(RAISED, 0.07) }}
            >
              <MegaphoneIcon size={14} color={RAISED} />
              Raised{' '}
              <b className="tabular-nums">
                <AnimatedNumber value={raisedCount.open} />
              </b>
              <span className="-ml-0.5 text-[11px] font-semibold tabular-nums opacity-60">/ {raisedCount.total}</span>
            </motion.button>
          )}

          {completedCount != null && (
            <motion.button
              whileTap={{ scale: 0.97 }}
              transition={{ type: 'spring', stiffness: 400, damping: 22 }}
              onClick={onOpenCompleted}
              title="View all completed tickets"
              className="gold-sheen inline-flex items-center rounded-full border-[3px] px-4 py-2 text-[13.5px] font-extrabold text-[#5b3d00]"
              style={{ borderColor: '#b45309' }}
            >
              <span className="relative z-[1] inline-flex items-center gap-2">
                <TrophyIcon size={16} glint /> Completed{' '}
                <b>
                  <AnimatedNumber value={completedCount} />
                </b>
              </span>
            </motion.button>
          )}
        </div>
      )}
    </div>
  )
})
