import rules from '../../jira-intern/move_rules.json'
import { describe, expect, it } from 'vitest'
import type { Ticket } from '../types'
import { checkMove, isQaTicket, laneBlocker, looksLikeQa, moveTargetOf, qaColumn, qaIssuesOf, readinessOf } from './moveRules'

const dev: Ticket = { key: 'T-1', title: 'Build the export', type: 'Story', status: 'In Progress', column: 'prog' }
const qaReady: Ticket = { key: 'Q-1', title: 'QA: verify the export', type: 'QA Task', status: 'Ready for QA', column: 'qa' }
const qaTodo: Ticket = { key: 'Q-2', title: 'Smoke test the nightly job', type: 'Task', labels: ['qa'], status: 'To Do', column: 'todo' }
const qaSub = (status: string): Ticket => ({ key: 'T-1-1', title: 'QA: verify the flow', type: 'QA Task', status, column: 'prog' })
const pr = (state: 'comments' | 'approved' | 'merged' | 'declined', id = 7) => ({ state, id, merged: state === 'merged' })

describe('isQaTicket', () => {
  it('a QA/Test type, a QA label or a QA-led title marks a QA ticket', () => {
    expect(isQaTicket({ type: 'QA Task' })).toBe(true)
    expect(isQaTicket({ type: 'Test' })).toBe(true)
    expect(isQaTicket({ type: 'Task', labels: ['QA'] })).toBe(true)
    expect(isQaTicket({ type: 'Task', labels: ['qa-ticket'] })).toBe(true)
    expect(isQaTicket({ type: 'Task', title: 'QA: smoke test' })).toBe(true)
    expect(isQaTicket({ type: 'Task', title: '[QA] export' })).toBe(true)
  })
  it('never just a word like "verify", "tests" or a label that merely contains the letters', () => {
    expect(isQaTicket({ type: 'Story', title: 'Verify the fix' })).toBe(false)
    expect(isQaTicket({ type: 'Story', title: 'Add unit tests for export' })).toBe(false)
    expect(isQaTicket({ type: 'Story', labels: ['aqua', 'backend'] })).toBe(false)
    // Labels ABOUT a dev ticket's QA are its state, not what it is.
    expect(isQaTicket({ type: 'Bug', labels: ['qa-failed', 'needs-qa', 'qa-passed'] })).toBe(false)
  })
  it('looksLikeQa stays loose for linked issues', () => {
    expect(looksLikeQa('Story', 'Verify the fix')).toBe(true)
    expect(looksLikeQa('Story', 'Build the export')).toBe(false)
  })
})

describe('qaColumn (where a QA ticket is displayed)', () => {
  const qa = (column: Ticket['column']) => ({ column, type: 'Sub-task', title: 'QA: verify the flow', labels: [] as string[] })
  it('puts a QA ticket in a dev stage (In Progress / In Review) into QA', () => {
    expect(qaColumn(qa('prog'))).toBe('qa')
    expect(qaColumn(qa('rev'))).toBe('qa')
    expect(qaColumn({ column: 'prog', type: 'Task', title: 'Smoke test', labels: ['qa'] })).toBe('qa')
  })
  it('leaves To Do, Blocked, On Hold, Done and QA alone', () => {
    for (const c of ['todo', 'blocked', 'hold', 'done', 'qa'] as const) expect(qaColumn(qa(c))).toBe(c)
  })
  it('leaves a dev ticket alone, even one that says "verify" or carries a QA-state label', () => {
    expect(qaColumn({ column: 'prog', type: 'Story', title: 'Verify the fix', labels: [] })).toBe('prog')
    expect(qaColumn({ column: 'rev', type: 'Bug', title: 'Squash', labels: ['qa-failed', 'needs-qa'] })).toBe('rev')
  })
})

describe('the QA lane', () => {
  it('only a QA ticket may enter QA or QA In Progress — from To Do or anywhere', () => {
    for (const to of ['qa', 'qaip'] as const) {
      expect(laneBlocker(dev, to)).toMatch(/Only QA tickets/)
      expect(laneBlocker(qaTodo, to)).toBeNull()
    }
  })
  it('a QA ticket moves only to QA, QA In Progress, Blocked, On Hold or Done', () => {
    for (const t of [qaReady, qaTodo]) {
      for (const to of ['qa', 'qaip', 'blocked', 'hold', 'done'] as const) expect(laneBlocker(t, to), `${t.key}→${to}`).toBeNull()
      for (const to of ['todo', 'prog', 'rev'] as const) expect(laneBlocker(t, to), `${t.key}→${to}`).toMatch(/can only be moved to/)
    }
  })
  it('sitting in QA is enough to be the lane’s, whatever the title', () => {
    expect(laneBlocker({ ...dev, column: 'qa' }, 'prog')).toMatch(/can only be moved to/)
  })
  it('every other ticket moves freely outside the lane', () => {
    for (const to of ['todo', 'blocked', 'hold', 'prog'] as const) expect(checkMove(dev, to).kind).toBeNull()
  })
  it('a lane refusal is a lane refusal, never a forcible gate', () => {
    expect(checkMove(dev, 'qa').kind).toBe('lane')
    expect(checkMove(qaReady, 'prog').kind).toBe('lane')
  })
  it('QA tickets close freely — no PR or QA ticket of their own to wait for', () => {
    expect(checkMove(qaReady, 'done').kind).toBeNull()
  })
})

