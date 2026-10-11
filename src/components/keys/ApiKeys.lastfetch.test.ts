// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { SourceStatus } from '../../types'
import { ApiKeysDialog } from './ApiKeys'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement | null = null
let root: ReturnType<typeof createRoot> | null = null
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  host = root = null
})

const checkmarx: SourceStatus = {
  state: 'read',
  detail: 'Checkmarx: 3 vulnerability-fix tickets looked up (7 targets: 4 fixed · 2 open · 1 not found) — 2 with open findings',
  at: new Date(Date.now() - 14 * 60_000).toISOString(),
}

const dynatrace: SourceStatus = {
  state: 'read',
  detail: 'Dynatrace: 3 tickets looked up (5 links: 3 read · 1 empty · 1 unconfigured tenant) — 2 with failed requests',
  at: new Date(Date.now() - 6 * 60_000).toISOString(),
}

const open = (lastFetch?: Record<string, SourceStatus>) => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() =>
    root!.render(
      createElement(ApiKeysDialog, {
        open: true,
        status: null,
        failed: false,
        health: {},
        lastFetch,
        onClose: () => {},
        onRefresh: () => {},
        onSave: async () => ({ ok: true }) as never,
        onTest: async () => ({ service: 'x', status: 'not-configured' }) as never,
      }),
    ),
  )
  return document.body
}

const select = (name: string) => {
  const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes(name))
  expect(btn, `a "${name}" button`).toBeTruthy()
  act(() => btn!.click())
}

describe('API keys · the "Last fetch" line of a proof source', () => {
  it('shows what the last fetch did with Checkmarx, without repeating its name', () => {
    open({ checkmarx })
    select('Checkmarx')
    const line = document.querySelector('[data-last-fetch]')
    expect(line).not.toBeNull()
    expect(line!.textContent).toContain('Last fetch')
    expect(line!.textContent).toContain('3 vulnerability-fix tickets looked up')
    expect(line!.textContent).toContain('14m ago')
  })

  it('shows what the last fetch did with Dynatrace', () => {
    open({ checkmarx, dynatrace })
    select('Dynatrace')
    const line = document.querySelector('[data-last-fetch]')
    expect(line).not.toBeNull()
    expect(line!.textContent).toContain('3 tickets looked up (5 links: 3 read · 1 empty · 1 unconfigured tenant)')
    expect(line!.textContent).toContain('2 with failed requests')
    expect(line!.textContent).toContain('6m ago')
    expect(line!.textContent).not.toContain('Checkmarx')
  })

  it('reserves the same one-line row before the first run', () => {
    open(undefined)
    select('Checkmarx')
    expect(document.querySelector('[data-last-fetch]')!.textContent).toContain('Not run yet')
  })

  it('is not drawn for a service that is not a proof source', () => {
    open({ checkmarx })
    select('Bitbucket')
    expect(document.querySelector('[data-last-fetch]')).toBeNull()
  })

  it('is a fixed-height row (no layout jump between states)', () => {
    open({ checkmarx: { ...checkmarx, state: 'not-configured', detail: 'Checkmarx not configured — missing CHECKMARX_API_KEY' } })
    select('Checkmarx')
    expect(document.querySelector('[data-last-fetch]')!.className).toContain('h-7')
  })
})
