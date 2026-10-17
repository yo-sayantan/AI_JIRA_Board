import { motion } from 'motion/react'
import type { ArchiveScope } from '../../lib/runner'
import { APP_CONFIG } from '../../lib/appConfig'
import { TrophyIcon } from '../common/Icons'
import { ScopeMenu, StopButton } from './ScopeMenu'
import { PRESSABLE } from '../../lib/motion'

const GREEN = '#16a34a'

const PHASE_LABEL: Record<string, string> = {
  starting: 'Starting',
  searching: 'Finding all assigned tickets',
  parents: 'Fetching parent context',
  devinfo: 'Refreshing branches and PRs',
  building: 'Refreshing ticket details',
  assembling: 'Assembling archive',
  writing: 'Saving archive',
  done: 'Complete',
}

/** Parallel workers only apply during devinfo and building; other phases are serial. */
function archiveRunningCount(total: number, done: number, phase: string | undefined, parallel: number): number {
  const remaining = Math.max(0, total - done)
  if (total <= 0 || remaining <= 0) return 0
  if (phase === 'devinfo' || phase === 'building') return Math.min(Math.max(1, parallel), remaining)
  return 1
}

function archiveBusyLine(done: number, total: number, phase: string | undefined, parallel: number): string {
  const phaseText = PHASE_LABEL[phase || '']
  if (total <= 0) return `${phaseText || 'Starting the scan'}…`
  const running = archiveRunningCount(total, done, phase, parallel)
  if (running) return `${done}/${total} done · ${running} running · ${phaseText || 'Working'}`
  return `${done}/${total} done · ${phaseText || 'Working'}`
}

export interface ArchiveMenuProps {
  served: boolean
  busy: boolean
  /** Another intern job (the quick refresh) owns data.json, so a rebuild cannot start. */
  blocked: boolean
  done: number
  total: number
  pct: number
  parallel: number
  phase?: string
  onRun: (target: ArchiveScope) => void
  onStop: () => void
}

/** Small green archive button. The scope menu and the progress fill live in the window under it. */
export function ArchiveMenu({ served, busy, blocked, done, total, pct, parallel, phase, onRun, onStop }: ArchiveMenuProps) {
  const fill = busy ? Math.max(0, Math.min(100, pct)) : 0
  return (
    <ScopeMenu
      color={GREEN}
      trigger={(open, toggle) => (
        <motion.button
          {...PRESSABLE}
          onClick={toggle}
          aria-label={busy ? 'Archive rebuild in progress — open options' : 'Rebuild the Completed archive'}
          aria-expanded={open}
          title={busy ? 'Rebuilding the Completed archive. Open for progress.' : 'Rebuild the Completed archive — all closed tickets, a date range, or one ticket'}
          className={`relative grid h-9 w-9 place-items-center overflow-hidden rounded-xl text-white card-shadow${busy ? ' jb-archive-busy' : ''}`}
          style={{ background: 'linear-gradient(135deg, #10d29a, #16a34a)', boxShadow: '0 6px 16px -8px rgba(16,185,129,0.75)' }}
        >
          {busy && (
            <motion.span
              aria-hidden
              className="pointer-events-none absolute inset-[3px] rounded-lg"
              animate={{ opacity: [0.25, 0.9, 0.25] }}
              transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
              style={{ boxShadow: 'inset 0 0 0 1.5px rgba(255,253,242,0.85)' }}
            />
          )}
          <motion.span
            className="relative inline-flex"
            animate={busy ? { y: [0, -1.5, 0] } : { y: 0 }}
            transition={busy ? { duration: 1.2, repeat: Infinity, ease: 'easeInOut' } : { duration: 0.2 }}
          >
            <TrophyIcon size={13} glint={busy} />
          </motion.span>
        </motion.button>
      )}
      title={busy ? 'Rebuilding complete archive...' : 'Rebuild Completed archive'}
      subtitle={busy ? archiveBusyLine(done, total, phase, parallel) : 'Closed tickets you owned. A range or one ticket updates only those rows.'}
      progress={{ busy, fill, shimmer: !total, label: `Archive rebuild ${done} of ${total || '…'}` }}
      served={served}
      offline={{ what: 'Rebuild', command: 'bash jira-intern/local-runner/update-completed.sh' }}
      options={{
        allLabel: 'All completed tickets',
        allHint: 'clear cached details and refetch your full history',
        yearHint: 'resolved this year',
        sinceHint: (date) => `resolved since ${date}`,
        windows: APP_CONFIG.archive?.presetWindowDays?.length ? APP_CONFIG.archive.presetWindowDays : [30, 90],
        defaultWindowDays: APP_CONFIG.archive?.defaultWindowDays ?? 30,
        sinceAria: 'Rebuild tickets resolved since this date, YYYY-MM-DD',
        keyAria: 'Ticket key to rebuild in the archive',
      }}
      disabled={busy || blocked}
      onPick={onRun}
      footer={
        <>
          {blocked && !busy && <p className="px-1.5 pt-1 text-[10.5px] text-[var(--muted)]">Wait for the board refresh to finish.</p>}
          {busy && <StopButton color={GREEN} label="Stop rebuild" onClick={onStop} />}
        </>
      }
    />
  )
}
