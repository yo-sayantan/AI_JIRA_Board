import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { KEY_RE, PATHS, ROOT } from './config.mjs'
import { readJson } from './http.mjs'
import { dataWriterBusy } from './jobs.mjs'
import { KeyQueue, runProcess } from './queue.mjs'
import { readBoardSettings } from './settings.mjs'
import { dropQueuedEnrichJobs, enqueueEnrich } from './ai.mjs'

// A registration older than this is a crashed generation, not a slow one.
const EXTERNAL_MAX_AGE_MS = 25 * 60 * 1000

let baseChild = null
let cancelled = false

/** Build the deterministic base, then hand the ticket to the AI intern unless AI is off. */
async function generate(key) {
  cancelled = false
  const code = await runProcess('python3', [PATHS.reportPy, 'base', key], { onSpawn: (c) => (baseChild = c) })
  baseChild = null
  if (code === 0 && !cancelled) {
    const settings = await readBoardSettings()
    // Settings → Features → AI off: the deterministic report stands alone, nothing is handed to the intern.
    if (settings.aiEnabled !== false) {
      await enqueueEnrich(key, settings).catch((e) => console.error('enqueue enrich failed', e))
    }
  }
  cancelled = false
  return code
}

// Reports write only reports/, but they read data.json, so they wait for its writers. A bulk or
// scheduled run can legitimately queue a whole year of tickets, hence the larger ceiling.
export const reportQueue = new KeyQueue({ run: generate, isBlocked: dataWriterBusy, max: 500 })

export async function stopReports() {
  reportQueue.clear()
  if (baseChild) {
    cancelled = true
    baseChild.kill('SIGTERM')
  }
  // reports/.status.json is not touched: only terminal and cron runs register there, and a row
  // whose process has gone is already ignored by externalGenerating().
  await Promise.all([writeFile(PATHS.aiCancelReport, '1').catch(() => {}), dropQueuedEnrichJobs().catch(() => {})])
}

/**
 * Which tickets a bulk run should cover. pr_report.py owns that rule (PR present, fingerprint
 * stale), so we ask it. Spawned with an argument array over pre-validated values, never a shell.
 */
export function resolveReportKeys({ year, since, keys, force }) {
  const args = [PATHS.reportPy, 'needs-report']
  if (year) args.push('--year', String(year))
  if (since) args.push('--since', since)
  if (keys) args.push('--keys', keys.join(','))
  if (force) args.push('--force')
  return new Promise((resolve) => {
    let out = ''
    try {
      const child = spawn('python3', args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      child.stdout.on('data', (d) => (out += d))
      child.on('error', () => resolve([]))
      child.on('close', () =>
        resolve(
          out
            .split('\n')
            .map((s) => s.trim().toUpperCase())
            .filter((s) => KEY_RE.test(s)),
        ),
      )
    } catch {
      resolve([])
    }
  })
}

/** Keys another process (cron backfill, terminal) is generating, from reports/.status.json. */
export async function externalGenerating() {
  const st = await readJson(PATHS.reportsStatus, null)
  const generating = st?.generating
  if (!generating || typeof generating !== 'object' || Array.isArray(generating)) return []
  const out = []
  for (const [key, v] of Object.entries(generating)) {
    if (!KEY_RE.test(key)) continue
    const pid = Number(v?.pid)
    // pid 1 is a container's init, never the report itself, so those rows would never expire.
    if (!Number.isInteger(pid) || pid <= 1) continue
    const started = Date.parse(v?.startedAt || '')
    if (Number.isFinite(started) && Date.now() - started > EXTERNAL_MAX_AGE_MS) continue
    try {
      process.kill(pid, 0)
      out.push(key)
    } catch (e) {
      if (e.code !== 'ESRCH') out.push(key)
    }
  }
  return out
}

function summarize(r) {
  return {
    key: r.key,
    title: r.title ?? null,
    timeZone: r.timeZone ?? null,
    generatedAt: r.generatedAt ?? null,
    enrichedAt: r.enrichedAt ?? null,
    enriched: !!r.enriched,
    fingerprint: r.fingerprint ?? null,
    verdict: r.verdict ?? null,
  }
}

// file name → { mtimeMs, size, summary }. Reports are rewritten rarely but listed on every
// status change, so only files whose stat changed are re-parsed.
const summaries = new Map()

/** Header-only index of every report on disk. */
export async function reportsIndex() {
  let names
  try {
    names = (await readdir(PATHS.reportsDir)).filter((n) => n.endsWith('.json') && !n.startsWith('.'))
  } catch {
    summaries.clear()
    return {}
  }
  const live = new Set(names)
  for (const name of summaries.keys()) if (!live.has(name)) summaries.delete(name)

  await Promise.all(
    names.map(async (name) => {
      const path = join(PATHS.reportsDir, name)
      try {
        const st = await stat(path)
        const hit = summaries.get(name)
        if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return
        const r = JSON.parse(await readFile(path, 'utf8'))
        summaries.set(name, { mtimeMs: st.mtimeMs, size: st.size, summary: typeof r?.key === 'string' ? summarize(r) : null })
      } catch {
        summaries.delete(name)
      }
    }),
  )

  const out = {}
  for (const { summary } of summaries.values()) if (summary) out[summary.key] = summary
  return out
}

export function readReport(key) {
  return readFile(join(PATHS.reportsDir, `${key}.json`))
}
