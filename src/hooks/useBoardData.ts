import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { injectedDump, loadArchivedKeys, loadData, persistArchivedKeys } from '../data'
import { demoDump, fetchDemoDump } from '../demo'
import { getDataDump } from '../lib/runner'

/**
 * The dump the board renders, plus the keys the user moved to Completed by hand. Served mode swaps
 * in a fresh data.json in place; file:// has no server to ask, so it reloads the page for data.js.
 */
export function useBoardData(served: boolean, onError?: (msg: string) => void, demo = false) {
  const [raw, setRaw] = useState(() => (demo ? demoDump() : injectedDump()))
  // Demo mode keeps its own archive set in memory: writing to jb-archived would prune the keys
  // belonging to the user's real board, which is not this mode's to touch.
  const [archived, setArchived] = useState<ReadonlySet<string>>(() => (demo ? new Set() : loadArchivedKeys(injectedDump())))
  const view = useMemo(() => loadData(raw, archived), [raw, archived])

  // Flipping the toggle swaps the whole dump — and the archive set that belongs with it.
  const wasDemo = useRef(demo)
  if (wasDemo.current !== demo) {
    wasDemo.current = demo
    setRaw(demo ? demoDump() : injectedDump())
    setArchived(demo ? new Set() : loadArchivedKeys(injectedDump()))
  }
  // Prefer the folder on disk — editing jira-intern/demo/data.json then reloading is the point of
  // keeping the sample tickets out there. The bundled copy is already on screen meanwhile.
  useEffect(() => {
    if (!demo || !served) return
    let cancelled = false
    void fetchDemoDump().then((d) => {
      if (d && !cancelled) setRaw(d)
    })
    return () => {
      cancelled = true
    }
  }, [demo, served])

  const latestReload = useRef(0)
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  const reload = useCallback(async () => {
    // Jobs finishing close together each reload; only the newest fetch may land, or a slow
    // older response would put stale data back on the board.
    const seq = ++latestReload.current
    if (demo) return // nothing to reload — the sample board is built in the browser
    if (!served) return location.reload()
    const next = await getDataDump()
    if (seq !== latestReload.current) return
    // A failed fetch keeps the copy on screen; reloading the page would throw it away for nothing.
    if (next) setRaw(next)
    else onErrorRef.current?.('Could not load fresh data — showing the last copy.')
  }, [served, demo])

  const updateArchived = useCallback(
    (update: (keys: Set<string>) => void) => {
      setArchived((prev) => {
        const next = new Set(prev)
        update(next)
        if (!demo) persistArchivedKeys(next)
        return next
      })
    },
    [demo],
  )
  const archive = useCallback((key: string) => updateArchived((keys) => keys.add(key)), [updateArchived])
  const restoreArchived = useCallback(() => updateArchived((keys) => keys.clear()), [updateArchived])
  // Demo mode → Reset. The sample dump itself is never changed by a demo session (moves are pins in
  // useTicketMoves), so putting the hand-archived cards back is all this half of a reset needs.
  const resetDemo = useCallback(() => {
    if (demo) setArchived(new Set())
  }, [demo])

  return { ...view, source: demo ? ('demo' as const) : view.source, reload, archive, restoreArchived, resetDemo }
}
