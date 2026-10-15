import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { hexToRgba } from '../../lib/format'

/**
 * A compact multi-select for "which optional sections does my board show": the chosen ones sit in
 * the field as removable chips, and one dropdown lists every option with a checkbox. It replaces a
 * grid of one switch card per section, so adding a section adds a row to a list, not another tile.
 *
 * Keyboard: Enter/Space/↓ opens; ↑↓ Home End move; Space or Enter toggles the highlighted option;
 * Esc closes the list (and only the list — the Settings dialog stays open); Tab closes it.
 */
export interface PickerOption {
  key: string
  label: string
  /** The shorter name for the chip in the field once chosen; the list keeps the full label. */
  chipLabel?: string
  hint: string
  detail?: string
  color: string
  icon: (color: string) => ReactNode
}

const LIST_MAX = 288 // px — also the room needed below the field before the list opens upward

export function SectionPicker({
  label,
  options,
  selected,
  onToggle,
  onSetAll,
  emptyText = 'None selected.',
}: {
  label: string
  options: readonly PickerOption[]
  selected: ReadonlySet<string>
  onToggle: (key: string, on: boolean) => void
  onSetAll: (on: boolean) => void
  emptyText?: string
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [up, setUp] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const fieldRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const id = useId()
  const chosen = options.filter((o) => selected.has(o.key))

  const openList = () => {
    setActive(Math.max(0, options.findIndex((o) => !selected.has(o.key))))
    setOpen(true)
  }
  const closeList = (refocus = true) => {
    setOpen(false)
    if (refocus) fieldRef.current?.focus()
  }

  // Open upward when the bottom of the screen would cut the list off.
  useLayoutEffect(() => {
    if (!open || !fieldRef.current) return
    const r = fieldRef.current.getBoundingClientRect()
    setUp(window.innerHeight - r.bottom < LIST_MAX + 16 && r.top > LIST_MAX)
  }, [open])

  useEffect(() => {
    if (open) listRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    // window + capture: runs before the dialog's own Escape handler, so Esc closes only the list.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopImmediatePropagation()
      e.preventDefault()
      closeList()
    }
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('keydown', onKey, true)
    document.addEventListener('mousedown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      document.removeEventListener('mousedown', onDown)
    }
  }, [open])

  const onListKeys = (e: React.KeyboardEvent) => {
    const n = options.length
    if (e.key === 'ArrowDown') setActive((a) => (a + 1) % n)
    else if (e.key === 'ArrowUp') setActive((a) => (a - 1 + n) % n)
    else if (e.key === 'Home') setActive(0)
    else if (e.key === 'End') setActive(n - 1)
    else if (e.key === ' ' || e.key === 'Enter') {
      const o = options[active]
      if (o) onToggle(o.key, !selected.has(o.key))
    } else if (e.key === 'Tab') {
      setOpen(false)
      return
    } else return
    e.preventDefault()
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={fieldRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-label={`${label}: ${chosen.length ? chosen.map((c) => c.chipLabel ?? c.label).join(', ') : 'none'}. ${open ? 'List open.' : 'Press to choose.'}`}
        onClick={() => (open ? closeList(false) : openList())}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault()
            openList()
          }
        }}
        className="flex min-h-11 w-full min-w-0 items-center gap-2 rounded-lg border border-[var(--line)] bg-[var(--surface-2)] px-2.5 py-1.5 text-left transition-colors hover:border-[var(--line-strong)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--link)]"
      >
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          {chosen.length === 0 ? (
            <span className="text-[11.5px] text-[var(--muted)]">{emptyText}</span>
          ) : (
            chosen.map((o) => (
              <span
                key={o.key}
                className="inline-flex items-center gap-1.5 rounded-full border py-0.5 pl-1.5 pr-2 text-[11px] font-bold"
                style={{ borderColor: hexToRgba(o.color, 0.45), background: hexToRgba(o.color, 0.1), color: o.color }}
              >
                {o.icon(o.color)}
                {o.chipLabel ?? o.label}
              </span>
            ))
          )}
        </span>
        <span aria-hidden className="shrink-0 px-1 text-[13px] font-black leading-none text-[var(--muted)]" style={{ transform: open ? 'rotate(180deg)' : undefined }}>
          ▾
        </span>
      </button>

      {open && (
        <div
          className={`absolute left-0 right-0 z-20 overflow-hidden rounded-xl border border-[var(--line-strong)] bg-[var(--surface-solid)] shadow-xl ${up ? 'bottom-full mb-1.5' : 'top-full mt-1.5'}`}
        >
          <div className="flex items-center gap-2 border-b border-[var(--line)] px-3 py-1.5 text-[10.5px] text-[var(--muted)]">
            <span className="font-bold uppercase tracking-wider">
              {chosen.length} of {options.length} shown
            </span>
            <span className="ml-auto flex gap-1">
              <button type="button" onClick={() => onSetAll(true)} disabled={chosen.length === options.length} className="rounded px-1.5 py-0.5 font-bold text-[var(--link)] hover:bg-[var(--surface-2)] disabled:opacity-40">
                Select all
              </button>
              <button type="button" onClick={() => onSetAll(false)} disabled={chosen.length === 0} className="rounded px-1.5 py-0.5 font-bold text-[var(--link)] hover:bg-[var(--surface-2)] disabled:opacity-40">
                Clear
              </button>
            </span>
          </div>
          <div
            ref={listRef}
            id={`${id}-list`}
            role="listbox"
            aria-multiselectable
            aria-label={label}
            aria-activedescendant={`${id}-opt-${active}`}
            tabIndex={0}
            onKeyDown={onListKeys}
            className="overflow-y-auto p-1 outline-none"
            style={{ maxHeight: LIST_MAX }}
          >
            {options.map((o, i) => {
              const on = selected.has(o.key)
              return (
                <div
                  key={o.key}
                  id={`${id}-opt-${i}`}
                  role="option"
                  aria-selected={on}
                  title={o.detail}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => onToggle(o.key, !on)}
                  className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5"
                  style={{ background: i === active ? hexToRgba(o.color, 0.09) : undefined }}
                >
                  <span
                    aria-hidden
                    className="grid h-4 w-4 shrink-0 place-items-center rounded border text-[10px] font-black leading-none text-white"
                    style={{ borderColor: on ? o.color : 'var(--line-strong)', background: on ? o.color : 'transparent' }}
                  >
                    {on ? '✓' : ''}
                  </span>
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md" style={{ background: hexToRgba(on ? o.color : '#94a3b8', 0.16), filter: on ? undefined : 'grayscale(1)' }}>
                    {o.icon(on ? o.color : 'var(--muted)')}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] font-bold leading-tight" style={{ color: on ? 'var(--ink)' : 'var(--muted)' }}>
                      {o.label}
                    </span>
                    <span className="mt-0.5 block truncate text-[10.5px] leading-tight text-[var(--muted)]">{o.hint}</span>
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
