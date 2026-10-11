// Shared resolver for the project-wide config. The tracked root config owns all
// non-secret defaults; a personal file may contain only the fields it overrides.
//
//   node config.mjs get <dot.path>       → print a value ("user.accountId" → ABC1234)
//   node config.mjs shellenv             → eval-able lines for the bash runners
//                                          (AGENT_BIN, AGENT_PROMPT_FLAG, AGENT_EXTRA_ARGS,
//                                           AGENT_MODEL_FLAG, AGENT_SECRETS, AGENT_API_KEY_ENV,
//                                           AGENT_INSTALL_HINT, AGENT_CONNECTOR, MODEL_MAIN,
//                                           TIMEOUT_* …)
//   node config.mjs policy               → the generated MCP POLICY block (allow + read/write)
//   node config.mjs render <prompt.md>   → prompt with {{TOKENS}} substituted, to stdout
//
import { readFileSync, existsSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { homedir } from 'os'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT_CONFIG_PATH = resolve(HERE, '..', '..', 'config', 'jira-board.config.json')
const PROJECT_SCHEMA_PATH = resolve(HERE, '..', '..', 'config', 'jira-board.config.schema.json')
const PERSONAL_CONFIG_PATH = join(homedir(), '.ai', 'config.json')

/** Settings the board writes from its Settings panel. Absent/unreadable → {} (config.json wins). */
function boardSettings() {
  try {
    return JSON.parse(readFileSync(join(HERE, '..', '.settings.json'), 'utf8')) || {}
  } catch {
    return {}
  }
}

/** Optional override path. The project config is always loaded first. */
export function resolveConfigPath() {
  if (process.env.AI_CONFIG_FILE) return process.env.AI_CONFIG_FILE
  if (existsSync(PERSONAL_CONFIG_PATH)) return PERSONAL_CONFIG_PATH
  return null
}

const OVERRIDE_CONFIG_PATH = resolveConfigPath()

function readJson(path, label, required = false) {
  if (!path || !existsSync(path)) {
    if (required) throw new Error(`${label} missing: ${path}`)
    return {}
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    throw new Error(`${label} is invalid JSON (${e.message})`)
  }
}

export function deepMerge(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return base
  const out = { ...base }
  for (const [key, value] of Object.entries(override)) {
    if (key.startsWith('_') || key === '$schema') continue
    const prior = out[key]
    out[key] =
      value && typeof value === 'object' && !Array.isArray(value) && prior && typeof prior === 'object' && !Array.isArray(prior)
        ? deepMerge(prior, value)
        : value
  }
  return out
}

function schemaTypeMatches(value, type) {
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value)
  if (type === 'array') return Array.isArray(value)
  if (type === 'integer') return Number.isInteger(value)
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (type === 'string') return typeof value === 'string'
  if (type === 'boolean') return typeof value === 'boolean'
  if (type === 'null') return value === null
  return true
}

