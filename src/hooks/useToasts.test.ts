// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { useToasts } from './useToasts'

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
