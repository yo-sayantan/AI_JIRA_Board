# Integrations — Jira, Bitbucket, the server API, Docker, and the config chain

How the pieces talk to each other and to the outside world. Companion to `DATA-FLOW.md`
(files) and `AI-PIPELINE.md` (models).

## Jira (REST v2, personal access token)

- Auth: `Authorization: Bearer $JIRA_PERSONAL_TOKEN` (`_jira.py::jira_get`), TLS with a relaxed
  context (on-prem instances behind private CAs), retry-with-backoff on 5xx/network
  (`get_json`, 4 retries), 120s timeout.
- One field list (`_jira.py::FIELDS`) shared by all fetches: summary, status, issuetype,
  priority, updated, created, resolutiondate, assignee, reporter, labels, components,
  fixVersions, description, comment, issuelinks, parent, subtasks, and the instance's custom
  fields (story points ×2, sprint, epic link, acceptance criteria). The raised fetch uses a
  lighter list (`raised.py::RAISED_FIELDS`) — no comment bodies, no subtasks.
- `expand=changelog` rides along with every search: it powers status timelines
  (`build_update_log`), done-date fallback (`changelog_done_date` — `resolutiondate` is null when
  a ticket jumps straight to Done), and the Raised view's assignee hand-off trail
  (`assignee_history`).
- The JQL queries, complete list:

| Query | Job |
|---|---|
| `assignee = currentUser() AND statusCategory != Done OR (… Done AND resolved >= -10d)` | daily fetch |
| `reporter = currentUser() AND (not Done OR resolved >= -10d)` → QA tickets only, then `key in (<QA keys>)` | daily fetch: QA tickets I raised or that link to my tickets (not assigned to me, so the assignee search misses them) |
| `parent in (<active keys>)` | all sub-tasks, one batched search |
| `(assignee WAS currentUser() OR assignee = currentUser()) [+ scope]` | archive rebuild |
| `key in (<parent keys>)` | archive context parents |
| `reporter = currentUser() AND issuetype not in subTaskIssueTypes()` | raised list (pages in parallel) |
| `parent = <KEY>` | per-ticket refresh sub-tasks |

  Compat fallbacks: `statusCategory = Done` → explicit statuses on 400;
  `subTaskIssueTypes()` → plain reporter search on 400 (the parent-field filter still drops
  sub-tasks). Pagination never trusts `total` blindly — permission-filtered results can return
  fewer rows than promised, so the loop stops on an empty batch.

## Bitbucket (Server/DC REST 1.0) + Jira dev-status

Branch/PR truth comes from **Jira's dev-status API first** (`devinfo.py` — repo-agnostic,
authoritative, includes reviewers/approvals); a Bitbucket **key-scan** of hinted repos
(`REPO_HINTS`/`BB_PROJECT` maps in `daily_fetch.py`) only supplements when dev-status has no PRs
(the symptom of the Jira↔Bitbucket link being down). Rules:

- PR identity is `(project, repo, id)` — ids repeat across repos (`_pr_identity`).
- PR state mapping: ≥`requiredApprovals` approvals + 0 open comments → `approved`; NEEDS_WORK →
  `changes`; merged/declined terminal (with fixed comment stats — closed PRs skip activity pages).
- Bitbucket is probed once per run; if down, `BB_OK=False` and all PR data is **carried forward**
  (the run note says so). Single-ticket refresh skips the per-PR comment lookups so a slow
  Bitbucket can't wedge the queue; the primary-branch ranking below still runs, because it is one
  short call per branch and only for tickets that have several.
- **Primary branch.** A ticket can carry several branches (renames, a restarted attempt, one per
  repo). The ticket's `branch` is the one with the **newest commit**: Jira's dev-status has no
  commit time per branch, so `devinfo.branch_head` asks Bitbucket for each branch's newest
  commit (`/commits?until=refs/heads/<branch>&limit=1`), only when there is more than one branch.
  The primary PR (`pr`) is then that branch's own PR, and `branches` / `prs` are reordered with
  the primary first and nothing dropped. When the branch has no PR in dev-status (the index can
  lag a new PR), `devinfo.prs_from_branch` looks for one in Bitbucket; if there is still none,
  `pr` is `{"state": "none"}` and the card shows no PR badge while the other PRs stay listed in
  the drawer. Without a readable commit time the previous run's branch stays (so a refresh that
  could not reach Bitbucket never flips it back); with no prior either, the in-flight PR's
  source branch decides, as before. The UI follows `pr` (`primaryPrOf` in `src/lib/format.ts`).
  The readiness report still weighs every PR of the ticket.
- **Bitbucket's records win over Jira's index.** Jira's dev-status can name a branch that no longer
  exists (or never existed under that name) and say a PR comes from it. So:
  - for every **open** PR — daily run and single-ticket refresh alike — `devinfo._to_pr` reads
    `fromRef`/`toRef` from `GET …/pull-requests/<id>` and uses those as `sourceBranch` /
    `destinationBranch` (dev-status's value is only the fallback); comment counts stay enrich-only;
  - when a ticket has several branches, `devinfo.branch_head` asks each for its newest commit; a
    branch Bitbucket answers **404** for is dropped from `branches` (a merged/declined PR's source
    branch stays — it is history, usually deleted on merge). Any other failure drops nothing.
  - the first network-level failure (DNS, TLS, refused) marks Bitbucket unreachable for the rest of
    that run (`_BB_UNREACHABLE`), so an outage costs one timeout, not one per PR and branch.
  All of this needs Bitbucket reachable **from where the fetch runs** — in Docker that usually means
  trusting the company CA (`~/.ai/ca-bundle.pem`, [SETUP.md](SETUP.md)). Until then the board can
  only show what Jira's index says; refresh logs read `bb_ok: false` and
  `WARN bitbucket unreachable … CERTIFICATE_VERIFY_FAILED`.
- **A ticket shows only its OWN pull requests.** Jira links a PR to every ticket named in any commit
  inside it, so release PRs, merges from dev and rebases drag other tickets' PRs onto a ticket.
  `devinfo.scope_to_ticket` drops a PR whose title and source branch name some OTHER ticket and
  never this one (and any branch that names only other tickets, unless a kept PR comes from it). A
  PR naming no ticket at all stays — it cannot be judged. Only upper-case `ABC-123` shapes count as
  "another ticket"; `utf-8`, `SHA-256`, `CVE-…` and similar look-alikes do not. Applied in the daily
  fetch, the single-ticket refresh, the completed archive and the Done gate.
- **A sub-task shows only its OWN code.** Jira links a PR to every ticket with a commit on its
  branch, so sub-tasks committed on the parent's branch used to mirror the parent's PR and branch.
  `devinfo.scope_to_subtask` drops, from a sub-task, any PR or branch it shares with its parent
  unless the PR title / branch name names the sub-task's own key (whole-key match: `ABC-12` is not
  `ABC-123`). It runs in the daily fetch (`code_for(key, prior, parent_key)`), the single-ticket
  refresh (the parent joins the dev-status batch), the completed archive (`dev_fields`) and the
  Done gate. If the parent's lookup failed nothing is dropped.
