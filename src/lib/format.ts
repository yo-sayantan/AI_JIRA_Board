import type { PrState, PullRequest, UpdateLogEntry } from '../types'
import { APP_CONFIG } from './appConfig'
import { mapStatusToColumn } from './columns'

// ── Priority ────────────────────────────────────────────────────────────
// 7 distinct tiers, each its own rank + colour + icon (see PriorityIcon in Icons.tsx).
// Critical/Blocker gets its OWN rank above Highest — previously it was silently merged into
// Highest (same colour, same icon), so a Blocker ticket looked no more urgent than a Highest one.
export interface PriorityMeta {
  label: string
  color: string
  rank: number
  glyph: string
}

export function priorityMeta(p?: string | null): PriorityMeta {
  const s = (p ?? '').trim().toLowerCase()
  if (/(critical|blocker)/.test(s)) return { label: p || 'Critical', color: '#dc2626', rank: 6, glyph: '⛔' }
  if (/(highest|p1)/.test(s)) return { label: p || 'Highest', color: '#ef4444', rank: 5, glyph: '⏫' }
  if (/(high|major|p2)/.test(s)) return { label: p || 'High', color: '#f97316', rank: 4, glyph: '🔼' }
  if (/(medium|normal|p3)/.test(s) || s === '') return { label: p || 'Medium', color: '#eab308', rank: 3, glyph: '➖' }
  // "lowest" must be tested BEFORE "low" (it contains it) — same reason highest precedes high.
  if (/(lowest|trivial|p5)/.test(s)) return { label: p || 'Lowest', color: '#38bdf8', rank: 1, glyph: '⏬' }
  if (/(low|minor|p4)/.test(s)) return { label: p || 'Low', color: '#22c55e', rank: 2, glyph: '🔽' }
  return { label: p || 'None', color: '#94a3b8', rank: 0, glyph: '•' }
}

// ── Issue type ──────────────────────────────────────────────────────────
export function typeMeta(t?: string | null): { color: string; glyph: string } {
  const s = (t ?? '').trim().toLowerCase()
  // Order matters: match the specific multi-word types BEFORE the generic "task".
  if (/bug|defect/.test(s)) return { color: '#ef4444', glyph: '🐞' }
  if (/security|vuln|cve/.test(s)) return { color: '#e11d48', glyph: '🛡️' }
  if (/requirement/.test(s)) return { color: '#a855f7', glyph: '📋' }
  if (/dev[\s-]?task|development/.test(s)) return { color: '#6366f1', glyph: '💻' }
  if (/qa[\s-]?task|\bqa\b|test/.test(s)) return { color: '#06b6d4', glyph: '🧪' }
  if (/support|service[\s-]?desk|incident|helpdesk/.test(s)) return { color: '#0d9488', glyph: '🎧' }
  if (/story/.test(s)) return { color: '#22c55e', glyph: '📗' }
  if (/epic/.test(s)) return { color: '#8b5cf6', glyph: '🗂️' }
  if (/sub-?task/.test(s)) return { color: '#0ea5e9', glyph: '↳' }
  if (/spike|research/.test(s)) return { color: '#f59e0b', glyph: '🔬' }
  if (/improvement|enhancement/.test(s)) return { color: '#14b8a6', glyph: '✨' }
  if (/tech[\s-]?debt|refactor/.test(s)) return { color: '#f97316', glyph: '🔧' }
  if (/release|deploy/.test(s)) return { color: '#ec4899', glyph: '🚀' }
  if (/onboard/.test(s)) return { color: '#84cc16', glyph: '🎓' }
  if (/task/.test(s)) return { color: '#3b82f6', glyph: '☑️' }
  return { color: '#64748b', glyph: '🎫' }
}

