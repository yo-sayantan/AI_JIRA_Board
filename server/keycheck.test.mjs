import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { KEY_TEST_SERVICES, classifyError, collectBody, createKeyChecker, mergeSettings } from './keycheck.mjs'

const CONFIG = {
  endpoints: {
    jiraBase: 'https://jira.corp.test',
    confluenceBase: 'https://wiki.corp.test/',
    bitbucketBase: 'https://git.corp.test',
    checkmarxBase: '',
    checkmarxAuthUrl: '',
  },
  jenkins: { jobs: { 'pay-svc': { qa: 'https://ci.corp.test/job/team/job/pay-qa/' } } },
}

const SECRETS = {
  JIRA_PERSONAL_TOKEN: 'jira-secret-token-0001',
  CONFLUENCE_PERSONAL_TOKEN: 'wiki-secret-token-0002',
  BITBUCKET_PAT: 'bb-secret-token-0003',
  ATLASSIAN_TOKEN: 'atl-secret-token-0004',
  ATLASSIAN_EMAIL: 'me@corp.test',
  ATLASSIAN_SITE_URL: 'https://me.atlassian.net',
  JENKINS_USER: 'builder',
  JENKINS_API_TOKEN: 'jk-secret-token-0005',
  CHECKMARX_API_KEY: 'cx-secret-token-0006',
  CHECKMARX_BASE_URL: 'https://acme.cxone.cloud',
  ANTHROPIC_API_KEY: 'sk-ant-secret-0007',
  CURSOR_API_KEY: 'cur-secret-token-0008',
  GEMINI_API_KEY: 'gem-secret-token-0009',
  OPENAI_API_KEY: 'sk-oai-secret-0010',
  GITHUB_TOKEN: 'ghp-secret-token-0011',
}
const SECRET_VALUES = Object.entries(SECRETS)
  .filter(([k]) => /TOKEN|KEY|PAT/.test(k))
  .map(([, v]) => v)

/** A fake HTTP layer: records each request and answers from `reply` (a value or a function). */
function fakeHttp(reply = { status: 200, body: '{}' }) {
  const calls = []
  const request = async (opts) => {
    calls.push(opts)
    const r = typeof reply === 'function' ? await reply(opts, calls.length) : reply
    return { headers: {}, truncated: false, body: '', ...r }
  }
  return { calls, request }
}

function checker({ secrets = SECRETS, config = CONFIG, reply, logs = [], recordHealth } = {}) {
  const http = fakeHttp(reply)
  const c = createKeyChecker({ loadSettings: async () => ({ ...secrets }), config, request: http.request, log: (l) => logs.push(l), readCa: async () => null, recordHealth })
  return { c, http, logs }
}

const noSecretIn = (value) => {
  const text = JSON.stringify(value)
  for (const s of SECRET_VALUES) expect(text).not.toContain(s)
  expect(text.toLowerCase()).not.toContain('authorization')
  expect(text.toLowerCase()).not.toContain('bearer')
}

