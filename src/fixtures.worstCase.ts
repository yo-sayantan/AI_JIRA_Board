import type { CompletedTicket, JiraData, RaisedTicket, Ticket } from './types'

// ─────────────────────────────────────────────────────────────────────────
// WORST-CASE DATA — `npm run dev` only, picked with ?data=worst|empty|one|huge
// (lib/devData.ts). Every value is something a real dump can hold: Jira's 255-
// character summary, a 10-letter project key with a 6-digit number, decimal
// story points, a branch name with no / or _ to wrap at, five Jenkins
// environments, a four-digit Completed count. Dates are relative to now so the
// relative-time, sprint and "archives in" labels hit their edges.
// ─────────────────────────────────────────────────────────────────────────

const DAY = 86_400_000
const JIRA = 'https://jira.example.com/browse/'
const BB = 'https://bitbucket.example.com/projects/PAY/repos'

const iso = (now: number, daysAgo: number) => new Date(now - daysAgo * DAY).toISOString()
/** Local calendar date, the form the intern writes into sprint strings. */
function ymd(now: number, daysAgo: number): string {
  const d = new Date(now - daysAgo * DAY)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const activeSprint = (now: number) => `PAYMENTS Q3 Hardening Sprint 14.2 (active · ${ymd(now, 13)} → ${ymd(now, 0)})`
const futureSprint = (now: number) => `PAYMENTS Q4 Platform Migration Sprint 15.1 (future · ${ymd(now, -3)} → ${ymd(now, -17)})`

function ticket(now: number, t: Partial<Ticket> & Pick<Ticket, 'key' | 'title' | 'status' | 'column'>): Ticket {
  return { url: JIRA + t.key, lastUpdate: iso(now, 2), sprint: activeSprint(now), ...t }
}

function worstTickets(now: number): Ticket[] {
  return [
    ticket(now, {
      key: 'PAYMENTSRV-104523',
      // 255 characters: Jira's summary limit.
      title:
        'Reconcile settlement batch totals against the general ledger for every merchant onboarded through the partner API before the quarterly audit, including refunds, chargebacks, partial captures and multi-currency adjustments posted after the cut-off windows.',
      status: 'To Do',
      column: 'todo',
      type: 'Story',
      priority: 'Highest',
      storyPoints: 13,
      lastUpdate: iso(now, 330),
      branch: 'feature/PAYMENTSRV-104523_reconcile_settlement_batch_totals_against_ledger_for_partner_api_merchants',
    }),
    ticket(now, {
      key: 'OPS-7',
      title: 'NullPointerException in com.example.payments.reconciliation.SettlementBatchProcessor.reconcileOutstandingLedgerEntries',
      status: 'In Progress',
      column: 'prog',
      type: 'Bug',
      priority: 'Blocker',
      storyPoints: 0.5,
      lastUpdate: new Date(now - 20_000).toISOString(),
      // Hyphens only: BranchName wraps at / and _, nowhere else.
      branch: 'bugfix/OPS-7-npe-in-settlement-batch-processor-reconcile-outstanding-ledger-entries-nightly',
    }),
    ticket(now, {
      key: 'AB-1',
      title: 'Fix',
      status: 'In Progress',
      column: 'prog',
      // No type, no priority, no last update, no branch: every optional field missing.
      type: null,
      priority: null,
      storyPoints: 1,
      lastUpdate: null,
      sprint: null,
    }),
    ticket(now, {
      key: 'PAYMENTSRV-104524',
      title: 'Remediate CVE-2021-44228, CVE-2022-22965, CVE-2023-34034 and CVE-2024-38816 in the payments gateway container image (STG + PROD)',
      status: 'Ready4Review',
      column: 'rev',
      type: 'Security',
      priority: 'High',
      storyPoints: 8,
      sprintOverflow: true,
      sprintCount: 4,
      branch: 'bugfix/PAYMENTSRV-104524-remediate-log4shell-spring4shell-gateway-image',
      pr: {
        state: 'comments',
        id: 10482,
        url: `${BB}/payments-gateway/pull-requests/10482`,
        approvals: 5,
        openComments: 14,
        sourceBranch: 'bugfix/PAYMENTSRV-104524-remediate-log4shell-spring4shell-gateway-image',
        destinationBranch: 'develop',
        repo: 'payments-gateway',
      },
      prs: [
        { state: 'comments', id: 10482, approvals: 5, sourceBranch: 'bugfix/PAYMENTSRV-104524-remediate-log4shell-spring4shell-gateway-image', repo: 'payments-gateway' },
        { state: 'approved', id: 311, approvals: 2, sourceBranch: 'bugfix/PAYMENTSRV-104524-pipeline-base-image', repo: 'payments-pipeline' },
        { state: 'merged', id: 87, approvals: 2, sourceBranch: 'bugfix/PAYMENTSRV-104524-helm-values', repo: 'payments-helm' },
        { state: 'declined', id: 86, approvals: 0, sourceBranch: 'bugfix/PAYMENTSRV-104524-helm-values-old', repo: 'payments-helm' },
      ],
      builds: [
        { env: 'dev', repo: 'payments-gateway', branch: 'bugfix/PAYMENTSRV-104524-remediate-log4shell-spring4shell-gateway-image', number: 10482, result: 'SUCCESS', at: iso(now, 0.2) },
        { env: 'qa', repo: 'payments-gateway', branch: 'bugfix/PAYMENTSRV-104524-remediate-log4shell-spring4shell-gateway-image', number: 9931, result: 'SUCCESS', at: iso(now, 0.3) },
        { env: 'stage', repo: 'payments-gateway', branch: 'bugfix/PAYMENTSRV-104524-remediate-log4shell-spring4shell-gateway-image', number: 4120, result: 'UNSTABLE', at: iso(now, 0.4) },
        { env: 'perf', repo: 'payments-gateway', branch: 'bugfix/PAYMENTSRV-104524-remediate-log4shell-spring4shell-gateway-image', number: 877, result: 'BUILDING', at: iso(now, 0.05) },
        { env: 'production', repo: 'payments-gateway', branch: 'bugfix/PAYMENTSRV-104524-remediate-log4shell-spring4shell-gateway-image', number: 12004, result: 'FAILURE', at: iso(now, 0.1) },
      ],
      vulnFixes: {
        scannedAt: iso(now, 0.1),
        project: 'payments-gateway',
        branch: 'bugfix/PAYMENTSRV-104524-remediate-log4shell-spring4shell-gateway-image',
        baseBranch: 'develop',
        items: [
          { target: 'CVE-2021-44228', kind: 'cve', status: 'fixed', severity: 'CRITICAL' },
          { target: 'CVE-2022-22965', kind: 'cve', status: 'fixed', severity: 'CRITICAL' },
          { target: 'CVE-2023-34034', kind: 'cve', status: 'open', severity: 'HIGH' },
          { target: 'CVE-2024-38816', kind: 'cve', status: 'unknown', severity: 'HIGH' },
        ],
      },
    }),
    ticket(now, {
      key: 'NOTIFY-88',
      title: '<script>alert(1)</script> &amp; **bold** rendered raw in the "Payment received" e-mail template',
      status: 'Ready4Review',
      column: 'rev',
      type: 'Bug',
      priority: 'Medium',
      storyPoints: null,
      pr: { state: 'approved', id: 2, approvals: 2, sourceBranch: 'bugfix/NOTIFY-88_escape_template', repo: 'notify' },
    }),
    ticket(now, {
      key: 'LOC-2210',
      title: 'QA: Cập nhật bản dịch tiếng Việt — Thông báo “Đã gửi thành công” bị cắt dấu ở màn hình xác nhận',
      status: 'Ready for QA',
      column: 'qa',
      type: 'Test',
      priority: 'Low',
      storyPoints: 2,
      lastUpdate: iso(now, 12),
    }),
    ticket(now, {
      key: 'INC-40417',
      title: '🚨 PROD down: card authorisations failing in the DE region after the Benachrichtigungseinstellungen rollout',
      status: 'Blocked',
      column: 'blocked',
      type: 'Incident',
      priority: 'Highest',
      storyPoints: 3,
      lastUpdate: iso(now, 0.04),
    }),
    ticket(now, {
      key: 'MERCH-5021',
      title: 'Benachrichtigungseinstellungen und Datenschutzeinstellungen für Händlerkonten überarbeiten',
      status: 'On Hold',
      column: 'hold',
      type: 'Task',
      priority: 'Lowest',
      storyPoints: 5,
      lastUpdate: iso(now, 45),
    }),
    ticket(now, {
      key: 'PAYMENTSRV-103999',
      title: 'Rotate the partner API signing keys in every region and retire the 2019 key pair from the HSM',
      status: 'Done',
      column: 'done',
      type: 'Task',
      priority: 'High',
      storyPoints: 3,
      resolved: iso(now, 4.2),
      lastUpdate: iso(now, 4.2),
      pr: { state: 'merged', id: 10301, approvals: 2, merged: true, sourceBranch: 'feature/PAYMENTSRV-103999_rotate_partner_signing_keys', repo: 'payments-gateway' },
    }),
    ticket(now, {
      key: 'PAYMENTSRV-104530',
      title: 'Write the reconciliation report exporter (CSV + XLSX) with per-merchant subtotals and currency rounding rules',
      status: 'In Progress',
      column: 'prog',
      type: 'Sub-task',
      priority: 'High',
      parentKey: 'PAYMENTSRV-104523',
      parentTitle:
        'Reconcile settlement batch totals against the general ledger for every merchant onboarded through the partner API before the quarterly audit',
      branch: 'feature/PAYMENTSRV-104530_reconciliation_report_exporter_csv_xlsx',
    }),
    ticket(now, {
      key: 'PAYMENTSRV-104600',
      title: 'Migrate the settlement scheduler from Quartz to the platform job runner',
      status: 'To Do',
      column: 'todo',
      type: 'Story',
      priority: 'Medium',
      storyPoints: 21,
      sprint: futureSprint(now),
    }),
    ticket(now, { key: 'PAYMENTSRV-104601', title: 'Update dependencies', status: 'To Do', column: 'todo', type: 'Task', priority: 'Low', storyPoints: 1 }),
    ticket(now, { key: 'PAYMENTSRV-104602', title: 'Update dependencies', status: 'To Do', column: 'todo', type: 'Task', priority: 'Low', storyPoints: 1 }),
  ]
}

function completedRows(now: number, n: number): CompletedTicket[] {
  return Array.from({ length: n }, (_, i) => ({
    key: `PAYMENTSRV-${100000 + i}`,
    title: `Archived ticket ${i + 1}`,
    status: 'Done',
    project: 'PAYMENTSRV',
    resolved: iso(now, 7 + i),
    mine: true,
  }))
}

function takenRow(now: number): CompletedTicket {
  return {
    key: 'PAYMENTSRV-099001',
    title: 'Investigate duplicate webhook deliveries',
    status: 'In Progress',
    project: 'PAYMENTSRV',
    resolved: null,
    mine: true,
    takenFromMe: { reason: 'reassigned', reasons: ['reassigned'], when: iso(now, 3), by: 'Fitzgerald, Bartholomew', to: 'Ó Súilleabháin, Seán', worked: true, workedOn: ['PR #61 — declined'] },
  }
}

function raisedRows(now: number, total: number, open: number): RaisedTicket[] {
  return Array.from({ length: total }, (_, i) => ({
    key: `PAYMENTSRV-${90000 + i}`,
    title: `Raised ticket ${i + 1}`,
    status: i < open ? 'To Do' : 'Done',
    column: i < open ? 'todo' : 'done',
    done: i >= open,
    created: iso(now, 10 + i),
  }))
}

const WORST_USER = { name: 'Wiśniewska-Kowalczyk, Aleksandra', accountId: 'DEV002', jiraBase: 'https://jira.example.com' }

/** Every rendered field at its realistic worst, spread across the first rows of each lane. */
export function worstCaseDump(now: number): JiraData {
  return {
    generatedAt: iso(now, 3),
    user: WORST_USER,
    tickets: worstTickets(now),
    completed: [...completedRows(now, 1284), takenRow(now)],
    raised: raisedRows(now, 312, 47),
    raisedAt: iso(now, 3),
    notes: [],
  }
}

/** A finished intern run that found nothing assigned. */
export function emptyDump(now: number): JiraData {
  return { generatedAt: iso(now, 0.01), user: WORST_USER, tickets: [], completed: [], raised: [], notes: [] }
}

/** One of everything, so every count reads 1 (pluralisation). */
export function oneDump(now: number): JiraData {
  return {
    generatedAt: iso(now, 0.01),
    // No "Last, First" comma: the header must fall back to the whole name.
    user: { name: 'Jo', accountId: 'DEV003', jiraBase: 'https://jira.example.com' },
    tickets: [ticket(now, { key: 'AB-2', title: 'Ship it', status: 'In Progress', column: 'prog', type: 'Story', priority: 'Medium', storyPoints: 1, lastUpdate: iso(now, 1) })],
    completed: [...completedRows(now, 1), takenRow(now)],
    raised: raisedRows(now, 1, 1),
    notes: [],
  }
}

const COLS: Ticket['column'][] = ['todo', 'prog', 'prog', 'rev', 'qa', 'blocked', 'hold', 'done']
const STATUS: Record<Ticket['column'], string> = { todo: 'To Do', prog: 'In Progress', rev: 'Ready4Review', qa: 'Ready for QA', blocked: 'Blocked', hold: 'On Hold', done: 'Done' }

/** An unpaginated board at the size a support rota or a team lead's "assigned to me" really reaches. */
export function hugeDump(now: number, n = 400): JiraData {
  const base = worstTickets(now)
  const tickets = Array.from({ length: n }, (_, i) => {
    const column = COLS[i % COLS.length]
    const src = base[i % base.length]
    return {
      ...src,
      key: `PAYMENTSRV-${200000 + i}`,
      url: `${JIRA}PAYMENTSRV-${200000 + i}`,
      column,
      status: STATUS[column],
      parentKey: null,
      resolved: column === 'done' ? iso(now, 1) : null,
      type: column === 'qa' ? 'Test' : src.type,
      title: column === 'qa' ? `QA: ${src.title}` : src.title,
    }
  })
  return { ...worstCaseDump(now), tickets }
}
