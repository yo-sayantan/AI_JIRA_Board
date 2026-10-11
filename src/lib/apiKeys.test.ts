import { describe, expect, it } from 'vitest'
import { API_SERVICES, canSave, keyCounts, missingRequired, serviceReady, type KeyStatus } from './apiKeys'

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