describe('request shapes, one per service', () => {
  it('jira: GET /rest/api/2/myself with the PAT as bearer, detail names the user', async () => {
    const { c, http } = checker({ reply: { status: 200, body: JSON.stringify({ displayName: 'Ada Lovelace', emailAddress: 'x@y' }) } })
    const r = await c.test('jira')
    expect(http.calls).toHaveLength(1)
    const [req] = http.calls
    expect(req.method).toBe('GET')
    expect(req.url).toBe('https://jira.corp.test/rest/api/2/myself')
    expect(req.headers.Authorization).toBe(`Bearer ${SECRETS.JIRA_PERSONAL_TOKEN}`)
    expect(r).toMatchObject({ ok: true, service: 'jira', status: 'ok', httpStatus: 200, detail: 'Signed in as Ada Lovelace' })
    expect(typeof r.ms).toBe('number')
    noSecretIn(r)
  })

  it('jira: a saved JIRA_URL beats the config endpoint (trailing slash trimmed)', async () => {
    const { c, http } = checker({ secrets: { ...SECRETS, JIRA_URL: 'https://jira2.corp.test/' } })
    await c.test('jira')
    expect(http.calls[0].url).toBe('https://jira2.corp.test/rest/api/2/myself')
  })

  it('confluence: GET /rest/api/user/current, bearer', async () => {
    const { c, http } = checker({ reply: { status: 200, body: JSON.stringify({ displayName: 'Ada' }) } })
    const r = await c.test('confluence')
    expect(http.calls[0].url).toBe('https://wiki.corp.test/rest/api/user/current')
    expect(http.calls[0].headers.Authorization).toBe(`Bearer ${SECRETS.CONFLUENCE_PERSONAL_TOKEN}`)
    expect(r.detail).toBe('Signed in as Ada')
  })

  it('bitbucket: GET projects?limit=1 with BITBUCKET_PAT, else ATLASSIAN_TOKEN', async () => {
    const { c, http } = checker()
    await c.test('bitbucket')
    expect(http.calls[0].url).toBe('https://git.corp.test/rest/api/1.0/projects?limit=1')
    expect(http.calls[0].headers.Authorization).toBe(`Bearer ${SECRETS.BITBUCKET_PAT}`)
    const { BITBUCKET_PAT, ...rest } = SECRETS
    void BITBUCKET_PAT
    const second = checker({ secrets: rest })
    await second.c.test('bitbucket')
    expect(second.http.calls[0].headers.Authorization).toBe(`Bearer ${SECRETS.ATLASSIAN_TOKEN}`)
  })

  it('atlassian: GET /rest/api/3/myself with basic email:token', async () => {
    const { c, http } = checker({ reply: { status: 200, body: JSON.stringify({ displayName: 'Ada' }) } })
    const r = await c.test('atlassian')
    expect(http.calls[0].url).toBe('https://me.atlassian.net/rest/api/3/myself')
    const basic = Buffer.from(`${SECRETS.ATLASSIAN_EMAIL}:${SECRETS.ATLASSIAN_TOKEN}`).toString('base64')
    expect(http.calls[0].headers.Authorization).toBe(`Basic ${basic}`)
    expect(r.detail).toBe('Signed in as Ada')
  })

  it('jenkins: GET <first job>api/json?tree=name with basic user:token', async () => {
    const { c, http } = checker({ reply: { status: 200, body: JSON.stringify({ name: 'pay-qa' }) } })
    const r = await c.test('jenkins')
    expect(http.calls[0].url).toBe('https://ci.corp.test/job/team/job/pay-qa/api/json?tree=name')
    const basic = Buffer.from(`builder:${SECRETS.JENKINS_API_TOKEN}`).toString('base64')
    expect(http.calls[0].headers.Authorization).toBe(`Basic ${basic}`)
    expect(r.status).toBe('ok')
    expect(r.detail).toContain('pay-qa')
  })

  it('jenkins: an http job URL is never used', async () => {
    const config = { ...CONFIG, jenkins: { jobs: { a: { qa: 'http://ci.corp.test/job/a/' } } } }
    const { c, http } = checker({ config })
    const r = await c.test('jenkins')
    expect(http.calls).toHaveLength(0)
    expect(r.status).toBe('not-configured')
  })

  it('atlassian: a site that is not an Atlassian Cloud site is refused before any call, with a clear hint', async () => {
    const { c, http } = checker({ secrets: { ...SECRETS, ATLASSIAN_SITE_URL: 'https://id.atlassian.com/' } })
    const r = await c.test('atlassian')
    expect(http.calls).toHaveLength(0)
    expect(r.status).toBe('not-configured')
    expect(r.detail).toMatch(/your-org\.atlassian\.net/)
  })

  it('atlassian: a 401 says the email must be the Atlassian account email, and never echoes it', async () => {
    const { c } = checker({ reply: { status: 401, body: '{}' } })
    const r = await c.test('atlassian')
    expect(r.status).toBe('auth-failed')
    expect(r.detail).toMatch(/email/i)
    expect(r.detail).not.toContain(SECRETS.ATLASSIAN_EMAIL)
  })

  it('atlassian: a 403 explains the usual causes', async () => {
    const { c } = checker({ reply: { status: 403, body: '{}' } })
    const r = await c.test('atlassian')
    expect(r.status).toBe('forbidden')
    expect(r.detail).toMatch(/email/i)
  })

  it('jenkins: with JENKINS_URL saved, checks /me/api/json — no job links needed', async () => {
    const { c, http } = checker({
      secrets: { ...SECRETS, JENKINS_URL: 'https://ci.corp.test/' },
      config: { ...CONFIG, jenkins: { jobs: {} } },
      reply: { status: 200, body: JSON.stringify({ fullName: 'Build Bot' }) },
    })
    const r = await c.test('jenkins')
    expect(http.calls[0].url).toBe('https://ci.corp.test/me/api/json')
    expect(r.status).toBe('ok')
    expect(r.detail).toBe('Signed in as Build Bot')
  })

  it('checkmarx: refresh-token exchange at the derived realm URL, key only in the POST body', async () => {
    const { c, http } = checker({ reply: { status: 200, body: JSON.stringify({ access_token: 'ACCESS-SHOULD-NOT-LEAK', expires_in: 1800 }) } })
    const r = await c.test('checkmarx')
    const [req] = http.calls
    expect(req.method).toBe('POST')
    expect(req.url).toBe('https://acme.cxone.cloud/auth/realms/acme/protocol/openid-connect/token')
    expect(req.url).not.toContain(SECRETS.CHECKMARX_API_KEY)
    expect(req.headers['Content-Type']).toBe('application/x-www-form-urlencoded')
    expect(req.headers.Authorization).toBeUndefined()
    const form = new URLSearchParams(req.body)
    expect(Object.fromEntries(form)).toEqual({ grant_type: 'refresh_token', client_id: 'ast-app', refresh_token: SECRETS.CHECKMARX_API_KEY })
    expect(r.status).toBe('ok')
    expect(JSON.stringify(r)).not.toContain('ACCESS-SHOULD-NOT-LEAK')
    noSecretIn(r)
  })

  it('checkmarx: CHECKMARX_AUTH_URL wins over the derived one', async () => {
    const { c, http } = checker({ secrets: { ...SECRETS, CHECKMARX_AUTH_URL: 'https://iam.cxone.cloud/token/' }, reply: { status: 200, body: '{"access_token":"a"}' } })
    await c.test('checkmarx')
    expect(http.calls[0].url).toBe('https://iam.cxone.cloud/token')
  })

  it('checkmarx: a 400 invalid_grant is a rejected key; 200 without a token is an error', async () => {
    const bad = checker({ reply: { status: 400, body: '{"error":"invalid_grant"}' } })
    expect((await bad.c.test('checkmarx')).status).toBe('auth-failed')
    const empty = checker({ reply: { status: 200, body: '{}' } })
    expect((await empty.c.test('checkmarx')).status).toBe('error')
  })

  it('claude: GET /v1/models with x-api-key and anthropic-version', async () => {
    const { c, http } = checker({ reply: { status: 200, body: JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }] }) } })
    const r = await c.test('claude')
    expect(http.calls[0].url).toBe('https://api.anthropic.com/v1/models')
    expect(http.calls[0].headers['x-api-key']).toBe(SECRETS.ANTHROPIC_API_KEY)
    expect(http.calls[0].headers['anthropic-version']).toBe('2023-06-01')
    expect(r.detail).toBe('2 models')
  })

  it('cursor: GET /v1/models with basic key: (as the worker does)', async () => {
    const { c, http } = checker({ reply: { status: 200, body: JSON.stringify({ items: ['m1'] }) } })
    const r = await c.test('cursor')
    expect(http.calls[0].url).toBe('https://api.cursor.com/v1/models')
    expect(http.calls[0].headers.Authorization).toBe(`Basic ${Buffer.from(`${SECRETS.CURSOR_API_KEY}:`).toString('base64')}`)
    expect(r.detail).toBe('1 model')
  })

  it('gemini: the key goes in x-goog-api-key, never the URL', async () => {
    const { c, http } = checker({ reply: { status: 200, body: JSON.stringify({ models: [{ name: 'x' }] }) } })
    await c.test('gemini')
    expect(http.calls[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/models')
    expect(http.calls[0].url).not.toContain(SECRETS.GEMINI_API_KEY)
    expect(http.calls[0].headers['x-goog-api-key']).toBe(SECRETS.GEMINI_API_KEY)
  })

  it('openai: GET /v1/models, bearer', async () => {
    const { c, http } = checker()
    await c.test('openai')
    expect(http.calls[0].url).toBe('https://api.openai.com/v1/models')
    expect(http.calls[0].headers.Authorization).toBe(`Bearer ${SECRETS.OPENAI_API_KEY}`)
  })

  it('github: GET /user, bearer + User-Agent, detail is the login', async () => {
    const { c, http } = checker({ reply: { status: 200, body: JSON.stringify({ login: 'ada', email: 'private@x' }) } })
    const r = await c.test('github')
    expect(http.calls[0].url).toBe('https://api.github.com/user')
    expect(http.calls[0].headers.Authorization).toBe(`Bearer ${SECRETS.GITHUB_TOKEN}`)
    expect(http.calls[0].headers['User-Agent']).toBeTruthy()
    expect(r.detail).toBe('Signed in as ada')
    expect(JSON.stringify(r)).not.toContain('private@x')
  })

  it('every request carries the timeout, the body cap and a verified TLS setting', async () => {
    for (const service of KEY_TEST_SERVICES) {
      const { c, http } = checker({ reply: { status: 200, body: '{"access_token":"t"}' } })
      await c.test(service)
      expect(http.calls[0].timeoutMs).toBe(10_000)
      expect(http.calls[0].maxBytes).toBeGreaterThan(0)
      expect(http.calls[0].tls.rejectUnauthorized).toBe(true)
    }
  })
})

