import { describe, expect, it } from 'vitest'
import {
  API_GROUPS,
  API_SERVICES,
  HEALTH_COLOR,
  groupedServices,
  TEST_TONE_COLOR,
  canSave,
  healthTone,
  healthView,
  keyCounts,
  keysBadge,
  latestHealth,
  missingRequired,
  recordFromTest,
  servicePlanned,
  serviceReady,
  testBlocker,
  testResultView,
  visibleHealth,
  type HealthRecord,
  type KeyStatus,
  type KeyTestResult,
} from './apiKeys'

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

describe('service colours', () => {
  /** Hue in degrees of a #rrggbb colour (0 for greys). */
  const hue = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min
    if (d < 0.08) return { h: 0, grey: true }
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
    return { h: (h * 60 + 360) % 360, grey: false }
  }
  it('no service uses a red or red-orange colour — red is reserved for a rejected key', () => {
    for (const s of API_SERVICES) {
      const { h, grey } = hue(s.color)
      expect(grey || (h > 40 && h < 330), `${s.id} ${s.color} (hue ${Math.round(h)})`).toBe(true)
    }
  })
})

// ── Health: the permanent dot per service ───────────────────────────────────────────────────────

const NOW = Date.parse('2026-01-01T12:00:00Z')
const okRec = (over: Partial<HealthRecord> = {}): HealthRecord => ({ service: 'jira', state: 'ok', checkedAt: '2026-01-01T10:00:00Z', lastOkAt: '2026-01-01T10:00:00Z', detail: '', source: 'fetch', ...over })
const badRec = (status: HealthRecord['status'], over: Partial<HealthRecord> = {}): HealthRecord => ({
  service: 'jira',
  state: 'attention',
  checkedAt: '2026-01-01T11:30:00Z',
  failingSince: '2026-01-01T11:00:00Z',
  status,
  detail: '',
  source: 'fetch',
  ...over,
})

describe('healthTone (same mapping as _health.tone_of and health.mjs toneOf)', () => {
  it('green ok, red for a rejected or forbidden key, orange for everything else, none without a record', () => {
    expect(healthTone(okRec())).toBe('ok')
    expect(healthTone(badRec('auth-failed'))).toBe('key')
    expect(healthTone(badRec('forbidden'))).toBe('key')
    for (const s of ['unreachable', 'tls', 'not-found', 'error', undefined] as const) expect(healthTone(badRec(s))).toBe('attention')
    expect(healthTone(undefined)).toBe('none')
    expect(healthTone(null)).toBe('none')
    expect(healthTone({ ...okRec(), state: 'weird' as never })).toBe('none')
  })

  it('has the three colours the dialog uses', () => {
    expect(HEALTH_COLOR.ok).toBe('#17c47a')
    expect(HEALTH_COLOR.key).toBe('#e11d48')
    expect(HEALTH_COLOR.attention).toBe('#ff8a1f')
  })
})

