// ─────────────────────────────────────────────────────────────────────────
// THE CONTRACT.
// This file is the single source of truth for the shape of the data that
// `jira-intern` dumps into  jira-intern/data.json  (+ data.js).
// intern-prompt.md documents the exact same schema in prose — keep them in sync.
// ─────────────────────────────────────────────────────────────────────────

/** Board columns. The intern maps every raw Jira status onto one of these. */
export type ColumnKey = 'todo' | 'blocked' | 'prog' | 'rev' | 'qa' | 'done' | 'hold'

export type PrState = 'approved' | 'comments' | 'changes' | 'merged' | 'declined' | 'none'

export interface PullRequest {
  state: PrState
  url?: string | null
  id?: string | number | null
  title?: string | null
  approvals?: number | null
  /** Unresolved (open) review comments. A mergeable PR has 0 of these. */
  openComments?: number | null
  /** Total review comments ever added on the PR. */
  commentsTotal?: number | null
  /** How many of those comments are resolved. */
  commentsResolved?: number | null
  reviewers?: string[]
  sourceBranch?: string | null
  destinationBranch?: string | null
  /**
   * Repository the review happened in. Dev info comes from Jira's dev-status index, so one
   * ticket's PRs can span several repos (app, pipeline, infra) — the number alone is ambiguous.
   */
  repo?: string | null
  author?: string | null
  merged?: boolean
  mergedAt?: string | null
  updatedAt?: string | null
}

/** Result of a Jenkins build; BUILDING while it is still running (Jenkins reports no result yet). */
export type BuildResult = 'SUCCESS' | 'FAILURE' | 'UNSTABLE' | 'ABORTED' | 'NOT_BUILT' | 'BUILDING'

/** JUnit totals of a build (Jenkins' test result action). */
export interface BuildTests {
  total: number
  failed: number
  skipped: number
  /** Up to 5 failing tests as "className.name" — only read for a build with failures. */
  failing?: string[]
}

/**
 * The LATEST build of one of the ticket's branches in one environment's Jenkins multibranch job
 * (config → jenkins.jobs.<repo>.<env>). Written only by jira-intern/jenkins.py via daily_fetch.py:
 * refreshed on every daily run (builds never bump Jira's `updated`) and by the single-ticket refresh;
 * carried forward unchanged when Jenkins cannot be reached. A sub-task never carries builds of its
 * parent's branch (same scoping as its PRs).
 */
export interface JenkinsBuild {
  /** Environment name as configured (free-form: qa, uat, …). */
  env: string
  /** Repository slug — the key under jenkins.jobs. */
  repo: string
  branch: string
  number: number
  result: BuildResult
  /** The build page in Jenkins. */
  url?: string | null
  /** When the build started (ISO, UTC). */
  at?: string | null
  /** Run time; null while building. */
  durationMs?: number | null
  tests?: BuildTests | null
  /** First pipeline stage that FAILED / went UNSTABLE (failed and unstable builds only). */
  failedStage?: string | null
  /** Where it deployed: an ENV / ENVIRONMENT / TARGET / DEPLOY_ENV build parameter, else `env`. */
  deployTarget?: string | null
  /** True when Jenkins could not be re-read and this is the previous run's build, carried forward — not current proof. */
  stale?: boolean
}

/** What a vulnerability-fix ticket names as fixed: a CVE id, a SAST query name or CWE id, a Checkmarx result / similarity id, or a package version. */
export type VulnFixKind = 'cve' | 'sast' | 'result' | 'package'

/**
 * Decided by comparing the latest completed Checkmarx One scan of the PR's source branch with the latest one of
 * its base branch: `fixed` = in the base scan and not open on the branch (gone, status FIXED, or triaged Not
 * exploitable — the detail says which); `open` = still detected on the branch; `not-found` = in neither scan;
 * `unknown` = the branch is not scanned yet, the base has no scan to compare, no project matches the repo, or a
 * scan has more results than the board reads.
 */
export type VulnFixStatus = 'fixed' | 'open' | 'not-found' | 'unknown'

export interface VulnFixItem {
  /** As named on the ticket: "CVE-2021-44228", "SQL_Injection", "CWE-89", "result abc123", "log4j-core 2.14.1 → 2.17.1". */
  target: string
  kind: VulnFixKind
  status: VulnFixStatus
  /** CRITICAL / HIGH / MEDIUM / LOW / INFO — from the base scan when it was there, else the branch. */
  severity?: string | null
  /** Where: "file:line" for SAST, "package version" for SCA. */
  location?: string | null
  /** One line of evidence: "Fixed — gone on feature/x (scan 2026-10-09) · was HIGH on develop (scan 2026-10-01)." */
  detail?: string | null
}

/**
 * Which vulnerabilities a vulnerability-fix ticket fixed — only the targets the ticket itself names, never the
 * scan's other findings. Written only by jira-intern/checkmarx.py via daily_fetch.py (full fetch, fast path,
 * single-ticket refresh), only for vulnerability-fix tickets with a pull request; carried forward unchanged when
 * Checkmarx cannot be read; kept by the archive. A sub-task only gets its own PR's scan.
 */
