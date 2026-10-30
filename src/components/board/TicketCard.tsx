import { memo, useEffect, useRef, useState } from 'react'
import { motion } from 'motion/react'
import type { Ticket } from '../../types'
import { COLUMN_META } from '../../lib/columns'
import { DONE_BOARD_DAYS } from '../../lib/appConfig'
import { priorityMeta, typeMeta, effectiveType, isClosedPr, prListOf, primaryPrOf, branchesOf, cardBranches, cardBuilds, envBuildCount, vulnFixesOf, relTime } from '../../lib/format'
import { Pill, PriorityGlyph, PrBadge, Approvals, PointsTag } from '../common/ui'
import { TypeIcon, RefreshIcon, TrophyIcon } from '../common/Icons'
import { BuildChip } from '../common/Builds'
import { VulnChip } from '../common/VulnFixes'
import { lift, tint } from '../../lib/tone'
import { EASE_OUT, LAYOUT, PRESS } from '../../lib/motion'

/** Days until this Done card auto-retires from the board into the Completed archive. */
function archivesInDays(t: Ticket, now: number): number | null {
  if (t.column !== 'done') return null
  const when = t.resolved ?? t.lastUpdate
  if (!when) return null
  const ts = Date.parse(when)
  if (Number.isNaN(ts)) return null
  const left = ts + DONE_BOARD_DAYS * 86_400_000 - now
  return left > 0 ? Math.ceil(left / 86_400_000) : null
}

const celebratedDone = new Set<string>()

/** dataTransfer type carrying the dragged ticket key; columns accept only this. */
/** How see-through the card is while it is carried: enough to read the drop zone through it. */
export const DRAG_GHOST_OPACITY = 0.55

/**
 * The browser's drag image is an opaque snapshot of the card, which hides exactly what the user is
 * aiming at. Hand it a translucent, slightly tilted clone instead (built offscreen, removed next tick —
 * the browser copies the pixels at once), grabbed at the same point the user picked the card up.
 */
function setTranslucentDragImage(e: DragEvent, card: HTMLElement) {
  if (!e.dataTransfer?.setDragImage) return
  const box = card.getBoundingClientRect()
  const ghost = card.cloneNode(true) as HTMLElement
  ghost.classList.remove('ticket-card-dragging')
  Object.assign(ghost.style, {
    position: 'fixed',
    top: '-2000px',
    left: '-2000px',
    width: `${box.width}px`,
    margin: '0',
    opacity: String(DRAG_GHOST_OPACITY),
    transform: 'rotate(-1.5deg) scale(0.97)',
    pointerEvents: 'none',
    boxShadow: '0 18px 36px -14px rgba(2,6,23,0.45)',
  })
  document.body.appendChild(ghost)
  e.dataTransfer.setDragImage(ghost, Math.max(0, e.clientX - box.left), Math.max(0, e.clientY - box.top))
  setTimeout(() => ghost.remove(), 0)
}

export const DRAG_MIME = 'application/x-jira-board-ticket'

/** Full branch name, wrapping only after / or _ so a key like PROJ-267 stays intact. */
function BranchName({ name }: { name: string }) {
  const parts = name.split(/([/_])/)
  return (
    <span className="block font-mono text-[10px] leading-3 opacity-80" title={name}>
      {parts.map((part, i) =>
        part === '/' || part === '_' ? (
          <span key={i}>
            {part}
            <wbr />
          </span>
        ) : (
          <span key={i} className="whitespace-nowrap">
            {part}
          </span>
        ),
      )}
    </span>
  )
}

