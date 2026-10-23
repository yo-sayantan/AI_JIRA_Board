import { describe, expect, it } from 'vitest'
import raw from '../../jira-intern/demo/data.json'
import { bundledDemoDump, rebaseDemoDump } from './data'
import type { Ticket } from '../types'
import { loadData } from '../data'
import { countMyCompleted, countRaised, indexByKey } from '../lib/boardView'
import { consoleTailLines, dynatraceKindLabel, dynatraceSummary, cardBranches, cardBuilds, cycleTime, effectiveType, futureSprintOf, isNextSprint, prListOf, priorityMeta, releaseEnvOf, typeMeta, unwrapBrief, yearOf } from '../lib/format'
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

  it('has an environment with a build pipeline next to a deploy pipeline, both kinds, and both ways of finding a branch', () => {
    const t = d.tickets.find((x) => x.key === 'DEMO-220')!
    const perEnv = new Map<string, string[]>()
    for (const b of t.builds ?? []) if (b.pipeline) perEnv.set(b.env, [...(perEnv.get(b.env) ?? []), b.kind ?? ''])
    expect([...perEnv.values()].some((kinds) => kinds.includes('build') && kinds.includes('deploy'))).toBe(true)
    expect(new Set(all.map((b) => b.kind).filter(Boolean))).toEqual(new Set(['build', 'deploy', 'both']))
    expect(new Set(all.map((b) => b.via).filter(Boolean))).toEqual(new Set(['branch-job', 'parameter']))
    // …and the card still shows one chip for it, red when a pipeline failed
    const chips = cardBuilds(t)
    expect(chips.filter((c) => c.env === 'stage')).toHaveLength(1)
    expect(chips.find((c) => c.env === 'stage')!.result).toBe('FAILURE')
    expect(chips.find((c) => c.env === 'dev')!.kind).toBe('deploy')
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

describe('demo Dynatrace evidence', () => {
  const d = rebaseDemoDump(raw, NOW)
  const withDt = d.tickets.filter((t) => t.dynatrace)
  const items = withDt.flatMap((t) => t.dynatrace!.items.map((i) => ({ key: t.key, ...i })))

  it('is on three QA / support-style tickets and shows every status', () => {
    expect(withDt.map((t) => t.key).sort()).toEqual(['DEMO-210', 'DEMO-213', 'DEMO-247'])
    expect(new Set(items.map((i) => i.status))).toEqual(new Set(['read', 'empty', 'unreachable', 'auth-failed', 'unconfigured-tenant']))
  })

  it('has a trace with failures, a closed Davis problem, a log link and a service link, on both URL flavours', () => {
    expect(new Set(items.map((i) => i.kind))).toEqual(new Set(['trace', 'problem', 'logs', 'service']))
    expect(new Set(items.map((i) => i.host))).toEqual(new Set(['classic', 'platform']))
    const trace = items.find((i) => i.status === 'read' && i.kind === 'trace' && (i.summary?.failedSpans ?? 0) > 0)!
    expect(trace.findings.some((f) => /failed spans; the failure originates in /.test(f))).toBe(true)
    expect(trace.summary!.errors![0].message).toMatch(/Read timed out/)
    expect(trace.url).toMatch(/^https:\/\/abc12345\.live\.dynatrace\.com\/#trace;gtf=.*;traceId=[0-9a-f]{32};.*;serviceId=SERVICE-[0-9A-F]{16}$/)
    const problem = items.find((i) => i.kind === 'problem')!
    expect(problem.status).toBe('read')
    expect(problem.summary!.problems![0]).toMatchObject({ status: 'CLOSED', severity: 'SLOWDOWN' })
    expect(problem.findings[0]).toMatch(/^Davis problem P-\d+: .* \(CLOSED, SLOWDOWN\)$/)
  })

  it('lists a tenant that is not configured, never read, with the reason', () => {
    const t = items.find((i) => i.status === 'unconfigured-tenant')!
    expect(t.url).toMatch(/^https:\/\/zzz99999\.live\.dynatrace\.com\//)
    expect(t.note).toBe('Tenant zzz99999 is not in DYNATRACE_TENANTS — not read')
    expect(t.findings).toEqual([])
    expect(t.summary ?? null).toBeNull()
    expect(t.fetchedAt ?? null).toBeNull()
  })

  it('keeps to the contract: at most five links, https only, findings short, a window only where one could be read', () => {
    for (const t of withDt) {
      expect(t.dynatrace!.items.length).toBeLessThanOrEqual(5)
      for (const i of t.dynatrace!.items) {
        expect(i.url).toMatch(/^https:\/\/(abc12345|def67890|zzz99999)\.(live|apps)\.dynatrace\.com\//)
        expect(i.url.length).toBeLessThanOrEqual(600)
        expect(i.findings.length).toBeLessThanOrEqual(8)
        for (const f of i.findings) expect(f.length).toBeLessThanOrEqual(200)
        if (i.window) expect(Date.parse(i.window.to) - Date.parse(i.window.from)).toBeLessThanOrEqual(2 * HOUR + 1)
      }
    }
  })

  it('summarises and labels in words the drawer can use', () => {
    const t = d.tickets.find((x) => x.key === 'DEMO-213')!
    expect(dynatraceSummary(t.dynatrace!)).toBe('1 read · 1 unreachable · 1 token rejected · 3 failed spans')
    expect(dynatraceKindLabel('logs')).toBe('Logs')
  })
})

describe('demo failed build with a console tail', () => {
  const d = rebaseDemoDump(raw, NOW)
  const withTail = d.tickets.flatMap((t) => (t.builds ?? []).filter((b) => b.consoleTail).map((b) => ({ key: t.key, ...b })))

  it('is on exactly one failed build, whose tail is a dozen-odd lines with a scrubbed Authorization header', () => {
    expect(withTail.map((b) => `${b.key}#${b.number}`)).toEqual(['DEMO-231#88'])
    expect(withTail[0].result).toBe('FAILURE')
    const lines = consoleTailLines(withTail[0].consoleTail)
    expect(lines.length).toBeGreaterThanOrEqual(10)
    expect(lines.length).toBeLessThanOrEqual(40)
    expect(withTail[0].consoleTail!.length).toBeLessThanOrEqual(4096)
    expect(lines.some((l) => /Authorization: •••/.test(l))).toBe(true)
    expect(lines.some((l) => /FAILED/.test(l))).toBe(true)
  })

  it('names the tests the build says failed', () => {
    const [b] = withTail
    for (const name of b.tests!.failing!) {
      const [cls, method] = name.split('.').slice(-2)
      expect(b.consoleTail).toContain(`${cls} > ${method}()`)
    }
  })

  it('carries no secret, address or token-looking string', () => {
    const tail = withTail[0].consoleTail!
    expect(tail).not.toMatch(/Bearer\s|password\s*[=:]|[A-Za-z0-9+/]{40,}|\b\d{1,3}(?:\.\d{1,3}){3}\b|[\w.-]+@[\w.-]+\.\w+/i)
  })
})

describe('demo briefs with an "Evidence from linked systems" section', () => {
  const d = rebaseDemoDump(raw, NOW)
  const evidence = d.tickets.filter((t) => t.aiSummaryEvidence)

  it('is on a Dynatrace ticket, a vulnerability-fix ticket and a build-failure ticket', () => {
    expect(evidence.map((t) => t.key).sort()).toEqual(['DEMO-210', 'DEMO-230', 'DEMO-231'])
    expect(evidence.find((t) => t.key === 'DEMO-210')!.dynatrace).toBeTruthy()
    expect(evidence.find((t) => t.key === 'DEMO-230')!.vulnFixes).toBeTruthy()
    expect(evidence.find((t) => t.key === 'DEMO-231')!.builds!.some((b) => b.consoleTail)).toBe(true)
  })

  it('is stamped with the current brief version, fingerprinted, and newer than the ticket', () => {
    for (const t of evidence) {
      expect(t.aiSummary!.startsWith('<div data-brief="2">')).toBe(true)
      expect(t.aiSummary!.endsWith('</div>')).toBe(true)
      expect(t.aiSummaryEvidence).toMatch(/^[0-9a-f]{16}$/)
      expect(Date.parse(t.aiSummaryAt!)).toBeGreaterThanOrEqual(Date.parse(t.lastUpdate!))
    }
    expect(new Set(evidence.map((t) => t.aiSummaryEvidence)).size).toBe(evidence.length)
  })

  it('has the section: a heading, a list that names its system, and a "What this means" line', () => {
    for (const t of evidence) {
      const html = unwrapBrief(t.aiSummary)!
      expect(html).toContain('<p><b>Evidence from linked systems</b></p><ul><li><b>')
      expect(html).toMatch(/<p><i>What this means: [^<]+<\/i><\/p><\/div>$/)
    }
    expect(unwrapBrief(evidence.find((t) => t.key === 'DEMO-210')!.aiSummary)).toContain('<b>Dynatrace:</b>')
    expect(unwrapBrief(evidence.find((t) => t.key === 'DEMO-230')!.aiSummary)).toContain('<b>Checkmarx:</b>')
    expect(unwrapBrief(evidence.find((t) => t.key === 'DEMO-231')!.aiSummary)).toContain('<b>Jenkins:</b>')
  })

  it('says only what the ticket’s own evidence says', () => {
    const b210 = evidence.find((t) => t.key === 'DEMO-210')!
    const trace = b210.dynatrace!.items.find((i) => i.kind === 'trace')!
    expect(b210.aiSummary).toContain(`${trace.summary!.failedSpans} failed spans out of ${trace.summary!.spans}`)
    const b230 = evidence.find((t) => t.key === 'DEMO-230')!
    for (const i of b230.vulnFixes!.items.filter((x) => x.status === 'open')) expect(b230.aiSummary).toContain(i.target)
    const b231 = evidence.find((t) => t.key === 'DEMO-231')!
    for (const name of b231.builds![0].tests!.failing!) expect(b231.aiSummary).toContain(name.split('.').slice(-2).join('.'))
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
    expect(countMyCompleted(d)).toBe(d.completed.filter((c) => c.mine !== false && !c.parentKey && !c.takenFromMe).length)
  })

  it('has tickets taken from me for every main reason — one still open — and none of them counts as done', () => {
    const takenRows = d.completed.filter((c) => c.takenFromMe?.reason)
    for (const r of ['backlog', 'taken-over', 'reassigned', 'cancelled', 'pr-declined']) {
      expect(takenRows.some((c) => c.takenFromMe!.reason === r), r).toBe(true)
    }
    const open = takenRows.find((c) => c.column && c.column !== 'done')!
    expect(open.done).toBe(false)
    expect(open.takenFromMe!.why?.text).toBeTruthy()
    expect(countMyCompleted(d)).toBe(d.completed.filter((c) => c.mine !== false && !c.parentKey).length - takenRows.filter((c) => !c.parentKey).length)
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
