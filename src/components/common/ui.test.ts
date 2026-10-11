// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { isSafeUrl, safeHref, sanitizeHtml } from './ui'

describe('safeHref', () => {
  it('rejects javascript: and accepts https', () => {
    expect(safeHref('javascript:alert(1)')).toBeUndefined()
    expect(safeHref(' java\tscript:alert(1)')).toBeUndefined()
    expect(safeHref('https://x')).toBe('https://x')
    expect(safeHref(null)).toBeUndefined()
    expect(isSafeUrl('data:text/html,hi')).toBe(false)
  })
})

describe('sanitizeHtml', () => {
  it('strips scripts and event handlers, keeps safe markup', () => {
    const out = sanitizeHtml('<b>bold</b><script>alert(1)</script><img src=x onerror="alert(1)"><a href="https://e.com">l</a>')
    expect(out).not.toContain('<script')
    expect(out).not.toContain('onerror')
    expect(out).toContain('<b>bold</b>')
    expect(out).toContain('href="https://e.com"')
    expect(out).toContain('target="_blank"')
    expect(out).toContain('rel="noopener noreferrer"')
  })
  it('drops unsafe hrefs', () => {
    expect(sanitizeHtml('<a href="javascript:alert(1)">x</a>')).not.toContain('javascript:')
  })
})

describe('sanitizeHtml · a brief with an "Evidence from linked systems" section', () => {
  const brief =
    '<div data-brief="2"><p>Retry control for <b>failed exports</b>.</p>' +
    '<p><b>Evidence from linked systems</b></p>' +
    '<ul><li><b>Dynatrace:</b> 4 failed spans; the failure originates in <code>payments: POST /charge</code> — ' +
    '<a href="https://abc12345.live.dynatrace.com/#trace;traceId=9f3c1d5e7a2b4c6d8e0f1a2b3c4d5e6f">the linked trace</a></li>' +
    '<li><b>Jenkins:</b> build #88 failed at <i>Integration tests</i></li></ul>' +
    '<p><i>What this means: the timeouts are in the payments call, not in the export worker.</i></p></div>'

  it('keeps every tag of the section, the link and the text; drops only the version marker', () => {
    const out = sanitizeHtml(brief)
    const doc = new DOMParser().parseFromString(out, 'text/html')
    expect(out).not.toContain('data-brief')
    expect(doc.querySelectorAll('p')).toHaveLength(3)
    expect([...doc.querySelectorAll('p > b')].map((b) => b.textContent)).toContain('Evidence from linked systems')
    expect(doc.querySelectorAll('ul > li')).toHaveLength(2)
    expect(doc.querySelectorAll('li > b')).toHaveLength(2)
    expect(doc.querySelector('li > code')!.textContent).toBe('payments: POST /charge')
    expect(doc.querySelector('p > i')!.textContent).toMatch(/^What this means: /)
    const a = doc.querySelector('a')!
    expect(a.getAttribute('href')).toBe('https://abc12345.live.dynatrace.com/#trace;traceId=9f3c1d5e7a2b4c6d8e0f1a2b3c4d5e6f')
    expect(a.getAttribute('target')).toBe('_blank')
    expect(a.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('still strips what must never get through, even inside that section', () => {
    const out = sanitizeHtml('<div data-brief="2"><p><b>Evidence from linked systems</b></p><ul><li><b>Dynatrace:</b> <img src=x onerror="alert(1)"><script>alert(2)</script><a href="javascript:alert(3)">trace</a></li></ul></div>')
    expect(out).not.toContain('onerror')
    expect(out).not.toContain('<script')
    expect(out).not.toContain('javascript:')
    expect(out).toContain('<b>Evidence from linked systems</b>')
  })
})
