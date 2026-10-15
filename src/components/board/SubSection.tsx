import { memo, type ReactNode } from 'react'
import { AnimatePresence } from 'motion/react'
import type { Ticket } from '../../types'
import type { MoveCheck } from '../../lib/moveRules'
import { DeniedSlot, LandingSlot, SpaceHeader, deniedOpacity, dropBoxStyle } from './boardParts'
import { lift } from '../../lib/tone'

/**
 * A second, separate space under a column's own box, in the same column: On Hold under Blocked,
 * QA In Progress under QA. Its own header and its own box, never nested inside the column's; slim
 * when empty. Both (On Hold, QA In Progress) are drop targets — the Column's one set of drag listeners
 * tells them apart (`data-drop`) — and each dims, saying why, when the ticket being dragged may not go there.
 */
export const SubSection = memo(function SubSection({
  id,
  label,
  accent,
  icon,
  tickets,
  card,
  over,
  dragging,
  droppable,
  denied = null,
  alt = false,
  texts,
  hint,
  bare = false,
  captionOf,
}: {
  /** Drop-target id, matched by Column's `targetOf` (droppable sections only). */
  id: string
  label: string
  accent: string
  icon: ReactNode
  tickets: Ticket[]
  /** The column's card renderer, so cards here look and behave like every other card. */
  card: (t: Ticket) => ReactNode
  /** A card is hovering this section. */
  over: boolean
  /** A card is being dragged somewhere on the board. */
  dragging: boolean
  droppable: boolean
  /** Why the ticket being dragged may not be dropped here (lib/moveRules.ts): dim it and say why. */
  denied?: MoveCheck | null
  /** ⌥ is held: a gated section can be forced. */
  alt?: boolean
  texts: { idle: string; dragging: string; slot: string }
  /** Tooltip while empty. */
  hint?: string
  /** The column already wears this space's header (its own box is off): no second header, fill the column. */
  bare?: boolean
  /** A line above the first ticket of each run that shares a caption (Next Sprint: the sprint and when it starts). Tickets must already be grouped. */
  captionOf?: (t: Ticket) => { text: string; detail?: string } | null
}) {
  const empty = tickets.length === 0
  // Consecutive tickets with the same caption form one group; without captions it is one plain group.
  const groups: { cap: { text: string; detail?: string } | null; tickets: Ticket[] }[] = []
  for (const t of tickets) {
    const cap = captionOf?.(t) ?? null
    const last = groups[groups.length - 1]
    if (last && last.cap?.text === cap?.text) last.tickets.push(t)
    else groups.push({ cap, tickets: [t] })
  }
  return (
    <div
      data-drop={droppable ? id : undefined}
      role="group"
      className={bare ? 'flex flex-1 flex-col' : undefined}
      aria-label={`${label} · ${tickets.length}${droppable && dragging ? ' — drop here' : ''}`}
    >
      {!bare && <SpaceHeader accent={accent} icon={icon} label={label} count={tickets.length} />}
      <div
        className={`flex flex-col gap-2 ${bare ? 'flex-1' : ''} rounded-2xl border border-dashed p-2 transition-[background,border-color,box-shadow,opacity] duration-150`}
        title={denied?.reason ?? (empty ? hint : undefined)}
        style={{ ...dropBoxStyle(accent, droppable && over), opacity: deniedOpacity(denied, over) }}
      >
        <DeniedSlot check={denied} alt={alt} active={over} inline={empty} />
        {groups.map((g, i) => (
          <div key={g.cap?.text ?? `g${i}`} className="flex flex-col gap-2">
            {g.cap && (
              <div className="flex flex-wrap items-baseline gap-x-1.5 px-1 pt-0.5 text-[10.5px] font-semibold leading-tight" style={{ color: lift(accent) }}>
                <span className="min-w-0 break-words">{g.cap.text}</span>
                {g.cap.detail && <span className="font-medium text-[var(--muted)]">· {g.cap.detail}</span>}
              </div>
            )}
            <AnimatePresence mode="popLayout" initial={false}>
              {g.tickets.map(card)}
            </AnimatePresence>
          </div>
        ))}
        {droppable && <LandingSlot accent={accent} show={over} label={texts.slot} />}
        {empty && !denied && !(droppable && over) && (
          <div className="flex items-center justify-center py-2.5 text-center text-[11px] italic" style={{ color: droppable && dragging ? lift(accent) : 'var(--muted)' }}>
            {dragging ? texts.dragging : texts.idle}
          </div>
        )}
      </div>
    </div>
  )
})
