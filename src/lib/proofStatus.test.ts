import { describe, expect, it } from 'vitest'
import { HEALTH_COLOR } from './apiKeys'
import { PROOF_SOURCES, lastFetchView, proofNoteOf, vulnReadLine } from './proofStatus'
import type { SourceStatus, VulnFixes } from '../types'

const NOW = Date.parse('2026-10-11T10:00:00Z')

const status = (over: Partial<SourceStatus> = {}): SourceStatus => ({
  state: 'read',
  detail: 'Checkmarx: 3 vulnerability-fix tickets looked up (7 targets: 4 fixed · 2 open · 1 not found) — 2 with open findings',
  at: '2026-10-11T09:46:00Z',
  ...over,
})

const vf = (read?: VulnFixes['read']): VulnFixes => ({
  scannedAt: '2026-10-11T06:00:00Z',
  project: 'demo-service',
  branch: 'bugfix/DEMO-1_x',
  baseBranch: 'release/2.1',
  items: [{ target: 'CVE-2024-1001', kind: 'cve', status: 'not-found' }],
  read,
})

describe('proofNoteOf — why a vulnerability-fix ticket has no fresh answer', () => {
  const note = { state: 'not-configured', detail: 'Checkmarx not configured — add the URL and key in API keys', at: '2026-10-11T09:00:00Z' } as const

  it('returns the note for its source', () => {
    expect(proofNoteOf({ proofNotes: { checkmarx: note } }, 'checkmarx')).toEqual(note)
  })

  it('answers for Dynatrace too, separately from the other sources', () => {
    const dt = { state: 'unreachable', detail: 'Dynatrace could not be reached — links not re-read', at: '2026-10-11T09:00:00Z' } as const
    expect(proofNoteOf({ proofNotes: { dynatrace: dt, checkmarx: note } }, 'dynatrace')).toEqual(dt)
    expect(proofNoteOf({ proofNotes: { checkmarx: note } }, 'dynatrace')).toBeNull()
    expect(proofNoteOf({ proofNotes: { dynatrace: dt } }, 'checkmarx')).toBeNull()
    expect(proofNoteOf({ proofNotes: { dynatrace: { state: 'weird', detail: 'x', at: '' } } } as never, 'dynatrace')).toBeNull()
    expect(proofNoteOf({ proofNotes: { dynatrace: { state: 'auth-failed', detail: '', at: '' } } } as never, 'dynatrace')).toBeNull()
  })

  it('is null when absent, for another source, or malformed', () => {
    expect(proofNoteOf({}, 'checkmarx')).toBeNull()
    expect(proofNoteOf({ proofNotes: null }, 'checkmarx')).toBeNull()
    expect(proofNoteOf({ proofNotes: { jenkins: null } }, 'checkmarx')).toBeNull()
    expect(proofNoteOf({ proofNotes: { checkmarx: { state: 'weird', detail: 'x', at: '' } } } as never, 'checkmarx')).toBeNull()
    expect(proofNoteOf({ proofNotes: { checkmarx: { state: 'unreachable', detail: '', at: '' } } } as never, 'checkmarx')).toBeNull()
  })
})

describe('vulnReadLine — what each scan returned', () => {
  it('says how many results each side gave, by engine', () => {
    const line = vulnReadLine(
      vf({
        branch: { total: 412, sca: 380, sast: 18, other: 14, truncated: false, reported: 412 },
        base: { total: 398, sca: 380, sast: 18, other: 0, truncated: false },
      }),
    )
    expect(line).toBe('Read 412 results on the branch scan (SCA 380 · SAST 18 · other 14); 398 on the base scan (SCA 380 · SAST 18)')
  })

  it('calls out a scan that returned nothing', () => {
    expect(vulnReadLine(vf({ branch: { total: 0, sca: 0, sast: 0, other: 0, truncated: false }, base: { total: 5, sca: 5, sast: 0, other: 0, truncated: false } }))).toBe(
      'Read 0 results on the branch scan — the results API returned nothing for it; 5 on the base scan (SCA 5)',
    )
  })

  it('says when a scan was only partly read', () => {
    expect(vulnReadLine(vf({ base: { total: 1000, sca: 1000, sast: 0, other: 0, truncated: true, reported: 2400 } }))).toBe(
      'Read 1000 results on the base scan (SCA 1000) — only part of the 2400 it holds',
    )
  })

  it('is empty without a read (older dumps)', () => {
    expect(vulnReadLine(vf())).toBe('')
    expect(vulnReadLine(vf({}))).toBe('')
    expect(vulnReadLine(vf(null))).toBe('')
  })
})

