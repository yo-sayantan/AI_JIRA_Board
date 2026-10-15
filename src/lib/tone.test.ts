import { describe, expect, it } from 'vitest'
import { contrastRatio, lift, liftAmount, onFill, selectedStyle, selectedText, tint } from './tone'
import { hexToRgba } from './format'

/** The `color-mix` the helper writes, evaluated in the dark theme (--tone-lift: 1) — what the browser would paint. */
function darkResult(css: string): string {
  const m = /color-mix\(in srgb, (#[0-9a-f]{6}), white calc\(var\(--tone-lift, 0\) \* (\d+)%\)\)/i.exec(css)
  if (!m) return css
  const n = parseInt(m[1].slice(1), 16)
  const t = Number(m[2]) / 100
  const mix = (v: number) => Math.round(v + (255 - v) * t)
  const hex = (v: number) => v.toString(16).padStart(2, '0')
  return `#${hex(mix((n >> 16) & 255))}${hex(mix((n >> 8) & 255))}${hex(mix(n & 255))}`
}

// Every brand colour the board paints text with: columns, views, states, services.
const PALETTE = [
  '#8b94a8', '#fb3f5f', '#2f86ff', '#b05cff', '#6aa9a1', '#5f9a93', '#2fcf6f', '#ff8a1f', // columns
  '#9a63ff', '#17c47a', '#ff9f1c', '#ff4466', '#e11d48', // PR states
  '#0052cc', '#6366f1', '#14b8a6', '#5b88a8', '#65a30d', '#8f7ae5', '#c2a15b', '#a855f7', '#d08fbf', '#10b981', '#0ea5e9', // services
  '#b45309', '#dc2626', '#16a34a', '#64748b', '#4338ca', '#1e3a8a',
]

describe('contrastRatio', () => {
  it('matches the WCAG reference values', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1)
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 1)
    expect(contrastRatio('#ffffff', '#ffffff')).toBe(1)
  })
  it('is 1 for anything that is not a hex colour', () => {
    expect(contrastRatio('var(--ink)', '#ffffff')).toBe(1)
  })
})

describe('lift', () => {
  it('leaves colours that are not plain hex alone', () => {
    expect(lift('var(--muted)')).toBe('var(--muted)')
    expect(lift('rgba(1, 2, 3, 0.5)')).toBe('rgba(1, 2, 3, 0.5)')
    expect(lift('#ffffff')).toBe('#ffffff')
  })

  it('does not touch a colour that already reads on the dark surface', () => {
    expect(liftAmount('#ffffff')).toBe(0)
    expect(lift('#e5e7eb')).toBe('#e5e7eb')
  })

  it('reads the theme variable, defaulting to "no lift" when it is missing (print, file:// without CSS)', () => {
    const css = lift('#1e3a8a')
    expect(css).toContain('var(--tone-lift, 0)')
    expect(css.startsWith('color-mix(in srgb, #1e3a8a, white calc(')).toBe(true)
  })

  it('lifts every palette colour to a clearly light tone on the dark surface (≥ 7:1, the WCAG enhanced level)', () => {
    for (const c of PALETTE) {
      const seen = darkResult(lift(c))
      expect(contrastRatio(seen, '#23262d'), `${c} → ${seen}`).toBeGreaterThanOrEqual(7)
    }
  })

  it('lifts a deep colour more than a light one and never past the cap', () => {
    expect(liftAmount('#1e3a8a')).toBeGreaterThan(liftAmount('#6366f1'))
    expect(liftAmount('#6366f1')).toBeGreaterThan(liftAmount('#a855f7'))
    for (const c of PALETTE) expect(liftAmount(c)).toBeLessThanOrEqual(0.82)
  })

  it('keeps the hue: the lifted colour is the same family, only lighter', () => {
    const hue = (hex: string) => {
      const n = parseInt(hex.slice(1), 16)
      const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
      const max = Math.max(r, g, b)
      const min = Math.min(r, g, b)
      if (max === min) return 0
      const d = max - min
      const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
      return (h * 60 + 360) % 360
    }
    for (const c of ['#4338ca', '#0052cc', '#dc2626']) {
      const seen = darkResult(lift(c))
      expect(Math.abs(hue(seen) - hue(c)), c).toBeLessThan(12)
    }
  })

  it('is stable: the same colour always gives the same string', () => {
    expect(lift('#4338ca')).toBe(lift('#4338ca'))
  })
})

