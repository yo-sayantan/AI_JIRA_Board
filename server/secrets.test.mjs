import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSecretsStore, maskValue, parseEnv, registryKeys, upsertEnv, validateValue } from './secrets.mjs'
import { STATIC_ALLOW } from './config.mjs'
import { createStaticHandler } from './http.mjs'
import registry from '../setup/api-keys.json' with { type: 'json' }

// The real file is setup/.env; tests use another name in a temp dir so nothing touches it.
const tempFile = async () => join(await mkdtemp(join(tmpdir(), 'jb-secrets-')), 'test-secrets.env')

describe('parseEnv', () => {
  it('reads KEY=VALUE like the Python and bash parsers', () => {
    const env = parseEnv(['# comment', '', 'A=1', 'export B = two ', 'C="quoted"', "D='single'", 'E=x=y', 'bad line', '1X=no'].join('\n'))
    expect(env).toEqual({ A: '1', B: 'two', C: 'quoted', D: 'single', E: 'x=y' })
  })

  it('takes values literally and tolerates CRLF', () => {
    expect(parseEnv('A=$(rm -rf /)\r\nB=`id`\r\n')).toEqual({ A: '$(rm -rf /)', B: '`id`' })
  })

  it('the last assignment wins', () => {
    expect(parseEnv('A=1\nA=2\n')).toEqual({ A: '2' })
  })
})

describe('upsertEnv', () => {
  it('replaces an existing key in place and keeps comments and other keys', () => {
    const out = upsertEnv('# head\nA=1\nB=2\n', 'A', 'new')
    expect(out).toBe('# head\nA=new\nB=2\n')
  })

  it('collapses duplicates of the key into one line', () => {
    expect(upsertEnv('A=1\nB=2\nexport A=3\n', 'A', 'x')).toBe('A=x\nB=2\n')
  })

  it('appends a key that is not there yet', () => {
    expect(upsertEnv('B=2', 'A', 'x')).toBe('B=2\nA=x\n')
    expect(upsertEnv('', 'A', 'x')).toBe('A=x\n')
  })

  it('an empty value removes the key; removing the last one leaves an empty file', () => {
    expect(upsertEnv('A=1\nB=2\n', 'A', '')).toBe('B=2\n')
    expect(upsertEnv('A=1\n', 'A', '')).toBe('')
  })

  it('keeps export-prefixed and CRLF neighbours as they were', () => {
    expect(upsertEnv('export B=2\r\nA=1\r\n', 'A', 'x')).toBe('export B=2\r\nA=x\n')
  })
})

describe('maskValue', () => {
  it('shows the first and last four characters of a long value', () => {
    expect(maskValue('sk-ant-0123456789abcdef')).toBe('sk-a••••••••cdef')
  })

  it('shows nothing of a value under 16 characters', () => {
    expect(maskValue('abcdefghijklmno')).toBe('••••••••')
    expect(maskValue('short')).toBe('••••••••')
  })

  it('never reveals the length', () => {
    expect(maskValue('a'.repeat(16)).length).toBe(maskValue('a'.repeat(400)).length)
  })
})

