// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BOARD_COLUMNS, COLUMN_META } from '../../lib/columns'
import { Column } from './Column'
import { DRAG_MIME } from './TicketCard'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement | null = null
let root: ReturnType<typeof createRoot> | null = null
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  host = root = null
})

function render(props: Partial<Parameters<typeof Column>[0]> & { meta: (typeof BOARD_COLUMNS)[number] }) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(createElement(Column, { tickets: [], now: Date.now(), onOpen: () => {}, ...props })))
  return host.querySelector('section')!
}

/** jsdom has no DragEvent; a plain event carrying a dataTransfer (and a pointer y) is what React reads. */
function drop(el: Element, key = 'ABC-1', clientY?: number, altKey = false) {
  const ev = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(ev, 'altKey', { value: altKey })
  Object.defineProperty(ev, 'dataTransfer', { value: { types: [DRAG_MIME], getData: () => key, dropEffect: '' } })
  if (clientY !== undefined) Object.defineProperty(ev, 'clientY', { value: clientY })
  act(() => { el.dispatchEvent(ev) })
}

describe('Column — empty columns and the On Hold space', () => {
  it('exposes the lane name as a heading', () => {
    const waiting = { key: 'Q-1', title: 'Waiting', status: 'Ready for QA', column: 'qa' as const }
    const section = render({ meta: COLUMN_META.qa, tickets: [waiting] })
    expect(section.querySelector('h2')?.textContent).toContain('QA')
  })

  it('folds an empty column to a rail; with On Hold the rail names both targets', () => {
    expect(render({ meta: COLUMN_META.rev }).getAttribute('aria-label')).toBe('In Review — empty')
    act(() => root!.unmount())
    const blocked = render({ meta: COLUMN_META.blocked, held: [], onMove: () => {} })
    expect(blocked.getAttribute('aria-label')).toBe('Blocked and On Hold — empty')
    expect(blocked.className).toContain('jb-col-rail')
  })

  it('opens to a compact drop zone during a drag, not full width', () => {
    const s = render({ meta: COLUMN_META.rev, onMove: () => {}, dragActive: true })
    expect(s.className).toContain('jb-col-drop')
    expect(s.style.flex).toBe('0 0 7.75rem')
  })

  it('a drop on the On Hold zone moves the ticket to On Hold; anywhere else in Blocked marks it Blocked', () => {
    const onMove = vi.fn()
    const s = render({ meta: COLUMN_META.blocked, held: [], onMove, dragActive: true })
    drop(s.querySelector('[data-drop="hold"]')!)
    expect(onMove).toHaveBeenLastCalledWith('ABC-1', 'hold', false)
    drop(s)
    expect(onMove).toHaveBeenLastCalledWith('ABC-1', 'blocked', false)
  })

  it('the folded rail is droppable too — its Hold segment parks the card', () => {
    const onMove = vi.fn()
    const s = render({ meta: COLUMN_META.blocked, held: [], onMove })
    drop(s.querySelector('[data-drop="hold"]')!)
    expect(onMove).toHaveBeenLastCalledWith('ABC-1', 'hold', false)
  })

  it('without an On Hold space (Settings → On Hold off) there is no hold target at all', () => {
    const onMove = vi.fn()
    const s = render({ meta: COLUMN_META.blocked, onMove, dragActive: true })
    expect(s.querySelector('[data-drop="hold"]')).toBeNull()
    expect(s.getAttribute('aria-label')).toBe('Blocked — empty, drop a card here')
    drop(s)
    expect(onMove).toHaveBeenLastCalledWith('ABC-1', 'blocked', false)
  })

  it('other columns never offer On Hold', () => {
    const onMove = vi.fn()
    const s = render({ meta: COLUMN_META.prog, onMove, dragActive: true })
    expect(s.querySelector('[data-drop="hold"]')).toBeNull()
    drop(s)
    expect(onMove).toHaveBeenLastCalledWith('ABC-1', 'prog', false)
  })

  it('a drop in the blank part of the column BELOW Blocked lands On Hold, not Blocked', () => {
    const onMove = vi.fn()
    const s = render({ meta: COLUMN_META.blocked, held: [], onMove, dragActive: true })
    // Blocked's box ends at y=200 (jsdom has no layout, so give it one).
    const ownBox = s.querySelector('[data-drop="hold"]')!.previousElementSibling as HTMLElement
    ownBox.getBoundingClientRect = () => ({ top: 60, bottom: 200, height: 140, left: 0, right: 112, width: 112, x: 0, y: 60, toJSON: () => ({}) })
    drop(s, 'ABC-1', 640) // the empty space far below both boxes
    expect(onMove).toHaveBeenLastCalledWith('ABC-1', 'hold', false)
    drop(s, 'ABC-1', 120) // inside Blocked's box
    expect(onMove).toHaveBeenLastCalledWith('ABC-1', 'blocked', false)
  })

  it('QA gets a second, separate space for tickets being tested — its own drop target', () => {
    const waiting = { key: 'Q-1', title: 'Waiting', status: 'Ready for QA', column: 'qa' as const }
    const testing = { key: 'Q-2', title: 'Testing', status: 'QA In Progress', column: 'qa' as const }
    const onMove = vi.fn()
    const s = render({ meta: COLUMN_META.qa, tickets: [waiting, testing], onMove })
    expect(s.getAttribute('aria-label')).toBe('QA · 1 · QA In Progress · 1')
    const groups = [...s.querySelectorAll('[role=group]')]
    expect(groups).toHaveLength(1)
    expect(groups[0].getAttribute('aria-label')).toBe('QA In Progress · 1')
    drop(s.querySelector('[data-drop="qaip"]')!)
    expect(onMove).toHaveBeenLastCalledWith('ABC-1', 'qaip', false)
    drop(s, 'ABC-1', 0) // inside QA's own box
    expect(onMove).toHaveBeenLastCalledWith('ABC-1', 'qa', false)
  })

  it('an empty QA folds to a rail that names both spaces; with only picked-up cards it stays open', () => {
    expect(render({ meta: COLUMN_META.qa }).getAttribute('aria-label')).toBe('QA and QA In Progress — empty')
    act(() => root!.unmount())
    const testing = { key: 'Q-2', title: 'Testing', status: 'QA In Progress', column: 'qa' as const }
    const s = render({ meta: COLUMN_META.qa, tickets: [testing] })
    expect(s.className).toContain('jb-col-full')
  })

  it('a zone arms on dragenter alone — no waiting for the next dragover', () => {
    const onMove = vi.fn()
    const s = render({ meta: COLUMN_META.blocked, held: [], onMove, dragActive: true })
    const enter = new Event('dragenter', { bubbles: true, cancelable: true })
    Object.defineProperty(enter, 'dataTransfer', { value: { types: [DRAG_MIME], dropEffect: '' } })
    Object.defineProperty(enter, 'clientY', { value: 0 })
    const hold = s.querySelector('[data-drop="hold"]')!
    act(() => { hold.dispatchEvent(enter) })
    expect(enter.defaultPrevented).toBe(true)
    expect(hold.textContent).toContain('Release') // lit up on arrival
  })

  it('QA In Progress switched off: no second space, and no QA In Progress in its name', () => {
    const waiting = { key: 'Q-1', title: 'Waiting', status: 'Ready for QA', column: 'qa' as const }
    const s = render({ meta: COLUMN_META.qa, tickets: [waiting], showQaInProgress: false })
    expect(s.querySelector('[role=group]')).toBeNull()
    expect(s.getAttribute('aria-label')).toBe('QA · 1')
    act(() => root!.unmount())
    expect(render({ meta: COLUMN_META.qa, showQaInProgress: false }).getAttribute('aria-label')).toBe('QA — empty')
  })

  it('Blocked off but On Hold on: the column is just On Hold — its name, its target, no Blocked box', () => {
    const onMove = vi.fn()
    const parked = { key: 'H-1', title: 'Parked', status: 'On Hold', column: 'hold' as const }
    const s = render({ meta: COLUMN_META.blocked, held: [parked], hideOwn: true, onMove })
    expect(s.getAttribute('aria-label')).toBe('On Hold · 1')
    expect(s.textContent).not.toMatch(/Blocked/i)
    drop(s, 'ABC-1', 5) // anywhere in the column means On Hold
    expect(onMove).toHaveBeenLastCalledWith('ABC-1', 'hold', false)
    act(() => root!.unmount())
    expect(render({ meta: COLUMN_META.blocked, held: [], hideOwn: true }).getAttribute('aria-label')).toBe('On Hold — empty')
  })

  it('a ticket that may not go to a zone cannot be dropped there: no drop is armed and nothing moves', () => {
    const onMove = vi.fn()
    const dev = { key: 'D-1', title: 'Build it', type: 'Story', status: 'In Progress', column: 'prog' as const }
    const waiting = { key: 'Q-1', title: 'Waiting', status: 'Ready for QA', column: 'qa' as const }
    const s = render({ meta: COLUMN_META.qa, tickets: [waiting], onMove, dragActive: true, dragged: dev })
    const over = new Event('dragover', { bubbles: true, cancelable: true })
    Object.defineProperty(over, 'dataTransfer', { value: { types: [DRAG_MIME], dropEffect: '' } })
    act(() => { s.dispatchEvent(over) })
    expect(over.defaultPrevented).toBe(false) // the browser shows "no drop"
    drop(s, 'D-1')
    expect(onMove).not.toHaveBeenCalled()
  })

  it('a lane that refuses the dragged card says why in its header, not as a banner above the cards', () => {
    const dev = { key: 'D-1', title: 'Build it', type: 'Story', status: 'In Progress', column: 'prog' as const }
    const waiting = { key: 'Q-1', title: 'Waiting', status: 'Ready for QA', column: 'qa' as const }
    const s = render({ meta: COLUMN_META.qa, tickets: [waiting], onMove: () => {}, dragActive: true, dragged: dev })
    const head = s.querySelector('.jb-lane-head')!
    const note = head.querySelector('[role="note"]')
    expect(note?.textContent).toBe('QA tickets only')
    expect(note?.getAttribute('title')).toMatch(/QA/)
    // No banner above the cards: every note sits in a header row (the lane's, or QA In Progress's own), whose height is
    // fixed, so the drag moves no card.
    const notes = [...s.querySelectorAll('[role="note"]')]
    expect(notes.length).toBeGreaterThan(0)
    expect(notes.every((n) => n.closest('header'))).toBe(true)
  })

  it('shows the count again once the drag ends', () => {
    const dev = { key: 'D-1', title: 'Build it', type: 'Story', status: 'In Progress', column: 'prog' as const }
    const waiting = { key: 'Q-1', title: 'Waiting', status: 'Ready for QA', column: 'qa' as const }
    const props = { meta: COLUMN_META.qa, tickets: [waiting], now: Date.now(), onOpen: () => {}, onMove: () => {} }
    const s = render({ ...props, dragActive: true, dragged: dev })
    expect(s.querySelector('.jb-lane-head [role="note"]')).not.toBeNull()
    act(() => root!.render(createElement(Column, { ...props, dragActive: false })))
    expect(s.querySelector('[role="note"]')).toBeNull()
    expect(s.querySelector('.jb-lane-head')!.textContent).toContain('1')
  })

  it('a gate is one short line in the header; the lane under the pointer adds how to move it anyway', () => {
    const dev = { key: 'D-1', title: 'Build it', type: 'Story', status: 'In Progress', column: 'prog' as const }
    const other = { key: 'R-1', title: 'In review', status: 'In Review', column: 'rev' as const }
    const calm = render({ meta: COLUMN_META.rev, tickets: [other], onMove: () => {}, dragActive: true, dragged: dev })
    const chip = calm.querySelector('.jb-lane-head [role="note"]')!
    expect(chip.textContent).toBe('No PR yet') // nothing about moving anyway until the pointer is on this lane
    expect(chip.getAttribute('title')).toMatch(/Hold ⌥ \(Option\) while dropping to move it anyway/)
    expect(chip.textContent).not.toMatch(/force/i)

    // Pointer over the lane: the instruction appears; ⌥ held: it becomes the release prompt.
    const over = (altKey: boolean) => {
      const ev = new Event('dragover', { bubbles: true, cancelable: true })
      Object.defineProperty(ev, 'altKey', { value: altKey })
      Object.defineProperty(ev, 'dataTransfer', { value: { types: [DRAG_MIME], dropEffect: '' } })
      act(() => { calm.dispatchEvent(ev) })
      return calm.querySelector('.jb-lane-head [role="note"]')!.textContent
    }
    expect(over(false)).toBe('No PR yetHold ⌥ to move anyway')
    expect(over(true)).toBe('Release to move anyway')
  })

  it('a lane that can never take the card is red-less of any "anyway" (nothing to move anyway)', () => {
    const dev = { key: 'D-1', title: 'Build it', type: 'Story', status: 'In Progress', column: 'prog' as const }
    const waiting = { key: 'Q-1', title: 'Waiting', status: 'Ready for QA', column: 'qa' as const }
    const s = render({ meta: COLUMN_META.qa, tickets: [waiting], onMove: () => {}, dragActive: true, dragged: dev })
    expect(s.querySelector('.jb-lane-head [role="note"]')!.textContent).toBe('QA tickets only')
    expect(s.querySelector('.jb-lane-head [role="note"]')!.textContent).not.toMatch(/anyway/)
  })

  it('the lane title is sticky, so it stays in view while the board scrolls', () => {
    const waiting = { key: 'Q-1', title: 'Waiting', status: 'Ready for QA', column: 'qa' as const }
    const head = render({ meta: COLUMN_META.qa, tickets: [waiting] }).querySelector('.jb-lane-head')!
    expect(head.className).toContain('sticky')
    expect(head.className).toContain('top-0')
  })

  it('while calm the full columns may shrink further, so an empty one opening never overflows the board', () => {
    const waiting = { key: 'Q-1', title: 'Waiting', status: 'Ready for QA', column: 'qa' as const }
    const at = (calm: boolean) => parseFloat(render({ meta: COLUMN_META.prog, tickets: [waiting], calm }).style.minWidth)
    const rest = at(false)
    act(() => root!.unmount())
    const calm = at(true)
    expect(calm).toBeLessThan(rest)
  })

  it('an empty column the dragged ticket cannot use stays folded instead of opening a drop zone', () => {
    const dev = { key: 'D-1', title: 'Build it', type: 'Story', status: 'In Progress', column: 'prog' as const }
    expect(render({ meta: COLUMN_META.qa, onMove: () => {}, dragActive: true, dragged: dev }).className).toContain('jb-col-rail')
    act(() => root!.unmount())
    const qaTicket = { key: 'Q-2', title: 'QA: check', type: 'QA Task', status: 'To Do', column: 'todo' as const }
    expect(render({ meta: COLUMN_META.qa, onMove: () => {}, dragActive: true, dragged: qaTicket }).className).toContain('jb-col-drop')
  })

  it('a gated zone says what is missing, refuses a plain drop, and takes a ⌥-drop as a move-anyway', () => {
    const onMove = vi.fn()
    const dev = { key: 'D-1', title: 'Build it', type: 'Story', status: 'In Progress', column: 'prog' as const }
    const s = render({ meta: COLUMN_META.rev, onMove, dragActive: true, dragged: dev })
    expect(s.className).toContain('jb-col-drop') // a gate still opens the zone, to say why
    expect(s.textContent).toContain('No PR yet')
    expect(s.textContent).toContain('anyway') // the drop zone has room for the hint
    expect(s.textContent).not.toMatch(/force/i)
    expect(s.querySelector('[title*="no pull request raised yet"]')).not.toBeNull() // the full sentence is the tooltip
    drop(s, 'D-1')
    expect(onMove).not.toHaveBeenCalled()
    drop(s, 'D-1', undefined, true)
    expect(onMove).toHaveBeenLastCalledWith('D-1', 'rev', true)
  })

  it('answers "copy" while ⌥ is held (macOS limits an Option-drag to a copy) and "move" otherwise', () => {
    const dev = { key: 'D-1', title: 'Build it', type: 'Story', status: 'In Progress', column: 'prog' as const }
    const s = render({ meta: COLUMN_META.rev, onMove: () => {}, dragActive: true, dragged: dev })
    const over = (altKey: boolean) => {
      const ev = new Event('dragover', { bubbles: true, cancelable: true })
      const dt = { types: [DRAG_MIME], dropEffect: '' }
      Object.defineProperty(ev, 'altKey', { value: altKey })
      Object.defineProperty(ev, 'dataTransfer', { value: dt })
      act(() => { s.dispatchEvent(ev) })
      return { armed: ev.defaultPrevented, effect: dt.dropEffect }
    }
    expect(over(true)).toEqual({ armed: true, effect: 'copy' }) // a gate + ⌥: armed, as a copy
    expect(over(false)).toEqual({ armed: false, effect: '' }) // a gate without ⌥: not armed
    const free = render({ meta: COLUMN_META.todo, onMove: () => {}, dragActive: true, dragged: dev })
    const ev = new Event('dragover', { bubbles: true, cancelable: true })
    const dt = { types: [DRAG_MIME], dropEffect: '' }
    Object.defineProperty(ev, 'dataTransfer', { value: dt })
    act(() => { free.dispatchEvent(ev) })
    expect(dt.dropEffect).toBe('move') // a free move stays a move
  })

  it('a lane refusal is named and never forced, ⌥ or not', () => {
    const onMove = vi.fn()
    const qaTicket = { key: 'Q-2', title: 'QA: check', type: 'QA Task', status: 'Ready for QA', column: 'qa' as const }
    const busy = { key: 'B-1', title: 'Busy', status: 'In Progress', column: 'prog' as const }
    const s = render({ meta: COLUMN_META.prog, tickets: [busy], onMove, dragActive: true, dragged: qaTicket })
    expect(s.textContent).toContain('QA tickets stay in QA')
    drop(s, 'Q-2', undefined, true)
    expect(onMove).not.toHaveBeenCalled()
  })

  it('To Do gets a Next Sprint space at its end — its own header and box, and a drop target', () => {
    const onMove = vi.fn()
    const todo = { key: 'T-1', title: 'This sprint', status: 'To Do', column: 'todo' as const }
    const queued = { key: 'T-2', title: 'Later', status: 'To Do', column: 'todo' as const, sprint: 'Sprint 99' }
    const s = render({ meta: COLUMN_META.todo, tickets: [todo], queued: [queued], onMove })
    expect(s.getAttribute('aria-label')).toBe('To Do · 1 · Next Sprint · 1')
    const group = s.querySelector('[role=group]')!
    expect(group.textContent).toContain('Later')
    expect(group.getAttribute('data-drop')).toBe('next')
    drop(group, 'ABC-1')
    expect(onMove).toHaveBeenLastCalledWith('ABC-1', 'next', false)
    drop(s, 'ABC-1', 5)
    expect(onMove).toHaveBeenLastCalledWith('ABC-1', 'todo', false) // the rest of the column is a To Do drop
  })

  it('a Done card is not draggable; others are', () => {
    const done = { key: 'D-1', title: 'Shipped', status: 'Done', column: 'done' as const }
    const open = { key: 'P-1', title: 'Working', status: 'In Progress', column: 'prog' as const }
    const s = render({ meta: COLUMN_META.done, tickets: [done], onMove: () => {} })
    expect(s.querySelector('[data-ticket-key="D-1"]')!.getAttribute('draggable')).toBeNull()
    act(() => root!.unmount())
    const p = render({ meta: COLUMN_META.prog, tickets: [open], onMove: () => {} })
    expect(p.querySelector('[data-ticket-key="P-1"]')!.getAttribute('draggable')).toBe('true')
  })

  it('the Next Sprint space is always there to drop on (even empty), unless Settings turned it off', () => {
    const s = render({ meta: COLUMN_META.todo, queued: [] })
    expect(s.getAttribute('aria-label')).toBe('To Do and Next Sprint — empty')
    act(() => root!.unmount())
    expect(render({ meta: COLUMN_META.todo }).querySelector('[role=group]')).toBeNull()
  })

  it('only To Do, Blocked, QA and On Hold cards may enter Next Sprint; from it only To Do is open', () => {
    const inProgress = { key: 'P-1', title: 'Working', status: 'In Progress', column: 'prog' as const }
    const blocked = { key: 'B-1', title: 'Stuck', status: 'Blocked', column: 'blocked' as const }
    const queuedTicket = { key: 'N-1', title: 'Queued', status: 'To Do', column: 'todo' as const, sprint: 'S99 (future · 2999-01-10 → 2999-01-24)' }
    const onMove = vi.fn()
    // Dragging an In Progress card: Next Sprint refuses it ("Not from here"), never forcible.
    let s = render({ meta: COLUMN_META.todo, queued: [], onMove, dragActive: true, dragged: inProgress })
    expect(s.querySelector('[data-drop="next"]')!.textContent).toContain('Not from here')
    drop(s.querySelector('[data-drop="next"]')!, 'P-1', undefined, true)
    expect(onMove).not.toHaveBeenCalled()
    act(() => root!.unmount())
    // A Blocked card may enter.
    s = render({ meta: COLUMN_META.todo, queued: [], onMove, dragActive: true, dragged: blocked })
    drop(s.querySelector('[data-drop="next"]')!, 'B-1')
    expect(onMove).toHaveBeenLastCalledWith('B-1', 'next', false)
    act(() => root!.unmount())
    // A Next Sprint card may go to To Do, but not to In Progress.
    s = render({ meta: COLUMN_META.prog, onMove, dragActive: true, dragged: queuedTicket })
    expect(s.textContent).toContain('Back to To Do only')
  })

  it('Next Sprint names each sprint and when it starts, one caption per group', () => {
    const t = (key: string, sprint: string) => ({ key, title: key, status: 'To Do', column: 'todo' as const, sprint })
    const dated = 'S99 (future · 2999-01-10 → 2999-01-24)'
    const queued = [t('Q-1', dated), t('Q-2', dated), t('Q-3', 'Platform READY (future)')]
    const s = render({ meta: COLUMN_META.todo, tickets: [], queued })
    const group = s.querySelector('[role=group]')!
    expect(group.textContent).toContain('S99')
    expect(group.textContent).toMatch(/starts in \d+ days? · Jan 10/)
    expect(group.textContent).toContain('Platform READY')
    expect(group.textContent).toContain('not started')
    expect(group.textContent!.match(/S99/g)).toHaveLength(1) // one caption for both its tickets
  })
})
