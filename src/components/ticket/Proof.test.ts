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

const base: Ticket = { key: 'PAY-7', title: 'Fix CVE-2021-44228', status: 'In Review', column: 'rev' }
const vulnFixes: NonNullable<Ticket['vulnFixes']> = {
  scannedAt: '2026-10-11T06:00:00Z',
  project: 'payments-service',
  branch: 'feature/PAY-7',
  baseBranch: 'develop',
  branchScanAt: '2026-10-09T08:00:00Z',
  baseScanAt: '2026-10-01T07:00:00Z',
  items: [
    { target: 'CVE-2021-44228', kind: 'cve', status: 'fixed', severity: 'CRITICAL', location: 'log4j-core 2.14.1', detail: 'Fixed — gone on feature/PAY-7' },
    { target: 'SQL_Injection', kind: 'sast', status: 'open', severity: 'HIGH', location: '/src/Dao.java:57', detail: 'Open — still on feature/PAY-7' },
  ],
}

const render = (t: Ticket) => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(createElement(ProofPanel, { ticket: t, now: Date.parse('2026-10-11T10:00:00Z') })))
  return host
}

describe('Proof · Vulnerabilities (Checkmarx)', () => {
  it('counts each target', () => {
    expect(proofCount(base)).toBe(0)
    expect(proofCount({ ...base, vulnFixes })).toBe(2)
  })

  it('renders a Checkmarx group: the scans compared, then one row per target', () => {
    const el = render({ ...base, vulnFixes })
    const group = el.querySelector('section[aria-label="Vulnerabilities · Checkmarx"]')!
    expect(group).not.toBeNull()
    const text = group.textContent ?? ''
    expect(text).toContain('feature/PAY-7 (scan 2026-10-09) vs develop (scan 2026-10-01)')
    expect(text).toContain('1/2 fixed')
    expect(text).toContain('CVE-2021-44228')
    expect(text).toContain('/src/Dao.java:57')
    expect(text).toContain('Open — still on feature/PAY-7')
    expect(text).toContain('SAST')
  })

  it('shows no group without results', () => {
    expect(render(base).querySelector('section')).toBeNull()
  })
})