describe('status mapping', () => {
  const cases = [
    [401, 'auth-failed'],
    [403, 'forbidden'],
    [404, 'not-found'],
    [500, 'error'],
  ]
  for (const [code, status] of cases) {
    it(`HTTP ${code} → ${status}`, async () => {
      const { c } = checker({ reply: { status: code, body: `token ${SECRETS.JIRA_PERSONAL_TOKEN} echoed` } })
      const r = await c.test('jira')
      expect(r).toMatchObject({ ok: false, status, httpStatus: code })
      noSecretIn(r)
    })
  }

  it('a 3xx is an error naming the host it redirected to, and is never followed', async () => {
    const { c, http } = checker({ reply: { status: 302, headers: { location: 'https://sso.elsewhere.test/login?x=1' } } })
    const r = await c.test('jira')
    expect(http.calls).toHaveLength(1)
    expect(r).toMatchObject({ ok: false, status: 'error', httpStatus: 302 })
    expect(r.detail).toBe('Redirected to sso.elsewhere.test')
  })

  const thrown = [
    [{ code: 'ETIMEDOUT' }, 'unreachable'],
    [{ code: 'ECONNREFUSED' }, 'unreachable'],
    [{ code: 'ENOTFOUND' }, 'unreachable'],
    [{ code: 'ECONNRESET' }, 'unreachable'],
    [{ code: 'CERT_HAS_EXPIRED' }, 'tls'],
    [{ code: 'SELF_SIGNED_CERT_IN_CHAIN' }, 'tls'],
    [{ code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }, 'tls'],
    [{ code: 'ERR_TLS_CERT_ALTNAME_INVALID' }, 'tls'],
    [{ code: 'EWHATEVER' }, 'error'],
  ]
  for (const [err, status] of thrown) {
    it(`${err.code} → ${status}`, async () => {
      const { c } = checker({
        reply: () => {
          throw Object.assign(new Error(`boom ${SECRETS.JIRA_PERSONAL_TOKEN}`), err)
        },
      })
      const r = await c.test('jira')
      expect(r).toMatchObject({ ok: false, status })
      expect(r.httpStatus).toBeUndefined()
      noSecretIn(r)
    })
  }

  it('classifyError names the host for unreachable / tls', () => {
    expect(classifyError({ code: 'ECONNREFUSED' }, 'jira.corp.test').detail).toContain('jira.corp.test')
    expect(classifyError({ code: 'ETIMEDOUT' }, 'h').detail).toMatch(/timed out/i)
    expect(classifyError({ code: 'CERT_HAS_EXPIRED' }, 'h').detail).toMatch(/certificate/i)
  })

  it('an identity field holding the secret is scrubbed from the detail', async () => {
    const { c } = checker({ reply: { status: 200, body: JSON.stringify({ displayName: SECRETS.JIRA_PERSONAL_TOKEN }) } })
    noSecretIn(await c.test('jira'))
  })

  it('a truncated (over-cap) body is not parsed but the status still counts', async () => {
    const { c } = checker({ reply: { status: 200, body: '{"data":[', truncated: true } })
    const r = await c.test('claude')
    expect(r).toMatchObject({ ok: true, status: 'ok' })
    expect(r.detail).toBe('Key accepted')
  })
})

