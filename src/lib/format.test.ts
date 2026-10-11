import { describe, expect, it } from 'vitest'
import { cardBranches, dtf, isAssignedToMe, primaryPrOf, releaseEnvOf, compareFutureSprints, parseSprint, sprintWhen, buildMeta, buildsOf, cardBuilds, fmtDuration, envLabel, buildTestsText, buildTooltip, pipelineKindMeta, envBuildCount, vulnFixesOf, vulnStatusMeta, vulnKindLabel, vulnSummary, vulnTooltip, vulnScanLine, consoleTailLines, unwrapBrief, dynatraceOf, dynatraceKindLabel, dynatraceStatusMeta, dynatraceWindowLabel, dynatraceSummary, dynatraceFailedSpans, dynatraceStaleLine, DYNATRACE_MAX_ITEMS } from './format'
import type { DynatraceEvidence, DynatraceItem, JenkinsBuild, VulnFixes, VulnFixItem } from '../types'

describe('dtf', () => {
  it('does not throw for an invalid zone and still formats', () => {
    expect(() => dtf('en-US', { year: 'numeric' }, 'Not/AZone')).not.toThrow()
    expect(dtf('en-US', { year: 'numeric' }, 'Not/AZone').format(new Date(2026, 0, 15))).toBe('2026')
  })
})

describe('isAssignedToMe', () => {
  const me = { name: 'Alex Doe', accountId: 'DEV001' }

  it('requires an exact match, not a substring', () => {
    expect(isAssignedToMe('ale', { name: 'alex' })).toBe(false)
    expect(isAssignedToMe('Alex', { name: 'alex' })).toBe(true)
    expect(isAssignedToMe('a@b.c', { email: 'a@b.c' })).toBe(true)
    expect(isAssignedToMe('', { name: 'x' })).toBe(false)
    expect(isAssignedToMe('Alex Doe', null)).toBe(false)
  })

  it('matches a plain display name or a bare id', () => {
    expect(isAssignedToMe('  alex doe ', me)).toBe(true)
    expect(isAssignedToMe('dev001', me)).toBe(true)
    expect(isAssignedToMe('Sam Roe', me)).toBe(false)
  })

  // The intern writes every person as "Display Name (ID)" (_jira.py::person_fmt).
  it('matches the "Display Name (ID)" form the intern writes', () => {
    expect(isAssignedToMe('Alex Doe (DEV001)', me)).toBe(true)
    expect(isAssignedToMe('Doe, Alex (dev001)', { accountId: 'DEV001' })).toBe(true)
    expect(isAssignedToMe('alex doe (DEV001)', { name: 'Alex Doe' })).toBe(true)
    expect(isAssignedToMe('Doe, Alex (DEV001)', { name: 'Doe, Alex' })).toBe(true)
    expect(isAssignedToMe('(DEV001)', me)).toBe(true)
  })

  it('does not match someone else in that form', () => {
    expect(isAssignedToMe('Sam Roe (DEV002)', me)).toBe(false)
    expect(isAssignedToMe('Alex Doe (DEV0011)', { accountId: 'DEV001' })).toBe(false)
    expect(isAssignedToMe('Alex Doer (DEV002)', { name: 'Alex Doe' })).toBe(false)
    // A namesake: same display name, different id — the id decides when both sides have one.
    expect(isAssignedToMe('Alex Doe (DEV002)', me)).toBe(false)
    expect(isAssignedToMe('Alex Doe ()', { accountId: 'DEV001' })).toBe(false)
  })
})

describe('releaseEnvOf', () => {
  it('does not read SG as Stage', () => {
    expect(releaseEnvOf({ title: 'Deploy to SG' })).toBeNull()
  })
  it('recognises staging and prod', () => {
    expect(releaseEnvOf({ title: 'Deploy to staging' })?.label).toBe('Stage')
    expect(releaseEnvOf({ title: 'Release to production' })?.label).toBe('Prod')
  })
})