// ── Derived types ─────────────────────────────────────────────────────────
// Deployment / release-coordination and onboarding work arrives from Jira typed as
// plain "Task" — derive first-class types from the title so every UI can surface
// them. Keyword pairing avoids false hits like "spring-beans-3.2.11.RELEASE.jar".
const RELEASE_RE = /\brelease\s+(?:management|coordination|mgmt)\b|\bdeploy(?:ing|ment|s)?\b/i
const ONBOARDING_RE = /\bon-?boarding\b/i

/** Display type: derived "Release" / "Onboarding" when the title says so, else the Jira type. */
export function effectiveType(t: { type?: string | null; title?: string | null }): string | null {
  const title = t.title ?? ''
  if (RELEASE_RE.test(title)) return 'Release'
  if (ONBOARDING_RE.test(title)) return 'Onboarding'
  return t.type ?? null
}

/** Target environment of a release ticket, parsed from its title. */
export function releaseEnvOf(t: { title?: string | null }): { label: string; color: string } | null {
  const s = t.title ?? ''
  if (/\bprod(?:uction)?\b/i.test(s)) return { label: 'Prod', color: '#ef4444' }
  if (/\bdemo\b/i.test(s)) return { label: 'Demo', color: '#f59e0b' }
  // "Stage", not "Staging" — the label sits in a fixed-width column next to Prod and Demo.
  // Only the real spellings count: the old `sta?g` form also matched the word "SG".
  if (/\b(?:stg|stage|staging)\b/i.test(s)) return { label: 'Stage', color: '#0ea5e9' }
  return null
}

// ── Pull request ──────────────────────────────────────────────────────────
/** A PR is worth showing if it has a real review state OR a link/id, even if state came through as "none". */
export function hasPr(pr?: { state?: PrState | null; url?: string | null; id?: string | number | null } | null): boolean {
  if (!pr) return false
  return (pr.state != null && pr.state !== 'none') || pr.url != null || pr.id != null
}

/** Merged can be encoded either as state:"merged" OR an orthogonal merged:true flag. */
export function isMergedPr(pr?: { state?: PrState | null; merged?: boolean | null } | null): boolean {
  return !!pr && (pr.state === 'merged' || pr.merged === true)
}

/** Closed PR = merged or declined (no longer awaiting review, so approval progress is moot). */
export function isClosedPr(pr?: { state?: PrState | null; merged?: boolean | null } | null): boolean {
  return !!pr && (isMergedPr(pr) || pr.state === 'declined')
}

/**
 * Review-comment stats for a PR, or null when the PR has NO comments (so the UI
 * can hide the block). "Open comments: 0" is meaningless — a PR can only merge
 * once all comments are resolved — so we show total added + how many are resolved.
 */
export function prCommentStats(pr?: PullRequest | null): { total: number; resolved: number } | null {
  if (!pr) return null
  const total = pr.commentsTotal
  if (total != null) {
    if (total <= 0) return null
    const resolved = pr.commentsResolved ?? Math.max(0, total - (pr.openComments ?? 0))
    return { total, resolved: Math.min(resolved, total) }
  }
  // Legacy data (only openComments known): if some are open there ARE comments;
  // if none are open we can't tell total from resolved, so hide rather than show "0".
  const open = pr.openComments ?? 0
  if (open > 0) return { total: open + (pr.commentsResolved ?? 0), resolved: pr.commentsResolved ?? 0 }
  return null
}

export function prMeta(state?: PrState | null): { label: string; color: string; glyph: string } {
  switch (state) {
    case 'merged':
      return { label: 'PR merged', color: '#9a63ff', glyph: '⬡' }
    case 'approved':
      return { label: 'PR approved', color: '#17c47a', glyph: '✓' }
    case 'comments':
      return { label: 'PR open', color: '#ff9f1c', glyph: '💬' }
    case 'changes':
      return { label: 'Changes requested', color: '#ff4466', glyph: '✗' }
    case 'declined':
      return { label: 'PR declined', color: '#e11d48', glyph: '⦸' }
    default:
      return { label: 'No PR', color: '#94a3b8', glyph: '○' }
  }
}

