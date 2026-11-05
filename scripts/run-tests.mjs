#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import process from 'node:process'
import { setTimeout as wait } from 'node:timers/promises'
import { parseCounts } from './test-report.mjs'

const ROOT = process.cwd()
const OUT = join(ROOT, 'test-results')
const JSON_FILE = join(OUT, 'latest.json')
const HTML_FILE = join(OUT, 'index.html')
const LOCK_FILE = join(OUT, '.report.lock')
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'

const SUITES = {
  policy: {
    label: 'Test-change policy',
    command: process.execPath,
    args: ['scripts/check-test-change.mjs'],
  },
  py: {
    label: 'Python logic & integration',
    command: 'python3',
    args: ['-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*.py'],
  },
  config: {
    label: 'Project configuration',
    command: 'python3',
    args: ['tests/test_config.py'],
  },
  js: {
    label: 'Vitest unit, component & flow',
    command: npx,
    args: ['vitest', 'run', '--config', 'tooling/vitest.config.ts'],
  },
  coverage: {
    label: 'Vitest coverage',
    command: npx,
    args: [
      'vitest',
      'run',
      '--config',
      'tooling/vitest.config.ts',
      '--coverage',
      '--coverage.reporter=text',
      '--coverage.reporter=json-summary',
      '--coverage.reporter=html',
    ],
  },
  production: {
    label: 'Production artifact contracts',
    command: process.execPath,
    args: ['--test', 'tests/production/dist-contract.test.mjs'],
  },
  e2e: {
    label: 'Playwright production UI flows',
    command: npx,
    args: ['playwright', 'test', '--config', 'tooling/playwright.config.ts'],
  },
  'e2e-smoke': {
    label: 'Playwright production smoke',
    command: npx,
    args: ['playwright', 'test', '--config', 'tooling/playwright.config.ts', '--grep', '@smoke'],
  },
}

function git(...args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' })
  return result.status === 0 ? (result.stdout ?? '').trim() : ''
}

function workspaceRevision() {
  const hash = createHash('sha256')
  hash.update(git('rev-parse', 'HEAD') || 'no-git')
  hash.update(spawnSync('git', ['diff', '--binary', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout ?? '')
  const untracked = git('ls-files', '--others', '--exclude-standard')
    .split(/\r?\n/)
    .filter((path) => path && !path.startsWith('.hallmark/'))
    .sort()
  for (const path of untracked) {
    hash.update(path)
    try {
      hash.update(readFileSync(join(ROOT, path)))
    } catch {
      hash.update('unreadable')
    }
  }
  return hash.digest('hex').slice(0, 12)
}

async function withReportLock(fn) {
  mkdirSync(OUT, { recursive: true })
  let descriptor
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      descriptor = openSync(LOCK_FILE, 'wx')
      writeFileSync(descriptor, String(process.pid))
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      let owner
      try {
        owner = Number.parseInt(readFileSync(LOCK_FILE, 'utf8'), 10)
      } catch {
        await wait(50)
        continue
      }
      if (!Number.isInteger(owner) || owner <= 0) {
        await wait(50)
        continue
      }
      try {
        process.kill(owner, 0)
      } catch {
        try {
          unlinkSync(LOCK_FILE)
        } catch {
          // Another process replaced or removed the stale lock first.
        }
      }
      await wait(50)
    }
  }
  if (descriptor === undefined) throw new Error(`Timed out waiting for ${LOCK_FILE}`)
  try {
    return fn()
  } finally {
    closeSync(descriptor)
    try {
      unlinkSync(LOCK_FILE)
    } catch {
      // Another process cannot own this lock until our descriptor has closed.
    }
  }
}

async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  if (!port) throw new Error('Could not allocate a browser-test port')
  return port
}

