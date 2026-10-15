// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Ticket } from '../types'
import { useTicketMoves } from './useTicketMoves'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Moves = ReturnType<typeof useTicketMoves>
let host: HTMLDivElement | null = null
let root: ReturnType<typeof createRoot> | null = null
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  host = root = null
})

/** Mount the hook in demo mode (local gates, no server) and hand back its latest value. */
function mountMoves() {
  const toast = vi.fn()
  const ref: { current: Moves | null } = { current: null }
  function Probe() {
    ref.current = useTicketMoves({ served: false, demo: true, toast, refreshTicket: async () => {} })
    return null
  }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(createElement(Probe)))
  return { moves: () => ref.current!, toast }
}

const dump: Ticket = { key: 'ABC-1', title: 'A card', status: 'Blocked', column: 'blocked' }

describe('moving a card and straight back', () => {
  it('Blocked → On Hold → Blocked ends Blocked again (the displayed column decides "from")', async () => {
    const { moves } = mountMoves()
    await act(async () => moves().moveTicket(dump, 'hold'))
    const shown = moves().applyOverrides([dump])[0]
    expect(shown.column).toBe('hold')
    expect(shown.onHold).toBe(true) // the pin carries the On Hold flag too
    // The dump still says Blocked; dragging the DISPLAYED (held) card back must still move it.
    await act(async () => moves().moveTicket(shown, 'blocked'))
    expect(moves().applyOverrides([dump])[0].column).toBe('blocked')
  })

  it('dropping a card where it already shows is a no-op', async () => {
    const { moves, toast } = mountMoves()
    await act(async () => moves().moveTicket(dump, 'blocked'))
    expect(toast).not.toHaveBeenCalled()
  })
})

describe('the QA lane in the move hook', () => {
  const qaTicket: Ticket = { key: 'Q-1', title: 'QA: verify', type: 'QA Task', status: 'Ready for QA', column: 'qa' }
  const dev: Ticket = { key: 'D-1', title: 'Build it', type: 'Story', status: 'In Progress', column: 'prog' }

  it('QA → QA In Progress changes what is shown although both are the same column', async () => {
    const { moves } = mountMoves()
    await act(async () => moves().moveTicket(qaTicket, 'qaip'))
    const shown = moves().applyOverrides([qaTicket])[0]
    expect(shown.column).toBe('qa')
    expect(shown.status).toBe('QA In Progress') // the board reads this as the in-progress space
    await act(async () => moves().moveTicket(shown, 'qa')) // and straight back
    expect(moves().applyOverrides([qaTicket])[0].status).toBe('Ready for QA') // back to what the dump shows
  })

  it('refuses a dev ticket to QA before Jira is asked, and says why', async () => {
    const { moves, toast } = mountMoves()
    await act(async () => moves().moveTicket(dev, 'qa'))
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('Only QA tickets'), 'error')
    expect(moves().applyOverrides([dev])[0].column).toBe('prog') // nothing pinned
  })

  it('refuses a QA ticket to leave the lane', async () => {
    const { moves, toast } = mountMoves()
    await act(async () => moves().moveTicket(qaTicket, 'prog'))
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('can only be moved to'), 'error')
  })
})

describe('gates, force and undo', () => {
  const dev: Ticket = { key: 'D-1', title: 'Build it', type: 'Story', status: 'In Progress', column: 'prog' }
  type Opts = { action?: { label: string; run: () => void }; seconds?: number }
  const last = (toast: ReturnType<typeof vi.fn>) => toast.mock.calls[toast.mock.calls.length - 1]
  const lastOpts = (toast: ReturnType<typeof vi.fn>) => last(toast)[2] as Opts | undefined

  it('a gate refuses before Jira is asked, offering "Move anyway" — which forces it', async () => {
    const { moves, toast } = mountMoves()
    await act(async () => moves().moveTicket(dev, 'rev'))
    expect(last(toast)[0]).toContain('no pull request raised')
    expect(moves().applyOverrides([dev])[0].column).toBe('prog') // nothing moved yet
    const opts = lastOpts(toast)!
    expect(opts.action!.label).toBe('Move anyway')
    await act(async () => opts.action!.run())
    expect(moves().applyOverrides([dev])[0].column).toBe('rev')
    expect(last(toast)[0]).toContain('(forced)')
  })

  it('⌥ on drop asks to move anyway rather than reporting a refusal', async () => {
    const { moves, toast } = mountMoves()
    await act(async () => moves().moveTicket(dev, 'done', { forceAsk: true }))
    expect(last(toast)[0]).toMatch(/^Move D-1 to Done anyway\?/)
    expect(lastOpts(toast)!.action!.label).toBe('Move anyway')
  })

  it('a lane refusal can never be forced', async () => {
    const { moves, toast } = mountMoves()
    await act(async () => moves().moveTicket(dev, 'qa', { forceAsk: true }))
    expect(lastOpts(toast)).toBeUndefined()
  })

  it('every finished move offers Undo, which puts the card back', async () => {
    const { moves, toast } = mountMoves()
    await act(async () => moves().moveTicket(dev, 'blocked'))
    expect(moves().applyOverrides([dev])[0].column).toBe('blocked')
    const opts = lastOpts(toast)!
    expect(opts.action!.label).toBe('Undo')
    expect(opts.seconds).toBeGreaterThan(0)
    await act(async () => opts.action!.run())
    expect(moves().applyOverrides([dev])[0].column).toBe('prog')
    expect(lastOpts(toast)).toBeUndefined() // an undo is not itself undoable
  })
})

