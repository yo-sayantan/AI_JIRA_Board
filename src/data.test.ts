import { describe, expect, it } from 'vitest'
import type { JiraData, Ticket } from './types'
import { loadData } from './data'

const dump = (...tickets: Ticket[]): JiraData => ({ tickets, completed: [], notes: [] })
const load = (...tickets: Ticket[]) => loadData(dump(...tickets), new Set()).data.tickets

describe('loading a dump: where a QA ticket is placed', () => {
  const qaSub: Ticket = { key: 'T-2', title: 'QA: verify the flow', type: 'Sub-task', status: 'In Progress', column: 'prog', parentKey: 'T-1' }

  it('shows a QA sub-ticket the QA team works under In Progress as QA, not among the dev stages', () => {
    expect(load(qaSub)[0].column).toBe('qa')
  })
  it('does this for a dump written before the rule existed (the stored column was prog)', () => {
    expect(load({ ...qaSub, column: 'rev', status: 'In Review' })[0].column).toBe('qa')
  })
  it('files a QA ticket In validation (the QA team working status) in QA even in a dump that stored it elsewhere', () => {
    expect(load({ ...qaSub, status: 'In validation', column: 'prog' })[0].column).toBe('qa')
    expect(load({ ...qaSub, status: 'In validation', column: undefined as never })[0].column).toBe('qa')
  })
  it('keeps a dev ticket, and a QA ticket that is not started or finished, where the dump put it', () => {
    expect(load({ key: 'T-3', title: 'Implement the flow', type: 'Sub-task', status: 'In Progress', column: 'prog' })[0].column).toBe('prog')
    expect(load({ ...qaSub, status: 'To Do', column: 'todo' })[0].column).toBe('todo')
    expect(load({ ...qaSub, status: 'Done', column: 'done', resolved: new Date().toISOString() })[0].column).toBe('done')
  })
})