describe('not configured', () => {
  const without = (...names) => Object.fromEntries(Object.entries(SECRETS).filter(([k]) => !names.includes(k)))
  const cases = [
    ['jira', without('JIRA_PERSONAL_TOKEN'), CONFIG],
    ['jira', SECRETS, { ...CONFIG, endpoints: { ...CONFIG.endpoints, jiraBase: '' } }],
    ['jira', SECRETS, { ...CONFIG, endpoints: { ...CONFIG.endpoints, jiraBase: 'https://jira.your-company.example' } }],
    ['jira', SECRETS, { ...CONFIG, endpoints: { ...CONFIG.endpoints, jiraBase: 'http://jira.corp.test' } }],
    ['confluence', without('CONFLUENCE_PERSONAL_TOKEN'), CONFIG],
    ['bitbucket', without('BITBUCKET_PAT', 'ATLASSIAN_TOKEN'), CONFIG],
    ['atlassian', without('ATLASSIAN_EMAIL'), CONFIG],
    ['atlassian', without('ATLASSIAN_SITE_URL'), CONFIG],
    ['jenkins', without('JENKINS_USER'), CONFIG],
    ['jenkins', SECRETS, { ...CONFIG, jenkins: { jobs: {} } }],
    ['checkmarx', without('CHECKMARX_API_KEY'), CONFIG],
    ['checkmarx', without('CHECKMARX_BASE_URL'), CONFIG],
    ['claude', without('ANTHROPIC_API_KEY'), CONFIG],
    ['cursor', without('CURSOR_API_KEY'), CONFIG],
    ['gemini', without('GEMINI_API_KEY'), CONFIG],
    ['openai', without('OPENAI_API_KEY'), CONFIG],
    ['github', without('GITHUB_TOKEN'), CONFIG],
  ]
  cases.forEach(([service, secrets, config], i) => {
    it(`${service} #${i}: nothing is sent`, async () => {
      const { c, http } = checker({ secrets, config })
      const r = await c.test(service)
      expect(http.calls).toHaveLength(0)
      expect(r).toMatchObject({ ok: false, service, status: 'not-configured' })
      expect(r.detail.length).toBeGreaterThan(3)
    })
  })

  it('atlassian without email / site says what it needs', async () => {
    const { c } = checker({ secrets: without('ATLASSIAN_EMAIL', 'ATLASSIAN_SITE_URL') })
    expect((await c.test('atlassian')).detail).toBe('needs email + site URL')
  })

  it('http is allowed for a localhost base', async () => {
    const { c, http } = checker({ secrets: { ...SECRETS, JIRA_URL: 'http://localhost:8080' } })
    await c.test('jira')
    expect(http.calls[0].url).toBe('http://localhost:8080/rest/api/2/myself')
  })
})

