// The board's API keys: setup/.env, edited from the board's API keys dialog.
//
// Which keys exist (and why) is setup/api-keys.json. Only those names can be written; any other
// line already in the file — comments, JIRA_CA_BUNDLE, a key some other tool reads — is kept as
// it is. The file is parsed exactly like jira-intern/_config.py load_secrets() and
// runner-env.sh export_secrets_from_file(): KEY=VALUE, literal values, nothing is executed.
//
// Values never leave this module in full: status() returns masked secrets, and the registry's
// `url` / `email` / `text` fields as they are. Saving one key never touches another: a
// token is only removed when the user removes it.
import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { open, readFile, rename, unlink } from 'node:fs/promises'

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
/** A registry field's kind: secret (masked — the default), url, email or text (shown in full). */
export const kindOf = (field) => field?.kind || 'secret'
const PRINTABLE = /^[\x21-\x7e]+$/
const EMAIL = /^[\x21-\x3f\x41-\x7e]+@[\x21-\x3f\x41-\x7e]+\.[\x21-\x3f\x41-\x7e]+$/
const MAX_VALUE = 4096
const BULLETS = '••••••••'

/** Every key field in the registry, flattened, with its service id. */
export function registryKeys(registry) {
  return (registry?.services || []).flatMap((s) => (s.keys || []).map((k) => ({ ...k, service: s.id })))
}

/** One line → [key, value], or null for blanks, comments and anything that is not KEY=VALUE. */
function parseLine(raw) {
  const line = raw.replace(/\r$/, '').trim()
  if (!line || line.startsWith('#') || !line.includes('=')) return null
  const at = line.indexOf('=')
  let key = line.slice(0, at).trim()
  if (/^export\s+/.test(key)) key = key.replace(/^export\s+/, '')
  if (!NAME_RE.test(key)) return null
  let value = line.slice(at + 1).trim()
  if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1)
  return [key, value]
}

/** KEY=VALUE text → { KEY: value }; the last assignment of a key wins. */
export function parseEnv(text) {
  const out = Object.create(null)
  for (const raw of String(text || '').split('\n')) {
    const kv = parseLine(raw)
    if (kv) out[kv[0]] = kv[1]
  }
  return out
}

/** Set `key` to `value` (empty → remove it), keeping every other line. Duplicates collapse. */
export function upsertEnv(text, key, value) {
  const lines = String(text || '').split('\n')
  if (lines.at(-1) === '') lines.pop()
  const out = []
  let placed = false
  for (const raw of lines) {
    const kv = parseLine(raw)
    if (kv && kv[0] === key) {
      if (!placed && value) out.push(`${key}=${value}`)
      placed = true
      continue
    }
    out.push(raw)
  }
  if (!placed && value) out.push(`${key}=${value}`)
  return out.length ? out.join('\n') + '\n' : ''
}

/** First and last four characters of a long value, else bullets only; the length stays private. */
export function maskValue(value) {
  const v = String(value || '')
  return v.length >= 16 ? `${v.slice(0, 4)}${BULLETS}${v.slice(-4)}` : BULLETS
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** A base URL a token may be sent to: https (http only on this machine), no credentials/query/fragment. */
function urlError(value) {
  let u
  try {
    u = new URL(value)
  } catch {
    return 'must be a URL like https://jira.example.com'
  }
  if (/\s/.test(value)) return 'must not contain spaces'
  const local = LOOPBACK_HOSTS.has(u.hostname) || u.hostname.endsWith('.localhost')
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return 'must start with https://'
  if (u.username || u.password) return 'must not contain a user name or password'
  if (u.search || u.hash || value.includes('?') || value.includes('#')) return 'must not contain ? or #'
  return null
}

/** { value } (trimmed; '' means remove) or { error }. */
export function validateValue(field, raw) {
  if (typeof raw !== 'string') return { error: 'value must be a string' }
  const value = raw.trim()
  if (!value) return { value: '' }
  if (value.length > MAX_VALUE) return { error: 'value too long' }
  // One line, always: a newline would let a value plant a second KEY=VALUE.
  if (/[\r\n\0]/.test(value)) return { error: 'value must be a single line' }
  if (/^["']|["']$/.test(value)) return { error: 'remove the surrounding quotes' }
  const kind = kindOf(field)
  if (kind === 'url') {
    const error = urlError(value)
    return error ? { error } : { value }
  }
  if (kind === 'email') return EMAIL.test(value) ? { value } : { error: 'must be an email address' }
  if (kind === 'text') return PRINTABLE.test(value) ? { value } : { error: 'one word — letters, digits and symbols, no spaces' }
  // Tokens are printable ASCII. This also refuses a mask sent back as a key, and the unicode and
  // control characters that Python's strip() would trim but bash and JS keep.
  if (!PRINTABLE.test(value)) return { error: 'paste the key exactly — letters, digits and symbols only, no spaces' }
  return { value }
}

/** `registry` is the parsed setup/api-keys.json. Keep ONE store per file: the write queue lives in it. */
export function createSecretsStore({ file, registry }) {
  const fields = new Map(registryKeys(registry).map((k) => [k.env, k]))
  const read = () => readFile(file, 'utf8').catch((e) => (e.code === 'ENOENT' ? '' : Promise.reject(e)))

  async function status() {
    const env = parseEnv(await read())
    const out = {}
    for (const [name, field] of fields) {
      const value = env[name] || ''
      out[name] = { set: !!value, masked: value ? (kindOf(field) === 'secret' ? maskValue(value) : value) : '' }
    }
    return out
  }

  // One read-modify-write at a time, or two quick saves would each start from the same file.
  let pending = Promise.resolve()
  async function apply(name, raw) {
    const field = fields.get(name)
    if (!field) return { error: `unknown key ${String(name).slice(0, 64)}` }
    const checked = validateValue(field, raw)
    if (checked.error) return { error: checked.error }
    const before = await read()
    // Only the named key changes — nothing else is ever removed on the user's behalf.
    await writeAtomic(upsertEnv(before, name, checked.value))
    return { status: await status() }
  }

  // Random name, exclusive create, never through a symlink, owner-only from the first byte; synced
  // before the rename so a crash cannot leave an empty file; removed if anything fails.
  async function writeAtomic(text) {
    const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
    const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0)
    let fh
    try {
      fh = await open(tmp, flags, 0o600)
      await fh.writeFile(text)
      await fh.sync()
      await fh.close()
      fh = null
      await rename(tmp, file)
    } catch (e) {
      await fh?.close().catch(() => {})
      await unlink(tmp).catch(() => {})
      throw e
    }
  }

  function save(name, raw) {
    const run = pending.then(() => apply(name, raw))
    pending = run.catch(() => {})
    return run
  }

  return { status, save }
}
