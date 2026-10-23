import type { CSSProperties, ReactNode } from 'react'
import type { Ticket } from '../../types'
import { COLUMN_META, mapStatusToColumn } from '../../lib/columns'
import { effectiveType, prMeta, primaryPrOf, priorityMeta, typeMeta } from '../../lib/format'
import { qaIssuesOf } from '../../lib/moveRules'
import { contrastRatio, lift, tint } from '../../lib/tone'
import { ColumnIcon, PriorityIcon, PrStateIcon, TypeIcon } from '../common/Icons'

/**
 * The drawer's status banners: one row that tells you where a ticket stands — and where its related work stands — at a
 * glance. They are READ, not pressed: no link, no hover, no press response, no pointer cursor (a control that does
 * nothing is a false promise, and these are summaries). Four groups, separated by a hairline:
 *   state      status · pull request            — what decides the next step (filled)
 *   ticket     priority · type                  — what it is (tinted)
 *   related    sub-tasks done · QA              — how the work around it is going (tinted, coloured by progress)
 *   release    fix versions                     — where it ships (tinted violet)
 * The colour is always the value's own (the column, the priority, the PR state…), so the same word is the same colour
 * everywhere on the board.
 */
export type PillGroup = 'state' | 'ticket' | 'related' | 'release'

export interface HeaderPill {
  id: string
  group: PillGroup
  kind: 'status' | 'priority' | 'type' | 'pr' | 'subtasks' | 'qa' | 'version'
  label: string
  color: string
  /** Filled = what decides the next step (status, the PR); tinted = descriptive. */
  filled: boolean
  /** Tooltip (a native title: it describes, it does not invite a click). */
  title: string
}

export const GROUP_LABEL: Record<PillGroup, string> = { state: 'State', ticket: 'Ticket', related: 'Related work', release: 'Release' }

const GREEN = '#22c55e'
const TEAL = '#14b8a6'
const AMBER = '#f59e0b'
const SLATE = '#64748b'
const BLUE = '#3b82f6'

/** "3/6 sub-tasks" and its colour: all done green, some done blue, none done slate. Null when there are no sub-tasks. */
export function subtaskPill(ticket: Ticket): HeaderPill | null {
  const subs = (ticket.subtasks ?? []).filter((s) => s && s.key)
  if (!subs.length) return null
  const done = subs.filter((s) => s.done ?? s.column === 'done').length
  const color = done === subs.length ? GREEN : done > 0 ? BLUE : SLATE
  const label = `${done}/${subs.length} sub-tasks`
  return { id: 'subtasks', group: 'related', kind: 'subtasks', label, color, filled: false, title: `${done} of ${subs.length} sub-tasks done` }
}

/** The QA ticket's state in a word: "QA done", "In QA", "Ready for QA", "QA blocked" — or the gap, "No QA ticket". */
export function qaPill(ticket: Ticket): HeaderPill | null {
  if (ticket.parentKey) return null // a sub-ticket's QA lives on its parent
  const qa = qaIssuesOf(ticket)
  if (!qa.length) {
    // Only a ticket that carries code can be waiting for QA; a bare To Do has nothing to test yet.
    return primaryPrOf(ticket) ? { id: 'qa', group: 'related', kind: 'qa', label: 'No QA ticket', color: AMBER, filled: false, title: 'No QA sub-ticket raised for this ticket yet' } : null
  }
  const cols = qa.map((q) => mapStatusToColumn(q.status))
  const allDone = cols.every((c) => c === 'done')
  const blocked = cols.some((c) => c === 'blocked' || c === 'hold')
  const first = qa.find((_q, i) => cols[i] !== 'done') ?? qa[0]
  const label = allDone ? 'QA done' : blocked ? 'QA blocked' : (first.status ?? 'In QA').replace(/^qa$/i, 'In QA')
  const color = allDone ? GREEN : blocked ? '#ef4444' : TEAL
  const who = qa.length > 1 ? `${qa.length} QA tickets` : qa[0].key
  return { id: 'qa', group: 'related', kind: 'qa', label, color, filled: false, title: `QA: ${who} — ${allDone ? 'done' : (first.status ?? 'in progress')}` }
}

