import { memo, useEffect, useState } from 'react'
import { motion, useSpring } from 'motion/react'
import { BOARD_COLUMNS } from '../../lib/columns'
import type { ColumnKey, Ticket } from '../../types'

import { MegaphoneIcon, MoveIcon, TrophyIcon, TicketGlyph } from '../common/Icons'
import { TAKEN_COLOR as TAKEN } from '../../lib/taken'
import { lift, selectedText, tint } from '../../lib/tone'
import { PRESS, PRESS_SCALE } from '../../lib/motion'

// Identity of the Raised-by-me view — indigo, deliberately not a red/alarm family.
const RAISED = '#6366f1'

/**
 * What the top chip row currently has selected. A column key filters the board to that column;
 * null is "All" — the whole board, selected by default. Picking a column chip again returns to All.
 */
export type StatSelection = ColumnKey | null

const COUNT = new Intl.NumberFormat()

function AnimatedNumber({ value }: { value: number }) {
  const spring = useSpring(value, { stiffness: 110, damping: 22 })
  const [display, setDisplay] = useState(value)
  useEffect(() => {
    spring.set(value)
  }, [value, spring])
  useEffect(() => spring.on('change', (v) => setDisplay(Math.round(v))), [spring])
  return <span className="tabular-nums">{COUNT.format(display)}</span>
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
    // Above the board's scroll area: the gold trophy's glow reaches past this row's margin, and the board
    // (painted later) would otherwise cut it off in a straight line along the lane titles.
    // Inset a little inside the header and footer (which run to the shell's edge): same side padding as the board below.
    <div className="relative z-[25] mb-4 flex flex-wrap items-center gap-2 px-3">
      <div role="toolbar" aria-label="Board filters" className="contents">
      {/* "All" — the whole board; first in the row and selected by default. */}
      <button
        type="button"
        onClick={() => onSelect(null)}
        aria-pressed={active === null}
        title="Show every column"
        className={`jb-raise flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-semibold transition-[background-color,border-color,color] duration-150 ${
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
            whileHover={{ y: -1 }}
            whileTap={{ scale: PRESS_SCALE }}
            transition={PRESS}
            type="button"
            aria-pressed={isActive}
            onClick={() => onSelect(isActive ? null : c.key)}
            className="jb-raise flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-semibold transition-colors"
            style={{
              ['--hue' as string]: c.accent,
              borderColor: isActive ? lift(c.accent) : 'var(--line)',
              background: isActive ? tint(c.accent, 0.16) : 'var(--surface-solid)',
              color: isActive ? selectedText(c.accent) : 'var(--ink-soft)',
              boxShadow: isActive ? `0 0 0 1px ${tint(c.accent, 0.55)}` : 'none',
            }}
          >
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: c.accent }} />
            {c.label}
            <b style={{ color: lift(c.accent) }}>
              <AnimatedNumber value={n} />
            </b>
          </motion.button>
        )
      })}
      </div>

      {(completedCount != null || raisedCount != null) && (
        <div role="toolbar" aria-label="Board destinations" className="ml-auto flex flex-wrap items-center gap-2">
          {/* Deliberately quieter than the gold Completed trophy: the board's flat chip
              pattern (thin outline, tinted fill) in the view's indigo. open/total because
              "still needs fixing" is the number this view exists for. */}
          {raisedCount != null && (
            <motion.button
              whileHover={{ y: -1 }}
              whileTap={{ scale: PRESS_SCALE }}
              transition={PRESS}
              onClick={onOpenRaised}
              title={`Tickets you raised (sub-tickets excluded) — ${raisedCount.open} of ${raisedCount.total} still open. See each one's status, who holds it now, and every hand-off.`}
              className="jb-raise inline-flex h-8 items-center gap-1.5 rounded-full border px-3.5 text-[11.5px] font-bold transition-colors"
              style={{ ['--hue' as string]: RAISED, borderColor: tint(RAISED, 0.45), color: lift(RAISED), background: tint(RAISED, 0.07) }}
            >
              <MegaphoneIcon size={13} color={lift(RAISED)} />
              Raised{' '}
              <b className="tabular-nums">
                <AnimatedNumber value={raisedCount.open} />
              </b>
              <span className="-ml-0.5 text-[10px] font-semibold tabular-nums opacity-60">/ {COUNT.format(raisedCount.total)}</span>
            </motion.button>
          )}

          {/* Where the tickets taken from me live: in Completed, with a pill each. Quiet flat chip in the taken orange. */}
          {completedCount != null && takenCount && takenCount.total > 0 && (
            <motion.button
              whileHover={{ y: -1 }}
              whileTap={{ scale: PRESS_SCALE }}
              transition={PRESS}
              onClick={() => onOpenCompleted?.({ taken: true })}
              title={`${takenCount.total} ticket${takenCount.total === 1 ? ' was' : 's were'} assigned to you and then taken away (un-assigned, reassigned, called off or its PR declined) — ${takenCount.worked} of them after you had worked on ${takenCount.worked === 1 ? 'it' : 'them'}. They are listed in Completed with the reason.`}
              className="jb-raise inline-flex h-8 items-center gap-1.5 rounded-full border px-3.5 text-[11.5px] font-bold transition-colors"
              style={{ ['--hue' as string]: TAKEN, borderColor: tint(TAKEN, 0.5), color: `color-mix(in srgb, ${lift(TAKEN)} 60%, var(--ink))`, background: tint(TAKEN, 0.1) }}
              data-taken-chip
            >
              <MoveIcon size={12} color="currentColor" /> Taken from you{' '}
              <b>
                <AnimatedNumber value={takenCount.total} />
              </b>
            </motion.button>
          )}

          {completedCount != null && (
            <motion.button
              whileTap={{ scale: PRESS_SCALE }}
              transition={PRESS}
              onClick={() => onOpenCompleted?.()}
              title="View all completed tickets"
              className="gold-sheen inline-flex h-11 items-center rounded-full border-[3px] px-3.5 text-[14.5px] font-extrabold text-[#5b3d00]"
              style={{ borderColor: '#b45309' }}
            >
              <span className="relative z-[1] inline-flex items-center gap-2">
                <TrophyIcon size={18} glint /> Completed{' '}
                <b>
                  <AnimatedNumber value={completedCount} />
                </b>
              </span>
            </motion.button>
          )}
        </div>
      )}

      <Spectrum tickets={tickets} hideBlocked={hideBlocked} counts={counts} />
    </div>
  )
})

