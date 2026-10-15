import { FlaskIcon, EyeOffIcon, RefreshIcon } from '../common/Icons'
import { lift } from '../../lib/tone'

export function NoMatches({ query, onClear }: { query: string; onClear: () => void }) {
  return (
    <div className="grid min-h-[34vh] place-items-center rounded-2xl border border-dashed border-[var(--line-strong)] bg-[var(--surface-2)] text-center">
      <div>
        <div className="mb-2 text-3xl">🔍</div>
        <p className="text-[14px] font-semibold text-[var(--ink)]">No tickets match “{query}”.</p>
        <button onClick={onClear} className="mt-2 text-[12.5px] text-[#8b9cff] hover:underline">
          Clear search
        </button>
      </div>
    </div>
  )
}

/** Tickets the user moved to Completed by hand, with a one-click undo. */
export function ArchivedUndo({ keys, onUndo }: { keys: string[]; onUndo: () => void }) {
  return (
    <div className="mt-2 flex justify-end">
      <button
        onClick={onUndo}
        className="inline-flex items-center gap-1.5 rounded-full border border-[var(--line)] bg-[var(--surface-solid)] px-3 py-1 text-[11.5px] text-[var(--muted)] hover:text-[var(--ink)]"
        title={`You moved ${keys.join(', ')} to Completed — undo to bring ${keys.length === 1 ? 'it' : 'them'} back onto the board`}
      >
        <EyeOffIcon size={13} /> {keys.length} moved to Completed · Undo
      </button>
    </div>
  )
}

const DEMO = '#f59e0b'

/** Demo mode is on: say so loudly, offer a reset to the starting layout, and the way out. */
export function DemoBanner({ onExit, onReset, changes }: { onExit: () => void; onReset: () => void; changes: number }) {
  const pristine = changes === 0
  return (
    <div
      role="status"
      className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border px-3.5 py-2"
      style={{ borderColor: `${DEMO}73`, background: `${DEMO}14` }}
    >
      <span className="inline-flex items-center gap-1.5 text-[12px] font-bold" style={{ color: lift(DEMO) }}>
        <FlaskIcon size={14} color={lift(DEMO)} /> Demo mode
      </span>
      <span className="min-w-0 flex-1 text-[11.5px] text-[var(--ink-soft)]">
        These tickets are invented. Drag them anywhere — the PR and QA gates still run, but nothing is sent to Jira or the AI intern.
      </span>
      <button
        type="button"
        onClick={onReset}
        disabled={pristine}
        title={pristine ? 'Nothing to reset — the demo board is as it started' : 'Put every ticket back where the demo started'}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11.5px] font-semibold transition-colors hover:bg-[var(--surface-2)] disabled:cursor-default disabled:opacity-45 disabled:hover:bg-transparent"
        style={{ borderColor: `${DEMO}73`, color: lift(DEMO), background: pristine ? undefined : `${DEMO}12` }}
      >
        <RefreshIcon size={12} color={lift(DEMO)} />
        Reset demo{pristine ? '' : ` · ${changes} ${changes === 1 ? 'change' : 'changes'}`}
      </button>
      <button
        type="button"
        onClick={onExit}
        className="shrink-0 rounded-lg border px-2.5 py-1 text-[11.5px] font-semibold transition-colors hover:bg-[var(--surface-2)]"
        style={{ borderColor: `${DEMO}73`, color: lift(DEMO) }}
      >
        Show my real board
      </button>
    </div>
  )
}