describe('primaryPrOf', () => {
  const pr61 = { state: 'approved' as const, id: 61, sourceBranch: 'feature/PROJ-1' }
  const pr62 = { state: 'comments' as const, id: 62, sourceBranch: 'feature/PROJ-1_next' }

  it('returns the pipeline-chosen primary PR, not just the first listed one', () => {
    expect(primaryPrOf({ pr: pr62, prs: [pr61, pr62] })).toBe(pr62)
  })

  it('is null when the primary branch has no PR of its own, even if another branch has one', () => {
    expect(primaryPrOf({ pr: { state: 'none' }, prs: [pr61] })).toBeNull()
  })

  it('falls back to the first listed PR for dumps without a primary pr', () => {
    expect(primaryPrOf({ prs: [pr61, pr62] })).toBe(pr61)
    expect(primaryPrOf({ pr: null, prs: [pr62] })).toBe(pr62)
  })

  it('is null for a ticket with nothing', () => {
    expect(primaryPrOf({})).toBeNull()
    expect(primaryPrOf({ pr: { state: 'none' }, prs: [] })).toBeNull()
  })

  it('treats a linked PR whose state is "none" but has an id as a PR', () => {
    expect(primaryPrOf({ pr: { state: 'none', id: 5 } })?.id).toBe(5)
  })
})

describe('cardBranches — what a parent card says about branches', () => {
  const pr = (id: number, sourceBranch: string) => ({ id, state: 'comments' as const, sourceBranch })
  it('with a PR: the branch the PR comes from, plus how many more', () => {
    expect(cardBranches({ branches: ['b-old', 'b-pr', 'b-pr2'], branch: 'b-old', prs: [pr(1, 'b-pr'), pr(2, 'b-pr2')] })).toMatchObject({ shown: 'b-pr', more: 1 })
    expect(cardBranches({ branches: ['b-old', 'b-pr'], prs: [pr(1, 'b-pr')] })).toMatchObject({ shown: 'b-pr', more: 0 })
  })
  it('two PRs from one branch is still one branch', () => {
    expect(cardBranches({ prs: [pr(1, 'b'), pr(2, 'b')] })).toMatchObject({ shown: 'b', more: 0 })
  })
  it('no PR, several branches: only the newest (the ticket\'s primary branch)', () => {
    expect(cardBranches({ branches: ['b-new', 'b-old'], branch: 'b-new' })).toMatchObject({ shown: 'b-new', more: 0, all: ['b-new', 'b-old'] })
    expect(cardBranches({ branches: ['b-first', 'b-second'] })).toMatchObject({ shown: 'b-first', more: 0 })
  })
  it('no branch: nothing at all', () => {
    expect(cardBranches({})).toBeNull()
    expect(cardBranches({ branches: [], prs: [] })).toBeNull()
  })
})

describe('next-sprint timing', () => {
  const NOW = Date.parse('2026-10-10T09:00:00')
  it('says how many working days away a dated sprint is', () => {
    expect(sprintWhen(parseSprint('S25 (future · 2026-10-14 → 2026-10-28)')!, NOW)).toMatch(/^starts in \d+ days? · Oct 14$/)
  })
  it('a grooming bucket with no dates, or a start that has slipped past, is just "not started"', () => {
    expect(sprintWhen(parseSprint('Platform READY (future)')!, NOW)).toBe('not started')
    expect(sprintWhen(parseSprint('S24 (future · 2026-10-01 → 2026-10-08)')!, NOW)).toBe('not started')
  })
  it('orders dated sprints soonest first and undated buckets last', () => {
    const names = ['Team REFINEMENT (future)', 'Platform READY (future)', 'S26 (future · 2026-11-01 → 2026-11-15)', 'S25 (future · 2026-10-18 → 2026-11-01)']
    const sorted = names.map((n) => parseSprint(n)!).sort(compareFutureSprints).map((x) => x.name)
    expect(sorted).toEqual(['S25', 'S26', 'Platform READY', 'Team REFINEMENT'])
  })
})

