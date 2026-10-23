// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { Ticket } from '../../types'
import { PriorityIcon } from '../common/Icons'
import { contrastRatio } from '../../lib/tone'
import { FILL_MIN_CONTRAST, HeaderPills, headerPills, readableFill } from './HeaderPills'

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

  it('sizes every pill to its content — one height, one left edge, one right edge — each with its icon, as a link', () => {
    const el = render(ticket)
    const pills = [...el.querySelectorAll('[data-pill]')] as HTMLElement[]
    expect(pills).toHaveLength(5)
    for (const p of pills) {
      // no fixed width (that wasted space on a short word): the content decides it, up to a cap for a long version
      expect(p.className).not.toMatch(/(^|\s)w-\[/)
      expect(p.className).toContain('max-w-[16rem]')
      // …but the same height and the same padding on every pill, so the margins match
      for (const cls of ['h-7', 'pl-2', 'pr-3', 'gap-1.5']) expect(p.className, `${p.dataset.pill} ${cls}`).toContain(cls)
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

  it('puts every icon in the same 16px slot, and draws the priority glyph without a tile behind it', () => {
    const el = render(ticket)
    for (const p of [...el.querySelectorAll('[data-pill]')]) {
      const slot = p.querySelector('span[aria-hidden]') as HTMLElement
      expect(slot.className, p.getAttribute('data-pill')!).toContain('h-4')
      expect(slot.className).toContain('w-4')
    }
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
    for (const c of FILLS) {
      expect(contrastRatio('#ffffff', readableFill(c)), c).toBeGreaterThanOrEqual(FILL_MIN_CONTRAST)
    }
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