export interface VulnFixes {
  /** When the board asked Checkmarx (ISO, UTC). */
  scannedAt: string
  /** The Checkmarx project (matched by the PR's repository slug). */
  project: string
  /** The PR's source branch. */
  branch: string
  /** What it is compared with: the PR's destination, else the project's main branch, else main/master/develop. */
  baseBranch?: string | null
  /** createdAt of the scans compared; null when that branch has no completed scan. */
  branchScanAt?: string | null
  baseScanAt?: string | null
  /** Why nothing could be decided (no project, branch not scanned yet). */
  note?: string | null
  items: VulnFixItem[]
}

export interface Comment {
  author?: string | null
  when?: string | null
  body?: string | null // light HTML allowed
}

export interface LinkRef {
  key?: string | null
  url?: string | null
  title?: string | null
  summary?: string | null
  excerpt?: string | null
  status?: string | null
  relation?: string | null // epic / parent / blocks / relates to ...
  reachable?: boolean | null
}

export interface UpdateLogEntry {
  when?: string | null
  text?: string | null
}

/** A fully-briefed, actively-tracked ticket (rich detail). */
export interface Ticket {
  key: string
  title: string
  /** Raw Jira status text, e.g. "Ready4Review". */
  status: string
  /** Mapped board column. The intern decides this; the app trusts it. */
  column: ColumnKey
  type?: string | null
  priority?: string | null
  storyPoints?: number | null
  /** Primary REAL branch (from Bitbucket), not a predicted name. */
  branch?: string | null
  /** All real branches associated with the ticket (a ticket may have several). */
  branches?: string[]
  estDays?: string | null
  /** Primary pull request (for the at-a-glance badge). */
  pr?: PullRequest | null
  /** All pull requests for the ticket (merged / declined / open …). */
  prs?: PullRequest[]
  comments?: Comment[]
  commentCount?: number | null
  latestComment?: string | null
  lastUpdate?: string | null
  created?: string | null
  done?: boolean
  onHold?: boolean
  /**
   * Board-only, never written by the intern: set by an optimistic drag-and-drop so the card sits in (true) or
   * leaves (false) the Next Sprint space before Jira's new sprint comes back. Undefined = decided by `sprint`.
   */
  queued?: boolean
  /** Resolution / close date (mainly for completed tickets). */
  resolved?: string | null
  /** Parent issue key, if this ticket is itself a sub-task. */
  parentKey?: string | null
  /** The parent ticket's summary, for lineage chips/tooltips. */
  parentTitle?: string | null
  /**
   * False for a team-mate's sub-task pulled in because it hangs off a master ticket I worked
   * on. Those rows give a master ticket its full delivery picture without being counted as
   * my own output.
   */
  mine?: boolean
  /** Child sub-tasks — each a full ticket, openable as its own detail page. */
  subtasks?: Ticket[]
  subtaskCount?: number | null
  url?: string | null
  sprint?: string | null
  /** True when Jira lists more than one distinct sprint — the ticket carried over. */
  sprintOverflow?: boolean
  /** Distinct sprint names seen on the issue (1 = never carried). */
  sprintCount?: number
  reporter?: string | null
  assignee?: string | null
  epic?: LinkRef | null
  labels?: string[]
  components?: string[]
  fixVersions?: string[]
  /** HTML allowed. */
  description?: string | null
  /**
   * AI-generated briefing (active tickets only; written by the summarize-active pass).
   * To Do / In-Progress tickets get a DEEP brief in light HTML — enriched from linked Confluence
   * docs, related tickets, Bitbucket PRs/diffs, attachments and external links.
   * In-Review / QA tickets and sub-tasks get a short plain-text summary. Rendered via SafeHtml.
   */
  aiSummary?: string | null
  /** When aiSummary was generated (ISO) — the pass regenerates a brief once lastUpdate outruns it. */
  aiSummaryAt?: string | null
  acceptanceCriteria?: string[]
  related?: LinkRef[]
  confluence?: LinkRef[]
  externalLinks?: LinkRef[]
  /** HTML allowed. */
  proposedSolution?: string | null
  /** HTML allowed. */
  effortEstimate?: string | null
  openQuestions?: string[]
  sources?: LinkRef[]
  updateLog?: UpdateLogEntry[]
  /**
   * Latest Jenkins build per (environment, branch) — see JenkinsBuild. Absent when Jenkins is not
   * configured or no branch of the ticket has a build; every view must cope without it.
   */
  builds?: JenkinsBuild[]
  /**
   * Vulnerability-fix tickets only: what Checkmarx One says about each vulnerability the ticket names — see
   * VulnFixes. Absent for every other ticket and when Checkmarx is not configured; every view must cope without it.
   */
  vulnFixes?: VulnFixes | null
}

/**
 * A row in the full historical "Completed" archive.
 * The base fields (key/title/status) drive the compact list; the rest power the
 * per-row inline "peek" (opened/closed/branch/PR) and, on click, the full detail
 * page. Old tickets may only have the lighter fields — the UI degrades cleanly.
 */
