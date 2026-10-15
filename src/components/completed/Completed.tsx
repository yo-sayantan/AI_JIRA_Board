import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { CompletedTicket, Ticket } from '../../types'
import { fmtDate, relTime, priorityMeta, projectOf, typeMeta, effectiveType, releaseEnvOf, yearOf, monthOf, hexToRgba, branchesOf, branchStatusOf, prListOf, isMergedPr, isClosedPr, shortBranch, cycleTime, fmtDays } from '../../lib/format'
import { matchRow, parseQuery } from '../../lib/search'
import { useDialogFocus } from '../../hooks/useDialogFocus'
import { Pill, PrBadge, BranchStatusPill, PointsTag, safeHref } from '../common/ui'
import { BranchIcon, ChevronIcon, CommentIcon, ExpandAllIcon, PersonIcon, PrStateIcon, SearchIcon, SparkleIcon, TrophyIcon, TypeIcon } from '../common/Icons'

const DONE = '#22c55e'
const CONTEXT = '#8b5cf6' // parent tickets owned by others, shown for lineage
const PR_PURPLE = '#8b5cf6' // merged-PR accent
const SUB = '#0ea5e9'
const CONTEXT_PREF_KEY = 'jb-completed-show-context' // remembers the hide/show choice for context-parent rows

/**
 * Fixed widths for the right-hand rail, right-to-left: Date, PR, environment, comments.
 * They live in one place because the column header and every row must agree to the pixel —
 * these used to be inline chips that shifted around depending on which ones a ticket had,
 * so nothing lined up down the list.
 */
const RAIL = { comments: 46, env: 64, pr: 44, date: 98 }

/**
 * A row is "mine" when it was assigned to me. The only non-mine rows are parent tickets
 * owned by someone else, kept because I delivered a sub-ticket under them — shown for
 * context, tinted apart, and never counted toward my totals. Rows without the flag predate
 * it and are all mine.
 */
const isMine = (it: CompletedTicket) => it.mine !== false

/** The ticket's own pull requests plus those on its sub-tasks. */
function archivePrs(it: CompletedTicket) {
  return [...prListOf(it), ...(it.subtasks ?? []).flatMap((s) => prListOf(s))]
}

function matchesPrFilter(it: CompletedTicket, filter: null | 'any' | 'merged' | 'declined') {
  if (!filter) return true
  const prs = archivePrs(it)
  if (filter === 'merged') return prs.some(isMergedPr)
  if (filter === 'declined') return prs.some((p) => p.state === 'declined')
  return prs.some(isClosedPr)
}

type MonthGroup = { label: string; rows: CompletedTicket[] }

