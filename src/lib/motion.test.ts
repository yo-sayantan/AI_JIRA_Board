import { describe, expect, it } from 'vitest'
import { DIALOG, EASE_DRAWER, EASE_OUT, HOVER_SCALE, POPOVER, PRESS, PRESS_SCALE, SCRIM, TOAST } from './motion'

const duration = (t: { transition: { duration: number } }) => t.transition.duration

describe('motion tokens', () => {
  it('press feedback is firm but subtle, and fast', () => {
    expect(PRESS_SCALE).toBeGreaterThanOrEqual(0.95)
    expect(PRESS_SCALE).toBeLessThanOrEqual(0.98)
    expect(HOVER_SCALE).toBeLessThanOrEqual(1.05)
    expect((PRESS as { duration: number }).duration).toBeLessThanOrEqual(0.16)
  })

  it('never eases in: every curve starts fast (first control point rises at least as fast as it runs)', () => {
    for (const [x1, y1] of [EASE_OUT, EASE_DRAWER]) expect(y1).toBeGreaterThanOrEqual(x1)
  })

  it('nothing appears from nothing', () => {
    for (const m of [DIALOG, POPOVER, TOAST]) expect(m.initial.scale).toBeGreaterThanOrEqual(0.9)
  })

  it('exits are faster than entrances, and UI stays under 300 ms', () => {
    for (const m of [SCRIM, DIALOG, POPOVER, TOAST]) {
      expect(duration(m.exit)).toBeLessThan(duration(m.animate))
      expect(duration(m.animate)).toBeLessThanOrEqual(0.3)
    }
  })
})

describe('motion in the source', () => {
  // Every component and stylesheet, as text (Vite's glob; no Node APIs needed).
  const sources = import.meta.glob(['../**/*.tsx', '../**/*.css'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>
  const offending = (re: RegExp) => Object.keys(sources).filter((f) => re.test(sources[f]))

  it('reads the source tree', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(20)
  })

  it('never transitions `all` — name the properties', () => {
    expect(offending(/\btransition-all\b|transition:\s*all\b/)).toEqual([])
  })

  it('never uses ease-in on UI', () => {
    expect(offending(/ease:\s*['"]easeIn['"]|\bease-in\b(?!-out)/)).toEqual([])
  })
})