/** The ticket's banners, in reading order: state · ticket · related · release. */
export function headerPills(ticket: Ticket): HeaderPill[] {
  const out: HeaderPill[] = []
  const status = ticket.status || COLUMN_META[ticket.column]?.label || 'Unknown'
  out.push({ id: 'status', group: 'state', kind: 'status', label: status, color: COLUMN_META[ticket.column]?.accent ?? SLATE, filled: true, title: `Status: ${status}` })
  const pr = primaryPrOf(ticket)
  if (pr?.state && pr.state !== 'none') {
    const m = prMeta(pr.state)
    out.push({ id: 'pr', group: 'state', kind: 'pr', label: m.label, color: m.color, filled: true, title: `Pull request${pr.id ? ` #${pr.id}` : ''}: ${m.label}` })
  }
  const p = priorityMeta(ticket.priority)
  out.push({ id: 'priority', group: 'ticket', kind: 'priority', label: p.label, color: p.color, filled: false, title: `Priority: ${p.label}` })
  const type = effectiveType(ticket)
  if (type) out.push({ id: 'type', group: 'ticket', kind: 'type', label: type, color: typeMeta(type).color, filled: false, title: `Type: ${type}` })
  const subs = subtaskPill(ticket)
  if (subs) out.push(subs)
  const qa = qaPill(ticket)
  if (qa) out.push(qa)
  for (const v of ticket.fixVersions ?? []) out.push({ id: `v:${v}`, group: 'release', kind: 'version', label: v, color: '#8b5cf6', filled: false, title: `Fix version: ${v}` })
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
 * Depth, Liquid-Glass style, at rest only: light from the top (a lighter upper half and a 1px top highlight) and a soft
 * shadow in the pill's own colour under it — a material resting on the sheet, not a bevelled 3D button. It does not
 * move: a banner is not a control.
 */
function look(color: string, filled: boolean): CSSProperties {
  if (filled) {
    const base = readableFill(color)
    return {
      color: '#ffffff',
      borderColor: 'transparent',
      // The top stays only a little lighter than the base, so white text keeps its contrast across the whole pill.
      background: `linear-gradient(180deg, color-mix(in srgb, ${base} 90%, #ffffff), ${base} 70%)`,
      boxShadow: `inset 0 1px 0 rgba(255,255,255,0.3), inset 0 -1px 0 rgba(0,0,0,0.1), 0 1px 2px ${tint(base, 0.4)}, 0 6px 14px -8px ${tint(base, 0.75)}`,
    }
  }
  return {
    // Half the colour, half the board's ink: dark enough on the pale wash (yellow, cyan, orange) in light mode, and the
    // lifted colour mixed with the light ink in dark mode — the label always clears AA, the hue still reads.
    color: `color-mix(in srgb, ${lift(color)} 55%, var(--ink))`,
    borderColor: tint(color, 0.55),
    background: `linear-gradient(180deg, ${tint(color, 0.17)}, ${tint(color, 0.08)})`,
    boxShadow: `inset 0 1px 0 var(--spec), 0 1px 2px ${tint(color, 0.18)}, 0 6px 14px -10px ${tint(color, 0.6)}`,
  }
}

function PillIcon({ pill, ticket }: { pill: HeaderPill; ticket: Ticket }): ReactNode {
  const color = 'currentColor' // the glyph is drawn in the label's own colour: exactly as visible as the text beside it
  switch (pill.kind) {
    case 'status':
      return <ColumnIcon col={ticket.column} color={color} size={13} />
    case 'priority':
      return <PriorityIcon bare rank={priorityMeta(ticket.priority).rank} color={color} size={14} />
    case 'type':
      return <TypeIcon type={pill.label} color={color} size={13} />
    case 'pr':
      return <PrStateIcon state={primaryPrOf(ticket)?.state} color={color} size={13} />
    case 'subtasks':
      return <TypeIcon type="Sub-task" color={color} size={13} />
    case 'qa':
      return <TypeIcon type="QA Task" color={color} size={13} />
    default:
      return <TypeIcon type="Release" color={color} size={13} />
  }
}

/**
 * One height, one left edge, one right edge — and the width is the content's, so a short word is a short pill and no
 * space is wasted. The icon always sits in the same 16px slot (8px from the edge); the label has 12px after it. A very
 * long fix version truncates at `max-w-[16rem]`, the full text is in the tooltip. `cursor-default` + `select-none`:
 * a banner, not a control.
 */
const SHAPE = 'inline-flex h-7 max-w-[16rem] shrink-0 cursor-default select-none items-center gap-1.5 rounded-full border pl-2 pr-3 text-[11px] font-semibold leading-none whitespace-nowrap'

export function HeaderPills({ ticket }: { ticket: Ticket }) {
  const pills = headerPills(ticket)
  const groups = (['state', 'ticket', 'related', 'release'] as PillGroup[]).map((g) => ({ g, items: pills.filter((p) => p.group === g) })).filter((x) => x.items.length)
  return (
    // A list of facts, in groups; each group wraps as a unit so a row never splits a group mid-way. role="group" +
    // a label so a screen reader reads "State: In Progress, PR open" — and nothing here takes focus.
    <ul className="mt-2.5 flex flex-wrap items-center gap-y-2" aria-label="Ticket summary">
      {groups.map(({ g, items }, i) => (
        <li key={g} role="group" aria-label={GROUP_LABEL[g]} className="flex items-center">
          {i > 0 && <span aria-hidden className="mx-3 h-4 w-px shrink-0 bg-[var(--line-strong)]" />}
          <span className="flex flex-wrap items-center gap-1.5">
            {items.map((pill) => (
              <span key={pill.id} title={pill.title} data-pill={pill.kind} data-group={pill.group} className={SHAPE} style={look(pill.color, pill.filled)}>
                <span className="grid h-4 w-4 shrink-0 place-items-center" aria-hidden>
                  <PillIcon pill={pill} ticket={ticket} />
                </span>
                <span className="min-w-0 truncate">{pill.label}</span>
              </span>
            ))}
          </span>
        </li>
      ))}
    </ul>
  )
}
