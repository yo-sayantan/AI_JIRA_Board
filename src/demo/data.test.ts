import { describe, expect, it } from 'vitest'
import raw from '../../jira-intern/demo/data.json'
import { bundledDemoDump, rebaseDemoDump } from './data'
import type { Ticket } from '../types'
import { loadData } from '../data'
import { countMyCompleted, countRaised, indexByKey } from '../lib/boardView'
import { cardBranches, cycleTime, effectiveType, futureSprintOf, isNextSprint, prListOf, priorityMeta, releaseEnvOf, typeMeta, unwrapBrief, yearOf } from '../lib/format'
import { matches, parseQuery } from '../lib/search'

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

describe('the demo board covers every rendering scenario', () => {
  const d = rebaseDemoDump(raw, NOW)
  const all = d.tickets.flatMap(function flat(t): Ticket[] { return [t, ...(t.subtasks ?? []).flatMap(flat)] })
  const byKey = (k: string) => d.tickets.find((t) => t.key === k)!
  const prs = all.flatMap((t) => prListOf(t))

  it('has every priority tier, Critical down to unprioritised', () => {
    const ranks = new Set(d.tickets.map((t) => priorityMeta(t.priority).rank))
    for (let r = 0; r <= 6; r++) expect(ranks, `rank ${r}`).toContain(r)
  })

  it('has every issue-type glyph the board draws, the derived Release and Onboarding included', () => {
    const glyphs = new Set(all.map((t) => typeMeta(effectiveType(t)).glyph))
    for (const type of ['Bug', 'Security', 'Requirement', 'Dev Task', 'QA Task', 'Incident', 'Story', 'Epic', 'Sub-task', 'Spike', 'Improvement', 'Tech Debt', 'Release', 'Onboarding', 'Task', 'Something else']) {
      expect(glyphs, type).toContain(typeMeta(type).glyph)
    }
  })

  it('splits Next Sprint into a dated sprint, READY and REFINEMENT — and leaves another undated future sprint in To Do', () => {
    const next = d.tickets.filter((t) => isNextSprint(t, NOW)).map((t) => futureSprintOf(t.sprint, NOW)!)
    expect(next.some((s) => s.start != null)).toBe(true)
    expect(next.some((s) => /\bREADY\b/.test(s.name))).toBe(true)
    expect(next.some((s) => /\bREFINEMENT\b/.test(s.name))).toBe(true)
    const parked = byKey('DEMO-207')
    expect(futureSprintOf(parked.sprint, NOW)).not.toBeNull()
    expect(isNextSprint(parked, NOW)).toBe(false)
  })

  it('retires an old Done ticket into Completed and keeps a recent one, closed or cancelled, on the board', () => {
    const { data } = loadData(bundledDemoDump(), new Set())
    expect(data.tickets.some((t) => t.key === 'DEMO-254')).toBe(false)
    expect(data.completed.some((c) => c.key === 'DEMO-254')).toBe(true)
    const doneStatuses = new Set(data.tickets.filter((t) => t.column === 'done').map((t) => t.status))
    for (const s of ['Done', 'Closed', 'Resolved', 'Cancelled']) expect(doneStatuses).toContain(s)
  })

  it('keeps my sub-task under a team-mate’s ticket as its own card too', () => {
    const own = byKey('DEMO-223-1')
    expect(own.parentKey).toBe('DEMO-223')
    expect(byKey('DEMO-223').subtasks!.some((s) => s.key === 'DEMO-223-1')).toBe(true)
    expect(indexByKey(d).get('DEMO-223-1')).toBe(own) // the standalone card wins the index
  })

  it('covers the drawer’s optional sections', () => {
    expect(all.some((t) => t.estDays)).toBe(true)
    expect(all.some((t) => t.aiSummary && t.parentKey)).toBe(true) // a sub-task's short brief
    const wrapped = all.find((t) => t.aiSummary?.trim().startsWith('{'))! // a model's {"html": …} brief, healed at render
    expect(unwrapBrief(wrapped.aiSummary)).toMatch(/^</)
    for (const k of ['proposedSolution', 'effortEstimate', 'openQuestions', 'confluence', 'externalLinks', 'sources', 'acceptanceCriteria', 'comments'] as const) {
      expect(all.some((t) => (Array.isArray(t[k]) ? (t[k] as unknown[]).length : t[k])), k).toBeTruthy()
    }
  })

  it('has a parent card with branches but no PR, so the card shows only the newest branch', () => {
    const t = byKey('DEMO-225')
    expect(prListOf(t)).toHaveLength(0)
    expect(cardBranches(t)).toMatchObject({ shown: t.branch, more: 0 })
    expect((t.branches ?? []).length).toBeGreaterThan(1)
  })

  it('gives every search form something to find', () => {
    const find = (q: string) => d.tickets.filter((t) => matches(t, parseQuery(q))).map((t) => t.key)
    expect(find('230')).toContain('DEMO-230') // a bare ticket number
    expect(find('23')).toEqual(expect.arrayContaining(['DEMO-230', 'DEMO-237'])) // a number prefix
    expect(find('425')).toEqual(['DEMO-230']) // a PR number
    expect(find('demo230')).toContain('DEMO-230') // a key without the hyphen
    expect(find('223')).toEqual(expect.arrayContaining(['DEMO-223', 'DEMO-223-1'])) // a parent pulls its sub-ticket
    expect(find('okafor qa-failed')).toEqual(['DEMO-244']) // free text, AND across fields
    expect(find('demo-infra')).toContain('DEMO-220') // a repository
    expect(prs.some((p) => p.repo && p.repo !== 'demo-service')).toBe(true)
  })

  it('spreads the Completed archive over three years, with releases, onboarding and measurable cycle times', () => {
    const years = new Set(d.completed.map((c) => yearOf(c.resolved)))
    expect(years.size).toBeGreaterThanOrEqual(3)
    const envs = new Set(d.completed.filter((c) => effectiveType(c) === 'Release').map((c) => releaseEnvOf(c)?.label))
    for (const e of ['Prod', 'Stage', 'Demo']) expect(envs, e).toContain(e)
    expect(d.completed.some((c) => effectiveType(c) === 'Onboarding')).toBe(true)
    expect(d.completed.filter((c) => cycleTime(c, NOW).devDays > 0).length).toBeGreaterThan(5)
    expect(d.completed.some((c) => prListOf(c).some((p) => p.state === 'declined'))).toBe(true)
  })

  it('archives my sub-task under a team-mate’s parent as its own row, and leaves it out of my count', () => {
    const row = d.completed.find((c) => c.parentKey === 'DEMO-170')!
    expect(row.mine).not.toBe(false)
    expect(d.completed.find((c) => c.key === 'DEMO-170')!.mine).toBe(false) // the context parent
    expect(countMyCompleted(d)).toBe(d.completed.filter((c) => c.mine !== false && !c.parentKey).length)
  })

  it('fills every Raised-by-me status bucket, with briefs, links and two years of history', () => {
    const cols = new Set((d.raised ?? []).map((r) => r.column))
    for (const c of ['todo', 'blocked', 'hold', 'prog', 'rev', 'qa', 'done']) expect(cols, c).toContain(c)
    expect((d.raised ?? []).some((r) => r.aiSummary)).toBe(true)
    expect((d.raised ?? []).some((r) => (r.related ?? []).length > 0)).toBe(true)
    expect((d.raised ?? []).some((r) => r.epic)).toBe(true)
    expect(new Set((d.raised ?? []).map((r) => yearOf(r.created))).size).toBeGreaterThanOrEqual(2)
    expect(countRaised(d).open).toBeLessThan(countRaised(d).total)
  })
})