describe('tint', () => {
  it('washes the LIFTED colour, so a dim colour keeps its identity on dark', () => {
    const css = tint('#4338ca', 0.14)
    expect(css).toContain(lift('#4338ca'))
    expect(css).toContain('transparent')
  })

  it('gives a faint wash more body in dark mode (the boost rides on --tone-lift, so light is untouched)', () => {
    const css = tint('#4338ca', 0.09)
    expect(css).toContain('calc(9% * (1 + 0.4 * var(--tone-lift, 0)))')
  })

  it('leaves a strong edge or fill as written', () => {
    expect(tint('#4338ca', 0.6)).toContain(' 60%, transparent')
    expect(tint('#4338ca', 0.6)).not.toContain('calc(60%')
  })

  it('keeps fractional percentages exact', () => {
    expect(tint('#4338ca', 0.075)).toContain('7.5%')
  })

  it('applies to colours that need no lift too, so a wash behaves the same on every colour', () => {
    expect(tint('#ffffff', 0.3)).toBe('color-mix(in srgb, #ffffff calc(30% * (1 + 0.4 * var(--tone-lift, 0))), transparent)')
  })

  it('falls back to hexToRgba for something that is not a hex colour', () => {
    expect(tint('rgba(1, 2, 3, 1)', 0.5)).toBe(hexToRgba('rgba(1, 2, 3, 1)', 0.5))
  })
})

describe('onFill', () => {
  it('keeps white text where white reads on the fill', () => {
    for (const c of ['#2f86ff', '#fb3f5f', '#9a63ff', '#0052cc', '#b05cff', '#dc2626']) expect(onFill(c), c).toBe('#fff')
  })

  it('switches to near-black ink, in dark mode only, on a pale fill', () => {
    for (const c of ['#8b94a8', '#17c47a', '#ff9f1c', '#2fcf6f', '#c2a15b']) {
      const css = onFill(c)
      expect(css, c).toContain('var(--tone-lift, 0)')
      expect(css, c).toContain('#0b0c0f')
    }
  })

  it('is white for anything that is not a plain hex', () => {
    expect(onFill('var(--muted)')).toBe('#fff')
  })

  it('the dark ink really has the contrast white lacked', () => {
    for (const c of ['#8b94a8', '#17c47a', '#ff9f1c']) {
      expect(contrastRatio('#0b0c0f', c), c).toBeGreaterThan(contrastRatio('#ffffff', c))
      expect(contrastRatio('#0b0c0f', c), c).toBeGreaterThanOrEqual(4.5)
    }
  })
})

describe('selectedStyle / selectedText', () => {
  it('in light mode is the colour on a wash with a coloured hairline (unchanged look)', () => {
    const s = selectedStyle('#a855f7')
    expect(s.color).toContain('var(--tone-lift, 0)') // resolves to the colour itself when the variable is 0
    expect(s.background).toBe(tint('#a855f7', 0.14))
    expect(s.boxShadow).toContain('inset 0 0 0 1px')
  })

  it('in dark mode moves the colour off the label (near-white) and onto a strong ring', () => {
    expect(selectedText('#a855f7')).toBe('color-mix(in srgb, #a855f7, white calc(var(--tone-lift, 0) * 86%))')
    expect(selectedStyle('#a855f7').boxShadow).toContain('calc(45% + 45% * var(--tone-lift, 0))')
  })

  it('never asks for more than 100% of the ring colour', () => {
    expect(selectedStyle('#a855f7', { edge: 0.8 }).boxShadow).toContain('calc(80% + 20% * var(--tone-lift, 0))')
  })

  it('the near-white label reads on a selected wash for every palette colour', () => {
    for (const c of PALETTE) {
      const n = parseInt(c.slice(1), 16)
      const mix = (v: number) => Math.round(v + (255 - v) * 0.86)
      const label = `#${[(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => mix(v).toString(16).padStart(2, '0')).join('')}`
      expect(contrastRatio(label, '#23262d'), c).toBeGreaterThanOrEqual(11)
    }
  })

  it('leaves a non-hex colour alone', () => {
    expect(selectedStyle('var(--ink)')).toEqual({ color: 'var(--ink)' })
  })
})
