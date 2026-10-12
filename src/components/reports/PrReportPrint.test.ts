// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { demoReports } from '../../demo/reports'
import type { PrReport, ReportTableBlock } from '../../lib/reportTypes'
import { PrReportPrintDoc, kpiColumns, rowTone, tallyGates } from './PrReportPrint'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement | null = null
let root: ReturnType<typeof createRoot> | null = null
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  host = root = null
})

function render(report: PrReport) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(createElement(PrReportPrintDoc, { report, tabs: report.tabs ?? [] })))
  return host
}

describe('PDF deck', () => {
  const reports = Object.values(demoReports().reports)

  it.each(reports.map((r) => [r.key, r] as const))('%s renders a deck with no running footer or page numbers', (_key, report) => {
    const el = render(report)
    const slides = el.querySelectorAll('.jb-slide')
    // jsdom has no layout, so pagination falls back to one slide per section — still a full deck.
    expect(slides.length).toBeGreaterThan(3)
    expect(el.querySelector('footer, .jb-slide-foot, .jb-slide-num')).toBeNull()
    expect(el.textContent).not.toMatch(/\b\d+\s*\/\s*\d+\s*$/m)
    // the measuring probe is gone once the deck is laid out
    expect(el.querySelector('[data-probe]')).toBeNull()
  })

  it('puts the Issue insight with the delivery gates, not under "Additional detail"', () => {
    const report = reports.find((r) => r.tabs.some((t) => t.blocks.some((b) => b.title === 'Issue insight')))
    expect(report, 'a demo report carries an Issue insight').toBeTruthy()
    const el = render(report!)
    const text = el.textContent ?? ''
    expect(text).toContain('Issue insight')
    const extra = [...el.querySelectorAll('.jb-slide')].find((s) => /Additional detail/.test(s.textContent ?? ''))
    expect(extra?.textContent ?? '').not.toContain('Issue insight')
  })

  it('places every block of the report on some slide', () => {
    const report = reports[0]
    const el = render(report)
    const text = el.textContent ?? ''
    for (const tab of report.tabs ?? []) {
      for (const b of tab.blocks ?? []) {
        if (b.kind === 'table') for (const row of b.rows) expect(text).toContain(row.cells[0].replace(/<[^>]+>/g, '').trim())
        if (b.kind === 'cards') for (const c of b.items) expect(text).toContain(c.title.replace(/<[^>]+>/g, '').trim())
      }
    }
  })

  it('lists sections on the cover without page numbers', () => {
    const el = render(reports[0])
    const agenda = [...el.querySelectorAll('.jb-cover-agenda li')].map((li) => li.textContent)
    expect(agenda[0]).toBe('1Executive summary')
    expect(agenda[agenda.length - 1]).toMatch(/Appendix$/)
  })

  it('never puts more than four KPI tiles in a row, and keeps rows even', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(kpiColumns)).toEqual([1, 2, 3, 4, 3, 3, 4, 4])
  })
})

describe('deck style (Settings → PDF report)', () => {
  const report = Object.values(demoReports().reports)[0]
  const render2 = (style?: 'light' | 'colorful') => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => root!.render(createElement(PrReportPrintDoc, { report, tabs: report.tabs ?? [], style })))
    return host
  }
  const agendaColour = (el: HTMLElement) => (el.querySelector('.jb-cover-agenda-n') as HTMLElement).style.background

  it('is Light (Google palette) unless told otherwise', () => {
    const el = render2()
    expect(el.querySelector('.jb-pdf')?.classList.contains('jb-deck-light')).toBe(true)
    // Google's tonal pair: the blue 50 container with blue ink, not a filled dot
    expect(agendaColour(el)).toMatch(/rgb\(232, 240, 254\)|#e8f0fe/i)
    expect((el.querySelector('.jb-cover-agenda-n') as HTMLElement).style.color).toMatch(/rgb\(24, 90, 188\)|#185abc/i)
  })
  it('draws the original section colours when Colourful is chosen', () => {
    const el = render2('colorful')
    expect(el.querySelector('.jb-pdf')?.classList.contains('jb-deck-colorful')).toBe(true)
    expect(el.querySelector('.jb-pdf')?.classList.contains('jb-deck-light')).toBe(false)
    expect(agendaColour(el)).toMatch(/rgb\(79, 70, 229\)|#4f46e5/i)
  })
})

describe('gate tally', () => {
  const gates = (...states: string[]): ReportTableBlock => ({
    kind: 'table',
    title: 'Gate checklist',
    tone: 'neutral',
    provenance: 'derived',
    headers: ['Gate', 'State', 'Evidence', 'Blocks closure?'],
    rows: states.map((s, i) => ({ cells: [`Gate ${i}`, s, '', 'No'] })),
  })

  it('counts passes, gaps and failures out of every gate that applies', () => {
    expect(tallyGates(gates('Pass', 'Pass', 'Not verified', 'Fail'))).toEqual({ pass: 2, warn: 1, fail: 1, na: 0, total: 4 })
  })

  it('leaves a "Not required" gate out of the total instead of counting it as a gap', () => {
    // 6 pass, 3 gaps, 1 not required: the old tally read "6 of 10" with 4 amber.
    const t = tallyGates(gates(...Array(6).fill('Pass'), 'Not verified', 'Not verified', 'Not verified', 'Not required'))
    expect(t).toEqual({ pass: 6, warn: 3, fail: 0, na: 1, total: 9 })
  })

  it('reads a ticket whose only open gate is not applicable as fully passed', () => {
    expect(tallyGates(gates('Pass', 'Pass', 'Not required'))).toEqual({ pass: 2, warn: 0, fail: 0, na: 1, total: 2 })
  })

  it('draws "Not required" grey, never amber, red or green', () => {
    const row = (state: string) => ({ cells: ['Security scan (Checkmarx) clean', state, 'Not a vulnerability-fix ticket'] })
    expect(rowTone(row('Not required'), 1)).toBe('neutral')
    expect(rowTone(row('not applicable'), 1)).toBe('neutral')
    // the others keep their colours
    expect(rowTone(row('Not verified'), 1)).toBe('warning')
    expect(rowTone(row('Pass'), 1)).toBe('success')
    expect(rowTone(row('Fail'), 1)).toBe('danger')
  })

  it('shows the not-required count in the gate bar legend only when there is one', () => {
    const report = Object.values(demoReports().reports)[0]
    const withGates = (...states: string[]): PrReport => ({
      ...report,
      tabs: report.tabs.map((tab, i) => (i === 0 ? { ...tab, blocks: [...tab.blocks, gates(...states)] } : tab)),
    })
    expect(render(withGates('Pass', 'Not required')).textContent).toMatch(/1 not required/)
    act(() => root?.unmount())
    host?.remove()
    expect(render(withGates('Pass', 'Not verified')).textContent).not.toMatch(/not required/)
  })
})
