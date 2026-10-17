import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { motion } from 'motion/react'
import type { ColumnKey, PrState } from '../../types'
import { COLUMN_META } from '../../lib/columns'
import { priorityMeta, typeMeta, prMeta, branchStatusMeta } from '../../lib/format'
import { APP_CONFIG } from '../../lib/appConfig'
import { PriorityIcon, TypeIcon, PrStateIcon, CopyIcon, CheckIcon, ICON_SCALE } from './Icons'
import { lift, onFill, tint } from '../../lib/tone'
import { EASE_OUT, PRESS, PRESS_SCALE } from '../../lib/motion'

export function Pill({
  children,
  color,
  filled,
  title,
  className = '',
}: {
  children: ReactNode
  color?: string
  filled?: boolean
  title?: string
  className?: string
}) {
  const c = color ?? 'var(--muted)'
  const hex = c.startsWith('#')
  // Modern badge: a gradient, not a flat fill. Solid ones run from the colour to a lighter, shifted
  // tone with a faint inner highlight; tinted ones are a soft gradient wash with a colour border, and
  // their text is the colour pulled toward --ink so it stays readable on a light OR dark board.
  const style = filled
    ? {
        background: `linear-gradient(135deg, ${c}, color-mix(in srgb, ${c} 72%, #ffffff))`,
        color: onFill(c),
        borderColor: 'transparent',
        boxShadow: `inset 0 1px 0 rgba(255,255,255,0.28), 0 1px 3px -1px ${tint(hex ? c : '#64748b', 0.55)}`,
      }
    : {
        color: hex ? `color-mix(in srgb, ${lift(c)} 80%, var(--ink))` : c,
        borderColor: tint(hex ? c : '#94a3b8', 0.34),
        background: `linear-gradient(135deg, ${tint(hex ? c : '#bac2cd', 0.2)}, ${tint(hex ? c : '#bac2cd', 0.07)})`,
      }
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-[2px] text-[10.5px] font-semibold leading-none whitespace-nowrap ${className}`}
      style={style}
    >
      {children}
    </span>
  )
}

export function StatusBadge({ column, label }: { column: ColumnKey; label: string }) {
  const accent = COLUMN_META[column]?.accent ?? '#64748b'
  return (
    <Pill color={accent} filled title={`Status: ${label}`}>
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-current opacity-85" />
      {label}
    </Pill>
  )
}

/** Compact story-points tag shown right next to the ticket id. "NA" when unset. */
export function PointsTag({ points }: { points?: number | null }) {
  const has = typeof points === 'number'
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-md border border-[var(--line)] bg-[var(--surface-2)] px-1.5 py-[1px] text-[10px] font-bold tabular-nums ${
        has ? 'text-[var(--ink-soft)]' : 'text-[var(--muted)]'
      }`}
      title={has ? `${points} story point${points === 1 ? '' : 's'}` : 'No story points set'}
    >
      {has ? `${points} pt${points === 1 ? '' : 's'}` : 'NA'}
    </span>
  )
}

export function PriorityBadge({ priority }: { priority?: string | null }) {
  const m = priorityMeta(priority)
  return (
    <Pill color={m.color} title={`Priority: ${m.label}`}>
      <PriorityIcon rank={m.rank} color={lift(m.color)} size={13} />
      {m.label}
    </Pill>
  )
}

/** Icon-only urgency signal for board cards — no "Low"/"Medium"/"High" text, just the glyph
 *  (a rounded tile with one bold glyph per tier: solid ! · double ⌃ · ⌃ · — · ⌄ · double ⌄). The label survives as a tooltip/aria-label so the information isn't lost, only
 *  the always-on text is. Ticket detail keeps the full labelled `PriorityBadge` — this is
 *  deliberately card-only. */
export function PriorityGlyph({ priority, size = 16 }: { priority?: string | null; size?: number }) {
  const m = priorityMeta(priority)
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center"
      title={`Priority: ${m.label}`}
      aria-label={`${m.label} priority`}
    >
      <PriorityIcon rank={m.rank} color={lift(m.color)} size={size} />
    </span>
  )
}

export function TypeBadge({ type }: { type?: string | null }) {
  if (!type) return null
  const m = typeMeta(type)
  return (
    <Pill color={m.color} title={`Type: ${type}`}>
      <TypeIcon type={type} color={lift(m.color)} size={12} />
      {type}
    </Pill>
  )
}

export function PrBadge({ state }: { state?: PrState | null }) {
  // No PR → render nothing (the "Pull request" UI is hidden entirely when absent).
  if (!state || state === 'none') return null
  const m = prMeta(state)
  return (
    <Pill color={m.color} filled title={m.label}>
      <PrStateIcon state={state} color="currentColor" size={12} />
      {m.label}
    </Pill>
  )
}

