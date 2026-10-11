// Talks to the optional local server (serve.mjs). On file:// none of this is reachable,
// so callers fall back to a plain reload.
import type { JiraData } from '../types'
import type { MoveTarget } from './columns'
import { summarizeReport, type PrReport, type PrReportSummary } from './reportTypes'
import type { ServerSettings } from './settings'
import type { KeyStatus, KeyTestResult } from './apiKeys'

export const RUN_COMMAND = 'bash jira-intern/local-runner/run-intern.sh'

/** How long any one request to the local server may take before it counts as a miss. */
export const FETCH_TIMEOUT_MS = 8_000

function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms)
  const controller = new AbortController()
  setTimeout(() => controller.abort(), ms)
  return controller.signal
}

/**
 * `fetch` that gives up after `ms`. A stalled local server (asleep laptop, container restarting,
 * a half-open socket) otherwise leaves a request pending for minutes and the board stuck on
 * "busy". An abort rejects like any other network failure, so every caller's `catch → null` path
 * already handles it.
 */
export function fetchWithTimeout(url: string, init: RequestInit = {}, ms = FETCH_TIMEOUT_MS): Promise<Response> {
  return fetch(url, { ...init, signal: init.signal ?? timeoutSignal(ms) })
}

/** True when the board was opened through the local server (http/https), not file://. */
// Demo mode's safety net. The hooks already refuse these actions with a friendly message; this
// makes it impossible for a path anyone forgets to reach Jira, Bitbucket or the AI intern while
// the board is showing invented tickets. Settings (including an AI model pull) still work — those
// configure the machine and are never triggered by a demo ticket.
let demoMode = false
export function setDemoMode(on: boolean): void {
  demoMode = on
}

export function isServed(): boolean {
  return typeof location !== 'undefined' && /^https?:$/.test(location.protocol)
}

/** The help guide's pages (the `help/` folder) the board links to, by topic. */
export const GUIDE_PAGES = {
  start: '00-start-here.html',
  modelFiles: '06-ai-local-models.html#ai-model-files',
  cloudPrices: '07-ai-cloud-models-and-prices.html#ai-cloud-prices',
} as const
export type GuideTopic = keyof typeof GUIDE_PAGES

/**
 * Where a help page lives, from wherever the board was opened.
 *  • served (Docker / `npm run serve`) → `/help/<page>` off the server root.
 *    The Dockerfile copies `help/` into the image so this resolves in the container too.
 *  • file:// (double-clicked `dist/index.html`) → the sibling `../help/<page>`.
 * Deliberately a plain relative path so it works with no server at all — the guide is the
 * thing you reach for WHEN the server is broken. Every page is plain HTML that opens from disk.
 */
export function guideUrl(topic: GuideTopic = 'start'): string {
  return `${isServed() ? '/help/' : '../help/'}${GUIDE_PAGES[topic]}`
}

export interface InternProgress {
  job?: 'daily' | 'archive' | string
  phase?: string
  done?: number
  total?: number
  /** 0–100, derived from done/total. */
  pct?: number
  current?: string | null
  updatedAt?: string
}

export interface InternStatus {
  running: boolean
  /** Which writer is busy: the fast daily fetch, the deep archive rebuild, the raised-by-me
   *  refresh, or a terminal-launched run. */
  job?: 'daily' | 'archive' | 'raised' | 'external' | null
  lastExit: number | null
  lastRunAt: string | null
  dataModified: number | null
  /** Active + queued refresh keys, in FIFO order (active first). */
  refreshingKeys?: string[]
  /** Exit codes for recently finished per-ticket refreshes (key → code). */
  refreshExits?: Record<string, number>
  /** Live ticket-count progress for the button fill (null when idle). */
  progress?: InternProgress | null
  /** Base PR reports being built right now (server queue ∪ cron/terminal runs). */
  reportsGenerating?: string[]
  /** Reports the AI intern has queued or is enriching. */
  reportsEnriching?: string[]
  /** JIRA-AI-Intern health, current job, installed models. */
  ai?: AiInternStatus
}