describe('Done is final', () => {
  const done: Ticket = { key: 'D-1', title: 'Shipped', type: 'Story', status: 'Done', column: 'done' }
  it('a Done ticket cannot be moved to any other column — a lane refusal, never forcible', () => {
    for (const to of ['todo', 'blocked', 'hold', 'prog', 'rev', 'qa', 'qaip', 'next'] as const) {
      expect(laneBlocker(done, to), to).toMatch(/stays in Done/)
      expect(checkMove(done, to).kind, to).toBe('lane')
    }
  })
  it('applies to a QA ticket in Done too', () => {
    expect(laneBlocker({ ...qaReady, column: 'done' }, 'todo')).toMatch(/stays in Done/)
  })
  it('other tickets still move into Done as before', () => {
    expect(laneBlocker({ ...done, column: 'prog' }, 'done')).toBeNull()
  })
})

describe('Next Sprint', () => {
  const FUTURE = 'S99 (future · 2999-01-10 → 2999-01-24)'
  const at = (column: Ticket['column'], status: string, extra: Partial<Ticket> = {}): Ticket => ({ key: 'N-1', title: 'Build it', type: 'Story', status, column, ...extra })
  const queued = at('todo', 'To Do', { sprint: FUTURE })

  it('To Do, Blocked, QA (ready) and On Hold tickets may be moved in', () => {
    for (const t of [at('todo', 'To Do'), at('blocked', 'Blocked'), at('hold', 'On Hold'), { ...qaReady }]) {
      expect(laneBlocker(t, 'next'), t.column).toBeNull()
      expect(checkMove(t, 'next').kind, t.column).toBeNull()
    }
  })
  it('nothing else may: not In Progress, In Review and not QA In Progress (Done is final anyway)', () => {
    for (const t of [at('prog', 'In Progress'), at('rev', 'In Review'), { ...qaReady, status: 'QA In Progress' }]) {
      expect(laneBlocker(t, 'next'), t.column).toMatch(/Only To Do, Blocked, QA and On Hold/)
      expect(checkMove(t, 'next').kind).toBe('lane') // never forcible
    }
  })
  it('a ticket in it can only go back to To Do', () => {
    expect(moveTargetOf(queued)).toBe('next')
    expect(laneBlocker(queued, 'todo')).toBeNull()
    for (const to of ['blocked', 'hold', 'prog', 'rev', 'qa', 'qaip', 'done'] as const) {
      expect(laneBlocker(queued, to), to).toMatch(/can only be moved back to To Do/)
    }
  })
  it('applies to a QA ticket too — it may enter from To Do, QA, Blocked or On Hold, and leaves only to To Do', () => {
    expect(laneBlocker({ ...qaTodo }, 'next')).toBeNull()
    expect(laneBlocker({ ...qaTodo, sprint: FUTURE }, 'todo')).toBeNull()
    expect(laneBlocker({ ...qaTodo, sprint: FUTURE }, 'qa')).toMatch(/back to To Do/)
  })
  it('is a sprint assignment: no PR or QA gate applies', () => {
    expect(checkMove(at('blocked', 'Blocked'), 'next').kind).toBeNull()
    expect(checkMove(queued, 'todo').kind).toBeNull()
  })
  it('an optimistic drop decides before the sprint arrives, in and out', () => {
    expect(moveTargetOf({ ...at('todo', 'To Do'), queued: true })).toBe('next')
    expect(moveTargetOf({ ...queued, queued: false })).toBe('todo')
  })
  it('an undated future sprint is Next Sprint only when it is the READY or REFINEMENT bucket', () => {
    expect(moveTargetOf(at('todo', 'To Do', { sprint: 'Team READY (future)' }))).toBe('next')
    expect(moveTargetOf(at('todo', 'To Do', { sprint: 'Team REFINEMENT (future · <null> → <null>)' }))).toBe('next')
    expect(moveTargetOf(at('todo', 'To Do', { sprint: 'Some Backlog (future)' }))).toBe('todo')
  })
})

describe('Support tickets (no PR needed for In Review)', () => {
  const support: Ticket = { key: 'SUP-1', title: 'Customer sees a conflicting value', type: 'Support', status: 'In Progress', column: 'prog' }
  it('may move to In Review with no PR at all', () => {
    expect(checkMove(support, 'rev').kind).toBeNull()
    expect(checkMove({ ...support, type: 'support' }, 'rev').kind).toBeNull()
  })
  it('a dev ticket of another type still needs one', () => {
    expect(checkMove({ ...support, type: 'Story' }, 'rev').kind).toBe('gate')
  })
  it('the exemption is only for In Review — Done still asks for its PR and QA ticket', () => {
    expect(checkMove(support, 'done').kind).toBe('gate')
  })
  it('the type list is the shared jira-intern/move_rules.json', () => {
    expect(rules.prOptionalTypes).toContain('Support')
  })
})

