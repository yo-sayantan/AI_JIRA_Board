import { describe, expect, it } from 'vitest'
import type { Ticket } from '../types'
import { MOVE_TARGETS } from '../lib/columns'
import { isAssignedToMe } from '../lib/format'
import { checkMove, DONE_LOCKED, isQaTicket, moveTargetOf, readinessOf } from '../lib/moveRules'
import { demoDump } from './index'
import { demoMoveVerdict, evaluateMove } from './gates'

// The rules themselves are pinned in lib/moveRules.test.ts; here: the demo verdict (modes) and the demo data.
const base: Ticket = { key: 'T-1', title: 'A ticket', status: 'In Progress', column: 'prog' }
const qaTicket: Ticket = { key: 'Q-1', title: 'QA: verify the export', type: 'QA Task', status: 'Ready for QA', column: 'qa' }

describe('demo move verdict', () => {
  it('refuses a gate in normal mode and says it can be forced', () => {
    expect(demoMoveVerdict(base, 'rev')).toMatchObject({ ok: false, blocked: true, forcible: true, reason: expect.stringContaining('In Review') })
  })
  it('force skips the PR / QA gates', () => {
    expect(demoMoveVerdict(base, 'done', 'force')).toMatchObject({ ok: true, moved: true, status: 'Done' })
  })
  it('force never skips the QA lane', () => {
    expect(demoMoveVerdict(base, 'qa', 'force')).toMatchObject({ ok: false, blocked: true, forcible: false })
    expect(demoMoveVerdict(qaTicket, 'prog', 'force')).toMatchObject({ ok: false, forcible: false })
  })
  it('undo puts a ticket back wherever it came from', () => {
    expect(demoMoveVerdict(qaTicket, 'todo', 'undo')).toMatchObject({ ok: true, status: 'To Do' })
  })
  it('names QA In Progress in the verdict', () => {
    expect(demoMoveVerdict(qaTicket, 'qaip')).toMatchObject({ ok: true, status: 'QA In Progress' })
  })
  it('passes on warnings for a normal move only', () => {
    const open: Ticket = { ...base, pr: { state: 'comments', id: 7 } }
    expect(demoMoveVerdict(open, 'hold').warnings?.join(' ')).toContain('#7 is still open')
  })
})

