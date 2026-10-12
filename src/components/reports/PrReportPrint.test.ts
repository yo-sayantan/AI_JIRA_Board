// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { demoReports } from '../../demo/reports'
import type { PrReport } from '../../lib/reportTypes'
import { PrReportPrintDoc, kpiColumns } from './PrReportPrint'

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
