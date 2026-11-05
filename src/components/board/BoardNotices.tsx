import { FlaskIcon, EyeOffIcon, RefreshIcon, SearchIcon } from '../common/Icons'

export function NoMatches({ query, onClear }: { query: string; onClear: () => void }) {
  return (
    <div className="grid min-h-[34vh] place-items-center border-2 border-dashed border-[var(--line-strong)] text-center">
      <div>
        <div className="mb-2 flex justify-center text-[var(--muted)]">
          <SearchIcon size={26} />
        </div>
        <p className="text-[14px] font-semibold text-[var(--ink)]">No tickets match “{query}”.</p>
        <button onClick={onClear} className="mt-2 text-[12.5px] text-[var(--link)] hover:underline">
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
        className="wf-ghost gap-1.5 whitespace-nowrap text-[11.5px]"
        title={`You moved ${keys.join(', ')} to Completed — undo to bring ${keys.length === 1 ? 'it' : 'them'} back onto the board`}
      >
        <EyeOffIcon size={13} /> {keys.length} moved to Completed. Undo
      </button>
    </div>
  )
}

/** Demo mode is on: say so loudly, offer a reset to the starting layout, and the way out. */
export function DemoBanner({ onExit, onReset, changes }: { onExit: () => void; onReset: () => void; changes: number }) {
  const pristine = changes === 0
  return (
    <div role="status" className="wf-band mb-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 py-1.5 pl-1.5 pr-2">
      <span className="wf-plate inline-flex h-7 items-center gap-1.5 px-2 text-[12px] font-extrabold">
        <FlaskIcon size={14} color="currentColor" /> <span className="wf-figure">Demo mode</span>
      </span>
      <span className="min-w-0 flex-1 text-[11.5px]">
        These tickets are invented. Drag them anywhere: the PR and QA gates still run, but nothing is sent to Jira or the AI intern.
      </span>
      <button
        type="button"
        onClick={onReset}
        disabled={pristine}
        title={pristine ? 'Nothing to reset — the demo board is as it started' : 'Put every ticket back where the demo started'}
        className="wf-ghost shrink-0 gap-1.5 text-[11.5px]"
      >
        <RefreshIcon size={12} color="currentColor" />
        Reset demo{pristine ? '' : ` (${changes} ${changes === 1 ? 'change' : 'changes'})`}
      </button>
      <button type="button" onClick={onExit} className="wf-ghost shrink-0 text-[11.5px]">
        Show my real board
      </button>
    </div>
  )
}