/** Whether a branch's PR merged / declined / is still open — shown next to the branch name. */
export function BranchStatusPill({ state }: { state?: PrState | null }) {
  if (!state || state === 'none') return null
  const m = branchStatusMeta(state)
  const filled = state === 'merged' || state === 'declined'
  return (
    <Pill color={m.color} filled={filled} title={`Branch ${m.label}`} className="shrink-0">
      {m.label}
    </Pill>
  )
}

/** Old-browser / insecure-context fallback: select the text in a hidden textarea and copy it. */
function legacyCopy(text: string): boolean {
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

/** Write to the clipboard; resolves true on success. Never throws — a missing or refused Clipboard API falls back to the legacy copy. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* permission denied or not a secure context — try the old way */
  }
  return legacyCopy(text)
}

export function CopyButton({ text, label = 'Copy', className = '', icon, title }: { text: string; label?: string; className?: string; icon?: ReactNode; title?: string }) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const done = state === 'done'
  const failed = state === 'failed'
  // Set once the label has changed at least once: from then on each swap crossfades in.
  const swapped = useRef(false)
  if (state !== 'idle') swapped.current = true
  return (
    <motion.button
      type="button"
      whileTap={{ scale: PRESS_SCALE }}
      transition={PRESS}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        void copyText(text).then((ok) => {
          setState(ok ? 'done' : 'failed')
          clearTimeout(timer.current)
          timer.current = setTimeout(() => setState('idle'), ok ? 1300 : 2200)
        })
      }}
      title={failed ? `Copy failed — select and copy by hand: ${text}` : title}
      aria-live="polite"
      className={`glass-interactive inline-flex items-center gap-1.5 rounded-lg border border-[var(--line-strong)] bg-[var(--surface-solid)] px-2.5 py-1 text-[11px] font-medium text-[var(--ink-soft)] transition-colors hover:border-[var(--muted)] hover:text-[var(--ink)] ${className}`}
    >
      {/* Copy ↔ Copied: a blur-masked crossfade, so the swap reads as one label changing, not two
          labels trading places. Only on a change — never on mount. */}
      <motion.span
        key={state}
        className="inline-flex items-center gap-1.5"
        initial={swapped.current ? { opacity: 0, filter: 'blur(2px)' } : false}
        animate={{ opacity: 1, filter: 'blur(0px)' }}
        transition={{ duration: 0.2, ease: EASE_OUT }}
      >
        {done ? <CheckIcon size={12} color={lift('#22c55e')} /> : failed ? <CopyIcon size={12} color={lift('#ef4444')} /> : (icon ?? <CopyIcon size={12} />)}
        {done ? 'Copied' : failed ? 'Copy failed' : label}
      </motion.span>
      {failed && <span className="select-all font-mono text-[10px] text-[var(--muted)]">{text}</span>}
    </motion.button>
  )
}

/** A PR counts as truly approved only when at least this many reviewers have approved (config.json → app.requiredApprovals). */
export const REQUIRED_APPROVALS = APP_CONFIG.requiredApprovals

function ApprovalDot({ filled }: { filled: boolean }) {
  const s = Math.round(11 * ICON_SCALE) // follow the global +40% icon scale
  return filled ? (
    <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r="10" fill="#22c55e" />
      <path d="M8 12.5l2.5 2.5L16 9.3" stroke="#fff" strokeWidth="2.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ) : (
    <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r="9" fill="none" stroke="#94a3b8" strokeWidth="2.2" />
    </svg>
  )
}

/** At-a-glance approval progress: ●●=approved (≥2), ●○=1 of 2, ○○=none yet. */
export function Approvals({ approvals }: { approvals?: number | null }) {
  const n = Math.max(0, approvals ?? 0)
  const full = n >= REQUIRED_APPROVALS
  const color = full ? '#22c55e' : '#94a3b8'
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border px-1.5 py-[2px] leading-none"
      title={`${n} of ${REQUIRED_APPROVALS} approvals${full ? ' — approved ✓' : ' — needs ' + (REQUIRED_APPROVALS - n) + ' more'}`}
      style={{ borderColor: tint(color, 0.45), background: tint(color, 0.12) }}
    >
      <span className="inline-flex items-center gap-0.5">
        {Array.from({ length: REQUIRED_APPROVALS }).map((_, i) => (
          <ApprovalDot key={i} filled={i < n} />
        ))}
      </span>
      <span className="text-[9.5px] font-bold tabular-nums" style={{ color: full ? lift('#22c55e') : 'var(--muted)' }}>
        {n}/{REQUIRED_APPROVALS}
        {n > REQUIRED_APPROVALS ? `+${n - REQUIRED_APPROVALS}` : ''}
      </span>
    </span>
  )
}

// ── HTML sanitization ───────────────────────────────────────────────────────
// The HTML rendered here comes from Jira ticket descriptions, proposed-solution
// fields and COMMENT BODIES — authored by many colleagues, not just the user.
// Treat it as UNTRUSTED. We parse it into an inert <template> (whose content is a
// detached fragment: <img onerror>/<iframe>/resource loads do NOT fire there) and
// walk the tree with a strict ALLOWLIST, dropping every unknown tag/attribute and
// neutralising javascript:/data: URLs. This also keeps the layout clean (no pasted
// inline styles / class names) so our .prose-mini rules fully control rendering.

