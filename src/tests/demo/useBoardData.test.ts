// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { useBoardData } from '../../hooks/useBoardData'
import { setDevDataset } from '../../lib/devData'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Board = ReturnType<typeof useBoardData>
let host: HTMLDivElement | null = null
let root: ReturnType<typeof createRoot> | null = null

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  host = root = null
  history.replaceState(null, '', '/')
  localStorage.removeItem('jb-archived')
  localStorage.removeItem('jb-hidden')
})

function mountBoard(demo = true) {
  const ref: { current: Board | null } = { current: null }

  function Probe({ enabled }: { enabled: boolean }) {
    ref.current = useBoardData(false, undefined, enabled)
    return null
  }

  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const render = (enabled: boolean) => act(() => root!.render(createElement(Probe, { enabled })))
  render(demo)
  return { board: () => ref.current!, render }
}

describe('demo board data isolation', () => {
  it('puts a normal demo ticket moved to Completed back on the board', () => {
    const { board } = mountBoard()
    const done = board().data.tickets.find((ticket) => ticket.column === 'done')!

    act(() => board().archive(done.key))
    expect(board().userArchived).toContain(done.key)
    act(() => board().resetDemo())

    expect(board().userArchived).toEqual([])
    expect(board().data.tickets.some((ticket) => ticket.key === done.key)).toBe(true)
  })

  it('loads a requested fixture only while Demo mode is on', () => {
    history.replaceState(null, '', '/?data=worst')
    const { board, render } = mountBoard(true)
    const worstUser = board().data.user?.name

    expect(worstUser).toBe('Wiśniewska-Kowalczyk, Aleksandra')
    render(false)
    expect(board().data.user?.name).not.toBe(worstUser)
  })

  it('switches fixtures immediately without a reload', () => {
    const { board } = mountBoard()

    act(() => setDevDataset('one'))
    expect(board().data.tickets).toHaveLength(1)

    act(() => setDevDataset('huge'))
    expect(board().data.tickets).toHaveLength(400)

    act(() => setDevDataset('empty'))
    expect(board().data.tickets).toHaveLength(0)

    act(() => setDevDataset(null))
    expect(board().data.tickets.length).toBeGreaterThan(1)
  })

  it('restores fixture tickets archived before Reset demo', () => {
    history.replaceState(null, '', '/?data=worst')
    const { board } = mountBoard()
    const done = board().data.tickets.find((ticket) => ticket.column === 'done')!

    act(() => board().archive(done.key))
    expect(board().userArchived).toContain(done.key)
    act(() => board().resetDemo())

    expect(board().userArchived).not.toContain(done.key)
    expect(board().data.tickets.some((ticket) => ticket.key === done.key)).toBe(true)
  })

  it('never reads or writes the real board archive while a fixture is selected', () => {
    localStorage.setItem('jb-archived', JSON.stringify(['REAL-1']))
    history.replaceState(null, '', '/?data=worst')
    const { board } = mountBoard()
    const done = board().data.tickets.find((ticket) => ticket.column === 'done')!

    act(() => board().archive(done.key))
    act(() => board().resetDemo())

    expect(localStorage.getItem('jb-archived')).toBe(JSON.stringify(['REAL-1']))
  })

  it('keeps a stale fixture URL harmless after leaving Demo mode', () => {
    history.replaceState(null, '', '/?data=worst')
    const { board, render } = mountBoard(true)
    render(false)

    expect(new URLSearchParams(location.search).get('data')).toBe('worst')
    expect(board().data.user?.name).not.toBe('Wiśniewska-Kowalczyk, Aleksandra')
    expect(board().source).not.toBe('demo')
  })

  it('starts the selected fixture clean after leaving and re-entering Demo mode', () => {
    history.replaceState(null, '', '/?data=worst')
    const { board, render } = mountBoard(true)
    const done = board().data.tickets.find((ticket) => ticket.column === 'done')!

    act(() => board().archive(done.key))
    expect(board().userArchived).toContain(done.key)
    render(false)
    render(true)

    expect(board().userArchived).not.toContain(done.key)
    expect(board().data.tickets.some((ticket) => ticket.key === done.key)).toBe(true)
  })
})
