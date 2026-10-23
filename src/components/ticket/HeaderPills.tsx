import type { CSSProperties, ReactNode } from 'react'
import { motion } from 'motion/react'
import type { Ticket } from '../../types'
import { COLUMN_META } from '../../lib/columns'
import { effectiveType, prMeta, primaryPrOf, priorityMeta, typeMeta } from '../../lib/format'
import { PRESS, PRESS_SCALE } from '../../lib/motion'
import { contrastRatio, lift, tint } from '../../lib/tone'
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

/** Text on a filled pill must clear this against the fill — WCAG AA for normal text. */
export const FILL_MIN_CONTRAST = 4.5

const toHex = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0')

/**
 * The fill of a pill that carries WHITE text: the colour itself when white already reads on it, else the colour pulled
 * toward black just far enough that it does (the quiet grey-teal of QA, the amber of an open PR, green…). Same hue, a
 * touch deeper — never a different colour. Not a 6-digit hex (a `var()`) → returned untouched.
 */
export function readableFill(color: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color)
  if (!m) return color
  const n = parseInt(m[1], 16)
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  for (let t = 0; t <= 0.7; t += 0.02) {
    const c = `#${rgb.map((v) => toHex(v * (1 - t))).join('')}`
    if (contrastRatio('#ffffff', c) >= FILL_MIN_CONTRAST) return c
  }
  return `#${rgb.map((v) => toHex(v * 0.3)).join('')}`
}

/**
 * Depth, Liquid-Glass style: light from the top (a lighter upper half and a 1px top highlight) and a soft shadow in the
 * pill's own colour under it — a material resting on the sheet, not a bevelled 3D button. Pressed, it sinks: the drop
 * shadow goes and a faint inner shadow takes its place, on the same press spring every chip uses.
 */
function depth(color: string, filled: boolean): { rest: CSSProperties; pressed: string } {
  if (filled) {
    const base = readableFill(color)
    return {
      rest: {
        color: '#ffffff',
        borderColor: 'transparent',
        // The top stays only a little lighter than the base, so white text keeps its contrast across the whole pill.
        background: `linear-gradient(180deg, color-mix(in srgb, ${base} 90%, #ffffff), ${base} 70%)`,
        boxShadow: `inset 0 1px 0 rgba(255,255,255,0.3), inset 0 -1px 0 rgba(0,0,0,0.1), 0 1px 2px ${tint(base, 0.4)}, 0 6px 14px -8px ${tint(base, 0.75)}`,
      },
      pressed: `inset 0 1px 3px rgba(0,0,0,0.22), inset 0 -1px 0 rgba(255,255,255,0.12), 0 0 0 ${tint(color, 0)}, 0 0 0 -8px ${tint(color, 0)}`,
    }
  }
  return {
    rest: {
      // Half the colour, half the board's ink: dark enough on the pale wash (yellow, cyan, orange) in light mode, and the
      // lifted colour mixed with the light ink in dark mode — the label always clears AA, the hue still reads.
      color: `color-mix(in srgb, ${lift(color)} 55%, var(--ink))`,
      borderColor: tint(color, 0.55),
      background: `linear-gradient(180deg, ${tint(color, 0.17)}, ${tint(color, 0.08)})`,
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
      return <PriorityIcon bare rank={priorityMeta(ticket.priority).rank} color={color} size={14} />
    case 'type':
      return <TypeIcon type={pill.label} color={color} size={13} />
    case 'pr':
      return <PrStateIcon state={primaryPrOf(ticket)?.state} color={color} size={13} />
    default:
      return <TypeIcon type="Release" color={color} size={13} />
  }
}

/**
 * One height, one left edge, one right edge — and the width is the content's, so a short word is a short pill and no
 * space is wasted. The icon always sits in the same 16px slot (8px from the edge); the label has 12px after it. A very
 * long fix version truncates at `max-w-[16rem]`, the full text is in the tooltip.
 */
const SHAPE = 'inline-flex h-7 max-w-[16rem] shrink-0 items-center gap-1.5 rounded-full border pl-2 pr-3 text-[11px] font-semibold leading-none whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-[var(--link)] focus-visible:ring-offset-1'

export function HeaderPills({ ticket }: { ticket: Ticket }) {
  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-2">
      {headerPills(ticket).map((pill) => {
        const d = depth(pill.color, pill.filled)
        // The glyph is drawn in the label's own colour, so it is exactly as visible as the text beside it.
        const iconColor = 'currentColor'
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
