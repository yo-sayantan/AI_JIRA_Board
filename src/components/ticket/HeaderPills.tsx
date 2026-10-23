import type { CSSProperties, ReactNode } from 'react'
import { motion } from 'motion/react'
import type { Ticket } from '../../types'
import { COLUMN_META } from '../../lib/columns'
import { effectiveType, prMeta, primaryPrOf, priorityMeta, typeMeta } from '../../lib/format'
import { PRESS, PRESS_SCALE } from '../../lib/motion'
import { lift, onFill, tint } from '../../lib/tone'
import { safeHref } from '../common/ui'
import { ColumnIcon, PriorityIcon, PrStateIcon, TypeIcon } from '../common/Icons'

/** What one pill in the drawer's header says, and where a click takes you. */
export interface HeaderPill {
  id: string
  label: string
  color: string
  /** Filled = the facts that decide what happens next (status, the PR); tinted = descriptive (priority, type, version). */
  filled: boolean
  kind: 'status' | 'priority' | 'type' | 'pr' | 'version'
  href?: string
  title: string
}

/**
 * The header pills of a ticket, in reading order: status · priority · type · PR · fix versions. Every one is a real
 * link — the values live in Jira (status, priority, type, version: open the ticket to change them) or in Bitbucket (the
 * PR) — so the press response is never a false promise. No link (e.g. no URL in the dump) → a static pill.
 */
export function headerPills(ticket: Ticket): HeaderPill[] {
  const jira = safeHref(ticket.url)
  const inJira = (what: string) => (jira ? `${what} — open in Jira to change it` : what)
  const out: HeaderPill[] = []
  const status = ticket.status || COLUMN_META[ticket.column]?.label || 'Unknown'
  out.push({ id: 'status', kind: 'status', label: status, color: COLUMN_META[ticket.column]?.accent ?? '#64748b', filled: true, href: jira, title: inJira(`Status: ${status}`) })
  const p = priorityMeta(ticket.priority)
  out.push({ id: 'priority', kind: 'priority', label: p.label, color: p.color, filled: false, href: jira, title: inJira(`Priority: ${p.label}`) })
  const type = effectiveType(ticket)
  if (type) out.push({ id: 'type', kind: 'type', label: type, color: typeMeta(type).color, filled: false, href: jira, title: inJira(`Type: ${type}`) })
  const pr = primaryPrOf(ticket)
  if (pr?.state && pr.state !== 'none') {
    const m = prMeta(pr.state)
    const href = safeHref(pr.url)
    out.push({ id: 'pr', kind: 'pr', label: m.label, color: m.color, filled: true, href, title: href ? `${m.label}${pr.id ? ` — open PR #${pr.id}` : ' — open the PR'}` : m.label })
  }
  for (const v of ticket.fixVersions ?? []) out.push({ id: `v:${v}`, kind: 'version', label: v, color: '#8b5cf6', filled: false, href: jira, title: inJira(`Fix version: ${v}`) })
  return out
}

/**
 * Depth, Liquid-Glass style: light from the top (a lighter upper half and a 1px top highlight) and a soft shadow in the
 * pill's own colour under it — a material resting on the sheet, not a bevelled 3D button. Pressed, it sinks: the drop
 * shadow goes and a faint inner shadow takes its place, on the same press spring every chip uses.
 */
function depth(color: string, filled: boolean): { rest: CSSProperties; pressed: string } {
  if (filled) {
    return {
      rest: {
        color: onFill(color),
        borderColor: 'transparent',
        background: `linear-gradient(180deg, color-mix(in srgb, ${color} 78%, #ffffff), ${color} 62%)`,
        boxShadow: `inset 0 1px 0 rgba(255,255,255,0.38), inset 0 -1px 0 rgba(0,0,0,0.08), 0 1px 2px ${tint(color, 0.35)}, 0 6px 14px -8px ${tint(color, 0.75)}`,
      },
      pressed: `inset 0 1px 3px rgba(0,0,0,0.22), inset 0 -1px 0 rgba(255,255,255,0.12), 0 0 0 ${tint(color, 0)}, 0 0 0 -8px ${tint(color, 0)}`,
    }
  }
  return {
    rest: {
      color: `color-mix(in srgb, ${lift(color)} 82%, var(--ink))`,
      borderColor: tint(color, 0.38),
      background: `linear-gradient(180deg, ${tint(color, 0.2)}, ${tint(color, 0.08)})`,
      boxShadow: `inset 0 1px 0 var(--spec), 0 1px 2px ${tint(color, 0.18)}, 0 6px 14px -10px ${tint(color, 0.6)}`,
    },
    pressed: `inset 0 1px 3px ${tint(color, 0.35)}, 0 0 0 transparent, 0 0 0 -10px transparent`,
  }
}

function PillIcon({ pill, ticket, color }: { pill: HeaderPill; ticket: Ticket; color: string }): ReactNode {
  switch (pill.kind) {
    case 'status':
      return <ColumnIcon col={ticket.column} color={color} size={13} />
    case 'priority':
      return <PriorityIcon rank={priorityMeta(ticket.priority).rank} color={color} size={14} />
    case 'type':
      return <TypeIcon type={pill.label} color={color} size={13} />
    case 'pr':
      return <PrStateIcon state={primaryPrOf(ticket)?.state} color={color} size={13} />
    default:
      return <TypeIcon type="Release" color={color} size={13} />
  }
}

/** One width for every pill, so the row reads as a set; a long value truncates (the full text is in the tooltip). */
const SHAPE = 'inline-flex h-7 w-[9.5rem] shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-semibold leading-none whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-[var(--link)] focus-visible:ring-offset-1'

export function HeaderPills({ ticket }: { ticket: Ticket }) {
  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
      {headerPills(ticket).map((pill) => {
        const d = depth(pill.color, pill.filled)
        const iconColor = pill.filled ? 'currentColor' : lift(pill.color)
        const body = (
          <>
            <span className="grid h-4 w-4 shrink-0 place-items-center" aria-hidden>
              <PillIcon pill={pill} ticket={ticket} color={iconColor} />
            </span>
            <span className="min-w-0 truncate">{pill.label}</span>
          </>
        )
        return pill.href ? (
          <motion.a
            key={pill.id}
            href={pill.href}
            target="_blank"
            rel="noopener noreferrer"
            title={pill.title}
            aria-label={pill.title}
            data-pill={pill.kind}
            className={`${SHAPE} cursor-pointer`}
            style={d.rest}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: PRESS_SCALE, boxShadow: d.pressed }}
            transition={PRESS}
          >
            {body}
          </motion.a>
        ) : (
          <span key={pill.id} title={pill.title} data-pill={pill.kind} className={SHAPE} style={d.rest}>
            {body}
          </span>
        )
      })}
    </div>
  )
}
