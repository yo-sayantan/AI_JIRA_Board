// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installGlassPointer } from './glassPointer'

function pointer(type: string, target: Element, init: { clientX: number; clientY: number; pointerType?: string }) {
  const e = new MouseEvent(type, { bubbles: true, clientX: init.clientX, clientY: init.clientY })
  Object.defineProperty(e, 'pointerType', { value: init.pointerType ?? 'mouse' })
  target.dispatchEvent(e)
}

describe('installGlassPointer', () => {
  let off: () => void = () => {}
  let card: HTMLElement
  let child: HTMLElement

  beforeEach(() => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('hover: hover'), media: q, addEventListener() {}, removeEventListener() {} }))
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => (fn(0), 1))
    document.body.innerHTML = '<div class="glass-interactive" id="g"><span id="c">x</span></div>'
    card = document.getElementById('g')!
    child = document.getElementById('c')!
    card.getBoundingClientRect = () => ({ left: 100, top: 40, width: 200, height: 60, right: 300, bottom: 100, x: 100, y: 40, toJSON() {} }) as DOMRect
  })
  afterEach(() => {
    off()
    vi.unstubAllGlobals()
  })

  it('publishes the pointer position relative to the glass surface, from any child', () => {
    off = installGlassPointer()
    pointer('pointermove', child, { clientX: 130, clientY: 55 })
    expect(card.style.getPropertyValue('--mx')).toBe('30px')
    expect(card.style.getPropertyValue('--my')).toBe('15px')
  })
  it('ignores touch and anything that is not a glass surface', () => {
    off = installGlassPointer()
    pointer('pointermove', child, { clientX: 130, clientY: 55, pointerType: 'touch' })
    expect(card.style.getPropertyValue('--mx')).toBe('')
    pointer('pointermove', document.body, { clientX: 1, clientY: 1 })
    expect(card.style.getPropertyValue('--mx')).toBe('')
  })
  it('does nothing without a hover-capable pointer, and stops after uninstall', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    installGlassPointer()()
    pointer('pointermove', child, { clientX: 130, clientY: 55 })
    expect(card.style.getPropertyValue('--mx')).toBe('')
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('hover: hover') }))
    off = installGlassPointer()
    off()
    pointer('pointermove', child, { clientX: 130, clientY: 55 })
    expect(card.style.getPropertyValue('--mx')).toBe('')
  })
})