/**
 * The board as one bar: a segment per column in its own colour, sized by how many tickets sit there — where the work is,
 * at a glance. Built from the chips' own counts (On Hold inside Blocked), so it adds up to All.
 */
function Spectrum({ tickets, hideBlocked, counts }: { tickets: Ticket[]; hideBlocked: boolean; counts: (k: ColumnKey) => number }) {
  if (tickets.length === 0) return null
  const parts = BOARD_COLUMNS.filter((c) => !(hideBlocked && c.key === 'blocked'))
    .map((c) => ({ c, n: counts(c.key) }))
    .filter((p) => p.n > 0)
  const total = parts.reduce((s, p) => s + p.n, 0)
  if (total === 0) return null
  const summary = parts.map((p) => `${p.c.label} ${p.n}`).join(', ')
  return (
    <div role="img" aria-label={`Where the work is: ${summary}`} className="flex h-1.5 basis-full gap-[3px] overflow-hidden rounded-full" data-spectrum>
      {parts.map(({ c, n }) => (
        <span
          key={c.key}
          title={`${c.label}: ${n} of ${total}`}
          className="h-full min-w-[6px] rounded-full"
          style={{
            flexGrow: n,
            flexBasis: 0,
            background: `linear-gradient(90deg, ${c.accent}, color-mix(in srgb, ${c.accent} 70%, #ffffff))`,
            boxShadow: `0 1px 4px -1px ${tint(c.accent, 0.6)}`,
          }}
        />
      ))}
    </div>
  )
}