- Review activity never bumps Jira's `updated` → even "unchanged" tickets re-check PRs on the
  daily fast path.

## Service health (the API keys dialog's dots)

Every outside client records what a real call saw via `jira-intern/_health.py` (`record`, `record_ok`, `record_exception`),
and the Test button records through `server/health.mjs`: one file per service id from `setup/api-keys.json`, read by
`GET /api/keys/health`. Call sites: `_jira.get_json` / `jira_post` (`jira`, `bitbucket`), `jenkins._get` (and the console read), `checkmarx._call`
(a 400 on the token exchange = key rejected), `dynatrace._request` (a 400 for one rejected query is skipped like a 404), `ai-intern/worker.py` `http_json` / `_cloud_json` (cloud host → `claude`,
`cursor`, `gemini`, `openai`; Ollama is not a keyed service) and `mcp_get` (Bitbucket / Jira reads). Mapping: 2xx ok ·
401 `auth-failed` · 403 `forbidden` · 429 / 5xx / redirect `error` · timeout, DNS, refused `unreachable` · certificate `tls`.
Other 4xx — notably the **404 of a per-ticket / per-branch lookup** (Jenkins "no build for this branch", Checkmarx "no
project") — say nothing about the service and are never recorded. Red = 401 / 403 (the key), orange = everything else.

## Jenkins (multibranch pipelines, JSON API)

`jira-intern/jenkins.py` reads the **latest build of each of a ticket's branches, per environment and
pipeline**, from two sources that work together: the multibranch jobs you list in config →
`jenkins.jobs.<repo slug>.<env>`, and the pipelines **discovered** under your Jenkins root folder
(`JENKINS_ROOT_URL`, below). An explicit `jenkins.jobs` entry overrides discovery for that repo and
environment ([CONFIG.md](CONFIG.md)).
It runs inside the daily fetch (full and fast path — a build never bumps Jira's `updated`, so it is
re-read on every run like PR state) and the single-ticket refresh (`daily_fetch.apply_builds`).

- **Auth**: HTTP basic, `JENKINS_USER:JENKINS_API_TOKEN` from `setup/.env`, sent only in the
  `Authorization` header — never in a URL, never logged. Requests go only to the configured
  job URLs: follow-up calls are built from the configured job, never from the `url` Jenkins returns.
- **Transport** (`jira-intern/_safe_http.py`): **https job URLs only** — an `http://` entry in
  `jenkins.jobs` is skipped with a `WARN … job URL is not https — skipped` line (the token travels with
  every call). Jenkins has its **own** TLS context, always verified: `JIRA_INSECURE_TLS` does NOT apply to
  it; `JENKINS_INSECURE_TLS=1` is Jenkins' separate last-resort opt-out (logged as a WARN). A private CA
  from `JIRA_CA_BUNDLE` / `~/.ai/ca-bundle.pem` is still added to the system roots. Redirects are followed
  only within the same scheme + host + port (`SameOriginRedirect`), so the `Authorization` header never
  reaches another host and https is never downgraded; a refused redirect is a failed lookup. Every GET
  goes through `jenkins.get_json` — its own client (not `_jira`'s), one retry on a 5xx or network error,
  none on a 4xx.
- **Which branches**: the ticket's `branch`, its open PRs' source branches, its other `branches`,
  then merged / declined PR branches (usually deleted) — each in the repo devinfo saw it in
  (dev-status branch URL → `repos`, or the PR URL's slug). Repos in `jenkins.jobs` and repos discovery
  finds pipelines for; a branch whose repo is unknown is tried in every repo of `jenkins.jobs` (never
  in discovery). At most 24 (repo, pipeline, branch) lookups per ticket and 800 calls per run; 8 requests in flight.
- **Branch job name**: multibranch names a branch's child job after the branch with each character
  Jenkins refuses in an item name written as `%XX` (`/` → `%2F`, `%` → `%25`), and that name is
  URL-encoded again in the path — so `feature/ABC-1` lives at `<job>/job/feature%252FABC-1/`
  (`jenkins.item_name` / `branch_segment`, tested).
- **Endpoints**, per (repo, env, branch):
  - `<branch job>/lastBuild/api/json?tree=number,result,building,timestamp,duration,url,…,actions[parameters[name,value],failCount,skipCount,totalCount,urlName]`
    — result (`BUILDING` while `building`), number, link, start time, duration, JUnit totals (the test
    result action) and build parameters (`DEPLOY_ENV` / `ENVIRONMENT` / `ENV` / `TARGET` → `deployTarget`,
    else the env name);
  - only when tests failed: `<build>/testReport/api/json?tree=suites[cases[className,name,status]]` →
    up to 5 `FAILED` / `REGRESSION` names;
  - only for `FAILURE` / `UNSTABLE`: `<build>/wfapi/describe` (Pipeline Stage View) → the first stage
    whose status is `FAILED` / `UNSTABLE` → `failedStage`.
  The two extras are best-effort: if they fail, the build is stored without them.
- **Discovery** (`jira-intern/jenkins_discovery.py`; needs `JENKINS_ROOT_URL` — key button → Jenkins → "Projects
  folder" — or config `jenkins.root`; the env value wins and the real URL never goes in the tracked config).
  Layout it assumes — every name is free-form, only the shape matters:

  ```
  <root>/<portfolio>/<application>/<pipeline>/<branch job>        multibranch pipeline
  <root>/<portfolio>/<application>/<env folder>/<pipeline>        env folders may hold the pipelines
  <root>/<portfolio>/<application>/<deploy job>                   plain job: branch (or a build) is a PARAMETER
  ```

  1. *Walk*: `<folder>/api/json?tree=jobs[name,url,_class,color]`, one call per folder, level by level from
     the root, never deeper than `maxDepth` (default 4: root 0, portfolio 1, application 2, env folder 3,
     pipelines 4) and never more than `maxCalls` (150) folder reads per walk. Child URLs are built from the
     configured root plus the NAMES listed — never from a `url` Jenkins returns.
  2. *Application folders*: every folder (or pipeline) whose name matches the repo slug —
     `app_folder_matches`: case and punctuation ignored, the slug equals the name or a run of whole words of it
     (`payments` matches `PAYMENTS-AWS` and `team-payments`, not `paymentsgateway`; a slug under 3 characters must
     equal the name), or your own `jenkins.discovery.appFolderRegex` template (`^{slug}(-.*)?$`). A repo that
     appears under several portfolios gives several application folders; all are used. The repo slug is the one
     devinfo / the PR URL names — a branch whose repo is unknown is **never** guessed against a whole tree.
  3. *Classify* every node below an application folder (plain folders are recursed): a
     `WorkflowMultiBranchProject` is **multibranch** (the branch is a child job — `branch_segment`, double
     encoding included); any other job is read once for its parameters
     (`property[parameterDefinitions[name,type]]`) — a branch-like name (`branch`, `git ref`, `revision`, `tag`,
     in that order) makes it **parameterised**; a job without one is *ignored* (it cannot be tied to a branch).
  4. *Label*: environment = the first of `jenkins.discovery.envPatterns` (defaults dev · qa · stage · demo · prod,
     tried in that order) whose word appears — between non-alphanumerics, case-insensitive — in the pipeline name,
     then its folders deepest first, then the application folder, then the folders above it. Nothing matched → the
     pipeline's own name is the label (and, for a parameterised job with an `ENV` / `ENVIRONMENT` / `DEPLOY_ENV` /
     `TARGET` parameter, that parameter's value, run through `envPatterns`, is the label — one build per value).
     Kind = `build` / `deploy` / `both` from the name (`kindPatterns`); no hint → a parameterised job is a deploy,
     a multibranch pipeline is both (one pipeline with a Deploy stage).
  5. *Read builds*: multibranch → `lastBuild` of the branch job as above (404 = no build of this branch here);
     parameterised → ONE call, `builds[number,result,building,timestamp,duration,url,actions[parameters[name,value]]]{0,N}`
     (`buildScan`, default 25), and the newest build whose branch parameter equals the ticket's branch — after
     stripping `origin/`, `refs/heads/`, `refs/remotes/origin/` — is the latest run (deployment) of that branch.
     The build link is built from the configured job + number. Test totals are read for build / both pipelines
     only; a failed build names its stage as usual. Each build carries `pipeline`, `kind` and `via`
     (`branch-job` | `parameter`); one environment may therefore have several rows.
  6. *Cache*: the walk's answer per root + slug (+ a signature of the discovery config, so editing
     `envPatterns` applies at once) is written atomically to `jira-intern/.jenkins-discovery.json` (git- and
     docker-ignored, no credentials inside) and kept in memory for the run; `cacheMinutes` (60) is its TTL, so
     daily runs do not re-walk. A walk that fails (network, auth, budget) serves the **stale** entry; with none, the
     repo's prior builds are carried forward (`stale: true`) — "couldn't discover" is never "no pipelines". A
     genuinely empty answer (no application folder) is cached too.
  7. *Chips and the gate*: a build pipeline and a deploy pipeline of one environment are two builds. The card
     shows ONE chip per environment: a FAILURE (else an UNSTABLE) if any pipeline has one, otherwise the deploy
     result when there is one, otherwise the newest build; the drawer lists every row (pipeline, kind, env, result,
     number link, age, duration, branch, tests, failed stage). The CI gate passes only when every pipeline's
     latest build of the branch is SUCCESS (stale never passes; a per-lookup 404 is exempt).
- **Seeing what it found**: `python3 jira-intern/jenkins.py discover <repo-slug> [--json]` walks live (ignoring
  the cache, refreshing it) and prints the application folders, every pipeline with its classification
  (multibranch / parameterised [PARAM] / ignored), the environment it chose and *why* (`matched 'dev' in
  'Deploy (dev)'`), its kind and its URL — no token or user in the output. Exit 0 ok, 1 the walk failed, 2 no root /
  user / token (or no slug). Paste the output back when an environment label is wrong, then tune
  `jenkins.discovery.envPatterns`. Run it from the repo checkout (it reads `setup/.env` and your personal config like the fetch does), or
  inside the JIRA-Board container.
- **Testing the key**: with a projects folder saved the dialog's Test button reads `<root>/api/json?tree=name,jobs[name,_class]`
  and says "Root readable · N folders"; without one it falls back to `JENKINS_URL` (`/me`), then the first job link.
- **Console excerpt** (`jenkins.add_console_tails` → `console_tail`, stored as `builds[].consoleTail`): for the
  **latest failed build** (`FAILURE` / `UNSTABLE`, not `stale`) of a ticket that is *about* a failing build, pipeline or
  deployment (`jenkins.is_build_failure`: the title, type, labels, description or acceptance criteria say a build /
  pipeline / deploy / CI / Jenkins job "failed", "is broken", "is red" … — comments do not classify; "Jenkins" alone does
  not), the fetch keeps the **last ~40 lines, at most 4 KB** of `<build>/consoleText`, scrubbed (`_scrub.tail`:
  tokens, passwords, `Authorization` / `Bearer` values, credentials in URLs, secret-looking environment values, e-mail
  addresses and IPs are replaced with `•••` / `[email]` / `[ip]`). The log is never downloaded whole: a `Range:
  bytes=-16384` request first (a server that honours it answers 206 with just the tail), else a bounded stream whose
  last 16 KB are kept; a log that is still running past **2 MiB** without an end is not read further. The URL is the
  configured build address (the same one the test report is read from), the credentials only in the header, and the
  call is counted in the run's 800-call budget plus its own **25 excerpts per run**. A tail already stored for the same
  build number is kept without a call; any other build loses a tail it carried (it has moved on); a stale build keeps
  what it had. Outcomes: a string = the excerpt; `""` = nothing to excerpt and asking again will not change that (404,
  an empty log, or a log too long to find the end of — stored so the next run does not read it again, shown nowhere);
  nothing stored = it could not be asked this time (not configured, budget spent, host down, a network / server error —
  tried again next run). A 401 / 403 or a network failure marks the host down for the rest of the run like any other
  Jenkins call. Readers: the drawer's collapsed **Console (last lines)** box under the build, the report's evidence
  chain (the deciding lines), and the Evidence section of the AI brief ([AI-PIPELINE.md](AI-PIPELINE.md)).
- **Failure semantics**: `404` on the branch job (or on `lastBuild`) = "no build for this branch" — an
  answer, the build is simply absent. A network error or `401`/`403` = the lookup FAILED: that host is
  skipped for the rest of the run (one timeout, not one per ticket), the ticket keeps its previous
  `builds` (only the failed environments' entries when the failure was partial), and the run note says
  "Jenkins unreachable — builds carried forward". Every carried build is marked `stale: true` — the card
  and drawer show it as stale ("Jenkins could not be re-read; this is the last build seen") and the
  report's "CI green" gate cannot Pass on it (it is **Not verified**, with the build's age; a fresh
  FAILURE / UNSTABLE still fails it). No jobs configured or no credentials → nothing is asked and prior
  builds are preserved unchanged (not marked stale).
- **Sub-tasks**: builds are looked up only for the ticket's own branches, after `scope_to_subtask` — a
  sub-task committed on its parent's branch gets no builds; they are the parent's.
- **Readers**: the card's build chips, the drawer's Proof section and the PR readiness report's
  "CI green" gate (`pr_report.jenkins_ci`; Bitbucket's build status is the fallback when a ticket has
  no builds — [AI-PIPELINE.md](AI-PIPELINE.md)).

## Checkmarx One (vulnerability-fix tickets, REST API)

`jira-intern/checkmarx.py` answers one question for a **vulnerability-fix ticket**: which of the
vulnerabilities the ticket itself names are fixed on its branch. Nothing else from the scan is shown — the
scan's other findings are not this ticket's to fix. It runs inside the daily fetch (full and fast path — a
scan never bumps Jira's `updated`) and the single-ticket refresh (`daily_fetch.apply_vuln_fixes`), stored as
`Ticket.vulnFixes`. The AI worker uses the same module (no second client).

- **Which tickets** (`is_vuln_fix`): title, type, labels, description or acceptance criteria mention a CVE,
  Checkmarx, SCA, SAST, a CWE, "vulnerab…", OWASP, Spring4Shell or a dependency upgrade. Comments do not
  classify. A bare "dependency" no longer counts ("blocked by a dependency").
- **Targets** (`extract_targets`, from title, description, acceptance criteria, comments and link URLs, at
  most 12): CVE ids (`CVE-2021-44228`); SAST query names that look like Checkmarx's (Title_Case words joined
  by `_`, at least one lower-case letter, and a vulnerability word — `SQL_Injection`, `Stored_XSS`; plus a few
  common spaced forms like "sql injection") and `CWE-<n>`; Checkmarx result links (a `result-id` /
  `resultId` / `similarityId` query parameter on a host containing `checkmarx` / `cxone` or the configured
  one) and explicit `resultId=…` / `similarityId: …` in prose; package versions (`lodash@4.17.20`,
  `group:artifact:1.9`, `log4j-core 2.14.1`, "upgrade jackson-databind [from 2.13] to 2.15"). Env-var style
  names, plain words with a version ("version 2.3", "node 18.2") and e-mail addresses are not targets.
- **Which scans** (`scan_plan`): the repo slug and source branch of the ticket's open PR (else its newest
  merged PR; declined PRs never), compared with the PR's destination branch; without one, the project's
  `mainBranch`, else the first of `main` / `master` / `develop` with a scan. One repository per ticket.
  **A merged PR is judged against the newest base scan from before it merged** (`mergedAt`): after the merge the
  base branch already holds the fix, so a post-merge base scan would show every target as gone from both scans.
  With no base scan from before the merge the targets are `unknown` ("no <base> scan from before the PR
  merged … already contains the fix").
- **Auth**: `CHECKMARX_API_KEY` (an API key = OAuth refresh token) is POSTed once per run to the token URL
  (`CHECKMARX_AUTH_URL`, else `<base>/auth/realms/<tenant>/protocol/openid-connect/token`) with
  `client_id=ast-app`; the bearer token it returns goes in the `Authorization` header. The key is only ever in
  that POST body — never in a URL or a log. TLS is always verified (`JIRA_INSECURE_TLS` does not apply to
  SaaS); a proxy CA is added from `JIRA_CA_BUNDLE` / `~/.ai/ca-bundle.pem`. Keys come from `setup/.env`, the
  environment wins; hosts only from `CHECKMARX_BASE_URL` / `endpoints.checkmarxBase` (https only).
  Redirects are followed only within the same origin (`_safe_http.SameOriginRedirect`): neither the key nor
  the bearer token follows a redirect to another host or down to http. **Any** token failure — 401/403, a
  5xx, unreadable JSON, a refused redirect, or a response without `access_token` — marks Checkmarx down
  for the rest of the run.
- **Endpoints**: `GET /api/projects?limit=20&name=<slug>` — the search is a substring match, so only a project
  named exactly `<slug>` (case-insensitive) or ending in `/<slug>` is taken; anything else is "no project",
  never a best guess → `GET /api/scans?project-id=…&branch=…&statuses=Completed&limit=20&sort=-created_at`
  (the newest 20 completed scans of exactly that branch; per target, the newest one that **ran the target's
  engine** is used — SCA for CVEs and packages, SAST for queries, CWEs and result ids) → `GET /api/results?scan-id=…&limit=100&offset=…` (no
  severity or state filter: LOW and INFO are read too; at most 10 pages per scan). **Paging follows what the
  server serves, not what was asked**: a server may cap the page size below 100, so a short page is not the last
  page — `offset` advances by the rows actually returned and the read ends only on an empty page, on
  `totalCount`, or at the page limit (then the scan is *truncated* → `unknown`, never `not-found`). Projects,
  scans and results are cached for the run, so the base branch's scan is read once per repository, not once per
  ticket. At most 300 calls per run.
- **Status per target**, comparing the branch scan with the base scan:
  `fixed` — in the base scan and not open on the branch: absent, or there with status `FIXED`, or triaged
  `NOT_EXPLOITABLE` (the detail says "triaged rather than removed" — Checkmarx no longer counts it, but the
  code did not change); `open` — still detected on the branch; `not-found` — in neither scan: the ticket may
  name the wrong id, the finding was never in this repository, or the fix is already in the base scan (see
  "What was read" below — the detail says which it can tell); `unknown` — no verdict can be proved: the branch has no completed scan yet, or none
  that ran the target's engine ("branch scan did not run SCA/SAST"); the base has none to compare, or none
  that ran the engine ("base scan did not run SCA/SAST"); the branch scan is **older than** the base scan
  (a finding present on the base and absent from an older branch scan proves nothing — rescan the branch);
  the ticket names a per-scan result `id` instead of a `similarityId`; no project matches the repo; or a scan
  has more than 1,000 results (absence from a truncated read proves nothing). Matching: CVE ↔
  `vulnerabilityDetails.cveName` (or the SCA result id); query ↔ `data.queryName` ignoring case / `_` /
  spaces (a longer query name with the same start also matches); CWE ↔ `vulnerabilityDetails.cweId`; result
  ↔ `similarityId` **only** (stable across scans — a result's own `id` changes with every scan, so a target
  that matches a row's `id` is `unknown`, with a hint to name the similarityId); package ↔
  `data.packageIdentifier` (`Maven-org.x:lib-1.2.3`, `Npm-lodash-4.17.20`) — on the base the named vulnerable
  version, or (no from-version) any version **below** the upgrade target — a base finding already on the target
  version is not what the ticket fixes; on the branch the named vulnerable version or one below the upgrade target,
  and with only a from-version ("lodash 4.17.20", no "to") ANY version still carrying an open finding keeps
  the target open.
  Each item stores severity (from the base scan when it was there), location (SAST `file:line`, SCA
  `package version`) and a one-line detail with both branches and scan dates.
- **What was read** — so "not found" can be told from "nothing was read". `vulnFixes.read` holds, per side
  (`branch`, `base`), how many results the scan returned: `{ total, sca, sast, other, truncated, reported? }`
  (`reported` = the server's `totalCount`). Every `not-found` detail repeats it ("Read 412 results on
  feature/x (SCA 380 · SAST 18); 398 results on develop (…)"); a scan that returned **0 results** says "the
  results API returned nothing for this scan" and sets the `note` (the report's gate shows it). A package item
  also lists `foundOnBase` / `foundOnBranch` — the versions of that package carrying any finding in each scan —
  and when the base already runs the target version the detail says "already at 6.5.9 on develop: the upgrade
  predates the base scan, so no scan shows the before"; a CVE not found says the same when the ticket's own
  package upgrade is already in that scan ("…the fix may predate that scan").
- **Visible status, never a silent skip** (`_sources.py`, state per run in `data.json → proofSources.checkmarx`
  and a run note): `not-configured` (names the missing settings — `CHECKMARX_BASE_URL`, `CHECKMARX_API_KEY`,
  never values; silent in the notes unless a vulnerability-fix ticket is waiting), `no-candidates` (configured, but
  no vulnerability-fix ticket qualified — the line says how many were skipped and why: no PR / known branch, or
  naming no CVE, query, CWE, result or package), `read` ("Checkmarx: 3 vulnerability-fix tickets looked up (7
  targets: 4 fixed · 2 open · 1 not found) — 2 with open findings"), `unreachable` / `auth-failed` /
  `budget-exhausted` (the lookups failed; previous results carried forward). A candidate ticket with no fresh
  answer carries `proofNotes.checkmarx` — the drawer's Vulnerabilities group shows it ("Checkmarx not configured —
  add the URL and key in API keys") and the report's gate uses it as its evidence. The API keys window's Checkmarx
  panel has a fixed "Last fetch" line from the same record. This is the per-run account; the dot beside it
  (`_health.py`) is still the latest real call.
- **`diagnose`** — when targets do not match what you expect, run it from your terminal (read-only; uses
  `setup/.env` and the config like the fetch; prints no token, key or auth URL; exit 0 read · 1 Checkmarx could not
  be read · 2 not configured / bad arguments):
  `python3 jira-intern/checkmarx.py diagnose <TICKET-KEY>` (the ticket as in `data.json`) or
  `python3 jira-intern/checkmarx.py diagnose <repo-slug> --branch <PR branch> [--base <branch>] [--target CVE-… --target "pkg 1.2 → 1.3"]`.
  It lists the project matched (and the substring-only ones that were not used), the scans considered with
  their engines, the results read per scan (by engine, severity, status; the page count; whether the server
  gave a `totalCount`; the FIELD NAMES of an SCA and a SAST row), a cross-check against `/api/scan-summary`
  ("scan-summary counts 380 SCA findings but only 20 SCA rows were read — the results are incomplete"), and per
  target the status, the detail and — for packages — the versions seen on each side.
- **Failure semantics**: a network error, `401`/`403`, another HTTP error, unreadable JSON or the call budget
  = the lookup FAILED: `vuln_fixes_for` returns None, the ticket keeps its previous `vulnFixes` (and gets a
  `proofNotes.checkmarx` saying why), and after a network or auth failure Checkmarx is not asked again that run
  (the run's Checkmarx line says `unreachable` / `auth-failed` / `budget-exhausted` and how many tickets were
  carried forward). "No project" / "no scan" are answers, stored as `unknown` with a `note`. Not configured →
  nothing asked, prior results kept, `proofNotes.checkmarx` says so. Not a vulnerability-fix ticket, no target
  named, or no PR → no field and no call (the run line counts them as skipped, with the reason).
- **Sub-tasks**: only the sub-task's own PRs (after `scope_to_subtask`) — it never inherits its parent's scan.
- **Readers**: the card's shield chip, the drawer's Proof → Vulnerabilities group, and the PR readiness
  report's "Security scan (Checkmarx) clean" gate + evidence rows (`pr_report.vuln_gate`, in the deterministic
  base — AI level None included — [AI-PIPELINE.md](AI-PIPELINE.md)).

## Dynatrace (links in a ticket, read-only DQL)

QA and support tickets are full of Dynatrace links: the trace of the failing request, the Davis problem, the service, a
log search. `jira-intern/dynatrace.py` finds those links in the ticket's text, reads **only what each link points at**
and keeps short facts in `Ticket.dynatrace` (`src/types.ts::DynatraceEvidence`). It never searches a tenant on its own
and never reads anything a link does not name. It runs inside the daily fetch (full and fast path — Dynatrace answers
age: a problem closes, spans arrive late — and the single-ticket refresh, `daily_fetch.apply_dynatrace`). The AI worker
does not use this module: it reads what the fetch stored ([AI-PIPELINE.md](AI-PIPELINE.md)). (The worker keeps its own older
text-search probe for an observability / incident ticket that has **no** Dynatrace link — `worker.dynatrace_proof`, which
reads the same `DYNATRACE_TENANTS` — and does not ask it when the fetch already read the ticket's links.)

- **Which links** (`extract_links`): any `https` Dynatrace link (port 443, at most 4,096 characters) in the ticket's title,
  description, acceptance criteria, comments, external links and sources (`checkmarx.ticket_text`; a cheap substring check first). Distinct links in the
  reading order — the first link of each kind (trace · problem · logs · service · other), then the second of each, … so five
  links of one kind cannot push the others out — **the first 5 are read** (`moreLinks` counts the rest). Shapes
  (`parse_link`):

  | Link | Kind | What identifies it |
  |---|---|---|
  | classic `https://<tenant>.live.dynatrace.com/#trace;gtf=<iso> to <iso>;traceId=<hex>;timeframe=custom<ms>to<ms>` | `trace` | `traceId` (16–32 hex) |
  | `…/#problems/problemdetails;pid=<id>` | `problem` | the problem id (`P-23101234` or an event id) |
  | `…/#serviceOverview;id=SERVICE-<16 hex>` (also `#services`, `#entity/service/…`) | `service` | the service id |
  | `…/#logs;…` | `logs` | a `traceId` or a `serviceId` in the link — nothing else scopes a log query |
  | platform `https://<tenant>.apps.dynatrace.com/ui/apps/dynatrace.distributedtracing`, `dynatrace.davis.problems`, `dynatrace.logs`, `dynatrace.services` (id in the query string or path) | as above | as above |
  | Dynatrace Managed (`https://<host>/e/<uuid>/…`) or any other host | **not a Dynatrace link** — only `*.live.dynatrace.com` / `*.apps.dynatrace.com` hosts are believed (a Managed host is anything, and a link would be shown under Dynatrace's name) | — |
  | any other route (a dashboard, settings …), or a link whose id fails validation | `other` — listed, never queried | — |

- **Which tenants** — an allowlist. Only tenants **listed in `DYNATRACE_TENANTS`** (`setup/.env` / environment) or, when
  that is empty, `endpoints.dynatraceTenants` are ever contacted: `prod=abc12345,uat=def67890` (or a JSON object; an id
  is the first label of `<id>.apps.dynatrace.com` — lowercase letters, digits, `-`, no dots or slashes — and a label is
  plain text; anything else is dropped, never "fixed"). A host taken from ticket text only **selects which listed tenant
  a link belongs to**; the request URL is always `https://<listed tenant id>.apps.dynatrace.com/platform/storage/query/v1/…`,
  built from the validated id. A link to a tenant that is not listed is stored as `unconfigured-tenant` with the reason and
  **never fetched**. Both `DYNATRACE_PAT` and a tenant must be set; the run note names whichever is missing.
- **The time window**: the link's own `timeframe=custom<startMs>to<endMs>` (the tighter of the two) else
  `gtf=<iso> to <iso>`; a relative window (`gtf=-2h`) names none. Spans, logs and request counts are read in that
  window **padded by 5 minutes, at most 2 hours** (the end is clipped); Davis problems are few and small and get the
  window padded by 30 minutes, at most 7 days. A trace or log link **without** an absolute window is not queried (it would
  scan too much) — the item is `empty` with that note. A problem link without one looks back 35 days, a service link 24 hours.
- **What is asked** (`plan`; `inspect` prints it). Every query is read-only DQL, POSTed to `query:execute` with the
  window in the **request** (`defaultTimeframeStart` / `End`, never in the DQL), `maxResultRecords`,
  `maxResultBytes` (1 MB) and `defaultScanLimitGbytes` (2), `requestTimeoutMilliseconds` 15 s — Grail bills by bytes
  scanned, so every question is time-bounded and capped. A `202` / `RUNNING` answer is polled (`query:poll`, up to 6
  times, 1 s apart; a query that never finishes is a failed lookup, not an empty answer — and two of them mark the tenant down for the run). An id goes into DQL only after
  a strict regex (a trace id is hex, a service id `SERVICE-` + 16 hex, a problem id letters / digits / `_ . -`).

  | Link | Query (fields abbreviated) | Notes |
  |---|---|---|
  | trace | `fetch spans \| filter trace.id == "<id>" \| fields start_time, span.id, span.parent_id, span.name, duration, request.is_failed, request.is_root_span, http.request.method, http.route, url.path, http.response.status_code, service.name, dt.entity.service, span.status_code, span.status_message, exception.message, exception.type, span.events \| sort start_time asc \| limit 500` | if the tenant refuses the field list (HTTP 400) the same question is asked once more as `fetch spans \| filter trace.id == "<id>" \| limit 500`. Then, **only when the trace has failed spans that name services**, `fetch dt.davis.problems \| fields display_id, event.id, event.name, event.status, event.category, event.start, event.end, root_cause_entity_id, root_cause_entity_name, affected_entity_ids \| limit 200` over the problem window; the problems that name one of the trace's services are kept (filtered in Python). |
  | problem | `fetch dt.davis.problems \| filter display_id == "<id>" or event.id == "<id>" \| fields … \| limit 5` | |
  | service | the problems query above (no filter in DQL — filtered in Python to those that name the service) and, **with a window**, `fetch spans \| filter dt.entity.service == "<SERVICE-id>" and request.is_root_span == true \| summarize total = count(), failed = countIf(request.is_failed == true)` | |
  | logs | `fetch logs \| filter trace_id == "<id>" (or dt.entity.service == "<SERVICE-id>") and (loglevel == "ERROR" or status == "ERROR") \| fields timestamp, content, loglevel, status \| limit 200` | |

  The field names are the platform's documented ones, not verified against every tenant — a tenant that names a field
  differently shows up as a rejected query or an empty answer; `inspect` (below) shows what a real link returns.
- **What is stored** (`DynatraceItem`): the link (https, no credentials, ≤ 600 chars — a longer one is replaced by a short
  link that opens the same thing), `kind`, `host`, the tenant label, the window read, `status`, **findings** (≤ 8 short
  strings of ≤ 200 chars: "38 spans across 4 services (…)", "6 failed spans; the failure originates in …", "Error:
  SocketTimeoutException: Read timed out (×4)", the Davis problem and its root cause, "N of M root requests failed"),
  a small `summary` (spans, services, root request, status codes, grouped error messages, slowest span, first failure,
  problems, request counts, log groups) and `fetchedAt`. Never a raw dump: an item is ≤ 3 KB (`_fit` trims the findings,
  then the lists inside the summary). Error messages are grouped (numbers and ids normalised) and counted.
- **Status per item**: `read`, `empty` (the query ran and found nothing — "no spans for this trace in the window", a
  kind that is not read, no window, or a query the tenant rejected, with the reason in `note`), `unreachable`,
  `auth-failed`, `unconfigured-tenant`.
- **Auth**: `Authorization: Bearer $DYNATRACE_PAT` — a **platform token** — only in that header, never in a URL, a log
  line, the health file or `data.json`. TLS is always verified (a private CA from `JIRA_CA_BUNDLE` / `~/.ai/ca-bundle.pem`
  is added to the system roots); `JIRA_INSECURE_TLS` does **not** apply, `DYNATRACE_INSECURE_TLS=1` is Dynatrace's own
  last-resort opt-out (a WARN). Redirects are followed only within the same origin (`_safe_http.SameOriginRedirect`);
  a response over 2 MiB is refused.
- **Cost and politeness**: at most **200 calls per run** (`query:execute` and `query:poll` both count), 4 requests in flight,
  and a per-run cache: the same question (tenant, query, window) is asked once however many tickets name the link. An
  answer is **not asked for again while fresh**: 24 hours for a read link, 1 hour while a problem it shows is still `ACTIVE`,
  6 hours for an empty answer (spans can arrive late); `unconfigured-tenant` items cost nothing to re-evaluate. A refusal or failure of
  a question is remembered for the run too, and all Dynatrace work in one fetch is limited to **15 minutes** of wall-clock
  (then `budget-exhausted`, like the call budget).
- **Failure semantics** (same family as Jenkins / Checkmarx): a `401` marks the tenant down for the rest of the run
  (`auth-failed`, the only red); a `403` names the missing scope (spans and request counts `storage:spans:read`, problems
  `storage:events:read`, logs `storage:logs:read`) and blocks only that table for the run; a 5xx, 408, 429, a network
  error, an unreadable / oversized answer or a query that does not finish marks the tenant down (`unreachable`); one
  tenant being down does not stop the other. Any of those = the lookup FAILED: the link's **previous answer is carried
  forward, marked `stale: true`** (with none, the item is stored as `unreachable` / `auth-failed` with a note), the
  ticket gets `proofNotes.dynatrace` and the run line says how many were carried forward. A query that was accepted and
  then FAILED / CANCELLED on the tenant is a failed lookup too (carried forward and reported, the tenant is not marked down).
  A query the tenant rejects with another 4xx (a field it does not know) is an answer about the query, not about the
  service: `empty` with a note, the health dot is not touched — and an earlier read of the link is **kept (marked
  `stale`)** instead of being replaced by "nothing found". **Not configured** (no token or no tenant): nothing is asked, the prior
  answer is kept, `proofNotes.dynatrace` says so (quietly: grey). **No Dynatrace link in the ticket** → no field, no
  call, no note; a link removed from the ticket drops out of the field on the next run.
- **Visible status** (`_sources.py`, generalised with `finish(statuses=…, unit=…, flag=…)`): `data.json →
  proofSources.dynatrace` and a run note, e.g. "Dynatrace: 3 tickets with Dynatrace links looked up (5 links: 4 read ·
  1 empty) — 2 with failed requests or problems"; states `not-configured` (names the missing settings),
  `no-candidates`, `read`, `unreachable`, `auth-failed`, `budget-exhausted`. The API keys window's Dynatrace panel shows
  it as its "Last fetch" line; the dot beside it is `_health.py`'s latest real call (service id `dynatrace`).
- **What leaves the board**: nothing is sent to Dynatrace but the queries above. What comes back is **scrubbed**
  (`jira-intern/_scrub.py`: tokens, `Authorization` / `Bearer` values, `password=` / `token=` values, credentials in
  URLs, JWTs, secret-looking environment values, e-mail addresses, IPs) before it is stored, shown or given to an AI
  model, and is treated as untrusted third-party text by every consumer.
- **Token scopes** (a Dynatrace *platform token* with the read scopes the queries need): `storage:spans:read`,
  `storage:events:read`, `storage:logs:read`, `storage:buckets:read`. Create it under Account Management → Identity &
  access → Platform tokens ([SETUP.md](SETUP.md#dynatrace)). The dialog's **Test** sends `fetch dt.davis.problems | limit 1`
  over the last 7 days (`maxResultRecords` 1) to every listed tenant at once and answers "Connected" (or names the
  tenant that failed: token rejected, a missing scope, not found — check the tenant id); the token reaches only
  `https://<tenant id>.apps.dynatrace.com`, with the id validated again in Node.
- **`inspect`** — to see what the board makes of a link before trusting it, from your terminal (read-only; uses
  `setup/.env` and the config like the fetch; prints no token; exit 0 read · 1 Dynatrace could not be read · 2 not
  configured / not a Dynatrace link / unknown ticket):
  `python3 jira-intern/dynatrace.py inspect "<link>" [--no-read]` or `… inspect <TICKET-KEY> [--no-read]` (every link
  of the ticket as in `data.json`). It prints the tenant the link maps to and why a link is not read, the ids and window
  it parsed, the exact queries it would send, and — unless `--no-read` or Dynatrace is not configured — what they return,
  as findings. Run it from the repo checkout, or inside the JIRA-Board container.
- **Readers**: the drawer's Proof → **Linked traces & problems** group, the **Evidence** of the AI brief and the report's
  **Issue insight**, evidence rows and Sources links (`evidence.py`, shared by all three — [AI-PIPELINE.md](AI-PIPELINE.md)),
  and the worker's Proof table. Unlisted-tenant links are shown in the drawer, muted, with the reason.

## Confluence & links

No Confluence API calls in the scripted path — Confluence/external links are harvested from
ticket descriptions/comments by URL pattern (`extract_links`), keeping prior excerpts. The
LLM-agent fallback may read Confluence through MCP (policy string from `config.mjs policy`).

## The local server — complete API

`server/serve.mjs` routes (all under `http://localhost:4321`):

| Route | Does |
|---|---|
| `POST /api/run-intern` | Start the daily fetch (409 if any writer is busy). |
| `POST /api/run-archive?scope=all|year|since|key&…` | Start the archive rebuild. `POST /api/run-archive/stop` kills it. |
| `POST /api/run-raised` | Start the raised-by-me refresh. |
| `POST /api/refresh-ticket?key=K` | Queue a single-ticket refresh (FIFO, idempotent). |
| `POST /api/move-ticket?key=K&to=todo\|blocked\|hold\|prog\|rev\|qa\|qaip\|done\|next[&mode=force\|undo]` | Transition the ticket in Jira (`transition.py`). `qaip` is QA In Progress; `next` is Next Sprint — a sprint assignment through the Jira Agile API (nearest dated future sprint, else READY, else REFINEMENT; the ticket also becomes To Do), and a Next Sprint ticket can only go back `to=todo` (into the active sprint). The QA lane (a non-QA ticket into QA / QA In Progress; a QA ticket to To Do / In Progress / In Review) and the gates (In Review without a PR; Done with an open PR, no PR or no QA ticket) refuse with `{ok:false, blocked, reason, forcible}` — `forcible` is true for a gate. `mode=force` skips the gates, never the lane; `mode=undo` skips every check (the board's Undo). Replies with `{ok, moved, status, warnings}` / `{ok:false, blocked, reason, forcible}` / `{ok:false, error}`. On a real move, queues a refresh of that ticket. |
| `GET /api/intern-status` | THE poll: run state + job type (daily/archive/raised/external), lastExit, progress, refresh queue, report queues, AI status. |
| `GET /api/reports` · `GET /api/reports/<KEY>` · `POST /api/report?key=K` · `POST /api/reports/bulk?scope=…` · `POST /api/reports/stop` | PR-report index / one report / generate one / bulk / stop. |
| `GET|POST /api/settings` | Machine-wide settings (mirrored to `.settings.json`). |
| `GET /api/keys` · `POST /api/keys` `{ name, value }` | The API keys dialog: status of every key in `setup/api-keys.json` (`{ set, masked }` — never a full secret) / save one into `setup/.env` (`''` removes it; JSON ≤ 8 KB, single line, no surrounding quotes, ≤ 4096 chars, secrets printable ASCII, URL fields `https://`; only the named key changes). Details: [API.md](API.md#api-keys). |
| `POST /api/keys/test` `{ service }` | The dialog's **Test** button: one authenticated read with the saved key (`server/keycheck.mjs`) → `{ ok, service, status, httpStatus?, ms, detail }`; 409 while that service's test runs. Details: [API.md](API.md#api-keys). |
| `GET /api/ai-status` · `GET /api/ai-models` · `GET /api/cloud-models` · `POST /api/ai-models/pull` · `POST /api/ai-jobs` | Proxied to the AI intern. |
| static | Allowlist only: `/dist/`, `/help/` (`/help` → `/help/00-start-here.html`), `/docs/`, `/setup/`, `/ai-intern/{models,cursor-prices,cloud-models}.json`, `/jira-intern/data.js(on)`, `/jira-intern/reports/index.js`; never a dotfile (`setup/.env` is 404). Gzip + ETag/304, in-memory cache keyed by mtime. |

Client side, every route has a typed wrapper in `src/lib/runner.ts`; `src/lib/statusPoller.ts`
multiplexes all watchers onto ONE `/api/intern-status` request at the fastest subscribed rate.

## Docker topology

```
docker compose (project jira-project)
├─ JIRA-Board   :4321  server + fetch scripts (python3 + tini), REFRESH_ON_START/INTERVAL
├─ AI-Intern    :4322  worker.py (jobs: briefs, report enrichment, pulls)
└─ AI-Ollama    :11434 local inference (volume jira-ai-models)
shared mounts: ./jira-intern (DATA — follows the deploy directory!), ./config,
               ./setup (API keys in setup/.env — read-write for the board, read-only for
               the AI-Intern), ~/.ai (read-only, identity)
```

Image build: stage `dist-build` (npm ci + vite) **or** stage `dist-prebuilt` (host-built `dist/`
copied in), selected by `--build-arg DIST_SOURCE`; `scripts/start-jira-board.sh` host-builds and passes
`prebuilt` because in-image npm over the Docker VM's network silently drops optional native
binaries (TypeScript 7 platform packages). The runtime stage seeds `/opt/jira-intern-seed` so an
empty mounted volume gets a working skeleton on first boot.

## Config & settings precedence (identity, URLs, knobs)

```
config/jira-board.config.json      tracked, GENERIC defaults + policy (ports, repo hints, AI defaults…)
        ▲ deep-merged with
~/.ai/config.json ($AI_CONFIG_FILE) personal: your name, accountId, company base URLs   [outside repo]
        ▲ overridden at runtime by
jira-intern/.settings.json          what you change in the board's Settings (server-relevant slice)
```

`local-runner/config.mjs` is the single merger: `shellenv` (vars for the runners, incl.
`REFRESH_WORKERS`), `policy` (MCP policy string for agent prompts), `path`/`print` for debugging.
The app receives the non-secret slice as `window.__JIRA_CONFIG__` (written next to the data by
`datafile._app_config`). Secrets NEVER pass through this chain — they live in `setup/.env`
(filled from the board's API keys dialog; `JB_SECRETS_FILE` moves it) and scripts read it directly
into process env (`load_agent_secrets` / `load_env`; variables already set in the environment win).
`JIRA_URL` / `BITBUCKET_URL` / `CONFLUENCE_URL` saved there override `endpoints.*`.

## Scheduler

`server/schedule.mjs` runs the Settings cadences (active refresh daily/twice-daily; full refresh
and report backfill daily/weekly/twice-weekly), stamping `.schedule.json`, always through the
same `startDaily`/`startArchive` gates as the buttons — so scheduled and manual runs can never
overlap. In-container cron behaviour additionally honours `REFRESH_ON_START` / `REFRESH_INTERVAL`
(default: fetch on boot, then every 15 minutes).