describe('demo dump', () => {
  const d = demoDump()
  const byKey = (k: string) => d.tickets.find((t) => t.key === k)!
  const prStates = new Set(d.tickets.flatMap((t) => (t.prs ?? (t.pr ? [t.pr] : [])).map((p) => p.state)))

  it('fills every board column, both QA shelves and the side sections', () => {
    const cols = new Set(d.tickets.map((t) => t.column))
    for (const c of ['todo', 'blocked', 'prog', 'rev', 'qa', 'done', 'hold']) expect(cols).toContain(c)
    expect(d.tickets.some((t) => t.column === 'qa' && /^(QA|Ready for QA)$/.test(t.status))).toBe(true)
    expect(d.tickets.some((t) => t.column === 'qa' && /^(In QA|In Testing|Under QA)$/.test(t.status))).toBe(true)
    expect(d.tickets.some((t) => t.sprint?.includes('future'))).toBe(true)
  })

  it('covers every pull-request state', () => {
    for (const s of ['merged', 'approved', 'comments', 'changes', 'declined']) expect(prStates).toContain(s)
    expect(d.tickets.some((t) => !t.pr && !t.prs?.length)).toBe(true) // and tickets with none
  })

  it('covers the review edge cases', () => {
    expect(byKey('DEMO-233').pr).toMatchObject({ approvals: 1, openComments: 0 }) // one approval short
    expect(byKey('DEMO-234').pr).toMatchObject({ approvals: 2 }) // approved, comments still open
    expect(byKey('DEMO-234').pr!.openComments).toBeGreaterThan(0)
    expect(byKey('DEMO-232').pr).toMatchObject({ approvals: 0, openComments: 0 }) // nobody looked yet
    expect(byKey('DEMO-235').prs!.every((p) => p.state === 'declined')).toBe(true) // every attempt rejected
    expect(byKey('DEMO-253').pr!.merged).toBeFalsy() // closed in Jira, code never merged
    expect(byKey('DEMO-212').pr!.merged).toBe(true) // merged, yet still blocked
  })

  it('gives tickets that pass the Done gate, and one for each refusal', () => {
    expect(evaluateMove('done', byKey('DEMO-242')).blocker).toBeNull() // merged + QA done
    expect(evaluateMove('done', byKey('DEMO-240')).blocker).toBeNull() // merged + QA raised (not started yet)
    expect(evaluateMove('done', byKey('DEMO-241')).blocker).toContain('no QA ticket raised')
    expect(byKey('DEMO-241').column).toBe('rev') // dev work waiting to close, not a ticket in the QA lane
    expect(evaluateMove('done', byKey('DEMO-244')).blocker).toContain('#433 still open') // QA failed, fix open
    expect(evaluateMove('done', byKey('DEMO-201')).blocker).toContain('no pull request raised')
  })

  it('gives an In Review refusal and a sub-ticket riding on its parent’s open PR', () => {
    const index = new Map(d.tickets.flatMap((t) => [t, ...(t.subtasks ?? [])]).map((t) => [t.key, t] as const))
    expect(evaluateMove('rev', byKey('DEMO-222')).blocker).toContain('no pull request raised') // in progress, no PR
    const riding = byKey('DEMO-220').subtasks!.find((s) => s.key === 'DEMO-220-2')!
    expect(evaluateMove('rev', riding, index).blocker).toBeNull() // parent DEMO-220 has PR #430 open
  })

  it('has QA tickets in the lane and one waiting in To Do — none of the dev tickets counts as one', () => {
    expect(isQaTicket(byKey('DEMO-245')) && isQaTicket(byKey('DEMO-246')) && isQaTicket(byKey('DEMO-247'))).toBe(true)
    expect(byKey('DEMO-247').column).toBe('todo')
    expect(isQaTicket(byKey('DEMO-244'))).toBe(false) // labelled qa-failed: a dev bug, not a QA ticket
  })

  it('mixes ownership and nests sub-tasks', () => {
    expect(d.tickets.some((t) => t.mine === false)).toBe(true) // someone else's ticket
    expect(d.tickets.some((t) => t.assignee == null)).toBe(true) // unassigned
    expect(byKey('DEMO-220').subtasks!.some((s) => s.mine === false)).toBe(true) // sub-task owned by QA
    expect(byKey('DEMO-220').subtasks!.some((s) => (s.subtasks ?? []).length > 0)).toBe(true) // nested child
    expect(byKey('DEMO-223').mine).toBe(false) // their parent…
    expect(byKey('DEMO-223').subtasks![0].mine).not.toBe(false) // …carrying my sub-task
  })

  it('covers the card edges', () => {
    expect(d.tickets.some((t) => t.storyPoints == null)).toBe(true)
    expect(d.tickets.some((t) => (t.storyPoints ?? 0) >= 21)).toBe(true)
    expect(d.tickets.some((t) => !t.description)).toBe(true)
    expect(d.tickets.some((t) => t.title.length > 90)).toBe(true)
    expect(d.tickets.some((t) => t.sprintOverflow)).toBe(true)
    expect(d.tickets.some((t) => (t.branches ?? []).length > 1)).toBe(true)
  })

  it('has history and raised rows worth browsing', () => {
    expect(d.completed.length).toBeGreaterThan(10)
    expect(d.completed.some((c) => c.mine === false)).toBe(true)
    expect((d.raised ?? []).some((r) => (r.assigneeLog ?? []).length >= 4)).toBe(true)
    expect((d.raised ?? []).some((r) => r.assignee == null)).toBe(true)
    // The Raised "With me" chip needs a row handed back to the demo user.
    expect((d.raised ?? []).some((r) => isAssignedToMe(r.assignee, d.user))).toBe(true)
  })

  it('never points at a real host', () => {
    const json = JSON.stringify(d)
    // example.com, or the invented Dynatrace tenants (a Dynatrace link can only be on a *.dynatrace.com host)
    for (const url of json.match(/https?:\/\/[^"\\\s]+/g) ?? [])
      expect(url).toMatch(/\/\/(?:[a-z.]*example\.com|(?:abc12345|def67890|zzz99999)\.(?:live|apps)\.dynatrace\.com)(\/|$)/)
  })
})

describe('demo dump — every move scenario', () => {
  const d = demoDump()
  const index = new Map(d.tickets.flatMap(function flat(t): Ticket[] { return [t, ...(t.subtasks ?? []).flatMap(flat)] }).map((t) => [t.key, t] as const))
  const byKey = (k: string) => d.tickets.find((t) => t.key === k)!
  const nested = (k: string) => index.get(k)!

  it('puts at least one ticket in every move target', () => {
    const at = new Set(d.tickets.map((t) => moveTargetOf(t)))
    for (const target of MOVE_TARGETS) expect(at, target).toContain(target)
  })

  it('locks a Done ticket: every move is refused, never forcible, and only Undo moves it', () => {
    const done = d.tickets.filter((t) => t.column === 'done')
    expect(done.length).toBeGreaterThan(0)
    for (const t of done) {
      for (const to of MOVE_TARGETS) {
        if (to === 'done') continue
        expect(checkMove(t, to)).toMatchObject({ kind: 'lane', reason: DONE_LOCKED })
      }
    }
    expect(demoMoveVerdict(byKey('DEMO-250'), 'rev', 'force')).toMatchObject({ ok: false, forcible: false })
    expect(demoMoveVerdict(byKey('DEMO-250'), 'rev', 'undo')).toMatchObject({ ok: true })
  })

  it('takes Next Sprint entrants from To Do, Blocked, the QA shelf and On Hold only', () => {
    for (const k of ['DEMO-201', 'DEMO-210', 'DEMO-246', 'DEMO-260', 'DEMO-249']) expect(checkMove(byKey(k), 'next').reason, k).toBeNull()
    for (const k of ['DEMO-220', 'DEMO-230', 'DEMO-245']) expect(checkMove(byKey(k), 'next'), k).toMatchObject({ kind: 'lane', reason: expect.stringContaining('Only To Do') })
  })

  it('lets a Next Sprint ticket go back to To Do and nowhere else — from every kind of future sprint', () => {
    for (const k of ['DEMO-270', 'DEMO-271', 'DEMO-273']) {
      expect(moveTargetOf(byKey(k)), k).toBe('next')
      expect(checkMove(byKey(k), 'todo').reason).toBeNull()
      expect(checkMove(byKey(k), 'prog')).toMatchObject({ kind: 'lane', reason: expect.stringContaining('back to To Do') })
    }
  })

  it('recognises QA tickets by type, by label and by title, and keeps each in the lane', () => {
    expect(byKey('DEMO-245').type).toMatch(/QA/) // by type
    expect(byKey('DEMO-248').type).toBe('Task') // by its qa-ticket label only
    expect(byKey('DEMO-249').type).toBe('Task') // by its [QA] title only
    for (const k of ['DEMO-245', 'DEMO-248', 'DEMO-249']) {
      expect(isQaTicket(byKey(k)), k).toBe(true)
      expect(checkMove(byKey(k), 'prog'), k).toMatchObject({ kind: 'lane', reason: expect.stringContaining('A QA ticket can only') })
      expect(checkMove(byKey(k), 'qa').reason, k).toBeNull()
    }
    expect(byKey('DEMO-248').column).toBe('blocked') // the lane from Blocked
    expect(byKey('DEMO-249').column).toBe('hold') // …and from On Hold
    expect(checkMove(byKey('DEMO-220'), 'qaip')).toMatchObject({ kind: 'lane', reason: expect.stringContaining('Only QA tickets') })
  })

  it('shows a QA ticket I raised, linked to my Blocked ticket, in To Do', () => {
    const qa = byKey('DEMO-247')
    expect(isQaTicket(qa)).toBe(true)
    expect(qa.reporter).toMatch(/^Demo User/)
    expect(qa.assignee).not.toMatch(/^Demo User/)
    expect(qa.column).toBe('todo')
    const blocked = byKey((qa.related ?? [])[0].key!)
    expect(blocked).toMatchObject({ column: 'blocked', assignee: expect.stringMatching(/^Demo User/) })
    expect((d.raised ?? []).some((r) => r.key === 'DEMO-247')).toBe(true) // and it is listed under Raised by me
  })

  it('refuses In Review for a declined-only PR and for a sub-ticket whose parent has no open PR', () => {
    expect(evaluateMove('rev', byKey('DEMO-226')).blocker).toContain('no pull request raised')
    expect(evaluateMove('rev', nested('DEMO-225-1'), index).blocker).toContain('its parent DEMO-225 has no open one')
  })

  it('judges sub-tickets against their parent for Done', () => {
    expect(evaluateMove('done', nested('DEMO-220-2'), index).blocker).toBeNull() // no PR of its own, parent has a QA ticket
    const refused = evaluateMove('done', byKey('DEMO-223-1'), index).blocker
    expect(refused).toContain('#428 still open')
    expect(refused).toContain('no QA ticket raised (on it or its parent)')
  })

  it('passes the Done gate on a linked QA ticket, not only a QA sub-task', () => {
    const t = byKey('DEMO-237')
    expect(t.subtasks ?? []).toHaveLength(0)
    expect(evaluateMove('done', t).blocker).toBeNull()
  })

  it('warns, without refusing, when a ticket with an open PR goes On Hold', () => {
    const v = evaluateMove('hold', byKey('DEMO-220'))
    expect(v.blocker).toBeNull()
    expect(v.warnings.join(' ')).toContain('#430 is still open')
  })

  it('lets ⌥ force a gate but never the lane', () => {
    expect(demoMoveVerdict(byKey('DEMO-241'), 'done')).toMatchObject({ ok: false, forcible: true })
    expect(demoMoveVerdict(byKey('DEMO-241'), 'done', 'force')).toMatchObject({ ok: true, status: 'Done' })
    expect(demoMoveVerdict(byKey('DEMO-248'), 'prog', 'force')).toMatchObject({ ok: false, forcible: false })
  })

  it('has cards with all-green and with amber readiness dots, and none on To Do or QA tickets', () => {
    expect(readinessOf(byKey('DEMO-242'), index)).toMatchObject({ rev: null, done: { reason: null } })
    expect(readinessOf(byKey('DEMO-210'), index)?.rev?.reason).toBeNull() // its PR is enough for In Review…
    expect(readinessOf(byKey('DEMO-210'), index)?.done.reason).toBeTruthy() // …but not for Done
    expect(readinessOf(byKey('DEMO-201'), index)).toBeNull()
    expect(readinessOf(byKey('DEMO-248'), index)).toBeNull()
  })
})
