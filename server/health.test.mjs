import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readAllHealth, readHealth, scrubDetail, toneOf, writeHealth } from './health.mjs'

let dir
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jb-health-'))
})
afterEach(() => rm(dir, { recursive: true, force: true }))

const T0 = new Date('2026-01-01T12:00:00Z')
const later = (s) => new Date(T0.getTime() + s * 1000)
const read = async (id) => JSON.parse(await readFile(join(dir, `${id}.json`), 'utf8'))

describe('writeHealth', () => {
  it('writes the shared record shape for ok', async () => {
    await writeHealth(dir, 'jira', { ok: true, source: 'test' }, T0)
    expect(await read('jira')).toEqual({ service: 'jira', state: 'ok', checkedAt: '2026-01-01T12:00:00Z', lastOkAt: '2026-01-01T12:00:00Z', detail: '', source: 'test' })
  })

  it('writes failures with status, http status, failingSince; keeps lastOkAt', async () => {
    await writeHealth(dir, 'jira', { ok: true }, T0)
    await writeHealth(dir, 'jira', { ok: false, status: 'auth-failed', httpStatus: 401, detail: 'Key rejected', source: 'test' }, later(100))
    const r = await read('jira')
    expect(r).toMatchObject({ state: 'attention', status: 'auth-failed', httpStatus: 401, lastOkAt: '2026-01-01T12:00:00Z', failingSince: '2026-01-01T12:01:40Z' })
    await writeHealth(dir, 'jira', { ok: false, status: 'unreachable', source: 'test' }, later(500))
    expect((await read('jira')).failingSince).toBe('2026-01-01T12:01:40Z')
    await writeHealth(dir, 'jira', { ok: true, source: 'test' }, later(900))
    const ok = await read('jira')
    expect(ok.state).toBe('ok')
    expect(ok.failingSince).toBeUndefined()
    expect(ok.status).toBeUndefined()
  })

  it('throttles an unchanged non-test outcome inside 60 s, never a test', async () => {
    await writeHealth(dir, 'claude', { ok: true, source: 'fetch' }, T0)
    expect(await writeHealth(dir, 'claude', { ok: true, source: 'fetch' }, later(30))).toBeNull()
    expect((await read('claude')).checkedAt).toBe('2026-01-01T12:00:00Z')
    expect(await writeHealth(dir, 'claude', { ok: true, source: 'fetch' }, later(61))).not.toBeNull()
    expect(await writeHealth(dir, 'claude', { ok: true, source: 'test' }, later(62))).not.toBeNull()
  })

  it('one file per service, no temp files left, bad ids refused', async () => {
    await writeHealth(dir, 'jira', { ok: true }, T0)
    await writeHealth(dir, 'cursor', { ok: false, status: 'forbidden', httpStatus: 403 }, T0)
    expect(await writeHealth(dir, '../evil', { ok: true }, T0)).toBeNull()
    expect((await readdir(dir)).sort()).toEqual(['cursor.json', 'jira.json'])
  })

  it('never throws and never records a secret', async () => {
    expect(await writeHealth('/proc/nope/never', 'jira', { ok: true }, T0)).toBeNull()
    const r = await writeHealth(dir, 'jira', { ok: false, status: 'error', detail: 'GET https://h.example/x?token=abc123 Authorization: Bearer abcdef123456 sk-ant-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, T0)
    expect(JSON.stringify(r)).not.toMatch(/abc123|abcdef123456|aaaaaaaa|token=/)
  })
})

describe('readAllHealth', () => {
  it('reads valid files, ignores junk, tolerates a missing folder', async () => {
    await writeHealth(dir, 'jira', { ok: true }, T0)
    await writeFile(join(dir, 'junk.json'), '{nope')
    await writeFile(join(dir, 'odd.json'), JSON.stringify({ state: 'weird' }))
    expect(Object.keys(await readAllHealth(dir))).toEqual(['jira'])
    expect(await readAllHealth(join(dir, 'missing'))).toEqual({})
    expect(await readHealth(dir, '../x')).toBeNull()
  })
})

describe('toneOf', () => {
  it('matches _health.tone_of', () => {
    expect(toneOf({ state: 'ok' })).toBe('ok')
    expect(toneOf({ state: 'attention', status: 'auth-failed' })).toBe('key')
    expect(toneOf({ state: 'attention', status: 'forbidden' })).toBe('key')
    for (const status of ['unreachable', 'tls', 'not-found', 'error', undefined]) expect(toneOf({ state: 'attention', status })).toBe('attention')
    expect(toneOf(null)).toBe('none')
    expect(toneOf({ state: 'weird' })).toBe('none')
  })
})

describe('scrubDetail', () => {
  it('is one short line', () => {
    const d = scrubDetail('x\n'.repeat(500))
    expect(d.length).toBeLessThanOrEqual(160)
    expect(d).not.toContain('\n')
  })
})
