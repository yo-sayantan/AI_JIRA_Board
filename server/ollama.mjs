// AI-Ollama lifecycle. The container runs only while BOTH hold:
//
//   1. Settings → "AI-Ollama container" is on            (ollamaEnabled)
//   2. jira-intern/models/ contains a model               (a pulled Ollama model under
//      models/manifests/, or a hand-dropped *.gguf — see jira-intern/models/README.md)
//
// That directory IS Ollama's store (docker-compose.yml binds it to /root/.ollama), so a pull
// from Settings lands there and counts next time. The board drives the container through the
// Docker Engine API on the mounted socket; without the socket every action reports
// 'unavailable' and Ollama simply follows compose.
//
//   node server/ollama.mjs wanted      → prints "yes" / "no" for start-jira-board.sh
import { request } from 'node:http'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { PATHS } from './config.mjs'
import { readBoardSettings } from './settings.mjs'

const SOCK = process.env.DOCKER_SOCK || '/var/run/docker.sock'
const CONTAINER = process.env.OLLAMA_CONTAINER || 'AI-Ollama'
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://ollama:11434'
const STOP_GRACE_S = 10
const READY_WAIT_MS = 45_000
const INSPECT_TTL_MS = 5000

/** Where models must be placed, as the user sees it (host path relative to the repo). */
export const MODELS_DIR_LABEL = 'jira-intern/models/'

// ── models directory ─────────────────────────────────────────────────────────

async function walkManifests(dir, depth = 0) {
  if (depth > 4) return []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const e of entries) {
    if (e.isDirectory()) out.push(...(await walkManifests(join(dir, e.name), depth + 1)))
    else if (depth >= 2) out.push(`${dir.split('/').slice(-1)[0]}:${e.name}`) // library/<name>/<tag>
  }
  return out
}

/** Model names found in jira-intern/models/: Ollama manifests plus loose *.gguf files. */
export async function modelsInDir() {
  const names = await walkManifests(join(PATHS.modelsDir, 'models', 'manifests'))
  try {
    for (const e of await readdir(PATHS.modelsDir, { withFileTypes: true })) {
      if (e.isFile() && /\.gguf$/i.test(e.name)) names.push(e.name)
    }
  } catch {
    /* no directory yet */
  }
  return [...new Set(names)]
}

/** The container toggle, once the AI master switch is taken into account: AI off means the container is off too. */
export function ollamaOn(settings) {
  return !!settings.ollamaEnabled && settings.aiEnabled !== false
}

export async function ollamaWanted(settings) {
  if (!ollamaOn(settings)) return false
  return (await modelsInDir()).length > 0
}

// ── Docker Engine API over the socket ────────────────────────────────────────

function docker(method, path) {
  return new Promise((resolve) => {
    const req = request({ socketPath: SOCK, method, path, timeout: 20_000 }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', () => resolve({ status: 0, body: '' }))
    req.end()
  })
}

const inspectCache = { at: 0, value: null }

/** { available, exists, running } for the Ollama container (cached a few seconds for polling). */
export async function ollamaContainer({ fresh = false } = {}) {
  if (!fresh && inspectCache.value && Date.now() - inspectCache.at < INSPECT_TTL_MS) return inspectCache.value
  const r = await docker('GET', `/containers/${CONTAINER}/json`)
  let value
  if (r.status === 0) value = { available: false, exists: false, running: false }
  else if (r.status === 404) value = { available: true, exists: false, running: false }
  else {
    let running = false
    try {
      running = !!JSON.parse(r.body)?.State?.Running
    } catch {
      /* treat as stopped */
    }
    value = { available: true, exists: r.status === 200, running }
  }
  inspectCache.value = value
  inspectCache.at = Date.now()
  return value
}

let chain = Promise.resolve()
const serial = (fn) => {
  const run = chain.then(fn, fn)
  chain = run.catch(() => {})
  return run
}

/** 'started' | 'running' | 'unavailable' */
export function startOllama() {
  return serial(async () => {
    const c = await ollamaContainer({ fresh: true })
    if (!c.available || !c.exists) return 'unavailable'
    if (c.running) return 'running'
    const r = await docker('POST', `/containers/${CONTAINER}/start`)
    inspectCache.at = 0
    const ok = r.status === 204 || r.status === 304
    console.log(`[ollama] start → ${ok ? 'ok' : `HTTP ${r.status}`}`)
    return ok ? 'started' : 'unavailable'
  })
}

/** 'stopped' | 'idle' | 'unavailable' */
export function stopOllama() {
  return serial(async () => {
    const c = await ollamaContainer({ fresh: true })
    if (!c.available || !c.exists) return 'unavailable'
    if (!c.running) return 'idle'
    const r = await docker('POST', `/containers/${CONTAINER}/stop?t=${STOP_GRACE_S}`)
    inspectCache.at = 0
    const ok = r.status === 204 || r.status === 304
    console.log(`[ollama] stop → ${ok ? 'ok' : `HTTP ${r.status}`}`)
    return ok ? 'stopped' : 'unavailable'
  })
}

async function answering(timeoutMs = 2000) {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) })
    return r.ok
  } catch {
    return false
  }
}

/** Start the container (toggle permitting) and wait until Ollama answers — for a model pull. */
export async function ensureOllamaReady(settings) {
  if (!ollamaOn(settings)) return false
  if ((await startOllama()) === 'unavailable') return false
  const until = Date.now() + READY_WAIT_MS
  while (Date.now() < until) {
    if (await answering()) return true
    await new Promise((r) => setTimeout(r, 1500))
  }
  return false
}

/**
 * Bring the container in line with the toggle and the models directory.
 * Returns 'started' | 'stopped' | 'unchanged' | 'no-models' | 'unavailable'.
 */
export async function reconcileOllama(settings) {
  if (!ollamaOn(settings)) {
    const r = await stopOllama()
    return r === 'stopped' ? 'stopped' : r === 'idle' ? 'unchanged' : 'unavailable'
  }
  if ((await modelsInDir()).length === 0) {
    const r = await stopOllama()
    console.log(`[ollama] not started: ${MODELS_DIR_LABEL} has no model (pull one or drop a .gguf there)`)
    return r === 'unavailable' ? 'unavailable' : 'no-models'
  }
  const r = await startOllama()
  return r === 'started' ? 'started' : r === 'running' ? 'unchanged' : 'unavailable'
}

/** What the board reports about the container, for Settings. */
export async function ollamaInfo(settings) {
  const [container, models] = await Promise.all([ollamaContainer(), modelsInDir()])
  return { enabled: ollamaOn(settings), ...container, modelsDir: MODELS_DIR_LABEL, models }
}

if (process.argv[2] === 'wanted' && process.argv[1]?.endsWith('ollama.mjs')) {
  readBoardSettings()
    .then(ollamaWanted)
    .then((w) => console.log(w ? 'yes' : 'no'), () => console.log('no'))
}
