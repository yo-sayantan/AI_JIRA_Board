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

function mountDemo(demo = true) {
  const ref: { current: Board | null } = { current: null }
  function Probe() {
    ref.current = useBoardData(false, undefined, demo)
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

describe('dev fixtures (?data=)', () => {
  afterEach(() => history.replaceState(null, '', '/'))
  const WORST_USER = 'Wiśniewska-Kowalczyk, Aleksandra'

  it('swap in only while demo mode is on', () => {
    history.replaceState(null, '', '/?data=worst')
    expect(mountDemo(true)().data.user?.name).toBe(WORST_USER)
  })

  it('are ignored with demo mode off, where the switch that clears them is hidden', () => {
    history.replaceState(null, '', '/?data=worst')
    expect(mountDemo(false)().data.user?.name).not.toBe(WORST_USER)
  })
})
