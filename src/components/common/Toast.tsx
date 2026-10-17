import { memo, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { lift } from '../../lib/tone'
import { DRAWER_RETURN, LAYOUT, TOAST, flickDismisses } from '../../lib/motion'

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
/** Thrown off to the right: a spring, so it picks up the swipe's velocity where the finger left it. */
const SWIPED_EXIT = { x: '120%', opacity: 0, transition: { type: 'spring', duration: 0.32, bounce: 0 } } as const

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
  // Swipe a toast right to dismiss it (apple-design / Sonner): it follows the pointer, rubber-bands
  // to the left, and a flick is enough — the projected resting point decides. A swiped toast leaves
  // the way it was thrown, carrying the release velocity; a closed one (×, timeout) sinks as before.
  const [swiped, setSwiped] = useState<ReadonlySet<number>>(() => new Set())
  const swipe = (id: number) => {
    setSwiped((prev) => new Set(prev).add(id))
    onDismiss(id)
  }

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
      <AnimatePresence custom={swiped}>
        {toasts.map((t) => {
          const kind = t.kind ?? 'info'
          return (
            <motion.div
              key={t.id}
              layout
              data-toast
              custom={swiped}
              variants={{
                initial: TOAST.initial,
                animate: TOAST.animate,
                exit: (gone: ReadonlySet<number>) => (gone.has(t.id) ? SWIPED_EXIT : TOAST.exit),
              }}
              initial="initial"
              animate="animate"
              exit="exit"
              transition={{ layout: LAYOUT }}
              drag="x"
              dragConstraints={{ left: 0, right: 0 }}
              dragElastic={{ left: 0.1, right: 1 }}
              dragMomentum={false}
              dragTransition={DRAWER_RETURN}
              onDragEnd={(e, info) => {
                const width = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-toast]')?.offsetWidth ?? 320
                if (flickDismisses(info.offset.x, info.velocity.x, width, 0.4)) swipe(t.id)
              }}
              className="jb-float pointer-events-auto flex touch-pan-y max-w-[92vw] items-center gap-2.5 rounded-xl border border-[var(--line)] bg-[var(--surface-solid)] px-4 py-2.5 text-[12.5px] font-medium text-[var(--ink)] card-shadow"
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
