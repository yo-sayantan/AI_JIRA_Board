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

/** What a Jenkins pipeline does: build the code, deploy it, or both (a build pipeline with a deploy stage). */
export type PipelineKind = 'build' | 'deploy' | 'both'

/**
 * The LATEST build of one of the ticket's branches in one Jenkins pipeline of one environment —
 * a multibranch job named in config → jenkins.jobs.<repo>.<env>, or a pipeline found by discovery
 * under the Jenkins root (then `pipeline`, `kind` and `via` say which). Written only by jira-intern/jenkins.py via daily_fetch.py:
 * refreshed on every daily run (builds never bump Jira's `updated`) and by the single-ticket refresh;
 * carried forward unchanged when Jenkins cannot be reached. A sub-task never carries builds of its
 * parent's branch (same scoping as its PRs).
 */
export interface JenkinsBuild {
  /** Environment name: as configured in jenkins.jobs, or labelled by discovery from folder / pipeline names (free-form: qa, stage, …). */
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
  /** Discovered builds only: the pipeline's name. An environment can have several (a build and a deploy pipeline). */
  pipeline?: string | null
  /** Discovered builds only: whether that pipeline builds, deploys, or both. */
  kind?: PipelineKind | null
  /**
   * Discovered builds only: how the branch was found — `branch-job` (a multibranch pipeline's child job for the
   * branch) or `parameter` (a plain job: the newest build whose branch build-parameter names the branch).
   */
  via?: 'branch-job' | 'parameter' | null
  /**
   * The last ~40 lines (at most 4 KB) of the console of a FAILED / UNSTABLE build, scrubbed of tokens, passwords,
   * credentials in URLs, e-mail addresses and IPs. Only the latest failed build of a ticket about a build /
   * pipeline failure carries one (jenkins.console_tail); kept while the build number is unchanged, dropped with the build.
   * An empty string means "tried — there is nothing to excerpt" (no such log, or one too long to find the end of): it is
   * kept so the next run does not read that log again, and no view shows it.
   */
  consoleTail?: string | null
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
  /**
   * Package targets only: the versions of the package that carry a finding in the base / branch scan, oldest first
   * ("already at 6.5.9 on the base" tells a fix that predates the base scan from one that is missing). Absent for
   * other kinds and for a side that was not read.
   */
  foundOnBase?: string[]
  foundOnBranch?: string[]
}

/** What was read from the scan(s) one side of a comparison used — so "not found" can be told from "nothing was read". */
export interface VulnScanRead {
  /** Result rows read, and by engine: SCA (type sca…), SAST, anything else (kics, containers, …). */
  total: number
  sca: number
  sast: number
  other: number
  /** True when the page limit was hit with results still coming: absence on this side proves nothing. */
  truncated: boolean
  /** The server's own totalCount (summed over the scans read); absent when it gave none. */
  reported?: number | null
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
  /** Why nothing could be decided (no project, branch not scanned yet, a scan that returned 0 results). */
  note?: string | null
  /** What each side's scan returned: how many results, by engine. Absent when no scan was read. */
  read?: { branch?: VulnScanRead | null; base?: VulnScanRead | null } | null
  items: VulnFixItem[]
}

/** What a Dynatrace link points at (jira-intern/dynatrace.py::parse_link). `other` = a link the board lists but does not read. */
export type DynatraceKind = 'trace' | 'problem' | 'logs' | 'service' | 'other'

/**
 * How reading one link went. `read` = data came back; `empty` = the query ran and found nothing (or the link is of a kind
 * that is not read, or carries no time window — `note` says which); `unreachable` / `auth-failed` = the lookup FAILED (the
 * previous result is carried forward, marked `stale`, when there was one); `unconfigured-tenant` = the link's host is not
 * one of the tenants in DYNATRACE_TENANTS — listed, NEVER fetched.
 */
export type DynatraceStatus = 'read' | 'empty' | 'unreachable' | 'auth-failed' | 'unconfigured-tenant'

/** A Davis problem as read from `dt.davis.problems` (every field optional: the table varies by tenant). */
export interface DynatraceProblem {
  id?: string | null
  /** "P-23101234" */
  displayId?: string | null
  title: string
  /** ACTIVE / CLOSED */
  status?: string | null
  /** The problem's category (ERROR, SLOWDOWN, AVAILABILITY, RESOURCE, CUSTOM). */
  severity?: string | null
  start?: string | null
  end?: string | null
  rootCause?: string | null
  affected?: string[]
}

