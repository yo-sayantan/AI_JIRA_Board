import { useEffect, useState } from 'react'
import { motion } from 'motion/react'
import type { ReportScope } from '../../lib/runner'
import { hexToRgba } from '../../lib/format'
import { APP_CONFIG } from '../../lib/appConfig'
import { SparkleIcon } from '../common/Icons'
import { ScopeMenu, StopButton, type MenuScope } from './ScopeMenu'

const AI = '#a855f7'
/** How long nothing may be generating before the next run counts as a new batch. */
const PEAK_RESET_MS = 4000

function formatModelPart(part: string): string {
  return part
    .trim()
    .replace(/^cursor[/:]/i, '')
    .replace(/[-_/:]+/g, ' ')
    .replace(/\b(gpt)\b/gi, 'GPT')
    .replace(/\b(\d+)b\b/gi, '$1B')
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
}

function formatModelLabel(label: string): string {
  return label.split('·').map(formatModelPart).filter(Boolean).join(' · ')
}

/** Twinkling sparkle while reports generate. The glyph stays; it does not spin like a refresh. */
function AiSpark({ busy }: { busy: boolean }) {
  return (
    <span className="relative grid place-items-center">
      <motion.span
        className="inline-flex"
        animate={busy ? { scale: [1, 1.2, 0.94, 1.12, 1], rotate: [0, -14, 12, 0] } : { scale: 1, rotate: 0 }}
        transition={busy ? { duration: 1.35, repeat: Infinity, ease: 'easeInOut' } : { duration: 0.2 }}
      >
        <SparkleIcon size={16} color={AI} />
      </motion.span>
      {busy && (
        <>
          <motion.span
            aria-hidden
            className="absolute -right-1 -top-1 h-1 w-1 rounded-full"
            style={{ background: AI }}
            animate={{ opacity: [0, 1, 0], scale: [0.3, 1.3, 0.3] }}
            transition={{ duration: 1.05, repeat: Infinity, ease: 'easeInOut' }}
          />
          <motion.span
            aria-hidden
            className="absolute -left-1 bottom-0 h-[3px] w-[3px] rounded-full"
            style={{ background: '#e9d5ff' }}
            animate={{ opacity: [0, 1, 0], scale: [0.2, 1.1, 0.2] }}
            transition={{ duration: 1.05, repeat: Infinity, ease: 'easeInOut', delay: 0.4 }}
          />
        </>
      )}
    </span>
  )
}

export interface ReportsMenuProps {
  served: boolean
  /** Keys still being worked on — base report queue ∪ terminal/cron runs ∪ the AI pass that follows each. */
  generating: ReadonlySet<string>
  /** Tickets on the board that have at least one pull request (the eligible population). */
  withPrCount: number
  /** How many of those already have a report on disk. */
  reportCount: number
  /** Dashboard cards (open + the Done column) that have a pull request. */
  board: { keys: string[]; open: number; done: number }
  onBulk: (target: ReportScope, force: boolean) => void
  onOne: (key: string) => void
  onStop: () => void
  /** Report jobs actively executing, excluding queued work. */
  runningCount?: number
  /** Saved cloud model actually running, e.g. "grok-4.5 · medium". */
  modelLabel?: string | null
}

