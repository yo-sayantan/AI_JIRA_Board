// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { bundledDemoDump } from '../../demo/data'
import { CompletedOverlay } from './Completed'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement | null = null
let root: ReturnType<typeof createRoot> | null = null
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  host = root = null
})

const items = bundledDemoDump(Date.parse('2026-10-08T09:00:00Z')).completed
const top = items.filter((c) => !c.parentKey)
const takenTop = top.filter((c) => c.takenFromMe?.reason)

function render(showTaken = false) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(createElement(CompletedOverlay, { open: true, onClose: () => {}, items, onOpen: () => {}, showTaken })))
  return host
}
const rows = (el: HTMLElement) => el.querySelectorAll('button[aria-label="Expand details"], button[aria-label="Collapse details"]').length
const chip = (el: HTMLElement, text: string) => [...el.querySelectorAll('button[aria-pressed]')].find((b) => b.textContent?.trim().startsWith(text)) as HTMLButtonElement

describe('Completed: taken from you', () => {
  it('lists taken tickets with their banner, but never counts them as done', () => {
    expect(takenTop.length).toBeGreaterThanOrEqual(5)
    const el = render()
    expect(rows(el)).toBe(top.length) // every row is listed (context parents shown by default)
    const text = el.textContent ?? ''
    expect(text).toContain(`${takenTop.length} taken from you`)
    expect(text).toContain('Unassigned by Priya Raman')
    expect(text).toContain('we have to stop the pipeline move for now')
    const doneTile = [...el.querySelectorAll('div')].find((d) => d.textContent === `${top.filter((c) => c.mine !== false && !c.takenFromMe).length}Tickets done`)
    expect(doneTile, 'the Tickets done tile leaves taken rows out').toBeTruthy()
  })

  it('filters to the taken tickets, then to one reason', () => {
    const el = render()
    act(() => chip(el, 'Taken from you').click())
    expect(rows(el)).toBe(takenTop.length)
    const unassigned = chip(el, 'Unassigned')
    expect(unassigned, 'reason chips appear once the filter is on').toBeTruthy()
    act(() => unassigned.click())
    expect(rows(el)).toBe(takenTop.filter((c) => (c.takenFromMe!.reasons ?? [c.takenFromMe!.reason]).includes('backlog')).length)
  })

  it('opens the full banner — who moved it, the comment, and my work on it — when a row is expanded', () => {
    const el = render()
    act(() => chip(el, 'Taken from you').click())
    const firstExpand = el.querySelector('button[aria-label="Expand details"]') as HTMLButtonElement
    act(() => firstExpand.click())
    const text = el.textContent ?? ''
    expect(text).toMatch(/You had worked on it:|No work of yours recorded on it/)
  })

  it('marks every taken row with two pills in its title line: why it left you, and whether you worked on it', () => {
    const el = render()
    const pills = [...el.querySelectorAll('[data-taken-pills]')]
    expect(pills).toHaveLength(takenTop.length)
    const reasons = pills.map((p) => p.querySelector('[data-taken-reason]')!.getAttribute('data-taken-reason'))
    expect(new Set(reasons).size).toBeGreaterThanOrEqual(4) // reassigned, backlog, taken-over, cancelled, pr-declined…
    const kinds = pills.map((p) => p.querySelector('[data-taken-work]')!.getAttribute('data-taken-work'))
    expect(kinds).toContain('worked')
    expect(kinds).toContain('none')
    // visible at every width: not behind a breakpoint class
    for (const p of pills) expect(p.className).not.toMatch(/\bhidden\b/)
  })

  it('draws worked-on and never-worked tickets differently: solid and green against hollow, dashed and grey', () => {
    const el = render()
    const worked = el.querySelector('[data-taken-work="worked"]') as HTMLElement
    const none = el.querySelector('[data-taken-work="none"]') as HTMLElement
    expect(worked.textContent).toBe('You worked on it')
    expect(none.textContent).toBe('No work of yours')
    expect(worked.className).not.toContain('border-dashed')
    expect(none.className).toContain('border-dashed')
    // the whole row follows: a dashed frame for a ticket I only held
    const frame = (pill: HTMLElement) => pill.closest('.group\\/row') as HTMLElement
    expect(frame(none).style.borderStyle).toBe('dashed')
    expect(frame(worked).style.borderStyle).not.toBe('dashed')
  })

  it('filters the taken tickets to the ones you worked on, or the ones you never did', () => {
    const el = render()
    act(() => chip(el, 'Taken from you').click())
    const worked = takenTop.filter((c) => c.takenFromMe!.worked)
    const none = takenTop.filter((c) => !c.takenFromMe!.worked)
    expect(worked.length).toBeGreaterThan(0)
    expect(none.length).toBeGreaterThan(0)
    act(() => chip(el, 'You worked on it').click())
    expect(rows(el)).toBe(worked.length)
    act(() => chip(el, 'No work of yours').click())
    expect(rows(el)).toBe(none.length)
    act(() => chip(el, 'No work of yours').click()) // toggles off
    expect(rows(el)).toBe(takenTop.length)
  })

  it('opens already filtered to the taken tickets when the board’s "taken from you" chip sent you here', () => {
    expect(rows(render(true))).toBe(takenTop.length)
  })
})
