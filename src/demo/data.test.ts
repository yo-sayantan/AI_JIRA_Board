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

  it('names every ticket in the folder listing', () => {
    // tickets/ is generated from data.json by `npm run demo:split`; keys must stay file-safe.
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

describe('demo builds', () => {
  const d = rebaseDemoDump(raw, NOW)
  const all = d.tickets.flatMap((t) => (t.builds ?? []).map((b) => ({ key: t.key, ...b })))

  it('shows every Jenkins build state', () => {
    expect(new Set(all.map((b) => b.result))).toEqual(new Set(['SUCCESS', 'FAILURE', 'UNSTABLE', 'BUILDING', 'ABORTED', 'NOT_BUILT']))
  })

  it('has a failure with its stage and failing tests, a green build with tests, and a ticket with two environments', () => {
    expect(all.some((b) => b.result === 'FAILURE' && b.failedStage && (b.tests?.failing?.length ?? 0) > 0)).toBe(true)
    expect(all.some((b) => b.result === 'SUCCESS' && (b.tests?.total ?? 0) > 0)).toBe(true)
    expect(d.tickets.some((t) => new Set((t.builds ?? []).map((b) => b.env)).size >= 2)).toBe(true)
    expect(all.some((b) => b.deployTarget && b.deployTarget !== b.env)).toBe(true)
  })

  it('re-dates build times with everything else', () => {
    const shift = NOW - Date.parse(raw._demoNow)
    const before = raw.tickets.find((t) => t.key === 'DEMO-220')!.builds![0]
    const after = all.find((b) => b.key === 'DEMO-220' && b.env === before.env)!
    expect(Date.parse(after.at!)).toBe(Date.parse(before.at!) + shift)
  })

  it('only builds of the ticket branch, with links that stay on the example host', () => {
    for (const t of d.tickets)
      for (const b of t.builds ?? []) {
        expect([...(t.branches ?? []), t.branch]).toContain(b.branch)
        expect(b.url).toMatch(/^https:\/\/jenkins\.example\.com\//)
      }
  })
})

describe('demo vulnerability fixes (Checkmarx)', () => {
  const d = rebaseDemoDump(raw, NOW)
  const withVf = d.tickets.filter((t) => t.vulnFixes)
  const items = withVf.flatMap((t) => t.vulnFixes!.items.map((i) => ({ key: t.key, ...i })))

  it('shows every status and every kind of target', () => {
    expect(new Set(items.map((i) => i.status))).toEqual(new Set(['fixed', 'open', 'not-found', 'unknown']))
    expect(new Set(items.map((i) => i.kind))).toEqual(new Set(['cve', 'sast', 'result', 'package']))
    expect(withVf.length).toBeGreaterThanOrEqual(3)
  })

  it('only on vulnerability-fix tickets, comparing the ticket branch, naming what the ticket names', () => {
    for (const t of withVf) {
      expect(t.vulnFixes!.branch).toBe(t.branch)
      const text = `${t.title} ${t.description ?? ''}`
      for (const i of t.vulnFixes!.items)
        for (const part of i.target.replace(/^result /, '').split(' ').filter((p) => p !== '→')) expect(text).toContain(part)
    }
  })

  it('re-dates scan times with everything else and keeps a not-scanned branch as null', () => {
    const shift = NOW - Date.parse(raw._demoNow)
    const before = raw.tickets.find((t) => t.key === 'DEMO-230')!.vulnFixes!
    const after = d.tickets.find((t) => t.key === 'DEMO-230')!.vulnFixes!
    expect(Date.parse(after.branchScanAt!)).toBe(Date.parse(before.branchScanAt!) + shift)
    expect(withVf.some((t) => t.vulnFixes!.branchScanAt === null && t.vulnFixes!.note)).toBe(true)
  })

  it('links stay on the example tenant', () => {
    for (const t of withVf) expect(t.description ?? '').not.toMatch(/https?:\/\/(?!your-tenant\.cxone\.cloud|[\w.-]*example\.com)/)
  })
})
