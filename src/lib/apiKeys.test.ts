import { describe, expect, it } from 'vitest'
import { API_GROUPS, API_SERVICES, groupedServices, TEST_TONE_COLOR, canSave, keyCounts, missingRequired, servicePlanned, serviceReady, testBlocker, testResultView, type KeyStatus } from './apiKeys'

const jira = API_SERVICES.find((s) => s.id === 'jira')!
const bitbucket = API_SERVICES.find((s) => s.id === 'bitbucket')!
const unset = { set: false, masked: '' }

describe('API_SERVICES', () => {
  it('comes from setup/api-keys.json, Jira first and required', () => {
    expect(API_SERVICES[0].id).toBe('jira')
    expect(jira.required).toBe(true)
    expect(jira.keys.map((k) => k.env)).toContain('JIRA_PERSONAL_TOKEN')
  })
})

describe('serviceReady', () => {
  it('needs every non-optional key of the service', () => {
    expect(serviceReady(jira, { JIRA_PERSONAL_TOKEN: { set: true, masked: 'abcd••••••••wxyz' } })).toBe(true)
    expect(serviceReady(jira, { JIRA_URL: { set: true, masked: 'https://j' } })).toBe(false)
  })

  it('an optional alternative alone does not light the service', () => {
    expect(serviceReady(bitbucket, { ATLASSIAN_TOKEN: { set: true, masked: 'x' } })).toBe(false)
  })

  it('no status yet means not ready', () => {
    expect(serviceReady(jira, null)).toBe(false)
  })
})

describe('planned services', () => {
  it('a service whose keys are all planned is marked as not used yet', () => {
    const github = API_SERVICES.find((s) => s.id === 'github')!
    expect(servicePlanned(github)).toBe(true)
    expect(servicePlanned(jira)).toBe(false)
  })
})

describe('missingRequired', () => {
  it('lists required services that are not ready', () => {
    expect(missingRequired({}).map((s) => s.id)).toEqual(['jira'])
    expect(missingRequired({ JIRA_PERSONAL_TOKEN: { set: true, masked: 'x' } })).toEqual([])
  })

  it('says nothing before the status has loaded', () => {
    expect(missingRequired(null)).toEqual([])
  })
})

describe('keyCounts', () => {
  it('counts ready services out of all of them', () => {
    const status: KeyStatus = { JIRA_PERSONAL_TOKEN: { set: true, masked: 'x' }, GEMINI_API_KEY: { set: true, masked: 'y' } }
    expect(keyCounts(status)).toEqual({ ready: 2, total: API_SERVICES.length })
  })
})

describe('canSave', () => {
  const saved = { set: true, masked: 'abcd••••••••wxyz' }
  it('is off for an empty box', () => {
    expect(canSave('', unset, true)).toBe(false)
    expect(canSave('   ', saved, true)).toBe(false)
  })

  it('a secret: on once anything is typed (the mask is only the placeholder)', () => {
    expect(canSave('tok-1', unset, true)).toBe(true)
    expect(canSave('new-token', saved, true)).toBe(true)
  })

  it('never saves a value containing mask bullets', () => {
    expect(canSave('abcd••••••••wxyz', saved, true)).toBe(false)
    expect(canSave('abcd••••••••wxyzEXTRA', saved, true)).toBe(false)
  })

  it('a URL: off while it still equals the saved one (whitespace aside), on once changed', () => {
    const url = { set: true, masked: 'https://j.example' }
    expect(canSave(' https://j.example ', url, false)).toBe(false)
    expect(canSave('https://k.example', url, false)).toBe(true)
  })
})

