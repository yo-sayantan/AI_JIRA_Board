import { readFile, rename, writeFile } from 'node:fs/promises'
import { PATHS, PROJECT_CONFIG } from './config.mjs'

// Low · Medium · High · Max. The old "none" is the AI switch being off: still ACCEPTED on write (an older browser tab or a
// hand-edited file), and turned into { aiLevel: 'moderate', aiEnabled: false } on read — see normaliseBoardSettings.
export const AI_LEVELS = ['low', 'moderate', 'high', 'full']
export const CLOUD_PROVIDERS = ['claude', 'cursor', 'gemini']
export const DEFAULT_LOCAL_MODEL = 'qwen2.5-coder:7b'

const ACTIVE_CADENCE = ['off', 'daily', 'twice-daily']
const BOARD_CADENCE = ['off', 'daily', 'weekly', 'twice-weekly']
const oneOf = (values) => (v) => (values.includes(v) ? { value: v } : null)
// Model ids are passed to the AI intern and on to CLIs, so they are limited to tag characters.
const MODEL_RE = /^[\w.:/-]*$/
const model = (max) => (v) => (typeof v === 'string' && v.length <= max && MODEL_RE.test(v) ? { value: v } : null)
const int = (lo, hi) => (v) => (Number.isInteger(v) && v >= lo && v <= hi ? { value: v } : null)
const bool = (v) => ({ value: !!v })

// Only the settings the shell runners and the AI intern read. Presentation stays in localStorage.
const SCHEMA = {
  aiEnabled: bool,
  jobsEnabled: bool,
  aiLevel: oneOf([...AI_LEVELS, 'none']),
  aiBackend: oneOf(['local', 'cloud']),
  aiLocalModel: model(80),
  aiCloudModel: model(128),
  aiCloudProvider: oneOf(CLOUD_PROVIDERS),
  aiCloudEffort: oneOf(['low', 'medium', 'high', 'auto']),
  aiUseHostOllama: bool,
  ollamaEnabled: bool,
  reportParallel: int(1, 10),
  archiveParallel: int(1, 16),
  refreshParallel: int(1, 16),
  activeRefresh: oneOf(ACTIVE_CADENCE),
  fullRefresh: oneOf(BOARD_CADENCE),
  reportRefresh: oneOf(BOARD_CADENCE),
}

async function readSaved() {
  const text = await readFile(PATHS.settings, 'utf8').catch(() => null)
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

/** Central project defaults overlaid by jira-intern/.settings.json. */
export async function readBoardSettings() {
  const ai = PROJECT_CONFIG.ai || {}
  const schedule = PROJECT_CONFIG.schedule || {}
  const pick = (allowed, value, fallback) => (allowed.includes(value) ? value : fallback)
  const defaults = {
    aiEnabled: ai.enabled !== false,
    jobsEnabled: schedule.enabled !== false,
    aiLevel: ai.level || 'moderate',
    aiBackend: ai.backend || 'local',
    aiLocalModel: ai.localModel || '',
    aiCloudModel: ai.cloudModel || '',
    aiCloudProvider: ai.cloudProvider || 'cursor',
    aiCloudEffort: ai.cloudEffort || 'auto',
    aiUseHostOllama: !!ai.useHostOllama,
    ollamaEnabled: ai.ollamaEnabled === true,
    reportParallel: ai.parallel || 4,
    archiveParallel: PROJECT_CONFIG.archive?.workers || 8,
    refreshParallel: PROJECT_CONFIG.refresh?.workers || 8,
    activeRefresh: pick(ACTIVE_CADENCE, schedule.activeRefresh, 'twice-daily'),
    fullRefresh: pick(BOARD_CADENCE, schedule.fullRefresh, 'twice-weekly'),
    reportRefresh: pick(BOARD_CADENCE, schedule.reportRefresh, 'twice-weekly'),
  }
  return normaliseBoardSettings({ ...defaults, ...(await readSaved()) })
}

/** The retired "none" level means AI off; everything downstream then only ever sees a real level. */
export function normaliseBoardSettings(settings) {
  if (settings.aiLevel !== 'none') return settings
  return { ...settings, aiLevel: 'moderate', aiEnabled: false }
}

let pending = Promise.resolve()

/**
 * Validate and persist a partial update. Written to jira-intern/.settings.json rather than the
 * config, which may resolve to the user's personal ~/.ai/config.json.
 */
export function updateBoardSettings(patch) {
  // One read-modify-write at a time: overlapping saves would each start from the same file and
  // the slower one would undo the other.
  const run = pending.then(() => applyPatch(patch))
  pending = run.catch(() => {})
  return run
}

async function applyPatch(patch) {
  const next = await readSaved()
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (!Object.hasOwn(SCHEMA, key) || value === undefined) continue
    const check = SCHEMA[key]
    const ok = check(value)
    if (!ok) return { error: `bad ${key}` }
    next[key] = ok.value
  }
  // Temp file + rename, so the scheduler and the runners never read a half-written file.
  const tmp = `${PATHS.settings}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(next, null, 2) + '\n')
  await rename(tmp, PATHS.settings)
  return { settings: next }
}
