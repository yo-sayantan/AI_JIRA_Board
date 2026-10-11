import { describe, expect, it } from 'vitest'
import { cardBranches, dtf, isAssignedToMe, primaryPrOf, releaseEnvOf, compareFutureSprints, parseSprint, sprintWhen } from './format'

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