/** All PRs for a ticket, falling back to the single `pr`. */
export function prListOf(t: { prs?: PullRequest[] | null; pr?: PullRequest | null }): PullRequest[] {
  if (t.prs && t.prs.length) return t.prs
  return hasPr(t.pr) ? [t.pr as PullRequest] : []
}

/**
 * The one PR the banners describe (card badge, approvals, drawer badge): the pipeline's primary
 * PR for the ticket's primary branch. `pr` of {state:"none"} is a real answer — that branch has
 * no PR of its own, even when another branch's PR sits in `prs` — so it yields null rather than
 * borrowing a PR from a different branch. Dumps that carry no `pr` at all fall back to the
 * first listed PR.
 */
export function primaryPrOf(t: { prs?: PullRequest[] | null; pr?: PullRequest | null }): PullRequest | null {
  if (t.pr != null) return hasPr(t.pr) ? t.pr : null
  return prListOf(t)[0] ?? null
}

/**
 * What a PARENT ticket's card says about branches — as little as is useful:
 *   • a PR was raised  → the branch(es) those PRs come from (the primary PR's first), "+N" for more;
 *   • no PR, branches  → just the newest one (`branch`; the pipeline ranks by newest commit);
 *   • no branch        → nothing.
 * `all` is every branch, for the tooltip.
 */
export function cardBranches(t: {
  branches?: string[] | null
  branch?: string | null
  prs?: PullRequest[] | null
  pr?: PullRequest | null
}): { shown: string; more: number; all: string[] } | null {
  const all = branchesOf(t)
  const fromPrs = [...new Set(prListOf(t).map((p) => p.sourceBranch?.trim() ?? '').filter(Boolean))]
  if (fromPrs.length) return { shown: fromPrs[0], more: fromPrs.length - 1, all: [...new Set([...fromPrs, ...all])] }
  const newest = t.branch?.trim() || all[0]
  return newest ? { shown: newest, more: 0, all } : null
}

/** All real branches for a ticket, falling back to the single `branch`. */
export function branchesOf(t: { branches?: string[] | null; branch?: string | null }): string[] {
  if (t.branches && t.branches.length) return t.branches
  return t.branch ? [t.branch] : []
}

/**
 * Merge / review status of a branch, derived from the PR whose source branch matches it.
 * Returns the matched PR's state ('merged' | 'declined' | 'approved' | 'comments' | 'changes')
 * or null when no PR is associated with the branch (so the UI can stay quiet).
 */
export function branchStatusOf(
  branch: string,
  t: { prs?: PullRequest[] | null; pr?: PullRequest | null },
): PrState | null {
  const norm = (s?: string | null) => (s ?? '').trim().toLowerCase()
  const b = norm(branch)
  if (!b) return null
  // Match on exact source-branch equality only. Branches are derived from PR
  // sourceBranches, so an exact match is reliable; a fuzzy suffix match would paint
  // a status onto an unrelated branch that merely shares a tail (e.g. "app-service"
  // vs "my-app-service"). No match → null (the UI stays quiet).
  const matches = prListOf(t).filter((p) => norm(p.sourceBranch) === b)
  if (!matches.length) return null
  // A branch that ever merged reads as "merged" regardless of PR array order.
  if (matches.some((p) => isMergedPr(p))) return 'merged'
  return matches.find((p) => p.state && p.state !== 'none')?.state ?? null
}

/** Compact label + color for a branch's derived merge/review status. */
export function branchStatusMeta(state: PrState): { label: string; color: string } {
  switch (state) {
    case 'merged':
      return { label: 'merged', color: '#8b5cf6' }
    case 'declined':
      return { label: 'declined', color: '#dc2626' }
    case 'approved':
      return { label: 'approved', color: '#22c55e' }
    case 'changes':
      return { label: 'changes req', color: '#ef4444' }
    case 'comments':
      return { label: 'open PR', color: '#f59e0b' }
    default:
      return { label: state, color: '#94a3b8' }
  }
}

