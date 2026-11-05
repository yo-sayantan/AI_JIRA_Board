#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import process from 'node:process'

function git(...args) {
  return spawnSync('git', args, { encoding: 'utf8' })
}

if (git('rev-parse', '--is-inside-work-tree').status !== 0) {
  console.log('Test-change gate skipped: Git metadata is not available in this build context.')
  process.exit(0)
}

const baseName = process.env.GITHUB_BASE_REF || 'main'
const base = `origin/${baseName}`
const changed = new Set()
const testCandidates = new Set()
const add = (result, target = changed) => {
  if (result.status !== 0) return
  for (const path of result.stdout.split(/\r?\n/)) if (path) target.add(path)
}

if (git('rev-parse', '--verify', base).status === 0) {
  add(git('diff', '--name-only', `${base}...HEAD`))
  add(git('diff', '--name-only', '--diff-filter=ACMRTUXB', `${base}...HEAD`), testCandidates)
}
add(git('diff', '--name-only'))
add(git('diff', '--cached', '--name-only'))
add(git('diff', '--name-only', '--diff-filter=ACMRTUXB'), testCandidates)
add(git('diff', '--cached', '--name-only', '--diff-filter=ACMRTUXB'), testCandidates)
const untracked = git('ls-files', '--others', '--exclude-standard')
add(untracked)
add(untracked, testCandidates)

const paths = [...changed]
const isBehavioralSource = (path) =>
  /^(src|server|jira-intern|ai-intern|scripts|docker)\//.test(path) &&
  /\.(?:css|html|js|mjs|py|sh|ts|tsx)$/.test(path) &&
  !/(?:^|\/)(?:tests?|__tests__)\//.test(path) &&
  !/\.test\.[^.]+$/.test(path)
const isTest = (path) =>
  /(?:^|\/)(?:tests?|__tests__)\//.test(path) ||
  /\.test\.[^.]+$/.test(path)

const sourceChanges = paths.filter(isBehavioralSource)
const testChanges = [...testCandidates].filter(isTest)

if (sourceChanges.length > 0 && testChanges.length === 0) {
  console.error('Behavioral source changed without a test change.')
  console.error('Source changes:')
  for (const path of sourceChanges) console.error(`  - ${path}`)
  console.error('Add or update a unit, component, integration, production-contract, or E2E test.')
  process.exit(1)
}

console.log(
  sourceChanges.length === 0
    ? 'Test-change gate passed: no behavioral source changes.'
    : `Test-change gate passed: ${sourceChanges.length} behavioral source file(s), ${testChanges.length} test file(s).`,
)