function motionOff(): boolean {
  try {
    if (document.documentElement.classList.contains('jb-no-anim')) return true
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

export const TicketCard = memo(function TicketCard({
  ticket,
  now,
  onOpen,
  onArchive,
  onRefreshTicket,
  refreshing,
  draggable = false,
  calm = false,
  moving = false,
  readyRev,
  readyDone,
}: {
  ticket: Ticket
  now: number
  onOpen: (key: string) => void
  /** Move this (Done) ticket to the Completed archive now — off the board immediately. */
  onArchive?: (key: string) => void
  onRefreshTicket?: (key: string) => void
  refreshing?: boolean
  /** Card can be dragged to another column (status change written to Jira). */
  draggable?: boolean
  /** A drag is in flight (or just ended) somewhere on the board: no position animation, so columns re-flowing under it do not make it spring around. */
  calm?: boolean
  /** Jira is being updated for this card right now. */
  moving?: boolean
  /**
   * Readiness dots (lib/moveRules.ts::readinessOf), as primitives so the card stays memoised: undefined =
   * no dot, null = ready, a string = what is missing.
   */
  readyRev?: string | null
  readyDone?: string | null
}) {
  const meta = COLUMN_META[ticket.column]
  const accent = meta?.accent ?? '#64748b'
  const prio = priorityMeta(ticket.priority)
  const tm = typeMeta(effectiveType(ticket))
  const urgent = prio.rank >= 4
  const rel = relTime(ticket.lastUpdate, now)
  const prs = prListOf(ticket)
  // The banner follows the ticket's primary branch; PRs on other branches are counted below.
  const pr = primaryPrOf(ticket)
  const otherPrs = prs.length - (pr ? 1 : 0)
  const prKnownState = pr && pr.state && pr.state !== 'none'
  // Parent cards say only what matters (cardBranches); a sub-task keeps its compact branch line.
  const subBranches = branchesOf(ticket)
  const branch = ticket.parentKey ? (subBranches[0] ? { shown: subBranches[0], more: subBranches.length - 1, all: subBranches } : null) : cardBranches(ticket)
  // Latest Jenkins build per environment — one compact chip each, all on one row.
  const builds = cardBuilds(ticket)
  // Vulnerability-fix tickets: how many of the vulnerabilities they name Checkmarx shows as fixed.
  const vulns = vulnFixesOf(ticket)
  const archiveIn = archivesInDays(ticket, now)
  const overflow = !!ticket.sprintOverflow
  // Sub-tasks carry little of their own (no points, rarely a PR or branch), so they get a compact card.
  const sub = !!ticket.parentKey
  const quiet = motionOff()
  // Native HTML5 drag. Bound by hand because motion.div consumes React's onDragStart/onDragEnd
  // for its own pan gesture and never forwards them to the DOM.
  const cardRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = cardRef.current
    if (!el || !draggable) return
    const start = (e: DragEvent) => {
      if (!e.dataTransfer) return
      e.dataTransfer.setData(DRAG_MIME, ticket.key)
      e.dataTransfer.setData('text/plain', ticket.key)
      // copyMove, not move: holding ⌥ (force past a gate) asks the browser for a copy, and a drag
      // that only allows "move" would then be refused before the board ever saw the drop.
      e.dataTransfer.effectAllowed = 'copyMove'
      setTranslucentDragImage(e, el)
      // The browser snapshots the card for the drag image first; then the card itself leaves
      // its column, so the drag reads as picking the whole card up. Removing it from the DOM
      // would cancel the drag, so it only turns invisible.
      requestAnimationFrame(() => el.classList.add('ticket-card-dragging'))
    }
    // The card fades back in rather than popping, when a drop leaves it where it was.
    const end = () => {
      el.classList.remove('ticket-card-dragging')
      el.classList.add('ticket-card-return')
      setTimeout(() => el.classList.remove('ticket-card-return'), 260)
    }
    el.addEventListener('dragstart', start)
    el.addEventListener('dragend', end)
    return () => {
      el.removeEventListener('dragstart', start)
      el.removeEventListener('dragend', end)
    }
  }, [draggable, ticket.key])
  // Decided once per card instance, then recorded in an effect: StrictMode double-invokes
  // useMemo (and the second pass would see its own first-pass mutation and skip the burst).
  const [burst] = useState(() => ticket.column === 'done' && !quiet && !celebratedDone.has(ticket.key))
  useEffect(() => {
    if (burst) celebratedDone.add(ticket.key)
  }, [burst, ticket.key])

  const ring = [
    urgent ? `0 0 0 1px ${tint(prio.color, 0.3)}` : '',
    overflow ? '0 0 0 2px #dc2626' : '',
  ]
    .filter(Boolean)
    .join(', ')
  const ringSuffix = ring ? `, ${ring}` : ''
  // Resting card sits on the board. Hover lifts it: a tight contact shadow plus a
  // wider ambient shadow tinted with the column color, so the lift reads as depth.
  const baseShadow = `inset 4px 0 0 ${accent}, 0 1px 2px rgba(2,6,23,0.07), 0 10px 20px -14px ${tint(accent, meta?.quiet ? 0.28 : 0.55)}${ringSuffix}`
  const hoverShadow = `inset 4px 0 0 ${accent}, inset 0 1px 0 rgba(255,255,255,0.14), 0 1px 2px rgba(2,6,23,0.06), 0 14px 24px -12px rgba(2,6,23,0.42), 0 28px 44px -18px ${tint(accent, 0.48)}${ringSuffix}`
  const overflowTitle = overflow
    ? `Carried across ${ticket.sprintCount && ticket.sprintCount > 1 ? ticket.sprintCount : 'multiple'} sprints`
    : undefined

  return (
    // Card shell is a div[role=button], NOT a <button>, so the dismiss/refresh controls inside it
    // are valid (a <button> may not contain interactive descendants). Enter/Space open it.
    <motion.div
      ref={cardRef}
      layout={calm ? false : 'position'}
      draggable={draggable || undefined}
      role="button"
      tabIndex={0}
      data-ticket-key={ticket.key}
      aria-label={`Open ${ticket.key}: ${ticket.title}`}
      title={overflowTitle ?? (draggable ? 'Drag to another column to change its status in Jira' : undefined)}
      onClick={() => onOpen(ticket.key)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen(ticket.key)
        }
      }}
      initial={{ opacity: 0, y: 8, boxShadow: baseShadow }}
      animate={{ opacity: 1, y: 0, zIndex: 0, boxShadow: baseShadow }}
      exit={{ opacity: 0, scale: 0.96 }}
      // Hovering a card happens all day, so the lift is small and quick (no slow float); the
      // status-colour bloom underneath (.ticket-card-wash / -glow / -edge) stays deliberately slow.
      transition={{
        opacity: { duration: 0.24, ease: EASE_OUT },
        y: { duration: 0.2, ease: EASE_OUT },
        layout: LAYOUT,
        boxShadow: { duration: 0.24, ease: EASE_OUT },
        scale: PRESS,
      }}
      whileHover={quiet ? undefined : { y: -3, zIndex: 3, boxShadow: hoverShadow }}
      whileTap={quiet ? undefined : { y: -1, scale: 0.99 }}
      className={`ticket-card @container group relative flex w-full flex-col ${draggable ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'} overflow-hidden rounded-xl border bg-[var(--surface-solid)] text-left ${sub ? 'px-2.5 py-2' : 'min-h-[168px] p-2.5'}`}
      style={{
        boxShadow: baseShadow,
        borderColor: overflow ? '#dc2626' : undefined,
        ['--card-accent' as string]: accent,
      }}
    >
      {/* Status color blooms in slowly — a soft wash, then a thinner top light. */}
      <span
        aria-hidden
        className="ticket-card-wash pointer-events-none absolute inset-0"
        style={{
          background: meta?.quiet
            ? `linear-gradient(160deg, ${tint(accent, 0.08)} 0%, transparent 60%)`
            : `linear-gradient(160deg, ${tint(accent, 0.2)} 0%, ${tint(accent, 0.07)} 42%, transparent 78%)`,
        }}
      />
      <span
        aria-hidden
        className="ticket-card-glow pointer-events-none absolute -left-6 -top-10 h-28 w-40 rounded-full blur-2xl"
        style={{ background: tint(accent, 0.45) }}
      />
      <span
        aria-hidden
        className="ticket-card-edge pointer-events-none absolute inset-x-0 top-0 h-px"
        style={{ background: `linear-gradient(90deg, ${accent}, ${tint(accent, 0.15)} 70%, transparent)` }}
      />

      {burst && <DoneBurst />}

      {onArchive && (
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onArchive(ticket.key)
          }}
          onKeyDown={(e) => e.stopPropagation()}
          title="Move to Completed now (removes it from the board)"
          aria-label="Move to Completed"
          className="absolute right-1 top-1 z-10 grid h-5 w-5 cursor-pointer place-items-center rounded-md border border-[var(--line)] bg-[var(--surface-solid)] leading-none opacity-0 transition-opacity hover:border-[#f59e0b] focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
        >
          <TrophyIcon size={10} />
        </button>
      )}

      {/* Per-ticket refresh — only for tickets still in flight (not Done). */}
      {onRefreshTicket && ticket.column !== 'done' && (
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            if (!refreshing) onRefreshTicket(ticket.key)
          }}
          onKeyDown={(e) => e.stopPropagation()}
          title="Fetch the latest status of this ticket (background)"
          aria-label="Refresh this ticket"
          className={`absolute right-1 top-1 z-10 grid h-5 w-5 cursor-pointer place-items-center rounded-md border border-[var(--line)] bg-[var(--surface-solid)] text-[var(--muted)] transition-opacity hover:border-[var(--muted)] hover:text-[var(--ink)] ${refreshing ? 'opacity-100' : 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100'}`}
        >
          <motion.span
            className="inline-flex"
            animate={refreshing ? { rotate: 360 } : { rotate: 0 }}
            transition={refreshing ? { repeat: Infinity, duration: 0.8, ease: 'linear' } : { duration: 0.2 }}
          >
            <RefreshIcon size={11} color="currentColor" />
          </motion.span>
        </button>
      )}

      <div className="relative flex items-center justify-between gap-2">
        <span className="inline-flex min-w-0 items-center gap-1.5 text-[11px] font-bold tracking-wide" style={{ color: lift(accent) }}>
          {ticket.column === 'done' && <TrophyIcon size={12} />}
          <TypeIcon type={effectiveType(ticket)} color={lift(tm.color)} size={13} />
          {/* Keys never break at their hyphen — six columns leave each card ~220px. */}
          <span className="whitespace-nowrap">{ticket.key}</span>
          <PointsTag points={ticket.storyPoints} />
        </span>
        {moving ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-[10px] font-semibold" style={{ color: lift(accent) }} title="Updating status in Jira…">
            <motion.span className="inline-flex" animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 0.8, ease: 'linear' }}>
              <RefreshIcon size={10} color="currentColor" />
            </motion.span>
            syncing
          </span>
        ) : (
          // Thin columns (To Do · QA · Done) leave no room for the age beside key and points — it yields.
          rel && <span className="hidden shrink-0 text-[10px] text-[var(--muted)] @[13rem]:inline">{rel}</span>
        )}
      </div>

      <h3 className={`relative mt-1 line-clamp-2 font-semibold leading-snug text-[var(--ink)] ${sub ? 'text-[12px]' : 'text-[13px]'}`}>
        {ticket.title}
      </h3>

      <div className={`relative flex flex-wrap items-center gap-1 ${sub ? 'mt-1' : 'mt-1.5'}`}>
        <PriorityGlyph priority={ticket.priority} />
        {sub && (
          <span
            className="min-w-0 truncate font-mono text-[10px] text-[var(--muted)]"
            title={`Sub-ticket of ${ticket.parentKey}${ticket.parentTitle ? ` — ${ticket.parentTitle}` : ''}`}
          >
            ↳ {ticket.parentKey}
          </span>
        )}
        {pr && (prKnownState ? <PrBadge state={pr.state} /> : <Pill color="#94a3b8" title="Pull request linked">⊙ PR</Pill>)}
        {pr && !isClosedPr(pr) && <Approvals approvals={pr.approvals} />}
        {otherPrs > 0 && (
          <Pill color="#a855f7" title={`${otherPrs} other pull request${otherPrs > 1 ? 's' : ''}`}>
            +{otherPrs} PR
          </Pill>
        )}
        {overflow && (
          <Pill color="#dc2626" title={overflowTitle}>
            overflow
          </Pill>
        )}
        {(readyRev !== undefined || readyDone !== undefined) && <ReadinessDots rev={readyRev} done={readyDone} />}
        {archiveIn != null && (
          <Pill color="#b45309" title={`Recent win — moves to the Completed archive in ${archiveIn} day${archiveIn === 1 ? '' : 's'}`}>
            <TrophyIcon size={10} /> archives in {archiveIn}d
          </Pill>
        )}
      </div>

      {(builds.length > 0 || vulns) && (
        <div className="relative mt-1 flex min-w-0 flex-nowrap items-center gap-1 overflow-hidden">
          {vulns && <VulnChip vf={vulns} />}
          {builds.length > 0 && (
            <div className="flex min-w-0 flex-nowrap items-center gap-1 overflow-hidden" aria-label="Latest builds">
              {builds.map((b) => (
                <BuildChip key={b.env} build={b} now={now} total={envBuildCount(ticket, b.env)} />
              ))}
            </div>
          )}
        </div>
      )}

      {branch && (
        <div className="relative mt-auto w-full pt-1 text-[var(--muted)]" title={branch.all.join('\n')}>
          <BranchName name={branch.shown} />
          {branch.more > 0 ? <span className="font-mono text-[10px] opacity-80">{` +${branch.more}`}</span> : null}
        </div>
      )}
    </motion.div>
  )
})

