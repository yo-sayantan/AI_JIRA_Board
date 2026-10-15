import { useCallback, useEffect, useRef, useState } from 'react'
import type { RunProgress } from '../components/header/Header'
import { pollNow, subscribeStatus } from '../lib/statusPoller'
import {
  startArchiveRun,
  startInternRun,
  startRaisedRun,
  startTicketRefresh,
  stopArchiveRun,
  type ArchiveScope,
  type InternStatus,
  type RunStartResult,
} from '../lib/runner'
import { DEMO_REFUSED } from '../demo'
import type { DismissFn, ToastFn } from './useToasts'

export type RunJob = 'daily' | 'archive' | 'raised'

// Each ceiling must exceed the runner's own timeout, or the board gives up on a live run.
const CEILING_MS: Record<RunJob, number> = { daily: 32 * 60_000, archive: 130 * 60_000, raised: 6 * 60_000 }
const RUN_POLL_MS = 800
const TICKET_POLL_MS = 1500
const TICKET_CEILING_MS = 11 * 60_000
const TICKET_QUEUE_STEP_MS = 5 * 60_000

function progressOf(s: InternStatus, prev: RunProgress | null): RunProgress | null {
  const p = s.progress
  if (p && typeof p.total === 'number' && p.total > 0) {
    const done = Number(p.done) || 0
    return { done, total: p.total, pct: typeof p.pct === 'number' ? p.pct : Math.round((100 * done) / p.total), current: p.current ?? null, phase: p.phase }
  }
  return s.running ? (prev ?? { done: 0, total: 0, pct: 0, phase: p?.phase || 'starting' }) : prev
}

function exitMessage(code: number): string {
  if (code === 2) return 'Intern could not run — no Jira token yet. Add it with the key button in the header.'
  if (code === 3) return 'Skipped — another refresh/archive was already running. Try again in a moment.'
  if (code === 127) return 'Intern finished with errors (tooling missing) — check logs/.'
  return 'Intern finished with errors — check logs/.'
}

function archiveLabel(target: ArchiveScope): string {
  if (target.scope === 'key') return target.key
  if (target.scope === 'year') return String(target.year)
  if (target.scope === 'since') return `since ${target.since}`
  return 'the full archive'
}

/**
 * The intern's data-writing jobs: the quick board refresh, the Completed archive rebuild, and
 * per-ticket refreshes. Every watcher rides the shared status poller; fresh data is swapped in
 * with `reload` instead of reloading the page.
 */
