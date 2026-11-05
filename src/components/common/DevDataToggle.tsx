import { DEV_DATASETS, setDevDataset, useDevDataset, type DevDataset } from '../../lib/devData'

/**
 * `npm run dev` + demo mode only: flip the demo board to the fixtures in lib/devData.ts. Not part of the design under
 * test. Unset is demo mode's own sample board (jira-intern/demo/data.json).
 */
export function DevDataToggle() {
  const current = useDevDataset()
  const options: { id: DevDataset | null; label: string }[] = [{ id: null, label: 'Demo board' }, ...DEV_DATASETS]
  return (
    <div
      role="radiogroup"
      aria-label="Dev data set"
      className="fixed bottom-14 left-1/2 z-[44] flex -translate-x-1/2 gap-0.5 rounded-full bg-[#e5e7eb] p-0.5 font-sans text-[11px] text-[#374151] shadow-sm"
    >
      {options.map((o) => {
        const on = current === o.id
        return (
          <button
            key={o.label}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => setDevDataset(o.id)}
            className={`whitespace-nowrap rounded-full px-2.5 py-1 font-medium ${on ? 'bg-white text-[#111827] shadow-sm' : 'hover:text-[#111827]'}`}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
