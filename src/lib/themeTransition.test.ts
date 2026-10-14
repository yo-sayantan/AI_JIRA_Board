// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FADE_MS, revealGeometry, switchTheme, themeMotionAllowed } from './themeTransition'

const root = document.documentElement
afterEach(() => {
  root.className = ''
  root.removeAttribute('style')
  delete (document as { startViewTransition?: unknown }).startViewTransition
  vi.useRealTimers()
})

describe('the theme switch', () => {
  it('with Motion & animations off just switches — no reveal, no fade', () => {
    root.classList.add('jb-no-anim')
    expect(themeMotionAllowed()).toBe(false)
    const apply = vi.fn()
    switchTheme(null, true, apply)
    expect(apply).toHaveBeenCalledOnce()
    expect(root.classList.contains('jb-theme-fade')).toBe(false)
    expect(root.classList.contains('jb-theme-vt')).toBe(false)
  })

  it('without the View Transitions API cross-fades the colours for a moment', () => {
    vi.useFakeTimers()
    const apply = vi.fn()
    switchTheme(null, true, apply)
    expect(apply).toHaveBeenCalledOnce()
    expect(root.classList.contains('jb-theme-fade')).toBe(true)
    vi.advanceTimersByTime(FADE_MS)
    expect(root.classList.contains('jb-theme-fade')).toBe(false)
  })

  it('with it, reveals from the button: going dark spreads the new theme, going light folds the old one in', async () => {
    let finish!: () => void
    const start = vi.fn((update: () => void) => {
      update()
      return { ready: Promise.resolve(), finished: new Promise<void>((r) => (finish = r)) }
    })
    ;(document as { startViewTransition?: unknown }).startViewTransition = start
    const animate = vi.fn()
    root.animate = animate as never
    const button = document.createElement('button')
    button.getBoundingClientRect = () => ({ left: 900, top: 10, width: 36, height: 36 }) as DOMRect
    const apply = vi.fn()

    switchTheme(button, true, apply)
    expect(start).toHaveBeenCalledOnce()
    expect(apply).toHaveBeenCalledOnce()
    expect(root.classList.contains('jb-theme-vt-in')).toBe(true)
    expect(root.style.getPropertyValue('--jb-vt-x')).toBe('918px')
    expect(root.style.getPropertyValue('--jb-vt-y')).toBe('28px')
    await Promise.resolve()
    await Promise.resolve()
    const [keyframes, options] = animate.mock.calls[0]
    expect(keyframes['--jb-vt-r'][0]).toBe('0px')
    expect(options.pseudoElement).toBe('::view-transition-new(root)')

    finish()
    await Promise.resolve()
    await Promise.resolve()
    expect(root.classList.contains('jb-theme-vt')).toBe(false)
    expect(root.style.getPropertyValue('--jb-vt-x')).toBe('')

    switchTheme(button, false, apply)
    expect(root.classList.contains('jb-theme-vt-out')).toBe(true)
    await Promise.resolve()
    await Promise.resolve()
    expect(animate.mock.calls[1][0]['--jb-vt-r'][1]).toBe('0px')
    expect(animate.mock.calls[1][1].pseudoElement).toBe('::view-transition-old(root)')
  })

  it('still switches when the transition cannot start', () => {
    ;(document as { startViewTransition?: unknown }).startViewTransition = () => {
      throw new Error('no')
    }
    const apply = vi.fn()
    switchTheme(null, false, apply)
    expect(apply).toHaveBeenCalledOnce()
    expect(root.classList.contains('jb-theme-vt')).toBe(false)
  })

  it('reaches past the far corner by the width of the soft edge', () => {
    const g = revealGeometry({ left: 980, top: 0, width: 40, height: 40 }, 1000, 800)
    const corner = Math.hypot(1000, 780)
    expect(g.x).toBe(1000)
    expect(g.max).toBeGreaterThanOrEqual(Math.ceil(corner + g.feather))
  })
})