export function useInternJobs({
  served,
  toast,
  dismiss,
  reload,
  demo = false,
}: {
  served: boolean
  toast: ToastFn
  dismiss: DismissFn
  reload: () => Promise<void>
  /** Demo mode: every job is refused — the sample board has nothing to fetch. */
  demo?: boolean
}) {
  const [running, setRunning] = useState<RunJob | null>(null)
  const [progress, setProgress] = useState<RunProgress | null>(null)
  const [refreshingKeys, setRefreshingKeys] = useState<ReadonlySet<string>>(new Set())
  const runningRef = useRef(running)
  runningRef.current = running
  const refreshingKeysRef = useRef(refreshingKeys)
  refreshingKeysRef.current = refreshingKeys
  const runWatch = useRef<{ stop: () => void; toastId: number } | null>(null)

  const endRun = useCallback(() => {
    if (runWatch.current) {
      runWatch.current.stop()
      dismiss(runWatch.current.toastId)
      runWatch.current = null
    }
    setRunning(null)
    setProgress(null)
  }, [dismiss])

  /** Follow a run until it stops. `runAt` pins it to one run, so an older run's exit never counts. */
  const watchRun = useCallback(
    (job: RunJob, before: number | null, toastId: number, runAt: string | null) => {
      if (runWatch.current) {
        runWatch.current.stop()
        if (runWatch.current.toastId !== toastId) dismiss(runWatch.current.toastId)
      }
      setRunning(job)
      const startedAt = Date.now()
      let sawRunning = false
      let misses = 0
      const stop = subscribeStatus((s) => {
        if (s) misses = 0
        else if (++misses >= 4) {
          endRun()
          return void toast('Lost contact with the local server.', 'error')
        }
        if (s?.running) sawRunning = true
        if (s) setProgress((prev) => progressOf(s, prev))
        const timedOut = Date.now() - startedAt > CEILING_MS[job]
        // A run pinned by its own stamp is over once it has an exit code, even when it ended
        // between two polls and no poll ever saw it running (e.g. refused because a lock was held).
        const finished = runAt
          ? s?.lastRunAt === runAt && (s.lastExit != null || (sawRunning && s.dataModified !== before))
          : sawRunning && (s?.dataModified !== before || s?.lastExit != null)
        const done = s && !s.running && finished
        if (done) {
          endRun()
          if (s.lastExit != null && s.lastExit !== 0) return void toast(exitMessage(s.lastExit), 'error')
          toast('Fresh data in.', 'success')
          void reload()
        } else if (timedOut) {
          endRun()
          toast('Intern is taking unusually long — reload manually when it finishes.', 'info')
        }
      }, RUN_POLL_MS)
      runWatch.current = { stop, toastId }
    },
    [dismiss, endRun, reload, toast],
  )

  /** Start a job; on 409 attach to the run already in flight, retrying once if its lock just cleared. */
  const begin = useCallback(
    async (job: RunJob, start: () => Promise<RunStartResult>, toastId: number, msgs: { already: string; fail: string }) => {
      setRunning(job)
      const before = (await pollNow())?.dataModified ?? null
      let result = await start()
      for (let attempt = 0; !result.ok; attempt++) {
        const s = await pollNow()
        if (s?.running) {
          toast(msgs.already, 'info')
          return watchRun(job, before, toastId, s.lastRunAt)
        }
        if (attempt > 0 || result.status !== 409) {
          dismiss(toastId)
          setRunning(null)
          return void toast(msgs.fail, 'error')
        }
        await new Promise((r) => setTimeout(r, 350))
        result = await start()
      }
      watchRun(job, before, toastId, result.runAt ?? null)
    },
    [dismiss, toast, watchRun],
  )

  const refreshBoard = useCallback(async () => {
    if (runningRef.current) return
    if (demo) return void toast(DEMO_REFUSED, 'info')
    if (!served) {
      toast('Reloading the latest dump…', 'loading')
      setTimeout(() => location.reload(), 350)
      return
    }
    const id = toast('Refreshing the board. Fetching your active tickets…', 'loading')
    await begin('daily', startInternRun, id, { already: 'Intern already running — watching it.', fail: 'Could not start the intern run.' })
  }, [served, demo, toast, begin])

  const rebuildArchive = useCallback(
    async (target: ArchiveScope = { scope: 'all' }) => {
      if (runningRef.current) return
      if (demo) return void toast(DEMO_REFUSED, 'info')
      if (!served) return void toast('The archive rebuild needs the local server — run `npm run serve`.', 'info')
      const id = toast(`Rebuilding Completed — ${archiveLabel(target)}…`, 'loading')
      await begin('archive', () => startArchiveRun(target), id, {
        already: 'Another intern job is running — watching it.',
        fail: 'Could not start the archive rebuild.',
      })
    },
    [served, demo, toast, begin],
  )

  const stopArchive = useCallback(async () => {
    await stopArchiveRun()
    endRun()
    toast('Stopped the archive rebuild.', 'info')
  }, [endRun, toast])

  // The Raised view's own refresh: tickets I reported but don't work are invisible to the
  // normal board refresh, so this is the one pull that keeps that list current.
  const refreshRaised = useCallback(async () => {
    if (runningRef.current) return
    if (demo) return void toast(DEMO_REFUSED, 'info')
    if (!served) return void toast('Refreshing raised tickets needs the local server — run `npm run serve`.', 'info')
    const id = toast('Refreshing the tickets you raised…', 'loading')
    await begin('raised', startRaisedRun, id, {
      already: 'Another intern job is running — watching it.',
      fail: 'Could not start the raised-tickets refresh.',
    })
  }, [served, demo, toast, begin])

  const dropRefreshingKey = useCallback((key: string) => {
    setRefreshingKeys((prev) => {
      const next = new Set(prev)
      next.delete(key)
      return next
    })
  }, [])

  // Every click queues FIFO on the server; each key is watched until IT leaves the pending list.
  // `quiet` (the refresh a drag-and-drop move queues): no progress or success toasts — they would crowd out the move's own
  // Undo notification — but a failure still says so. The card's own refresh button keeps every toast.
  const refreshTicket = useCallback(
    async (key: string, opts: { quiet?: boolean } = {}) => {
      const quiet = !!opts.quiet
      if (demo) return void toast(DEMO_REFUSED, 'info')
      if (!served) return void toast('Single-ticket refresh needs the local server — run `npm run serve`.', 'info')
      if (refreshingKeysRef.current.has(key)) return void (quiet ? undefined : toast(`${key} is already queued.`, 'info'))
      setRefreshingKeys((prev) => new Set(prev).add(key))
      const toastId = quiet ? -1 : toast(`Fetching latest status for ${key}…`, 'loading')
      const finish = (msg: string, kind: 'info' | 'success' | 'error') => {
        if (toastId >= 0) dismiss(toastId)
        dropRefreshingKey(key)
        if (!quiet || kind === 'error') toast(msg, kind)
      }

      const start = await startTicketRefresh(key)
      if (start?.queueFull) return finish('The refresh queue is full — try again in a moment.', 'info')
      if (!start?.ok) return finish(`Couldn't start refresh for ${key}.`, 'error')
      const position = start.position ?? 0
      if (!quiet && start.already) toast(`${key} is already in the refresh queue.`, 'info')
      else if (!quiet && position > 0) toast(`${key} queued (#${position + 1}) — will run next.`, 'info')

      const startedAt = Date.now()
      const ceiling = TICKET_CEILING_MS + Math.max(0, position) * TICKET_QUEUE_STEP_MS
      let misses = 0
      const stop = subscribeStatus((s) => {
        if (!s) {
          if (++misses < 4) return
          stop()
          return finish('Lost contact with the local server.', 'error')
        }
        misses = 0
        const exit = s.refreshExits?.[key]
        const pending = s.refreshingKeys?.includes(key)
        const timedOut = Date.now() - startedAt > ceiling
        if ((pending || typeof exit !== 'number') && !timedOut) return
        stop()
        if (exit === 0 && !pending) {
          finish(`${key} updated.`, 'success')
          return void reload()
        }
        finish(typeof exit === 'number' && exit !== 0 ? `${key} refresh failed (exit ${exit}).` : `${key} refresh timed out.`, 'error')
      }, TICKET_POLL_MS)
    },
    [served, demo, toast, dismiss, dropRefreshingKey, reload],
  )

  // A run started from a terminal, cron or another tab: attach to it instead of looking idle.
  useEffect(() => {
    if (!served || demo) return
    void pollNow().then((s) => {
      if (!s?.running || runningRef.current) return
      const job: RunJob = s.job === 'archive' ? 'archive' : s.job === 'raised' ? 'raised' : 'daily'
      const id = toast('JIRA Intern Agent is running… the board updates when it finishes.', 'loading')
      watchRun(job, s.dataModified ?? null, id, s.lastRunAt)
    })
  }, [served, demo, toast, watchRun])

  useEffect(() => () => runWatch.current?.stop(), [])

  return { running, progress, refreshingKeys, refreshBoard, rebuildArchive, stopArchive, refreshTicket, refreshRaised }
}