function validateAgainstSchema(value, schema, path = 'config') {
  const errors = []
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : []
  if (types.length && !types.some((type) => schemaTypeMatches(value, type))) return [`${path} has the wrong type`]
  if ('const' in schema && value !== schema.const) errors.push(`${path} must equal ${JSON.stringify(schema.const)}`)
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path} must be one of ${schema.enum.join(', ')}`)
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) errors.push(`${path} must be >= ${schema.minimum}`)
    if (schema.maximum != null && value > schema.maximum) errors.push(`${path} must be <= ${schema.maximum}`)
  }
  if (typeof value === 'string' && schema.minLength != null && value.length < schema.minLength) errors.push(`${path} is too short`)
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) errors.push(`${path} has too few items`)
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) errors.push(`${path} must contain unique items`)
    if (schema.items) value.forEach((item, i) => errors.push(...validateAgainstSchema(item, schema.items, `${path}[${i}]`)))
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required || []) if (!(key in value)) errors.push(`${path}.${key} is required`)
    const properties = schema.properties || {}
    for (const [key, item] of Object.entries(value)) {
      if (properties[key]) errors.push(...validateAgainstSchema(item, properties[key], `${path}.${key}`))
      else if (schema.additionalProperties === false) errors.push(`${path}.${key} is not allowed`)
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object')
        errors.push(...validateAgainstSchema(item, schema.additionalProperties, `${path}.${key}`))
    }
  }
  return errors
}

export function validateConfig(config) {
  const schema = readJson(PROJECT_SCHEMA_PATH, 'project config schema', true)
  return validateAgainstSchema(config, schema)
}

export function loadConfig() {
  const project = readJson(PROJECT_CONFIG_PATH, 'project config', true)
  if (process.env.AI_CONFIG_FILE && !existsSync(process.env.AI_CONFIG_FILE))
    throw new Error(`AI_CONFIG_FILE does not exist: ${process.env.AI_CONFIG_FILE}`)
  const merged = deepMerge(project, readJson(OVERRIDE_CONFIG_PATH, 'personal config'))
  if (String(merged.app?.timeZone || '').toUpperCase() === 'IST') merged.app.timeZone = 'Asia/Kolkata'
  try {
    new Intl.DateTimeFormat('en', { timeZone: merged.app?.timeZone }).format()
  } catch {
    merged.app.timeZone = 'UTC'
  }
  const errors = validateConfig(merged)
  if (errors.length) throw new Error(`configuration invalid:\n- ${errors.join('\n- ')}`)
  return merged
}

export const CONFIG_PATH = OVERRIDE_CONFIG_PATH || PROJECT_CONFIG_PATH
export const cfg = loadConfig()
const DEFAULTS = readJson(PROJECT_CONFIG_PATH, 'project config', true)
const untilde = (p) => (typeof p === 'string' && p.startsWith('~') ? join(homedir(), p.slice(1)) : p)

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)
}

function activeConnector() {
  const name = cfg.connector?.active || 'cursor'
  const c = cfg.connector?.[name]
  if (!c) {
    process.stderr.write(`config.mjs: connector "${name}" not defined in config.json — falling back to cursor defaults\n`)
    return { name: 'cursor', ...DEFAULTS.connector.cursor }
  }
  return { name, ...c }
}

/** Generated MCP allow/deny + read/write policy block, injected into every agent prompt. */
function mcpPolicy() {
  const conn = activeConnector()
  const entries = Object.entries(cfg.mcp || {})
  // A server is usable only when enabled AND at least one of read/write is granted.
  const allowed = entries.filter(([, v]) => v?.enabled && (v.read !== false || v.write === true))
  const denied = entries.filter(([, v]) => !(v?.enabled && (v.read !== false || v.write === true)))
  const lines = []
  lines.push(`MCP POLICY (from config.json — enforced; the "${conn.name}" connector provides these servers):`)
  for (const [name, v] of allowed) {
    const canRead = v.read !== false
    const canWrite = v.write === true
    const rw =
      canRead && canWrite
        ? 'READ + WRITE allowed (create/update/comment permitted when the task requires it)'
        : canWrite
          ? 'WRITE-ONLY: you may create/update when the task requires it, but do NOT query/browse it'
          : 'READ-ONLY: query/fetch freely, but NEVER create, update, delete, transition, comment, or push'
    lines.push(`  • ${name} — ALLOWED, ${rw}.`)
  }
  for (const [name] of denied) lines.push(`  • ${name} — FORBIDDEN: do not call it at all.`)
  lines.push('Any MCP server NOT listed above is FORBIDDEN. Never write anywhere unless its line explicitly allows WRITE.')
  return lines.join('\n')
}

/** {{TOKEN}} substitution map for the prompt files. */
function tokens() {
  return {
    USER_NAME: cfg.user?.name ?? '',
    USER_ID: cfg.user?.accountId ?? '',
    USER_EMAIL: cfg.user?.email ?? '',
    JIRA_BASE: cfg.endpoints?.jiraBase ?? '',
    CONFLUENCE_BASE: cfg.endpoints?.confluenceBase ?? '',
    BITBUCKET_BASE: cfg.endpoints?.bitbucketBase ?? '',
    REQUIRED_APPROVALS: String(cfg.app?.requiredApprovals ?? 2),
    // Machine-derived (not from config) — makes the prompts path-portable automatically.
    INTERN_DIR: resolve(HERE, '..'),
    MCP_POLICY: mcpPolicy(),
  }
}

function render(file) {
  let text = readFileSync(resolve(file), 'utf8')
  const map = tokens()
  // Identity-critical tokens must not be empty — an agent run without them burns a full
  // timed run fetching nothing. Loud warning (lands in the runner's log via stderr).
  const missing = ['USER_NAME', 'USER_ID', 'JIRA_BASE'].filter((k) => !map[k])
  if (missing.length)
    process.stderr.write(`config.mjs: WARNING identity tokens empty (set user/endpoints in the central config or personal override): ${missing.join(', ')}\n`)
  text = text.replace(/\{\{([A-Z_]+)\}\}/g, (m, key) => (key in map ? map[key] : m))
  // Any token we don't know stays literal — flag it so a typo never reaches the agent silently.
  const leftover = [...text.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1])
  if (leftover.length) process.stderr.write(`config.mjs: WARNING unknown tokens left in ${file}: ${[...new Set(leftover)].join(', ')}\n`)
  return text
}

const shq = (s) => `'${String(s ?? '').replace(/'/g, `'\\''`)}'` // single-quote for shell eval

