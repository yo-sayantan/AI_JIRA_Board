// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Ticket } from '../../types'
import { Stats } from './Stats'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement | null = null
let root: ReturnType<typeof createRoot> | null = null
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  host = root = null
})

const t = (key: string, column: Ticket['column']): Ticket => ({ key, title: key, status: column, column })

function mount(active: Parameters<typeof Stats>[0]['active'], onSelect = vi.fn()) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const tickets = [t('A-1', 'todo'), t('A-2', 'todo'), t('A-3', 'prog'), t('A-4', 'hold')]
  act(() => root!.render(createElement(Stats, { tickets, completedCount: null, raisedCount: null, active, onSelect })))
  return { chips: [...host.querySelectorAll('button')], onSelect }
}

describe('the chip row', () => {
  it('starts with All, selected by default (nothing filtered), counting every ticket', () => {
    const { chips } = mount(null)
    expect(chips[0].textContent).toMatch(/^\s*All\s*4$/)
    expect(chips[0].getAttribute('aria-pressed')).toBe('true')
    expect(chips.some((c) => /next sprint/i.test(c.textContent ?? ''))).toBe(false) // it is a space in To Do now
  })

  it('a column chip filters; picking it again returns to All', () => {
    const picked = mount('todo')
    expect(picked.chips[0].getAttribute('aria-pressed')).toBe('false')
    const todo = picked.chips.find((c) => /^To Do/.test(c.textContent ?? ''))!
    expect(todo.getAttribute('aria-pressed')).toBe('true')
    act(() => todo.click())
    expect(picked.onSelect).toHaveBeenLastCalledWith(null)
  })
})

function mountWith(props: Record<string, unknown>) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(createElement(Stats, { tickets: [], completedCount: 130, raisedCount: null, active: null, onSelect: () => {}, ...props } as never)))
  return host
}

it('separates board filters from destination actions with accessible names', () => {
  const el = mountWith({
    raisedCount: { total: 8, open: 3 },
    takenCount: { total: 2, worked: 1 },
  })
  const toolbars = [...el.querySelectorAll('[role="toolbar"]')]
  expect(toolbars.map((bar) => bar.getAttribute('aria-label'))).toEqual([
    'Board filters',
    'Board destinations',
  ])
  const filters = [...toolbars[0].querySelectorAll('button')]
  expect(filters.every((button) => button.hasAttribute('aria-pressed'))).toBe(true)
  const destinations = [...toolbars[1].querySelectorAll('button')]
  expect(destinations.every((button) => !button.hasAttribute('aria-pressed'))).toBe(true)
})

describe('the board’s pointer to the tickets taken from you', () => {
  it('shows a chip with the count, and opens Completed already filtered to them', () => {
    const open = vi.fn()
    const el = mountWith({ takenCount: { total: 5, worked: 3 }, onOpenCompleted: open })
    const chip = el.querySelector('[data-taken-chip]') as HTMLButtonElement
    expect(chip.textContent).toContain('Taken from you')
    expect(chip.getAttribute('title')).toContain('3 of them after you had worked on them')
    act(() => chip.click())
    expect(open).toHaveBeenCalledWith({ taken: true })
  })

  it('leaves the Completed button as it was: a plain open, no filter', () => {
    const open = vi.fn()
    const el = mountWith({ takenCount: { total: 5, worked: 3 }, onOpenCompleted: open })
    const gold = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes('Completed')) as HTMLButtonElement
    act(() => gold.click())
    expect(open).toHaveBeenCalledWith() // no options
  })

  it('is hidden when nothing was taken, or the archive is off', () => {
    expect(mountWith({ takenCount: { total: 0, worked: 0 } }).querySelector('[data-taken-chip]')).toBeNull()
    act(() => root?.unmount())
    host?.remove()
    expect(mountWith({ takenCount: null }).querySelector('[data-taken-chip]')).toBeNull()
    act(() => root?.unmount())
    host?.remove()
    expect(mountWith({ takenCount: { total: 2, worked: 1 }, completedCount: null }).querySelector('[data-taken-chip]')).toBeNull()
  })
})
