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
| `GET /api/keys` · `POST /api/keys` `{ name, value }` | The API keys dialog: status of every key in `setup/api-keys.json` (`{ set, masked }` — never a full secret) / save one into `setup/.env` (`''` removes it; JSON ≤ 8 KB, single line, no surrounding quotes, ≤ 4096 chars, secrets printable ASCII, URL fields `https://` — and a new URL clears its service's tokens). Details: [API.md](API.md#api-keys). |
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
