import type { CSSProperties, ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'

import { shortReason, type MoveCheck } from '../../lib/moveRules'
import { lift, tint } from '../../lib/tone'
import { LAYOUT } from '../../lib/motion'

// Pieces every space on the board shares — a column, the On Hold space under Blocked, an empty
// column's rail or drop zone — so they cannot drift apart in size or colour.

/** A dashed drop box: faint at rest, lit while a card hovers it. */
export function dropBoxStyle(accent: string, active: boolean): CSSProperties {
  return {
    borderColor: active ? tint(accent, 0.72) : 'var(--line)',
    background: active ? tint(accent, 0.1) : 'transparent',
    boxShadow: active ? `0 0 0 2px ${tint(accent, 0.16)}` : undefined,
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

/**
 * A space's header: inline icon, uppercase label, count. `folded` keeps only the icon (a rail). While a card is dragged, a
 * space that will not take it says WHY from its header (`denied` → `DeniedChip`, a callout floating just below the title) —
 * never as a banner in the box below, which pushed every card down by its height the moment a drag started.
 */
export function SpaceHeader({
  accent,
  icon,
  label,
  count,
  folded = false,
  title,
  denied = null,
  alt = false,
  active = false,
}: {
  accent: string
  icon: ReactNode
  label: string
  /** Omitted while an empty column is a drop zone — "0" would only add noise. */
  count?: number
  folded?: boolean
  title?: string
  /** Why the card being dragged may not land here; shown in place of the count. */
  denied?: MoveCheck | null
  /** ⌥ is held (a gate can then be forced). */
  alt?: boolean
  /** The pointer is on this space right now (whether or not it will take the card). */
  active?: boolean
}) {
  return (
    <header className="relative mb-2 flex h-6 items-center gap-2 px-1">
      <span className="inline-flex shrink-0 items-center justify-center" title={title}>
        {icon}
      </span>
      <AnimatePresence initial={false}>
        {!folded && (
          <motion.div key="label" className="flex min-w-0 flex-1 items-center gap-2" initial={false}>
            <h2 className="truncate text-[11px] font-bold uppercase tracking-wider text-[var(--ink-soft)]">
              {label}
            </h2>
            {count !== undefined && <CountPill accent={accent} count={count} />}
          </motion.div>
        )}
      </AnimatePresence>
      {denied && !folded && <DeniedChip check={denied} alt={alt} active={active} />}
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
          transition={LAYOUT}
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
 * way; a PR / QA gate (⌥ passes it) less, and not at all while ⌥ has armed it under the pointer.
 */
export function deniedOpacity(denied: MoveCheck | null | undefined, active = false): number {
  if (!denied) return 1
  if (denied.kind === 'lane') return 0.4
  return active ? 1 : 0.72
}

const LANE_RED = '#e11d48'
const GATE_AMBER = '#d97706'

/**
 * The header form of `DeniedNote`: a small callout that hangs just below a space's title while a card is dragged. It is
 * absolutely positioned — it floats over the top of the (dimmed, refusing) space instead of taking room — so it never
 * pushes a card down. Its text is the refusal's SHORT form (`MoveCheck.short`: "No PR and QA ticket found", "#412 still
 * open"), written to fit one line of a ~180px lane; it still wraps rather than truncating if a lane is narrower. A gate
 * is amber (red = never allowed); the lane under the pointer adds "Hold ⌥ to move anyway", and says "Release to move
 * anyway" once ⌥ has armed it — the instruction only where it is needed, since on every lane it would double the height.
 * Clicks and drags pass through it to the space underneath.
 */
export function DeniedChip({ check, alt, active }: { check: MoveCheck; alt: boolean; active: boolean }) {
  const gate = check.kind === 'gate'
  const color = gate ? GATE_AMBER : LANE_RED
  const armed = gate && active && alt
  return (
    <motion.span
      role="note"
      title={gate ? `${check.reason ?? ''} Hold ⌥ (Option) while dropping to move it anyway.`.trim() : (check.reason ?? undefined)}
      initial={{ opacity: 0, y: -3 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      className="jb-float pointer-events-none absolute inset-x-0 top-[calc(100%+4px)] z-30 flex flex-wrap items-center justify-center gap-x-1.5 gap-y-0.5 rounded-lg border px-1.5 py-[3px] text-center text-[10.5px] font-bold leading-snug shadow-lg"
      style={{ borderColor: tint(color, 0.5), color: lift(color) }}
    >
      <span className="[overflow-wrap:anywhere]">{armed ? 'Release to move anyway' : shortReason(check)}</span>
      {/* The instruction goes only where the pointer is: on every lane it would double the note's height. */}
      {gate && active && !alt && <span className="w-full text-[9.5px] font-semibold opacity-85">Hold ⌥ to move anyway</span>}
    </motion.span>
  )
}

/**
 * A PR / QA gate can be passed on purpose: hold ⌥ (Option) while dropping. The hint is a ⌥ key cap and a soft "anyway" —
 * the same words as the toast's "Move anyway" button, so the board speaks one language about it — on the reason's own line
 * where it fits (wrapping, not truncating, where it doesn't). Holding ⌥ turns the note into "Release to move anyway".
 */
function AnywayHint({ color }: { color: string }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-[9.5px] font-semibold opacity-85" aria-label="hold Option while dropping to move anyway">
      <kbd className="rounded border px-[3px] font-sans text-[9.5px] leading-[12px]" style={{ borderColor: tint(color, 0.5) }}>
        ⌥
      </kbd>
      anyway
    </span>
  )
}

/** Says why a zone will not take the dragged card — and, for a gate, that ⌥ moves it anyway. */
export function DeniedNote({ check, alt, active, inline = false }: { check: MoveCheck; alt: boolean; active: boolean; inline?: boolean }) {
  const gate = check.kind === 'gate'
  const color = gate ? GATE_AMBER : LANE_RED
  return (
    <div
      role="note"
      className={`${inline ? '' : 'mb-1'} flex flex-col items-center gap-0.5 rounded-lg border px-2 py-1 text-center leading-tight`}
      style={{ borderColor: tint(color, 0.4), background: tint(color, 0.08), color: lift(color) }}
    >
      <span className="text-[10.5px] font-bold">{gate && active && alt ? 'Release to move anyway' : shortReason(check)}</span>
      {gate && !(active && alt) && <AnywayHint color={color} />}
    </div>
  )
}
