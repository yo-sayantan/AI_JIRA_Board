import { memo, useRef, useState, type DragEvent, type Ref } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { HOLD_COLUMN, NEXT_SPRINT_SECTION, QA_IN_PROGRESS, columnMode, columnWidth, isQaInProgress, type ColumnMeta, type MoveTarget } from '../../lib/columns'
import { MOVE_OK, checkMove, readinessOf, type MoveCheck, type TicketLookup } from '../../lib/moveRules'
import type { Ticket } from '../../types'
import { DRAG_MIME, TicketCard } from './TicketCard'
import { futureSprintOf, sprintWhen } from '../../lib/format'
import { CalendarIcon, ColumnIcon, PauseIcon } from '../common/Icons'
import { SubSection } from './SubSection'
import { DeniedNote, DeniedSlot, LandingSlot, SpaceHeader, dropBoxStyle, deniedOpacity } from './boardParts'
import { lift, tint } from '../../lib/tone'

/** Which of a column's drop targets a card is over: the column itself, or its second space. */
type DropTarget = 'col' | 'sub'

/** The second space in a column: On Hold under Blocked, QA In Progress under QA, Next Sprint at the end of To Do. */
interface Sub {
  id: 'hold' | 'qaip' | 'next'
  label: string
  accent: string
  droppable: boolean
}
const SUB_HOLD: Sub = { id: 'hold', label: HOLD_COLUMN.label, accent: HOLD_COLUMN.accent, droppable: true }
const SUB_QAIP: Sub = { id: 'qaip', label: QA_IN_PROGRESS.label, accent: QA_IN_PROGRESS.accent, droppable: true }
const SUB_NEXT: Sub = { id: 'next', label: NEXT_SPRINT_SECTION.label, accent: NEXT_SPRINT_SECTION.accent, droppable: true }
const SUB_TEXTS = {
  hold: { idle: 'Nothing on hold', dragging: 'Drop here to put on hold', slot: 'Drop to put on hold' },
  qaip: { idle: 'Nobody testing yet', dragging: 'Drop here to mark as in QA', slot: 'Drop to move to QA In Progress' },
  next: { idle: 'Nothing queued', dragging: 'Drop here to queue for next sprint', slot: 'Drop to move to Next Sprint' },
} as const

const SUB_HINTS = {
  hold: 'Drag a card here to put it on hold in Jira.',
  qaip: 'QA tickets being tested. Only QA tickets can be dropped here.',
  next: 'Drag a card here to queue it for the next sprint (To Do, Blocked, QA and On Hold tickets only).',
} as const

function SubIcon({ sub, size, color }: { sub: Sub; size: number; color?: string }) {
  const c = color ?? sub.accent
  return sub.id === 'hold' ? <PauseIcon size={size} color={lift(c)} /> : sub.id === 'next' ? <CalendarIcon size={size} color={lift(c)} /> : <ColumnIcon col="qa" color={lift(c)} size={size} />
}