describe('testability', () => {
  const svc = (id: string) => API_SERVICES.find((s) => s.id === id)!
  const set = { set: true, masked: 'x' }

  it('needs every non-optional key that is not a URL (the config can supply a URL)', () => {
    expect(testBlocker(jira, {})).toMatch(/Personal access token/)
    expect(testBlocker(jira, { JIRA_PERSONAL_TOKEN: set })).toBeNull()
    expect(testBlocker(svc('checkmarx'), { CHECKMARX_API_KEY: set })).toBeNull()
    expect(testBlocker(svc('jenkins'), { JENKINS_API_TOKEN: set })).toMatch(/User name/)
  })

  it('Bitbucket can test with the Atlassian token instead of its own', () => {
    expect(testBlocker(bitbucket, { ATLASSIAN_TOKEN: set })).toBeNull()
    expect(testBlocker(bitbucket, {})).not.toBeNull()
  })

  it('a planned-only service (GitHub) is testable once its key is saved', () => {
    expect(testBlocker(svc('github'), { GITHUB_TOKEN: set })).toBeNull()
    expect(testBlocker(svc('github'), {})).not.toBeNull()
  })

  it('no status yet blocks the test', () => {
    expect(testBlocker(jira, null)).not.toBeNull()
  })
})

describe('testResultView', () => {
  const base = { service: 'jira', ms: 240 }
  it('ok: green, connected, detail and time', () => {
    const v = testResultView({ ...base, ok: true, status: 'ok', httpStatus: 200, detail: 'Signed in as Ada' })
    expect(v.tone).toBe('ok')
    expect(v.text).toBe('✓ Connected · Signed in as Ada · 240 ms')
  })

  it('auth-failed: red with the HTTP code', () => {
    const v = testResultView({ ...base, ok: false, status: 'auth-failed', httpStatus: 401, detail: 'Key rejected' })
    expect(v).toMatchObject({ tone: 'bad', text: '✗ Key rejected (401)' })
  })

  it('forbidden / not-found: red', () => {
    expect(testResultView({ ...base, ok: false, status: 'forbidden', httpStatus: 403, detail: '' })).toMatchObject({ tone: 'bad', text: '✗ Access denied (403)' })
    expect(testResultView({ ...base, ok: false, status: 'not-found', httpStatus: 404, detail: '' }).text).toMatch(/404/)
  })

  it('unreachable / tls: amber', () => {
    const v = testResultView({ ...base, ok: false, status: 'unreachable', detail: "Can't reach jira.x (ECONNREFUSED)" })
    expect(v.tone).toBe('warn')
    expect(v.text).toBe("Can't reach host")
    expect(v.title).toContain('ECONNREFUSED')
    expect(testResultView({ ...base, ok: false, status: 'tls', detail: 'Certificate…' }).tone).toBe('warn')
  })

  it('not-configured: grey with the reason', () => {
    expect(testResultView({ ...base, ok: false, status: 'not-configured', detail: 'needs email + site URL' })).toMatchObject({
      tone: 'idle',
      text: 'Not configured: needs email + site URL',
    })
  })

  it('error: red with the detail', () => {
    expect(testResultView({ ...base, ok: false, status: 'error', httpStatus: 302, detail: 'Redirected to sso.x' })).toMatchObject({ tone: 'bad', text: '✗ Redirected to sso.x' })
  })

  it('every tone has a colour', () => {
    for (const t of ['ok', 'bad', 'warn', 'idle'] as const) expect(TEST_TONE_COLOR[t]).toMatch(/^#/)
  })
})

describe('grouped, alphabetical, readable', () => {
  it('every service belongs to a known group', () => {
    const ids = new Set(API_GROUPS.map((g) => g.id))
    for (const s of API_SERVICES) expect(ids.has(s.group), s.id).toBe(true)
  })
  it('groups come in registry order, services alphabetically inside each', () => {
    const grouped = groupedServices()
    expect(grouped.map((g) => g.group.id)).toEqual(API_GROUPS.map((g) => g.id).filter((id) => API_SERVICES.some((s) => s.group === id)))
    for (const { services } of grouped) {
      const names = services.map((s) => s.name)
      expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)))
    }
    expect(grouped.flatMap((g) => g.services)).toHaveLength(API_SERVICES.length)
  })
  it('the one-line summary is short enough not to truncate; the full text is in details', () => {
    for (const s of API_SERVICES) {
      expect(s.why.length, s.id).toBeLessThanOrEqual(44)
      expect(s.details.length, s.id).toBeGreaterThan(0)
    }
  })
})
