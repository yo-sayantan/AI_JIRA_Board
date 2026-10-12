import { describe, expect, it } from 'vitest'
import type { CloudModelChoice } from './runner'
import { effortChoicesFor, groupByProvider, isPricey, levelAllows, usd } from './cloudModels'

describe('usd', () => {
  it('writes whole dollars bare and fractions to the precision Cursor quotes', () => {
    expect(usd(2)).toBe('$2')
    expect(usd(10)).toBe('$10')
    expect(usd(0.5)).toBe('$0.50')
    expect(usd(1.2)).toBe('$1.20')
    expect(usd(4.25)).toBe('$4.25')
    expect(usd(0.125)).toBe('$0.125')
    expect(usd(0.029)).toBe('$0.029')
  })
  it('shows a dash where Cursor lists no charge', () => {
    expect(usd(null)).toBe('—')
    expect(usd(undefined)).toBe('—')
  })
})

describe('groupByProvider', () => {
  const m = (id: string, provider?: string): CloudModelChoice => ({ id, label: id, provider })
  it('keeps the server order, one group per maker', () => {
    const groups = groupByProvider([m('a', 'Cursor'), m('b', 'Anthropic'), m('c', 'Anthropic'), m('d', 'OpenAI')])
    expect(groups.map(([g, rows]) => [g, rows.map((r) => r.id)])).toEqual([
      ['Cursor', ['a']],
      ['Anthropic', ['b', 'c']],
      ['OpenAI', ['d']],
    ])
  })
  it('puts models without a maker in one ungrouped list (Claude and Gemini providers)', () => {
    expect(groupByProvider([m('x'), m('y')])).toEqual([['', [m('x'), m('y')]]])
  })
})

describe('isPricey', () => {
  const at = (output: number | null) => ({ price: { output } })
  it('without a costly flag, $10 and above is costly — the line is "at or above"', () => {
    expect(isPricey(at(12))).toBe(true)
    expect(isPricey(at(10.01))).toBe(true)
    expect(isPricey(at(10))).toBe(true)
    expect(isPricey(at(9.99))).toBe(false)
    expect(isPricey(at(1.2))).toBe(false)
  })
  it('stays quiet when there is no price to judge', () => {
    expect(isPricey(at(null))).toBe(false)
    expect(isPricey({})).toBe(false)
    expect(isPricey(null)).toBe(false)
    expect(isPricey(undefined)).toBe(false)
  })
})

describe('effortChoicesFor', () => {
  it('offers exactly the efforts the config lists for the model, in the dropdown order', () => {
    expect(effortChoicesFor({ efforts: ['auto', 'low', 'high', 'medium'] })).toEqual(['low', 'medium', 'high', 'auto'])
    expect(effortChoicesFor({ efforts: ['low', 'auto'] })).toEqual(['low', 'auto'])
  })
  it('offers none when the config lists none (a costly model) or the model is unknown', () => {
    expect(effortChoicesFor({ efforts: [] })).toEqual([])
    expect(effortChoicesFor({})).toEqual([])
    expect(effortChoicesFor(null)).toEqual([])
  })
  it('ignores an effort it does not know', () => {
    expect(effortChoicesFor({ efforts: ['turbo', 'low'] })).toEqual(['low'])
  })
})

describe('isPricey follows the worker\'s costly verdict', () => {
  it('trusts the flag either way, whatever the price says', () => {
    expect(isPricey({ costly: true, price: { output: 1 } })).toBe(true)
    expect(isPricey({ costly: false, price: { output: 90 } })).toBe(false)
  })
  it('without a flag, $10 itself is costly (at or above the line)', () => {
    expect(isPricey({ price: { output: 10 } })).toBe(true)
    expect(isPricey({ price: { output: 9.99 } })).toBe(false)
    expect(isPricey({ price: null })).toBe(false)
  })
})

describe('levelAllows', () => {
  const priced = (output: number | null, costly?: boolean) => ({ costly, price: { output } })
  it('caps Low at $1, Medium at $5 (both inclusive) and High below $10', () => {
    expect([0.5, 1, 1.2].map((o) => levelAllows('low', priced(o)))).toEqual([true, true, false])
    expect([4.5, 5, 6].map((o) => levelAllows('moderate', priced(o)))).toEqual([true, true, false])
    expect([6, 9, 9.99, 10, 12].map((o) => levelAllows('high', priced(o)))).toEqual([true, true, true, false, false])
  })
  it('lets Max run every model, priced or not', () => {
    expect(levelAllows('full', priced(12))).toBe(true)
    expect(levelAllows('full', priced(null))).toBe(true)
    expect(levelAllows('full', null)).toBe(true)
  })
  it('never lets a costly model below Max, whatever it costs', () => {
    expect(levelAllows('high', priced(3, true))).toBe(false)
  })
  it('does not allow a model with no listed price below Max', () => {
    expect(levelAllows('moderate', priced(null))).toBe(false)
    expect(levelAllows('moderate', { price: null })).toBe(false)
  })
})