export const Column = memo(function Column({
  meta,
  tickets,
  now,
  onOpen,
  onArchive,
  onRefreshTicket,
  refreshingKeys,
  onMove,
  movingKeys,
  dragActive = false,
  calm = false,
  dragged,
  focused = false,
  held,
  queued,
  hideOwn = false,
  showQaInProgress = true,
  lookup,
  readiness = false,
}: {
  meta: ColumnMeta
  tickets: Ticket[]
  now: number
  onOpen: (key: string) => void
  onArchive?: (key: string) => void
  onRefreshTicket?: (key: string) => void
  refreshingKeys?: ReadonlySet<string>
  /** Drop handler: the dragged ticket should take this column's status (or On Hold) in Jira. `force`: ⌥ past a gate. */
  onMove?: (key: string, to: MoveTarget, force?: boolean) => void
  movingKeys?: ReadonlySet<string>
  /** A card is being dragged somewhere on the board. */
  dragActive?: boolean
  /** A drag is in flight or has only just ended: cards hold still instead of animating their position. */
  calm?: boolean
  /** The ticket being dragged, so zones it may not be dropped on can say why (lib/moveRules.ts). */
  dragged?: Ticket
  /** This is the only column shown (a stat chip filtered the board to it). */
  focused?: boolean
  /** Blocked only: the On Hold space's tickets. Undefined = no On Hold space (Settings → On Hold off). */
  held?: Ticket[]
  /** To Do only: tickets whose sprint has not started, as a space at the end of the column (a drop target). Undefined = Settings → Next Sprint is off. */
  queued?: Ticket[]
  /** Settings → Blocked off while On Hold is on: the column is just the On Hold space, no Blocked box. */
  hideOwn?: boolean
  /** Settings → QA In Progress off: no second space under QA. */
  showQaInProgress?: boolean
  /** Every ticket the board knows, for the move rules (a sub-ticket's parent). */
  lookup?: TicketLookup
  /** Draw the In Review / Done readiness dots on cards. */
  readiness?: boolean
}) {
  // QA's cards split in two spaces: waiting for QA (the column's own box) and picked up by QA.
  const inProgress = meta.key === 'qa' ? tickets.filter((t) => isQaInProgress(t.status)) : []
  const own = meta.key === 'qa' ? tickets.filter((t) => !isQaInProgress(t.status)) : tickets
  const sub: Sub | null =
    meta.key === 'qa' ? (showQaInProgress ? SUB_QAIP : null) : meta.key === 'blocked' && held !== undefined ? SUB_HOLD : meta.key === 'todo' && queued !== undefined ? SUB_NEXT : null
  const subTickets = sub?.id === 'hold' ? (held ?? []) : sub?.id === 'next' ? (queued ?? []) : inProgress
  // With its own box off, the column IS its second space: it wears that space's header and fills with it.
  const ownOff = hideOwn && sub?.id === 'hold'

  // The column's own box, whatever the mode draws it as. With a droppable second space, the pointer is
  // on it when inside it or anywhere BELOW the column's own box — so the blank part of the column under
  // it is never a surprise "Blocked". The line moves with the landing slot, which keeps the target
  // steady at the boundary instead of flipping back and forth.
  const ownBox = useRef<HTMLDivElement>(null)
  const [over, setOver] = useState<DropTarget | null>(null)
  // Whether the ticket being dragged may land on each of this column's zones (lib/moveRules.ts). A zone
  // it may not use is dimmed and says why; it never arms, so the cursor shows "not allowed" instead of a
  // false promise — except a PR / QA gate with ⌥ held, which arms and forces (after a confirm).
  const ownTarget: MoveTarget = meta.key
  const checkFor = (target: MoveTarget): MoveCheck => (dragged ? checkMove(dragged, target, lookup) : MOVE_OK)
  const ownCheck = checkFor(ownTarget)
  const subCheck = sub ? checkFor(sub.id) : MOVE_OK
  const [alt, setAlt] = useState(false)
  const usable = (c: MoveCheck, altKey: boolean) => c.kind === null || (c.kind === 'gate' && altKey)
  const accepts = (e: DragEvent) => !!onMove && e.dataTransfer.types.includes(DRAG_MIME)
  const targetOf = (e: DragEvent): DropTarget => {
    if (ownOff) return 'sub'
    if (!sub?.droppable) return 'col'
    if ((e.target as Element | null)?.closest?.(`[data-drop="${sub.id}"]`)) return 'sub'
    const box = ownBox.current?.getBoundingClientRect()
    return box && box.height > 0 && e.clientY > box.bottom ? 'sub' : 'col'
  }
  // dragenter AND dragover both arm the target: a zone must light up the moment the pointer arrives,
  // not on the next dragover tick (Safari and Firefox ignore a drop target that never cancelled
  // dragenter, which showed as a lag before a drop would "take").
  const arm = (e: DragEvent) => {
    if (!accepts(e)) return
    const t = targetOf(e)
    setAlt((cur) => (cur === e.altKey ? cur : e.altKey))
    if (!usable(t === 'sub' ? subCheck : ownCheck, e.altKey)) {
      // Not allowed here: do not cancel the event, so the browser shows "no drop" and nothing highlights.
      setOver((cur) => (cur === null ? cur : null))
      return
    }
    e.preventDefault()
    // ⌥ held: macOS narrows the drag to a COPY, and a zone that still answers "move" can be refused before the
    // drop fires. The card allows copyMove and carries only the key, so a copy lands exactly like a move.
    e.dataTransfer.dropEffect = e.altKey ? 'copy' : 'move'
    setOver((cur) => (cur === t ? cur : t))
  }
  const onDragLeave = (e: DragEvent) => {
    // Still inside this column? Decided by position: relatedTarget is null in Safari and Firefox, which
    // used to clear the highlight on every child-element crossing and made zones flicker.
    const r = e.currentTarget.getBoundingClientRect()
    if (e.clientX > r.left && e.clientX < r.right && e.clientY > r.top && e.clientY < r.bottom) return
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
    setOver(null)
  }
  const onDrop = (e: DragEvent) => {
    if (!accepts(e)) return
    e.preventDefault()
    const where = targetOf(e)
    const to: MoveTarget = where === 'sub' && sub ? sub.id : ownTarget
    const c = where === 'sub' ? subCheck : ownCheck
    setOver(null)
    setAlt(false)
    if (!usable(c, e.altKey)) return
    const key = e.dataTransfer.getData(DRAG_MIME)
    if (key) onMove?.(key, to, c.kind === 'gate')
  }

  // An empty column has nothing to show: it folds to a rail and its width goes to the columns with
  // cards. While a card is dragged it opens only to a compact drop zone. A second space counts too.
  // A column the QA lane closes to the dragged ticket does not open as a drop zone — it stays out of the
  // way. A gated one does open: it says what is missing, and ⌥ can still force it.
  const dragging = !!onMove && (dragActive || over != null) && (ownCheck.kind !== 'lane' || subCheck.kind !== 'lane')
  const ownDenied = dragActive && ownCheck.kind ? ownCheck : null
  const subDenied = dragActive && subCheck.kind ? subCheck : null
  const mode = columnMode({ count: own.length, held: subTickets.length, focused, dragging })
  const dropLabel = meta.key === 'blocked' ? 'Drop to mark as Blocked' : `Drop to move to ${meta.label}`
  const emptyHint = meta.key === 'blocked' ? (dragging ? 'Drag a stuck card here' : 'Nothing blocked') : meta.key === 'qa' ? 'Nothing waiting for QA' : 'Nothing here'
  const name = ownOff ? sub!.label : sub ? `${meta.label} and ${sub.label}` : meta.label
  const stacked = !!sub && !ownOff

  // Next Sprint: which sprint each ticket waits for, and when it starts.
  const sprintCaption = (t: Ticket) => {
    const sp = futureSprintOf(t.sprint, now)
    return sp ? { text: sp.name, detail: sprintWhen(sp, now) } : null
  }
  const card = (t: Ticket) => {
    const r = readiness ? readinessOf(t, lookup) : null
    return (
    <TicketCard
      key={t.key}
      ticket={t}
      now={now}
      onOpen={onOpen}
      onArchive={onArchive}
      onRefreshTicket={onRefreshTicket}
      refreshing={refreshingKeys?.has(t.key)}
      // A Done ticket is final: not draggable at all (moveRules.laneBlocker refuses it too, and so does the server).
      draggable={!!onMove && t.column !== 'done'}
      calm={calm}
      moving={movingKeys?.has(t.key)}
      readyRev={r ? (r.rev ? r.rev.reason : undefined) : undefined}
      readyDone={r ? r.done.reason : undefined}
    />
    )
  }

  return (
    <section
      className={`jb-col jb-col-${mode} flex flex-col`}
      style={{ ...columnWidth(mode, { slim: meta.slim, calm }), marginInline: -6, paddingInline: 6 }}
      aria-label={
        mode === 'full'
          ? ownOff
            ? `${sub!.label} · ${subTickets.length}`
            : `${meta.label} · ${own.length}${sub ? ` · ${sub.label} · ${subTickets.length}` : ''}`
          : `${name} — empty${mode === 'drop' ? ', drop a card here' : ''}`
      }
      onDragEnter={arm}
      onDragOver={arm}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <SpaceHeader
        accent={ownOff ? sub!.accent : meta.accent}
        icon={ownOff ? <PauseIcon size={13} color={lift(sub!.accent)} /> : <ColumnIcon col={meta.key} color={lift(meta.accent)} size={13} />}
        label={ownOff ? sub!.label : meta.label}
        count={mode === 'full' ? (ownOff ? subTickets.length : own.length) : undefined}
        folded={mode === 'rail'}
        title={mode === 'rail' ? `${name} — empty. Drag a card here to move it in Jira.` : undefined}
      />

      {mode === 'rail' ? (
        <div className="flex flex-1 flex-col gap-3">
          {!ownOff && <RailBox boxRef={ownBox} accent={meta.accent} label={meta.label} stacked={stacked} />}
          {sub && <RailBox accent={sub.accent} label={sub.label} stacked={!ownOff} sub={sub} />}
        </div>
      ) : mode === 'drop' ? (
        <div className="flex flex-1 flex-col gap-2">
          {!ownOff && <DropZone boxRef={ownBox} accent={meta.accent} label={meta.label} active={over === 'col'} stacked={stacked} denied={ownDenied} alt={alt} />}
          {sub && <DropZone accent={sub.accent} label={sub.label} active={over === 'sub'} stacked={!ownOff} sub={sub} denied={subDenied} alt={alt} />}
        </div>
      ) : (
        <div className={`flex flex-1 flex-col ${stacked ? 'gap-4' : ''}`}>
          {/* The column's own box. Alone it fills the column's height, so a drop anywhere below the
              cards counts; with a second space it is sized to its cards and that space follows. */}
          {!ownOff && (
          <div
            ref={ownBox}
            className={`relative flex flex-col gap-2 rounded-2xl border border-dashed p-2 transition-[background,border-color,box-shadow] duration-150 ${stacked ? '' : 'flex-1'}`}
            style={{ ...dropBoxStyle(meta.accent, over === 'col'), opacity: deniedOpacity(ownDenied, over === 'col') }}
            title={ownDenied?.reason ?? undefined}
          >
            <DeniedSlot check={ownDenied} alt={alt} active={over === 'col'} />
            <AnimatePresence mode="popLayout" initial={false}>
              {own.map(card)}
            </AnimatePresence>
            <LandingSlot accent={meta.accent} show={over === 'col'} label={dropLabel} />
            {own.length === 0 && over !== 'col' && !ownDenied && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                // Compact when a second space follows: this part then has nothing to say.
                className={`flex items-center justify-center rounded-lg text-[11px] italic text-[var(--muted)] ${stacked ? 'py-3' : 'py-6'}`}
              >
                {emptyHint}
              </motion.div>
            )}
          </div>
          )}

          {/* The second space: its own header and box, slim when empty. */}
          {sub && (
            <SubSection
              id={sub.id}
              label={sub.label}
              accent={sub.accent}
              icon={<SubIcon sub={sub} size={12} />}
              tickets={subTickets}
              card={card}
              over={over === 'sub'}
              dragging={dragging}
              droppable={sub.droppable}
              denied={subDenied}
              alt={alt}
              bare={ownOff}
              texts={SUB_TEXTS[sub.id]}
              hint={SUB_HINTS[sub.id]}
              captionOf={sub.id === 'next' ? sprintCaption : undefined}
            />
          )}
        </div>
      )}
    </section>
  )
})

