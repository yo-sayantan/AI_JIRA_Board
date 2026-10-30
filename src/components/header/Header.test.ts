// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Header } from './Header'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement | null = null
let root: ReturnType<typeof createRoot> | null = null

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  host = root = null
})

function mount(overrides: Record<string, unknown> = {}) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const setQuery = vi.fn()
  act(() =>
    root!.render(
      createElement(Header, {
        data: { tickets: [], completed: [], generatedAt: '2026-10-30T10:00:00Z', user: { name: 'Doe, Alex' } },
        now: Date.parse('2026-10-30T11:00:00Z'),
        query: 'fraud',
        setQuery,
        dark: false,
        toggleTheme: () => {},
        refreshing: false,
        archiveRefreshing: false,
        archiveParallel: 1,
        served: false,
        onRefresh: () => {},
        onArchiveRefresh: () => {},
        onStopArchive: () => {},
        ...overrides,
      }),
    ),
  )
  return { host, setQuery }
}

describe('Header accessibility', () => {
  it('connects a visible-to-AT label to search and names the clear action', () => {
    const { host, setQuery } = mount()
    expect(host.querySelector('label[for="jb-search"]')?.textContent).toContain('Search tickets')
    const clear = host.querySelector('button[aria-label="Clear search"]') as HTMLButtonElement
    act(() => clear.click())
    expect(setQuery).toHaveBeenCalledWith('')
  })

  it('exposes refresh progress through one polite live region', () => {
    const { host } = mount({
      refreshing: true,
      runProgress: { done: 2, total: 5, pct: 40, phase: 'building' },
    })
    const status = host.querySelector('[role="status"][aria-live="polite"]')
    expect(status?.textContent).toMatch(/2\/5.*40%/)
  })
})
