import { describe, expect, it } from 'vitest'
import { healthTone } from '../lib/apiKeys'
import { demoKeyHealth } from './health'

describe('demoKeyHealth', () => {
  it('shows each colour and is the same object on every call', () => {
    const h = demoKeyHealth(Date.parse('2026-01-01T12:00:00Z'))
    const tones = Object.values(h).map(healthTone)
    expect(tones.filter((t) => t === 'ok').length).toBeGreaterThanOrEqual(3)
    expect(tones.filter((t) => t === 'attention')).toHaveLength(1)
    expect(tones.filter((t) => t === 'key')).toHaveLength(1)
    expect(demoKeyHealth(Date.now() + 1e9)).toBe(h)
  })

  it('has Dynatrace green, so its dot shows a service the fetch reads fine', () => {
    const h = demoKeyHealth(Date.parse('2026-01-01T12:00:00Z'))
    expect(healthTone(h.dynatrace)).toBe('ok')
    expect(h.dynatrace).toMatchObject({ service: 'dynatrace', state: 'ok', source: 'fetch' })
  })
})
