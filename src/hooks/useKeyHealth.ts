import { useCallback, useEffect, useRef, useState } from 'react'
import { demoKeyHealth } from '../demo'
import { getKeyHealth } from '../lib/runner'
import type { HealthMap } from '../lib/apiKeys'

/** How often the latest real outcomes are re-read: quickly while the dialog is open, slowly otherwise. */
export const POLL_OPEN_MS = 20_000
export const POLL_CLOSED_MS = 60_000

/**
 * The latest real outcome of each service (served mode only): loaded on start, then polled — every
 * 20 s while the API keys dialog is open, every 60 s otherwise — and paused while the tab is hidden
 * (and re-read the moment it shows again). `refresh()` re-reads at once, e.g. right after a Test.
 * Demo mode never reads the real files: it returns a constant sample.
 */
export function useKeyHealth(served: boolean, dialogOpen: boolean, demo: boolean) {
  const [health, setHealth] = useState<HealthMap>({})
  const seq = useRef(0)
  const applied = useRef(0)

  const refresh = useCallback(async () => {
    if (!served || demo) return
    const n = ++seq.current
    const next = await getKeyHealth()
    // A failed read keeps what is shown (no dots flicker off when the server blips); an answer
    // older than the newest one already applied is dropped.
    if (next && n >= applied.current) {
      applied.current = n
      setHealth(next)
    }
  }, [served, demo])

  useEffect(() => {
    if (!served || demo) return
    void refresh()
    const every = dialogOpen ? POLL_OPEN_MS : POLL_CLOSED_MS
    const tick = () => {
      if (!document.hidden) void refresh()
    }
    const timer = window.setInterval(tick, every)
    document.addEventListener('visibilitychange', tick)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [served, demo, dialogOpen, refresh])

  return { health: demo ? demoKeyHealth() : health, refresh }
}