function shellenv() {
  const conn = activeConnector()
  const out = []
  out.push(`AGENT_CONNECTOR=${shq(conn.name)}`)
  out.push(`AGENT_BIN=${shq(conn.bin)}`)
  out.push(`AGENT_BIN_FALLBACKS=${shq((conn.binFallbacks || []).map(untilde).join(':'))}`)
  out.push(`AGENT_PROMPT_FLAG=${shq(conn.promptFlag ?? '-p')}`)
  // NOTE: args are space-joined — individual args must not contain spaces (documented in docs/CONFIG.md).
  out.push(`AGENT_EXTRA_ARGS=${shq((conn.extraArgs || []).join(' '))}`)
  out.push(`AGENT_MODEL_FLAG=${shq(conn.modelFlag ?? '--model')}`)
  out.push(`AGENT_SECRETS=${shq(untilde(conn.secretsFile ?? ''))}`)
  out.push(`AGENT_API_KEY_ENV=${shq(conn.apiKeyEnv ?? '')}`)
  out.push(`AGENT_INSTALL_HINT=${shq(conn.install ?? '')}`)
  out.push(`REQUIRED_APPROVALS=${shq(cfg.app?.requiredApprovals ?? 2)}`)
  out.push(`MODEL_MAIN=${shq(cfg.models?.main ?? 'auto')}`)
  out.push(`TIMEOUT_DAILY=${shq(cfg.timeouts?.dailySec ?? 1800)}`)
  out.push(`TIMEOUT_WEEKLY=${shq(cfg.timeouts?.weeklySec ?? 7200)}`)
  out.push(`TIMEOUT_REFRESH=${shq(cfg.timeouts?.refreshSec ?? 600)}`)
  // PR Readiness Reports (local-runner/pr-report.sh + pr-reports-backfill.sh).
  out.push(`MODEL_REPORT=${shq(cfg.models?.report ?? 'auto')}`)
  out.push(`TIMEOUT_REPORT=${shq(cfg.timeouts?.reportSec ?? 600)}`)
  out.push(`REPORTS_AUTO=${shq(cfg.reports?.autoGenerate === false ? 0 : 1)}`)
  out.push(`REPORTS_YEAR=${shq(cfg.reports?.year ?? 2026)}`)
  out.push(`REPORTS_MAX_PER_RUN=${shq(cfg.reports?.maxPerRun ?? 5)}`)
  // The board's Settings panel writes jira-intern/.settings.json; it overrides config.json so a
  // UI change takes effect without editing (or exposing) the user's personal config file.
  const runtime = boardSettings()
  out.push(`COMPLETED_MAX_FETCH=${shq(cfg.archive?.maxFetch ?? 999)}`)
  out.push(`COMPLETED_WORKERS=${shq(runtime.archiveParallel ?? cfg.archive?.workers ?? 8)}`)
  out.push(`REFRESH_WORKERS=${shq(runtime.refreshParallel ?? cfg.refresh?.workers ?? 8)}`)
  out.push(`REPORTS_AI_LEVEL=${shq(runtime.aiLevel ?? cfg.ai?.level ?? 'moderate')}`)
  out.push(`AI_BACKEND=${shq(runtime.aiBackend ?? cfg.ai?.backend ?? 'local')}`)
  out.push(`AI_LOCAL_MODEL=${shq(runtime.aiLocalModel ?? cfg.ai?.localModel ?? '')}`)
  out.push(`AI_CLOUD_PROVIDER=${shq(runtime.aiCloudProvider ?? cfg.ai?.cloudProvider ?? 'cursor')}`)
  out.push(`AI_CLOUD_MODEL=${shq(runtime.aiCloudModel ?? cfg.ai?.cloudModel ?? '')}`)
  out.push(`AI_CLOUD_EFFORT=${shq(runtime.aiCloudEffort ?? cfg.ai?.cloudEffort ?? 'low')}`)
  out.push(`AI_USE_HOST_OLLAMA=${shq(runtime.aiUseHostOllama ?? cfg.ai?.useHostOllama ? 1 : 0)}`)
  return out.join('\n')
}

function main() {
  const [cmd, arg] = process.argv.slice(2)
  switch (cmd) {
  case 'get': {
    const v = getPath(cfg, arg ?? '')
    if (v === undefined) process.exit(1)
    process.stdout.write(typeof v === 'object' ? JSON.stringify(v) : String(v))
    break
  }
  case 'shellenv':
    process.stdout.write(shellenv() + '\n')
    break
  case 'policy':
    process.stdout.write(mcpPolicy() + '\n')
    break
  case 'render':
    if (!arg) {
      process.stderr.write('usage: node config.mjs render <prompt-file>\n')
      process.exit(2)
    }
    process.stdout.write(render(arg))
    break
  case 'path':
    process.stdout.write(`project: ${PROJECT_CONFIG_PATH}\noverride: ${OVERRIDE_CONFIG_PATH || '(none)'}\n`)
    break
  case 'export':
    process.stdout.write(JSON.stringify(cfg, null, 2) + '\n')
    break
  case 'validate':
    process.stdout.write(`valid: ${PROJECT_CONFIG_PATH}${OVERRIDE_CONFIG_PATH ? ` + ${OVERRIDE_CONFIG_PATH}` : ''}\n`)
    break
  default:
    process.stderr.write('usage: node config.mjs <get <dot.path> | export | validate | shellenv | policy | render <file> | path>\n')
    process.exit(2)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
