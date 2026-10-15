import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { AssigneeHop, ColumnKey, LinkRef, RaisedTicket } from '../../types'
import { COLUMN_META, mapStatusToColumn } from '../../lib/columns'
import { fmtDate, relTime, priorityMeta, projectOf, typeMeta, effectiveType, yearOf, hexToRgba, isAssignedToMe, unwrapBrief } from '../../lib/format'
import { matchRow, parseQuery } from '../../lib/search'
import { useDialogFocus } from '../../hooks/useDialogFocus'
import { PriorityGlyph, SafeHtml } from '../common/ui'
import { ChevronIcon, CheckIcon, ClockIcon, DocIcon, ExpandAllIcon, LinkIcon, MegaphoneIcon, PersonIcon, QuestionIcon, RefreshIcon, SearchIcon, SparkleIcon, TypeIcon } from '../common/Icons'

// The Raised view's own palette — indigo identity (deliberately apart from the Completed
// archive's green/gold, and not a red/alarm family); amber marks what's still open.
const RAISED = '#6366f1'
const OPEN = '#f59e0b'
const HANDOFF = '#0ea5e9' // a ticket that moved between people
const FIXED = '#22c55e'
const NOBODY = '#64748b'

/**
 * Fixed widths for the right-hand rail, right-to-left: Raised date, Status, Assignee,
 * hand-off count. One source so the header row and every ticket row agree to the pixel
 * (same rule as the Completed archive's rail).
 */
const RAIL = { hands: 44, assignee: 150, status: 112, date: 98 }

type Who = 'me' | 'others' | 'none'
type UserRef = { name?: string | null; accountId?: string | null } | null | undefined

const colOf = (it: RaisedTicket): ColumnKey => it.column ?? mapStatusToColumn(it.status)

/** Real hand-offs only — the first assignment (from nobody) is not a REassignment. */
const handoffs = (it: RaisedTicket): AssigneeHop[] => (it.assigneeLog ?? []).filter((h) => !!h.from)

const whoHolds = (it: RaisedTicket, user: UserRef): Who =>
  !it.assignee ? 'none' : isAssignedToMe(it.assignee, user) ? 'me' : 'others'

/** "Doe, Alex (DEV001)" → "Alex Doe" — short enough for the rail cell. */
function shortName(raw?: string | null): string {
  if (!raw) return ''
  const noId = raw.replace(/\s*\([^)]*\)\s*$/, '').trim()
  const comma = noId.indexOf(',')
  return comma === -1 ? noId : `${noId.slice(comma + 1).trim()} ${noId.slice(0, comma).trim()}`
}

/** Status buckets for the filter chips — coarser than the five board columns on purpose. */
const BUCKETS = [
  { key: 'open', label: 'Open', color: '#64748b', cols: ['todo', 'blocked', 'hold'] as ColumnKey[] },
  { key: 'prog', label: 'In progress', color: '#3b82f6', cols: ['prog'] as ColumnKey[] },
  { key: 'review', label: 'Review / QA', color: '#8b5cf6', cols: ['rev', 'qa'] as ColumnKey[] },
  { key: 'done', label: 'Fixed', color: FIXED, cols: ['done'] as ColumnKey[] },
] as const
type BucketKey = (typeof BUCKETS)[number]['key']

const bucketOf = (it: RaisedTicket): BucketKey => {
  const col = colOf(it)
  return BUCKETS.find((b) => b.cols.includes(col))?.key ?? 'open'
}

type MonthGroup = { label: string; rows: RaisedTicket[] }

