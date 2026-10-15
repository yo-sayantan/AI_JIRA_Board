import type { CSSProperties, ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'

import { shortReason, type MoveCheck } from '../../lib/moveRules'
import { lift, tint } from '../../lib/tone'

// Pieces every space on the board shares — a column, the On Hold space under Blocked, an empty
// column's rail or drop zone — so they cannot drift apart in size or colour.

export const SPRING = { type: 'spring', stiffness: 300, damping: 30 } as const

/** A dashed drop box: faint at rest, lit while a card hovers it. */
export function dropBoxStyle(accent: string, active: boolean): CSSProperties {
  return {
    borderColor: tint(accent, active ? 0.72 : 0.26),
    background: tint(accent, active ? 0.13 : 0.045),
    boxShadow: active ? `0 0 0 3px ${tint(accent, 0.18)}, 0 12px 28px -16px ${tint(accent, 0.5)}` : undefined,
  }
}

export function CountPill({ accent, count }: { accent: string; count: number }) {
  return (
    <span
      className="ml-auto min-w-[22px] rounded-full px-1.5 py-0.5 text-center text-[11px] font-bold tabular-nums"
      style={{ color: lift(accent), background: tint(accent, 0.14) }}
    >
      {count}
    </span>
  )
}

/** A space's header: icon chip, uppercase label, count. `folded` keeps only the icon (a rail). */
export function SpaceHeader({
  accent,
  icon,
  label,
  count,
  folded = false,
  title,
}: {
  accent: string
  icon: ReactNode
  label: string
  /** Omitted while an empty column is a drop zone — "0" would only add noise. */
  count?: number
  folded?: boolean
  title?: string
}) {
  return (
    <header className="mb-2 flex h-5 items-center gap-2 px-1">
      <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md" style={{ background: tint(accent, 0.16) }} title={title}>
        {icon}
      </span>
      <AnimatePresence initial={false}>
        {!folded && (
          <motion.span
            key="label"
            className="flex min-w-0 flex-1 items-center gap-2"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
          >
            <span className="truncate text-[11px] font-bold uppercase tracking-wider" style={{ color: lift(accent) }}>
              {label}
            </span>
            {count !== undefined && <CountPill accent={accent} count={count} />}
          </motion.span>
        )}
      </AnimatePresence>
    </header>
  )
}

/** Where a hovering card will land: the bottom of the space, labelled with what the drop does. */
export function LandingSlot({ accent, show, label }: { accent: string; show: boolean; label: string }) {
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div
          key="slot"
          layout
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 44 }}
          exit={{ opacity: 0, height: 0 }}
          transition={SPRING}
          className="flex items-center justify-center overflow-hidden rounded-xl border-2 border-dashed text-[11px] font-semibold"
          style={{ borderColor: tint(accent, 0.55), background: tint(accent, 0.1), color: lift(accent) }}
        >
          {label}
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/**
 * How far a refusing zone fades while a card is dragged: the QA lane (never possible) almost out of the
 * way; a PR / QA gate (⌥ forces it) less, and not at all while ⌥ has armed it under the pointer.
 */
export function deniedOpacity(denied: MoveCheck | null | undefined, active = false): number {
  if (!denied) return 1
  if (denied.kind === 'lane') return 0.4
  return active ? 1 : 0.72
}

const LANE_RED = '#e11d48'
const GATE_AMBER = '#d97706'

/** Says why a zone will not take the dragged card — and, for a gate, that ⌥ forces it. */
export function DeniedNote({ check, alt, active, inline = false }: { check: MoveCheck; alt: boolean; active: boolean; inline?: boolean }) {
  const gate = check.kind === 'gate'
  const color = gate ? GATE_AMBER : LANE_RED
  return (
    <div
      role="note"
      className={`${inline ? '' : 'mb-1'} flex flex-col items-center gap-0.5 rounded-lg border px-2 py-1 text-center leading-tight`}
      style={{ borderColor: tint(color, 0.4), background: tint(color, 0.08), color: lift(color) }}
    >
      <span className="text-[10.5px] font-bold">{gate && active && alt ? 'Release to force' : shortReason(check)}</span>
      {gate && !(active && alt) && <span className="text-[9.5px] font-semibold opacity-80">⌥ + drop to force</span>}
    </div>
  )
}
