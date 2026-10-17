import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { lift } from '../../lib/tone'
import { EASE_OUT } from '../../lib/motion'

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

/** How far each toast behind the front one peeks out, and the gap between toasts when the stack opens. */
export const PEEK = 12
export const GAP = 8
/** Toasts behind the front one that still show an edge; deeper ones fade out. */
const VISIBLE_BEHIND = 2

/**
 * Front-to-back order of a stack: toasts with a button (Undo, Move anyway) in front — their button
 * must stay reachable without opening the stack — then the rest, newest first.
 */
export function stackOrder(toasts: ToastItem[]): ToastItem[] {
  const newestFirst = [...toasts].reverse()
  return [...newestFirst.filter((t) => t.action), ...newestFirst.filter((t) => !t.action)]
}

export interface StackSlot {
  /** translateY from the stack's bottom edge, px. */
  y: number
  scale: number
  opacity: number
  /** The toast's own text and buttons — hidden behind the front toast while the stack is closed. */
  contentOpacity: number
}

/**
 * Where each toast sits (Sonner's stack): closed, the front toast sits at the bottom and the ones
 * behind it line their TOP edge up a few px above the front's top, shrinking a little each, so the
 * stack reads as a deck however tall each toast is; open, they lay out as a list, newest at the bottom.
 */
export function stackLayout(heights: number[], expanded: boolean): StackSlot[] {
  const front = heights[0] ?? 0
  let above = 0
  return heights.map((h, i) => {
    if (expanded) {
      const slot = { y: above ? -above : 0, scale: 1, opacity: 1, contentOpacity: 1 }
      above += h + GAP
      return slot
    }
    return {
      // Top edge at (front's top − i·PEEK): bottom-anchored, so shift by the height difference.
      y: i === 0 ? 0 : h - front - i * PEEK,
      scale: 1 - i * 0.05,
      opacity: i <= VISIBLE_BEHIND ? 1 : 0,
      contentOpacity: i === 0 ? 1 : 0,
    }
  })
}

/** The stack's footprint, px — what the pointer can hover. */
export function stackHeight(heights: number[], expanded: boolean): number {
  if (!heights.length) return 0
  if (expanded) return heights.reduce((a, h) => a + h, 0) + GAP * (heights.length - 1)
  return heights[0] + PEEK * Math.min(heights.length - 1, VISIBLE_BEHIND)
}

const SLIDE = { duration: 0.32, ease: EASE_OUT }

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
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [heights, setHeights] = useState<Record<number, number>>({})
  const observers = useRef(new Map<number, ResizeObserver>())
  useEffect(() => () => observers.current.forEach((o) => o.disconnect()), [])

  // Measure each toast (text wraps, so heights differ) and keep measuring while it lives.
  const refs = useRef(new Map<number, (el: HTMLDivElement | null) => void>())
  const refFor = (id: number) => {
    let fn = refs.current.get(id)
    if (!fn) {
      fn = (el) => {
        measure(id, el)
        if (!el) refs.current.delete(id)
      }
      refs.current.set(id, fn)
    }
    return fn
  }
  const measure = useCallback((id: number, el: HTMLDivElement | null) => {
    observers.current.get(id)?.disconnect()
    observers.current.delete(id)
    if (!el) return
    const read = () => setHeights((prev) => (prev[id] === el.offsetHeight ? prev : { ...prev, [id]: el.offsetHeight }))
    read()
    if (typeof ResizeObserver !== 'undefined') {
      const o = new ResizeObserver(read)
      o.observe(el)
      observers.current.set(id, o)
    }
  }, [])

  const order = stackOrder(toasts)
  // Nothing left to hover: the stack closes again (and the pause reason goes with it).
  useEffect(() => {
    if (!toasts.length && hovered) {
      setHovered(false)
      onResume?.('hover')
    }
  }, [toasts.length, hovered, onResume])
  const expanded = (hovered || focused) && order.length > 1
  const hs = order.map((t) => heights[t.id] ?? 44)
  const slots = stackLayout(hs, expanded)

  return (
    <div
      className="fixed bottom-12 right-4 z-[60] w-[min(380px,92vw)]"
      // Closed, only the toasts take the pointer; open, the whole stack does, so the gaps between
      // toasts don't close it under a pointer that is travelling from one to the next.
      style={{ height: stackHeight(hs, expanded), pointerEvents: expanded ? 'auto' : 'none' }}
      role="status"
      aria-live="polite"
      onPointerEnter={() => {
        setHovered(true)
        onPause?.('hover')
      }}
      onPointerLeave={() => {
        setHovered(false)
        onResume?.('hover')
      }}
      onFocus={() => {
        setFocused(true)
        onPause?.('focus')
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setFocused(false)
          onResume?.('focus')
        }
      }}
    >
      <AnimatePresence initial={false}>
        {order.map((t, i) => {
          const kind = t.kind ?? 'info'
          const slot = slots[i]
          return (
            <motion.div
              key={t.id}
              ref={refFor(t.id)}
              initial={{ opacity: 0, y: 16, scale: 1 }}
              animate={{ opacity: slot.opacity, y: slot.y, scale: slot.scale }}
              exit={{ opacity: 0, y: slot.y + 8, scale: slot.scale * 0.97, transition: { duration: 0.16, ease: EASE_OUT } }}
              transition={SLIDE}
              style={{ zIndex: order.length - i, transformOrigin: 'top center' }}
              className="jb-float pointer-events-auto absolute bottom-0 right-0 flex w-full items-center gap-2.5 rounded-xl border border-[var(--line)] bg-[var(--surface-solid)] px-4 py-2.5 text-[12.5px] font-medium text-[var(--ink)] card-shadow"
            >
              <motion.div className="flex min-w-0 flex-1 items-center gap-2.5" animate={{ opacity: slot.contentOpacity }} transition={{ duration: 0.16, ease: EASE_OUT }}>
                <span className={kind === 'loading' ? 'animate-spin' : ''} style={{ color: lift(COLOR[kind]) }}>
                  {ICON[kind]}
                </span>
                <span className="min-w-0 flex-1">{t.msg}</span>
                {t.action && (
                  <button
                    type="button"
                    tabIndex={!expanded && i > 0 ? -1 : undefined}
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
                  tabIndex={!expanded && i > 0 ? -1 : undefined}
                  onClick={() => onDismiss(t.id)}
                  className="-mr-1 grid h-5 w-5 shrink-0 place-items-center rounded-md text-[14px] leading-none text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--ink)]"
                  aria-label="Dismiss notification"
                  title="Dismiss"
                >
                  ×
                </button>
              </motion.div>
            </motion.div>
          )
        })}
      </AnimatePresence>
    </div>
  )
})
