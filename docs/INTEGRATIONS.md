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

## Jenkins (multibranch pipelines, JSON API)

`jira-intern/jenkins.py` reads the **latest build of each of a ticket's branches, per environment**,
from the multibranch jobs listed in config → `jenkins.jobs.<repo slug>.<env>` ([CONFIG.md](CONFIG.md)).
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
  (dev-status branch URL → `repos`, or the PR URL's slug). Only repos in `jenkins.jobs`; a branch
  whose repo is unknown is tried in every configured repo. At most 12 (repo, env, branch) lookups
  per ticket and 800 calls per run; 8 requests in flight.
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
  engine** is used — SCA for CVEs and packages, SAST for queries, CWEs and result ids) → `GET /api/results?scan-id=…&limit=100&offset=…` (pages of
  100, at most 10 per scan). Projects, scans and results are cached for the run, so the base branch's scan is
  read once per repository, not once per ticket. At most 300 calls per run.
- **Status per target**, comparing the branch scan with the base scan:
  `fixed` — in the base scan and not open on the branch: absent, or there with status `FIXED`, or triaged
  `NOT_EXPLOITABLE` (the detail says "triaged rather than removed" — Checkmarx no longer counts it, but the
  code did not change); `open` — still detected on the branch; `not-found` — in neither scan (the ticket may
  name the wrong id); `unknown` — no verdict can be proved: the branch has no completed scan yet, or none
  that ran the target's engine ("branch scan did not run SCA/SAST"); the base has none to compare, or none
  that ran the engine ("base scan did not run SCA/SAST"); the branch scan is **older than** the base scan
  (a finding present on the base and absent from an older branch scan proves nothing — rescan the branch);
  the ticket names a per-scan result `id` instead of a `similarityId`; no project matches the repo; or a scan
  has more than 1,000 results (absence from a truncated read proves nothing). Matching: CVE ↔
  `vulnerabilityDetails.cveName` (or the SCA result id); query ↔ `data.queryName` ignoring case / `_` /
  spaces (a longer query name with the same start also matches); CWE ↔ `vulnerabilityDetails.cweId`; result
  ↔ `similarityId` **only** (stable across scans — a result's own `id` changes with every scan, so a target
  that matches a row's `id` is `unknown`, with a hint to name the similarityId); package ↔
  `data.packageIdentifier` (`Maven-org.x:lib-1.2.3`, `Npm-lodash-4.17.20`) — on the base any version (or
  the named vulnerable one); on the branch the named vulnerable version or one below the upgrade target,
  and with only a from-version ("lodash 4.17.20", no "to") ANY version still carrying an open finding keeps
  the target open.
  Each item stores severity (from the base scan when it was there), location (SAST `file:line`, SCA
  `package version`) and a one-line detail with both branches and scan dates.
- **Failure semantics**: a network error, `401`/`403`, another HTTP error, unreadable JSON or the call budget
  = the lookup FAILED: `vuln_fixes_for` returns None, the ticket keeps its previous `vulnFixes`, and after a
  network or auth failure Checkmarx is not asked again that run (run note "Checkmarx unreachable —
  vulnerability results carried forward"). "No project" / "no scan" are answers, stored as `unknown` with a
  `note`. Not configured → nothing asked, prior results kept. Not a vulnerability-fix ticket, no target named,
  or no PR → no field and no call.
- **Sub-tasks**: only the sub-task's own PRs (after `scope_to_subtask`) — it never inherits its parent's scan.
- **Readers**: the card's shield chip, the drawer's Proof → Vulnerabilities group, and the PR readiness
  report's "Security scan (Checkmarx) clean" gate + evidence rows (`pr_report.vuln_gate`, in the deterministic
  base — AI level None included — [AI-PIPELINE.md](AI-PIPELINE.md)).

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