describe('validateValue', () => {
  const secret = { env: 'X', kind: 'secret' }
  const url = { env: 'X_URL', kind: 'url' }
  const email = { env: 'X_EMAIL', kind: 'email' }
  const text = { env: 'X_USER', kind: 'text' }
  it('accepts a normal token and trims it', () => {
    expect(validateValue(secret, '  tok-123  ')).toEqual({ value: 'tok-123' })
  })
  it('rejects line breaks and NUL (a value must stay one line)', () => {
    for (const bad of ['a\nB=evil', 'a\rb', 'a\0b']) expect(validateValue(secret, bad).error).toBeTruthy()
  })
  it('rejects surrounding quotes (the parser would strip them) and huge values', () => {
    expect(validateValue(secret, '"abc"').error).toBeTruthy()
    expect(validateValue(secret, 'x'.repeat(5000)).error).toBeTruthy()
  })
  it('non-secret fields must be clean https URLs (http only for localhost)', () => {
    expect(validateValue(url, 'https://jira.example.com')).toEqual({ value: 'https://jira.example.com' })
    expect(validateValue(url, 'https://jira.example.com/jira')).toEqual({ value: 'https://jira.example.com/jira' })
    expect(validateValue(url, 'http://localhost:8080')).toEqual({ value: 'http://localhost:8080' })
    for (const bad of ['javascript:alert(1)', 'http://jira.example.com', 'https://user:tok@evil.example/', 'https://x y', 'https://a.example/?q=1', 'https://a.example/#f', 'ftp://a.example'])
      expect(validateValue(url, bad).error, bad).toBeTruthy()
  })
  it('secrets are printable ASCII only — no mask bullets, no unicode or control characters', () => {
    for (const bad of ['abcd••••••••wxyz', 'abc"\x85', 'tok en', 'tok\u2028x', 'tok\x1cx']) expect(validateValue(secret, bad).error, JSON.stringify(bad)).toBeTruthy()
  })
  it('a field without a kind is a secret', () => {
    expect(validateValue({ env: 'X' }, 'tok en').error).toBeTruthy()
  })
  it('email fields take an address, text fields one printable word', () => {
    expect(validateValue(email, ' me@example.com ')).toEqual({ value: 'me@example.com' })
    for (const bad of ['me', 'me@', 'me @example.com', 'me@example']) expect(validateValue(email, bad).error, bad).toBeTruthy()
    expect(validateValue(text, 'build-bot')).toEqual({ value: 'build-bot' })
    expect(validateValue(text, 'build bot').error).toBeTruthy()
  })
  it('a text field refuses quotes, backticks and shell substitutions anywhere in the value', () => {
    for (const bad of ['a"b', "a'b", 'a`b`', 'a$(id)', 'a${HOME}', 'prod=abc12345,uat="x"', '{"prod":"abc12345"}'])
      expect(validateValue(text, bad).error, bad).toBeTruthy()
  })
  it('the Dynatrace tenants field takes env=id pairs on one line', () => {
    const tenants = registryKeys(registry).find((k) => k.env === 'DYNATRACE_TENANTS')
    expect(tenants).toMatchObject({ kind: 'text' })
    expect(validateValue(tenants, 'prod=abc12345,uat=def67890')).toEqual({ value: 'prod=abc12345,uat=def67890' })
    expect(validateValue(tenants, ' prod=abc12345 ')).toEqual({ value: 'prod=abc12345' })
    for (const bad of ['prod=abc12345\nOTHER=evil', 'prod=abc12345$(id)', 'prod="abc12345"', "prod='abc12345'", 'prod=abc12345, uat=def67890'])
      expect(validateValue(tenants, bad).error, JSON.stringify(bad)).toBeTruthy()
  })
  it('an empty value means remove', () => {
    expect(validateValue(secret, '   ')).toEqual({ value: '' })
  })
  it('rejects non-strings', () => {
    expect(validateValue(secret, 42).error).toBeTruthy()
  })
})

