import { memo } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { lift } from '../../lib/tone'
import { LAYOUT, TOAST } from '../../lib/motion'

export type ToastKind = 'info' | 'success' | 'error' | 'loading'
export interface ToastAction {
  label: string
  run: () => void
}
export interface ToastItem {
  id: number
  msg: string
  kind?: ToastKind
  /** One button beside the message (Undo, Move anyway…); pressing it also closes the toast. */
  action?: ToastAction
  /** Overrides Settings → toast duration for this one (an Undo window, say). */
  seconds?: number
}

const ICON: Record<ToastKind, string> = { info: 'ⓘ', success: '✓', error: '⚠️', loading: '◌' }
const COLOR: Record<ToastKind, string> = { info: '#8b9cff', success: '#22c55e', error: '#ef4444', loading: '#8b9cff' }

export const Toasts = memo(function Toasts({
  toasts,
  onDismiss,
  onPause,
  onResume,
}: {
  toasts: ToastItem[]
  onDismiss: (id: number) => void
  /** The pointer or keyboard focus is on the notifications: hold every clock (useToasts). */
  onPause?: (reason: string) => void
  onResume?: (reason: string) => void
}) {
  return (
    <div
      className="pointer-events-none fixed bottom-12 right-4 z-[60] flex flex-col items-end gap-2"
      role="status"
      aria-live="polite"
      onPointerEnter={() => onPause?.('hover')}
      onPointerLeave={() => onResume?.('hover')}
      onFocus={() => onPause?.('focus')}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onResume?.('focus')
      }}
    >
      <AnimatePresence>
        {toasts.map((t) => {
          const kind = t.kind ?? 'info'
          return (
            <motion.div
              key={t.id}
              layout
              {...TOAST}
              transition={{ layout: LAYOUT }}
              className="jb-float pointer-events-auto flex max-w-[92vw] items-center gap-2.5 rounded-xl border border-[var(--line)] bg-[var(--surface-solid)] px-4 py-2.5 text-[12.5px] font-medium text-[var(--ink)] card-shadow"
            >
              <span className={kind === 'loading' ? 'animate-spin' : ''} style={{ color: lift(COLOR[kind]) }}>
                {ICON[kind]}
              </span>
              <span className="min-w-0">{t.msg}</span>
              {t.action && (
                <button
                  type="button"
                  onClick={() => {
                    onDismiss(t.id)
                    t.action!.run()
                  }}
                  className="shrink-0 rounded-md border px-2 py-0.5 text-[11.5px] font-bold transition-colors"
                  style={{ color: lift(COLOR[kind]), borderColor: `${COLOR[kind]}73`, background: `${COLOR[kind]}12` }}
                >
                  {t.action.label}
                </button>
              )}
              <button
                type="button"
                onClick={() => onDismiss(t.id)}
                className="-mr-1 grid h-5 w-5 shrink-0 place-items-center rounded-md text-[14px] leading-none text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--ink)]"
                aria-label="Dismiss notification"
                title="Dismiss"
              >
                ×
              </button>
            </motion.div>
          )
        })}
      </AnimatePresence>
    </div>
  )
})