// ── Dates / relative time ──────────────────────────────────────────────────
/**
 * Is `assignee` me? An exact, case-insensitive, trimmed match on the dump's user by accountId,
 * name or email. Exact on purpose: a substring test let a colleague called "Ann" match "Joanne".
 * The intern writes people as "Display Name (ID)" (`_jira.py::person_fmt`), so that form is split:
 * the id must equal my accountId, or — when either side has no id — the name must equal my name.
 * A namesake with a different id is not me.
 */
export function isAssignedToMe(
  assignee?: string | null,
  user?: { name?: string | null; accountId?: string | null; email?: string | null } | null,
): boolean {
  const a = assignee?.trim().toLowerCase()
  if (!a || !user) return false
  const norm = (v?: string | null) => v?.trim().toLowerCase() || ''
  const same = (v?: string | null) => !!norm(v) && norm(v) === a
  if (same(user.accountId) || same(user.name) || same(user.email)) return true
  const m = /^(.*?)\s*\(([^()]*)\)$/.exec(a)
  if (!m) return false
  const [, name, id] = m
  const myId = norm(user.accountId)
  if (id && myId) return id.trim() === myId
  return !!name && name === norm(user.name)
}

export function projectOf(key?: string | null): string {
  if (!key) return '—'
  const m = key.match(/^([A-Z][A-Z0-9]+)-\d+/i)
  return m ? m[1].toUpperCase() : key
}

function parseDate(v?: string | null): Date | null {
  if (!v) return null
  // A pure date "YYYY-MM-DD" is parsed by `new Date()` as UTC midnight, which renders as the
  // PREVIOUS day for anyone west of UTC (e.g. the US). Parse it as LOCAL midnight instead so
  // update-log / resolved dates show the intended day everywhere. Datetime strings (with a time
  // or Z/offset) keep their normal parsing.
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim())
  if (dateOnly) {
    const [, y, m, d] = dateOnly
    const dt = new Date(Number(y), Number(m) - 1, Number(d))
    return isNaN(dt.getTime()) ? null : dt
  }
  const d = new Date(v)
  return isNaN(d.getTime()) ? null : d
}

/**
 * Intl.DateTimeFormat for the configured zone, falling back to the browser's zone when the
 * configured one is not an IANA name (config.json is hand-edited; "PST" or a typo must not take
 * the whole board down). Every zone-aware formatter below goes through here.
 */
export function dtf(locale: string | undefined, options: Intl.DateTimeFormatOptions, timeZone?: string | null): Intl.DateTimeFormat {
  const zone = timeZone ?? APP_CONFIG.timeZone
  if (zone) {
    try {
      return new Intl.DateTimeFormat(locale, { ...options, timeZone: zone })
    } catch {
      /* unknown zone — fall through to the local one */
    }
  }
  return new Intl.DateTimeFormat(locale, options)
}

export function fmtDate(v?: string | null, timeZone?: string | null): string {
  const d = parseDate(v)
  if (!d) return v ?? '—'
  return dtf(undefined, { year: 'numeric', month: 'short', day: 'numeric' }, timeZone).format(d)
}

export function fmtDateTime(v?: string | null, timeZone?: string | null): string {
  const d = parseDate(v)
  if (!d) return v ?? '—'
  return dtf(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }, timeZone).format(d)
}

/** Humanise the two ISO timestamps stored in the report's Run metadata block. */
export function fmtReportMetadata(label: string, value: string, timeZone?: string | null): string {
  if (label === 'Generated' && parseDate(value)) return fmtDateTime(value, timeZone)
  if (label === 'AI enrichment') {
    const match = /^run\s+(.+)$/.exec(value)
    if (match && parseDate(match[1])) return `run ${fmtDateTime(match[1], timeZone)}`
  }
  return value
}

