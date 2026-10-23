// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { Ticket } from '../../types'
import { HeaderPills, headerPills } from './HeaderPills'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement | null = null
let root: ReturnType<typeof createRoot> | null = null
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  host = root = null
})

const ticket: Ticket = {
  key: 'T-379',
  title: 'Default inquiry channel is not applied',
  status: 'In Progress',
  column: 'prog',
  priority: 'High',
  type: 'Bug',
  url: 'https://jira.example.com/browse/T-379',
  fixVersions: ['2026.4'],
  prs: [{ state: 'changes', id: 88, url: 'https://bitbucket.example.com/pr/88' }],
}

function render(t: Ticket) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(createElement(HeaderPills, { ticket: t })))
  return host
}

describe('drawer header pills', () => {
  it('reads status · priority · type · PR · version, and each opens where that value lives', () => {
    const pills = headerPills(ticket)
    expect(pills.map((p) => [p.kind, p.label])).toEqual([
      ['status', 'In Progress'],
      ['priority', 'High'],
      ['type', 'Bug'],
      ['pr', 'Changes requested'],
      ['version', '2026.4'],
    ])
    expect(pills.filter((p) => p.kind !== 'pr').every((p) => p.href === ticket.url)).toBe(true)
    expect(pills.find((p) => p.kind === 'pr')!.href).toBe('https://bitbucket.example.com/pr/88')
    expect(pills.find((p) => p.kind === 'priority')!.title).toBe('Priority: High — open in Jira to change it')
    // the facts that decide what happens next are filled; the descriptive ones tinted
    expect(pills.filter((p) => p.filled).map((p) => p.kind)).toEqual(['status', 'pr'])
  })

  it('draws every pill at one size, each with its icon, as a link with a label', () => {
    const el = render(ticket)
    const pills = [...el.querySelectorAll('[data-pill]')] as HTMLElement[]
    expect(pills).toHaveLength(5)
    for (const p of pills) {
      expect(p.className).toContain('w-[9.5rem]')
      expect(p.className).toContain('h-7')
      expect(p.querySelector('svg'), p.dataset.pill).toBeTruthy()
      expect(p.tagName).toBe('A')
      expect(p.getAttribute('aria-label')).toBeTruthy()
      expect(p.getAttribute('rel')).toBe('noopener noreferrer')
    }
  })

  it('stays a static pill — no press, no promise — when there is nowhere to go', () => {
    const el = render({ ...ticket, url: null, prs: [], fixVersions: [] })
    const pills = [...el.querySelectorAll('[data-pill]')] as HTMLElement[]
    expect(pills.map((p) => p.tagName)).toEqual(['SPAN', 'SPAN', 'SPAN'])
    expect(headerPills({ ...ticket, url: 'javascript:alert(1)' })[0].href).toBeUndefined()
  })
})
