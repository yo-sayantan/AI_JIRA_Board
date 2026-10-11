import { useCallback, useEffect, useRef, useState } from 'react'
import type { ToastAction, ToastItem } from '../components/common/Toast'

export interface ToastOptions {
  action?: ToastAction
  /** Seconds on screen, instead of the Settings value. */
  seconds?: number
}
export type ToastFn = (msg: string, kind?: ToastItem['kind'], opts?: ToastOptions) => number
export type DismissFn = (id: number) => void

/**
 * Notifications, governed by two Settings values: how many may be on screen at once (`max`) and
 * how long each stays (`seconds`). A new toast appears the moment it is raised when a slot is
 * free; otherwise it waits its turn and its clock only starts once it is actually visible, so a
 * burst of messages is shown one after another instead of flashing past in a bunch.
 */
export function useToasts(seconds: number, max: number) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const nextId = useRef(0)
  const prefs = useRef({ seconds, max })
  prefs.current = { seconds, max }
  // Waiting toasts, oldest first, and the expiry timer of each visible one.
  const queue = useRef<ToastItem[]>([])
  const visible = useRef<ToastItem[]>([])
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>())

  const render = () => setToasts([...visible.current])

  const remove = useCallback((id: number) => {
    const timer = timers.current.get(id)
    if (timer) clearTimeout(timer)
    timers.current.delete(id)
    visible.current = visible.current.filter((t) => t.id !== id)
  }, [])

  /** Move waiting toasts on screen while there is room, starting each one's timer as it shows. */
  const pump = useCallback(() => {
    while (queue.current.length && visible.current.length < prefs.current.max) {
      const next = queue.current.shift()!
      visible.current.push(next)
      timers.current.set(
        next.id,
        setTimeout(() => {
          remove(next.id)
          pump()
        }, (next.seconds ?? prefs.current.seconds) * 1000),
      )
    }
    render()
  }, [remove])

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
    for (const t of visible.current) remove(t.id)
    render()
  }, [remove])

  const toast = useCallback<ToastFn>(
    (msg, kind = 'info', opts) => {
      const id = ++nextId.current
      queue.current.push({ id, msg, kind, ...opts })
      pump()
      return id
    },
    [pump],
  )

  // Fewer slots: the oldest on screen close first and go back to nobody (they were seen).
  useEffect(() => {
    if (visible.current.length > max) {
      for (const t of visible.current.slice(0, visible.current.length - max)) remove(t.id)
    }
    pump()
  }, [max, remove, pump])

  useEffect(() => {
    const pending = timers.current
    return () => pending.forEach((t) => clearTimeout(t))
  }, [])

  return { toasts, toast, dismiss, clear }
}