/** YYYY-MM-DD for N calendar days ago in the configured timezone. */
export function dateInputDaysAgo(days: number, timeZone?: string | null, now: Date = new Date()): string {
  const formatter = dtf('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' }, timeZone)
  const parts = Object.fromEntries(formatter.formatToParts(now).map((p) => [p.type, p.value]))
  const utc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) - days)
  return new Date(utc).toISOString().slice(0, 10)
}

export function currentYear(timeZone?: string | null, now: Date = new Date()): number {
  const year = dtf('en-US', { year: 'numeric' }, timeZone)
    .formatToParts(now)
    .find((p) => p.type === 'year')?.value
  return Number(year ?? now.getFullYear())
}

/** "3d ago", "2h ago", "just now". `now` is injected so it stays deterministic per render. */
export function relTime(v?: string | null, now: number = Date.now()): string {
  const d = parseDate(v)
  if (!d) return ''
  const diff = now - d.getTime()
  const abs = Math.abs(diff)
  const min = 60_000
  const hr = 60 * min
  const day = 24 * hr
  const suffix = diff >= 0 ? ' ago' : ' from now'
  if (abs < min) return 'just now'
  if (abs < hr) return `${Math.round(abs / min)}m${suffix}`
  if (abs < day) return `${Math.round(abs / hr)}h${suffix}`
  if (abs < 30 * day) return `${Math.round(abs / day)}d${suffix}`
  if (abs < 365 * day) return `${Math.round(abs / (30 * day))}mo${suffix}`
  return `${Math.round(abs / (365 * day))}y${suffix}`
}

export function yearOf(v?: string | null): string {
  const d = parseDate(v)
  if (!d) return 'Undated'
  return dtf('en-US', { year: 'numeric' }).format(d)
}

/** Full month name ("November") in the same configured zone `yearOf` uses, so a ticket closed late on
 *  the 30th never lands under one year and the next month. Empty when the date is unusable. */
export function monthOf(v?: string | null): string {
  const d = parseDate(v)
  if (!d) return ''
  return dtf(undefined, { month: 'long' }).format(d)
}

/**
 * How stale the dump is. Buckets requested by the user:
 *   < 3h   → "fresh"            (green)
 *   3–12h  → "fetched Xh ago"   (amber)
 *   > 12h  → "fetched Xh/Xd ago" (RED, stale → show the refresh banner)
 */
export function freshness(
  v?: string | null,
  now: number = Date.now(),
): { label: string; color: string; level: 'fresh' | 'aging' | 'stale' | 'unknown'; full: string; stale: boolean; ageHours: number } {
  const d = parseDate(v)
  if (!d) return { label: 'no run yet', color: '#94a3b8', level: 'unknown', full: '—', stale: false, ageHours: 0 }
  const full = fmtDateTime(v)
  const h = (now - d.getTime()) / 3_600_000
  if (h < 3) return { label: 'fresh', color: '#22c55e', level: 'fresh', full, stale: false, ageHours: h }
  const ago = h < 48 ? `fetched ${Math.floor(h)}h ago` : `fetched ${Math.round(h / 24)}d ago`
  if (h < 12) return { label: ago, color: '#f59e0b', level: 'aging', full, stale: false, ageHours: h }
  return { label: ago, color: '#ef4444', level: 'stale', full, stale: true, ageHours: h }
}

// ── Sprint ────────────────────────────────────────────────────────────────
export interface SprintInfo {
  name: string
  state: 'active' | 'future' | 'closed' | ''
  start: string | null
  end: string | null
}

/** Parse the intern's canonical sprint string: "Name (state · YYYY-MM-DD → YYYY-MM-DD)".
 *  Degrades gracefully: bare names, missing dates and missing state all still parse. */