export interface AiCatalogModel {
  id: string
  label: string
  pull: string
  params: string
  ramGb: number
  level: string
  fits: 'container' | 'host' | string
  why: string
  /** Ollama library page for this tag. */
  ollama?: string
  /** Direct Hugging Face .gguf download (Q4_K_M when available). */
  gguf?: string
  ggufFile?: string
  /** Repo to browse if the GGUF is split across files. */
  ggufPage?: string
}

export interface AiPullProgress {
  model?: string
  status?: string
  completed?: number
  total?: number
  percent?: number
  label?: string
}

export interface AiInternStatus {
  ok?: boolean
  down?: boolean
  state?: string
  current?: { type?: string; key?: string; model?: string } | null
  /** Every job running right now — report jobs run several at a time. */
  active?: { type?: string; key?: string; model?: string }[]
  /** How many report jobs the intern runs at once. */
  parallel?: number
  lastError?: string | null
  backend?: string
  model?: string
  cloudEffort?: string
  useHostOllama?: boolean
  ollamaOk?: boolean
  ollamaError?: string | null
  installedModels?: string[]
  catalog?: { models?: AiCatalogModel[]; defaultLocal?: string; source?: string; hostOnlyRamGb?: number }
  memGb?: number | null
  pulling?: string | null
  /** Live Ollama pull bytes / percent while state is pulling. */
  pullProgress?: AiPullProgress | null
  queuedKeys?: string[]
  queued?: number
  error?: string
  /** The AI-Ollama Docker container, as seen by the board server. */
  container?: OllamaContainerInfo
}

export interface OllamaContainerInfo {
  /** Settings toggle. */
  enabled: boolean
  /** False when the board has no Docker socket — the container then just follows compose. */
  available: boolean
  exists: boolean
  running: boolean
  /** Where models must be placed (host path). */
  modelsDir: string
  /** Models found there: pulled Ollama models and loose .gguf files. */
  models: string[]
}

/** How many enrich-report jobs the AI intern is running right now (queued ones excluded). */
export function enrichJobsRunning(ai: AiInternStatus | null): number {
  const jobs = ai?.active?.length ? ai.active : ai?.current ? [ai.current] : []
  return jobs.filter((job) => job.type === 'enrich-report').length
}

export function aiModelLabel(ai: AiInternStatus | null): string | null {
  if (!ai?.model) return null
  return ai.cloudEffort ? `${ai.model} · ${ai.cloudEffort}` : ai.model
}

// ── PR Readiness Reports ──────────────────────────────────────────────────────
// Served mode talks to /api/reports*. file:// mode reads window.__JIRA_PR_REPORTS__, written by
// local-runner/sync-reports.mjs and injected by the build next to data.js (see tooling/vite.config.ts).

export interface PrReportsIndex {
  reports: Record<string, PrReportSummary>
  generating: string[]
  exits?: Record<string, number>
}

type ReportsGlobal = { __JIRA_PR_REPORTS__?: { reports?: Record<string, PrReport>; generating?: string[] } }

/** Every report on disk, keyed by ticket. Header fields only in served mode; full reports on file://. */
export async function getReportsIndex(): Promise<PrReportsIndex | null> {
  if (!isServed()) {
    const g = (window as unknown as ReportsGlobal).__JIRA_PR_REPORTS__
    if (!g?.reports) return null
    const reports: Record<string, PrReportSummary> = {}
    for (const [k, r] of Object.entries(g.reports)) reports[k] = summarizeReport(r)
    return { reports, generating: g.generating ?? [] }
  }
  try {
    const r = await fetchWithTimeout('/api/reports', { cache: 'no-store' })
    if (!r.ok) return null
    return (await r.json()) as PrReportsIndex
  } catch {
    return null
  }
}

