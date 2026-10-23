// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { BANNER_HUE, BannerHead, BannerIcon, BannerMeta, bannerStyle } from './Banner'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement | null = null
let root: ReturnType<typeof createRoot> | null = null
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  host = root = null
})

describe('drawer banners share one anatomy and one colour code', () => {
  it('puts the colour on a 3px left rail and a hairline — the glass itself stays neutral', () => {
    const s = bannerStyle('#a855f7')
    expect(s.borderLeftWidth).toBe(3)
    expect(s.borderLeftColor).toBe('#a855f7')
    expect(s.borderStyle).toBe('solid')
    expect(String(s.backgroundImage)).toContain('var(--glass-sheen)') // the material is the board's, not a tinted slab
    expect(bannerStyle('#a855f7', { dashed: true }).borderStyle).toBe('dashed') // an offer ("generate") reads as unfilled
  })

  it('gives each kind of banner its own colour', () => {
    expect(BANNER_HUE.ai).toBe('#a855f7')
    expect(BANNER_HUE.taken).toBe('#f97316')
    expect(BANNER_HUE.ai).not.toBe(BANNER_HUE.taken)
  })

  it('reads label over title, with meta at the end', () => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() =>
      root!.render(
        createElement(
          'div',
          null,
          createElement(BannerIcon, { hue: '#a855f7', children: 'i' }),
          createElement(BannerHead, { hue: '#a855f7', label: 'Written by the AI intern', title: 'AI Brief' }),
          createElement(BannerMeta, { children: 'auto-generated' }),
        ),
      ),
    )
    const text = host.textContent ?? ''
    expect(text.indexOf('Written by the AI intern')).toBeLessThan(text.indexOf('AI Brief'))
    expect(text.indexOf('AI Brief')).toBeLessThan(text.indexOf('auto-generated'))
    expect(host.querySelector('[aria-hidden]')).toBeTruthy() // the icon tile is decoration
  })
})
