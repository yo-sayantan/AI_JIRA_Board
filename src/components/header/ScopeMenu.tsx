import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { currentYear, dateInputDaysAgo, hexToRgba } from '../../lib/format'
import { APP_CONFIG } from '../../lib/appConfig'

export type MenuScope = { scope: 'all' } | { scope: 'year'; year: number } | { scope: 'since'; since: string } | { scope: 'key'; key: string }

const KEY_RE = /^[A-Za-z][A-Za-z0-9]+-\d+$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const SPRING = { type: 'spring', stiffness: 120, damping: 22, mass: 0.6 } as const

const daysAgo = (n: number) => dateInputDaysAgo(n, APP_CONFIG.timeZone)

export interface ScopeMenuProps {
  color: string
  /** The header icon button; receives the open state and the toggle. */
  trigger: (open: boolean, toggle: () => void) => ReactNode
  title: string
  subtitle: string
  progress: { busy: boolean; fill: number; shimmer: boolean; label: string }
  served: boolean
  /** What to run from a terminal when there is no server. */
  offline: { what: string; command: string }
  options: {
    allLabel: string
    allHint: string
    yearHint: string
    sinceHint: (date: string) => string
    windows: number[]
    defaultWindowDays: number
    sinceAria: string
    keyAria: string
    /** Extra one-click scopes listed right under the "all" item. */
    extra?: { label: string; hint: string; disabled?: boolean; onClick: () => void }[]
  }
  disabled?: boolean
  onPick: (target: MenuScope) => void
  footer?: ReactNode
}