describe('Jenkins builds', () => {
  const b = (env: string, number: number, result: JenkinsBuild['result'], extra: Partial<JenkinsBuild> = {}): JenkinsBuild => ({
    env,
    repo: 'payments-service',
    branch: 'feature/PAY-1',
    number,
    result,
    at: '2026-10-11T08:00:00Z',
    ...extra,
  })

  it('gives every result its own colour and label', () => {
    expect(buildMeta('SUCCESS')).toMatchObject({ color: '#17c47a', glyph: '✓' })
    expect(buildMeta('FAILURE')).toMatchObject({ color: '#ff4466', glyph: '✗' })
    expect(buildMeta('UNSTABLE').color).toBe('#ff9f1c')
    expect(buildMeta('BUILDING').color).toBe('#2f86ff')
    expect(buildMeta('ABORTED').color).toBe('#94a3b8')
    expect(buildMeta('NOT_BUILT').label).toBe('Not built')
  })

  it('reads only well-formed builds and tolerates their absence', () => {
    expect(buildsOf({})).toEqual([])
    expect(buildsOf({ builds: null as unknown as JenkinsBuild[] })).toEqual([])
    const good = b('qa', 1, 'SUCCESS')
    expect(buildsOf({ builds: [good, { env: 'qa' } as JenkinsBuild] })).toEqual([good])
  })

  it('shows one chip per environment, in the order the dump lists them, preferring the primary branch', () => {
    const other = b('qa', 9, 'FAILURE', { branch: 'feature/PAY-1_old', at: '2026-10-11T09:00:00Z' })
    const primary = b('qa', 4, 'SUCCESS')
    const uat = b('uat', 2, 'BUILDING')
    const got = cardBuilds({ branch: 'feature/PAY-1', builds: [other, uat, primary] })
    expect(got.map((x) => [x.env, x.number])).toEqual([
      ['qa', 4],
      ['uat', 2],
    ])
  })

  it('without a primary-branch build the newest one stands for the environment', () => {
    const older = b('qa', 3, 'SUCCESS', { branch: 'a', at: '2026-10-10T08:00:00Z' })
    const newer = b('qa', 5, 'FAILURE', { branch: 'b', at: '2026-10-11T08:00:00Z' })
    expect(cardBuilds({ branch: 'zzz', builds: [older, newer] }).map((x) => x.number)).toEqual([5])
  })

  it('shows ONE chip per environment when a build and a deploy pipeline both ran: the deploy result stands for it', () => {
    const build = b('dev', 10, 'SUCCESS', { pipeline: 'app-build', kind: 'build', at: '2026-10-11T09:00:00Z' })
    const deploy = b('dev', 4, 'BUILDING', { pipeline: 'deploy-dev', kind: 'deploy', at: '2026-10-11T08:00:00Z' })
    const got = cardBuilds({ branch: 'feature/PAY-1', builds: [build, deploy] })
    expect(got).toHaveLength(1)
    expect(got[0].pipeline).toBe('deploy-dev') // deploy outranks a newer build
    expect(cardBuilds({ branch: 'feature/PAY-1', builds: [deploy, build] })[0].pipeline).toBe('deploy-dev')
  })

  it('a pipeline that failed is the chip, however green the other one is — red beats amber beats the rest', () => {
    const ok = b('stage', 5, 'SUCCESS', { pipeline: 'deploy-stage', kind: 'deploy' })
    const failedBuild = b('stage', 6, 'FAILURE', { pipeline: 'app-build', kind: 'build', at: '2026-10-11T07:00:00Z' })
    const unstable = b('stage', 7, 'UNSTABLE', { pipeline: 'smoke', kind: 'both' })
    expect(cardBuilds({ branch: 'feature/PAY-1', builds: [ok, failedBuild] })[0].result).toBe('FAILURE')
    expect(cardBuilds({ branch: 'feature/PAY-1', builds: [ok, unstable] })[0].result).toBe('UNSTABLE')
    expect(cardBuilds({ branch: 'feature/PAY-1', builds: [unstable, failedBuild, ok] })[0].result).toBe('FAILURE')
  })

  it('with only build pipelines (or no pipeline info) the newest build stands, and each environment keeps its place', () => {
    const early = b('qa', 1, 'SUCCESS', { pipeline: 'a', kind: 'build', at: '2026-10-11T06:00:00Z' })
    const late = b('qa', 2, 'SUCCESS', { pipeline: 'b', kind: 'build', at: '2026-10-11T07:00:00Z' })
    const prod = b('prod', 3, 'SUCCESS')
    expect(cardBuilds({ branch: 'feature/PAY-1', builds: [early, prod, late] }).map((x) => [x.env, x.number])).toEqual([
      ['qa', 2],
      ['prod', 3],
    ])
  })

  it('the primary branch is still preferred over a failing build of another branch', () => {
    const mine = b('qa', 4, 'SUCCESS', { pipeline: 'deploy', kind: 'deploy' })
    const old = b('qa', 9, 'FAILURE', { pipeline: 'deploy', kind: 'deploy', branch: 'feature/old' })
    expect(cardBuilds({ branch: 'feature/PAY-1', builds: [old, mine] })[0].number).toBe(4)
  })

  it('knows how many builds sit behind an environment chip, and names the pipeline kinds', () => {
    const t = { builds: [b('dev', 1, 'SUCCESS'), b('dev', 2, 'SUCCESS', { pipeline: 'x' }), b('qa', 3, 'SUCCESS')] }
    expect(envBuildCount(t, 'dev')).toBe(2)
    expect(envBuildCount(t, 'nope')).toBe(0)
    expect(pipelineKindMeta('build')?.label).toBe('Build')
    expect(pipelineKindMeta('deploy')?.label).toBe('Deploy')
    expect(pipelineKindMeta('both')?.label).toBe('Build + deploy')
    expect(pipelineKindMeta(null)).toBeNull()
    expect(pipelineKindMeta(undefined)).toBeNull()
  })

  it('the tooltip names the pipeline and its kind', () => {
    const tip = buildTooltip(b('stage', 31, 'FAILURE', { pipeline: 'deploy-stage', kind: 'deploy', via: 'parameter' }), Date.parse('2026-10-11T10:00:00Z'))
    expect(tip).toContain('Pipeline: deploy-stage (deploy)')
    expect(buildTooltip(b('qa', 1, 'SUCCESS'), Date.now())).not.toContain('Pipeline:')
  })

  it('formats durations, environments and test totals', () => {
    expect(fmtDuration(38_000)).toBe('38s')
    expect(fmtDuration(252_000)).toBe('4m 12s')
    expect(fmtDuration(3_780_000)).toBe('1h 3m')
    expect(fmtDuration(null)).toBe('')
    expect(envLabel('qa')).toBe('QA')
    expect(envLabel('uat')).toBe('UAT')
    expect(envLabel('staging')).toBe('Staging')
    expect(buildTestsText({ total: 312, failed: 0, skipped: 4 })).toBe('308 passed · 0 failed · 4 skipped')
    expect(buildTestsText({ total: 10, failed: 2, skipped: 0 })).toBe('8 passed · 2 failed')
    expect(buildTestsText(null)).toBe('')
  })

  it('writes a tooltip that names env, number, result, branch and the failure', () => {
    const now = Date.parse('2026-10-11T10:00:00Z')
    const tip = buildTooltip(
      b('uat', 78, 'FAILURE', { failedStage: 'Deploy', durationMs: 252_000, tests: { total: 10, failed: 2, skipped: 0, failing: ['a.B.c'] }, deployTarget: 'uat-eu' }),
      now,
    )
    expect(tip).toContain('UAT #78 · Failed')
    expect(tip).toContain('feature/PAY-1')
    expect(tip).toContain('2h ago')
    expect(tip).toContain('4m 12s')
    expect(tip).toContain("Failed at stage 'Deploy'")
    expect(tip).toContain('a.B.c')
    expect(tip).toContain('uat-eu')
    expect(tip).not.toContain('stale')
  })

  it('says a carried-forward build is stale', () => {
    const tip = buildTooltip(b('qa', 5, 'SUCCESS', { stale: true }), Date.parse('2026-10-11T10:00:00Z'))
    expect(tip).toContain('QA #5 · Passed · stale')
    expect(tip).toContain('could not be re-read')
  })
})

