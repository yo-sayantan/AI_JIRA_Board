import { describe, expect, it } from 'vitest'
import raw from '../../jira-intern/demo/data.json'
import { rebaseDemoDump } from './data'
import { lastFetchView, proofNoteOf, vulnReadLine } from '../lib/proofStatus'
import { dynatraceOf } from '../lib/format'
import type { JiraData } from '../types'

const NOW = Date.parse('2027-03-15T11:30:00Z')

describe('demo · proof sources and what Checkmarx read', () => {
  const d = rebaseDemoDump(raw, NOW)
  const withVf = d.tickets.filter((t) => t.vulnFixes)
  const items = withVf.flatMap((t) => t.vulnFixes!.items)

  it('the Checkmarx "last fetch" record is what the demo tickets add up to', () => {
    const st = d.proofSources!.checkmarx
    expect(st.state).toBe('read')
    expect(st.looked).toBe(withVf.length)
    const count = (s: string) => items.filter((i) => i.status === s).length
    expect(st.counts).toEqual({ fixed: count('fixed'), open: count('open'), 'not-found': count('not-found'), unknown: count('unknown') })
    expect(st.detail).toContain(`${withVf.length} vulnerability-fix tickets looked up (${items.length} targets`)
  })

  it('is re-dated with the rest, so the key window says "just now" ish, not years ago', () => {
    const view = lastFetchView(d.proofSources!.checkmarx, NOW)
    expect(view.text).toMatch(/· \d+h ago$|· just now$|· \d+m ago$/)
  })

  it('shows what each scan returned, and a "not found" that says how much was read', () => {
    const t = d.tickets.find((x) => x.key === 'DEMO-230')!
    expect(vulnReadLine(t.vulnFixes!)).toMatch(/^Read 214 results on the branch scan \(SCA 171 · SAST 36 · other 7\); 219 on the base scan/)
    const pkg = t.vulnFixes!.items.find((i) => i.kind === 'package')!
    expect(pkg.foundOnBase).toEqual(['8.5.1'])
    const nf = items.find((i) => i.status === 'not-found')!
    expect(nf.detail).toMatch(/Read \d+ results on/)
  })

  it('what was read never exceeds what the server reported', () => {
    for (const t of withVf)
      for (const side of [t.vulnFixes!.read?.branch, t.vulnFixes!.read?.base])
        if (side) {
          expect(side.total).toBe(side.sca + side.sast + side.other)
          expect(side.reported ?? side.total).toBeGreaterThanOrEqual(side.total)
        }
  })
})

describe('demo · proof sources and what Dynatrace read', () => {
  const d = rebaseDemoDump(raw, NOW)
  const withDt = d.tickets.filter((t) => t.dynatrace)
  const items = withDt.flatMap((t) => t.dynatrace!.items.map((i) => ({ key: t.key, ...i })))
  // Links that got an answer this run (a failed lookup is carried forward, not counted)
  const answered = items.filter((i) => i.status === 'read' || i.status === 'empty' || i.status === 'unconfigured-tenant')
  const count = (s: string) => answered.filter((i) => i.status === s).length

  it('the Dynatrace "last fetch" record is what the demo tickets add up to', () => {
    const st = d.proofSources!.dynatrace
    expect(st.state).toBe('read')
    const looked = new Set(answered.map((i) => i.key)).size
    expect(st.looked).toBe(looked)
    expect(st.counts).toEqual({ read: count('read'), empty: count('empty'), 'unconfigured-tenant': count('unconfigured-tenant') })
    const failed = new Set(items.filter((i) => i.status === 'read' && (i.summary?.failedSpans ?? 0) > 0).map((i) => i.key)).size
    expect(st.detail).toBe(
      `Dynatrace: ${looked} tickets looked up (${answered.length} links: ${count('read')} read · ${count('empty')} empty · ${count('unconfigured-tenant')} unconfigured tenant) — ${failed} with failed requests`,
    )
  })

  it('is re-dated with the rest, so the key window says "just now" ish, not years ago', () => {
    expect(lastFetchView(d.proofSources!.dynatrace, NOW).text).toMatch(/· \d+h ago$|· just now$|· \d+m ago$/)
  })

  it('every Dynatrace stamp moves with the dump: when it was read, the window, the problem, the ticket note', () => {
    const shift = NOW - Date.parse(raw._demoNow)
    const rawTickets = (raw as unknown as JiraData).tickets
    const before = rawTickets.find((t) => t.key === 'DEMO-210')!.dynatrace!
    const after = d.tickets.find((t) => t.key === 'DEMO-210')!.dynatrace!
    expect(Date.parse(after.fetchedAt)).toBe(Date.parse(before.fetchedAt) + shift)
    for (const [i, a] of after.items.entries()) {
      const b = before.items[i]
      expect(Date.parse(a.fetchedAt!)).toBe(Date.parse(b.fetchedAt!) + shift)
      expect(Date.parse(a.window!.from)).toBe(Date.parse(b.window!.from) + shift)
      expect(Date.parse(a.window!.to)).toBe(Date.parse(b.window!.to) + shift)
    }
    const prob = after.items.find((i) => i.kind === 'problem')!.summary!.problems![0]
    const probBefore = before.items.find((i) => i.kind === 'problem')!.summary!.problems![0]
    expect(Date.parse(prob.start!)).toBe(Date.parse(probBefore.start!) + shift)
    expect(Date.parse(prob.end!)).toBe(Date.parse(probBefore.end!) + shift)
    const note = d.tickets.find((t) => t.key === 'DEMO-213')!.proofNotes!.dynatrace!
    const noteBefore = rawTickets.find((t) => t.key === 'DEMO-213')!.proofNotes!.dynatrace!
    expect(Date.parse(note.at)).toBe(Date.parse(noteBefore.at) + shift)
    expect(Date.parse(d.proofSources!.dynatrace.at)).toBe(Date.parse(raw.proofSources.dynatrace.at) + shift)
    // …and a read is never "in the future" of the board's clock
    for (const i of items) if (i.fetchedAt) expect(Date.parse(i.fetchedAt)).toBeLessThanOrEqual(NOW)
  })

  it('the stale answer is older than the run, and its ticket says why', () => {
    const t = d.tickets.find((x) => x.key === 'DEMO-213')!
    const stale = t.dynatrace!.items.filter((i) => i.stale)
    expect(stale).toHaveLength(1)
    expect(Date.parse(stale[0].fetchedAt!)).toBeLessThan(Date.parse(t.dynatrace!.fetchedAt))
    expect(stale[0].findings.length).toBeGreaterThan(0) // the earlier answer is kept
    expect(proofNoteOf(t, 'dynatrace')).toMatchObject({ state: 'unreachable' })
    // a ticket whose links were all answered carries no note
    for (const o of withDt.filter((x) => x.key !== 'DEMO-213')) expect(proofNoteOf(o, 'dynatrace')).toBeNull()
  })

  it('every item reads back through the board’s own filter', () => {
    for (const t of withDt) expect(dynatraceOf(t)!.items).toHaveLength(t.dynatrace!.items.length)
  })
})
