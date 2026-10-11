// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { Ticket } from '../../types'
import { ProofPanel, proofCount } from './Proof'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement | null = null
let root: ReturnType<typeof createRoot> | null = null
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  host = root = null
})

const NOT_CONFIGURED = 'Checkmarx not configured — add the URL and key in API keys'
const base: Ticket = { key: 'PAY-7', title: 'Fix CVE-2021-44228', status: 'In Review', column: 'rev' }
const note = (state: 'not-configured' | 'unreachable', detail: string): NonNullable<Ticket['proofNotes']> => ({ checkmarx: { state, detail, at: '2026-10-11T09:00:00Z' } })
const vulnFixes: NonNullable<Ticket['vulnFixes']> = {
  scannedAt: '2026-10-11T06:00:00Z',
  project: 'payments-service',
  branch: 'feature/PAY-7',
  baseBranch: 'develop',
  branchScanAt: '2026-10-09T08:00:00Z',
  baseScanAt: '2026-10-01T07:00:00Z',
  read: {
    branch: { total: 412, sca: 380, sast: 18, other: 14, truncated: false, reported: 412 },
    base: { total: 398, sca: 380, sast: 18, other: 0, truncated: false, reported: 398 },
  },
  items: [
    { target: 'CVE-2021-44228', kind: 'cve', status: 'not-found', detail: 'Not found — in neither scan' },
    { target: 'acme-web-core 6.5.7 → 6.5.9', kind: 'package', status: 'fixed', severity: 'HIGH', detail: 'Fixed', foundOnBase: ['6.5.7'], foundOnBranch: ['6.5.9'] },
  ],
}

const render = (t: Ticket) => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(createElement(ProofPanel, { ticket: t, now: Date.parse('2026-10-11T10:00:00Z') })))
  return host
}
const group = (el: HTMLElement) => el.querySelector('section[aria-label="Vulnerabilities · Checkmarx"]')

describe('Proof · Vulnerabilities says why there is no answer', () => {
  it('a vulnerability-fix ticket Checkmarx could not look up still gets the group, with the reason', () => {
    const t = { ...base, proofNotes: note('not-configured', NOT_CONFIGURED) }
    expect(proofCount(t)).toBe(1)
    const g = group(render(t))!
    expect(g).not.toBeNull()
    expect(g.textContent).toContain(NOT_CONFIGURED)
    expect(g.querySelector('[data-proof-note]')?.getAttribute('data-state')).toBe('not-configured')
  })

  it('results carried forward show the reason above the old rows', () => {
    const t = { ...base, vulnFixes, proofNotes: note('unreachable', 'Checkmarx could not be reached — results not refreshed') }
    const text = group(render(t))!.textContent ?? ''
    expect(text).toContain('Checkmarx could not be reached — results not refreshed')
    expect(text).toContain('last results from 2026-10-11')
    expect(text).toContain('CVE-2021-44228')
  })

  it('a ticket with fresh results and no note has no note line', () => {
    expect(group(render({ ...base, vulnFixes }))!.querySelector('[data-proof-note]')).toBeNull()
  })

  it('shows what each scan returned under the comparison', () => {
    const text = group(render({ ...base, vulnFixes }))!.textContent ?? ''
    expect(text).toContain('Read 412 results on the branch scan (SCA 380 · SAST 18 · other 14); 398 on the base scan (SCA 380 · SAST 18)')
  })

  it('a package row lists the versions that carry a finding on each side', () => {
    const text = group(render({ ...base, vulnFixes }))!.textContent ?? ''
    expect(text).toContain('findings on base: 6.5.7')
    expect(text).toContain('branch: 6.5.9')
  })

  it('an older dump without any of this renders as before', () => {
    const { read: _read, ...old } = vulnFixes
    const g = group(render({ ...base, vulnFixes: old }))!
    expect(g.textContent).not.toContain('Read ')
    expect(g.querySelector('[data-proof-note]')).toBeNull()
  })

  it('nothing at all → no section', () => {
    expect(render(base).querySelector('section')).toBeNull()
    expect(proofCount(base)).toBe(0)
  })
})