describe('Checkmarx vulnerability fixes', () => {
  const it_ = (target: string, kind: VulnFixItem['kind'], status: VulnFixItem['status'], extra: Partial<VulnFixItem> = {}): VulnFixItem => ({ target, kind, status, ...extra })
  const vf = (...items: VulnFixItem[]): VulnFixes => ({
    scannedAt: '2026-10-11T06:00:00Z',
    project: 'payments-service',
    branch: 'feature/PAY-7',
    baseBranch: 'develop',
    branchScanAt: '2026-10-09T08:00:00Z',
    baseScanAt: '2026-10-01T07:00:00Z',
    items,
  })

  it('reads only well-formed results and tolerates their absence', () => {
    expect(vulnFixesOf({})).toBeNull()
    expect(vulnFixesOf({ vulnFixes: null })).toBeNull()
    expect(vulnFixesOf({ vulnFixes: vf() })).toBeNull()
    const good = it_('CVE-2021-44228', 'cve', 'fixed')
    const got = vulnFixesOf({ vulnFixes: vf(good, { target: 'x', kind: 'cve', status: 'weird' } as unknown as VulnFixItem) })
    expect(got?.items).toEqual([good])
  })

  it('gives every status its own colour, label and glyph', () => {
    expect(vulnStatusMeta('fixed')).toMatchObject({ label: 'Fixed', color: '#17c47a', glyph: '✓' })
    expect(vulnStatusMeta('open')).toMatchObject({ label: 'Open', color: '#ff4466', glyph: '✗' })
    expect(vulnStatusMeta('not-found')).toMatchObject({ label: 'Not found', color: '#ff9f1c' })
    expect(vulnStatusMeta('unknown')).toMatchObject({ label: 'Unknown', color: '#94a3b8' })
    expect(vulnKindLabel('cve')).toBe('CVE')
    expect(vulnKindLabel('sast')).toBe('SAST')
    expect(vulnKindLabel('result')).toBe('Result')
    expect(vulnKindLabel('package')).toBe('Package')
  })

  it('summarises for the card chip: green all fixed, red any open, amber otherwise', () => {
    expect(vulnSummary(vf(it_('a', 'cve', 'fixed'), it_('b', 'sast', 'fixed')))).toMatchObject({ label: '2/2 fixed', fixed: 2, total: 2, color: '#17c47a', state: 'fixed' })
    expect(vulnSummary(vf(it_('a', 'cve', 'fixed'), it_('b', 'sast', 'open'), it_('c', 'package', 'unknown')))).toMatchObject({ label: '1/3 fixed', open: 1, color: '#ff4466', state: 'open' })
    expect(vulnSummary(vf(it_('a', 'cve', 'fixed'), it_('b', 'result', 'not-found')))).toMatchObject({ label: '1/2 fixed', notFound: 1, color: '#ff9f1c', state: 'pending' })
    expect(vulnSummary(vf(it_('a', 'cve', 'unknown')))).toMatchObject({ label: '0/1 fixed', unknown: 1, color: '#ff9f1c', state: 'pending' })
  })

  it('writes a tooltip that lists every target with its status and the scans compared', () => {
    const tip = vulnTooltip(vf(it_('CVE-2021-44228', 'cve', 'fixed', { severity: 'CRITICAL' }), it_('SQL_Injection', 'sast', 'open', { severity: 'HIGH' })))
    expect(tip).toContain('Checkmarx · 1 of 2 fixed')
    expect(tip).toContain('feature/PAY-7 (scan 2026-10-09) vs develop (scan 2026-10-01)')
    expect(tip).toContain('✓ CVE-2021-44228 · Fixed · CRITICAL')
    expect(tip).toContain('✗ SQL_Injection · Open · HIGH')
    expect(vulnTooltip({ ...vf(it_('x', 'cve', 'unknown')), branchScanAt: null, note: 'feature/PAY-7 has no completed Checkmarx scan yet' })).toContain('no completed Checkmarx scan')
  })

  it('names the two scans compared', () => {
    expect(vulnScanLine(vf())).toBe('feature/PAY-7 (scan 2026-10-09) vs develop (scan 2026-10-01)')
    expect(vulnScanLine({ ...vf(), baseBranch: null, branchScanAt: null, baseScanAt: null })).toBe('feature/PAY-7 (not scanned yet) vs the base branch')
  })
})