describe('lastFetchView — the "Last fetch" line of a proof source in the API keys window', () => {
  it('lists the sources that have one', () => {
    expect(PROOF_SOURCES).toContain('checkmarx')
    expect(PROOF_SOURCES).toContain('dynatrace')
  })

  it('a Dynatrace read says what was looked up, without repeating the name', () => {
    const v = lastFetchView(
      status({ detail: 'Dynatrace: 3 tickets looked up (5 links: 3 read · 1 empty · 1 unconfigured tenant) — 2 with failed requests' }),
      NOW,
    )
    expect(v).toMatchObject({ tone: 'ok', color: HEALTH_COLOR.ok })
    expect(v.text).toBe('3 tickets looked up (5 links: 3 read · 1 empty · 1 unconfigured tenant) — 2 with failed requests · 14m ago')
  })

  it('Dynatrace not configured is quiet, an unreachable tenant is orange, a rejected token is red', () => {
    expect(lastFetchView(status({ state: 'not-configured', detail: 'Dynatrace not configured — set DYNATRACE_PAT and DYNATRACE_TENANTS' }), NOW)).toMatchObject({ tone: 'quiet', color: null })
    expect(lastFetchView(status({ state: 'unreachable', detail: 'Dynatrace could not be reached' }), NOW)).toMatchObject({ tone: 'attention', color: HEALTH_COLOR.attention })
    expect(lastFetchView(status({ state: 'auth-failed', detail: 'Dynatrace rejected the token' }), NOW)).toMatchObject({ tone: 'key', color: HEALTH_COLOR.key })
  })

  it('has nothing to say before the first run', () => {
    expect(lastFetchView(undefined, NOW)).toMatchObject({ tone: 'quiet', color: null, text: 'Not run yet' })
    expect(lastFetchView(null, NOW).color).toBeNull()
  })

  it('a read is green, without the source name repeated, and says how long ago', () => {
    const v = lastFetchView(status(), NOW)
    expect(v.tone).toBe('ok')
    expect(v.color).toBe(HEALTH_COLOR.ok)
    expect(v.text).toBe('3 vulnerability-fix tickets looked up (7 targets: 4 fixed · 2 open · 1 not found) — 2 with open findings · 14m ago')
  })

  it('not configured and nothing to look up are quiet — no red, no orange', () => {
    const nc = lastFetchView(status({ state: 'not-configured', detail: 'Checkmarx not configured — missing CHECKMARX_API_KEY' }), NOW)
    expect(nc).toMatchObject({ tone: 'quiet', color: null })
    expect(nc.text).toContain('missing CHECKMARX_API_KEY')
    expect(lastFetchView(status({ state: 'no-candidates', detail: 'Checkmarx: no vulnerability-fix ticket to look up' }), NOW)).toMatchObject({ tone: 'quiet', color: null })
  })

  it('failures are orange, a rejected key is red', () => {
    expect(lastFetchView(status({ state: 'unreachable' }), NOW)).toMatchObject({ tone: 'attention', color: HEALTH_COLOR.attention })
    expect(lastFetchView(status({ state: 'budget-exhausted' }), NOW)).toMatchObject({ tone: 'attention', color: HEALTH_COLOR.attention })
    expect(lastFetchView(status({ state: 'auth-failed' }), NOW)).toMatchObject({ tone: 'key', color: HEALTH_COLOR.key })
  })

  it('survives a record it does not understand', () => {
    expect(lastFetchView({ state: 'banana', detail: 5, at: 'x' } as never, NOW)).toMatchObject({ tone: 'quiet', color: null })
  })
})