export interface CompletedTicket {
  key: string
  title: string
  type?: string | null
  priority?: string | null
  /** Project key prefix, e.g. "PROJ". Derived from key if absent. */
  project?: string | null
  status?: string | null // current status: Done / Closed / Resolved
  /** Set when this row is a sub-task archived standalone (its parent may belong to someone else). */
  parentKey?: string | null
  /** The parent ticket's summary, for lineage chips/tooltips. */
  parentTitle?: string | null
  /** False for team-mates' work archived alongside mine — see Ticket.mine. */
  mine?: boolean
  /** When it was opened. */
  created?: string | null
  /** When it was closed / resolved (ISO). */
  resolved?: string | null
  storyPoints?: number | null
  branch?: string | null
  branches?: string[]
  pr?: PullRequest | null
  prs?: PullRequest[]
  url?: string | null
  /** How many sub-tasks this parent spawned (shown in the archive peek). */
  subtaskCount?: number | null
  /** The parent's sub-tasks, openable from its detail page. */
  subtasks?: Ticket[]
  // ── optional richer detail for the full detail page (may be sparse) ──
  lastUpdate?: string | null
  sprint?: string | null
  /** True when Jira lists more than one distinct sprint — the ticket carried over. */
  sprintOverflow?: boolean
  sprintCount?: number
  reporter?: string | null
  assignee?: string | null
  epic?: LinkRef | null
  labels?: string[]
  components?: string[]
  fixVersions?: string[]
  description?: string | null
  acceptanceCriteria?: string[]
  comments?: Comment[]
  commentCount?: number | null
  related?: LinkRef[]
  confluence?: LinkRef[]
  externalLinks?: LinkRef[]
  proposedSolution?: string | null
  effortEstimate?: string | null
  openQuestions?: string[]
  sources?: LinkRef[]
  updateLog?: UpdateLogEntry[]
  /** Kept from the board copy when the ticket was archived (the archive never asks Checkmarx) — see VulnFixes. */
  vulnFixes?: VulnFixes | null
}

/** One assignee hand-off from the Jira changelog. The first assignment has from=null. */
export interface AssigneeHop {
  when?: string | null
  from?: string | null
  to?: string | null
}

/**
 * A ticket I RAISED (reporter = me), whoever works it now. Sub-tasks are excluded at the
 * source — a sub-ticket cut under my own work is mine by default, not "raised" work.
 * Deliberately compact (no code/PR data): these rows answer "what's its status, and who
 * holds it now?", and refresh with every daily run.
 */
export interface RaisedTicket {
  key: string
  title: string
  status?: string | null
  /** Mapped board column, for status colour-coding. The intern sets this. */
  column?: ColumnKey
  type?: string | null
  priority?: string | null
  /** Project key prefix, e.g. "FIDM". Derived from key if absent. */
  project?: string | null
  storyPoints?: number | null
  created?: string | null
  lastUpdate?: string | null
  resolved?: string | null
  done?: boolean
  url?: string | null
  reporter?: string | null
  /** CURRENT assignee (null = nobody picked it up yet). */
  assignee?: string | null
  labels?: string[]
  components?: string[]
  fixVersions?: string[]
  sprint?: string | null
  sprintOverflow?: boolean
  sprintCount?: number
  /** HTML allowed. */
  description?: string | null
  /** Which tickets this was raised from / blocks / duplicates (Jira issue links). */
  related?: LinkRef[]
  /** Epic (or parent) lineage, when Jira has one. */
  epic?: LinkRef | null
  /** Chronological assignee hand-offs — the "has it been reassigned?" trail. */
  assigneeLog?: AssigneeHop[]
  updateLog?: UpdateLogEntry[]
  /** AI brief (written by the summarize pass; carried across raised refreshes). HTML. */
  aiSummary?: string | null
  aiSummaryAt?: string | null
}

/** Adapt a raised row to the rich Ticket shape so the detail drawer can render it. */
export function raisedToTicket(r: RaisedTicket): Ticket {
  const column = r.column ?? 'todo'
  return {
    ...r,
    column,
    status: r.status ?? 'Open',
    done: r.done ?? column === 'done',
    onHold: column === 'hold',
  }
}

/** Adapt an archive row to the rich Ticket shape so the detail view can render it. */
export function completedToTicket(c: CompletedTicket): Ticket {
  return {
    ...c,
    column: 'done',
    status: c.status ?? 'Done',
    done: true,
    onHold: false,
    lastUpdate: c.lastUpdate ?? c.resolved ?? null,
  }
}

export interface JiraData {
  generatedAt?: string | null
  user?: {
    name?: string | null
    accountId?: string | null
    jiraBase?: string | null
  } | null
  /** Actively tracked tickets (rich). Includes recently-done ones (column "done"). */
  tickets: Ticket[]
  /** Every Done ticket ever assigned to me (compact, full history). */
  completed: CompletedTicket[]
  /** Every non-sub-task ticket I ever REPORTED (compact) — the "Raised by me" view. */
  raised?: RaisedTicket[]
  /** When raised[] was last re-fetched (its freshness is independent of generatedAt). */
  raisedAt?: string | null
  /** Optional run notices (e.g. "Jira MCP unavailable"). */
  notes?: string[]
}