describe('In Review gate', () => {
  it('needs a PR — open or merged; declined does not count', () => {
    expect(checkMove(dev, 'rev')).toMatchObject({ kind: 'gate', reason: expect.stringContaining('no pull request') })
    expect(checkMove({ ...dev, pr: pr('comments') }, 'rev').kind).toBeNull()
    expect(checkMove({ ...dev, pr: pr('merged') }, 'rev').kind).toBeNull()
    expect(checkMove({ ...dev, prs: [pr('declined')] }, 'rev').kind).toBe('gate')
  })
  it('a sub-ticket may ride on an OPEN PR of its parent', () => {
    const sub: Ticket = { ...dev, key: 'T-2', parentKey: 'P-1' }
    const parentOpen = new Map([['P-1', { ...dev, key: 'P-1', pr: pr('approved') } as Ticket]])
    const parentMerged = new Map([['P-1', { ...dev, key: 'P-1', pr: pr('merged') } as Ticket]])
    expect(checkMove(sub, 'rev', parentOpen).kind).toBeNull()
    expect(checkMove(sub, 'rev', parentMerged)).toMatchObject({ kind: 'gate', reason: expect.stringContaining('P-1 has no open one') })
  })
  it('an unknown parent is left to the server, which reads it live', () => {
    expect(checkMove({ ...dev, parentKey: 'P-9' }, 'rev', new Map()).kind).toBeNull()
  })
})

describe('Done gate', () => {
  const qaLinked = { subtasks: [qaSub('To Do')] }
  it('needs every PR merged or declined', () => {
    expect(checkMove({ ...dev, ...qaLinked, pr: pr('approved') }, 'done').reason).toContain('#7 still open')
    expect(checkMove({ ...dev, ...qaLinked, pr: pr('merged') }, 'done').kind).toBeNull()
    expect(checkMove({ ...dev, ...qaLinked, prs: [pr('declined', 4)] }, 'done').kind).toBeNull()
  })
  it('needs a PR at all', () => {
    expect(checkMove({ ...dev, ...qaLinked }, 'done').reason).toContain('no pull request raised')
  })
  it('needs a QA ticket RAISED — not finished', () => {
    expect(checkMove({ ...dev, pr: pr('merged') }, 'done').reason).toContain('no QA ticket raised')
    expect(checkMove({ ...dev, pr: pr('merged'), ...qaLinked }, 'done').kind).toBeNull()
  })
  it('a sub-ticket may close with no PR of its own; its parent’s QA ticket counts', () => {
    const sub: Ticket = { ...dev, key: 'T-2', parentKey: 'P-1' }
    const withQa = new Map([['P-1', { ...dev, key: 'P-1', ...qaLinked } as Ticket]])
    const noQa = new Map([['P-1', { ...dev, key: 'P-1' } as Ticket]])
    expect(checkMove(sub, 'done', withQa).kind).toBeNull()
    expect(checkMove(sub, 'done', noQa).reason).toContain('no QA ticket raised (on it or its parent)')
    expect(checkMove({ ...sub, pr: pr('comments') }, 'done', withQa).reason).toContain('#7 still open')
  })
  it('warns (only) when a ticket with an open PR goes on hold', () => {
    const c = checkMove({ ...dev, pr: pr('comments') }, 'hold')
    expect(c.kind).toBeNull()
    expect(c.warnings.join(' ')).toContain('#7 is still open')
  })
})

describe('qaIssuesOf / readinessOf', () => {
  it('finds QA tickets among sub-tasks and linked issues, never the parent or epic link', () => {
    const t: Ticket = {
      ...dev,
      subtasks: [qaSub('Done')],
      related: [
        { key: 'T-9', title: 'Test the importer', status: 'Open' },
        { key: 'T-8', title: 'Refactor the writer', status: 'Open' },
        { key: 'E-1', title: 'Testing epic', relation: 'epic' },
      ],
    }
    expect(qaIssuesOf(t).map((q) => q.key)).toEqual(['T-1-1', 'T-9'])
  })
  it('readiness covers In Review only before review, and nothing for To Do, Done or QA tickets', () => {
    expect(readinessOf(dev)?.rev?.kind).toBe('gate')
    expect(readinessOf({ ...dev, column: 'todo' })).toBeNull()
    expect(readinessOf({ ...dev, column: 'rev' })?.rev).toBeNull()
    expect(readinessOf({ ...dev, column: 'done' })).toBeNull()
    expect(readinessOf(qaReady)).toBeNull()
  })
})
