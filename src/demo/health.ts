// Demo mode's API-key health: a constant sample for the keys dialog's dots, so the colours can be
// shown without the user's real services being asked (or revealed): a few green, one orange, one
// red, the rest never called.
import type { HealthMap } from '../lib/apiKeys'

const MIN = 60_000

let sample: { base: number; map: HealthMap } | null = null

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

/** The sample, fixed for the session (timestamps are relative to the first call, so they do not creep). */
export function demoKeyHealth(now: number = Date.now()): HealthMap {
  if (sample) return sample.map
  const ok = (service: string, minutesAgo: number) => ({
    service,
    state: 'ok' as const,
    checkedAt: iso(now - minutesAgo * MIN),
    lastOkAt: iso(now - minutesAgo * MIN),
    detail: '',
    source: 'fetch' as const,
  })
  const map: HealthMap = {
    jira: ok('jira', 4),
    bitbucket: ok('bitbucket', 4),
    claude: { ...ok('claude', 35), source: 'worker' },
    dynatrace: ok('dynatrace', 7),
    jenkins: {
      service: 'jenkins',
      state: 'attention',
      checkedAt: iso(now - 9 * MIN),
      lastOkAt: iso(now - 26 * 60 * MIN),
      failingSince: iso(now - 3 * 60 * MIN),
      status: 'unreachable',
      detail: "Can't reach the host",
      source: 'fetch',
    },
    checkmarx: {
      service: 'checkmarx',
      state: 'attention',
      checkedAt: iso(now - 12 * MIN),
      failingSince: iso(now - 12 * MIN),
      status: 'auth-failed',
      httpStatus: 400,
      detail: 'Key rejected',
      source: 'fetch',
    },
  }
  sample = { base: now, map }
  return map
}
