import { writeFile } from 'node:fs/promises'
import { PATHS } from './config.mjs'
import { readJson } from './http.mjs'
import { readBoardSettings } from './settings.mjs'
import { runStatus, startArchive, startDaily } from './jobs.mjs'
import { reportQueue, reportsIndex, resolveReportKeys } from './reports.mjs'

const HOUR = 60 * 60 * 1000
const INTERVALS = {
  off: 0,
  daily: 24 * HOUR,
  'twice-daily': 12 * HOUR,
  weekly: 7 * 24 * HOUR,
  'twice-weekly': 84 * HOUR,
}

function due(last, cadence) {
  const every = INTERVALS[cadence] ?? 0
  if (!every) return false
  const then = Date.parse(last || '')
  return Number.isFinite(then) && Date.now() - then >= every
}

/** Last-run stamps from .schedule.json; a missing, corrupt or non-object file reads as empty. */
async function readState() {
  const state = await readJson(PATHS.schedule, null)
  return state && typeof state === 'object' && !Array.isArray(state) ? state : {}
}

async function writeState(state) {
  await writeFile(PATHS.schedule, JSON.stringify(state, null, 2) + '\n')
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Wait until the daily fetch and archive rebuild are both idle, or give up. */
async function waitIdle(maxMs) {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    if (!(await runStatus()).running) return true
    await sleep(15_000)
  }
  return false
}

async function refreshReports() {
  const withPr = new Set(await resolveReportKeys({ force: true }))
  const stale = await resolveReportKeys({})
  const index = await reportsIndex()
  const keys = new Set(stale.filter((key) => withPr.has(key)))
  for (const report of Object.values(index)) {
    if (!withPr.has(report.key)) continue
    const score = report.verdict?.score
    if (typeof score !== 'number' || score < 100) keys.add(report.key)
  }
  let queued = 0
  for (const key of keys) if (reportQueue.add(key)) queued += 1
  console.log(`[schedule] PR reports: ${queued} queued, ${keys.size - queued} already running`)
}

async function tick() {
  const [settings, state] = await Promise.all([readBoardSettings(), readState()])
  const now = new Date().toISOString()
  // Settings → Features → Background jobs. While it is off nothing is started on a schedule. `pausedAt` is written once
  // per switch-off; on switch-on every last-run stamp restarts from now, so the jobs that fell due meanwhile do not all
  // fire in the same minute (the same reason startScheduler seeds the stamps).
  if (settings.jobsEnabled === false) {
    if (!state.pausedAt) {
      state.pausedAt = now
      await writeState(state)
      console.log('[schedule] background jobs switched off')
    }
    return
  }
  if (state.pausedAt) {
    delete state.pausedAt
    state.activeAt = state.fullAt = state.reportAt = now
    await writeState(state)
    console.log('[schedule] background jobs switched on — schedules restart now')
    return
  }
  if (due(state.fullAt, settings.fullRefresh)) {
    if (await startDaily()) {
      state.fullAt = now
      state.activeAt = now
      await writeState(state)
      console.log('[schedule] full board refresh')
      await waitIdle(3 * HOUR)
      if (!(await startArchive({ ARCHIVE_SCOPE: 'all' }))) console.log('[schedule] archive deferred — another job holds the data')
      else await waitIdle(6 * HOUR)
    }
  } else if (due(state.activeAt, settings.activeRefresh) && (await startDaily())) {
    state.activeAt = now
    await writeState(state)
    console.log('[schedule] active ticket refresh')
  }
  if (due(state.reportAt, settings.reportRefresh) && settings.reportRefresh !== 'off') {
    state.reportAt = now
    await writeState(state)
    await refreshReports()
  }
}

/** Seed last-run times so a container restart does not immediately repeat the boot fetch. */
export async function startScheduler() {
  const state = await readState()
  const now = new Date().toISOString()
  let seeded = false
  for (const key of ['activeAt', 'fullAt', 'reportAt']) {
    if (!state[key]) {
      state[key] = now
      seeded = true
    }
  }
  if (seeded) await writeState(state)
  let running = false
  const run = () => {
    if (running) return
    running = true
    tick()
      .catch((e) => console.error('[schedule]', e))
      .finally(() => {
        running = false
      })
  }
  setInterval(run, 60_000)
  console.log('[schedule] watching Settings for the active, full-board, and PR report jobs')
}
