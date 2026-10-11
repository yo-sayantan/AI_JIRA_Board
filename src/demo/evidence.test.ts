// @vitest-environment jsdom
// The demo's linked-system evidence, drawn the way the drawer draws it: Dynatrace rows, a failed build's console tail,
// and the "Evidence from linked systems" section of a brief — so a hand edit to the demo that the UI cannot show fails here.
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import raw from '../../jira-intern/demo/data.json'
import { rebaseDemoDump } from './data'
import { unwrapBrief } from '../lib/format'
import { proofCount, ProofPanel } from '../components/ticket/Proof'
import { sanitizeHtml } from '../components/common/ui'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement | null = null
let root: ReturnType<typeof createRoot> | null = null
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  host = root = null
})

const NOW = Date.parse('2027-03-15T11:30:00Z')
const d = rebaseDemoDump(raw, NOW)
const ticket = (key: string) => d.tickets.find((t) => t.key === key)!

const drawer = (key: string) => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(createElement(ProofPanel, { ticket: ticket(key), now: NOW, timeZone: 'UTC' })))
  return host
}
const group = (el: HTMLElement) => el.querySelector('section[aria-label="Linked traces & problems · Dynatrace"]')!

describe('demo · the drawer shows the Dynatrace evidence', () => {
  it('DEMO-210: a trace with failures and a closed problem, both read', () => {
    const g = group(drawer('DEMO-210'))
    const rows = [...g.querySelectorAll('[data-dynatrace-item]')]
    expect(rows.map((r) => r.getAttribute('data-status'))).toEqual(['read', 'read'])
    expect(g.textContent).toContain('6 failed spans; the failure originates in object-storage-gateway: PUT /exports/{id}')
    expect(g.textContent).toContain('Davis problem P-24100731: Response time degradation (CLOSED, SLOWDOWN)')
    expect(g.textContent).toContain('2 read · 6 failed spans')
    expect(g.querySelector('[data-proof-note]')).toBeNull()
    expect(proofCount(ticket('DEMO-210'))).toBe(2 + 1) // two links + the one NOT_BUILT build
  })

  it('DEMO-247: nothing found, and a tenant that is not listed — muted, with the reason', () => {
    const g = group(drawer('DEMO-247'))
    expect([...g.querySelectorAll('[data-dynatrace-item]')].map((r) => r.getAttribute('data-status'))).toEqual(['empty', 'unconfigured-tenant'])
    expect(g.textContent).toContain('Tenant zzz99999 is not in DYNATRACE_TENANTS — not read')
    expect(g.textContent).toContain('No requests were recorded for this service in the window')
    expect(g.textContent).toContain('1 nothing found · 1 tenant not listed')
  })

  it('DEMO-213: a read trace, a stale log answer with the note above it, and a rejected token', () => {
    const g = group(drawer('DEMO-213'))
    expect([...g.querySelectorAll('[data-dynatrace-item]')].map((r) => r.getAttribute('data-status'))).toEqual(['read', 'unreachable', 'auth-failed'])
    expect(g.querySelector('[data-proof-note]')!.getAttribute('data-state')).toBe('unreachable')
    expect(g.querySelectorAll('[data-dynatrace-stale]')).toHaveLength(1)
    expect(g.querySelector('[data-dynatrace-stale]')!.textContent).toMatch(/^⚠Last read \d+(h|d|mo|y) ago; Dynatrace could not be re-read$/)
    expect(g.textContent).toContain('Top error lines: key-service: SignatureMismatch: key id not found (×42)')
    expect(g.textContent).toContain('Dynatrace rejected the token for tenant uat (HTTP 403)')
  })

  it('every link opens the ticket’s own URL in a new tab, safely', () => {
    for (const key of ['DEMO-210', 'DEMO-213', 'DEMO-247']) {
      const anchors = [...group(drawer(key)).querySelectorAll('a')]
      expect(anchors).toHaveLength(ticket(key).dynatrace!.items.length)
      anchors.forEach((a, i) => {
        expect(a.getAttribute('href')).toBe(ticket(key).dynatrace!.items[i].url)
        expect(a.getAttribute('rel')).toBe('noopener noreferrer')
      })
      act(() => root?.unmount())
      host?.remove()
    }
  })

  it('a ticket with no Dynatrace evidence has no such group', () => {
    expect(drawer('DEMO-220').querySelector('section[aria-label="Linked traces & problems · Dynatrace"]')).toBeNull()
  })
})

describe('demo · the drawer shows the console tail of the failed build', () => {
  it('DEMO-231: collapsed, scrubbed, and only on the failed build', () => {
    const el = drawer('DEMO-231')
    const boxes = el.querySelectorAll('details[data-console-tail]')
    expect(boxes).toHaveLength(1) // the UAT build passed and carries none
    expect((boxes[0] as HTMLDetailsElement).open).toBe(false)
    expect(boxes[0].textContent).toContain('Console (last lines)')
    expect(boxes[0].querySelector('pre')!.textContent).toContain('Authorization: •••')
  })

  it('a green or running build shows none', () => {
    expect(drawer('DEMO-220').querySelector('details[data-console-tail]')).toBeNull()
  })
})

describe('demo · the evidence briefs survive the sanitiser', () => {
  it.each(['DEMO-210', 'DEMO-230', 'DEMO-231'])('%s keeps its heading, list, bold system name and takeaway', (key) => {
    const out = sanitizeHtml(unwrapBrief(ticket(key).aiSummary)!)
    const doc = new DOMParser().parseFromString(out, 'text/html')
    expect(out).not.toContain('data-brief')
    expect([...doc.querySelectorAll('p > b')].map((b) => b.textContent)).toContain('Evidence from linked systems')
    expect(doc.querySelectorAll('ul > li > b').length).toBeGreaterThan(0)
    expect(doc.querySelector('p > i')!.textContent).toMatch(/^What this means: /)
    expect(doc.body.textContent).toContain('Evidence from linked systems')
  })
})
