import { describe, expect, it } from 'vitest'
import { SECTION_HUE } from './TicketDetail'

describe('drawer section colours', () => {
  it('are hex colours the deck and tint helpers can use', () => {
    for (const [k, v] of Object.entries(SECTION_HUE)) expect(v, k).toMatch(/^#[0-9a-f]{6}$/i)
  })
  it('give every section that decides the work a colour of its own', () => {
    const main = [SECTION_HUE.criteria, SECTION_HUE.subtasks, SECTION_HUE.prs, SECTION_HUE.branches, SECTION_HUE.proof, SECTION_HUE.comments]
    expect(new Set(main).size).toBe(main.length)
  })
})
