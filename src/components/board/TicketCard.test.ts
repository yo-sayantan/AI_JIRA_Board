// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Ticket } from '../../types'
import { DRAG_GHOST_OPACITY, DRAG_MIME, TicketCard } from './TicketCard'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement | null = null
let root: ReturnType<typeof createRoot> | null = null
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  host = root = null
  vi.useRealTimers()
})

const ticket: Ticket = { key: 'ABC-1', title: 'A card', status: 'In Progress', column: 'prog' }

describe('quiet card semantics', () => {
  it('uses the ticket title as a heading inside the operable card', () => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => root!.render(createElement(TicketCard, { ticket, now: Date.now(), onOpen: () => {} })))
    const card = host.querySelector('[role="button"]')!
    expect(card.querySelector('h3')?.textContent).toBe('A card')
  })
})

describe('dragging a card', () => {
  it('carries a translucent clone, so the drop zone stays visible through it', () => {
    vi.useFakeTimers()
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => root!.render(createElement(TicketCard, { ticket, now: Date.now(), onOpen: () => {}, draggable: true })))

    const setDragImage = vi.fn()
    const data: Record<string, string> = {}
    const ev = new Event('dragstart', { bubbles: true })
    Object.defineProperty(ev, 'dataTransfer', { value: { setData: (k: string, v: string) => (data[k] = v), setDragImage, effectAllowed: '' } })
    Object.defineProperty(ev, 'clientX', { value: 30 })
    Object.defineProperty(ev, 'clientY', { value: 20 })
    act(() => { host!.querySelector('.ticket-card')!.dispatchEvent(ev) })

    expect(data[DRAG_MIME]).toBe('ABC-1')
    expect(setDragImage).toHaveBeenCalledTimes(1)
    const [ghost] = setDragImage.mock.calls[0] as [HTMLElement]
    expect(Number(ghost.style.opacity)).toBe(DRAG_GHOST_OPACITY)
    expect(DRAG_GHOST_OPACITY).toBeLessThan(0.8) // visibly see-through…
    expect(DRAG_GHOST_OPACITY).toBeGreaterThan(0.3) // …but still a card you can read
    expect(ghost.isConnected).toBe(true) // the browser reads it right now
    act(() => { vi.runAllTimers() })
    expect(ghost.isConnected).toBe(false) // and it never lingers in the page
  })
})

describe('build chips', () => {
  const render = (t: Ticket) => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => root!.render(createElement(TicketCard, { ticket: t, now: Date.parse('2026-10-11T10:00:00Z'), onOpen: () => {} })))
    return host.querySelector('[aria-label="Latest builds"]')
  }

  it('shows one chip per environment, in one row, with result and number', () => {
    const row = render({
      ...ticket,
      branch: 'feature/ABC-1',
      builds: [
        { env: 'qa', repo: 'svc', branch: 'feature/ABC-1', number: 412, result: 'SUCCESS', at: '2026-10-11T08:00:00Z' },
        { env: 'uat', repo: 'svc', branch: 'feature/ABC-1', number: 9, result: 'FAILURE', at: '2026-10-11T09:00:00Z', failedStage: 'Deploy' },
      ],
    })
    expect(row).not.toBeNull()
    const chips = [...row!.children] as HTMLElement[]
    expect(chips.map((c) => c.textContent)).toEqual(['QA✓Passed#412', 'UAT✗Failed#9'])
    expect(chips[1].title).toContain("Failed at stage 'Deploy'")
  })

  it('renders nothing for a dump without builds', () => {
    expect(render(ticket)).toBeNull()
  })
})

describe('vulnerability chip', () => {
  const render = (t: Ticket) => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => root!.render(createElement(TicketCard, { ticket: t, now: Date.parse('2026-10-11T10:00:00Z'), onOpen: () => {} })))
    return host.querySelector('[aria-label^="Checkmarx:"]') as HTMLElement | null
  }
  const vulnFixes = {
    scannedAt: '2026-10-11T06:00:00Z',
    project: 'svc',
    branch: 'feature/ABC-1',
    baseBranch: 'develop',
    branchScanAt: '2026-10-09T08:00:00Z',
    baseScanAt: '2026-10-01T07:00:00Z',
    items: [
      { target: 'CVE-2021-44228', kind: 'cve' as const, status: 'fixed' as const, severity: 'CRITICAL' },
      { target: 'log4j-core 2.14.1', kind: 'package' as const, status: 'fixed' as const },
      { target: 'SQL_Injection', kind: 'sast' as const, status: 'open' as const, severity: 'HIGH' },
    ],
  }

  it('shows one compact chip with fixed / total and lists every target in its tooltip', () => {
    const chip = render({ ...ticket, vulnFixes })
    expect(chip).not.toBeNull()
    expect(chip!.textContent).toBe('2/3 fixed')
    expect(chip!.getAttribute('aria-label')).toBe('Checkmarx: 2 of 3 vulnerabilities fixed')
    expect(chip!.title).toContain('✗ SQL_Injection · Open · HIGH')
    expect(chip!.title).toContain('✓ CVE-2021-44228 · Fixed · CRITICAL')
  })

  it('sits on the build row without changing the build chips', () => {
    render({ ...ticket, vulnFixes, branch: 'feature/ABC-1', builds: [{ env: 'qa', repo: 'svc', branch: 'feature/ABC-1', number: 1, result: 'SUCCESS' }] })
    const builds = host!.querySelector('[aria-label="Latest builds"]')!
    expect(builds.children.length).toBe(1)
    expect(builds.parentElement!.firstElementChild!.getAttribute('aria-label')).toMatch(/^Checkmarx:/)
  })

  it('renders nothing without results', () => {
    expect(render(ticket)).toBeNull()
    expect(render({ ...ticket, vulnFixes: { ...vulnFixes, items: [] } })).toBeNull()
  })
})
