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
  DYNATRACE_PAT: ['dt0s16', 'TESTONLYPLATFORMTOKEN0012'].join('.'),
  DYNATRACE_TENANTS: 'prod=abc12345',
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

  it('atlassian: a scoped token (401 on the site) is retried through api.atlassian.com with the cloud id', async () => {
    const { c, http } = checker({
      reply: (opts) => {
        if (opts.url === 'https://me.atlassian.net/rest/api/3/myself') return { status: 401, body: '{}' }
        if (opts.url === 'https://me.atlassian.net/_edge/tenant_info') return { status: 200, body: JSON.stringify({ cloudId: '11111111-2222-3333-4444-555555555555' }) }
        if (opts.url === 'https://api.atlassian.com/ex/jira/11111111-2222-3333-4444-555555555555/rest/api/3/myself') return { status: 200, body: JSON.stringify({ displayName: 'Ada' }) }
        return { status: 500, body: '{}' }
      },
    })
    const r = await c.test('atlassian')
    expect(r.status).toBe('ok')
    expect(r.detail).toMatch(/Signed in as Ada/)
    expect(r.detail).toMatch(/scoped/i)
    const tenant = http.calls.find((x) => x.url.endsWith('/_edge/tenant_info'))
    expect(tenant.headers?.Authorization).toBeUndefined() // the discovery call is anonymous
    const gw = http.calls.find((x) => x.url.startsWith('https://api.atlassian.com/'))
    expect(gw.headers.Authorization).toMatch(/^Basic /)
  })

  it('atlassian: still 401 through the gateway → key rejected, with the email hint', async () => {
    const { c } = checker({
      reply: (opts) =>
        opts.url.endsWith('/_edge/tenant_info') ? { status: 200, body: JSON.stringify({ cloudId: '11111111-2222-3333-4444-555555555555' }) } : { status: 401, body: '{}' },
    })
    const r = await c.test('atlassian')
    expect(r.status).toBe('auth-failed')
    expect(r.detail).toMatch(/email/i)
    expect(r.detail).toMatch(/gateway 401/i)
  })

  it('atlassian: both 401s are reported with the HTTP code of each attempt and Atlassian\'s own login reason', async () => {
    const { c } = checker({
      reply: (opts) =>
        opts.url.endsWith('/_edge/tenant_info')
          ? { status: 200, body: JSON.stringify({ cloudId: '11111111-2222-3333-4444-555555555555' }) }
          : { status: 401, headers: { 'x-seraph-loginreason': 'AUTHENTICATED_FAILED' }, body: '{}' },
    })
    const r = await c.test('atlassian')
    expect(r.status).toBe('auth-failed')
    expect(r.detail).toMatch(/site 401/i)
    expect(r.detail).toMatch(/gateway 401/i)
    expect(r.detail).toMatch(/AUTHENTICATED_FAILED/)
  })

  it('atlassian: a gateway 403 (token lacks the read:jira-user scope) is reported as forbidden, not rejected', async () => {
    const { c } = checker({
      reply: (opts) => {
        if (opts.url.endsWith('/_edge/tenant_info')) return { status: 200, body: JSON.stringify({ cloudId: '11111111-2222-3333-4444-555555555555' }) }
        if (opts.url.startsWith('https://api.atlassian.com/')) return { status: 403, body: '{}' }
        return { status: 401, body: '{}' }
      },
    })
    const r = await c.test('atlassian')
    expect(r.status).toBe('forbidden')
    expect(r.detail).toMatch(/scope/i)
  })

  it('atlassian: a 401 whose cloud id cannot be found stays a plain key rejection', async () => {
    const { c } = checker({ reply: { status: 401, body: '{}' } })
    const r = await c.test('atlassian')
    expect(r.status).toBe('auth-failed')
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

  it('jenkins: with the projects folder saved, reads <root>/api/json and counts its folders — before JENKINS_URL and the job links', async () => {
    const body = { name: 'Atlas', jobs: [{ name: 'a', _class: 'com.cloudbees.hudson.plugins.folder.Folder' }, { name: 'b', _class: 'com.cloudbees.hudson.plugins.folder.Folder' }, { name: 'c', _class: 'org.jenkinsci.plugins.workflow.job.WorkflowJob' }] }
    const { c, http } = checker({
      secrets: { ...SECRETS, JENKINS_ROOT_URL: 'https://ci.corp.test/job/NA/job/Atlas/', JENKINS_URL: 'https://ci.corp.test/' },
      reply: { status: 200, body: JSON.stringify(body) },
    })
    const r = await c.test('jenkins')
    expect(http.calls).toHaveLength(1)
    expect(http.calls[0].url).toBe('https://ci.corp.test/job/NA/job/Atlas/api/json?tree=name,jobs[name,_class]')
    const basic = Buffer.from(`builder:${SECRETS.JENKINS_API_TOKEN}`).toString('base64')
    expect(http.calls[0].headers.Authorization).toBe(`Basic ${basic}`)
    expect(r.status).toBe('ok')
    expect(r.detail).toBe('Root readable · 2 folders')
  })

  it('jenkins: the root may come from config jenkins.root; a root with no folder classes counts items; http is refused', async () => {
    const config = { ...CONFIG, jenkins: { jobs: {}, root: 'https://ci.corp.test/job/x/' } }
    const { c, http } = checker({ config, reply: { status: 200, body: JSON.stringify({ jobs: [{ name: 'a' }] }) } })
    const r = await c.test('jenkins')
    expect(http.calls[0].url).toBe('https://ci.corp.test/job/x/api/json?tree=name,jobs[name,_class]')
    expect(r.detail).toBe('Root readable · 1 item')
    const bad = checker({ secrets: { ...SECRETS, JENKINS_ROOT_URL: 'http://ci.corp.test/job/x/' } })
    const r2 = await bad.c.test('jenkins')
    expect(bad.http.calls).toHaveLength(0)
    expect(r2.status).toBe('not-configured')
  })

  it('jenkins: a root that rejects the key reports it, and the key never appears in the detail', async () => {
    const { c } = checker({ secrets: { ...SECRETS, JENKINS_ROOT_URL: 'https://ci.corp.test/job/x/' }, reply: { status: 401, body: '' } })
    const r = await c.test('jenkins')
    expect(r.status).toBe('auth-failed')
    expect(JSON.stringify(r)).not.toContain(SECRETS.JENKINS_API_TOKEN)
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

  it('dynatrace: one POST per tenant to <id>.apps.dynatrace.com, bearer token, a one-row Davis problems query over the last 7 days', async () => {
    const NOW = Date.parse('2026-10-11T10:30:15.250Z')
    const http = fakeHttp({ status: 200, body: JSON.stringify({ state: 'SUCCEEDED', result: { records: [] } }) })
    const c = createKeyChecker({ loadSettings: async () => ({ ...SECRETS }), config: CONFIG, request: http.request, log: () => {}, readCa: async () => null, now: () => NOW })
    const r = await c.test('dynatrace')
    expect(http.calls).toHaveLength(1)
    const [req] = http.calls
    expect(req.method).toBe('POST')
    expect(req.url).toBe('https://abc12345.apps.dynatrace.com/platform/storage/query/v1/query:execute')
    expect(req.headers).toEqual({ Authorization: `Bearer ${SECRETS.DYNATRACE_PAT}`, 'Content-Type': 'application/json', Accept: 'application/json' })
    expect(JSON.parse(req.body)).toEqual({
      query: 'fetch dt.davis.problems | limit 1',
      defaultTimeframeStart: '2026-10-04T10:30:15Z',
      defaultTimeframeEnd: '2026-10-11T10:30:15Z',
      maxResultRecords: 1,
      requestTimeoutMilliseconds: 8000,
    })
    expect(req.url).not.toContain(SECRETS.DYNATRACE_PAT)
    expect(req.body).not.toContain(SECRETS.DYNATRACE_PAT)
    expect(r).toMatchObject({ ok: true, service: 'dynatrace', status: 'ok', httpStatus: 200, detail: '1 tenant' })
    noSecretIn(r)
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
    ['dynatrace', without('DYNATRACE_PAT'), CONFIG],
    ['dynatrace', without('DYNATRACE_TENANTS'), CONFIG],
    ['dynatrace', without('DYNATRACE_TENANTS'), { ...CONFIG, endpoints: { ...CONFIG.endpoints, dynatraceTenants: { prod: '', uat: '', dev: '' } } }],
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

describe('dynatrace', () => {
  const HOST = (id) => `https://${id}.apps.dynatrace.com/platform/storage/query/v1`
  const OK = { status: 200, body: JSON.stringify({ state: 'SUCCEEDED', result: { records: [] } }) }
  const dt = (tenants, extra = {}) => ({ ...SECRETS, DYNATRACE_TENANTS: tenants, ...extra })
  /** Answer per tenant host: { abc12345: reply, def67890: reply }; a function reply gets the call. */
  const perTenant = (map) => (opts) => {
    const id = new URL(opts.url).hostname.split('.')[0]
    const r = map[id]
    return typeof r === 'function' ? r(opts) : r
  }

  it('one tenant OK → "1 tenant"; two → "2 tenants", one probe each, in order', async () => {
    const one = checker({ reply: OK })
    expect((await one.c.test('dynatrace')).detail).toBe('1 tenant')
    const two = checker({ secrets: dt('prod=abc12345,uat=def67890'), reply: OK })
    const r = await two.c.test('dynatrace')
    expect(r).toMatchObject({ ok: true, status: 'ok', detail: '2 tenants' })
    expect(two.http.calls.map((x) => x.url)).toEqual([`${HOST('abc12345')}/query:execute`, `${HOST('def67890')}/query:execute`])
    for (const call of two.http.calls) expect(call.headers.Authorization).toBe(`Bearer ${SECRETS.DYNATRACE_PAT}`)
    noSecretIn(r)
  })

  it('a 200 without a state counts as finished', async () => {
    const { c } = checker({ reply: { status: 200, body: '{}' } })
    expect((await c.test('dynatrace')).status).toBe('ok')
  })

  it('202 RUNNING → polls query:poll with the url-encoded request token, then SUCCEEDED → ok', async () => {
    const answers = [
      { status: 202, body: JSON.stringify({ state: 'RUNNING', requestToken: 'tok/with+odd=chars&x' }) },
      { status: 202, body: JSON.stringify({ state: 'RUNNING', requestToken: 'tok/with+odd=chars&x' }) },
      { status: 200, body: JSON.stringify({ state: 'SUCCEEDED', result: {} }) },
    ]
    const { c, http } = checker({ reply: () => answers.shift() })
    const r = await c.test('dynatrace')
    expect(http.calls).toHaveLength(3)
    expect(http.calls[0].method).toBe('POST')
    const poll = http.calls[1]
    expect(poll.method).toBe('GET')
    expect(poll.url).toBe(`${HOST('abc12345')}/query:poll?request-token=tok%2Fwith%2Bodd%3Dchars%26x&request-timeout-milliseconds=8000`)
    expect(poll.headers.Authorization).toBe(`Bearer ${SECRETS.DYNATRACE_PAT}`)
    expect(poll.body).toBeUndefined()
    expect(http.calls[2].url).toBe(poll.url)
    expect(r).toMatchObject({ ok: true, status: 'ok', detail: '1 tenant' })
  })

  it('still RUNNING after 3 polls → ok with a note, no fourth poll', async () => {
    const { c, http } = checker({ reply: { status: 202, body: JSON.stringify({ state: 'RUNNING', requestToken: 'abc' }) } })
    const r = await c.test('dynatrace')
    expect(http.calls).toHaveLength(4) // execute + 3 polls
    expect(r).toMatchObject({ ok: true, status: 'ok' })
    expect(r.detail).toBe('1 tenant · token accepted — query still running')
  })

  it('a 202 with no request token cannot be polled: ok with the note', async () => {
    const { c, http } = checker({ reply: { status: 202, body: JSON.stringify({ state: 'RUNNING' }) } })
    const r = await c.test('dynatrace')
    expect(http.calls).toHaveLength(1)
    expect(r.status).toBe('ok')
    expect(r.detail).toMatch(/still running/)
  })

  it('a poll that comes back FAILED → error "query failed", with no HTTP status and nothing the server said', async () => {
    const answers = [
      { status: 202, body: JSON.stringify({ state: 'RUNNING', requestToken: 'abc' }) },
      { status: 200, body: JSON.stringify({ state: 'FAILED', error: { code: 400, message: 'SECRET query text echoed' } }) },
    ]
    const { c } = checker({ reply: () => answers.shift() })
    const r = await c.test('dynatrace')
    expect(r).toMatchObject({ ok: false, status: 'error', detail: 'prod: query failed' })
    expect(r.httpStatus).toBeUndefined()
    expect(JSON.stringify(r)).not.toContain('SECRET query text')
  })

  it('an execute that already answers FAILED is the same error', async () => {
    const { c } = checker({ reply: { status: 200, body: JSON.stringify({ state: 'FAILED' }) } })
    expect(await c.test('dynatrace')).toMatchObject({ status: 'error', detail: 'prod: query failed' })
  })

  it('401 → auth-failed, "token rejected", and the token never appears', async () => {
    const { c } = checker({ reply: { status: 401, body: `{"error":"bad ${SECRETS.DYNATRACE_PAT}"}` } })
    const r = await c.test('dynatrace')
    expect(r).toMatchObject({ ok: false, status: 'auth-failed', httpStatus: 401, detail: 'prod: token rejected' })
    noSecretIn(r)
  })

  it('403 → forbidden, naming the scope the probe needs', async () => {
    const { c } = checker({ reply: { status: 403, body: '{}' } })
    const r = await c.test('dynatrace')
    expect(r).toMatchObject({ ok: false, status: 'forbidden', httpStatus: 403 })
    expect(r.detail).toBe('prod: token accepted but lacks a scope (storage:events:read)')
  })

  it('404 / 429 / 500 map like the other services', async () => {
    for (const [code, status] of [[404, 'not-found'], [429, 'error'], [500, 'error']]) {
      const { c } = checker({ reply: { status: code, body: '{}' } })
      expect(await c.test('dynatrace'), String(code)).toMatchObject({ ok: false, status, httpStatus: code })
    }
  })

  it('one tenant failing, one fine → the failing label is named and the status is that failure', async () => {
    const { c } = checker({ secrets: dt('prod=abc12345,uat=def67890'), reply: perTenant({ abc12345: OK, def67890: { status: 401, body: '{}' } }) })
    const r = await c.test('dynatrace')
    expect(r).toMatchObject({ ok: false, status: 'auth-failed', httpStatus: 401, detail: 'prod: OK · uat: token rejected' })
  })

  it('both failing differently → the key problem is the headline, every label is listed', async () => {
    const { c } = checker({
      secrets: dt('prod=abc12345,uat=def67890,dev=fed09876'),
      reply: perTenant({ abc12345: { status: 500, body: '{}' }, def67890: { status: 403, body: '{}' }, fed09876: OK }),
    })
    const r = await c.test('dynatrace')
    expect(r.status).toBe('forbidden')
    expect(r.detail).toBe('prod: unexpected HTTP 500 · uat: token accepted but lacks a scope (storage:events:read) · dev: OK')
    const net = checker({
      secrets: dt('prod=abc12345,uat=def67890'),
      reply: perTenant({
        abc12345: { status: 404, body: '{}' },
        def67890: () => {
          throw Object.assign(new Error('boom'), { code: 'ECONNREFUSED' })
        },
      }),
    })
    expect((await net.c.test('dynatrace')).status).toBe('unreachable')
  })

  it('a network failure on a tenant → unreachable / tls, the host only, never the error text', async () => {
    const down = checker({
      reply: () => {
        throw Object.assign(new Error(`boom ${SECRETS.DYNATRACE_PAT}`), { code: 'ENOTFOUND' })
      },
    })
    const r = await down.c.test('dynatrace')
    expect(r.status).toBe('unreachable')
    expect(r.detail).toBe("prod: Can't reach abc12345.apps.dynatrace.com (ENOTFOUND)")
    noSecretIn(r)
    const tls = checker({
      reply: () => {
        throw Object.assign(new Error('x'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' })
      },
    })
    const r2 = await tls.c.test('dynatrace')
    expect(r2.status).toBe('tls')
    expect(r2.detail).toMatch(/abc12345\.apps\.dynatrace\.com/)
  })

  it('a poll that fails on the network is reported like an execute that does', async () => {
    let n = 0
    const { c } = checker({
      reply: () => {
        if (n++ === 0) return { status: 202, body: JSON.stringify({ state: 'RUNNING', requestToken: 'abc' }) }
        throw Object.assign(new Error('x'), { code: 'ETIMEDOUT' })
      },
    })
    expect((await c.test('dynatrace')).status).toBe('unreachable')
  })

  it('a redirect is refused, never followed, and names only the host', async () => {
    const { c, http } = checker({ reply: { status: 302, headers: { location: 'https://sso.elsewhere.test/login?x=1' } } })
    const r = await c.test('dynatrace')
    expect(http.calls).toHaveLength(1)
    expect(r).toMatchObject({ ok: false, status: 'error', httpStatus: 302, detail: 'prod: redirected to sso.elsewhere.test' })
  })

  it('a redirect on a poll is not followed either', async () => {
    const answers = [
      { status: 202, body: JSON.stringify({ state: 'RUNNING', requestToken: 'abc' }) },
      { status: 307, headers: { location: 'https://evil.example/steal' } },
    ]
    const { c, http } = checker({ reply: () => answers.shift() })
    const r = await c.test('dynatrace')
    expect(http.calls).toHaveLength(2)
    expect(r.detail).toBe('prod: redirected to evil.example')
  })

  it('tenants: JSON object, shorthand with spaces and case, and the config fallback ({env: id}, blanks dropped)', async () => {
    const json = checker({ secrets: dt('{"prod":"abc12345","uat":"def67890"}'), reply: OK })
    expect((await json.c.test('dynatrace')).detail).toBe('2 tenants')
    expect(json.http.calls.map((x) => new URL(x.url).hostname)).toEqual(['abc12345.apps.dynatrace.com', 'def67890.apps.dynatrace.com'])
    const short = checker({ secrets: dt(' Prod = ABC12345 , uat=def67890, '), reply: OK })
    expect((await short.c.test('dynatrace')).detail).toBe('2 tenants')
    expect(short.http.calls.map((x) => new URL(x.url).hostname)).toEqual(['abc12345.apps.dynatrace.com', 'def67890.apps.dynatrace.com'])
    const { DYNATRACE_TENANTS, ...noTenants } = SECRETS
    void DYNATRACE_TENANTS
    const fromConfig = checker({ secrets: noTenants, config: { ...CONFIG, endpoints: { ...CONFIG.endpoints, dynatraceTenants: { prod: 'abc12345', uat: '', dev: 'fed09876' } } }, reply: OK })
    const r = await fromConfig.c.test('dynatrace')
    expect(r.detail).toBe('2 tenants')
    expect(fromConfig.http.calls.map((x) => new URL(x.url).hostname)).toEqual(['abc12345.apps.dynatrace.com', 'fed09876.apps.dynatrace.com'])
  })

  it('the saved DYNATRACE_TENANTS wins over the config', async () => {
    const { c, http } = checker({ config: { ...CONFIG, endpoints: { ...CONFIG.endpoints, dynatraceTenants: { dev: 'fed09876' } } }, reply: OK })
    await c.test('dynatrace')
    expect(http.calls.map((x) => new URL(x.url).hostname)).toEqual(['abc12345.apps.dynatrace.com'])
  })

  it('no token → "needs DYNATRACE_PAT"; no tenants → says where to put them; nothing is sent', async () => {
    const { DYNATRACE_PAT, DYNATRACE_TENANTS, ...rest } = SECRETS
    void DYNATRACE_PAT
    void DYNATRACE_TENANTS
    const noToken = checker({ secrets: { ...rest, DYNATRACE_TENANTS: 'prod=abc12345' } })
    expect(await noToken.c.test('dynatrace')).toMatchObject({ ok: false, status: 'not-configured', detail: 'needs DYNATRACE_PAT' })
    const noTenants = checker({ secrets: { ...rest, DYNATRACE_PAT: SECRETS.DYNATRACE_PAT } })
    expect(await noTenants.c.test('dynatrace')).toMatchObject({ status: 'not-configured', detail: 'needs DYNATRACE_TENANTS (e.g. prod=abc12345) or endpoints.dynatraceTenants' })
    expect(noToken.http.calls).toHaveLength(0)
    expect(noTenants.http.calls).toHaveLength(0)
  })

  it('a tenant id that is not a bare id is refused before ANY call, naming the label — never a host built from it', async () => {
    const hostile = [
      'abc12345.evil.com',
      'abc12345.apps.dynatrace.com',
      'abc/../x',
      'abc12345/evil',
      'abc12345@evil.com',
      'abc12345:443',
      'abc12345#x',
      'abc12345?x=1',
      'a',
      '-abc12345',
      'abc 12345',
      'abc_12345',
      'a'.repeat(64),
      'https://abc12345.apps.dynatrace.com',
    ]
    for (const bad of hostile) {
      for (const tenants of [`uat=${bad}`, JSON.stringify({ uat: bad })]) {
        const { c, http } = checker({ secrets: dt(tenants), reply: OK })
        const r = await c.test('dynatrace')
        expect(http.calls, `${bad} via ${tenants}`).toHaveLength(0)
        expect(r.status).toBe('not-configured')
        expect(r.detail).toContain('uat')
        expect(r.detail).not.toContain('evil')
      }
    }
    const config = checker({ secrets: { ...SECRETS, DYNATRACE_TENANTS: undefined }, config: { ...CONFIG, endpoints: { ...CONFIG.endpoints, dynatraceTenants: { prod: 'abc12345.evil.com' } } }, reply: OK })
    const r = await config.c.test('dynatrace')
    expect(config.http.calls).toHaveLength(0)
    expect(r).toMatchObject({ status: 'not-configured' })
    expect(r.detail).toContain('prod')
  })

  it('one bad tenant among good ones refuses the whole test — nothing is sent to the good ones either', async () => {
    const { c, http } = checker({ secrets: dt('prod=abc12345,uat=def67890.evil.com'), reply: OK })
    const r = await c.test('dynatrace')
    expect(http.calls).toHaveLength(0)
    expect(r.status).toBe('not-configured')
  })

  it('malformed tenant lists are not-configured: no "=", bad JSON, a JSON array, odd labels, too many', async () => {
    for (const tenants of ['abc12345', 'prod', '=abc12345', '{"prod":', '["abc12345"]', '{"prod":42}', 'pro d=abc12345', 'prod/x=abc12345', `${'x'.repeat(40)}=abc12345`]) {
      const { c, http } = checker({ secrets: dt(tenants), reply: OK })
      const r = await c.test('dynatrace')
      expect(http.calls, tenants).toHaveLength(0)
      expect(r.status, tenants).toBe('not-configured')
    }
    const many = Array.from({ length: 9 }, (_, i) => `e${i}=abc1234${i}`).join(',')
    const { c, http } = checker({ secrets: dt(many), reply: OK })
    expect((await c.test('dynatrace')).detail).toBe('at most 8 Dynatrace tenants')
    expect(http.calls).toHaveLength(0)
  })

  it('the same label twice keeps the last id (one probe)', async () => {
    const { c, http } = checker({ secrets: dt('prod=abc12345,prod=def67890'), reply: OK })
    await c.test('dynatrace')
    expect(http.calls.map((x) => new URL(x.url).hostname)).toEqual(['def67890.apps.dynatrace.com'])
  })

  it('every call goes to *.apps.dynatrace.com over https, whatever a response says', async () => {
    const answers = [
      { status: 202, body: JSON.stringify({ state: 'RUNNING', requestToken: 'abc', location: 'https://evil.example/', url: 'https://evil.example/x', next: 'https://evil.example/y' }) },
      { status: 200, body: JSON.stringify({ state: 'SUCCEEDED' }) },
    ]
    const { c, http } = checker({ secrets: dt('prod=abc12345,uat=def67890'), reply: (opts) => (opts.method === 'POST' ? answers[0] : answers[1]) })
    await c.test('dynatrace')
    expect(http.calls).toHaveLength(4)
    for (const call of http.calls) {
      const u = new URL(call.url)
      expect(u.protocol).toBe('https:')
      expect(u.hostname).toMatch(/^(abc12345|def67890)\.apps\.dynatrace\.com$/)
      expect(u.username + u.password + u.hash).toBe('')
      expect(u.pathname).toMatch(/^\/platform\/storage\/query\/v1\/query:(execute|poll)$/)
    }
  })

  it('a hostile request token stays inside the query string (it is encoded, never a path or host)', async () => {
    const hostileToken = '../../x?evil=1#frag&a=b'
    const answers = [{ status: 202, body: JSON.stringify({ state: 'RUNNING', requestToken: hostileToken }) }, OK]
    const { c, http } = checker({ reply: () => answers.shift() })
    await c.test('dynatrace')
    const u = new URL(http.calls[1].url)
    expect(u.hostname).toBe('abc12345.apps.dynatrace.com')
    expect(u.pathname).toBe('/platform/storage/query/v1/query:poll')
    expect(u.searchParams.get('request-token')).toBe(hostileToken)
    expect(u.hash).toBe('')
  })

  it('the probes run in parallel but one Test press is one result; a second press while one runs is busy', async () => {
    let release
    const gate = new Promise((r) => (release = r))
    const { c, http } = checker({ secrets: dt('prod=abc12345,uat=def67890'), reply: async () => (await gate, OK) })
    const first = c.test('dynatrace')
    await Promise.resolve()
    expect(await c.test('dynatrace')).toEqual({ busy: true })
    release()
    const r = await first
    expect(r.detail).toBe('2 tenants')
    expect(http.calls).toHaveLength(2)
    expect((await c.test('dynatrace')).status).toBe('ok')
  })

  it('the aggregate (not each probe) is what health records; a refused config records nothing', async () => {
    const seen = []
    const two = checker({ secrets: dt('prod=abc12345,uat=def67890'), reply: perTenant({ abc12345: OK, def67890: { status: 401, body: '{}' } }), recordHealth: async (s, o) => seen.push([s, o]) })
    await two.c.test('dynatrace')
    expect(seen).toHaveLength(1)
    expect(seen[0][0]).toBe('dynatrace')
    expect(seen[0][1]).toMatchObject({ ok: false, status: 'auth-failed', httpStatus: 401, detail: 'prod: OK · uat: token rejected' })
    const none = checker({ secrets: dt('prod=abc12345.evil.com'), recordHealth: async (s, o) => seen.push([s, o]) })
    await none.c.test('dynatrace')
    expect(seen).toHaveLength(1)
    noSecretIn(seen)
  })

  it('logs only the service and the status', async () => {
    const { c, logs } = checker({ reply: { status: 401, body: 'nope' } })
    await c.test('dynatrace')
    expect(logs).toEqual(['[keys] test dynatrace → auth-failed'])
  })
})

describe('TLS settings', () => {
  it('JIRA_INSECURE_TLS=1 relaxes only jira / confluence / bitbucket', async () => {
    const secrets = { ...SECRETS, JIRA_INSECURE_TLS: '1' }
    for (const [service, verified] of [['jira', false], ['confluence', false], ['bitbucket', false], ['jenkins', true], ['checkmarx', true], ['dynatrace', true], ['claude', true]]) {
      const { c, http } = checker({ secrets, reply: { status: 200, body: '{"access_token":"t"}' } })
      await c.test(service)
      expect(http.calls[0].tls.rejectUnauthorized).toBe(verified)
    }
  })

  it('JENKINS_INSECURE_TLS=1 relaxes Jenkins only; DYNATRACE_INSECURE_TLS=1 relaxes Dynatrace only', async () => {
    const jenkins = checker({ secrets: { ...SECRETS, JENKINS_INSECURE_TLS: '1' } })
    await jenkins.c.test('jenkins')
    expect(jenkins.http.calls[0].tls.rejectUnauthorized).toBe(false)
    const dynatraceUnderJenkins = checker({ secrets: { ...SECRETS, JENKINS_INSECURE_TLS: '1' } })
    await dynatraceUnderJenkins.c.test('dynatrace')
    expect(dynatraceUnderJenkins.http.calls[0].tls.rejectUnauthorized).toBe(true)
    for (const [service, relaxed] of [['dynatrace', false], ['jenkins', true], ['jira', true], ['checkmarx', true], ['claude', true]]) {
      const { c, http } = checker({ secrets: { ...SECRETS, DYNATRACE_INSECURE_TLS: '1' }, reply: { status: 200, body: '{"access_token":"t"}' } })
      await c.test(service)
      expect(http.calls[0].tls.rejectUnauthorized, service).toBe(relaxed)
    }
    // Every tenant's probe carries the relaxed setting, not just the first.
    const both = checker({ secrets: { ...SECRETS, DYNATRACE_TENANTS: 'prod=abc12345,uat=def67890', DYNATRACE_INSECURE_TLS: '1' } })
    await both.c.test('dynatrace')
    expect(both.http.calls).toHaveLength(2)
    expect(both.http.calls.every((x) => x.tls.rejectUnauthorized === false)).toBe(true)
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