/** One full report, or null when none exists yet. */
export async function getReport(key: string): Promise<PrReport | null> {
  if (!isServed()) {
    return (window as unknown as ReportsGlobal).__JIRA_PR_REPORTS__?.reports?.[key] ?? null
  }
  try {
    const r = await fetchWithTimeout(`/api/reports/${encodeURIComponent(key)}`, { cache: 'no-store' })
    if (!r.ok) return null
    return (await r.json()) as PrReport
  } catch {
    return null
  }
}

export interface ReportStart {
  ok: boolean
  already?: boolean
  queued?: boolean
  pending?: string[]
  /** HTTP 429: the server-side queue is at capacity — try again shortly, nothing is wrong. */
  queueFull?: boolean
}

/** Ask the server to (re)generate one ticket's report in the background (served mode only). */
export async function startReportGeneration(key: string): Promise<ReportStart | null> {
  if (demoMode) return null
  try {
    const r = await fetchWithTimeout(`/api/report?key=${encodeURIComponent(key)}`, { method: 'POST' })
    if (r.status === 429) return { ok: false, queueFull: true }
    if (!r.ok) return null
    return (await r.json()) as ReportStart
  } catch {
    return null
  }
}

/** Push the settings the server-side jobs honour; everything else stays in localStorage. */
export type OllamaAction = 'starting' | 'stopping' | 'no-models' | 'unchanged'

/** Resolves with what the server did to the AI-Ollama container, or null when the save failed. */
export async function saveServerSettings(patch: ServerSettings): Promise<OllamaAction | null> {
  try {
    const r = await fetchWithTimeout('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
    if (!r.ok) return null
    const body = (await r.json().catch(() => null)) as { ollama?: OllamaAction } | null
    return body?.ollama === 'starting' || body?.ollama === 'stopping' || body?.ollama === 'no-models' ? body.ollama : 'unchanged'
  } catch {
    return null
  }
}

/**
 * The API keys in setup/.env, masked (a URL comes back in full). null when the server cannot be
 * reached. Works in demo mode: like Settings, it configures the machine, not a ticket.
 */
export async function getApiKeys(): Promise<KeyStatus | null> {
  try {
    const r = await fetchWithTimeout('/api/keys', { cache: 'no-store' })
    if (!r.ok) return null
    const body = (await r.json()) as { keys?: KeyStatus }
    return body.keys ?? null
  } catch {
    return null
  }
}

export type ApiKeySave = { ok: true; keys: KeyStatus; cleared: string[] } | { ok: false; error: string }

/**
 * Save one key ('' removes it). Resolves with the new masked status — plus any tokens the server
 * cleared because their service's URL changed — or the server's reason.
 */
export async function saveApiKey(name: string, value: string): Promise<ApiKeySave> {
  try {
    const r = await fetchWithTimeout('/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, value }),
    })
    const body = (await r.json().catch(() => null)) as { keys?: KeyStatus; cleared?: string[]; error?: string } | null
    if (r.ok && body?.keys) return { ok: true, keys: body.keys, cleared: body.cleared ?? [] }
    return { ok: false, error: body?.error || `save failed (HTTP ${r.status})` }
  } catch {
    return { ok: false, error: 'the board server did not answer' }
  }
}

/**
 * Test one service's SAVED key: the server makes one authenticated read (server/keycheck.mjs) and
 * answers with what happened. Never rejects — a server that is down, busy or refuses the request
 * comes back as an `error` result with the reason in `detail`.
 */
