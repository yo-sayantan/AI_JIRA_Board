// Two canned PR Readiness Reports for Demo mode — one that ships, one that does not — so the
// report overlay, its tabs, every block kind and both verdict tones can be seen without the AI
// intern ever running. Shapes follow `src/lib/reportTypes.ts`.
import { summarizeReport, type PrReport, type PrReportSummary } from '../lib/reportTypes'

const JIRA = 'https://jira.example.com'
const BB = 'https://bitbucket.example.com'
const CONF = 'https://confluence.example.com'

function build(now: number): PrReport[] {
  const HOUR = 3_600_000
  const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const ago = (hours: number) => iso(now - hours * HOUR)

  const ready: PrReport = {
    schemaVersion: 1,
    key: 'DEMO-230',
    title: 'Signed download links for exported files',
    timeZone: 'UTC',
    generatedAt: ago(2),
    fingerprint: 'demo-ready-1',
    enriched: true,
    enrichedAt: ago(2),
    generator: 'demo · sample report',
    verdict: {
      id: 'ready',
      label: 'Ready to merge',
      tone: 'success',
      headline: 'Two approvals, no open comments, and every release gate passes.',
      summary: 'The only thing left is the merge itself — QA has already signed off on the linked sub-task.',
      score: 92,
      provenance: 'ai',
      reason: 'PR #425 has 2/2 approvals and 0 unresolved comments; the QA sub-task is Done; no dependencies are open.',
      next: { owner: 'Demo User', action: 'merge PR #425', due: null },
    },
    stats: [
      { label: 'Approvals', value: '2 / 2', tone: 'success' },
      { label: 'Open comments', value: '0', tone: 'success' },
      { label: 'Files changed', value: '14' },
      { label: 'Lines', value: '+486 / −112' },
      { label: 'Age', value: '2 days', hint: 'Since the PR was raised' },
    ],
    tabs: [
      {
        id: 'verdict',
        title: 'Verdict',
        tone: 'success',
        summary: 'Everything the decision rests on.',
        blocks: [
          { kind: 'callout', tone: 'success', title: 'Safe to merge', body: 'Signed links expire in 15 minutes and are scoped to the requesting user, which is what the linked standard asks for. Nothing in the diff touches the unauthenticated path.' },
          {
            kind: 'kv',
            title: 'At a glance',
            items: [
              { label: 'Pull request', value: '#425 · approved', tone: 'success', href: `${BB}/projects/DEMO/repos/demo-service/pull-requests/425` },
              { label: 'Target branch', value: 'main' },
              { label: 'QA sub-task', value: 'DEMO-230-1 · Done', tone: 'success' },
              { label: 'Release', value: '2026.11' },
            ],
          },
        ],
      },
      {
        id: 'gates',
        title: 'Release gates',
        tone: 'success',
        badge: '6 / 6',
        blocks: [
          {
            kind: 'table',
            title: 'Every gate and its evidence',
            headers: ['Gate', 'Result', 'Evidence', 'Blocking'],
            rows: [
              { cells: ['Approvals (2 required)', 'Pass', 'r.okafor, m.lindqvist', 'Yes'], tone: 'success' },
              { cells: ['Unresolved comments', 'Pass', '0 of 7 still open', 'Yes'], tone: 'success' },
              { cells: ['QA / test sub-task done', 'Pass', 'DEMO-230-1 (Done, Rahul Okafor)', 'Yes'], tone: 'success' },
              { cells: ['Other sub-tasks & dependencies', 'Pass', 'none open', 'Yes'], tone: 'success' },
              { cells: ['Security scan', 'Pass', 'no new findings', 'Yes'], tone: 'success' },
              { cells: ['Changelog entry', 'Pass', 'added in the PR', 'No'], tone: 'success' },
            ],
          },
        ],
      },
      {
        id: 'changes',
        title: 'What changed',
        tone: 'info',
        badge: 14,
        blocks: [
          {
            kind: 'cards',
            title: 'The files that matter',
            items: [
              { title: 'signing/links.ts', badge: 'new', badgeTone: 'violet', body: 'HMAC-SHA256 over path + user id + expiry, with a 15-minute default taken from config.', detail: '+180 / −0' },
              { title: 'api/exports.ts', badge: 'changed', badgeTone: 'info', body: 'Download route now issues a signed link instead of returning a static path.', detail: '+64 / −41' },
              { title: 'api/exports.test.ts', badge: 'tests', badgeTone: 'success', body: 'Covers expiry, cross-user reuse and the 403 path.', detail: '+152 / −8' },
            ],
          },
          { kind: 'list', title: 'Review notes', items: [{ text: 'Expiry is read from config, so the 15-minute default can be tightened without a deploy.', tone: 'info' }, { text: 'The old unauthenticated route is deleted in the same commit — no dual path is left behind.', tone: 'success' }] },
        ],
      },
      {
        id: 'timeline',
        title: 'Timeline',
        tone: 'neutral',
        blocks: [
          {
            kind: 'timeline',
            items: [
              { when: ago(2), label: 'Second approval', detail: 'm.lindqvist approved', tone: 'success' },
              { when: ago(20), label: 'All comments resolved', detail: '7 of 7', tone: 'success' },
              { when: ago(44), label: 'Pull request raised', detail: '#425 → main' },
              { when: ago(96), label: 'Ticket moved to In Progress' },
            ],
          },
        ],
      },
    ],
    links: [
      { label: 'DEMO-230 in Jira', href: `${JIRA}/browse/DEMO-230` },
      { label: 'Pull request #425', href: `${BB}/projects/DEMO/repos/demo-service/pull-requests/425` },
      { label: 'Link signing standard', href: `${CONF}/x/link-signing` },
    ],
    sources: 'Sample data — no system was consulted.',
    warnings: ['This is a demo report. Every number in it is invented.'],
  }

  const atRisk: PrReport = {
    schemaVersion: 1,
    key: 'DEMO-210',
    title: 'Nightly export job times out on the largest tenant',
    timeZone: 'UTC',
    generatedAt: ago(5),
    fingerprint: 'demo-risk-1',
    enriched: true,
    enrichedAt: ago(5),
    generator: 'demo · sample report',
    verdict: {
      id: 'blocked',
      label: 'Not ready',
      tone: 'danger',
      headline: 'Changes are requested on the only PR, and the ticket is blocked on a capacity answer.',
      summary: 'Even with the review cleared, the fix cannot be judged until the platform team supplies the per-node numbers.',
      score: 24,
      provenance: 'ai',
      reason: 'PR #412 has 0 approvals and 5 unresolved comments; the ticket has been Blocked for 3 days; no QA sub-task exists.',
      next: { owner: 'Priya Raman', action: 'chase the capacity figures, then re-request review', due: null },
    },
    stats: [
      { label: 'Approvals', value: '0 / 2', tone: 'danger' },
      { label: 'Open comments', value: '5', tone: 'danger' },
      { label: 'Blocked for', value: '3 days', tone: 'warning' },
      { label: 'Files changed', value: '7' },
      { label: 'QA ticket', value: 'none', tone: 'warning' },
    ],
    tabs: [
      {
        id: 'verdict',
        title: 'Verdict',
        tone: 'danger',
        summary: 'Two separate things are in the way.',
        blocks: [
          { kind: 'callout', tone: 'danger', title: 'Blocked, and under review', body: 'The serialiser change is sound, but the reviewer has asked for a cap on the retry backoff. Separately, the ticket is waiting on capacity numbers before the approach (shard vs. longer budget) can be settled.' },
          {
            kind: 'callout',
            tone: 'warning',
            title: 'Issue insight',
            provenance: 'derived',
            body: '<p>The Dynatrace trace linked from the ticket has <b>6 failed spans out of 38</b>, and the failure originates in <code>object-storage-gateway: PUT /exports/{id}</code> (HTTP 504 ×4 · 500 ×2, <i>SocketTimeoutException: Read timed out</i> ×4, slowest span 30.0 s). The linked Davis problem P-24100731 (response time degradation) is CLOSED.</p><p>The timeouts sit in the storage call, not in the serialiser this PR changes — worth settling together with the capacity numbers before choosing between sharding and a longer budget.</p>',
            note: 'From the 2 Dynatrace links in the ticket · read-only',
          },
          { kind: 'list', title: 'What has to happen', ordered: true, items: [{ text: 'Get the per-node capacity figures from the platform team.', tone: 'warning' }, { text: 'Cap the retry backoff as the reviewer asked.', tone: 'danger' }, { text: 'Raise a QA sub-task — closure will need one.', tone: 'warning' }] },
        ],
      },
      {
        id: 'gates',
        title: 'Release gates',
        tone: 'danger',
        badge: '2 / 6',
        blocks: [
          {
            kind: 'table',
            title: 'Every gate and its evidence',
            headers: ['Gate', 'Result', 'Evidence', 'Blocking'],
            rows: [
              { cells: ['Approvals (2 required)', 'Fail', '0 approvals; changes requested by r.okafor', 'Yes'], tone: 'danger' },
              { cells: ['Unresolved comments', 'Fail', '5 of 9 still open', 'Yes'], tone: 'danger' },
              { cells: ['QA / test sub-task done', 'Not verified', 'no QA sub-task on the ticket', 'Yes'], tone: 'warning' },
              { cells: ['Other sub-tasks & dependencies', 'Pass', 'none open', 'Yes'], tone: 'success' },
              { cells: ['Security scan', 'Pass', 'no new findings', 'Yes'], tone: 'success' },
              { cells: ['Changelog entry', 'Fail', 'missing', 'No'], tone: 'warning' },
            ],
          },
        ],
      },
      {
        id: 'risk',
        title: 'Risk',
        tone: 'warning',
        blocks: [
          {
            kind: 'cards',
            items: [
              { title: 'Unbounded backoff', badge: 'high', badgeTone: 'danger', body: 'The third retry can exceed the job budget, turning one slow run into a failed night.', detail: 'worker/retry.ts' },
              { title: 'Serialiser rewrite', badge: 'medium', badgeTone: 'warning', body: '70% of the job’s time is here, so the change is on the hot path with no benchmark in the PR.', detail: 'export/serialise.ts' },
            ],
          },
          { kind: 'links', title: 'Where this was discussed', items: [{ label: 'Capacity thread (Confluence)', href: `${CONF}/x/capacity-thread` }, { label: 'Pull request #412', href: `${BB}/projects/DEMO/repos/demo-service/pull-requests/412` }] },
        ],
      },
    ],
    links: [
      { label: 'DEMO-210 in Jira', href: `${JIRA}/browse/DEMO-210` },
      { label: 'Pull request #412', href: `${BB}/projects/DEMO/repos/demo-service/pull-requests/412` },
    ],
    sources: 'Sample data — no system was consulted.',
    warnings: ['This is a demo report. Every number in it is invented.', 'Capacity figures were unavailable, so the sharding option is not costed.'],
  }

  return [ready, atRisk]
}

let cache: { reports: Record<string, PrReport>; summaries: Record<string, PrReportSummary> } | null = null

/** The demo reports, keyed by ticket. Built once per session. */
export function demoReports(): { reports: Record<string, PrReport>; summaries: Record<string, PrReportSummary> } {
  if (!cache) {
    const list = build(Date.now())
    cache = {
      reports: Object.fromEntries(list.map((r) => [r.key, r])),
      summaries: Object.fromEntries(list.map((r) => [r.key, summarizeReport(r)])),
    }
  }
  return cache
}
