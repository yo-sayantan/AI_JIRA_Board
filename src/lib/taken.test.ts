import { describe, expect, it } from 'vitest'
import type { CompletedTicket, TakenFromMe } from '../types'
import { completedToTicket } from '../types'
import { TAKEN_META, TAKEN_ORDER, countTaken, matchesTaken, rowDate, takenCounts, takenLine, takenMeta, whyLabel, workLabel } from './taken'

const t = (over: Partial<TakenFromMe>): TakenFromMe => ({ reason: 'backlog', reasons: ['backlog'], ...over })
const row = (key: string, taken?: Partial<TakenFromMe> | null, extra: Partial<CompletedTicket> = {}): CompletedTicket => ({
  key, title: key, ...(taken ? { takenFromMe: t(taken) } : {}), ...extra,
})

describe('taken from me — words and colours', () => {
  it('has a label, a colour and a hint for every reason, in the archive’s order', () => {
    expect(TAKEN_ORDER).toEqual(['cancelled', 'pr-declined', 'backlog', 'taken-over', 'reassigned', 'released'])
    for (const r of TAKEN_ORDER) expect(TAKEN_META[r].label && TAKEN_META[r].color && TAKEN_META[r].hint).toBeTruthy()
    expect(takenMeta('something-new').label).toBe('Taken from you') // a newer archive's word never throws
  })

  it('says who did what, and when', () => {
    expect(takenLine(t({ by: 'Roe, Sam', to: null, when: '2026-10-22T10:00:00Z' }))).toMatch(/^Unassigned by Roe, Sam · /)
    expect(takenLine(t({ reason: 'taken-over', by: 'Roe, Sam', to: 'Lee, Ann (DEV02)' }))).toBe('Given to Lee, Ann by Roe, Sam')
    expect(takenLine(t({ reason: 'released', byMe: true }))).toBe('You un-assigned yourself')
    expect(takenLine(t({ reason: 'cancelled', reasons: ['cancelled', 'backlog'], by: 'Roe, Sam', resolution: 'Cancelled' }))).toBe(
      'Unassigned by Roe, Sam · later closed as Cancelled',
    )
    expect(takenLine(t({ reason: 'pr-declined', reasons: ['pr-declined'], stillMine: true, declinedPrs: ['PR #7'] }))).toBe('PR #7 declined')
  })

  it('labels the comment as what it is — the mover’s note, or just the next comment', () => {
    expect(whyLabel(t({ why: { author: 'Roe, Sam', text: 'Pausing', byMover: true } }))).toBe('Roe, Sam wrote, when it moved')
    expect(whyLabel(t({ why: { author: 'Lee, Ann', text: 'Deployed', byMover: false } }))).toBe('Next comment — Lee, Ann')
    expect(whyLabel(t({ why: null }))).toBeNull()
  })

  it('counts by headline reason and filters by any reason a row has', () => {
    const rows = [row('A', { reason: 'cancelled', reasons: ['cancelled', 'backlog'] }), row('B', { reason: 'backlog' }), row('C')]
    const c = takenCounts(rows)
    expect([c.total, c.cancelled, c.backlog]).toEqual([2, 1, 1])
    expect(rows.filter((r) => matchesTaken(r, 'backlog')).map((r) => r.key)).toEqual(['A', 'B'])
    expect(rows.filter((r) => matchesTaken(r, 'any')).map((r) => r.key)).toEqual(['A', 'B'])
    expect(rows.filter((r) => matchesTaken(r, null))).toHaveLength(3)
  })

  it('tells a ticket I worked on from one I only held — in words, counts and the filter', () => {
    const worked = row('A', { reason: 'taken-over', worked: true, workedOn: ['PR #61 — comments', 'In Progress on your name'] })
    const held = row('B', { reason: 'reassigned', worked: false, workedOn: [] })
    expect(workLabel(worked.takenFromMe!)).toEqual({ label: 'You worked on it', hint: 'PR #61 — comments · In Progress on your name' })
    expect(workLabel(held.takenFromMe!).label).toBe('No work of yours')
    expect(workLabel(held.takenFromMe!).hint).toMatch(/no pull request/i)
    const c = takenCounts([worked, held, row('C')])
    expect([c.total, c.worked, c.none]).toEqual([2, 1, 1])
    const rows = [worked, held, row('C')]
    expect(rows.filter((r) => matchesTaken(r, 'any', 'worked')).map((r) => r.key)).toEqual(['A'])
    expect(rows.filter((r) => matchesTaken(r, 'any', 'none')).map((r) => r.key)).toEqual(['B'])
    expect(rows.filter((r) => matchesTaken(r, null, 'none')).map((r) => r.key)).toEqual(['B']) // a work filter alone still means "taken"
    expect(rows.filter((r) => matchesTaken(r, 'reassigned', 'worked'))).toEqual([]) // both must hold
    expect(rows.filter((r) => matchesTaken(r, null, null))).toHaveLength(3)
  })

  it('counts the top-level tickets taken from me for the board — not sub-tickets, not context parents', () => {
    const rows = [
      row('A', { reason: 'backlog', worked: true }),
      row('B', { reason: 'cancelled', worked: false }),
      row('C', { reason: 'backlog', worked: true }, { parentKey: 'A' }),
      row('D', { reason: 'backlog', worked: true }, { mine: false }),
      row('E'),
    ]
    expect(countTaken(rows)).toEqual({ total: 2, worked: 1 })
    expect(countTaken([])).toEqual({ total: 0, worked: 0 })
  })

  it('puts a row on the timeline at its close, else at the day it left me', () => {
    expect(rowDate(row('A', { when: '2026-10-22' }, { resolved: '2026-10-25' }))).toBe('2026-10-25')
    expect(rowDate(row('A', { when: '2026-10-22' }))).toBe('2026-10-22')
  })

  it('opens a ticket that is still open with someone else in its real column, not as Done', () => {
    expect(completedToTicket(row('A', { reason: 'backlog' }, { column: 'todo', status: 'To Do' }))).toMatchObject({ column: 'todo', done: false })
    expect(completedToTicket(row('B', null, { column: 'todo' }))).toMatchObject({ column: 'done', done: true }) // only taken rows keep it
    expect(completedToTicket(row('C', { reason: 'taken-over' }))).toMatchObject({ column: 'done', done: true })
  })
})