export async function testApiKey(service: string): Promise<KeyTestResult> {
  const fail = (detail: string): KeyTestResult => ({ ok: false, service, status: 'error', ms: 0, detail })
  try {
    // The server gives the remote host 10 s; leave room for that plus the round trip.
    const r = await fetchWithTimeout(
      '/api/keys/test',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ service }) },
      15_000,
    )
    const body = (await r.json().catch(() => null)) as (Partial<KeyTestResult> & { error?: string }) | null
    if (r.ok && body && typeof body.status === 'string') {
      return { ok: !!body.ok, service, status: body.status, httpStatus: body.httpStatus, ms: Number(body.ms) || 0, detail: String(body.detail ?? '') }
    }
    if (r.status === 409) return fail('A test is already running')
    return fail(body?.error || `test failed (HTTP ${r.status})`)
  } catch {
    return fail('the board server did not answer')
  }
}

/** Which tickets a bulk report run should cover. */
export type ReportScope =
  | { scope: 'all' }
  | { scope: 'year'; year: number }
  | { scope: 'since'; since: string }
  | { scope: 'keys'; keys: string[] }

export interface BulkReportStart {
  ok: boolean
  /** Tickets the scope matched, before anything already queued was skipped. */
  matched: number
  /** Tickets this call actually added to the queue. */
  queuedKeys: string[]
  pending?: string[]
  /** The queue hit capacity before every matched ticket was added; the rest need another pass. */
  full?: boolean
}

/**
 * Queue a whole scope of reports. Every ticket with a pull request is eligible; `force` also
 * rebuilds ones whose stored report still matches the current PR fingerprint.
 */
export async function startBulkReportGeneration(target: ReportScope, force = false): Promise<BulkReportStart | null> {
  if (demoMode) return null
  const q = new URLSearchParams({ scope: target.scope })
  if (target.scope === 'year') q.set('year', String(target.year))
  if (target.scope === 'since') q.set('since', target.since)
  if (target.scope === 'keys') q.set('keys', target.keys.join(','))
  if (force) q.set('force', '1')
  try {
    const r = await fetchWithTimeout(`/api/reports/bulk?${q}`, { method: 'POST' })
    if (!r.ok) return null
    const body = (await r.json()) as { ok?: boolean; matched?: number; queued?: string[]; pending?: string[]; full?: boolean }
    return {
      ok: body.ok !== false,
      matched: body.matched ?? 0,
      queuedKeys: Array.isArray(body.queued) ? body.queued : [],
      pending: body.pending,
      full: body.full === true,
    }
  } catch {
    return null
  }
}

export interface TicketRefreshStart {
  ok: boolean
  already?: boolean
  queued?: boolean
  started?: boolean
  key?: string
  active?: string | null
  position?: number
  pending?: string[]
  /** HTTP 429: the refresh queue is at capacity — try again shortly, nothing is wrong. */
  queueFull?: boolean
}

/** Trigger a targeted background fetch for ONE ticket (served mode only).
 *  Always queues when another refresh is in flight — never drops later clicks. */
export async function startTicketRefresh(key: string): Promise<TicketRefreshStart | null> {
  if (demoMode) return null
  try {
    const r = await fetchWithTimeout(`/api/refresh-ticket?key=${encodeURIComponent(key)}`, { method: 'POST' })
    if (r.status === 429) return { ok: false, queueFull: true }
    if (!r.ok) return null
    return (await r.json()) as TicketRefreshStart
  } catch {
    return null
  }
}

/** USD per 1M tokens: the model's outputUsd in ai-intern/cloud-models.json, else ai-intern/cursor-prices.json. null = no such charge listed. */
export interface CloudPrice {
  input: number | null
  cacheWrite: number | null
  cacheRead: number | null
  output: number | null
}

export interface CloudModelChoice {
  id: string
  label: string
  /** The efforts the dropdown offers for this model, from cloud-models.json (low / medium / high / auto). Empty = no dropdown. */
  efforts?: string[]
  /** Who makes it (the dropdown's groups). */
  provider?: string
  price?: CloudPrice | null
  /** A pricing caveat worth showing (e.g. a surcharge above 100k input tokens). */
  note?: string | null
  /** Costly: output price at or above the file's `costlyOutputUsd`, or the entry's own `costly`. */
  costly?: boolean
  /** Cursor only: false for a model your key's Cursor catalog does not list — Cursor may reject it. */
  inCatalog?: boolean | null
}