describe('Proof · Linked traces & problems (Dynatrace)', () => {
  const dynatrace: NonNullable<Ticket['dynatrace']> = {
    fetchedAt: '2026-10-11T09:30:00Z',
    items: [
      {
        url: 'https://abc12345.live.dynatrace.com/#trace;traceId=9f3c1d5e7a2b4c6d8e0f1a2b3c4d5e6f',
        kind: 'trace',
        host: 'classic',
        tenant: 'prod',
        window: { from: '2026-10-11T08:10:00Z', to: '2026-10-11T08:35:00Z' },
        status: 'read',
        findings: ['4 failed spans; the failure originates in payments: POST /charge', 'HTTP 500 ×3 · 504 ×1'],
        summary: { spans: 12, failedSpans: 4 },
        fetchedAt: '2026-10-11T09:30:00Z',
      },
      {
        url: 'https://zzz99999.live.dynatrace.com/#problems/problemdetails;pid=7',
        kind: 'problem',
        host: 'classic',
        tenant: 'zzz99999',
        status: 'unconfigured-tenant',
        findings: [],
        note: 'Tenant zzz99999 is not in DYNATRACE_TENANTS — not read',
      },
    ],
  }
  const dtGroup = (el: HTMLElement) => el.querySelector('section[aria-label="Linked traces & problems · Dynatrace"]')
  const dtNote = (state: 'not-configured' | 'unreachable' | 'auth-failed' | 'budget-exhausted', detail: string): NonNullable<Ticket['proofNotes']> => ({
    dynatrace: { state, detail, at: '2026-10-11T09:00:00Z' },
  })

  it('counts each link', () => {
    expect(proofCount({ ...base, dynatrace })).toBe(2)
  })

  it('renders a Dynatrace group: one row per link, the group note summarising them', () => {
    const g = dtGroup(render({ ...base, dynatrace }))!
    expect(g).not.toBeNull()
    expect(g.querySelectorAll('[data-dynatrace-item]')).toHaveLength(2)
    const text = g.textContent ?? ''
    expect(text).toContain('Linked traces & problems')
    expect(text).toContain('Dynatrace')
    expect(text).toContain('1 read · 1 tenant not listed · 4 failed spans')
    expect(text).toContain('4 failed spans; the failure originates in payments: POST /charge')
    expect(text).toContain('Tenant zzz99999 is not in DYNATRACE_TENANTS — not read')
    expect(g.querySelector('[data-proof-note]')).toBeNull()
  })

  it('a ticket whose links Dynatrace could not answer still gets the group, with the reason', () => {
    const t = { ...base, proofNotes: dtNote('unreachable', 'Dynatrace could not be reached — links not re-read') }
    expect(proofCount(t)).toBe(1)
    const g = dtGroup(render(t))!
    expect(g).not.toBeNull()
    expect(g.textContent).toContain('Dynatrace could not be reached — links not re-read')
    expect(g.querySelector('[data-proof-note]')?.getAttribute('data-state')).toBe('unreachable')
    expect(g.querySelector('[data-dynatrace-item]')).toBeNull()
  })

  it('carried-forward answers show the reason above their rows, each marked stale', () => {
    const stale = { ...dynatrace, items: [{ ...dynatrace.items[0], status: 'unreachable' as const, stale: true }] }
    const g = dtGroup(render({ ...base, dynatrace: stale, proofNotes: dtNote('unreachable', 'Dynatrace could not be reached — links not re-read') }))!
    expect(g.querySelector('[data-proof-note]')).not.toBeNull()
    expect(g.querySelector('[data-dynatrace-stale]')!.textContent).toContain('Dynatrace could not be re-read')
    expect(g.textContent).toContain('4 failed spans; the failure originates in payments: POST /charge')
  })

  it('says how many links beyond the first five were not read', () => {
    const g = dtGroup(render({ ...base, dynatrace: { ...dynatrace, moreLinks: 2 } }))!
    expect(g.textContent).toContain('+2 more Dynatrace links in the ticket were not read')
  })

  it('sits beside the other sources and does not disturb them', () => {
    const el = render({ ...base, vulnFixes, dynatrace })
    expect(el.querySelector('section[aria-label="Vulnerabilities · Checkmarx"]')).not.toBeNull()
    expect(dtGroup(el)).not.toBeNull()
    expect(proofCount({ ...base, vulnFixes, dynatrace })).toBe(2 + 2)
  })

  it('an older dump, garbage, or an empty list → no Dynatrace group and no section', () => {
    for (const t of [base, { ...base, dynatrace: null }, { ...base, dynatrace: { fetchedAt: 'x', items: [] } }, { ...base, dynatrace: { fetchedAt: 'x', items: [{ nope: true }] } } as unknown as Ticket]) {
      const el = render(t)
      expect(dtGroup(el)).toBeNull()
      expect(el.querySelector('section')).toBeNull()
      expect(proofCount(t)).toBe(0)
      act(() => root?.unmount())
      host?.remove()
    }
  })
})
