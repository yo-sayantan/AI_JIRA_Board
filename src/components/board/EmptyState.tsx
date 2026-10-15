import { motion } from 'motion/react'
import { CopyButton } from '../common/ui'
import { FlaskIcon, KeyIcon, RefreshIcon } from '../common/Icons'
import { lift, tint } from '../../lib/tone'


export function EmptyState({
  served,
  refreshing,
  onRefresh,
  runCommand,
  onOpenKeys,
  keysMissing = false,
  onTryDemo,
}: {
  served: boolean
  refreshing: boolean
  onRefresh: () => void
  runCommand: string
  /** Served only: a new install has no board yet, so the API keys entry has to live here too. */
  onOpenKeys?: () => void
  /** A required key (the Jira token) is missing — the intern cannot fetch until it is added. */
  keysMissing?: boolean
  /** Switch Demo mode on: a sample board that needs no server, keys or data (nothing is ever sent to Jira). */
  onTryDemo?: () => void
}) {
  return (
    <div className="grid min-h-[80vh] place-items-center">
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        className="max-w-md rounded-2xl border border-[var(--line)] bg-[var(--surface-solid)] p-8 text-center card-shadow"
      >
        <motion.div
          initial={{ scale: 0.6, rotate: -8 }}
          animate={{ scale: 1, rotate: 0 }}
          transition={{ type: 'spring', stiffness: 240, damping: 14 }}
          className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-2xl text-[32px]"
          style={{ background: 'linear-gradient(135deg, #6d5bd0, #3b82f6)' }}
        >
          🗂️
        </motion.div>
        <h2 className="text-[16px] font-bold text-[var(--ink)]">Nothing to show… yet</h2>
        <p className="mt-2 text-[13px] leading-relaxed text-[var(--muted)]">
          The board feeds on <code className="rounded bg-[var(--surface-2)] px-1 py-0.5 font-mono text-[11px]">jira-intern/data.js</code>. Run the
          intern to fill it up:
        </p>
        <pre className="mt-3 overflow-x-auto rounded-lg bg-[#0b1020] px-3 py-2 text-left font-mono text-[11px] text-[#cfe0ff]">{runCommand}</pre>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2.5">
          <motion.button
            whileTap={{ scale: 0.95 }}
            onClick={onRefresh}
            disabled={refreshing}
            className="inline-flex items-center gap-2 rounded-xl px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-60"
            style={{ background: 'linear-gradient(135deg, #6d5bd0, #3b82f6)' }}
          >
            <span className={`inline-flex ${refreshing ? 'animate-spin' : ''}`}>
              <RefreshIcon size={15} color="#fff" />
            </span>
            {refreshing ? 'Working…' : served ? 'Run the intern' : 'Reload'}
          </motion.button>
          {onOpenKeys && (
            <motion.button
              whileTap={{ scale: 0.95 }}
              onClick={onOpenKeys}
              className="inline-flex items-center gap-2 rounded-xl border px-4 py-2 text-[13px] font-semibold"
              style={{ color: lift('#f59e0b'), borderColor: tint('#f59e0b', 0.45), background: tint('#f59e0b', 0.07) }}
            >
              <KeyIcon size={14} color={lift('#f59e0b')} />
              {keysMissing ? 'Add API keys first' : 'API keys'}
            </motion.button>
          )}
          {onTryDemo && (
            <motion.button
              whileTap={{ scale: 0.95 }}
              onClick={onTryDemo}
              className="inline-flex items-center gap-2 rounded-xl border px-4 py-2 text-[13px] font-semibold"
              style={{ color: lift('#0d9488'), borderColor: tint('#14b8a6', 0.5), background: tint('#14b8a6', 0.09) }}
              title="Look around a sample board of invented tickets — nothing reaches Jira, and it works without the server or any keys"
            >
              <FlaskIcon size={14} color={lift('#14b8a6')} />
              Try demo mode
            </motion.button>
          )}
          {!served && <CopyButton text={runCommand} label="Copy command" />}
        </div>
        {!served && (
          <p className="mt-3 text-[11.5px] text-[var(--muted)]">
            Want a live button? Start <code className="rounded bg-[var(--surface-2)] px-1 py-0.5 font-mono">npm run serve</code> and open the board from there.
          </p>
        )}
      </motion.div>
    </div>
  )
}
