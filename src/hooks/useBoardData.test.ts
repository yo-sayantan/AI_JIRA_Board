// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { useBoardData } from './useBoardData'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Board = ReturnType<typeof useBoardData>
let host: HTMLDivElement | null = null
let root: ReturnType<typeof createRoot> | null = null
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  host = root = null
})

function mountDemo() {
  const ref: { current: Board | null } = { current: null }
  function Probe() {
    ref.current = useBoardData(false, undefined, true)
    return null
  }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(createElement(Probe)))
  return () => ref.current!
}

describe('Demo mode reset', () => {
  it('puts tickets moved to Completed back on the board', () => {
    const board = mountDemo()
    const done = board().data.tickets.find((t) => t.column === 'done')!
    act(() => board().archive(done.key))
    expect(board().userArchived).toContain(done.key)
    act(() => board().resetDemo())
    expect(board().userArchived).toEqual([])
    expect(board().data.tickets.some((t) => t.key === done.key)).toBe(true)
  })
})
