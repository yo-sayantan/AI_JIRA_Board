import { useCallback, useEffect, useRef, useState } from 'react'
import type { ToastAction, ToastItem } from '../components/common/Toast'

export interface ToastOptions {
  action?: ToastAction
  /** Seconds on screen, instead of what the rules below give it. Rarely needed. */
  seconds?: number
}
export type ToastFn = (msg: string, kind?: ToastItem['kind'], opts?: ToastOptions) => number
export type DismissFn = (id: number) => void

/** A toast with a button (Undo, Move anyway) stays at least this long, however short Settings makes the others. */
export const ACTION_MIN_SECONDS = 12

/**
 * How long a toast stays: Settings → "Close after" for a plain one; for one with a button, twice that and never under
 * `ACTION_MIN_SECONDS` — reading "KEY → Done in Jira", deciding, and reaching for Undo takes longer than reading a notice.
 */
export function toastSeconds(item: Pick<ToastItem, 'action' | 'seconds'>, settingSeconds: number): number {
  if (item.seconds) return item.seconds
  return item.action ? Math.max(ACTION_MIN_SECONDS, settingSeconds * 2) : settingSeconds
}

interface Clock {
  timer?: ReturnType<typeof setTimeout>
  /** When it closes, while running (ms since epoch). */
  due: number
  /** What was left when it was paused (ms). */
  left: number
}

/**
 * Notifications, governed by two Settings values: how many may be on screen at once (`max`) and how long a plain one
 * stays (`seconds`). Rules, in order of importance:
 *
 * - A toast with a BUTTON (Undo, Move anyway) is a priority toast. It never waits: with every slot taken it bumps the
 *   oldest PLAIN toast off the screen, and it is never bumped by a plain one. It also stays longer (`toastSeconds`).
 *   (Before, an Undo raised while the slots were full queued behind progress notices, and showed late or seemed never to
 *   come; and its fixed 8 s was shorter than the default plain toast.)
 * - Plain toasts take a free slot, or wait their turn — priority ones are let in first. A toast's clock starts only
 *   once it is on screen, so a burst is shown one after another instead of flashing past.
 * - Every clock PAUSES while the pointer (or keyboard focus) is on the notifications and while the tab is hidden, and
 *   resumes with the time it had left: a toast never vanishes from under the cursor reaching for Undo, nor while you
 *   checked Jira in another tab.
 */
export function useToasts(seconds: number, max: number) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const nextId = useRef(0)
  const prefs = useRef({ seconds, max })
  prefs.current = { seconds, max }
  // Waiting toasts — priority first, then by arrival — and the clock of each visible one.
  const queue = useRef<ToastItem[]>([])
  const visible = useRef<ToastItem[]>([])
  const clocks = useRef(new Map<number, Clock>())
  // Pause reasons that are on: 'hover' (pointer / focus on the stack) and 'hidden' (tab in the background).
  const pausedBy = useRef(new Set<string>())

  const render = () => setToasts([...visible.current])
  const isPriority = (t: ToastItem) => !!t.action

  const remove = useCallback((id: number) => {
    const clock = clocks.current.get(id)
    if (clock?.timer) clearTimeout(clock.timer)
    clocks.current.delete(id)
    visible.current = visible.current.filter((t) => t.id !== id)
  }, [])

  // `pump` and `arm` call each other (a toast that times out frees its slot): a ref breaks the cycle.
  const pumpRef = useRef<() => void>(() => {})

  /** Start (or restart) a visible toast's clock with `ms` left — unless the stack is paused, then just remember `ms`. */
  const arm = useCallback(
    (id: number, ms: number) => {
      const clock: Clock = { due: Date.now() + ms, left: ms }
      if (pausedBy.current.size === 0) {
        clock.timer = setTimeout(() => {
          remove(id)
          pumpRef.current()
        }, ms)
      }
      clocks.current.set(id, clock)
    },
    [remove],
  )

  const show = useCallback(
    (t: ToastItem) => {
      visible.current.push(t)
      arm(t.id, toastSeconds(t, prefs.current.seconds) * 1000)
    },
    [arm],
  )

  /** Move waiting toasts on screen while there is room, starting each one's clock as it shows. */
  const pump = useCallback(() => {
    while (queue.current.length && visible.current.length < prefs.current.max) show(queue.current.shift()!)
    render()
  }, [show])
  pumpRef.current = pump

  /** Queue in order: priority toasts ahead of every plain one, each group oldest first. */
  const enqueue = (t: ToastItem) => {
    if (!isPriority(t)) return void queue.current.push(t)
    const firstPlain = queue.current.findIndex((q) => !isPriority(q))
    if (firstPlain < 0) queue.current.push(t)
    else queue.current.splice(firstPlain, 0, t)
  }

  const dismiss = useCallback<DismissFn>(
    (id) => {
      queue.current = queue.current.filter((t) => t.id !== id)
      remove(id)
      pump()
    },
    [remove, pump],
  )

  /** Every toast, visible or waiting — e.g. a demo reset, whose old Undo buttons would undo nothing. */
  const clear = useCallback(() => {
    queue.current = []
    for (const t of [...visible.current]) remove(t.id)
    render()
  }, [remove])

  const toast = useCallback<ToastFn>(
    (msg, kind = 'info', opts) => {
      const id = ++nextId.current
      const item: ToastItem = { id, msg, kind, ...opts }
      // A priority toast with every slot taken bumps the oldest plain one, so it shows NOW.
      if (isPriority(item) && visible.current.length >= prefs.current.max) {
        const plain = visible.current.find((t) => !isPriority(t))
        if (plain) remove(plain.id)
      }
      enqueue(item)
      pump()
      return id
    },
    [pump, remove],
  )

  /** Stop every clock (keeping what each had left), for one reason; clocks run again when no reason is left. */
  const pause = useCallback((reason: string) => {
    if (pausedBy.current.has(reason)) return
    const wasRunning = pausedBy.current.size === 0
    pausedBy.current.add(reason)
    if (!wasRunning) return
    const now = Date.now()
    for (const clock of clocks.current.values()) {
      if (clock.timer) clearTimeout(clock.timer)
      clock.timer = undefined
      clock.left = Math.max(0, clock.due - now)
    }
  }, [])

  const resume = useCallback(
    (reason: string) => {
      if (!pausedBy.current.delete(reason) || pausedBy.current.size) return
      // A toast keeps at least a second and a half after a pause, so it does not blink out the moment the pointer leaves.
      for (const [id, clock] of [...clocks.current]) arm(id, Math.max(1500, clock.left))
    },
    [arm],
  )

  // The tab in the background: nobody can read or press anything.
  useEffect(() => {
    if (typeof document === 'undefined') return
    const onVisibility = () => (document.hidden ? pause('hidden') : resume('hidden'))
    onVisibility()
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [pause, resume])

  // Fewer slots: plain toasts close first (they were seen), oldest first; priority ones only if they alone overflow.
  useEffect(() => {
    while (visible.current.length > max) {
      const victim = visible.current.find((t) => !isPriority(t)) ?? visible.current[0]
      remove(victim.id)
    }
    pump()
  }, [max, remove, pump])

  useEffect(() => {
    const pending = clocks.current
    return () => pending.forEach((c) => c.timer && clearTimeout(c.timer))
  }, [])

  return { toasts, toast, dismiss, clear, pause, resume }
}