/** Near-full-screen overlay (slides in from the top) listing every completed ticket. Controlled by App. */
export function CompletedOverlay({
  open,
  onClose,
  items: rawItems,
  onOpen,
  pauseEsc,
}: {
  open: boolean
  onClose: () => void
  items: CompletedTicket[]
  onOpen: (key: string) => void
  /** When a ticket detail is layered on top, ignore Esc here so one keypress closes only the top layer. */
  pauseEsc?: boolean
}) {
  // Sub-tasks stay on the parent. The archive also stores each one as its own row so the
  // detail page can open it; those rows are not listed here.
  const all = useMemo(() => {
    const seen = new Set<string>()
    return rawItems.filter((it) => !it.parentKey && !seen.has(it.key) && (seen.add(it.key), true))
  }, [rawItems])
  const [q, setQ] = useState('')
  const [proj, setProj] = useState<string | null>(null)
  const [typ, setTyp] = useState<string | null>(null)
  const [prFilter, setPrFilter] = useState<null | 'any' | 'merged' | 'declined'>(null)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())

  const mineItems = useMemo(() => all.filter(isMine), [all])
  const contextCount = all.length - mineItems.length
  // Context parents (someone else's ticket, kept ONLY because I delivered a sub-ticket under it)
  // are lineage, not my work — so they can be toggled out of the view. The choice sticks across
  // sessions; default shows them. Stat tiles always count MY tickets only, so this toggle changes
  // only which rows are listed, never any number.
  const [showContext, setShowContext] = useState<boolean>(() => {
    try {
      return localStorage.getItem(CONTEXT_PREF_KEY) !== '0'
    } catch {
      return true
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(CONTEXT_PREF_KEY, showContext ? '1' : '0')
    } catch {
      /* private mode / storage disabled — the toggle still works for this session */
    }
  }, [showContext])
  const items = showContext ? all : mineItems

  // Fresh start each time the archive reopens — don't carry over a prior search / project filter /
  // expanded rows from the last time it was open.
  useEffect(() => {
    if (open) return
    setQ('')
    setProj(null)
    setTyp(null)
    setPrFilter(null)
    setExpanded(new Set())
  }, [open])

  const pauseRef = useRef(false)
  const panelRef = useRef<HTMLDivElement>(null)
  useDialogFocus(open, panelRef)
  pauseRef.current = !!pauseEsc
  useEffect(() => {
    if (!open) return
    // Ignore Esc while a ticket detail is layered on top (that drawer handles it first).
    // Body scroll-lock is owned centrally by App (single source of truth).
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

  const totalPts = useMemo(() => mineItems.reduce((s, it) => s + (it.storyPoints ?? 0), 0), [mineItems])

  // See lib/search — a bare number is treated as a ticket number, not as free text.
  const terms = useMemo(() => parseQuery(q), [q])
  const chipsMatch = (it: CompletedTicket) => {
    if (proj && (it.project || projectOf(it.key)) !== proj) return false
    if (!matchesPrFilter(it, prFilter)) return false
    return !typ || (effectiveType(it) || 'Other').trim() === typ
  }
  const filtered = useMemo(
    () => items.filter((it) => chipsMatch(it) && matchRow(it, terms) !== null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, terms, proj, typ, prFilter],
  )

  // Pure chronology: newest first, year → month. Types are surfaced via the row
  // accents and the filter chips, never by re-ordering.
  const groups = useMemo(() => {
    const byYear = new Map<string, CompletedTicket[]>()
    for (const it of filtered) {
      const y = yearOf(it.resolved)
      if (!byYear.has(y)) byYear.set(y, [])
      byYear.get(y)!.push(it)
    }
    const out: [string, MonthGroup[]][] = []
    for (const [year, arr] of [...byYear.entries()].sort((a, b) => b[0].localeCompare(a[0]))) {
      arr.sort((a, b) => (b.resolved ?? '').localeCompare(a.resolved ?? ''))
      const months: MonthGroup[] = []
      for (const it of arr) {
        const label = monthOf(it.resolved)
        const last = months[months.length - 1]
        if (last && last.label === label) last.rows.push(it)
        else months.push({ label, rows: [it] })
      }
      out.push([year, months])
    }
    return out
  }, [filtered])

  const stats = useMemo(
    () => ({
      merged: mineItems.filter((it) => prListOf(it).some(isMergedPr)).length,
      releases: mineItems.filter((it) => effectiveType(it) === 'Release').length,
      onboarding: mineItems.filter((it) => effectiveType(it) === 'Onboarding').length,
    }),
    [mineItems],
  )

  /** "2023 – 2026" — the span the archive actually covers, for the subtitle. */
  const span = useMemo(() => {
    const years = items.map((it) => yearOf(it.resolved)).filter((y) => /^\d{4}$/.test(y)).sort()
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
  const empty = all.length === 0
  const filtering = !!q || !!proj || !!typ || !!prFilter

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
            <span className="absolute inset-x-0 top-0 h-1" style={{ background: `linear-gradient(90deg, ${DONE}, ${SUB} 55%, ${CONTEXT})` }} aria-hidden />

            {/* hero header: title + at-a-glance stat band */}
            <div
              className="shrink-0 border-b border-[var(--line)]"
              style={{ background: `radial-gradient(120% 140% at 0% 0%, ${hexToRgba(DONE, 0.2)}, ${hexToRgba(DONE, 0.05)} 42%, transparent 78%)` }}
            >
              <div className="flex items-center gap-3.5 px-6 pt-5 sm:gap-4">
                <span
                  className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl"
                  style={{ background: `linear-gradient(140deg, ${hexToRgba(DONE, 0.3)}, ${hexToRgba(DONE, 0.1)})`, boxShadow: `inset 0 0 0 1px ${hexToRgba(DONE, 0.4)}, 0 10px 26px -14px ${DONE}` }}
                >
                  <TrophyIcon size={24} glint />
                </span>
                <div className="min-w-0">
                  <h2 className="bg-gradient-to-r bg-clip-text text-[24px] font-black leading-none tracking-tight text-transparent" style={{ backgroundImage: `linear-gradient(95deg, ${DONE}, #0ea5e9)` }}>
                    Completed
                  </h2>
                  <p className="mt-1.5 truncate text-[12px] font-medium text-[var(--muted)]">
                    {empty ? (
                      "everything I've shipped"
                    ) : (
                      <>
                        <b className="text-[var(--ink-soft)]">{mineItems.length}</b> tickets
                        {' · '}
                        <b className="text-[var(--ink-soft)]">{projects.length}</b> project{projects.length === 1 ? '' : 's'}
                        {span && ` · ${span}`}
                        {showContext && contextCount > 0 && (
                          <span title="Parent tickets owned by someone else, shown because you delivered a sub-ticket under them. Not counted in your totals — use “Mine only” to hide them.">
                            {' · '}
                            <b style={{ color: CONTEXT }}>+{contextCount}</b> parent{contextCount === 1 ? '' : 's'} for context
                          </span>
                        )}
                      </>
                    )}
                  </p>
                </div>
                <button
                  onClick={onClose}
                  className="ml-auto grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-[var(--line)] bg-[var(--surface-solid)] text-[15px] text-[var(--muted)] transition-colors hover:border-[var(--muted)] hover:text-[var(--ink)]"
                  aria-label="Close"
                >
                  ✕
                </button>
              </div>
              {!empty && (
                <div className="grid grid-cols-2 gap-2.5 px-6 pb-5 pt-4 sm:grid-cols-3 lg:grid-cols-5">
                  <StatTile n={mineItems.length} label="Tickets done" color={DONE} icon={<TrophyIcon size={14} />} />
                  <StatTile n={totalPts} label="Story points" color="#3b82f6" icon={<SparkleIcon size={14} color="#3b82f6" />} />
                  <StatTile n={stats.merged} label="PRs merged" color={CONTEXT} icon={<PrStateIcon state="merged" color={CONTEXT} size={14} />} />
                  <StatTile n={stats.releases} label="Releases" color="#ec4899" icon={<TypeIcon type="Release" color="#ec4899" size={14} />} />
                  <StatTile n={stats.onboarding} label="Onboarding" color="#84cc16" icon={<TypeIcon type="Onboarding" color="#84cc16" size={14} />} />
                </div>
              )}
            </div>

            {/* scroll body */}
            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 sm:px-6">
              {empty ? (
                <div className="py-16 text-center">
                  <div className="mb-3 text-3xl">🗃️</div>
                  <p className="text-[14px] font-bold text-[var(--ink)]">No completed tickets yet.</p>
                  <p className="mx-auto mt-1.5 max-w-sm text-[12.5px] text-[var(--muted)]">
                    Run the intern (with Jira connected) to pull every Done ticket ever assigned to you.
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
                          placeholder="Ticket no. or text — try 6115"
                          title="A bare number searches ticket numbers only (its own, its parent's, its sub-tickets' and PR numbers). Anything else is a text search."
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
                            <b style={{ color: DONE }}>{filtered.length}</b> of {items.length}
                          </span>
                        )}
                        {contextCount > 0 && (
                          <button
                            onClick={() => setShowContext((v) => !v)}
                            aria-pressed={!showContext}
                            title={
                              showContext
                                ? `${contextCount} parent ticket${contextCount === 1 ? '' : 's'} owned by others are shown for lineage (you delivered a sub-ticket under ${contextCount === 1 ? 'it' : 'them'}). Click to list only your own tickets.`
                                : `${contextCount} parent ticket${contextCount === 1 ? '' : 's'} owned by others ${contextCount === 1 ? 'is' : 'are'} hidden. Click to show ${contextCount === 1 ? 'it' : 'them'} for lineage.`
                            }
                            className="inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-[11.5px] font-semibold card-shadow transition-colors"
                            style={
                              showContext
                                ? { borderColor: 'var(--line)', background: 'var(--surface-solid)', color: 'var(--ink-soft)' }
                                : { borderColor: hexToRgba(CONTEXT, 0.5), background: hexToRgba(CONTEXT, 0.08), color: CONTEXT }
                            }
                          >
                            <PersonIcon size={13} />
                            {showContext ? 'Mine only' : 'Show context'}
                            <span className="tabular-nums opacity-70">{contextCount}</span>
                          </button>
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
                      <FilterChip active={proj === null && typ === null && prFilter === null} color={DONE} onClick={() => { setProj(null); setTyp(null); setPrFilter(null) }} title="Clear every filter">
                        All
                      </FilterChip>
                      <FilterChip active={prFilter === 'any'} color={PR_PURPLE} onClick={() => setPrFilter(prFilter === 'any' ? null : 'any')} n={items.filter((it) => matchesPrFilter(it, 'any')).length} title="Tickets with a merged or declined pull request">
                        With a PR
                      </FilterChip>
                      <FilterChip active={prFilter === 'merged'} color={DONE} onClick={() => setPrFilter(prFilter === 'merged' ? null : 'merged')} n={items.filter((it) => matchesPrFilter(it, 'merged')).length} title="Tickets with a merged pull request">
                        Merged
                      </FilterChip>
                      <FilterChip active={prFilter === 'declined'} color="#ef4444" onClick={() => setPrFilter(prFilter === 'declined' ? null : 'declined')} n={items.filter((it) => matchesPrFilter(it, 'declined')).length} title="Tickets with a declined pull request">
                        Declined
                      </FilterChip>
                      <span className="mx-1 h-5 w-px shrink-0 bg-[var(--line-strong)]" aria-hidden />
                      {projects.map(([p, n]) => (
                        <FilterChip key={p} active={proj === p} color={DONE} onClick={() => setProj(proj === p ? null : p)} n={n} title={`Only ${p} tickets`}>
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

                  {/* Labels the fixed rail so the columns read as columns, not as scattered chips. */}
                  {filtered.length > 0 && <RailHeader />}

                  {/* chronological timeline: year → month → rows */}
                  <div className="flex flex-col gap-7">
                    {groups.map(([year, months]) => {
                      const count = months.reduce((s, m) => s + m.rows.length, 0)
                      return (
                        <div key={year}>
                          <div className="mb-3 flex items-center gap-3 px-1">
                            <span className="text-[19px] font-black tracking-tight text-[var(--ink)]">{year}</span>
                            <span className="rounded-full px-2.5 py-[3px] text-[11px] font-extrabold tabular-nums" style={{ color: DONE, background: hexToRgba(DONE, 0.14) }}>
                              {count}
                            </span>
                            <span className="h-px flex-1" style={{ background: `linear-gradient(90deg, ${hexToRgba(DONE, 0.35)}, transparent)` }} />
                          </div>
                          <div className="flex flex-col gap-5">
                            {months.map((m, mi) => (
                              <div key={`${m.label}-${mi}`}>
                                {m.label && (
                                  <div className="mb-2 flex items-center gap-2 px-1">
                                    <span className="h-3 w-1 rounded-full" style={{ background: hexToRgba(DONE, 0.5) }} aria-hidden />
                                    <span className="text-[11px] font-extrabold uppercase tracking-[0.1em] text-[var(--ink-soft)]">{m.label}</span>
                                    <span className="text-[11px] font-semibold tabular-nums text-[var(--muted)]">{m.rows.length}</span>
                                  </div>
                                )}
                                <div className="flex flex-col gap-2">
                                  {m.rows.map((it) => (
                                    <CompletedRow key={it.key} it={it} expanded={expanded.has(it.key)} onToggle={() => toggleRow(it.key)} onOpen={() => onOpen(it.key)} onOpenKey={onOpen} />
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
                        <p className="text-[13px] font-semibold text-[var(--ink)]">No completed tickets match{q ? ` “${q}”` : ''}.</p>
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

/** Column labels for the rail. Mirrors CompletedRow's trailing cells exactly. */
function RailHeader() {
  return (
    <div className="mb-2 hidden items-center border border-transparent px-3 text-[9.5px] font-bold uppercase tracking-[0.09em] text-[var(--muted)] sm:flex" style={{ borderLeftWidth: 3 }} aria-hidden>
      <span className="flex-1" />
      {/* "Comments" cannot fit this column; the icon is the same one the rows use. */}
      <span className="flex justify-end pr-0.5" style={{ width: RAIL.comments }} title="Comments">
        <CommentIcon size={11} />
      </span>
      <span className="text-center" style={{ width: RAIL.env }}>Env</span>
      <span className="text-center" style={{ width: RAIL.pr }}>PR</span>
      <span className="text-right" style={{ width: RAIL.date }}>Closed</span>
    </div>
  )
}

function CompletedRow({ it, expanded, onToggle, onOpen, onOpenKey }: { it: CompletedTicket; expanded: boolean; onToggle: () => void; onOpen: () => void; onOpenKey: (key: string) => void }) {
  const status = it.status || 'Done'
  const branches = branchesOf(it)
  const prs = prListOf(it)
  const et = effectiveType(it)
  const tm = typeMeta(et)
  const env = et === 'Release' ? releaseEnvOf(it) : null
  const anyMerged = prs.some(isMergedPr)
  const subs = it.subtasks ?? []
  const mine = isMine(it)
  const comments = it.commentCount ?? 0
  const rel = relTime(it.resolved)
  const ct = cycleTime(it)

  return (
    <div
      className="group/row overflow-hidden rounded-xl border border-[var(--line)] transition-all hover:-translate-y-px hover:border-[var(--line-strong)] hover:shadow-[0_10px_24px_-16px_rgba(16,24,40,0.5)]"
      style={{
        borderLeftWidth: 3,
        borderLeftColor: tm.color,
        // A context parent (owned by someone else) gets a faint tint rather than reduced
        // opacity — still fully legible, but instantly distinguishable from my own tickets.
        background: mine ? 'var(--surface-solid)' : hexToRgba(CONTEXT, 0.05),
      }}
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
          {/* Fixed-width key + points columns so every title starts at the same x. */}
          <span className="w-[104px] shrink-0 whitespace-nowrap font-mono text-[12.5px] font-extrabold" style={{ color: 'var(--link)' }}>
            {it.key}
          </span>
          <span className="flex w-[50px] shrink-0 justify-start">
            <PointsTag points={it.storyPoints} />
          </span>
          <span className="min-w-0 flex-1 truncate text-[14.5px] font-semibold text-[var(--ink)] group-hover:underline">{it.title}</span>

          {/* Lineage / ownership chips travel WITH the title — they describe what the ticket
              is, not how it landed, and keeping them out of the rail is what lets the rail align. */}
          {it.parentKey && (
            <span
              className="hidden shrink-0 items-center gap-0.5 rounded-md border px-1.5 py-[2px] font-mono text-[10px] font-bold lg:inline-flex"
              style={{ borderColor: hexToRgba(SUB, 0.35), color: SUB, background: hexToRgba(SUB, 0.09) }}
              title={`Sub-ticket of ${it.parentKey}${it.parentTitle ? ` — ${it.parentTitle}` : ''}`}
            >
              ↳ {it.parentKey}
            </span>
          )}
          {subs.length > 0 && (
            <span
              className="hidden shrink-0 rounded-md border px-1.5 py-[2px] text-[10px] font-bold lg:inline"
              style={{ borderColor: hexToRgba(SUB, 0.35), color: SUB, background: hexToRgba(SUB, 0.09) }}
              title={`${subs.length} sub-ticket${subs.length === 1 ? '' : 's'} — expand to see owners and reviews`}
            >
              {subs.length} sub
            </span>
          )}
          {!mine && (
            <span
              className="hidden shrink-0 items-center gap-1 rounded-md border px-1.5 py-[2px] text-[10px] font-bold lg:inline-flex"
              style={{ borderColor: hexToRgba(CONTEXT, 0.4), color: CONTEXT, background: hexToRgba(CONTEXT, 0.1) }}
              title={`Parent ticket${it.assignee ? ` owned by ${it.assignee}` : ''} — shown because you delivered a sub-ticket under it`}
            >
              <PersonIcon size={9} color={CONTEXT} />
              context
            </span>
          )}
        </button>

        {/* Right rail — right-to-left: Closed date, PR, environment, comments. */}
        <span className="hidden shrink-0 items-center sm:flex">
          <span className="flex items-center justify-end gap-1 text-[11.5px] font-semibold text-[var(--muted)]" style={{ width: RAIL.comments }} title={comments ? `${comments} comment${comments === 1 ? '' : 's'}` : undefined}>
            {comments > 0 && (
              <>
                <CommentIcon size={11} />
                {comments}
              </>
            )}
          </span>
          <span className="flex justify-center" style={{ width: RAIL.env }}>
            {env && (
              <span className="rounded-full border px-2 py-[2px] text-[10px] font-extrabold uppercase tracking-wide" style={{ borderColor: hexToRgba(env.color, 0.5), color: env.color, background: hexToRgba(env.color, 0.12) }}>
                {env.label}
              </span>
            )}
          </span>
          <span className="flex items-center justify-center gap-0.5" style={{ width: RAIL.pr }} title={prs.length ? `${prs.length} pull request${prs.length === 1 ? '' : 's'}${anyMerged ? ' — merged' : ' — none merged'}` : undefined}>
            {prs.length > 0 && (
              <>
                <PrStateIcon state={anyMerged ? 'merged' : undefined} color={anyMerged ? PR_PURPLE : '#dc2626'} size={14} />
                {prs.length > 1 && <b className="text-[10px] tabular-nums" style={{ color: anyMerged ? PR_PURPLE : '#dc2626' }}>{prs.length}</b>}
              </>
            )}
          </span>
          <span className="flex flex-col items-end leading-tight" style={{ width: RAIL.date }}>
            <span className="text-[12px] font-bold tabular-nums text-[var(--ink-soft)]">{fmtDate(it.resolved)}</span>
            {rel && <span className="text-[10px] font-medium text-[var(--muted)]">{rel}</span>}
          </span>
        </span>
      </div>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.22 }} className="overflow-hidden">
            <div className="border-t border-[var(--line)] bg-[var(--surface-2)] px-4 py-3.5">
              <div className="grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-4">
                <Field label="Opened" value={it.created ? fmtDate(it.created) : '—'} />
                <Field label="Closed" value={it.resolved ? fmtDate(it.resolved) : '—'} />
                {/* Lead time is the wall clock; dev time is only the part spent In Progress or In
                    Review. The gap between the two is usually the interesting number. */}
                <Field
                  label="Lead time"
                  value={ct.measurable ? fmtDays(ct.totalDays) : '—'}
                  hint={ct.measurable ? `${fmtDays(ct.totalDays)} from opened to closed` : undefined}
                />
                <Field
                  label="Dev time"
                  value={ct.measurable ? fmtDays(ct.devDays) : '—'}
                  dot={ct.measurable && ct.devDays > 0 ? '#8b5cf6' : undefined}
                  hint={
                    ct.measurable
                      ? `${fmtDays(ct.progressDays)} in progress · ${fmtDays(ct.reviewDays)} in review — ${fmtDays(ct.devDays)} of the ${fmtDays(ct.totalDays)} lead time`
                      : undefined
                  }
                />
                <Field label="Current status" value={status} dot={DONE} />
                <Field label="Type" value={et && et !== it.type ? `${et} · ${it.type}` : it.type || '—'} />
                <Field label="Priority" value={priorityMeta(it.priority).label} dot={priorityMeta(it.priority).color} />
                <Field label="Story points" value={typeof it.storyPoints === 'number' ? `${it.storyPoints}` : '—'} />
                {it.parentKey ? (
                  <Field label="Sub-ticket of" value={`${it.parentKey}${it.parentTitle ? ` — ${it.parentTitle}` : ''}`} />
                ) : (
                  <Field label="Sub-tickets" value={`${it.subtaskCount ?? subs.length}`} />
                )}
                <Field label="Delivered by" value={it.assignee ?? '—'} />
              </div>

              <div className="mt-3.5 flex flex-col gap-2.5">
                <div className={prs.length > 0 ? 'grid grid-cols-1 items-start gap-2.5 md:grid-cols-2' : ''}>
                  <Section label={branches.length > 1 ? `Branches (${branches.length})` : 'Branch'} icon={<BranchIcon size={12} color="var(--muted)" />}>
                    {branches.length ? (
                      <div className="flex flex-col gap-1.5">
                        {branches.map((b, i) => (
                          <span key={i} className="inline-flex flex-wrap items-center gap-2">
                            <code className="break-all font-mono text-[11.5px] text-[var(--ink-soft)]">{b}</code>
                            <BranchStatusPill state={branchStatusOf(b, it)} />
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-[12px] text-[var(--muted)]">No branch recorded in Jira.</span>
                    )}
                  </Section>

                  {prs.length > 0 && (
                    <Section label={prs.length > 1 ? `Pull requests (${prs.length})` : 'Pull request'} icon={<PrStateIcon state="merged" color="var(--muted)" size={12} />}>
                      <div className="flex flex-col gap-1.5">
                        {prs.map((p, i) => (
                          <span key={i} className="inline-flex flex-wrap items-center gap-2">
                            {p.state && p.state !== 'none' ? <PrBadge state={p.state} /> : <Pill color={PR_PURPLE}>⬡ PR</Pill>}
                            {p.merged && p.state !== 'merged' && <Pill color={PR_PURPLE}>merged</Pill>}
                            {/* One ticket's PRs can live in different repos, so the number alone is ambiguous. */}
                            {p.repo && <code className="rounded bg-[var(--surface-solid)] px-1.5 py-[1px] font-mono text-[10.5px] text-[var(--ink-soft)]">{p.repo}</code>}
                            {typeof p.approvals === 'number' && <span className="text-[11px] text-[var(--muted)]">{p.approvals} approval{p.approvals === 1 ? '' : 's'}</span>}
                            {safeHref(p.url) && (
                              <a href={safeHref(p.url)} target="_blank" rel="noopener noreferrer" className="text-[11px] font-bold hover:underline" style={{ color: 'var(--pr-link)' }}>
                                {p.id ? `#${p.id}` : 'view'} ↗
                              </a>
                            )}
                          </span>
                        ))}
                      </div>
                    </Section>
                  )}
                </div>

                {/* The whole point of the master-ticket view: who did which piece, and how it was reviewed. */}
                {subs.length > 0 && (
                  <Section label={`Sub-tickets (${subs.length})`} icon={<TypeIcon type="Sub-task" color="var(--muted)" size={12} />}>
                    <div className="flex flex-col gap-1.5">
                      {subs.map((s) => (
                        <SubRow key={s.key} s={s} onOpen={() => onOpenKey(s.key)} />
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

/** One child of a master ticket: owner, status, and the review that delivered it. */
function SubRow({ s, onOpen }: { s: Ticket; onOpen: () => void }) {
  const prs = prListOf(s)
  const branches = branchesOf(s)
  const owner = s.assignee?.split(',')[0]
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--line)] bg-[var(--surface-solid)] px-2.5 py-1.5 transition-colors hover:border-[var(--line-strong)]">
      <button onClick={onOpen} className="shrink-0 font-mono text-[11.5px] font-extrabold hover:underline" style={{ color: 'var(--link)' }}>
        {s.key}
      </button>
      <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--ink-soft)]" title={s.title ?? ''}>
        {s.title}
      </span>
      {owner && (
        <span className="inline-flex shrink-0 items-center gap-1 text-[10.5px] font-medium text-[var(--muted)]">
          <PersonIcon size={9} />
          {owner}
        </span>
      )}
      <span className="shrink-0 text-[10.5px] font-bold" style={{ color: s.done ? DONE : 'var(--muted)' }}>
        {s.status}
      </span>
      {prs.map((p, i) => (
        <span key={i} className="inline-flex shrink-0 items-center gap-1">
          <PrBadge state={p.state ?? 'none'} />
          {safeHref(p.url) && (
            <a href={safeHref(p.url)} target="_blank" rel="noopener noreferrer" className="text-[10.5px] font-bold hover:underline" style={{ color: 'var(--pr-link)' }} title={[p.repo, p.title].filter(Boolean).join(' — ')}>
              #{p.id}
            </a>
          )}
        </span>
      ))}
      {!prs.length && branches.length > 0 && (
        <code className="shrink-0 font-mono text-[10.5px] text-[var(--muted)]" title={branches.join('\n')}>
          {shortBranch(branches[0], 22)}
        </code>
      )}
    </div>
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