describe('Done is final', () => {
  it('refuses to move a Done ticket anywhere, with no way to force it', async () => {
    const done: Ticket = { key: 'F-1', title: 'Shipped', type: 'Story', status: 'Done', column: 'done' }
    const { moves, toast } = mountMoves()
    await act(async () => moves().moveTicket(done, 'prog', { forceAsk: true }))
    const call = toast.mock.calls[toast.mock.calls.length - 1]
    expect(call[0]).toContain('stays in Done')
    expect(call[2]).toBeUndefined()
    expect(moves().applyOverrides([done])[0].column).toBe('done')
  })
})

describe('Next Sprint moves', () => {
  const blocked: Ticket = { key: 'B-1', title: 'Stuck', type: 'Story', status: 'Blocked', column: 'blocked' }
  const dev: Ticket = { key: 'D-1', title: 'Build it', type: 'Story', status: 'In Progress', column: 'prog' }

  it('a blocked ticket dropped on Next Sprint shows as To Do in the Next Sprint space, and Undo returns it', async () => {
    const { moves, toast } = mountMoves()
    await act(async () => moves().moveTicket(blocked, 'next'))
    const shown = moves().applyOverrides([blocked])[0]
    expect([shown.column, shown.status, shown.queued]).toEqual(['todo', 'To Do', true])
    const calls = toast.mock.calls
    const undo = calls[calls.length - 1][2] as { action: { label: string; run: () => void } }
    expect(undo.action.label).toBe('Undo')
    await act(async () => undo.action.run())
    expect(moves().applyOverrides([blocked])[0].column).toBe('blocked')
  })

  it('and back: a queued ticket dropped on To Do leaves the Next Sprint space', async () => {
    const { moves } = mountMoves()
    const queued: Ticket = { ...blocked, column: 'todo', status: 'To Do', sprint: 'S99 (future · 2999-01-10 → 2999-01-24)' }
    await act(async () => moves().moveTicket(queued, 'todo'))
    const shown = moves().applyOverrides([queued])[0]
    expect([shown.column, shown.queued]).toEqual(['todo', false])
  })

  it('refuses an In Progress ticket, and a queued ticket anywhere but To Do, with no way to force it', async () => {
    const { moves, toast } = mountMoves()
    await act(async () => moves().moveTicket(dev, 'next', { forceAsk: true }))
    expect(toast.mock.calls[toast.mock.calls.length - 1][0]).toContain('Only To Do, Blocked, QA and On Hold')
    expect(toast.mock.calls[toast.mock.calls.length - 1][2]).toBeUndefined()
  })
})


describe('reset (Demo mode → Reset)', () => {
  it('drops every move, so each card is back where the dump puts it', async () => {
    const { moves } = mountMoves()
    await act(async () => moves().moveTicket(dump, 'hold'))
    expect(moves().moved).toBe(1)
    act(() => moves().reset())
    expect(moves().applyOverrides([dump])[0].column).toBe('blocked')
    expect(moves().bottomOrder.size).toBe(0)
    expect(moves().moved).toBe(0)
  })

  it('a card can be moved again right after a reset', async () => {
    const { moves } = mountMoves()
    await act(async () => moves().moveTicket(dump, 'hold'))
    act(() => moves().reset())
    await act(async () => moves().moveTicket(dump, 'hold'))
    expect(moves().applyOverrides([dump])[0].column).toBe('hold')
  })
})