/** What the worker made of cloud-models.json for one provider. */
export interface CloudListInfo {
  shown: number
  costly: number
  /** The `costlyOutputUsd` threshold in use. */
  costlyUsd: number
  /** Cursor: listed models your key's catalog does not have. */
  unresolved: string[]
  /** Cursor: how many models your key's catalog holds; null when it could not be read (or not Cursor). */
  catalogTotal: number | null
  /** Rows of cloud-models.json that were skipped, and why. */
  problems: string[]
  pricesChecked?: string | null
}

export interface CloudProviderModels {
  configured: boolean
  models: CloudModelChoice[]
  error?: string | null
  info?: CloudListInfo
}

export async function getCloudModels(): Promise<{
  ok: boolean
  claude?: CloudProviderModels
  cursor?: CloudProviderModels
  gemini?: CloudProviderModels
  error?: string
} | null> {
  try {
    const r = await fetchWithTimeout('/api/cloud-models', { cache: 'no-store' })
    if (!r.ok) return { ok: false, error: `AI intern returned ${r.status}` }
    return (await r.json()) as {
      ok: boolean
      claude?: CloudProviderModels
      cursor?: CloudProviderModels
      gemini?: CloudProviderModels
    }
  } catch {
    return { ok: false, error: 'AI intern unreachable' }
  }
}

export async function getAiModels(): Promise<{
  ok: boolean
  down?: boolean
  catalog?: AiInternStatus['catalog']
  installed?: string[]
  ollamaOk?: boolean
  memGb?: number | null
} | null> {
  try {
    const r = await fetchWithTimeout('/api/ai-models', { cache: 'no-store' })
    if (!r.ok) return { ok: false, down: true }
    return (await r.json()) as { ok: boolean; down?: boolean; catalog?: AiInternStatus['catalog']; installed?: string[] }
  } catch {
    return { ok: false, down: true }
  }
}

export async function pullAiModel(model: string, useHostOllama = false): Promise<boolean> {
  try {
    const r = await fetchWithTimeout('/api/ai-models/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, useHostOllama }),
    })
    if (!r.ok) {
      const text = await r.text().catch(() => '')
      console.error('[jira-ai] pull failed', r.status, text || model)
      return false
    }
    return true
  } catch (e) {
    console.error('[jira-ai] pull failed', model, e)
    return false
  }
}

let lastStatus: { text: string; value: InternStatus } | null = null

/** Unchanged payloads return the previous object, so state setters can bail out of a re-render. */
export async function getInternStatus(): Promise<InternStatus | null> {
  try {
    const r = await fetchWithTimeout('/api/intern-status', { cache: 'no-store' })
    if (!r.ok) return null
    const text = await r.text()
    if (lastStatus?.text !== text) lastStatus = { text, value: JSON.parse(text) as InternStatus }
    return lastStatus.value
  } catch {
    return null
  }
}

/**
 * The raw dump behind data.js. The server sends `Cache-Control: no-store` for /jira-intern/*, so the
 * browser never serves this from cache; `no-cache` here is belt-and-braces for any proxy in between.
 * (The server still answers 304 to a conditional request if one ever arrives.)
 */
export async function getDataDump(): Promise<JiraData | null> {
  if (demoMode) return null
  try {
    const r = await fetchWithTimeout('/jira-intern/data.json', { cache: 'no-cache' }, 20_000)
    if (!r.ok) return null
    const raw = (await r.json()) as JiraData
    return Array.isArray(raw?.tickets) ? raw : null
  } catch {
    return null
  }
}

/** Machine-wide AI choices: central defaults overlaid by jira-intern/.settings.json. */
export async function getServerSettings(): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetchWithTimeout('/api/settings', { cache: 'no-store' })
    if (!r.ok) return null
    const body = (await r.json()) as { settings?: Record<string, unknown> }
    return body.settings ?? null
  } catch {
    return null
  }
}