describe('Jenkins console tail', () => {
  it('splits into lines, without colour codes, carriage returns or blank lines at either end', () => {
    expect(consoleTailLines('\n\n> Task :test FAILED\r\n\u001b[31mFAILED\u001b[0m: lastPageIsPartial\nBUILD FAILED in 4m 12s\n\n')).toEqual([
      '> Task :test FAILED',
      'FAILED: lastPageIsPartial',
      'BUILD FAILED in 4m 12s',
    ])
  })

  it('keeps blank lines in the middle and indentation', () => {
    expect(consoleTailLines('a\n\n    at Foo.bar(Foo.java:12)')).toEqual(['a', '', '    at Foo.bar(Foo.java:12)'])
  })

  it('is empty when there is nothing', () => {
    expect(consoleTailLines(undefined)).toEqual([])
    expect(consoleTailLines(null)).toEqual([])
    expect(consoleTailLines('')).toEqual([])
    expect(consoleTailLines('  \n \n')).toEqual([])
    expect(consoleTailLines(42 as unknown as string)).toEqual([])
  })

  it('never returns more than the last 200 lines', () => {
    const many = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n')
    const out = consoleTailLines(many)
    expect(out).toHaveLength(200)
    expect(out[out.length - 1]).toBe('line 499')
  })
})

