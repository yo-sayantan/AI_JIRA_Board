import { motion } from 'motion/react'
import { BOARD_COLUMNS, HOLD_COLUMN, PIPELINE_COLUMNS, QA_IN_PROGRESS, isQaInProgress } from '../../lib/columns'
import type { ColumnKey } from '../../types'
import { hexToRgba } from '../../lib/format'
import { ColumnIcon, PauseIcon } from '../common/Icons'

/**
 * Horizontal status pipeline: To Do → In Progress → In Review → QA → Done. Side states (Blocked,
 * On Hold) are not stages: the bars stay dark and a badge says where the ticket is parked.
 */
export function Pipeline({ current, rawStatus }: { current: ColumnKey; rawStatus?: string | null }) {
  const aside = current === 'hold' ? HOLD_COLUMN : (BOARD_COLUMNS.find((c) => c.key === current && c.aside) ?? null)
  const currentIdx = PIPELINE_COLUMNS.findIndex((c) => c.key === current)
  const qaInProgress = current === 'qa' && isQaInProgress(rawStatus)

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-stretch gap-1.5">
        {PIPELINE_COLUMNS.map((c, i) => {
          const reached = !aside && i <= currentIdx
          const isCurrent = !aside && i === currentIdx
          const accent = c.accent
          return (
            <div key={c.key} className="flex flex-1 flex-col items-center gap-1">
              <div className="relative h-1.5 w-full overflow-hidden rounded-full" style={{ background: hexToRgba(accent, 0.16) }}>
                <motion.div
                  className="absolute inset-0 rounded-full"
                  initial={{ scaleX: 0 }}
                  animate={{ scaleX: reached ? 1 : 0 }}
                  transition={{ duration: 0.5, delay: 0.05 * i, ease: 'easeOut' }}
                  style={{ background: accent, transformOrigin: 'left' }}
                />
              </div>
              <div
                className="flex items-center gap-1 text-[10px] font-semibold"
                style={{ color: reached ? accent : 'var(--muted)' }}
              >
                <ColumnIcon col={c.key} color={reached ? accent : 'var(--muted)'} size={12} />
                <span className={isCurrent ? '' : 'hidden sm:inline'}>
                  {c.label}
                  {isCurrent && qaInProgress ? ` · ${QA_IN_PROGRESS.label.replace(/^QA /, '')}` : ''}
                </span>
              </div>
            </div>
          )
        })}
      </div>
      {aside && (
        <div
          className="inline-flex items-center gap-1.5 self-start rounded-full px-2.5 py-1 text-[11px] font-semibold pulse-attention"
          style={{ color: aside.accent, background: hexToRgba(aside.accent, 0.14), ['--ring' as string]: aside.accent }}
        >
          {aside.key === 'hold' ? <PauseIcon size={12} color={aside.accent} /> : <ColumnIcon col={aside.key} color={aside.accent} size={12} />}
          {aside.label}
          {rawStatus && rawStatus.toLowerCase() !== aside.label.toLowerCase() ? ` · ${rawStatus}` : ''}
        </div>
      )}
    </div>
  )
}