export interface RunStartResult {
  ok: boolean
  /** HTTP status from the start endpoint (202 started, 409 already running, 0 on network fail). */
  status: number
  /** The started run's lastRunAt stamp, for telling its completion apart from an older run's. */
  runAt?: string
}

async function startRun(path: string): Promise<RunStartResult> {
  if (demoMode) return { ok: false, status: 0 }
  try {
    const r = await fetchWithTimeout(path, { method: 'POST' })
    const body = (await r.json().catch(() => ({}))) as { runAt?: string }
    return { ok: r.ok, status: r.status, runAt: body.runAt }
  } catch {
    return { ok: false, status: 0 }
  }
}

export async function startInternRun(): Promise<RunStartResult> {
  return startRun('/api/run-intern')
}

/** Re-fetch ONLY the raised-by-me list (tickets I reported). One quick JQL search server-side. */
export async function startRaisedRun(): Promise<RunStartResult> {
  return startRun('/api/run-raised')
}

export type ArchiveScope =
  | { scope: 'all' }
  | { scope: 'year'; year: number }
  | { scope: 'since'; since: string }
  | { scope: 'key'; key: string }

/** Kick off the Completed archive rebuild. A scope updates only that slice; all rebuilds the whole archive. */
export async function startArchiveRun(target: ArchiveScope = { scope: 'all' }): Promise<RunStartResult> {
  if (demoMode) return { ok: false, status: 0 }
  const q = new URLSearchParams()
  q.set('scope', target.scope)
  if (target.scope === 'year') q.set('year', String(target.year))
  if (target.scope === 'since') q.set('since', target.since)
  if (target.scope === 'key') q.set('key', target.key)
  return startRun(`/api/run-archive?${q.toString()}`)
}

export async function stopArchiveRun(): Promise<void> {
  await fetchWithTimeout('/api/run-archive/stop', { method: 'POST' }).catch(() => {})
}

export async function stopReportRun(): Promise<void> {
  await fetchWithTimeout('/api/reports/stop', { method: 'POST' }).catch(() => {})
}

/** Any board column, On Hold and QA In Progress included; the server validates against jira-intern/move_targets.json. */
export type { MoveTarget } from './columns'

/**
 * `normal`: every rule applies. `force` (⌥ on drop, or "Move anyway"): skips the PR / QA gates — the
 * cached data may be behind Jira — but never the QA lane. `undo`: puts a ticket back where it was, no checks.
 */
export type MoveMode = 'normal' | 'force' | 'undo'

export interface MoveVerdict {
  ok: boolean
  /** True when Jira actually changed status; false with ok when it was already there. */
  moved?: boolean
  /** The Jira status the ticket landed in. */
  status?: string | null
  /** Soft notes (an open PR parked on hold) — the move still happened. */
  warnings?: string[]
  /** Refused: the QA lane, or a PR / QA gate (In Review with no PR, Done with an open PR or no QA ticket). */
  blocked?: boolean
  reason?: string
  /** The refusal was a PR / QA gate (not the QA lane), so a forced move would go through. */
  forcible?: boolean
  error?: string
}

/** Move a ticket to another column IN JIRA. Resolves when Jira has answered (a few seconds). */
export async function moveTicketInJira(key: string, to: MoveTarget, mode: MoveMode = 'normal'): Promise<MoveVerdict> {
  if (demoMode) return { ok: false, error: 'demo mode is on' }
  try {
    const r = await fetch(`/api/move-ticket?key=${encodeURIComponent(key)}&to=${to}${mode === 'normal' ? '' : `&mode=${mode}`}`, { method: 'POST' })
    const body = (await r.json().catch(() => null)) as MoveVerdict | null
    if (body) return body
    return { ok: false, error: `server answered ${r.status}` }
  } catch {
    return { ok: false, error: 'lost contact with the local server' }
  }
}