describe('Dynatrace evidence', () => {
  const item = (over: Partial<DynatraceItem> = {}): DynatraceItem => ({
    url: 'https://abc12345.live.dynatrace.com/#trace;traceId=9f3c1d5e7a2b4c6d8e0f1a2b3c4d5e6f',
    kind: 'trace',
    host: 'classic',
    tenant: 'prod',
    window: { from: '2026-02-26T08:10:00Z', to: '2026-02-26T08:35:00Z' },
    status: 'read',
    findings: ['4 failed spans; the failure originates in payments: POST /charge'],
    fetchedAt: '2026-10-11T09:00:00Z',
    ...over,
  })
  const ev = (...items: DynatraceItem[]): DynatraceEvidence => ({ fetchedAt: '2026-10-11T09:00:00Z', items })

  it('reads only well-formed items and tolerates absence and garbage', () => {
    expect(dynatraceOf({})).toBeNull()
    expect(dynatraceOf({ dynatrace: null })).toBeNull()
    expect(dynatraceOf({ dynatrace: 'nope' as unknown as DynatraceEvidence })).toBeNull()
    expect(dynatraceOf({ dynatrace: { fetchedAt: 'x', items: 'nope' as unknown as DynatraceItem[] } })).toBeNull()
    expect(dynatraceOf({ dynatrace: ev() })).toBeNull()
    const good = item()
    const got = dynatraceOf({
      dynatrace: ev(
        good,
        null as unknown as DynatraceItem,
        { ...item(), url: '' },
        { ...item(), url: 5 as unknown as string },
        { ...item(), status: 'weird' as never },
      ),
    })
    expect(got?.items).toEqual([good])
  })

  it('mends what it can: an unknown kind is a plain link, missing findings are none, a missing tenant is empty', () => {
    const got = dynatraceOf({ dynatrace: ev({ ...item(), kind: 'weird' as never, findings: undefined as never, tenant: undefined as never }) })!
    expect(got.items[0]).toMatchObject({ kind: 'other', findings: [], tenant: '' })
    const mixed = dynatraceOf({ dynatrace: ev(item({ findings: ['ok', 7 as unknown as string, '  ', 'also ok'] })) })!
    expect(mixed.items[0].findings).toEqual(['ok', 'also ok'])
  })

  it('lists at most five links and keeps moreLinks', () => {
    const many = Array.from({ length: 8 }, (_, i) => item({ url: `https://abc12345.live.dynatrace.com/#trace;traceId=${i}` }))
    const got = dynatraceOf({ dynatrace: { ...ev(...many), moreLinks: 3 } })!
    expect(got.items).toHaveLength(DYNATRACE_MAX_ITEMS)
    expect(got.moreLinks).toBe(3)
  })

  it('gives every status its own colour, label and glyph — red only for a rejected token', () => {
    expect(dynatraceStatusMeta('read')).toMatchObject({ label: 'Read', color: '#4f8df5' })
    expect(dynatraceStatusMeta('empty')).toMatchObject({ label: 'Nothing found', color: '#94a3b8' })
    expect(dynatraceStatusMeta('unreachable')).toMatchObject({ label: 'Unreachable', color: '#ff8a1f' })
    expect(dynatraceStatusMeta('auth-failed')).toMatchObject({ label: 'Token rejected', color: '#e11d48' })
    expect(dynatraceStatusMeta('unconfigured-tenant')).toMatchObject({ label: 'Tenant not listed', color: '#8b94a8' })
    expect(dynatraceStatusMeta(undefined)).toMatchObject({ label: 'Unknown', color: '#94a3b8' })
    const reds = (['read', 'empty', 'unreachable', 'auth-failed', 'unconfigured-tenant'] as const).filter((s) => dynatraceStatusMeta(s).color === '#e11d48')
    expect(reds).toEqual(['auth-failed'])
  })

  it('labels every kind', () => {
    expect(dynatraceKindLabel('trace')).toBe('Trace')
    expect(dynatraceKindLabel('problem')).toBe('Problem')
    expect(dynatraceKindLabel('logs')).toBe('Logs')
    expect(dynatraceKindLabel('service')).toBe('Service')
    expect(dynatraceKindLabel('other')).toBe('Link')
    expect(dynatraceKindLabel(undefined)).toBe('Link')
  })

  it('writes the window in the configured zone, one day or across midnight', () => {
    expect(dynatraceWindowLabel({ from: '2026-02-26T08:15:00Z', to: '2026-02-26T08:30:00Z' }, 'UTC')).toBe('2026-02-26 08:15–08:30')
    expect(dynatraceWindowLabel({ from: '2026-02-26T08:15:00Z', to: '2026-02-26T08:30:00Z' }, 'Asia/Kolkata')).toBe('2026-02-26 13:45–14:00')
    expect(dynatraceWindowLabel({ from: '2026-02-26T23:50:00Z', to: '2026-02-27T00:20:00Z' }, 'UTC')).toBe('2026-02-26 23:50 → 2026-02-27 00:20')
    // midnight is 00:xx, never 24:xx
    expect(dynatraceWindowLabel({ from: '2026-02-26T23:45:00Z', to: '2026-02-27T00:00:00Z' }, 'UTC')).toBe('2026-02-26 23:45 → 2026-02-27 00:00')
  })

  it('has no window label without a usable window', () => {
    expect(dynatraceWindowLabel(undefined)).toBe('')
    expect(dynatraceWindowLabel(null)).toBe('')
    expect(dynatraceWindowLabel({ from: '2026-02-26T08:15:00Z' })).toBe('')
    expect(dynatraceWindowLabel({ from: 'x', to: 'y' })).toBe('')
  })

  it('sums the failed spans of what was read, and not what was carried forward or never read', () => {
    const read = item({ summary: { spans: 12, failedSpans: 4 } })
    const readToo = item({ summary: { failedSpans: 1 } })
    const stale = item({ status: 'unreachable', stale: true, summary: { failedSpans: 9 } })
    const empty = item({ status: 'empty', findings: [] })
    expect(dynatraceFailedSpans(ev(read, readToo, stale, empty))).toBe(5)
    expect(dynatraceFailedSpans(ev(empty))).toBe(0)
  })

  it('summarises in one line, statuses in a fixed order and failed spans last', () => {
    const all = ev(
      item({ summary: { failedSpans: 4 } }),
      item({ kind: 'problem', summary: { problems: [{ title: 'Response time degradation' }] } }),
      item({ status: 'empty', findings: [] }),
      item({ status: 'unreachable', stale: true }),
      item({ status: 'unconfigured-tenant', findings: [] }),
      item({ status: 'auth-failed', findings: [] }),
    )
    expect(dynatraceSummary(all)).toBe('2 read · 1 nothing found · 1 unreachable · 1 token rejected · 1 tenant not listed · 4 failed spans')
    expect(dynatraceSummary(ev(item({ summary: { failedSpans: 1 } })))).toBe('1 read · 1 failed span')
    expect(dynatraceSummary(ev(item({ status: 'unconfigured-tenant', findings: [] })))).toBe('1 tenant not listed')
  })

  it('says when an item is an earlier answer carried forward', () => {
    const now = Date.parse('2026-10-11T12:00:00Z')
    expect(dynatraceStaleLine(item(), now)).toBe('')
    expect(dynatraceStaleLine(item({ status: 'unreachable', stale: true }), now)).toBe('Last read 3h ago; Dynatrace could not be re-read')
    expect(dynatraceStaleLine(item({ status: 'unreachable', stale: true, fetchedAt: null }), now)).toBe('Read earlier; Dynatrace could not be re-read')
  })
})

describe('unwrapBrief · evidence section', () => {
  const html = '<div data-brief="2"><p>Retry control.</p><p><b>Evidence from linked systems</b></p><ul><li><b>Dynatrace:</b> 4 failed spans</li></ul><p><i>What this means: the timeouts are upstream.</i></p></div>'

  it('leaves a stamped brief alone, evidence section included', () => {
    expect(unwrapBrief(html)).toBe(html)
  })

  it('peels the {"html": …} wrapper some models add and keeps the section', () => {
    expect(unwrapBrief(JSON.stringify({ html }))).toBe(html)
  })
})
