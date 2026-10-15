// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Ticket } from '../../types'
import { Board } from './Board'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement | null = null
let root: ReturnType<typeof createRoot> | null = null
afterEach(() => {
  vi.useRealTimers()
  act(() => root?.unmount())
  host?.remove()
  host = root = null
})

const tickets: Ticket[] = [{ key: 'A-1', title: 'Card', status: 'To Do', column: 'todo' }]

describe('Board — after a drag', () => {
  it('stays calm (columns keep their extra give, cards hold still) briefly after a drop that changed nothing, then lets go', () => {
    vi.useFakeTimers()
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => root!.render(createElement(Board, { tickets, now: Date.now(), onOpen: () => {}, onMove: () => {} })))
    const board = host.firstElementChild as HTMLElement
    const card = host.querySelector('[data-ticket-key]')!
    expect(board.className).not.toContain('jb-dragging')
    act(() => { card.dispatchEvent(new Event('dragstart', { bubbles: true })) })
    expect(board.className).toContain('jb-dragging')
    act(() => { card.dispatchEvent(new Event('dragend', { bubbles: true })) })
    expect(board.className).toContain('jb-dragging') // still calm: no card springs on top of the re-flow
    act(() => { vi.advanceTimersByTime(600) })
    expect(board.className).not.toContain('jb-dragging')
  })
})