describe('createSecretsStore', () => {
  it('lists every registry key, masked, and never the raw secret', async () => {
    const file = await tempFile()
    await writeFile(file, 'JIRA_PERSONAL_TOKEN=abcd1234567890wxyz\nJIRA_URL=https://jira.example.com\nOTHER=keep\n')
    const status = await createSecretsStore({ file, registry }).status()
    expect(Object.keys(status).sort()).toEqual(registryKeys(registry).map((k) => k.env).sort())
    expect(status.JIRA_PERSONAL_TOKEN).toEqual({ set: true, masked: 'abcd••••••••wxyz' })
    expect(status.JIRA_URL).toEqual({ set: true, masked: 'https://jira.example.com' })
    expect(status.ANTHROPIC_API_KEY).toEqual({ set: false, masked: '' })
    expect(JSON.stringify(status)).not.toContain('abcd1234567890wxyz')
  })

  it('treats a missing file as no keys', async () => {
    const status = await createSecretsStore({ file: await tempFile(), registry }).status()
    expect(status.JIRA_PERSONAL_TOKEN.set).toBe(false)
  })

  it('saves a key atomically, owner-only, keeping the rest of the file', async () => {
    const file = await tempFile()
    await writeFile(file, '# mine\nOTHER=keep\n')
    const store = createSecretsStore({ file, registry })
    const r = await store.save('GEMINI_API_KEY', 'gem-0123456789abcd')
    expect(r.error).toBeUndefined()
    expect(r.status.GEMINI_API_KEY).toEqual({ set: true, masked: 'gem-••••••••abcd' })
    expect(await readFile(file, 'utf8')).toBe('# mine\nOTHER=keep\nGEMINI_API_KEY=gem-0123456789abcd\n')
    expect((await stat(file)).mode & 0o777).toBe(0o600)
  })

  it('refuses names outside the registry and bad values without touching the file', async () => {
    const file = await tempFile()
    await writeFile(file, 'A=1\n')
    const store = createSecretsStore({ file, registry })
    expect((await store.save('PATH', '/evil')).error).toMatch(/unknown/)
    expect((await store.save('JIRA_PERSONAL_TOKEN', 'x\nPATH=/evil')).error).toBeTruthy()
    expect(await readFile(file, 'utf8')).toBe('A=1\n')
  })

  it('never removes a token the user did not remove — a new URL keeps every key', async () => {
    const file = await tempFile()
    await writeFile(file, 'JIRA_PERSONAL_TOKEN=abcd1234567890wxyz\nBITBUCKET_PAT=bbbb1234567890zzzz\n')
    const store = createSecretsStore({ file, registry })
    const r = await store.save('JIRA_URL', 'https://jira.example.com')
    expect(r.error).toBeUndefined()
    expect(r.status.JIRA_PERSONAL_TOKEN.set).toBe(true)
    await store.save('JIRA_URL', 'https://other.example.com')
    await store.save('ATLASSIAN_SITE_URL', 'https://your-org.atlassian.net')
    expect(parseEnv(await readFile(file, 'utf8'))).toEqual({
      JIRA_PERSONAL_TOKEN: 'abcd1234567890wxyz',
      BITBUCKET_PAT: 'bbbb1234567890zzzz',
      JIRA_URL: 'https://other.example.com',
      ATLASSIAN_SITE_URL: 'https://your-org.atlassian.net',
    })
  })

  it('email and text fields come back in full', async () => {
    const file = await tempFile()
    await writeFile(file, 'ATLASSIAN_TOKEN=atl-0123456789abcdef\n')
    const store = createSecretsStore({ file, registry })
    const r = await store.save('ATLASSIAN_EMAIL', 'me@example.com')
    expect(r.status.ATLASSIAN_EMAIL).toEqual({ set: true, masked: 'me@example.com' })
    expect(r.status.ATLASSIAN_TOKEN.masked).toBe('atl-••••••••cdef')
  })

  it('leaves no temp file behind', async () => {
    const file = await tempFile()
    await createSecretsStore({ file, registry }).save('GEMINI_API_KEY', 'gem-0123456789abcd')
    const { readdir } = await import('node:fs/promises')
    const { dirname } = await import('node:path')
    expect(await readdir(dirname(file))).toEqual(['test-secrets.env'])
  })

  it('serialises overlapping saves so neither is lost', async () => {
    const file = await tempFile()
    const store = createSecretsStore({ file, registry })
    await Promise.all([store.save('GEMINI_API_KEY', 'g-111111111111'), store.save('CURSOR_API_KEY', 'c-222222222222')])
    expect(parseEnv(await readFile(file, 'utf8'))).toEqual({ GEMINI_API_KEY: 'g-111111111111', CURSOR_API_KEY: 'c-222222222222' })
  })
})

describe('static allowlist', () => {
  const served = (p) => STATIC_ALLOW.some((re) => re.test(p))
  it('never serves the secrets file or its temp files', () => {
    for (const p of ['/setup/.env', '/setup/.env.123.tmp', '/setup/sub/.env', '/jira-intern/.settings.json', '/setup/mcp-secrets.env', '/setup/secrets.env', '/setup/env.bak'])
      expect(served(p), p).toBe(false)
  })
  it('still serves the setup templates and the help guide', () => {
    expect(served('/setup/mcp-secrets.env.template')).toBe(true)
    expect(served('/setup/api-keys.json')).toBe(true)
    expect(served('/help/00-start-here.html')).toBe(true)
  })
})

describe('static handler', () => {
  it('refuses a dotfile even when the allowlist would match it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jb-static-'))
    await writeFile(join(root, '.env'), 'SECRET=1')
    await writeFile(join(root, 'ok.txt'), 'fine')
    const serve = createStaticHandler(root, [/.*/])
    const hit = async (path) => {
      let code = 0
      const res = { writeHead: (c) => ((code = c), { end: () => {} }), end: () => {} }
      await serve({ headers: {}, method: 'GET' }, res, path)
      return code
    }
    expect(await hit('/.env')).toBe(404)
    expect(await hit('/ok.txt')).toBe(200)
  })
})