export function parseSprint(s?: string | null): SprintInfo | null {
  if (!s || !s.trim()) return null
  const m = s.match(/^(.*?)\s*\((active|future|closed)\b[^)]*\)\s*$/i)
  const name = (m ? m[1] : s.replace(/\s*\([^)]*\)\s*$/, '')).trim() || s.trim()
  const state = (m?.[2]?.toLowerCase() ?? '') as SprintInfo['state']
  const dates = s.match(/(\d{4}-\d{2}-\d{2})\s*(?:→|->|to)\s*(\d{4}-\d{2}-\d{2})/)
  return { name, state, start: dates?.[1] ?? null, end: dates?.[2] ?? null }
}

/** The sprint to headline: the ACTIVE sprint mentioned by the most board tickets,
 *  else the next FUTURE one — never a closed one (the header shouldn't dwell on the past). */
export function currentSprint(tickets: { sprint?: string | null }[]): SprintInfo | null {
  const counts = new Map<string, { info: SprintInfo; n: number }>()
  for (const t of tickets) {
    const info = parseSprint(t.sprint)
    if (!info) continue
    const k = `${info.state}|${info.name}`
    const e = counts.get(k)
    if (e) e.n++
    else counts.set(k, { info, n: 1 })
  }
  const ranked = [...counts.values()].sort((a, b) => b.n - a.n)
  return (
    ranked.find((e) => e.info.state === 'active')?.info ??
    ranked.find((e) => e.info.state === 'future')?.info ??
    null
  )
}

/** Working days (Mon–Fri) in the INCLUSIVE calendar range [from, to]; 0 when to < from.
 *  Sprints run ~2–3 weeks, so a simple day walk is plenty. */
export function workdaysBetween(fromTs: number, toTs: number): number {
  if (isNaN(fromTs) || isNaN(toTs) || toTs < fromTs) return 0
  const d = new Date(fromTs)
  d.setHours(0, 0, 0, 0)
  const end = new Date(toTs)
  end.setHours(0, 0, 0, 0)
  let n = 0
  while (d <= end) {
    const wd = d.getDay()
    if (wd !== 0 && wd !== 6) n++
    d.setDate(d.getDate() + 1)
  }
  return n
}

export interface CycleTime {
  /** Calendar days from Opened to the last status change (or now, if still open). */
  totalDays: number
  /** Days the ticket sat in the In Progress column. */
  progressDays: number
  /** Days the ticket sat in the In Review column. */
  reviewDays: number
  /** progressDays + reviewDays — the part of the wall clock that was actually development. */
  devDays: number
  /** False when the lifecycle is a single entry, so there is nothing meaningful to show. */
  measurable: boolean
}

const DAY_MS = 86_400_000
const round1 = (n: number) => Math.round(n * 10) / 10

/**
 * How long a ticket took, and how much of that was development.
 *
 * Derived from `updateLog`, which the fetch already builds from the Jira changelog — the entries
 * are status transitions newest-first, so the time a ticket spent IN a status is the gap between
 * that entry and the one after it chronologically. Nothing extra is fetched.
 *
 * Total is deliberately wall-clock from Opened, not a sum of the statuses: the gap between "the
 * ticket existed" and "someone worked on it" is exactly what makes the dev-days split worth
 * showing.
 */
