import { describe, expect, it } from 'vitest'
import { GAP, PEEK, stackHeight, stackLayout, stackOrder, type ToastItem } from './Toast'

const t = (id: number, action = false): ToastItem => ({ id, msg: `t${id}`, ...(action ? { action: { label: 'Undo', run: () => {} } } : {}) })

describe('toast stack', () => {
  it('puts the newest in front, but a toast with a button always ahead of plain ones', () => {
    expect(stackOrder([t(1), t(2), t(3)]).map((x) => x.id)).toEqual([3, 2, 1])
    expect(stackOrder([t(1, true), t(2), t(3)]).map((x) => x.id)).toEqual([1, 3, 2])
  })

  it('closed: the ones behind line their top edge up just above the front toast, smaller each', () => {
    const [front, second, third, fourth] = stackLayout([40, 60, 30, 40], false)
    expect(front).toEqual({ y: 0, scale: 1, opacity: 1, contentOpacity: 1 })
    // top edge = −height + y = −(40 + PEEK) for the second, −(40 + 2·PEEK) for the third
    expect(-60 + second.y).toBe(-(40 + PEEK))
    expect(-30 + third.y).toBe(-(40 + 2 * PEEK))
    expect(second.scale).toBeLessThan(1)
    expect(second.contentOpacity).toBe(0)
    expect(fourth.opacity).toBe(0)
  })

  it('open: a list, newest at the bottom, every toast readable', () => {
    const slots = stackLayout([40, 60, 30], true)
    expect(slots.map((s) => s.y)).toEqual([0, -(40 + GAP), -(40 + GAP + 60 + GAP)])
    expect(slots.every((s) => s.scale === 1 && s.contentOpacity === 1)).toBe(true)
    expect(stackHeight([40, 60, 30], true)).toBe(130 + 2 * GAP)
    expect(stackHeight([40, 60, 30], false)).toBe(40 + 2 * PEEK)
  })
})
