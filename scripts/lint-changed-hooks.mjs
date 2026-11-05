#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import process from 'node:process'

function git(...args) {
  return spawnSync('git', args, { encoding: 'utf8' })
}

if (git('rev-parse', '--is-inside-work-tree').status !== 0) {
  console.log('Changed-hook lint skipped: Git metadata is not available in this build context.')
  process.exit(0)
}

const changed = new Set()
const add = (result) => {
  if (result.status !== 0) return
  for (const path of result.stdout.split(/\r?\n/)) {
    if (/^src\/.*\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path) && !path.startsWith('src/tests/')) changed.add(path)
  }
}
const base = `origin/${process.env.GITHUB_BASE_REF || 'main'}`
if (git('rev-parse', '--verify', base).status === 0) add(git('diff', '--name-only', `${base}...HEAD`))
add(git('diff', '--name-only'))
add(git('diff', '--cached', '--name-only'))
add(git('ls-files', '--others', '--exclude-standard'))

const files = [...changed].sort()
if (files.length === 0) {
  console.log('Changed-hook lint passed: no changed TypeScript source files.')
  process.exit(0)
}

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'
const result = spawnSync(
  npx,
  [
    'biome',
    'lint',
    '--only=lint/correctness/useHookAtTopLevel',
    '--only=lint/correctness/useExhaustiveDependencies',
    ...files,
  ],
  { stdio: 'inherit' },
)
process.exit(result.status ?? 1)
