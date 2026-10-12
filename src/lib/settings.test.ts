import { describe, expect, it } from 'vitest'
import { AI_LEVELS, DEFAULT_SETTINGS, effortForLevel, mergeServerSettings, parseSettings, serverSettingsOf } from './settings'

describe('parseSettings', () => {
  it('falls back for an invalid aiLevel', () => {
    expect(parseSettings({ aiLevel: 'ultra' }).aiLevel).toBe(DEFAULT_SETTINGS.aiLevel)
  })
  it('offers exactly Low · Medium · High · Max', () => {
    expect(AI_LEVELS.map((l) => l.label)).toEqual(['Low', 'Medium', 'High', 'Max'])
    expect(parseSettings({ aiLevel: 'high' }).aiLevel).toBe('high')
  })
  it('turns the retired "none" level into the AI switch being off', () => {
    const s = parseSettings({ aiLevel: 'none' })
    expect(s.aiEnabled).toBe(false)
    expect(s.aiLevel).toBe(DEFAULT_SETTINGS.aiLevel)
  })
  it('has both master switches on by default and keeps a saved off', () => {
    expect(DEFAULT_SETTINGS.aiEnabled).toBe(true)
    expect(DEFAULT_SETTINGS.jobsEnabled).toBe(true)
    const s = parseSettings({ aiEnabled: false, jobsEnabled: false })
    expect([s.aiEnabled, s.jobsEnabled]).toEqual([false, false])
  })
  it('mirrors both switches to the server and reads them back', () => {
    const sent = serverSettingsOf({ ...DEFAULT_SETTINGS, aiEnabled: false, jobsEnabled: false })
    expect(sent.aiEnabled).toBe(false)
    expect(sent.jobsEnabled).toBe(false)
    expect(mergeServerSettings(DEFAULT_SETTINGS, { aiEnabled: false, jobsEnabled: false }).jobsEnabled).toBe(false)
    expect(mergeServerSettings(DEFAULT_SETTINGS, { aiEnabled: 'x' }).aiEnabled).toBe(true)
  })
  it('derives cloud effort from the level', () => {
    expect(AI_LEVELS.map((l) => effortForLevel(l.key))).toEqual(['low', 'medium', 'high', 'high'])
  })
  it('falls back for a model id with shell characters', () => {
    expect(parseSettings({ aiLocalModel: 'bad model;rm' }).aiLocalModel).toBe(DEFAULT_SETTINGS.aiLocalModel)
  })
  it('keeps valid values', () => {
    const s = parseSettings({ aiLevel: 'low', aiBackend: 'cloud', theme: 'light', aiLocalModel: 'llama3.1:8b' })
    expect(s.aiLevel).toBe('low')
    expect(s.aiBackend).toBe('cloud')
    expect(s.theme).toBe('light')
    expect(s.aiLocalModel).toBe('llama3.1:8b')
  })
  it('coerces feature flags to booleans and ignores unknown keys', () => {
    const key = Object.keys(DEFAULT_SETTINGS.features)[0]
    const s = parseSettings({ features: { [key]: 'yes', bogus: true } })
    expect(s.features[key as keyof typeof s.features]).toBe(DEFAULT_SETTINGS.features[key as keyof typeof s.features])
    expect('bogus' in s.features).toBe(false)
    const off = parseSettings({ features: { [key]: false } })
    expect(off.features[key as keyof typeof off.features]).toBe(false)
  })
  it('returns defaults for a non-object', () => {
    expect(parseSettings('nope')).toEqual(DEFAULT_SETTINGS)
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS)
  })
})
