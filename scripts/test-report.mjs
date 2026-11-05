const ANSI = /\u001b\[[0-9;]*m/g
const clean = (value) => value.replace(ANSI, '')
const count = (text, pattern) => Number(pattern.exec(text)?.[1] ?? 0)

export function parseCounts(id, rawText, ok) {
  const text = clean(rawText)
  if (id === 'py' || id === 'config') {
    const total = count(text, /Ran (\d+) tests?/)
    const failed = count(text, /failures=(\d+)/) + count(text, /errors=(\d+)/)
    const skipped = count(text, /skipped=(\d+)/)
    return { total, passed: Math.max(0, total - failed - skipped), failed, skipped, flaky: 0 }
  }
  if (id === 'js' || id === 'coverage') {
    const summary = /Tests\s+([^\n]+)/.exec(text)?.[1] ?? ''
    const total = count(summary, /\((\d+)\)/)
    const failed = count(summary, /(\d+) failed/)
    const skipped = count(summary, /(\d+) skipped/)
    const passed = count(summary, /(\d+) passed/)
    return { total: total || passed + failed + skipped, passed, failed, skipped, flaky: 0 }
  }
  if (id === 'production') {
    return {
      total: count(text, /(?:#|ℹ)\s*tests\s+(\d+)/),
      passed: count(text, /(?:#|ℹ)\s*pass\s+(\d+)/),
      failed: count(text, /(?:#|ℹ)\s*fail\s+(\d+)/),
      skipped: count(text, /(?:#|ℹ)\s*skipped\s+(\d+)/),
      flaky: 0,
    }
  }
  const passed = count(text, /(\d+) passed/)
  const failed = count(text, /(\d+) failed/)
  const skipped = count(text, /(\d+) skipped/)
  const flaky = count(text, /(\d+) flaky/)
  const total = passed + failed + skipped + flaky
  return { total: total || 1, passed: total ? passed : Number(ok), failed: total ? failed : Number(!ok), skipped, flaky }
}