function loadReport() {
  try {
    return JSON.parse(readFileSync(JSON_FILE, 'utf8'))
  } catch {
    return { latest: {}, history: [] }
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function writeReport(report) {
  mkdirSync(OUT, { recursive: true })
  const jsonTemp = `${JSON_FILE}.${process.pid}.tmp`
  writeFileSync(jsonTemp, `${JSON.stringify(report, null, 2)}\n`)
  renameSync(jsonTemp, JSON_FILE)

  const latest = Object.values(report.latest)
  const total = latest.reduce((sum, run) => sum + run.total, 0)
  const passed = latest.reduce((sum, run) => sum + run.passed, 0)
  const failed = latest.reduce((sum, run) => sum + run.failed, 0)
  const skipped = latest.reduce((sum, run) => sum + run.skipped, 0)
  const flaky = latest.reduce((sum, run) => sum + run.flaky, 0)
  const rate = total ? ((passed / total) * 100).toFixed(1) : '0.0'
  const rows = latest
    .sort((a, b) => a.label.localeCompare(b.label))
    .map(
      (run) => `<tr>
        <td><span class="status ${run.ok ? (run.flaky ? 'warn' : 'pass') : 'fail'}">${run.ok ? (run.flaky ? 'FLAKY' : 'PASS') : 'FAIL'}</span></td>
        <td>${escapeHtml(run.label)}</td>
        <td>${run.total}</td><td>${run.passed}</td><td>${run.failed}</td><td>${run.skipped}</td><td>${run.flaky}</td>
        <td>${run.passRate}%</td><td>${(run.durationMs / 1000).toFixed(2)}s</td>
        <td>${escapeHtml(new Date(run.finishedAt).toLocaleString())}</td>
      </tr>`,
    )
    .join('')

  const htmlTemp = `${HTML_FILE}.${process.pid}.tmp`
  writeFileSync(
    htmlTemp,
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Jira Board test report</title>
<style>
  :root{font:14px/1.45 ui-sans-serif,system-ui;color:#182033;background:#f4f6fa}
  body{max-width:1100px;margin:40px auto;padding:0 20px}h1{margin-bottom:4px}.meta{color:#5d6980}
  .summary{display:grid;grid-template-columns:repeat(6,minmax(100px,1fr));gap:12px;margin:24px 0}
  .card{background:#fff;border:1px solid #dce2ec;border-radius:12px;padding:14px}.card strong{display:block;font-size:24px}
  table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #dce2ec}th,td{padding:10px 12px;text-align:left;border-bottom:1px solid #e7ebf2}
  .status{font-weight:700}.pass{color:#08783e}.warn{color:#a15c00}.fail{color:#c52828}@media(max-width:760px){.summary{grid-template-columns:repeat(2,1fr)}table{display:block;overflow:auto}}
</style></head><body>
<h1>Jira Board test report</h1>
<div class="meta">Branch ${escapeHtml(report.branch)} · commit ${escapeHtml(report.commit || 'uncommitted')} · workspace ${escapeHtml(report.revision)} · generated ${escapeHtml(new Date().toLocaleString())}</div>
<section class="summary">
  <div class="card"><span>Pass rate</span><strong>${rate}%</strong></div>
  <div class="card"><span>Total</span><strong>${total}</strong></div>
  <div class="card"><span>Passed</span><strong>${passed}</strong></div>
  <div class="card"><span>Failed</span><strong>${failed}</strong></div>
  <div class="card"><span>Skipped</span><strong>${skipped}</strong></div>
  <div class="card"><span>Flaky</span><strong>${flaky}</strong></div>
</section>
<table><thead><tr><th>Status</th><th>Suite</th><th>Total</th><th>Passed</th><th>Failed</th><th>Skipped</th><th>Flaky</th><th>Rate</th><th>Duration</th><th>Last run</th></tr></thead>
<tbody>${rows}</tbody></table>
<p class="meta">Detailed Playwright traces, screenshots, video, and HTML are under <code>test-results/</code> when browser tests fail.</p>
</body></html>`,
  )
  renameSync(htmlTemp, HTML_FILE)
  console.log(`\nTest report: ${HTML_FILE}`)
}

async function runSuite(id, metadata, extraArgs) {
  const suite = SUITES[id]
  if (!suite) throw new Error(`Unknown suite "${id}". Choose: ${Object.keys(SUITES).join(', ')}, all`)
  const started = Date.now()
  let stdout = ''
  let stderr = ''
  const browserRun = id.startsWith('e2e')
  const browserPort = browserRun ? await freePort() : null
  const env = browserRun
    ? {
        ...process.env,
        JB_TEST_RUN_ID: `${id}-${process.pid}-${started}`,
        JB_TEST_PORT: String(browserPort),
      }
    : process.env
  const child = spawn(suite.command, [...suite.args, ...extraArgs], { cwd: ROOT, env })
  child.stdout.on('data', (chunk) => {
    const text = chunk.toString()
    stdout += text
    process.stdout.write(text)
  })
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString()
    stderr += text
    process.stderr.write(text)
  })
  child.on('error', (error) => {
    const text = `${error.message}\n`
    stderr += text
    process.stderr.write(text)
  })
  const code = await new Promise((resolve) => child.on('close', resolve))
  const finishedAt = new Date().toISOString()
  const ok = code === 0
  const counts = parseCounts(id, `${stdout}\n${stderr}`, ok)
  return {
    id,
    label: suite.label,
    ok,
    exitCode: code ?? 1,
    ...counts,
    passRate: counts.total ? Number(((counts.passed / counts.total) * 100).toFixed(1)) : 0,
    durationMs: Date.now() - started,
    finishedAt,
    ...metadata,
  }
}

const requested = process.argv[2] ?? 'all'
const ids = requested === 'all' ? ['py', 'js'] : [requested]
const extraArgs = process.argv.slice(3)
const metadata = {
  branch: git('branch', '--show-current') || 'detached',
  commit: git('rev-parse', '--short', 'HEAD') || 'uncommitted',
  revision: workspaceRevision(),
}
const results = []
let failed = false

for (const id of ids) {
  const result = await runSuite(id, metadata, extraArgs)
  results.push(result)
  failed ||= !result.ok
}

await withReportLock(() => {
  const report = loadReport()
  if (report.revision !== metadata.revision) report.latest = {}
  for (const result of results) {
    report.latest[result.id] = result
    report.history.push(result)
  }
  report.history = report.history.slice(-100)
  Object.assign(report, metadata)
  writeReport(report)
})
process.exitCode = failed ? 1 : 0