describe('TLS settings', () => {
  it('JIRA_INSECURE_TLS=1 relaxes only jira / confluence / bitbucket', async () => {
    const secrets = { ...SECRETS, JIRA_INSECURE_TLS: '1' }
    for (const [service, verified] of [['jira', false], ['confluence', false], ['bitbucket', false], ['jenkins', true], ['checkmarx', true], ['claude', true]]) {
      const { c, http } = checker({ secrets, reply: { status: 200, body: '{"access_token":"t"}' } })
      await c.test(service)
      expect(http.calls[0].tls.rejectUnauthorized).toBe(verified)
    }
  })

  it('a CA bundle is added to (never replaces) the system roots', async () => {
    const http = fakeHttp()
    const c = createKeyChecker({
      loadSettings: async () => ({ ...SECRETS, JIRA_CA_BUNDLE: '/x/ca.pem' }),
      config: CONFIG,
      request: http.request,
      log: () => {},
      readCa: async (path) => (path === '/x/ca.pem' ? '-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----\n' : null),
    })
    await c.test('jira')
    const { ca } = http.calls[0].tls
    expect(ca.length).toBeGreaterThan(1)
    expect(ca.at(-1)).toContain('BEGIN CERTIFICATE')
  })
})

describe('concurrency, input and logging', () => {
  it('a second test of the same service while one runs → busy; another service is fine', async () => {
    let release
    const gate = new Promise((r) => (release = r))
    const { c } = checker({ reply: async () => (await gate, { status: 200, body: '{}' }) })
    const first = c.test('jira')
    expect(await c.test('jira')).toEqual({ busy: true })
    const other = c.test('openai')
    release()
    expect((await first).status).toBe('ok')
    expect((await other).status).toBe('ok')
    expect((await c.test('jira')).status).toBe('ok')
  })

  it('an unknown service is refused without a request', async () => {
    const { c, http } = checker()
    expect(await c.test('evil')).toEqual({ unknown: true })
    expect(await c.test('__proto__')).toEqual({ unknown: true })
    expect(http.calls).toHaveLength(0)
  })

  it('logs only service and status', async () => {
    const { c, logs } = checker({ reply: { status: 401, body: 'nope' } })
    await c.test('jira')
    expect(logs).toEqual(['[keys] test jira → auth-failed'])
  })
})