/**
 * One box of a folded column. Alone it fills the column; `stacked` (a column with a second space) gives
 * each box a fixed height at the top, so both stay on screen however tall the board is.
 */
function RailBox({ boxRef, accent, label, stacked, sub }: { boxRef?: Ref<HTMLDivElement>; accent: string; label: string; stacked: boolean; sub?: Sub }) {
  return (
    <div
      ref={boxRef}
      data-drop={sub?.droppable ? sub.id : undefined}
      className={`jb-rail-zone flex flex-col items-center gap-1.5 rounded-2xl border border-dashed py-2 ${stacked ? 'min-h-[132px]' : 'flex-1'}`}
      style={dropBoxStyle(accent, false)}
    >
      {sub && <SubIcon sub={sub} size={11} color={lift(accent)} />}
      <span className="text-[10px] font-bold uppercase tracking-[0.18em]" style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)', color: tint(accent, 0.85) }}>
        {label}
      </span>
    </div>
  )
}

/** An empty column during a drag: just wide enough to aim at, labelled with where the card goes. Same `stacked` rule as RailBox. */
function DropZone({
  boxRef,
  accent,
  label,
  active,
  stacked,
  sub,
  denied = null,
  alt = false,
}: {
  boxRef?: Ref<HTMLDivElement>
  accent: string
  label: string
  active: boolean
  stacked: boolean
  sub?: Sub
  /** Why the dragged ticket may not be dropped here (lib/moveRules.ts), or null. */
  denied?: MoveCheck | null
  /** ⌥ is held: a gated zone can be forced. */
  alt?: boolean
}) {
  return (
    <div
      ref={boxRef}
      data-drop={sub?.droppable ? sub.id : undefined}
      // The label sits near the top: on a tall board the middle of the column is below the fold.
      className={`flex flex-col items-center gap-1 rounded-2xl border-2 border-dashed px-1 text-center transition-[background,border-color,box-shadow,opacity] duration-150 ${stacked ? 'h-[132px] justify-center' : 'flex-1 justify-start pt-16'}`}
      style={{ ...dropBoxStyle(accent, active), opacity: deniedOpacity(denied, active) }}
      title={denied?.reason ?? undefined}
    >
      {sub && <SubIcon sub={sub} size={13} color={lift(accent)} />}
      {denied ? (
        <DeniedNote check={denied} alt={alt} active={active} inline />
      ) : (
        <span className="text-[11px] font-bold leading-tight" style={{ color: lift(accent) }}>
          {active ? 'Release' : 'Drop here'}
        </span>
      )}
      <span className="text-[10px] font-semibold uppercase leading-tight tracking-wider" style={{ color: tint(accent, 0.75) }}>
        {label}
      </span>
    </div>
  )
}