export function cycleTime(
  t: { created?: string | null; resolved?: string | null; updateLog?: UpdateLogEntry[] | null },
  now: number = Date.now(),
): CycleTime {
  const empty: CycleTime = { totalDays: 0, progressDays: 0, reviewDays: 0, devDays: 0, measurable: false }
  const log = (t.updateLog ?? [])
    .map((e) => ({ ts: Date.parse(e.when ?? ''), text: e.text ?? '' }))
    .filter((e) => !Number.isNaN(e.ts))
    .sort((a, b) => a.ts - b.ts)
  if (log.length < 2) return empty

  let progressMs = 0
  let reviewMs = 0
  for (let i = 0; i < log.length - 1; i++) {
    const span = log[i + 1].ts - log[i].ts
    if (span <= 0) continue
    // "Opened" and the synthetic "Marked DONE — <date>" rows are not Jira statuses; the former
    // is the creation marker, the latter a duplicate of the Done transition.
    const label = log[i].text.replace(/\s+—.*$/, '')
    if (label === 'Opened') continue
    const col = mapStatusToColumn(label)
    if (col === 'prog') progressMs += span
    else if (col === 'rev') reviewMs += span
  }

  const startTs = Date.parse(t.created ?? '') || log[0].ts
  const endTs = Date.parse(t.resolved ?? '') || (t.resolved ? log[log.length - 1].ts : now)
  const totalMs = Math.max(0, endTs - startTs)
  const progressDays = round1(progressMs / DAY_MS)
  const reviewDays = round1(reviewMs / DAY_MS)

  return {
    totalDays: round1(totalMs / DAY_MS),
    progressDays,
    reviewDays,
    devDays: round1((progressMs + reviewMs) / DAY_MS),
    measurable: progressMs + reviewMs > 0 || totalMs > 0,
  }
}

/** "3.5d" / "<1d" — compact enough to sit inline without stealing attention. */
export function fmtDays(d: number): string {
  if (d <= 0) return '0d'
  if (d < 1) return '<1d'
  return `${d % 1 === 0 ? d : d.toFixed(1)}d`
}

/** Where the sprint stands relative to `now` — drives the header chip's label + colour.
 *  Forward-looking counts ("left" / "starts in") are WORKING days (Mon–Fri), matching a
 *  5-day sprint week; "ended ago" stays calendar days (how long it's actually been). */
