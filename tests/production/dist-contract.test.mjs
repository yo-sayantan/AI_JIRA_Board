import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const html = readFileSync(join(ROOT, 'dist', 'index.html'), 'utf8')

test('the production board inlines app assets and keeps only its two runtime data scripts external', () => {
  assert.match(html, /<script[^>]*>[\s\S]+<\/script>/)
  const externalScripts = [...html.matchAll(/<script[^>]+\bsrc=["']([^"']+)["']/g)].map((match) => match[1])
  assert.deepEqual(externalScripts, ['../jira-intern/data.js', '../jira-intern/reports/index.js'])
  assert.doesNotMatch(html, /<link[^>]+\brel=["']stylesheet["']/)
})

test('the production artifact includes the Demo mode dataset pill', () => {
  for (const label of ['Demo data set', 'Demo board', 'Dev sample', 'Worst case', 'Empty', 'One', '400 cards']) {
    assert.ok(html.includes(label), `missing production demo control: ${label}`)
  }
})

test('the production artifact includes the fixtures behind the pill', () => {
  for (const marker of ['Wiśniewska-Kowalczyk', 'PAYMENTSRV-103999']) {
    assert.ok(html.includes(marker), `fixture was tree-shaken from the production build: ${marker}`)
  }
})

test('development-only guards are compiled away', () => {
  assert.doesNotMatch(html, /import\.meta\.env\.DEV/)
})