describe('healthView', () => {
  it('ok: Working · last OK Xh ago', () => {
    const v = healthView(okRec(), NOW)
    expect(v.tone).toBe('ok')
    expect(v.label).toBe('Working')
    expect(v.detail).toBe('Working · last OK 2h ago')
    expect(v.color).toBe('#17c47a')
  })

  it('key rejected: red, with the code and since when', () => {
    const v = healthView(badRec('auth-failed', { httpStatus: 401 }), NOW)
    expect(v.tone).toBe('key')
    expect(v.label).toBe('Key rejected (401)')
    expect(v.detail).toMatch(/^Key rejected \(401\) since /)
    expect(v.color).toBe('#e11d48')
  })

  it('access denied is red too', () => {
    const v = healthView(badRec('forbidden', { httpStatus: 403 }), NOW)
    expect(v.tone).toBe('key')
    expect(v.label).toBe('Access denied (403)')
  })

  it('network, certificate, URL and server problems are orange "needs attention"', () => {
    expect(healthView(badRec('unreachable'), NOW).detail).toMatch(/^Needs attention · can't reach host since /)
    expect(healthView(badRec('tls'), NOW).label).toBe('Certificate not trusted')
    expect(healthView(badRec('not-found', { httpStatus: 404 }), NOW).label).toBe('Not found (404) — check the base URL')
    expect(healthView(badRec('error', { httpStatus: 503 }), NOW).label).toBe('Server error (503)')
    for (const s of ['unreachable', 'tls', 'not-found', 'error'] as const) {
      const v = healthView(badRec(s), NOW)
      expect(v.tone).toBe('attention')
      expect(v.color).toBe('#ff8a1f')
    }
  })

  it('mentions the last good time when there was one', () => {
    expect(healthView(badRec('unreachable', { lastOkAt: '2026-01-01T09:00:00Z' }), NOW).detail).toContain('last OK 3h ago')
    expect(healthView(badRec('unreachable'), NOW).detail).not.toContain('last OK')
  })

  it('no record: none, with a message and no colour dot', () => {
    const v = healthView(undefined, NOW)
    expect(v.tone).toBe('none')
    expect(v.label).toBe('Not called yet')
    expect(v.color).toBeNull()
  })

  it('never shows a URL query or secret-looking text from a hand-edited record', () => {
    const v = healthView(badRec('error', { detail: 'https://x.example/a?token=abc' }), NOW)
    expect(JSON.stringify(v)).not.toContain('abc')
  })
})

describe('recordFromTest', () => {
  const t = (status: KeyTestResult['status'], httpStatus?: number): KeyTestResult => ({ ok: status === 'ok', service: 'jira', status, httpStatus, ms: 5, detail: 'x' })
  it('maps a finished Test onto the same record shape (not-configured made no call)', () => {
    expect(healthTone(recordFromTest(t('ok'), NOW)!)).toBe('ok')
    expect(healthTone(recordFromTest(t('auth-failed', 401), NOW)!)).toBe('key')
    expect(healthTone(recordFromTest(t('unreachable'), NOW)!)).toBe('attention')
    expect(recordFromTest(t('not-configured'), NOW)).toBeNull()
    expect(recordFromTest(t('ok'), NOW)!.source).toBe('test')
  })
})

describe('latestHealth', () => {
  it('the newer of the server record and this session\'s Test wins', () => {
    const server = okRec({ checkedAt: '2026-01-01T10:00:00Z' })
    const test = badRec('auth-failed', { source: 'test', checkedAt: '2026-01-01T11:59:00Z' })
    expect(latestHealth(server, test)).toBe(test)
    expect(latestHealth(okRec({ checkedAt: '2026-01-01T11:59:30Z' }), test)?.state).toBe('ok')
    expect(latestHealth(undefined, test)).toBe(test)
    expect(latestHealth(server, null)).toBe(server)
    expect(latestHealth(undefined, null)).toBeUndefined()
  })
})

describe('visibleHealth + keysBadge', () => {
  const keys: KeyStatus = { JIRA_PERSONAL_TOKEN: { set: true, masked: 'x' }, CHECKMARX_API_KEY: { set: true, masked: 'x' } }
  const health = {
    jira: badRec('auth-failed', { service: 'jira' }),
    checkmarx: badRec('unreachable', { service: 'checkmarx' }),
    bitbucket: badRec('error', { service: 'bitbucket' }), // no key saved: a stale record is hidden
    claude: okRec({ service: 'claude' }),
  }

  it('only services with keys saved show their record', () => {
    expect(Object.keys(visibleHealth(health, keys, false)).sort()).toEqual(['checkmarx', 'jira'])
  })

  it('without the key list yet, nothing shows (no false alarm)', () => {
    expect(visibleHealth(health, null, false)).toEqual({})
  })

  it('demo mode shows its constant health whatever is saved', () => {
    expect(Object.keys(visibleHealth(health, null, true)).sort()).toEqual(['bitbucket', 'checkmarx', 'claude', 'jira'])
  })

  it('badge: red beats orange; counts both; null when all is well', () => {
    const b = keysBadge(visibleHealth(health, keys, false))
    expect(b).toEqual({ key: 1, attention: 1, color: '#e11d48', label: '1 key rejected, 1 needs attention' })
    expect(keysBadge({ checkmarx: health.checkmarx })).toMatchObject({ key: 0, attention: 1, color: '#ff8a1f', label: '1 needs attention' })
    expect(keysBadge({ jira: okRec() })).toBeNull()
    expect(keysBadge({})).toBeNull()
  })

  it('plural wording', () => {
    expect(keysBadge({ a: badRec('forbidden'), b: badRec('auth-failed'), c: badRec('tls'), d: badRec('error') })?.label).toBe('2 keys rejected, 2 need attention')
  })
})