/** Batch entry point for PR Readiness Reports: every ticket with a pull request, the dashboard's tickets, a time window, or one ticket. */
export function ReportsMenu({ served, generating, withPrCount, reportCount, board, onBulk, onOne, onStop, runningCount = 0, modelLabel }: ReportsMenuProps) {
  const [force, setForce] = useState(false)
  const [peak, setPeak] = useState(0)
  const busy = generating.size
  // The queue arrives all at once, then shrinks as each report finishes. Peak is the batch size. It resets only
  // after a few quiet seconds: a key hands over from the base queue to the AI queue between two status polls, and
  // a bar that zeroed (and re-peaked smaller) in that gap jumped to "done" mid-run.
  useEffect(() => {
    if (busy > 0) {
      setPeak((n) => Math.max(n, busy))
      return
    }
    const t = setTimeout(() => setPeak(0), PEAK_RESET_MS)
    return () => clearTimeout(t)
  }, [busy])
  const done = peak > 0 ? Math.max(0, peak - busy) : 0
  const pct = peak > 0 ? Math.round((done / peak) * 100) : 0
  const model = modelLabel ? formatModelLabel(modelLabel) : ''
  const busyLine = `${done}/${peak} done · ${Math.min(runningCount, busy)} running${model ? ` · ${model}` : ''}`

  const pick = (target: MenuScope) => (target.scope === 'key' ? onOne(target.key) : onBulk(target, force))

  return (
    <ScopeMenu
      color={AI}
      trigger={(open, toggle) => (
        <motion.button
          whileHover={{ scale: 1.08 }}
          whileTap={{ scale: 0.9 }}
          transition={{ type: 'spring', stiffness: 400, damping: 18 }}
          onClick={toggle}
          aria-label={busy ? `Generating ${busy} PR readiness report${busy === 1 ? '' : 's'} — open report options` : 'Generate PR readiness reports'}
          aria-expanded={open}
          title={
            busy
              ? `${busy} PR readiness report${busy === 1 ? '' : 's'} generating in the background — click for options`
              : "Generate PR Readiness Reports — all tickets with a pull request, the dashboard's tickets, a time window, or one ticket"
          }
          className="grid h-9 w-9 place-items-center rounded-xl border bg-[var(--surface-solid)] card-shadow hover:border-[var(--muted)]"
          style={{ borderColor: busy ? hexToRgba(AI, 0.5) : 'var(--line)' }}
        >
          <AiSpark busy={busy > 0} />
        </motion.button>
      )}
      title={busy ? 'Generating PR readiness reports...' : 'Generate PR Readiness Reports'}
      subtitle={busy ? busyLine : `${reportCount} of ${withPrCount} tickets with a pull request have a report.`}
      progress={{ busy: busy > 0, fill: busy > 0 ? Math.max(8, pct) : 0, shimmer: pct === 0, label: busyLine }}
      served={served}
      offline={{ what: 'Generation', command: 'bash jira-intern/local-runner/pr-reports-backfill.sh --all-years' }}
      options={{
        allLabel: 'All tickets with a PR',
        allHint: `${withPrCount} tickets · merged and open`,
        yearHint: 'tickets created or updated this year',
        sinceHint: (date) => `since ${date}`,
        windows: APP_CONFIG.reports?.presetWindowDays?.length ? APP_CONFIG.reports.presetWindowDays : [30, 90],
        defaultWindowDays: APP_CONFIG.reports?.defaultWindowDays ?? 30,
        sinceAria: 'Generate reports for tickets since this date, YYYY-MM-DD',
        keyAria: 'Ticket key to generate a report for',
        extra: [
          {
            label: 'Tickets on the dashboard',
            hint: board.keys.length
              ? `${board.keys.length} with a PR · ${board.open} open · ${board.done} completed`
              : 'No ticket on the dashboard has a pull request',
            disabled: board.keys.length === 0,
            onClick: () => onBulk({ scope: 'keys', keys: board.keys }, force),
          },
        ],
      }}
      onPick={pick}
      footer={
        <>
          <label className="mt-1.5 flex cursor-pointer items-start gap-2 rounded-lg border-t border-[var(--line)] px-1.5 pt-2.5 text-[11px] text-[var(--ink-soft)]">
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} className="mt-[2px]" />
            <span>
              <span className="font-semibold">Force rebuild</span>
              <span className="text-[var(--muted)]"> — also redo reports that are still current. Off: only missing or out-of-date ones.</span>
            </span>
          </label>
          {busy > 0 && <StopButton color={AI} label="Stop reports" onClick={onStop} />}
        </>
      }
    />
  )
}