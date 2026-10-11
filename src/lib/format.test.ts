import { describe, expect, it } from 'vitest'
import { cardBranches, dtf, isAssignedToMe, primaryPrOf, releaseEnvOf, compareFutureSprints, parseSprint, sprintWhen, buildMeta, buildsOf, cardBuilds, fmtDuration, envLabel, buildTestsText, buildTooltip, vulnFixesOf, vulnStatusMeta, vulnKindLabel, vulnSummary, vulnTooltip, vulnScanLine } from './format'
import type { JenkinsBuild, VulnFixes, VulnFixItem } from '../types'

describe('dtf', () => {
  it('does not throw for an invalid zone and still formats', () => {
    expect(() => dtf('en-US', { year: 'numeric' }, 'Not/AZone')).not.toThrow()
    expect(dtf('en-US', { year: 'numeric' }, 'Not/AZone').format(new Date(2026, 0, 15))).toBe('2026')
  })
})

describe('isAssignedToMe', () => {
  it('requires an exact match, not a substring', () => {
    expect(isAssignedToMe('sayan', { name: 'sayantan' })).toBe(false)
    expect(isAssignedToMe('Sayantan', { name: 'sayantan' })).toBe(true)
    expect(isAssignedToMe('a@b.c', { email: 'a@b.c' })).toBe(true)
    expect(isAssignedToMe('', { name: 'x' })).toBe(false)
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