// Formatting tags we keep. Everything else (script/style/iframe/object/embed/form/
// input/img/svg/…) is removed; a removed element's safe children are preserved.
const ALLOWED_TAGS = new Set([
  'P', 'BR', 'HR', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'DEL', 'SPAN', 'DIV',
  'UL', 'OL', 'LI', 'CODE', 'PRE', 'BLOCKQUOTE', 'A',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH',
])
// Tags whose text content is also unsafe/noise — drop them AND their subtree.
const DROP_WITH_CONTENT = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'TITLE'])
const ALLOWED_ATTRS = new Set(['href', 'title', 'colspan', 'rowspan'])
const SAFE_URL = /^(https?:|mailto:|#|\/)/i

/** http(s), mailto, a fragment or a site-relative path. Nothing else may become a link. */
export function isSafeUrl(v: string): boolean {
  // Strip control chars/whitespace that hide "java\tscript:" and decode nothing.
  return SAFE_URL.test(v.replace(/[\u0000-\u0020]+/g, '').trim())
}

/**
 * The href to put on a data-driven anchor, or undefined when the value is missing or not a web
 * URL. Every `<a href>` built from dump or report data goes through this — the intern already
 * drops javascript:/data: links, but the board must not rely on upstream for its own safety.
 */
export function safeHref(v?: string | null): string | undefined {
  if (typeof v !== 'string') return undefined
  const trimmed = v.trim()
  return trimmed && isSafeUrl(trimmed) ? trimmed : undefined
}

function cleanElement(el: Element) {
  // Remove every attribute not explicitly allowed (kills on*=, style, class,
  // data-*, srcdoc, formaction, …). Neutralise unsafe href values.
  for (const attr of [...el.attributes]) {
    const name = attr.name.toLowerCase()
    if (!ALLOWED_ATTRS.has(name)) {
      el.removeAttribute(attr.name)
      continue
    }
    if (name === 'href' && !isSafeUrl(attr.value)) el.removeAttribute(attr.name)
  }
  if (el.tagName === 'A') {
    el.setAttribute('target', '_blank')
    el.setAttribute('rel', 'noopener noreferrer')
  }
}

function sanitizeNode(node: Node) {
  // Iterate over a static copy — we mutate children as we go.
  for (const child of [...node.childNodes]) {
    if (child.nodeType === 8 /* comment */) {
      child.parentNode?.removeChild(child)
      continue
    }
    if (child.nodeType !== 1 /* element */) continue // keep text nodes as-is
    const el = child as Element
    const tag = el.tagName
    if (DROP_WITH_CONTENT.has(tag)) {
      el.parentNode?.removeChild(el)
      continue
    }
    sanitizeNode(el) // clean descendants first
    if (!ALLOWED_TAGS.has(tag)) {
      // Unknown but harmless wrapper: unwrap it, keeping its (already-cleaned) kids.
      const parent = el.parentNode
      if (parent) {
        while (el.firstChild) parent.insertBefore(el.firstChild, el)
        parent.removeChild(el)
      }
      continue
    }
    cleanElement(el)
  }
}

/** Convert markdown / Jira-wiki link syntax to real anchors BEFORE parsing to DOM. */
function linkifyRaw(html: string): string {
  return html
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\[([^\]|]+)\|(https?:\/\/[^\]\s]+)\]/g, '<a href="$2">$1</a>')
}

/** Sanitize untrusted HTML to a safe subset. Dependency-free; uses an inert <template>. */
export function sanitizeHtml(html: string): string {
  if (!html) return ''
  const linkified = linkifyRaw(html)
  if (typeof document === 'undefined') return '' // no DOM (SSR) → render nothing rather than raw HTML
  const tpl = document.createElement('template')
  tpl.innerHTML = linkified // inert: no scripts run, no resources load
  sanitizeNode(tpl.content)
  return tpl.innerHTML
}

/** Renders colleague-authored Jira HTML after allowlist sanitization; opens links in a new tab. */
export function SafeHtml({
  html,
  className = '',
  inline = false,
}: {
  html?: string | null
  className?: string
  /** span instead of div so keys inside a headline <p> stay valid HTML. */
  inline?: boolean
}) {
  const processed = useMemo(() => sanitizeHtml(html ?? ''), [html])
  if (!html) return null
  const Tag = inline ? 'span' : 'div'
  return <Tag className={`prose-mini ${className}`} dangerouslySetInnerHTML={{ __html: processed }} />
}

export function ExternalLink({ href, children }: { href?: string | null; children: ReactNode }) {
  const safe = safeHref(href)
  if (!safe) return <span>{children}</span>
  return (
    <a href={safe} target="_blank" rel="noopener noreferrer" className="font-semibold hover:underline" style={{ color: 'var(--link)' }}>
      {children}
      <span className="opacity-60"> ↗</span>
    </a>
  )
}