const READY = '#17c47a'
const NOT_YET = '#f59e0b'

/** Can this card go to In Review / Done right now? Green = yes; amber = something is missing (tooltip says what). */
function ReadinessDots({ rev, done }: { rev?: string | null; done?: string | null }) {
  const dot = (label: string, target: string, reason: string | null | undefined) => {
    if (reason === undefined) return null
    const color = reason ? NOT_YET : READY
    const text = reason ?? `Ready for ${target}`
    return (
      <span className="inline-flex items-center gap-[3px] text-[9.5px] font-bold uppercase tracking-wide" style={{ color: lift(color) }} title={text} aria-label={`${target}: ${text}`}>
        <span aria-hidden className="h-[7px] w-[7px] rounded-full" style={{ background: reason ? 'transparent' : color, boxShadow: `inset 0 0 0 1.5px ${color}, 0 0 0 2px ${tint(color, 0.16)}` }} />
        {label}
      </span>
    )
  }
  return (
    <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 pl-1">
      {dot('Rev', 'In Review', rev)}
      {dot('Done', 'Done', done)}
    </span>
  )
}

function DoneBurst() {
  const sparks = Array.from({ length: 10 }, (_, i) => i)
  return (
    <span aria-hidden className="pointer-events-none absolute right-3 top-3 z-20 h-0 w-0">
      {sparks.map((i) => {
        const a = (i / sparks.length) * Math.PI * 2
        return (
          <motion.span
            key={i}
            className="absolute h-1.5 w-1.5 rounded-full"
            style={{ background: i % 2 ? '#f59e0b' : '#fde68a', boxShadow: '0 0 6px #f59e0b' }}
            initial={{ opacity: 1, x: 0, y: 0, scale: 1 }}
            animate={{ opacity: 0, x: Math.cos(a) * 28, y: Math.sin(a) * 22, scale: 0.2 }}
            transition={{ duration: 0.7, ease: 'easeOut' }}
          />
        )
      })}
    </span>
  )
}
