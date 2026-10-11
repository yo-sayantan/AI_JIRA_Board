import { describe, expect, it } from 'vitest'
import raw from '../../jira-intern/demo/data.json'
import { bundledDemoDump, rebaseDemoDump } from './data'

const HOUR = 3_600_000
const DAY = 86_400_000
const NOW = Date.parse('2027-03-15T11:30:00Z')

describe('the demo folder', () => {
  it('is a dump the board can render, with an anchor to re-date it from', () => {
    expect(Array.isArray(raw.tickets)).toBe(true)
    expect(raw.tickets.length).toBeGreaterThan(25)
    expect(Date.parse(raw._demoNow)).not.toBeNaN()
  })

  it('uses Jira-shaped keys', () => {
    for (const t of raw.tickets) expect(t.key).toMatch(/^[A-Z][A-Z0-9]*-[\d-a-z]+$/)
  })
})

describe('rebaseDemoDump', () => {
  const d = rebaseDemoDump(raw, NOW)
  const byKey = (k: string) => d.tickets.find((t) => t.key === k)!

  it('drops the file metadata so only dump fields reach the board', () => {
    expect(d).not.toHaveProperty('_readme')
    expect(d).not.toHaveProperty('_demoNow')
    expect(d.tickets.length).toBe(raw.tickets.length)
  })

  it('keeps every offset from the anchor exactly', () => {
    const shift = NOW - Date.parse(raw._demoNow)
    const before = raw.tickets.find((t) => t.key === 'DEMO-250')!
    expect(Date.parse(byKey('DEMO-250').resolved!)).toBe(Date.parse(before.resolved!) + shift)
    // The dump reads as fetched 7h ago, whatever "now" is.
    expect((NOW - Date.parse(d.generatedAt!)) / HOUR).toBeCloseTo(7, 5)
  })

  it('keeps the Done card that is about to retire inside the board window', () => {
    const age = (NOW - Date.parse(byKey('DEMO-252').resolved!)) / DAY
    expect(age).toBeGreaterThan(4)
    expect(age).toBeLessThan(5) // DONE_BOARD_DAYS — still on the board, "archives in 1d"
  })

  it('re-dates the sprint labels, so one sprint is running and the next has not started', () => {
    const active = byKey('DEMO-201').sprint!
    const next = byKey('DEMO-270').sprint!
    const range = (s: string) => (s.match(/(\d{4}-\d{2}-\d{2}) → (\d{4}-\d{2}-\d{2})/) ?? []).slice(1).map((x) => Date.parse(`${x}T00:00:00Z`))
    const [aStart, aEnd] = range(active)
    const [nStart] = range(next)
    expect(aStart).toBeLessThan(NOW)
    expect(aEnd).toBeGreaterThan(NOW)
    expect(nStart).toBeGreaterThan(NOW)
  })

  it('shifts bare day stamps without turning them into timestamps', () => {
    for (const e of byKey('DEMO-201').updateLog ?? []) expect(e.when).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('leaves a dump with no anchor alone', () => {
    const out = rebaseDemoDump({ tickets: [], completed: [], generatedAt: '2020-01-01T00:00:00Z' }, NOW)
    expect(out.generatedAt).toBe('2020-01-01T00:00:00Z')
  })

  it('bundledDemoDump re-dates onto the clock it is given', () => {
    expect((NOW - Date.parse(bundledDemoDump(NOW).generatedAt!)) / HOUR).toBeCloseTo(7, 5)
  })
})
