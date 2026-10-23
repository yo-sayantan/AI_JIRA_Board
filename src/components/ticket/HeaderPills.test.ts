// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { Ticket } from '../../types'
import { PriorityIcon } from '../common/Icons'
import { contrastRatio } from '../../lib/tone'
import { FILL_MIN_CONTRAST, HeaderPills, headerPills, qaPill, readableFill, subtaskPill } from './HeaderPills'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement | null = null
let root: ReturnType<typeof createRoot> | null = null
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  host = root = null
})

const sub = (key: string, status: string, column: Ticket['column'], extra: Partial<Ticket> = {}): Ticket => ({ key, title: key, status, column, ...extra })
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
  subtasks: [sub('T-380', 'Done', 'done'), sub('T-381', 'Done', 'done'), sub('T-382', 'In Progress', 'prog'), sub('T-383', 'In validation', 'qa', { title: 'QA: verify the flow', type: 'Sub-task' })],
}

function render(t: Ticket) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(createElement(HeaderPills, { ticket: t })))
  return host
}

describe('drawer status banners', () => {
  it('reads in four groups — state · ticket · related work · release — in that order', () => {
    const pills = headerPills(ticket)
    expect(pills.map((p) => [p.group, p.kind, p.label])).toEqual([
      ['state', 'status', 'In Progress'],
      ['state', 'pr', 'Changes requested'],
      ['ticket', 'priority', 'High'],
      ['ticket', 'type', 'Bug'],
      ['related', 'subtasks', '2/4 sub-tasks'],
      ['related', 'qa', 'In validation'],
      ['release', 'version', '2026.4'],
    ])
    // the facts that decide what happens next are filled; the rest tinted
    expect(pills.filter((p) => p.filled).map((p) => p.kind)).toEqual(['status', 'pr'])
  })

  it('are banners, not controls: no link, no button, nothing focusable, a default cursor', () => {
    const el = render(ticket)
    expect(el.querySelector('a, button, [tabindex], [role="button"]')).toBeNull()
    for (const p of [...el.querySelectorAll('[data-pill]')] as HTMLElement[]) {
      expect(p.className, p.dataset.pill).toContain('cursor-default')
      expect(p.className).not.toContain('cursor-pointer')
      expect(p.getAttribute('title')).toBeTruthy() // a description on hover, nothing to click
    }
  })

  it('draws the groups as labelled lists of facts, separated by a hairline', () => {
    const el = render(ticket)
    expect(el.querySelector('ul')!.getAttribute('aria-label')).toBe('Ticket summary')
    const groups = [...el.querySelectorAll('li[role="group"]')]
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual(['State', 'Ticket', 'Related work', 'Release'])
    expect(el.querySelectorAll('li > span[aria-hidden].w-px')).toHaveLength(3) // between four groups
  })

  it('sizes every pill to its content — one height, one left edge, one right edge — each with its icon', () => {
    const el = render(ticket)
    const pills = [...el.querySelectorAll('[data-pill]')] as HTMLElement[]
    expect(pills).toHaveLength(7)
    for (const p of pills) {
      expect(p.className).not.toMatch(/(^|\s)w-\[/) // the content decides the width…
      expect(p.className).toContain('max-w-[16rem]') // …up to a cap for a very long version
      for (const cls of ['h-7', 'pl-2', 'pr-3', 'gap-1.5']) expect(p.className, `${p.dataset.pill} ${cls}`).toContain(cls)
      expect(p.querySelector('svg'), p.dataset.pill).toBeTruthy()
      const slot = p.querySelector('span[aria-hidden]') as HTMLElement
      expect(slot.className).toContain('h-4')
      expect(slot.className).toContain('w-4')
    }
  })

  it('leaves out what does not apply: no PR, no sub-tasks, no versions — only the state and the ticket remain', () => {
    const el = render({ ...ticket, prs: [], subtasks: [], fixVersions: [] })
    expect([...el.querySelectorAll('[data-pill]')].map((p) => (p as HTMLElement).dataset.pill)).toEqual(['status', 'priority', 'type'])
    expect(el.querySelectorAll('li[role="group"]')).toHaveLength(2)
  })

  it('shows sub-task progress in a colour that tracks it: none done slate, some blue, all green', () => {
    const color = (done: number, total: number) =>
      subtaskPill({ ...ticket, subtasks: Array.from({ length: total }, (_, i) => sub(`S-${i}`, 'x', i < done ? 'done' : 'prog')) })!
    expect(color(0, 3).color).toBe('#64748b')
    expect(color(1, 3).color).toBe('#3b82f6')
    expect(color(3, 3).color).toBe('#22c55e')
    expect(color(3, 3).label).toBe('3/3 sub-tasks')
    expect(subtaskPill({ ...ticket, subtasks: [] })).toBeNull()
  })

  it('shows the QA ticket’s state — and the gap when a ticket with code has none', () => {
    const qa = (status: string, column: Ticket['column']) => qaPill({ ...ticket, subtasks: [sub('Q-1', status, column, { title: 'QA: verify', type: 'Sub-task' })] })!
    expect(qa('Ready for QA', 'qa')).toMatchObject({ label: 'Ready for QA', color: '#14b8a6' })
    expect(qa('Done', 'done')).toMatchObject({ label: 'QA done', color: '#22c55e' })
    expect(qa('Blocked', 'blocked')).toMatchObject({ label: 'QA blocked', color: '#ef4444' })
    expect(qaPill({ ...ticket, subtasks: [] })).toMatchObject({ label: 'No QA ticket', color: '#f59e0b' }) // has a PR, nothing to test it
    expect(qaPill({ ...ticket, subtasks: [], prs: [] })).toBeNull() // nothing to test yet
    expect(qaPill({ ...ticket, parentKey: 'P-1' })).toBeNull() // a sub-ticket's QA lives on its parent
  })

  it('draws the priority glyph without a tile behind it', () => {
    const html = (bare: boolean) => {
      const box = document.createElement('div')
      const r = createRoot(box)
      act(() => r.render(createElement(PriorityIcon, { rank: 4, color: '#f97316', bare })))
      const out = box.innerHTML
      act(() => r.unmount())
      return out
    }
    expect(html(false)).toContain('<rect')
    expect(html(true)).not.toContain('<rect')
    expect(html(true)).toContain('<path')
  })
})

describe('pill contrast', () => {
  // Every colour a header pill can be filled with: the board's columns, and the PR states.
  const FILLS = ['#2f86ff', '#8b94a8', '#fb3f5f', '#b05cff', '#6aa9a1', '#2fcf6f', '#ff8a1f', '#ff9f1c', '#9a63ff', '#17c47a', '#ff4466', '#e11d48', '#5f9a93']

  it('darkens a fill until white text on it clears AA (4.5:1) — the pale ones were 2:1', () => {
    for (const c of FILLS) expect(contrastRatio('#ffffff', readableFill(c)), c).toBeGreaterThanOrEqual(FILL_MIN_CONTRAST)
    expect(contrastRatio('#ffffff', '#2fcf6f')).toBeLessThan(2.5) // what Done looked like before
  })

  it('keeps the hue: a colour that already reads is left alone, the rest only get deeper', () => {
    expect(readableFill('#e11d48')).toBe('#e11d48')
    const hue = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
      return r >= g && r >= b ? 'r' : g >= b ? 'g' : 'b'
    }
    for (const c of FILLS) expect(hue(readableFill(c)), c).toBe(hue(c))
    expect(readableFill('var(--x)')).toBe('var(--x)')
  })
})