describe('health recording', () => {
  it('records every finished test (source added by the server), with a scrubbed detail', async () => {
    const seen = []
    const { c } = checker({ recordHealth: async (service, outcome) => seen.push([service, outcome]), reply: { status: 401, body: 'nope' } })
    await c.test('jira')
    expect(seen).toHaveLength(1)
    expect(seen[0][0]).toBe('jira')
    expect(seen[0][1]).toMatchObject({ ok: false, status: 'auth-failed', httpStatus: 401 })
    noSecretIn(seen)
  })

  it('records success too, but never a service that is not configured', async () => {
    const seen = []
    const ok = checker({ recordHealth: async (s, o) => seen.push([s, o.ok]), reply: { status: 200, body: '{}' } })
    await ok.c.test('jira')
    const none = checker({ secrets: {}, recordHealth: async (s, o) => seen.push([s, o.ok]) })
    await none.c.test('jira')
    expect(seen).toEqual([['jira', true]])
  })

  it('a recorder that throws never breaks the test', async () => {
    const { c } = checker({
      recordHealth: async () => {
        throw new Error('disk full')
      },
    })
    expect((await c.test('jira')).status).toBe('ok')
  })
})

describe('mergeSettings', () => {
  it('environment variables win over setup/.env, blanks do not', () => {
    const merged = mergeSettings({ A: 'file', B: 'file', C: 'file' }, { A: 'env', B: '  ', D: 'env' })
    expect(merged.A).toBe('env')
    expect(merged.B).toBe('file')
    expect(merged.C).toBe('file')
  })
})

describe('collectBody', () => {
  it('reads a small body whole', async () => {
    expect(await collectBody(Readable.from([Buffer.from('ab'), Buffer.from('cd')]), 10)).toEqual({ text: 'abcd', truncated: false })
  })

  it('stops at the cap and says so', async () => {
    const r = await collectBody(Readable.from([Buffer.from('x'.repeat(8)), Buffer.from('y'.repeat(8))]), 10)
    expect(r.truncated).toBe(true)
    expect(r.text.length).toBeLessThanOrEqual(10)
  })
})
