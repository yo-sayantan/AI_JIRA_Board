import { memo, type ReactNode } from 'react'
import { motion } from 'motion/react'
import type { JiraData } from '../../types'
import { currentSprint, fmtDate, fmtDateShort, freshness, sprintStatus } from '../../lib/format'
import { CalendarIcon, GearIcon, KeyIcon, QuestionIcon, RefreshIcon, SearchIcon, SunIcon, MoonIcon, TicketGlyph } from '../common/Icons'
import { guideUrl, type ArchiveScope } from '../../lib/runner'
import { ReportsMenu, type ReportsMenuProps } from './ReportsMenu'
import { ArchiveMenu } from './ArchiveMenu'
import { flushSync } from 'react-dom'
import { switchTheme } from '../../lib/themeTransition'
import { lift } from '../../lib/tone'
import { FILL, PRESS } from '../../lib/motion'

export type RunProgress = {
  done: number
  total: number
  pct: number
  current?: string | null
  phase?: string
}

/** Overall completion 0–100. Prefer the worker's measured, weighted progress. */
function displayPct(p: RunProgress | null | undefined): number {
  if (!p) return 0
  if (Number.isFinite(p.pct)) return p.pct
  return p.total > 0 ? (100 * p.done) / p.total : 0
}

/** True once we have a real ticket count to show as x/y. */
function hasCount(p: RunProgress | null | undefined): boolean {
  return !!(p && p.total > 0 && (p.phase === 'building' || p.phase === 'assembling'))
}

/**
 * A fixed-width button that doubles as its own progress bar. Idle: solid bright gradient with
 * a label. Busy: the same bright colour fills left→right (the unfilled part is dimmed/faded),
 * and the label is just `x/y · z%` — no word, so the width never has to change.
 */
function ProgressButton({
  busy,
  progress,
  onClick,
  disabled,
  ariaLabel,
  title,
  idleLabel,
  idleIcon,
}: {
  busy: boolean
  progress: RunProgress | null | undefined
  onClick: () => void
  disabled: boolean
  ariaLabel: string
  title: string
  idleLabel: string
  /** Kept for callers; the Wayfind primary button is solid cobalt, so these no longer paint. */
  gradient?: string
  shadow?: string
  idleIcon: ReactNode
}) {
  const pctNum = busy ? Math.max(0, Math.min(100, displayPct(progress))) : 0
  const pct = Math.round(pctNum)
  const label = busy ? (hasCount(progress) ? `${progress!.done}/${progress!.total} · ${pct}%` : `${pct}%`) : idleLabel

  return (
    <>
    <motion.button
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-busy={busy || undefined}
      title={
        busy && progress?.current
          ? `${title}\nNow: ${progress.current}${progress.total ? ` (${progress.done}/${progress.total})` : ''}`
          : title
      }
      // Fixed width so the label swapping (idle text ↔ x/y · %) never resizes the button.
      className="wf-btn relative w-[188px] shrink-0 overflow-hidden whitespace-nowrap px-3 text-[13px]"
      style={{ opacity: disabled && !busy ? 0.6 : 1 }}
    >
      {/* Dimming scrim over the UNFILLED (right) portion — recedes as pct grows, so the deep bright colour "fills
          in" from the left. scaleX instead of animating `left`: the fill updates on every progress tick, during a fetch, and a
          width change re-lays-out the button each frame. Anchored right, so it shrinks off the filled part. */}
      {busy && (
        <motion.span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 z-0 w-full origin-right"
          initial={false}
          animate={{ transform: `scaleX(${1 - pct / 100})` }}
          transition={FILL}
          style={{ background: 'rgba(0,0,0,0.34)' }}
        />
      )}
      {/* Bright leading edge at the fill boundary for a crisp "wet paint" look. The bar rides the left edge of a
          full-width layer, so translateX's percentage is the button's width and the edge tracks the fill. */}
      {busy && (
        <motion.span
          aria-hidden
          className="pointer-events-none absolute inset-0 z-[1]"
          initial={false}
          animate={{ transform: `translateX(calc(${pct}% - 1.5px))` }}
          transition={FILL}
        >
          <span className="absolute inset-y-0 left-0 w-[3px]" style={{ background: 'rgba(255,255,255,0.85)', boxShadow: '0 0 8px rgba(255,255,255,0.6)' }} />
        </motion.span>
      )}
      {/* Shimmer while we don't yet have a ticket count (early phases). A quarter-width band: -100% to 400% of its
          own width runs it from just off the left edge to just off the right. */}
      {busy && !hasCount(progress) && (
        <motion.span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 z-[1] w-1/4"
          animate={{ transform: ['translateX(-100%)', 'translateX(400%)'] }}
          transition={{ repeat: Infinity, duration: 1.1, ease: 'linear' }}
          style={{ background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.4), transparent)' }}
        />
      )}
      <span className="relative z-10 inline-flex items-center gap-1.5" style={{ textShadow: '0 1px 2px rgba(0,0,0,0.35)' }}>
        <motion.span
          className="inline-flex"
          animate={busy ? { transform: ['rotate(0deg)', 'rotate(360deg)'] } : { transform: 'rotate(0deg)' }}
          transition={busy ? { repeat: Infinity, duration: 0.8, ease: 'linear' } : PRESS}
        >
          {busy ? <RefreshIcon size={15} color="#fff" /> : idleIcon}
        </motion.span>
        <span className="tabular-nums">{label}</span>
      </span>
    </motion.button>
    <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {busy ? label : ''}
    </span>
    </>
  )
}