/** The facts pulled out of a link (never a raw dump). Which fields are present depends on the link's kind. */
export interface DynatraceSummary {
  /** trace: how many spans the trace has (the first 500 are read), the services in order of first call, the root request. */
  spans?: number
  services?: string[]
  root?: string | null
  failedSpans?: number
  /** HTTP status codes seen, as strings ("500": 3). */
  statusCodes?: Record<string, number>
  /** Top exception / error messages, scrubbed and cut, with how often each occurred. */
  errors?: { message: string; count: number }[]
  slowest?: { name: string; ms: number } | null
  /** Where in the call chain the failure ORIGINATES: the deepest failed span (no failed child), earliest first. */
  firstFailure?: { service?: string | null; name?: string | null } | null
  /** problem / service / trace: Davis problems (for a trace: those that overlap its window and name one of its services). */
  problems?: DynatraceProblem[]
  /** service: requests in the window and how many failed. */
  requests?: { total: number; failed: number } | null
  /** logs: the most frequent error lines, grouped. */
  logGroups?: { message: string; count: number }[]
}

export interface DynatraceItem {
  /** The link as written in the ticket: https only, no credentials, at most 600 chars. */
  url: string
  kind: DynatraceKind
  /** Which flavour of Dynatrace SaaS URL it was (Managed hosts are not recognised as Dynatrace links). */
  host: 'classic' | 'platform'
  /** The environment label from DYNATRACE_TENANTS ("prod"), else the tenant id from the link's host. */
  tenant: string
  /** The time window that was (or would be) read, ISO UTC — the link's own, padded by 5 minutes, at most 2 hours. */
  window?: { from: string; to: string } | null
  status: DynatraceStatus
  /** Short plain-language facts ("4 failed spans, the first in payments: POST /charge"). At most 8, 200 chars each. */
  findings: string[]
  summary?: DynatraceSummary | null
  /** Why nothing was read: "tenant xyz is not in DYNATRACE_TENANTS", "the link carries no time window", … */
  note?: string | null
  /** When this item was read (ISO, UTC). */
  fetchedAt?: string | null
  /** True when Dynatrace could not be re-read and this is the previous run's answer, carried forward. */
  stale?: boolean
}

/**
 * What Dynatrace says about the links in a ticket (QA / support tickets are full of them). Written only by
 * jira-intern/dynatrace.py via daily_fetch.apply_dynatrace — read-only queries against tenants the user LISTED, never
 * against a host taken from ticket text. At most 5 items; a ticket with no Dynatrace link has no field.
 */
export interface DynatraceEvidence {
  /** When the board last asked Dynatrace about this ticket (ISO, UTC). */
  fetchedAt: string
  items: DynatraceItem[]
  /** Links beyond the first 5 that were not read. */
  moreLinks?: number
}

/** What a proof source did in the last fetch run (jira-intern/_sources.py) — a skip is never silent. */
export type SourceState = 'not-configured' | 'no-candidates' | 'read' | 'unreachable' | 'auth-failed' | 'budget-exhausted'

/**
 * `JiraData.proofSources[source]`, written by the daily fetch: one state and one human line per source per run
 * ("Checkmarx: 3 vulnerability-fix tickets looked up (…) — 2 with open findings"). Never holds a secret.
 */
export interface SourceStatus {
  state: SourceState
  detail: string
  /** When the run finished (ISO, UTC). */
  at: string
  /** Tickets looked up this run, and their targets by status. */
  looked?: number
  counts?: Record<string, number>
  /** Keys of the tickets that wanted an answer and got none (not configured / failed): their old results were carried forward. */
  waiting?: string[]
}

/**
 * `Ticket.proofNotes[source]`: why a ticket the source applies to has no FRESH answer — not configured, unreachable,
 * key rejected, call budget used up. Set by the fetch (daily_fetch.apply_vuln_fixes), cleared by the next answer.
 */
export interface ProofNote {
  state: Exclude<SourceState, 'read' | 'no-candidates'>
  detail: string
  /** Since when the ticket has been in this state (ISO, UTC) — an unchanged state keeps its stamp. */
  at: string
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
  /**
   * Why a vulnerability-fix ticket has no fresh Checkmarx answer — see ProofNote. Written only by
   * daily_fetch.apply_vuln_fixes; absent when the ticket was looked up (or is not a candidate).
   */
  proofNotes?: { checkmarx?: ProofNote | null; jenkins?: ProofNote | null; dynatrace?: ProofNote | null } | null
  /**
   * What Dynatrace says about the Dynatrace links in the ticket's text (traces, problems, logs, services) — see
   * DynatraceEvidence. Absent when the ticket has no such link or Dynatrace was never read; every view must cope without it.
   */
  dynatrace?: DynatraceEvidence | null
  /**
   * A fingerprint of the evidence (Dynatrace / Checkmarx / Jenkins) the aiSummary was written from. The brief is
   * regenerated when the evidence changes even though Jira's `updated` did not. Written with aiSummary by the AI worker.
   */
  aiSummaryEvidence?: string | null
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
  aiSummaryEvidence?: string | null
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
  /** What each outside proof source (Checkmarx, Dynatrace) did in the last daily fetch — see SourceStatus. */
  proofSources?: Record<string, SourceStatus>
}