export function sprintStatus(
  sp: SprintInfo,
  now: number,
): { label: string; color: string; pct: number | null } {
  const DAY = 86_400_000
  const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`
  const startTs = sp.start ? Date.parse(`${sp.start}T00:00:00`) : NaN
  const endTs = sp.end ? Date.parse(`${sp.end}T23:59:59`) : NaN
  if (!isNaN(startTs) && now < startTs) {
    return { label: `starts in ${days(workdaysBetween(now + DAY, startTs))}`, color: '#64748b', pct: 0 }
  }
  if (!isNaN(endTs)) {
    if (now > endTs) return { label: `ended ${days(Math.ceil((now - endTs) / DAY))} ago`, color: '#ef4444', pct: 1 }
    const left = workdaysBetween(now, endTs) // includes today when it's a weekday
    const pct =
      !isNaN(startTs) && endTs > startTs
        ? Math.min(1, Math.max(0, workdaysBetween(startTs, now) / Math.max(1, workdaysBetween(startTs, endTs))))
        : null
    return { label: `${days(left)} left`, color: left <= 3 ? '#f59e0b' : '#3b82f6', pct }
  }
  return { label: sp.state || 'sprint', color: '#64748b', pct: null }
}

/**
 * The ticket's sprint IF that sprint hasn't started yet — work that is *queued* (next
 * sprint, or a grooming bucket like "Team READY"), not committed to the current one.
 *
 * Jira's own `state` is authoritative: a sprint nobody has clicked "Start" on stays
 * `future` even once its planned start date has slipped by, and a READY bucket carries
 * no dates at all. Dates are only consulted for dumps that carry no state.
 */
export function futureSprintOf(sprint?: string | null, now: number = Date.now()): SprintInfo | null {
  const sp = parseSprint(sprint)
  if (!sp) return null
  if (sp.state === 'future') return sp
  if (sp.state) return null // active / closed → live work, belongs on the board
  const startTs = sp.start ? Date.parse(`${sp.start}T00:00:00`) : NaN
  return !Number.isNaN(startTs) && now < startTs ? sp : null
}

/**
 * Board rule: a To Do ticket parked in a not-yet-started sprint is NOT this sprint's
 * work — it gets its own "Next Sprint" section instead of padding the To Do column
 * (otherwise a fully-cleared To Do still looks like you have work outstanding).
 *
 * Deliberately scoped to `todo`: the moment you actually pick a next-sprint ticket up,
 * it shows in In Progress / Review / QA / On Hold where the real work state is.
 */
export function isNextSprint(t: { column: string; sprint?: string | null; queued?: boolean }, now: number): boolean {
  if (t.column !== 'todo') return false
  if (t.queued !== undefined) return t.queued // an optimistic drop decides before Jira's sprint comes back
  const sp = futureSprintOf(t.sprint, now)
  return sp != null && isNextSprintBucket(sp)
}

/**
 * Which not-yet-started sprints are "Next Sprint": a dated sprint (the one the team is heading into), or one of
 * the two grooming buckets — READY (groomed, waiting for a sprint) and REFINEMENT (still being groomed).
 * Any other undated future-state sprint is not, so its tickets stay in the To Do box.
 */
export function isNextSprintBucket(sp: SprintInfo): boolean {
  return sp.start != null || bucketRank(sp) < 2
}

/** READY first, then REFINEMENT; 2 = not a bucket. */
function bucketRank(sp: SprintInfo): number {
  if (/\bready\b/i.test(sp.name)) return 0
  if (/\brefinement\b/i.test(sp.name)) return 1
  return 2
}

/**
 * How far off a not-yet-started sprint is, SHORT enough to share a line with its name. A grooming bucket
 * ("Team READY") carries no dates, and a `future` sprint whose planned start has slipped is still not
 * started. Working days, like the header's sprint chip.
 */
export function sprintWhen(sp: SprintInfo, now: number = Date.now()): string {
  const startTs = sp.start ? Date.parse(`${sp.start}T00:00:00`) : NaN
  if (Number.isNaN(startTs) || now >= startTs) return 'not started'
  const d = workdaysBetween(now + 86_400_000, startTs)
  return `starts in ${d} day${d === 1 ? '' : 's'} · ${fmtDateShort(sp.start)}`
}

/** Order for the sprints of the Next Sprint space: dated ones soonest first, then READY, then REFINEMENT. */
export function compareFutureSprints(a: SprintInfo, b: SprintInfo): number {
  return (a.start ?? '9999').localeCompare(b.start ?? '9999') || bucketRank(a) - bucketRank(b) || a.name.localeCompare(b.name)
}

/** Compact "Jul 9" style date (no year) — for tight UI like the header sprint chip. */
export function fmtDateShort(v?: string | null): string {
  const d = parseDate(v)
  if (!d) return v ?? '—'
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// ── misc ──────────────────────────────────────────────────────────────────
export function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

export function shortBranch(b?: string | null, max = 30): string {
  if (!b) return ''
  return b.length > max ? b.slice(0, max - 1) + '…' : b
}

/**
 * Some models wrap an AI brief as {"html": "…"} despite the prompt forbidding it, and a few
 * of those slipped into stored data. Unwrap before rendering; the intern also regenerates
 * them, but render-time healing means no brief ever SHOWS as raw JSON.
 */
export function unwrapBrief(raw?: string | null): string | null {
  if (!raw) return raw ?? null
  const s = raw.trim()
  if (!s.startsWith('{')) return raw
  try {
    const obj = JSON.parse(s) as Record<string, unknown>
    for (const k of ['html', 'summary', 'brief', 'text']) {
      const v = obj[k]
      if (typeof v === 'string' && v.trim()) return v.trim()
    }
  } catch {
    // Wrapped but not valid JSON (literal newlines inside the string) — peel by regex.
    const m = /"(?:html|summary|brief|text)"\s*:\s*"([\s\S]*?)"\s*\}\s*$/.exec(s)
    if (m) return m[1].replace(/\\"/g, '"').replace(/\\n/g, '\n').trim()
  }
  return raw
}
