// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { DynatraceItem } from '../../types'
import { DynatraceRow } from './Dynatrace'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement | null = null
let root: ReturnType<typeof createRoot> | null = null
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  host = root = null
})

const NOW = Date.parse('2026-10-11T12:00:00Z')
const TRACE_URL = 'https://abc12345.live.dynatrace.com/#trace;gtf=2026-02-26T13:45:00+05:30%20to%202026-02-26T14:00:00+05:30;traceId=9f3c1d5e7a2b4c6d8e0f1a2b3c4d5e6f'
const trace: DynatraceItem = {
  url: TRACE_URL,
  kind: 'trace',
  host: 'classic',
  tenant: 'prod',
  window: { from: '2026-02-26T08:10:00Z', to: '2026-02-26T08:35:00Z' },
  status: 'read',
  findings: ['12 spans across 3 services (frontend → gateway → payments); root: POST /api/pay', '4 failed spans; the failure originates in payments: POST /charge'],
  fetchedAt: '2026-10-11T11:00:00Z',
}

const render = (item: DynatraceItem, timeZone: string | null = 'UTC') => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(createElement(DynatraceRow, { item, now: NOW, timeZone })))
  return host.querySelector<HTMLElement>('[data-dynatrace-item]')!
}

describe('DynatraceRow', () => {
  it('shows kind, tenant, window, status, every finding and the ticket’s own link', () => {
    const row = render(trace)
    const text = row.textContent ?? ''
    expect(row.getAttribute('data-status')).toBe('read')
    expect(text).toContain('Read')
    expect(text).toContain('Trace')
    expect(text).toContain('prod')
    expect(text).toContain('2026-02-26 08:10–08:35')
    expect(row.querySelectorAll('li')).toHaveLength(2)
    expect(text).toContain('12 spans across 3 services (frontend → gateway → payments); root: POST /api/pay')
    expect(text).toContain('4 failed spans; the failure originates in payments: POST /charge')
    const a = row.querySelector('a')!
    expect(a.getAttribute('href')).toBe(TRACE_URL)
    expect(a.getAttribute('target')).toBe('_blank')
    expect(a.getAttribute('rel')).toBe('noopener noreferrer')
    expect(a.getAttribute('aria-label')).toContain('trace')
    expect(row.querySelector('[data-dynatrace-stale]')).toBeNull()
    expect(row.className).not.toContain('border-dashed')
  })

  it('writes the window in the zone it is given', () => {
    expect(render(trace, 'Asia/Kolkata').textContent).toContain('2026-02-26 13:40–14:05')
  })

  it('never turns a link that is not a web address into an anchor', () => {
    const row = render({ ...trace, url: 'javascript:alert(1)' })
    expect(row.querySelector('a')).toBeNull()
    expect(row.textContent).toContain('link unavailable')
  })

  it('lists a tenant that is not in DYNATRACE_TENANTS muted, with the reason and no findings', () => {
    const row = render({
      url: 'https://zzz99999.live.dynatrace.com/#problems/problemdetails;pid=1',
      kind: 'problem',
      host: 'classic',
      tenant: 'zzz99999',
      status: 'unconfigured-tenant',
      findings: [],
      note: 'Tenant zzz99999 is not in DYNATRACE_TENANTS — not read',
    })
    expect(row.getAttribute('data-status')).toBe('unconfigured-tenant')
    expect(row.textContent).toContain('Tenant not listed')
    expect(row.textContent).toContain('Tenant zzz99999 is not in DYNATRACE_TENANTS — not read')
    expect(row.querySelector('li')).toBeNull()
    expect(row.querySelector('a')).not.toBeNull()
    expect(row.className).toContain('border-dashed') // a read answer has a solid border, this one was never asked
  })

  it('marks an answer carried forward: when it was last read, and that Dynatrace could not be re-read', () => {
    const row = render({ ...trace, status: 'unreachable', stale: true, fetchedAt: '2026-10-11T09:00:00Z' })
    const stale = row.querySelector('[data-dynatrace-stale]')!
    expect(row.hasAttribute('data-stale')).toBe(true)
    expect(stale.textContent).toContain('Last read 3h ago; Dynatrace could not be re-read')
    expect(row.textContent).toContain('Unreachable')
    expect(row.querySelectorAll('li')).toHaveLength(2) // the earlier answer is still shown
  })

  it('shows why nothing was found', () => {
    const row = render({ ...trace, status: 'empty', findings: [], note: 'No spans for this trace id in the window' })
    expect(row.textContent).toContain('Nothing found')
    expect(row.textContent).toContain('No spans for this trace id in the window')
  })

  it('tolerates an item with almost nothing in it (older or hand-edited dump)', () => {
    const row = render({ url: TRACE_URL, kind: 'other', host: 'platform', tenant: '', status: 'read' } as DynatraceItem)
    expect(row.textContent).toContain('Link')
    expect(row.querySelector('li')).toBeNull()
    expect(row.querySelector('a')).not.toBeNull()
  })
})
