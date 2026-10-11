import { useCallback, useEffect, useRef, useState } from 'react'
import { getApiKeys, saveApiKey } from '../lib/runner'
import type { KeyStatus } from '../lib/apiKeys'

/**
 * The masked API-key status from setup/.env (served mode only). Loaded once on start — so the
 * header can flag a missing Jira token for a new user — and again whenever the dialog opens.
 */
export function useApiKeys(served: boolean) {
  const [status, setStatus] = useState<KeyStatus | null>(null)
  const [failed, setFailed] = useState(false)
  // Every request takes a number; an answer older than the newest one applied is dropped, so a
  // slow refresh cannot put back the state from before a save.
  const seq = useRef(0)
  const applied = useRef(0)
  const apply = (n: number, next: KeyStatus) => {
    if (n < applied.current) return
    applied.current = n
    setStatus(next)
    setFailed(false)
  }

  const refresh = useCallback(async () => {
    if (!served) return
    const n = ++seq.current
    const next = await getApiKeys()
    if (next) apply(n, next)
    else if (n >= applied.current) setFailed(true)
  }, [served])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const save = useCallback(async (name: string, value: string) => {
    const n = ++seq.current
    const r = await saveApiKey(name, value)
    if (r.ok) apply(n, r.keys)
    return r
  }, [])

  return { status, failed, refresh, save }
}
