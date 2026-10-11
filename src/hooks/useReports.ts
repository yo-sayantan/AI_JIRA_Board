import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PrReport } from '../lib/reportTypes'
import { pollNow } from '../lib/statusPoller'
import {
  getReport,
  getReportsIndex,
  startBulkReportGeneration,
  startReportGeneration,
  stopReportRun,
  type InternStatus,
  type PrReportsIndex,
  type ReportScope,
} from '../lib/runner'
import { DEMO_REFUSED, demoReports } from '../demo'
import { reportFailureSummary } from '../lib/reportFailure'
import type { ToastFn } from './useToasts'

const EMPTY: ReadonlySet<string> = new Set()

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many.replace('#', String(n)))

function sameKeys(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((k) => b.has(k))
}

/**
 * PR Readiness Reports. Which keys are generating comes from the shared intern status; the index
 * of reports on disk is fetched once and again only when a report finishes or its AI pass lands.
 */
export function useReports({
  served,
  enabled,
  status,
  toast,
  demo = false,
}: {
  served: boolean
  enabled: boolean
  status: InternStatus | null
  toast: ToastFn
  /** Demo mode: serve the two canned sample reports; never generate anything. */
  demo?: boolean
}) {
  const [index, setIndex] = useState<PrReportsIndex | null>(null)
  const [generating, setGenerating] = useState<ReadonlySet<string>>(EMPTY)
  const [enriching, setEnriching] = useState<ReadonlySet<string>>(EMPTY)
  const [openReport, setOpenReport] = useState<PrReport | null>(null)
  const [loadingKey, setLoadingKey] = useState<string | null>(null)
  const openKey = useRef<string | null>(null)
  openKey.current = openReport?.key ?? null
  const seen = useRef({ generating: EMPTY, enriching: EMPTY })
  // Keys started from this tab were already announced by the click that queued them.
  const announced = useRef(new Set<string>())

  const refreshIndex = useCallback(async () => {
    if (demo) {
      const next: PrReportsIndex = { reports: demoReports().summaries, generating: [] }
      setIndex(next)
      return next
    }
    const next = await getReportsIndex()
    if (next) setIndex(next)
    const key = openKey.current
    if (key) void getReport(key).then((r) => r && openKey.current === key && setOpenReport(r))
    return next
  }, [demo])

  useEffect(() => {
    if (!enabled) return
    void refreshIndex().then((idx) => !served && idx && setGenerating(new Set(idx.generating)))
  }, [enabled, served, refreshIndex])

  useEffect(() => {
    if (!enabled || !status || demo) return
    const prev = seen.current
    const nextGenerating = new Set(status.reportsGenerating ?? [])
    const nextEnriching = new Set(status.reportsEnriching ?? [])
    const enrichedDone = [...prev.enriching].some((k) => !nextEnriching.has(k))
    seen.current = { generating: nextGenerating, enriching: nextEnriching }
    // Queued AI passes of an intern that is down are not progress — nothing will run them (same rule as the poller).
    const live = status.ai?.down ? EMPTY : nextEnriching
    setEnriching((cur) => (sameKeys(cur, live) ? cur : live))
    if (sameKeys(prev.generating, nextGenerating)) {
      if (enrichedDone) void refreshIndex()
      return
    }
    setGenerating(nextGenerating)

    const started = [...nextGenerating].filter((k) => !prev.generating.has(k) && !announced.current.delete(k))
    const finished = [...prev.generating].filter((k) => !nextGenerating.has(k))
    if (started.length) toast(plural(started.length, `Generating PR readiness report for ${started[0]}…`, 'Generating # PR readiness reports…'), 'loading')
    if (!finished.length && !enrichedDone) return
    void refreshIndex().then((idx) => {
      const ready = finished.filter((k) => idx?.reports?.[k])
      const failed = finished.filter((k) => !idx?.reports?.[k])
      if (ready.length) toast(plural(ready.length, `PR readiness report ready for ${ready[0]}.`, '# PR readiness reports ready.'), 'success')
      if (failed.length) toast(reportFailureSummary(failed, idx?.exits), 'error')
    })
  }, [enabled, status, refreshIndex, toast])

  const openReportFor = useCallback(
    async (key: string) => {
      if (demo) {
        const r = demoReports().reports[key]
        if (r) setOpenReport(r)
        else toast(`No sample report for ${key} — try DEMO-230 or DEMO-210.`, 'info')
        return
      }
      setLoadingKey(key)
      const r = await getReport(key)
      setLoadingKey(null)
      if (r) setOpenReport(r)
      else toast(`No PR readiness report for ${key} yet.`, 'info')
    },
    [demo, toast],
  )
  const closeReport = useCallback(() => setOpenReport(null), [])

  const generateOne = useCallback(
    async (key: string) => {
      if (demo) return void toast(DEMO_REFUSED, 'info')
      if (!served) return void toast(`Report generation needs the server or Docker — run: bash jira-intern/local-runner/pr-report.sh ${key}`, 'info')
      const start = await startReportGeneration(key)
      if (start?.queueFull) return void toast('The report queue is full — try again shortly.', 'info')
      if (!start?.ok) return void toast(`Couldn't start the report for ${key} — is the server running?`, 'error')
      announced.current.add(key)
      toast(start.already ? `${key} report is already being generated.` : `Generating PR readiness report for ${key} — running in the background.`, 'loading')
      void pollNow()
    },
    [served, demo, toast],
  )

  const generateBulk = useCallback(
    async (target: ReportScope, force: boolean) => {
      if (demo) return void toast(DEMO_REFUSED, 'info')
      if (!served) return void toast('Bulk generation needs the server or Docker — run: bash jira-intern/local-runner/pr-reports-backfill.sh --all-years', 'info')
      const start = await startBulkReportGeneration(target, force)
      if (!start?.ok) return void toast("Couldn't start the report run — is the server running?", 'error')
      if (start.queuedKeys.length === 0) {
        return void toast(
          start.matched === 0 ? 'No tickets with a pull request matched that scope.' : 'Every matching report is already current or queued — tick "Force rebuild" to redo them.',
          'info',
        )
      }
      for (const k of start.queuedKeys) announced.current.add(k)
      const queued = plural(start.queuedKeys.length, 'one PR readiness report', '# PR readiness reports')
      if (start.full) toast(`Queued ${queued}; the queue is full, run again for the rest.`, 'info')
      else toast(`Queued ${queued} — they generate in the background.`, 'loading')
      void pollNow()
    },
    [served, demo, toast],
  )

  const stopAll = useCallback(async () => {
    if (demo) return void toast(DEMO_REFUSED, 'info')
    await stopReportRun()
    toast('Stopped report generation.', 'info')
    void pollNow()
  }, [demo, toast])

  // Everything still being worked on, base report OR AI pass. The base report is quick and the server's own
  // "generating" list empties as soon as the last one is built — the AI pass that follows is the slow part,
  // and a progress bar that only watched the first half read "done" while the intern was still running.
  const working = useMemo<ReadonlySet<string>>(() => (enriching.size === 0 ? generating : new Set([...generating, ...enriching])), [generating, enriching])

  return { index, generating, working, openReport, loadingKey, openReportFor, closeReport, generateOne, generateBulk, stopAll }
}
