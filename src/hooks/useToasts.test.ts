// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACTION_MIN_SECONDS, toastSeconds, useToasts } from './useToasts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Toasts = ReturnType<typeof useToasts>
let host: HTMLDivElement | null = null
let root: ReturnType<typeof createRoot> | null = null
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  host = root = null
})

describe('useToasts.clear', () => {
  it('removes the visible toasts and the waiting ones', () => {
    const ref: { current: Toasts | null } = { current: null }
    function Probe() {
      ref.current = useToasts(5, 1)
      return null
    }
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => root!.render(createElement(Probe)))
    act(() => {
      ref.current!.toast('one')
      ref.current!.toast('two') // waits: only one slot
    })
    expect(ref.current!.toasts.map((t) => t.msg)).toEqual(['one'])
    act(() => ref.current!.clear())
    expect(ref.current!.toasts).toEqual([])
    act(() => ref.current!.toast('three'))
    expect(ref.current!.toasts.map((t) => t.msg)).toEqual(['three'])
  })
})

function mount(seconds: number, max: number) {
  const ref: { current: Toasts | null } = { current: null }
  function Probe() {
    ref.current = useToasts(seconds, max)
    return null
  }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(createElement(Probe)))
  return () => ref.current!
}
const undo = { label: 'Undo', run: () => {} }
const shown = (t: () => Toasts) => t().toasts.map((x) => x.msg)

describe('toastSeconds', () => {
  it('a plain toast follows Settings; one with a button stays twice as long, never under the minimum', () => {
    expect(toastSeconds({}, 4)).toBe(4)
    expect(toastSeconds({ action: undo }, 4)).toBe(ACTION_MIN_SECONDS)
    expect(toastSeconds({ action: undo }, 10)).toBe(20)
    expect(toastSeconds({ action: undo }, 2)).toBeGreaterThan(toastSeconds({}, 10)) // always outlives a plain one
    expect(toastSeconds({ action: undo, seconds: 3 }, 10)).toBe(3) // an explicit override still wins
  })
})

describe('useToasts — priority, durations and pausing', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('closes a plain toast after the Settings time, and an Undo toast only after its longer time', () => {
    const t = mount(4, 5)
    act(() => {
      t().toast('plain')
      t().toast('moved', 'success', { action: undo })
    })
    act(() => void vi.advanceTimersByTime(4_100))
    expect(shown(t)).toEqual(['moved'])
    act(() => void vi.advanceTimersByTime((ACTION_MIN_SECONDS - 4) * 1000))
    expect(shown(t)).toEqual([])
  })

  it('an Undo toast never waits: with every slot taken it bumps the oldest plain toast', () => {
    const t = mount(5, 2)
    act(() => {
      t().toast('progress 1', 'loading')
      t().toast('progress 2', 'loading')
      t().toast('KEY → Done', 'success', { action: undo })
    })
    expect(shown(t)).toEqual(['progress 2', 'KEY → Done'])
  })

  it('a plain toast never bumps a priority one — it waits, and priority toasts are let in first', () => {
    const t = mount(5, 1)
    act(() => {
      t().toast('A → Done', 'success', { action: undo })
      t().toast('plain notice')
      t().toast('B → Done', 'success', { action: undo })
    })
    expect(shown(t)).toEqual(['A → Done'])
    act(() => t().dismiss(t().toasts[0].id))
    expect(shown(t)).toEqual(['B → Done']) // the waiting Undo goes ahead of the plain notice
  })

  it('pauses every clock while the pointer is on the notifications, and resumes with the time left', () => {
    const t = mount(4, 5)
    act(() => void t().toast('moved', 'success', { action: undo }))
    act(() => void vi.advanceTimersByTime(10_000)) // 2 s left of 12
    act(() => t().pause('hover'))
    act(() => void vi.advanceTimersByTime(60_000))
    expect(shown(t)).toEqual(['moved']) // held for as long as the pointer stays
    act(() => t().resume('hover'))
    act(() => void vi.advanceTimersByTime(1_900))
    expect(shown(t)).toEqual(['moved'])
    act(() => void vi.advanceTimersByTime(200))
    expect(shown(t)).toEqual([])
  })

  it('does not blink out the instant the pointer leaves: at least 1.5 s after a pause', () => {
    const t = mount(2, 5)
    act(() => void t().toast('notice'))
    act(() => void vi.advanceTimersByTime(1_950))
    act(() => t().pause('hover'))
    act(() => t().resume('hover'))
    act(() => void vi.advanceTimersByTime(1_000))
    expect(shown(t)).toEqual(['notice'])
    act(() => void vi.advanceTimersByTime(600))
    expect(shown(t)).toEqual([])
  })

  it('holds while the tab is in the background', () => {
    const t = mount(4, 5)
    act(() => void t().toast('moved', 'success', { action: undo }))
    const hidden = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden')
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    act(() => void document.dispatchEvent(new Event('visibilitychange')))
    act(() => void vi.advanceTimersByTime(120_000))
    expect(shown(t)).toEqual(['moved'])
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
    act(() => void document.dispatchEvent(new Event('visibilitychange')))
    act(() => void vi.advanceTimersByTime(ACTION_MIN_SECONDS * 1000 + 100))
    expect(shown(t)).toEqual([])
    if (hidden) Object.defineProperty(document, 'hidden', hidden)
    else delete (document as { hidden?: boolean }).hidden
  })

  it('two pause reasons: the clocks run again only when both are gone', () => {
    const t = mount(2, 5)
    act(() => void t().toast('notice'))
    act(() => {
      t().pause('hover')
      t().pause('focus')
      t().resume('hover')
    })
    act(() => void vi.advanceTimersByTime(30_000))
    expect(shown(t)).toEqual(['notice'])
  })
})