/** Header dropdown with a progress banner and the shared scope picker: all, this year, a window, one ticket. */
export function ScopeMenu({ color, trigger, title, subtitle, progress, served, offline, options, disabled = false, onPick, footer }: ScopeMenuProps) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const { busy, fill, shimmer, label } = progress
  return (
    <div className="relative" ref={wrapRef}>
      {trigger(open, () => setOpen((o) => !o))}

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            className="absolute right-0 z-50 mt-2 w-[330px] origin-top-right overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--surface-solid)] shadow-2xl"
            role="menu"
          >
            <div
              className="relative overflow-hidden rounded-t-xl border-b border-[var(--line)] px-3.5 py-2.5"
              style={{ background: hexToRgba(color, busy ? 0.16 : 0.08) }}
              role={busy ? 'progressbar' : undefined}
              aria-valuenow={busy ? fill : undefined}
              aria-valuemin={busy ? 0 : undefined}
              aria-valuemax={busy ? 100 : undefined}
              aria-label={busy ? label : undefined}
            >
              {busy && (
                <>
                  <motion.span
                    aria-hidden
                    className="pointer-events-none absolute inset-y-0 left-0"
                    initial={false}
                    animate={{ width: `${fill}%` }}
                    transition={SPRING}
                    style={{ background: `linear-gradient(90deg, ${hexToRgba(color, 0.55)}, ${hexToRgba(color, 0.28)})` }}
                  />
                  <motion.span
                    aria-hidden
                    className="pointer-events-none absolute inset-y-0 z-[1] w-[2px]"
                    initial={false}
                    animate={{ left: `calc(${fill}% - 1px)` }}
                    transition={SPRING}
                    style={{ background: 'rgba(255,255,255,0.85)' }}
                  />
                </>
              )}
              {busy && shimmer && (
                <motion.span
                  aria-hidden
                  className="pointer-events-none absolute inset-y-0 z-[1] w-1/3"
                  animate={{ left: ['-33%', '100%'] }}
                  transition={{ repeat: Infinity, duration: 1.1, ease: 'linear' }}
                  style={{ background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.45), transparent)' }}
                />
              )}
              <div className="relative">
                <div className="text-[12px] font-extrabold" style={{ color }}>
                  {title}
                </div>
                <div className="mt-0.5 text-[11px] text-[var(--muted)]">{subtitle}</div>
              </div>
            </div>

            {served ? (
              <div className="flex flex-col gap-1 p-2">
                <ScopeOptions color={color} disabled={disabled} onPick={onPick} {...options} />
                {footer}
              </div>
            ) : (
              <div className="px-3.5 py-3 text-[11.5px] text-[var(--muted)]">
                {offline.what} needs the local server or Docker. From a terminal:
                <code className="mt-1 block rounded bg-[var(--surface-2)] px-1.5 py-1 text-[10.5px]">{offline.command}</code>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export function StopButton({ color, label, onClick }: { color: string; label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="mt-1 rounded-lg border px-2.5 py-1.5 text-[12px] font-bold" style={{ borderColor: hexToRgba(color, 0.45), color }}>
      {label}
    </button>
  )
}

function ScopeOptions({
  color,
  disabled,
  onPick,
  allLabel,
  allHint,
  yearHint,
  sinceHint,
  windows,
  defaultWindowDays,
  sinceAria,
  keyAria,
  extra = [],
}: ScopeMenuProps['options'] & { color: string; disabled: boolean; onPick: (target: MenuScope) => void }) {
  const [since, setSince] = useState(() => daysAgo(defaultWindowDays))
  const [key, setKey] = useState('')
  const thisYear = useMemo(() => currentYear(APP_CONFIG.timeZone), [])
  const pick = (target: MenuScope) => {
    if (!disabled) onPick(target)
  }
  const pickKey = () => {
    if (!KEY_RE.test(key.trim())) return
    pick({ scope: 'key', key: key.trim().toUpperCase() })
    setKey('')
  }

  return (
    <>
      <MenuItem color={color} label={allLabel} hint={allHint} disabled={disabled} onClick={() => pick({ scope: 'all' })} />
      {extra.map((item) => (
        <MenuItem key={item.label} color={color} label={item.label} hint={item.hint} disabled={disabled || item.disabled} onClick={() => !disabled && item.onClick()} />
      ))}
      <MenuItem color={color} label={`This year (${thisYear})`} hint={yearHint} disabled={disabled} onClick={() => pick({ scope: 'year', year: thisYear })} />
      {windows.map((days) => (
        <MenuItem key={days} color={color} label={`Last ${days} days`} hint={sinceHint(daysAgo(days))} disabled={disabled} onClick={() => pick({ scope: 'since', since: daysAgo(days) })} />
      ))}
      <InputRow
        color={color}
        heading="Custom window"
        value={since}
        onChange={setSince}
        placeholder="YYYY-MM-DD"
        numeric
        ariaLabel={sinceAria}
        canSubmit={DATE_RE.test(since) && !disabled}
        onSubmit={() => pick({ scope: 'since', since })}
      />
      <InputRow
        color={color}
        heading="One ticket"
        value={key}
        onChange={setKey}
        placeholder="TICKET-123"
        ariaLabel={keyAria}
        canSubmit={KEY_RE.test(key.trim()) && !disabled}
        onSubmit={pickKey}
        submitOnEnter
      />
    </>
  )
}

function InputRow({
  color,
  heading,
  value,
  onChange,
  placeholder,
  numeric,
  ariaLabel,
  canSubmit,
  onSubmit,
  submitOnEnter,
}: {
  color: string
  heading: string
  value: string
  onChange: (v: string) => void
  placeholder: string
  numeric?: boolean
  ariaLabel: string
  canSubmit: boolean
  onSubmit: () => void
  submitOnEnter?: boolean
}) {
  return (
    <div className="mt-1 border-t border-[var(--line)] pt-2">
      <div className="px-1.5 pb-1 text-[10px] font-bold uppercase tracking-wide text-[var(--muted)]">{heading}</div>
      <div className="flex items-center gap-1.5 px-1.5">
        <input
          type="text"
          inputMode={numeric ? 'numeric' : undefined}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={submitOnEnter ? (e) => e.key === 'Enter' && canSubmit && onSubmit() : undefined}
          className="min-w-0 flex-1 rounded-lg border border-[var(--line)] bg-[var(--bg)] px-2 py-1 font-mono text-[11.5px] text-[var(--ink)] outline-none focus:border-[var(--muted)]"
          aria-label={ariaLabel}
        />
        <button
          type="button"
          onClick={onSubmit}
          disabled={!canSubmit}
          className="shrink-0 rounded-lg px-2.5 py-1 text-[11.5px] font-bold text-white disabled:opacity-50"
          style={{ background: color }}
        >
          Run
        </button>
      </div>
    </div>
  )
}

function MenuItem({ color, label, hint, onClick, disabled }: { color: string; label: string; hint: string; onClick: () => void; disabled?: boolean }) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      disabled={disabled}
      role="menuitem"
      whileHover={disabled ? undefined : { y: -1 }}
      whileTap={disabled ? undefined : { scale: 0.985, y: 0 }}
      transition={{ type: 'spring', stiffness: 520, damping: 26 }}
      className="jb-scope-item flex w-full items-center gap-2 rounded-lg border border-transparent bg-transparent px-2 py-1.5 text-left shadow-none transition-[background-color,border-color,box-shadow] duration-150 hover:bg-[var(--surface-2)] disabled:opacity-50 disabled:hover:bg-transparent"
      style={{ ['--scope' as string]: color }}
    >
      <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />
      <span className="min-w-0 flex-1">
        <span className="block text-[12px] font-semibold text-[var(--ink)]">{label}</span>
        <span className="block text-[10.5px] text-[var(--muted)]">{hint}</span>
      </span>
    </motion.button>
  )
}
