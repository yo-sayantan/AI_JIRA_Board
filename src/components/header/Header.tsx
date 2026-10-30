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
import { lift, tint } from '../../lib/tone'

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
 * A fixed-width button that doubles as its own progress bar. Idle: solid blue with a label.
 * Busy: the same blue fills left→right (the unfilled part is dimmed/faded),
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
  idleIcon: ReactNode
}) {
  const pctNum = busy ? Math.max(0, Math.min(100, displayPct(progress))) : 0
  const pct = Math.round(pctNum)
  const label = busy ? (hasCount(progress) ? `${progress!.done}/${progress!.total} · ${pct}%` : `${pct}%`) : idleLabel

  return (
    <>
      <motion.button
        type="button"
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
        className="jb-primary-action relative inline-flex h-9 w-[148px] shrink-0 items-center justify-center gap-1.5 overflow-hidden rounded-lg px-3 text-[13px] font-semibold"
        style={{ opacity: disabled && !busy ? 0.6 : 1 }}
      >
        {/* Dimming scrim over the UNFILLED (right) portion — recedes as pct grows, so the deep
            bright colour "fills in" from the left. */}
        {busy && (
          <motion.span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 right-0 z-0"
            initial={false}
            animate={{ left: `${pct}%` }}
            transition={{ type: 'spring', stiffness: 120, damping: 22, mass: 0.6 }}
            style={{ background: 'rgba(0,0,0,0.34)' }}
          />
        )}
        <span className="relative z-10 inline-flex items-center gap-1.5">
          <motion.span
            className="inline-flex"
            animate={busy ? { rotate: 360 } : { rotate: 0 }}
            transition={busy ? { repeat: Infinity, duration: 0.8, ease: 'linear' } : { type: 'spring', stiffness: 300, damping: 20 }}
          >
            {busy ? <RefreshIcon size={15} color="currentColor" /> : idleIcon}
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
    <header className="jb-board-header sticky top-0 z-30 mb-3 border-b border-[var(--line)] bg-[var(--surface-solid)] px-1 py-3 md:px-2">
      <div className="jb-header-layout flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex min-w-0 items-center gap-2">
          <TicketGlyph size={18} />
          <div className="min-w-0 leading-tight">
            <h1 className="truncate text-[16px] font-bold tracking-tight text-[var(--ink)]">My Jira Board</h1>
            <span className="block truncate text-[11.5px] text-[var(--muted)]">{name}</span>
          </div>
        </div>

        <span
          className="jb-header-freshness inline-flex items-center gap-1.5 rounded-full border border-[var(--line)] bg-transparent px-2 py-[2px] text-[11.5px] text-[var(--muted)]"
          title={
            data.generatedAt
              ? `The board reflects JIRA as of ${fr.full} (the last intern run). It is ${fr.label} relative to now.`
              : 'The intern has not produced a dump yet.'
          }
        >
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: fr.color }} />
          {data.generatedAt ? (
            <>
              <span className="text-[var(--ink-soft)]">last run {fr.full}</span>
              <b style={{ color: lift(fr.color) }}>· {fr.label}</b>
            </>
          ) : (
            <b style={{ color: lift(fr.color) }}>no intern run yet</b>
          )}
        </span>

        <div className="jb-header-controls ml-auto flex min-w-0 flex-1 items-center justify-end gap-2">
          {/* Current sprint — compact two-line block: name + workdays left, dates + progress. */}
          {sprint && sp && (
            <div
              className="hidden shrink-0 flex-col gap-0.5 rounded-lg border border-[var(--line)] bg-transparent px-2.5 py-1 leading-tight md:flex"
              title={
                (sprint.start && sprint.end
                  ? `Sprint ${sprint.name}: ${fmtDate(sprint.start)} → ${fmtDate(sprint.end)}`
                  : `Sprint ${sprint.name}`) + ` — ${sp.label} (working days, Mon–Fri)`
              }
            >
              <span className="flex items-center gap-1.5 text-[10.5px] font-bold text-[var(--ink-soft)]">
                <CalendarIcon size={10} color={lift(sp.color)} />
                {/* The pill sizes to the NAME — sprint names vary in length ("Team Sprint 13.2"
                    alone needs ~118px, so the old 110px cap clipped every one of them). 280px is a
                    backstop against a pathological name squeezing the search box, not a budget. */}
                <span className="max-w-[280px] shrink-0 truncate whitespace-nowrap">{sprint.name}</span>
                <b className="ml-auto shrink-0 whitespace-nowrap pl-1" style={{ color: lift(sp.color) }}>
                  {sp.label}
                </b>
              </span>
              <span className="flex items-center gap-1.5 text-[10px] text-[var(--muted)]">
                {sprint.start && sprint.end ? (
                  <span className="whitespace-nowrap tabular-nums">{fmtDateShort(sprint.start)} → {fmtDateShort(sprint.end)}</span>
                ) : (
                  <span>{sprint.state || 'sprint'}</span>
                )}
                {sp.pct != null && (
                  <span className="relative h-1 min-w-8 flex-1 overflow-hidden rounded-full" style={{ background: tint(sp.color, 0.18) }}>
                    <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.round(sp.pct * 100)}%`, background: sp.color }} />
                  </span>
                )}
              </span>
            </div>
          )}

          <div className="jb-search min-w-[12rem] flex-1 md:max-w-[24rem]">
            <label htmlFor="jb-search" className="sr-only">Search tickets</label>
            <div className="flex h-9 items-center gap-2 rounded-lg border border-[var(--line)] bg-[var(--surface-solid)] px-3">
              <SearchIcon size={14} />
              <input
                id="jb-search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                type="search"
                placeholder={shortcuts ? 'Search tickets  /' : 'Search tickets'}
                className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--ink)] outline-none placeholder:text-[var(--muted)]"
              />
              {query && (
                <button type="button" onClick={() => setQuery('')} aria-label="Clear search" className="text-[var(--muted)] hover:text-[var(--ink)]">
                  <span aria-hidden>×</span>
                </button>
              )}
            </div>
          </div>

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
            <button
              type="button"
              onClick={onOpenKeys}
              aria-label={keysBadge ? `API keys — ${keysBadge.label}` : keysMissing ? 'API keys — a required key is missing' : 'API keys'}
              title={
                keysBadge
                  ? `API keys — ${keysBadge.label}`
                  : keysMissing
                    ? 'API keys — add your Jira token so the board can fetch'
                    : 'API keys — Jira, Bitbucket, Cloud AI…'
              }
              className="jb-icon-action relative"
            >
              <KeyIcon size={16} />
              {(keysBadge || keysMissing) && (
                <span
                  aria-hidden
                  className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-[var(--bg)]"
                  style={{ background: keysBadge?.color ?? '#f59e0b' }}
                />
              )}
            </button>
          )}

          {onOpenSettings && (
            <button
              type="button"
              onClick={onOpenSettings}
              aria-label="Board settings"
              title="Settings — appearance, features, AI usage"
              className="jb-icon-action"
            >
              <GearIcon size={16} />
            </button>
          )}

          {/* Help — opens the Setup & Deployment guide. An <a>, not a fetch/route, so it still works
              when the server is down (file:// falls back to the sibling help/ folder). */}
          <a
            href={guideUrl()}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Setup and deployment guide"
            title="Setup & deployment guide — requirements, install steps for Windows/macOS/Linux, git & Docker commands, troubleshooting"
            className="jb-icon-action"
          >
            <QuestionIcon size={16} />
          </a>

          <button
            type="button"
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
            className="jb-icon-action"
          >
            {dark ? <MoonIcon size={16} /> : <SunIcon size={16} />}
          </button>
        </div>
      </div>
    </header>
  )
})