export const Header = memo(function Header({
  data,
  now,
  query,
  setQuery,
  dark,
  toggleTheme,
  refreshing,
  archiveRefreshing,
  archiveParallel,
  runProgress,
  served,
  onRefresh,
  shortcuts = true,
  onArchiveRefresh,
  onStopArchive,
  reports,
  onOpenSettings,
  onOpenKeys,
  keysMissing = false,
  keysBadge = null,
}: {
  data: JiraData
  now: number
  query: string
  setQuery: (v: string) => void
  dark: boolean
  toggleTheme: () => void
  refreshing: boolean
  archiveRefreshing: boolean
  archiveParallel: number
  /** Live done/total from the running fetch — fills the active button. */
  runProgress?: RunProgress | null
  served: boolean
  onRefresh: () => void
  /** When off, / and r do nothing and their hints stay off the controls. */
  shortcuts?: boolean
  onArchiveRefresh: (target: ArchiveScope) => void
  onStopArchive: () => void
  /** Bulk PR Readiness Report controls — grouped so the header keeps one prop, not five. */
  reports?: ReportsMenuProps
  onOpenSettings?: () => void
  /** Served only — opens the API keys dialog. */
  onOpenKeys?: () => void
  /** A required key is missing: the key button carries an amber dot. */
  keysMissing?: boolean
  /** Services with saved keys whose latest real call failed: red dot (key rejected) beats orange (needs attention) beats the amber "missing" dot. */
  keysBadge?: { color: string; label: string } | null
}) {
  const fr = freshness(data.generatedAt, now)
  const name = data.user?.name?.split(',')[1]?.trim() || data.user?.name || 'you'
  // Headline sprint: the active one on the board's tickets (else the next future one).
  const sprint = currentSprint(data.tickets)
  const sp = sprint ? sprintStatus(sprint, now) : null
  const dailyProgress = refreshing ? runProgress : null
  const archiveProgress = archiveRefreshing ? runProgress : null

  return (
    <header className="wf-bar sticky top-0 z-30 -mx-2 mb-4 px-4 py-3 md:px-5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-3">
          <span className="wf-plate grid h-9 w-9 shrink-0 place-items-center">
            <TicketGlyph size={20} />
          </span>
          <div className="leading-tight">
            <h1 className="wf-wordmark text-[17px]">My Jira Board</h1>
            <p
              className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11.5px] text-[var(--muted)]"
              title={
                data.generatedAt
                  ? `The board reflects JIRA as of ${fr.full} (the last intern run). It is ${fr.label} relative to now.`
                  : 'The intern has not produced a dump yet.'
              }
            >
              <span className="text-[var(--ink)]">{name}</span>
              {data.generatedAt ? (
                <>
                  <span>Last run {fr.full}</span>
                  <b className="font-medium" style={{ color: lift(fr.color) }}>
                    ({fr.label})
                  </b>
                </>
              ) : (
                <b className="font-medium" style={{ color: lift(fr.color) }}>
                  No intern run yet
                </b>
              )}
            </p>
          </div>
        </div>

        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
          {/* Current sprint — compact two-line block: name + workdays left, dates + progress. */}
          {sprint && sp && (
            <div
              className="wf-plate hidden h-9 shrink-0 flex-col justify-center gap-0.5 px-2.5 leading-tight md:flex"
              title={
                (sprint.start && sprint.end
                  ? `Sprint ${sprint.name}: ${fmtDate(sprint.start)} → ${fmtDate(sprint.end)}`
                  : `Sprint ${sprint.name}`) + ` — ${sp.label} (working days, Mon–Fri)`
              }
            >
              <span className="flex items-center gap-2 text-[10.5px] font-medium">
                <CalendarIcon size={10} color="currentColor" />
                {/* The plate sizes to the NAME — sprint names vary in length; 280px is a backstop against a pathological
                    name squeezing the search box, not a budget. */}
                <span className="max-w-[280px] shrink-0 truncate whitespace-nowrap">{sprint.name}</span>
                <b className="wf-figure ml-auto shrink-0 whitespace-nowrap pl-1">{sp.label}</b>
              </span>
              <span className="flex items-center gap-2 text-[10px] opacity-80">
                {sprint.start && sprint.end ? (
                  <span className="whitespace-nowrap tabular-nums">{fmtDateShort(sprint.start)} to {fmtDateShort(sprint.end)}</span>
                ) : (
                  <span>{sprint.state || 'sprint'}</span>
                )}
                {sp.pct != null && (
                  <span className="wf-plate-track relative h-1 min-w-8 flex-1 overflow-hidden">
                    <span className="wf-plate-fill absolute inset-0 origin-left" style={{ transform: `scaleX(${sp.pct})` }} />
                  </span>
                )}
              </span>
            </div>
          )}

          <label htmlFor="jb-search" className="jb-search wf-field flex h-9 items-center gap-2 px-3">
            <span className="sr-only">Search tickets</span>
            <span className="text-[var(--muted)]">
              <SearchIcon size={14} />
            </span>
            <input
              id="jb-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              type="search"
              placeholder={shortcuts ? 'Search…  ( / )' : 'Search…'}
              className="w-36 bg-transparent text-[13px] text-[var(--ink)] outline-none placeholder:text-[var(--muted)] md:w-60"
            />
            {query && (
              <button type="button" onClick={() => setQuery('')} className="text-[var(--muted)] hover:text-[var(--ink)]" aria-label="Clear search">
                <span aria-hidden>✕</span>
              </button>
            )}
          </label>

          <ProgressButton
            busy={refreshing}
            progress={dailyProgress}
            onClick={onRefresh}
            disabled={refreshing || archiveRefreshing}
            ariaLabel={served ? 'Refresh the board (active tickets only)' : 'Reload latest data'}
            title={
              served
                ? `QUICK refresh — re-fetches only your ACTIVE tickets (seconds). The Completed archive is not touched.${shortcuts ? '  (r)' : ''}`
                : `Reload the latest data dump from disk${shortcuts ? '  (r)' : ''}`
            }
            idleLabel={served ? 'Refresh board' : 'Reload'}
            idleIcon={<RefreshIcon size={15} color="currentColor" />}
          />

          <div className="wf-cells" role="group" aria-label="Board tools">
          {served && (
            <ArchiveMenu
              served={served}
              busy={archiveRefreshing}
              blocked={refreshing}
              done={archiveProgress?.done ?? 0}
              total={archiveProgress?.total ?? 0}
              pct={archiveRefreshing ? Math.round(displayPct(archiveProgress)) : 0}
              parallel={archiveParallel}
              phase={archiveProgress?.phase}
              onRun={onArchiveRefresh}
              onStop={onStopArchive}
            />
          )}

          {reports && <ReportsMenu {...reports} />}

          {onOpenKeys && (
            <motion.button
              onClick={onOpenKeys}
              aria-label={keysBadge ? `API keys — ${keysBadge.label}` : keysMissing ? 'API keys — a required key is missing' : 'API keys'}
              title={
                keysBadge
                  ? `API keys — ${keysBadge.label}`
                  : keysMissing
                    ? 'API keys — add your Jira token so the board can fetch'
                    : 'API keys — Jira, Bitbucket, Cloud AI…'
              }
              className="wf-cell relative"
            >
              <KeyIcon size={16} />
              {(keysBadge || keysMissing) && (
                <span
                  aria-hidden
                  className="absolute right-0.5 top-0.5 h-2 w-2"
                  style={{ background: keysBadge?.color ?? 'var(--color-accent-2)' }}
                />
              )}
            </motion.button>
          )}

          {onOpenSettings && (
            <motion.button
              onClick={onOpenSettings}
              aria-label="Board settings"
              title="Settings — appearance, features, AI usage"
              className="wf-cell"
            >
              <GearIcon size={16} />
            </motion.button>
          )}

          {/* Help — opens the Setup & Deployment guide. An <a>, not a fetch/route, so it still works
              when the server is down (file:// falls back to the sibling help/ folder). */}
          <motion.a
            href={guideUrl()}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Setup and deployment guide"
            title="Setup & deployment guide — requirements, install steps for Windows/macOS/Linux, git & Docker commands, troubleshooting"
            className="wf-cell"
          >
            <QuestionIcon size={16} />
          </motion.a>

          <motion.button
            onClick={(e) => {
              // The reveal snapshots the page before and after `apply`, so the theme must change synchronously in it:
              // flushSync renders the new setting, and the class is set right here too (applySettings repeats it).
              const toDark = !dark
              switchTheme(e.currentTarget, toDark, () => {
                flushSync(toggleTheme)
                document.documentElement.classList.toggle('dark', toDark)
              })
            }}
            aria-label="Toggle theme"
            aria-pressed={dark}
            className="wf-cell"
          >
            {dark ? <MoonIcon size={16} /> : <SunIcon size={16} />}
          </motion.button>
          </div>
        </div>
      </div>
    </header>
  )
})