/** Near-full-screen overlay listing every ticket I reported. Controlled by App, like Completed. */
export function RaisedOverlay({
  open,
  onClose,
  items: rawItems,
  onOpen,
  user,
  onRefresh,
  refreshing,
  fetchedAt,
  briefsEnabled,
  pauseEsc,
}: {
  open: boolean
  onClose: () => void
  items: RaisedTicket[]
  onOpen: (key: string) => void
  /** Who "me" is, for the with-me / with-others split. */
  user: UserRef
  /** The view's own pull — these tickets are invisible to the normal board refresh. Served mode only. */
  onRefresh?: () => void
  refreshing?: boolean
  /** When raised[] was last re-fetched from Jira (shown beside the refresh button). */
  fetchedAt?: string | null
  /** Settings → AI briefs: show the per-ticket aiSummary in the peek. */
  briefsEnabled?: boolean
  /** When a ticket detail is layered on top, ignore Esc here so one keypress closes only the top layer. */
  pauseEsc?: boolean
}) {
  const items = useMemo(() => {
    const seen = new Set<string>()
    return rawItems.filter((it) => !seen.has(it.key) && (seen.add(it.key), true))
  }, [rawItems])

  const [q, setQ] = useState('')
  const [proj, setProj] = useState<string | null>(null)
  const [typ, setTyp] = useState<string | null>(null)
  const [bucket, setBucket] = useState<BucketKey | null>(null)
  const [who, setWho] = useState<null | Who | 'moved'>(null)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())

  // Fresh start each time the view reopens — same rule as the Completed archive.
  useEffect(() => {
    if (open) return
    setQ('')
    setProj(null)
    setTyp(null)
    setBucket(null)
    setWho(null)
    setExpanded(new Set())
  }, [open])

  const pauseRef = useRef(false)
  const panelRef = useRef<HTMLDivElement>(null)
  useDialogFocus(open, panelRef)
  pauseRef.current = !!pauseEsc
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !pauseRef.current) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const projects = useMemo(() => {
    const m = new Map<string, number>()
    for (const it of items) {
      const p = it.project || projectOf(it.key)
      m.set(p, (m.get(p) ?? 0) + 1)
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [items])

  const types = useMemo(() => {
    const m = new Map<string, number>()
    for (const it of items) {
      const t = (effectiveType(it) || 'Other').trim()
      m.set(t, (m.get(t) ?? 0) + 1)
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [items])

  const stats = useMemo(
    () => ({
      open: items.filter((it) => bucketOf(it) !== 'done').length,
      fixed: items.filter((it) => bucketOf(it) === 'done').length,
      moved: items.filter((it) => handoffs(it).length > 0).length,
      unassigned: items.filter((it) => whoHolds(it, user) === 'none').length,
    }),
    [items, user],
  )

  const terms = useMemo(() => parseQuery(q), [q])
  const chipsMatch = (it: RaisedTicket) => {
    if (proj && (it.project || projectOf(it.key)) !== proj) return false
    if (typ && (effectiveType(it) || 'Other').trim() !== typ) return false
    if (bucket && bucketOf(it) !== bucket) return false
    if (who === 'moved') return handoffs(it).length > 0
    return !who || whoHolds(it, user) === who
  }
  const filtered = useMemo(
    () => items.filter((it) => chipsMatch(it) && matchRow(it, terms) !== null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, terms, proj, typ, bucket, who, user],
  )

  // Chronology of when I RAISED them: newest first, year → month of `created`.
  const groups = useMemo(() => {
    const byYear = new Map<string, RaisedTicket[]>()
    for (const it of filtered) {
      const y = yearOf(it.created)
      if (!byYear.has(y)) byYear.set(y, [])
      byYear.get(y)!.push(it)
    }
    const out: [string, MonthGroup[]][] = []
    for (const [year, arr] of [...byYear.entries()].sort((a, b) => b[0].localeCompare(a[0]))) {
      arr.sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''))
      const months: MonthGroup[] = []
      for (const it of arr) {
        const d = it.created ? new Date(it.created) : null
        const label = d && !isNaN(d.getTime()) ? d.toLocaleString(undefined, { month: 'long' }) : ''
        const last = months[months.length - 1]
        if (last && last.label === label) last.rows.push(it)
        else months.push({ label, rows: [it] })
      }
      out.push([year, months])
    }
    return out
  }, [filtered])

  /** "2023 – 2026" — the span of raising, for the subtitle. */
  const span = useMemo(() => {
    const years = items.map((it) => yearOf(it.created)).filter((y) => /^\d{4}$/.test(y)).sort()
    if (!years.length) return null
    return years[0] === years[years.length - 1] ? years[0] : `${years[0]}–${years[years.length - 1]}`
  }, [items])

  const allExpanded = filtered.length > 0 && filtered.every((it) => expanded.has(it.key))
  const toggleRow = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  const toggleAll = () => setExpanded(allExpanded ? new Set() : new Set(filtered.map((it) => it.key)))
  const empty = items.length === 0
  const filtering = !!q || !!proj || !!typ || !!bucket || !!who

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[45] flex justify-center overflow-hidden p-2 sm:p-5">
          <motion.div className="absolute inset-0 bg-black/60 backdrop-blur-sm" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
          <motion.div
            initial={{ opacity: 0, y: -40, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -30, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 300, damping: 32 }}
            ref={panelRef}
            tabIndex={-1}
            className="jb-dialog-panel relative flex max-h-full w-full max-w-[1540px] flex-col overflow-hidden rounded-3xl border border-[var(--line)] bg-[var(--bg)] shadow-2xl"
            role="dialog"
            aria-modal="true"
          >
            <span className="absolute inset-x-0 top-0 h-1" style={{ background: `linear-gradient(90deg, ${RAISED}, ${HANDOFF} 55%, #a855f7)` }} aria-hidden />

            {/* hero header: title + at-a-glance stat band */}
            <div
              className="shrink-0 border-b border-[var(--line)]"
              style={{ background: `radial-gradient(120% 140% at 0% 0%, ${hexToRgba(RAISED, 0.18)}, ${hexToRgba(RAISED, 0.05)} 42%, transparent 78%)` }}
            >
              <div className="flex items-center gap-3.5 px-6 pt-5 sm:gap-4">
                <span
                  className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl"
                  style={{ background: `linear-gradient(140deg, ${hexToRgba(RAISED, 0.28)}, ${hexToRgba(RAISED, 0.1)})`, boxShadow: `inset 0 0 0 1px ${hexToRgba(RAISED, 0.4)}, 0 10px 26px -14px ${RAISED}` }}
                >
                  <MegaphoneIcon size={24} color={RAISED} />
                </span>
                <div className="min-w-0">
                  <h2 className="bg-gradient-to-r bg-clip-text text-[24px] font-black leading-none tracking-tight text-transparent" style={{ backgroundImage: `linear-gradient(95deg, ${RAISED}, #a855f7)` }}>
                    Raised by me
                  </h2>
                  <p className="mt-1.5 truncate text-[12px] font-medium text-[var(--muted)]">
                    {empty ? (
                      'bugs and asks I reported — whoever works them'
                    ) : (
                      <>
                        <b className="text-[var(--ink-soft)]">{items.length}</b> ticket{items.length === 1 ? '' : 's'} reported
                        {' · '}
                        <b className="text-[var(--ink-soft)]">{projects.length}</b> project{projects.length === 1 ? '' : 's'}
                        {span && ` · ${span}`}
                        {stats.open > 0 && (
                          <span title="Raised tickets that are not Done yet — the ones still waiting on a fix.">
                            {' · '}
                            <b style={{ color: OPEN }}>{stats.open}</b> still open
                          </span>
                        )}
                      </>
                    )}
                  </p>
                </div>
                <div className="ml-auto flex shrink-0 items-center gap-2.5">
                  {/* Raised tickets you don't WORK never ride the normal board refresh — this
                      button is the one pull that updates this list. Always a HARD fetch: it
                      re-pulls EVERY reported ticket (updates the rows already here) and the
                      full search also surfaces newly raised ones not in the list yet. */}
                  {onRefresh && (
                    <div className="flex flex-col items-end gap-1">
                      <motion.button
                        whileHover={refreshing ? undefined : { scale: 1.04, y: -1 }}
                        whileTap={refreshing ? undefined : { scale: 0.95 }}
                        transition={{ type: 'spring', stiffness: 400, damping: 22 }}
                        onClick={onRefresh}
                        disabled={refreshing}
                        aria-busy={refreshing || undefined}
                        title="Hard refresh — re-pulls EVERY ticket you ever reported straight from Jira: rows already listed pick up their updates, and newly raised tickets appear. (The board's normal refresh never covers tickets other people are working.)"
                        className="inline-flex h-10 items-center gap-1.5 rounded-xl border px-3.5 text-[12px] font-bold transition-colors"
                        style={{
                          borderColor: hexToRgba(RAISED, 0.45),
                          color: RAISED,
                          background: hexToRgba(RAISED, refreshing ? 0.14 : 0.07),
                          opacity: refreshing ? 0.85 : 1,
                        }}
                      >
                        <motion.span
                          className="inline-flex"
                          animate={refreshing ? { rotate: 360 } : { rotate: 0 }}
                          transition={refreshing ? { repeat: Infinity, duration: 0.8, ease: 'linear' } : { type: 'spring', stiffness: 300, damping: 20 }}
                        >
                          <RefreshIcon size={13} color={RAISED} />
                        </motion.span>
                        {refreshing ? 'Fetching all…' : 'Hard refresh'}
                      </motion.button>
                      {fetchedAt && !refreshing && (
                        <span className="text-[10px] font-semibold text-[var(--muted)]" title={`This list was last re-fetched from Jira ${fmtDate(fetchedAt)}`}>
                          fetched {relTime(fetchedAt) || fmtDate(fetchedAt)}
                        </span>
                      )}
                    </div>
                  )}
                  <button
                    onClick={onClose}
                    className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-[var(--line)] bg-[var(--surface-solid)] text-[15px] text-[var(--muted)] transition-colors hover:border-[var(--muted)] hover:text-[var(--ink)]"
                    aria-label="Close"
                  >
                    ✕
                  </button>
                </div>
              </div>
              {!empty && (
                <div className="grid grid-cols-2 gap-2.5 px-6 pb-5 pt-4 sm:grid-cols-3 lg:grid-cols-5">
                  <StatTile n={items.length} label="Raised" color={RAISED} icon={<MegaphoneIcon size={14} color={RAISED} />} />
                  <StatTile n={stats.open} label="Still open" color={OPEN} icon={<ClockIcon size={14} color={OPEN} />} />
                  <StatTile n={stats.fixed} label="Fixed" color={FIXED} icon={<CheckIcon size={14} color={FIXED} />} />
                  <StatTile n={stats.moved} label="Reassigned" color={HANDOFF} icon={<PersonIcon size={14} color={HANDOFF} />} />
                  <StatTile n={stats.unassigned} label="Unassigned" color={NOBODY} icon={<QuestionIcon size={14} color={NOBODY} />} />
                </div>
              )}
            </div>

            {/* scroll body */}
            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 sm:px-6">
              {empty ? (
                <div className="py-16 text-center">
                  <div className="mb-3 text-3xl">📣</div>
                  <p className="text-[14px] font-bold text-[var(--ink)]">No raised tickets found yet.</p>
                  <p className="mx-auto mt-1.5 max-w-sm text-[12.5px] text-[var(--muted)]">
                    {onRefresh ? 'Hit “Refresh raised” above' : 'Run a board refresh'} (with Jira connected) to pull every ticket you ever reported. Sub-tickets you cut under your own work don&apos;t count — those are yours by default.
                  </p>
                </div>
              ) : (
                <>
                  {/* controls — two rows so search and the filter chips each get room */}
                  <div className="sticky top-0 z-10 -mx-4 mb-3 border-b border-[var(--line)] bg-[var(--bg)]/95 px-4 pb-3 pt-4 backdrop-blur-xl sm:-mx-6 sm:px-6">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <label className="flex items-center gap-2 rounded-xl border border-[var(--line)] bg-[var(--surface-solid)] px-3 py-2 card-shadow transition-colors focus-within:border-[var(--muted)]">
                        <span className="text-[var(--muted)]">
                          <SearchIcon size={14} />
                        </span>
                        <input
                          value={q}
                          onChange={(e) => setQ(e.target.value)}
                          placeholder="Ticket no., text, assignee…"
                          title="A bare number searches ticket numbers only. Anything else is a text search — titles, assignees, labels, components."
                          className="w-52 bg-transparent text-[12.5px] outline-none placeholder:text-[var(--muted)] md:w-64"
                        />
                        {q && (
                          <button onClick={() => setQ('')} className="text-[var(--muted)] hover:text-[var(--ink)]" aria-label="Clear search">
                            ✕
                          </button>
                        )}
                      </label>

                      <div className="ml-auto flex items-center gap-2.5">
                        {filtering && (
                          <span className="text-[11.5px] font-semibold tabular-nums text-[var(--muted)]">
                            <b style={{ color: RAISED }}>{filtered.length}</b> of {items.length}
                          </span>
                        )}
                        <button
                          onClick={toggleAll}
                          className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--line)] bg-[var(--surface-solid)] px-3 py-2 text-[11.5px] font-semibold text-[var(--ink-soft)] card-shadow transition-colors hover:border-[var(--muted)] hover:text-[var(--ink)]"
                        >
                          <ExpandAllIcon collapsed={!allExpanded} size={13} />
                          {allExpanded ? 'Collapse all' : 'Expand all'}
                        </button>
                      </div>
                    </div>

                    <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                      <FilterChip
                        active={bucket === null && who === null && proj === null && typ === null}
                        color={RAISED}
                        onClick={() => { setBucket(null); setWho(null); setProj(null); setTyp(null) }}
                        title="Clear every filter"
                      >
                        All
                      </FilterChip>
                      {BUCKETS.map((b) => (
                        <FilterChip
                          key={b.key}
                          active={bucket === b.key}
                          color={b.color}
                          onClick={() => setBucket(bucket === b.key ? null : b.key)}
                          n={items.filter((it) => bucketOf(it) === b.key).length}
                          title={b.key === 'done' ? 'Raised tickets that reached Done' : `Raised tickets currently ${b.label.toLowerCase()}`}
                        >
                          <span className="inline-block h-2 w-2 rounded-full" style={{ background: b.color }} />
                          {b.label}
                        </FilterChip>
                      ))}
                      <span className="mx-1 h-5 w-px shrink-0 bg-[var(--line-strong)]" aria-hidden />
                      <FilterChip active={who === 'me'} color="#14b8a6" onClick={() => setWho(who === 'me' ? null : 'me')} n={items.filter((it) => whoHolds(it, user) === 'me').length} title="Raised by you and currently assigned back to you">
                        With me
                      </FilterChip>
                      <FilterChip active={who === 'others'} color={HANDOFF} onClick={() => setWho(who === 'others' ? null : 'others')} n={items.filter((it) => whoHolds(it, user) === 'others').length} title="Currently assigned to someone else">
                        With others
                      </FilterChip>
                      <FilterChip active={who === 'none'} color={NOBODY} onClick={() => setWho(who === 'none' ? null : 'none')} n={stats.unassigned} title="Nobody is assigned yet">
                        Unassigned
                      </FilterChip>
                      <FilterChip active={who === 'moved'} color={OPEN} onClick={() => setWho(who === 'moved' ? null : 'moved')} n={stats.moved} title="Changed hands at least once since you raised it">
                        Reassigned
                      </FilterChip>
                      <span className="mx-1 h-5 w-px shrink-0 bg-[var(--line-strong)]" aria-hidden />
                      {projects.map(([p, n]) => (
                        <FilterChip key={p} active={proj === p} color={RAISED} onClick={() => setProj(proj === p ? null : p)} n={n} title={`Only ${p} tickets`}>
                          {p}
                        </FilterChip>
                      ))}
                      <span className="mx-1 h-5 w-px shrink-0 bg-[var(--line-strong)]" aria-hidden />
                      {types.map(([t, n]) => (
                        <FilterChip key={t} active={typ === t} color={typeMeta(t).color} onClick={() => setTyp(typ === t ? null : t)} n={n} title={`Only ${t} tickets`}>
                          <TypeIcon type={t} color={typ === t ? typeMeta(t).color : 'currentColor'} size={11} />
                          {t}
                        </FilterChip>
                      ))}
                    </div>
                  </div>

                  {filtered.length > 0 && <RailHeader />}

                  {/* chronological timeline of raising: year → month → rows */}
                  <div className="flex flex-col gap-7">
                    {groups.map(([year, months]) => {
                      const count = months.reduce((s, m) => s + m.rows.length, 0)
                      return (
                        <div key={year}>
                          <div className="mb-3 flex items-center gap-3 px-1">
                            <span className="text-[19px] font-black tracking-tight text-[var(--ink)]">{year}</span>
                            <span className="rounded-full px-2.5 py-[3px] text-[11px] font-extrabold tabular-nums" style={{ color: RAISED, background: hexToRgba(RAISED, 0.12) }}>
                              {count}
                            </span>
                            <span className="h-px flex-1" style={{ background: `linear-gradient(90deg, ${hexToRgba(RAISED, 0.35)}, transparent)` }} />
                          </div>
                          <div className="flex flex-col gap-5">
                            {months.map((m, mi) => (
                              <div key={`${m.label}-${mi}`}>
                                {m.label && (
                                  <div className="mb-2 flex items-center gap-2 px-1">
                                    <span className="h-3 w-1 rounded-full" style={{ background: hexToRgba(RAISED, 0.5) }} aria-hidden />
                                    <span className="text-[11px] font-extrabold uppercase tracking-[0.1em] text-[var(--ink-soft)]">{m.label}</span>
                                    <span className="text-[11px] font-semibold tabular-nums text-[var(--muted)]">{m.rows.length}</span>
                                  </div>
                                )}
                                <div className="flex flex-col gap-2">
                                  {m.rows.map((it) => (
                                    <RaisedRow key={it.key} it={it} user={user} briefsEnabled={briefsEnabled} expanded={expanded.has(it.key)} onToggle={() => toggleRow(it.key)} onOpen={() => onOpen(it.key)} />
                                  ))}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )
                    })}
                    {filtered.length === 0 && (
                      <div className="py-14 text-center">
                        <div className="mb-2 text-2xl">🔍</div>
                        <p className="text-[13px] font-semibold text-[var(--ink)]">No raised tickets match{q ? ` “${q}”` : ''}.</p>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  )
}

/** Column labels for the rail. Mirrors RaisedRow's trailing cells exactly. */
function RailHeader() {
  return (
    <div className="mb-2 hidden items-center border border-transparent px-3 text-[9.5px] font-bold uppercase tracking-[0.09em] text-[var(--muted)] sm:flex" style={{ borderLeftWidth: 3 }} aria-hidden>
      <span className="flex-1" />
      <span className="text-center" style={{ width: RAIL.hands }} title="Times it changed hands since you raised it">Hands</span>
      <span className="pl-2 text-left" style={{ width: RAIL.assignee }}>Assignee</span>
      <span className="text-center" style={{ width: RAIL.status }}>Status</span>
      <span className="text-right" style={{ width: RAIL.date }}>Raised</span>
    </div>
  )
}

/** The hand-off chain as a tooltip: "you raised it → Priya (12 Jan) → Rahul (3 Mar)". */
function handoffTitle(hops: AssigneeHop[]): string {
  if (!hops.length) return 'Never reassigned'
  const steps = hops.map((h) => `${shortName(h.from) || 'Unassigned'} → ${shortName(h.to) || 'Unassigned'}${h.when ? ` (${fmtDate(h.when)})` : ''}`)
  return `Changed hands ${hops.length} time${hops.length === 1 ? '' : 's'}:\n${steps.join('\n')}`
}

function RaisedRow({ it, user, briefsEnabled, expanded, onToggle, onOpen }: { it: RaisedTicket; user: UserRef; briefsEnabled?: boolean; expanded: boolean; onToggle: () => void; onOpen: () => void }) {
  const col = colOf(it)
  const accent = COLUMN_META[col]?.accent ?? NOBODY
  const et = effectiveType(it)
  const tm = typeMeta(et)
  const pm = priorityMeta(it.priority)
  const who = whoHolds(it, user)
  const hops = handoffs(it)
  const rel = relTime(it.created)
  const holder = who === 'none' ? 'Unassigned' : shortName(it.assignee)
  const holderColor = who === 'me' ? '#14b8a6' : who === 'others' ? HANDOFF : NOBODY
  // What this ticket was raised from / blocks / duplicates — epic lineage leads, issue links follow.
  const links: LinkRef[] = [...(it.epic?.key ? [it.epic] : []), ...(it.related ?? [])]

  return (
    <div
      className="group/row overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--surface-solid)] transition-all hover:-translate-y-px hover:border-[var(--line-strong)] hover:shadow-[0_10px_24px_-16px_rgba(16,24,40,0.5)]"
      // The left edge carries the STATUS colour — one glance down the list answers
      // "where does everything I raised stand?", which is this view's whole job.
      style={{ borderLeftWidth: 3, borderLeftColor: accent }}
    >
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <button
          onClick={onToggle}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--ink)]"
          aria-label={expanded ? 'Collapse details' : 'Expand details'}
          aria-expanded={expanded}
          title="Quick peek"
        >
          <motion.span animate={{ rotate: expanded ? 90 : 0 }} className="inline-flex">
            <ChevronIcon size={12} />
          </motion.span>
        </button>

        <button onClick={onOpen} className="group flex min-w-0 flex-1 items-center gap-2.5 text-left" title="Open full ticket details">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg" style={{ background: hexToRgba(tm.color, 0.14), boxShadow: `inset 0 0 0 1px ${hexToRgba(tm.color, 0.22)}` }} title={et || 'Ticket'}>
            <TypeIcon type={et} color={tm.color} size={15} />
          </span>
          {/* Fixed-width key + priority columns so every title starts at the same x. */}
          <span className="w-[104px] shrink-0 whitespace-nowrap font-mono text-[12.5px] font-extrabold" style={{ color: 'var(--link)' }}>
            {it.key}
          </span>
          <span className="flex w-[30px] shrink-0 justify-start">
            <PriorityGlyph priority={it.priority} size={15} />
          </span>
          <span className="min-w-0 flex-1 truncate text-[14.5px] font-semibold text-[var(--ink)] group-hover:underline">{it.title}</span>

          {/* Which work it hangs off — the first linked ticket, with a count when there are more. */}
          {links.length > 0 && (
            <span
              className="hidden shrink-0 items-center gap-1 rounded-md border px-1.5 py-[2px] font-mono text-[10px] font-bold lg:inline-flex"
              style={{ borderColor: hexToRgba(HANDOFF, 0.35), color: HANDOFF, background: hexToRgba(HANDOFF, 0.09) }}
              title={links.map((l) => `${l.relation || 'linked'}: ${l.key}${l.summary ? ` — ${l.summary}` : ''}`).join('\n')}
            >
              ⇄ {links[0].key}
              {links.length > 1 && <span className="opacity-70">+{links.length - 1}</span>}
            </span>
          )}
        </button>

        {/* Right rail — right-to-left: Raised date, Status, Assignee, hand-off count. */}
        <span className="hidden shrink-0 items-center sm:flex">
          <span className="flex items-center justify-center" style={{ width: RAIL.hands }} title={handoffTitle(hops)}>
            {hops.length > 0 && (
              <span className="inline-flex items-center gap-0.5 text-[11px] font-extrabold tabular-nums" style={{ color: OPEN }}>
                ↻ {hops.length}
              </span>
            )}
          </span>
          <span className="flex items-center gap-1 overflow-hidden pl-2" style={{ width: RAIL.assignee }} title={who === 'none' ? 'Nobody assigned yet' : `Currently with ${shortName(it.assignee)}${who === 'me' ? ' (you)' : ''}`}>
            <PersonIcon size={10} color={holderColor} />
            <span className={`truncate text-[11.5px] font-semibold ${who === 'none' ? 'italic' : ''}`} style={{ color: holderColor }}>
              {who === 'me' ? 'me' : holder}
            </span>
          </span>
          {/* Own pill, not StatusBadge: raw status names run long ("Selected for Development"),
              and this cell is fixed-width — the label must truncate, never bleed over the date. */}
          <span className="flex justify-center overflow-hidden px-1" style={{ width: RAIL.status }} title={`Status: ${it.status || COLUMN_META[col]?.label || '—'}`}>
            <span
              className="inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-[3px] text-[10.5px] font-bold leading-none"
              style={{ borderColor: hexToRgba(accent, 0.45), color: accent, background: hexToRgba(accent, 0.12) }}
            >
              <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: accent }} />
              <span className="truncate">{it.status || COLUMN_META[col]?.label || '—'}</span>
            </span>
          </span>
          <span className="flex flex-col items-end leading-tight" style={{ width: RAIL.date }}>
            <span className="text-[12px] font-bold tabular-nums text-[var(--ink-soft)]">{fmtDate(it.created)}</span>
            {rel && <span className="text-[10px] font-medium text-[var(--muted)]">{rel}</span>}
          </span>
        </span>
      </div>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.22 }} className="overflow-hidden">
            <div className="border-t border-[var(--line)] bg-[var(--surface-2)] px-4 py-3.5">
              {/* The brief leads: for a ticket someone else works, it's the fastest answer to
                  "what is this and where does it stand" without opening the full page. */}
              {briefsEnabled && it.aiSummary && (
                <div className="mb-3.5 overflow-hidden rounded-xl border" style={{ borderColor: hexToRgba(RAISED, 0.3), background: hexToRgba(RAISED, 0.05) }}>
                  <div className="flex items-center gap-1.5 border-b px-3.5 py-2 text-[10px] font-bold uppercase tracking-[0.07em]" style={{ borderColor: hexToRgba(RAISED, 0.18), color: RAISED }}>
                    <SparkleIcon size={12} color={RAISED} />
                    AI brief
                    {it.aiSummaryAt && (
                      <span className="ml-auto font-semibold normal-case tracking-normal text-[var(--muted)]">{relTime(it.aiSummaryAt)}</span>
                    )}
                  </div>
                  <SafeHtml html={unwrapBrief(it.aiSummary)} className="px-3.5 py-3 text-[13px] leading-relaxed text-[var(--ink-soft)]" />
                </div>
              )}

              <div className="grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-4">
                <Field label="Raised on" value={it.created ? fmtDate(it.created) : '—'} />
                <Field label="Last update" value={it.lastUpdate ? `${fmtDate(it.lastUpdate)}${relTime(it.lastUpdate) ? ` · ${relTime(it.lastUpdate)}` : ''}` : '—'} />
                <Field label="Current status" value={it.status || '—'} dot={accent} />
                <Field label="Fixed on" value={it.resolved ? fmtDate(it.resolved) : col === 'done' ? '—' : 'not yet'} dot={it.resolved ? FIXED : undefined} />
                <Field label="Assigned to" value={who === 'none' ? 'nobody yet' : `${shortName(it.assignee)}${who === 'me' ? ' (you)' : ''}`} dot={holderColor} />
                <Field label="Reported by" value={shortName(it.reporter) || 'you'} />
                <Field label="Type" value={et && et !== it.type ? `${et} · ${it.type}` : it.type || '—'} />
                <Field label="Priority" value={pm.label} dot={pm.color} />
                <Field label="Story points" value={typeof it.storyPoints === 'number' ? `${it.storyPoints}` : '—'} />
                <Field label="Sprint" value={it.sprint || '—'} />
                {(it.labels?.length ?? 0) > 0 && <Field label="Labels" value={it.labels!.join(', ')} />}
                {(it.components?.length ?? 0) > 0 && <Field label="Components" value={it.components!.join(', ')} />}
              </div>

              {/* The raw report, as filed — scrolls when long rather than swallowing the peek. */}
              {it.description && (
                <div className="mt-3.5">
                  <Section label="Description" icon={<DocIcon size={12} color="var(--muted)" />}>
                    <SafeHtml html={it.description} className="max-h-44 overflow-y-auto text-[12.5px] leading-relaxed text-[var(--ink-soft)]" />
                  </Section>
                </div>
              )}

              {/* Who has held it, and what it hangs off — the view's two "vivid" answers. */}
              <div className={`mt-3.5 grid grid-cols-1 items-start gap-2.5 ${links.length > 0 ? 'md:grid-cols-2' : ''}`}>
                <Section label={hops.length ? `Hand-offs (${hops.length})` : 'Hand-offs'} icon={<PersonIcon size={12} color="var(--muted)" />}>
                  {it.assigneeLog?.length ? (
                    <div className="flex flex-wrap items-center gap-y-1.5">
                      <HolderPill name="raised by you" color={RAISED} />
                      {it.assigneeLog.map((h, i) => (
                        <span key={i} className="inline-flex items-center">
                          <span className="mx-1.5 text-[11px] text-[var(--muted)]">→</span>
                          <HolderPill
                            name={shortName(h.to) || 'unassigned'}
                            color={h.to ? (isAssignedToMe(h.to, user) ? '#14b8a6' : HANDOFF) : NOBODY}
                            when={h.when}
                          />
                        </span>
                      ))}
                    </div>
                  ) : (
                    <span className="text-[12px] text-[var(--muted)]">
                      {who === 'none' ? 'Never picked up — still waiting for an owner.' : 'No assignee changes recorded since it was raised.'}
                    </span>
                  )}
                </Section>

                {links.length > 0 && (
                  <Section label={`Linked tickets (${links.length})`} icon={<LinkIcon size={12} color="var(--muted)" />}>
                    <div className="flex flex-col gap-1.5">
                      {links.map((l, i) => (
                        <span key={`${l.key}-${i}`} className="inline-flex flex-wrap items-center gap-1.5 text-[12px]">
                          <span className="rounded-md border border-[var(--line)] bg-[var(--surface-2)] px-1.5 py-[1px] text-[10px] font-bold text-[var(--muted)]">
                            {l.relation || 'linked'}
                          </span>
                          {l.url ? (
                            <a href={l.url} target="_blank" rel="noopener noreferrer" className="font-mono text-[11.5px] font-extrabold hover:underline" style={{ color: 'var(--link)' }}>
                              {l.key}
                            </a>
                          ) : (
                            <span className="font-mono text-[11.5px] font-extrabold text-[var(--ink-soft)]">{l.key}</span>
                          )}
                          {l.summary && <span className="min-w-0 flex-1 truncate text-[var(--ink-soft)]" title={l.summary}>{l.summary}</span>}
                          {l.status && <span className="text-[10.5px] font-bold text-[var(--muted)]">{l.status}</span>}
                        </span>
                      ))}
                    </div>
                  </Section>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function HolderPill({ name, color, when }: { name: string; color: string; when?: string | null }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border px-2 py-[2px] text-[10.5px] font-bold leading-none"
      style={{ borderColor: hexToRgba(color, 0.4), color, background: hexToRgba(color, 0.1) }}
      title={when ? fmtDate(when) : undefined}
    >
      {name}
      {when && <span className="font-medium opacity-65">{fmtDate(when)}</span>}
    </span>
  )
}

function FilterChip({ active, color, onClick, n, title, children }: { active: boolean; color: string; onClick: () => void; n?: number; title?: string; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-bold transition-colors"
      style={{
        borderColor: active ? hexToRgba(color, 0.5) : 'var(--line)',
        color: active ? color : 'var(--muted)',
        background: active ? hexToRgba(color, 0.12) : 'var(--surface-solid)',
      }}
    >
      {children}
      {n != null && <span className="tabular-nums opacity-60">{n}</span>}
    </button>
  )
}

function StatTile({ n, label, color, icon }: { n: number; label: string; color: string; icon: ReactNode }) {
  return (
    <div
      className="rounded-2xl border px-3.5 py-2.5 transition-transform hover:-translate-y-0.5"
      style={{ borderColor: hexToRgba(color, 0.28), background: `linear-gradient(150deg, ${hexToRgba(color, 0.14)}, ${hexToRgba(color, 0.05)})` }}
    >
      <div className="flex items-center gap-1.5">
        <span className="inline-flex">{icon}</span>
        <span className="text-[22px] font-black leading-none tabular-nums" style={{ color }}>
          {n}
        </span>
      </div>
      <div className="mt-1.5 truncate text-[10px] font-bold uppercase tracking-[0.07em] text-[var(--muted)]">{label}</div>
    </div>
  )
}

function Section({ label, icon, children }: { label: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-[var(--line)] bg-[var(--surface-solid)] px-3 py-2.5">
      <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.07em] text-[var(--muted)]">
        {icon}
        {label}
      </div>
      {children}
    </div>
  )
}

function Field({ label, value, dot, hint }: { label: string; value: string; dot?: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <div className="mb-0.5 text-[10px] font-bold uppercase tracking-[0.07em] text-[var(--muted)]">{label}</div>
      <div className="flex items-center gap-1.5 truncate text-[12.5px] font-medium text-[var(--ink-soft)]" title={hint ?? value}>
        {dot && <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: dot }} />}
        <span className="truncate">{value}</span>
      </div>
    </div>
  )
}
