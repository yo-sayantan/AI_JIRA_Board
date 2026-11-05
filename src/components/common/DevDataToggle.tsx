import { DEV_DATASETS, setDevDataset, useDevDataset, type DevDataset } from '../../lib/devData'

/**
 * In demo mode, flip the board to the fixtures in lib/devData.ts. Unset is demo mode's own sample board
 * (jira-intern/demo/data.json).
 */
export function DevDataToggle() {
  const current = useDevDataset()
  const options: { id: DevDataset | null; label: string }[] = [{ id: null, label: 'Demo board' }, ...DEV_DATASETS]
  return (
    <div
      role="radiogroup"
      aria-label="Demo data set"
      className="fixed bottom-14 left-1/2 z-[44] flex max-w-[calc(100vw-1rem)] -translate-x-1/2 gap-0.5 overflow-x-auto overscroll-x-contain rounded-full bg-[#e5e7eb] p-0.5 font-sans text-[11px] text-[#374151] shadow-sm"
    >
      {options.map((o) => {
        const on = current === o.id
        return (
          <label
            key={o.label}
            className="shrink-0 cursor-pointer"
          >
            <input
              type="radio"
              name="demo-data-set"
              value={o.id ?? ''}
              checked={on}
              onChange={() => setDevDataset(o.id)}
              className="peer sr-only"
            />
            <span
              className={`block whitespace-nowrap rounded-full px-2.5 py-1 font-medium peer-focus-visible:ring-2 peer-focus-visible:ring-[#2563eb] peer-focus-visible:ring-offset-1 ${
                on ? 'bg-white text-[#111827] shadow-sm' : 'hover:text-[#111827]'
              }`}
            >
              {o.label}
            </span>
          </label>
        )
      })}
    </div>
  )
}
