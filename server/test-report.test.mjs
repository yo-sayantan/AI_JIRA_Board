import { describe, expect, it } from 'vitest'
import { parseCounts } from '../scripts/test-report.mjs'

describe('test report counters', () => {
  it('does not confuse Vitest file counts with test counts', () => {
    const output = `
 Test Files  56 passed (56)
      Tests  730 passed (730)
`
    expect(parseCounts('js', output, true)).toEqual({ total: 730, passed: 730, failed: 0, skipped: 0, flaky: 0 })
  })

  it('counts mixed Vitest outcomes', () => {
    const output = `Tests  2 failed | 10 passed | 1 skipped (13)`
    expect(parseCounts('js', output, false)).toEqual({ total: 13, passed: 10, failed: 2, skipped: 1, flaky: 0 })
    expect(parseCounts('coverage', output, false)).toEqual({ total: 13, passed: 10, failed: 2, skipped: 1, flaky: 0 })
  })

  it('counts Python suite and config-test failures, errors and skips', () => {
    const output = `Ran 20 tests\nFAILED (failures=2, errors=1, skipped=3)`
    expect(parseCounts('py', output, false)).toEqual({ total: 20, passed: 14, failed: 3, skipped: 3, flaky: 0 })
    expect(parseCounts('config', output, false)).toEqual({ total: 20, passed: 14, failed: 3, skipped: 3, flaky: 0 })
  })

  it('counts Node TAP production contracts', () => {
    const output = `# tests 4\n# pass 3\n# fail 1\n# skipped 0`
    expect(parseCounts('production', output, false)).toEqual({ total: 4, passed: 3, failed: 1, skipped: 0, flaky: 0 })
    const modernOutput = `ℹ tests 4\nℹ pass 4\nℹ fail 0\nℹ skipped 0`
    expect(parseCounts('production', modernOutput, true)).toEqual({ total: 4, passed: 4, failed: 0, skipped: 0, flaky: 0 })
  })

  it('counts Playwright outcomes', () => {
    const output = `1 failed\n1 flaky\n5 passed (12.3s)`
    expect(parseCounts('e2e', output, false)).toEqual({ total: 7, passed: 5, failed: 1, skipped: 0, flaky: 1 })
  })
})
