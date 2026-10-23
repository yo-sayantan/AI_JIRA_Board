# Data flow — every file, every writer, every rule

The system is a set of plain files under `jira-intern/` plus browser `localStorage`. This
document is the complete inventory: who writes what, when, and the invariants that keep it safe.

## File inventory

| File | Written by | Read by | Notes |
|---|---|---|---|
| `jira-intern/data.json` | daily fetch · archive rebuild · raised refresh · per-ticket refresh · AI brief merge | server (`/jira-intern/data.json`), scripts | **The canonical dump.** Shape = `src/types.ts::JiraData`. |
| `jira-intern/data.js` | same writers (via `datafile.write_outputs`) | the app on `file://` (`window.__JIRA_DATA__`, `__JIRA_CONFIG__`) | Must ALWAYS equal data.json; `sync-datajs.mjs` is the shell-side safety net. |
| `jira-intern/cache/<KEY>.json` | archive rebuild · per-ticket refresh | archive `assemble()` | Per-ticket rich rows; `SCHEMA` version in `completed_archive.py` busts stale shapes. |
| `jira-intern/reports/<KEY>.json` + `reports/index.js` | `pr_report.py` · AI enrichment · `sync-reports.mjs` | app (served: `/api/reports*`; file://: `index.js`) | PR Readiness Reports; staleness by PR fingerprint. |
| `jira-intern/.state.json` | daily fetch / per-ticket refresh | daily fetch | Hidden memory: per-key `(status, updated, comments…)` snapshot powering the unchanged-ticket fast path. Corrupt = "treat all as changed", never fatal. |
| `jira-intern/.progress.json` | all long jobs (`progress.py`) | `/api/intern-status` | Drives the header buttons' live fill (`done/total/pct/phase/current`). Deleted when idle. |
| `jira-intern/.settings.json` | server (`server/settings.mjs`) | `config.mjs shellenv`, worker | The server-relevant slice of Settings (AI level/backend/model, parallelism, cadences). |
| `jira-intern/.schedule.json` | scheduler | scheduler | Last-run stamps for the cadences. |
| `jira-intern/.ai-queue/` + `.ai-status.json` | server/scripts enqueue; worker consumes | worker, `/api/ai-status` | File-based job queue to the AI intern. |
| `jira-intern/logs/`, `_STATUS.md` | every runner | humans | Newest-first audit log (`prepend_status`). |
| Locks: `.intern.lock` `.completed.lock` `.refresh.lock` `.raised.lock` | each runner (`<pid> <iso>`) | `refuse_if_locked`, `server/locks.mjs` | Dead-PID/stale locks are auto-cleared. |
| `setup/.env` | the board's API keys dialog → `server/secrets.mjs` (one write queue, temp + rename, mode 0600; keeps comments and unknown lines) | `_config.py::secrets_path`/`load_secrets`, runners (`runner-env.sh` `APP_SECRETS` → `load_agent_secrets`), `docker-entrypoint.sh` (Jira-token check), worker (re-read per cloud call), server (`GET /api/keys`, masked) | Tokens only — the ONLY secrets file. Git-ignored, docker-ignored, never served. Key names: `setup/api-keys.json`. `JB_SECRETS_FILE` moves it. Mounted read-write into JIRA-Board, read-only into AI-Intern. |
| `jira-intern/.jenkins-discovery.json` | `jenkins_discovery.discover` (atomic temp + rename; only a COMPLETE walk is stored) | `jenkins_discovery.discover` (daily fetch, single-ticket refresh, the `discover` CLI) | Per root + repo slug + discovery-config signature: the application folders and pipelines (name, url, env, kind, via, param) found under `JENKINS_ROOT_URL`. TTL `jenkins.discovery.cacheMinutes`; a failed walk serves the stale entry. No credentials. Git- and docker-ignored runtime state. |
| `jira-intern/.health/<serviceId>.json` | EVERY outside client after a real call, success and failure: `_health.record*` from `_jira.get_json` / `jira_post` (jira, bitbucket), `jenkins._get` (and the console read), `checkmarx._call`, `dynatrace._request`, `ai-intern/worker.py` (`http_json`, `_cloud_json`, `mcp_get`: claude, cursor, gemini, openai, and Jira/Bitbucket reads); the server from the Test button (`server/health.mjs`, source `test`) | `server/health.mjs` → `GET /api/keys/health` → the API keys dialog's permanent dots and the header key button's badge | One small file per service (a writer touches only its own; temp + rename, so Python and Node never corrupt each other). `{ service, state: ok\|attention, checkedAt, lastOkAt?, failingSince?, status?, httpStatus?, detail, source }` — `detail` is built from fixed texts + the host, never a secret, header or URL query. Throttled: an unchanged outcome is not rewritten within 60 s. A 404 on a per-ticket / per-branch lookup is not a service failure and is never recorded. Git-ignored, docker-ignored, never served (dot-segment); lives in the bind-mounted `jira-intern/`, so the JIRA-Board and AI-Intern containers share it. `JB_HEALTH_DIR` moves it. |
| `setup/api-keys.json` | developers (tracked) | `server/secrets.mjs` (which names may be saved), `src/lib/apiKeys.ts` (the dialog), `tests/test_api_keys.py` | The list of services and keys: `kind` (secret · url · email · text) and `planned`. No values. |
| `~/.ai/config.json` | **you** (outside repo) | `config.mjs` merge | Identity + company URLs. |
| localStorage (`jb-settings`, `jb-archived`, `jb-completed-show-context`, `jb-guide-os`) | the app | the app | Preferences only; no cookies exist. |

## The dump's top-level shape

```jsonc
{
  "generatedAt": "…",          // freshness pill
  "user": { name, accountId, jiraBase },
  "tickets": [Ticket…],        // ACTIVE work assigned to me (rich; incl. recent Done)
  "completed": [CompletedTicket…], // full history ever assigned to me (archive owns it)
  "raised": [RaisedTicket…],   // every non-sub-task ticket I REPORTED (compact)
  "raisedAt": "…",             // when raised[] itself was last re-fetched
  "notes": ["dated run notes…"]
}
```

## Writers and exactly what they touch

### 1. Daily fetch — `daily_fetch.py` (via `run-intern.sh`, button "Refresh board")

```
search: assignee = currentUser() AND (not Done OR resolved >= -10d)   [expand=changelog]
  → + QA tickets NOT assigned to me (qa_rules.is_qa_ticket): ones I reported (`reporter = currentUser()`)
    and ones linked to my tickets — fetched by key, then built like any ticket. A failed lookup carries
    the earlier QA tickets forward instead of dropping them.
  → ONE batched `parent in (…)` search for all sub-tasks
  → ONE parallel dev-status batch (devinfo.fetch_many) for parents + subtasks
  → build tickets in a ThreadPoolExecutor (REFRESH_WORKERS)
       unchanged fast path: (status, updated) match .state.json → deep-copy prior,
       BUT still re-apply sprint + re-check PRs + re-read Jenkins builds + Checkmarx scans + Dynatrace links (all mutate without touching
       `updated`; Dynatrace re-asks only what is older than its TTL — 24 h read, 1 h an open problem, 6 h an empty answer)
       every full ticket: apply_builds → jenkins.py → ticket.builds (latest build per env of its own branches;
         lookup failed → prior builds carried, each marked `stale: true`; Jenkins not configured → prior
         builds kept unchanged, nothing asked)
       every full ticket: apply_vuln_fixes → checkmarx.py → ticket.vulnFixes (vulnerability-fix tickets with a
         named target and a PR only: branch scan vs base scan per target; lookup failed or Checkmarx not
         configured → prior vulnFixes kept; not a vulnerability fix / nothing named / no PR → field removed)
         and `ticket.proofNotes.checkmarx` (why a candidate has no fresh answer: not configured / failed), and
         every ticket is reported to `_sources.py` (skipped / looked up / waiting)
       every full ticket: apply_builds also puts the scrubbed console tail on the latest failed build of a ticket about
         a failing build / pipeline (`builds[].consoleTail`, jenkins.py)
       every full ticket: apply_dynatrace → dynatrace.py → ticket.dynatrace (the Dynatrace links in its text, read-only,
         listed tenants only; a failed lookup keeps each link's previous answer marked `stale`; not configured → prior kept;
         no link → field removed) and `ticket.proofNotes.dynatrace`; reported to `_sources.py` like Checkmarx
  → fetch_raised() rides along (one parallel-paged JQL; see below)
  → proof_sources_status(): `_sources.finish` → one state + one line per source ("Checkmarx: 3 vulnerability-fix
    tickets looked up …", "Dynatrace: 3 tickets with Dynatrace links looked up (5 links: 4 read · 1 empty) …") appended to
    `notes` and stored as `proofSources` (other sources' records kept)
  → write_outputs({tickets, completed: PRESERVED, raised, raisedAt, proofSources, notes, user, generatedAt})
  → atomic_dump(.state.json)
```
The 10-day Done window is wider than the board's 3-day display window **on purpose**: a ticket
must never leave `tickets[]` before the weekly archive has captured it.

**QA sub-tasks in `completed[]`.** The archive nests a closed ticket's own sub-tickets (`mine: true`) and, in
addition, the parent's QA / test sub-tasks whoever owns them (`mine: false`, `qa_rules.is_qa_ticket`): the
closure report's "QA / test sub-task done" gate reads `subtasks[]`, and a tester usually owns the QA ticket, so
without it every closed ticket read "no QA sub-task on the ticket". One batched `parent in (…)` search per 100
parents (`completed_archive.fetch_qa_children`); a failed search keeps the QA sub-tasks the cached row had. Active
tickets never had this gap — the daily fetch's `parent in (…)` search takes every sub-task. Older archive rows get
their QA sub-tasks on the next archive rebuild.

**`Ticket.builds`** (Jenkins, `src/types.ts::JenkinsBuild`) is written ONLY here and by the per-ticket
refresh below — `daily_fetch.apply_builds` for every fully built ticket (mine, my sub-tasks, QA extras;
never a team-mate's basic sub-task). Every other writer carries it untouched: the archive never rewrites
`tickets[]`, `write_briefs` stamps only `aiSummary*`, the raised refresh touches only `raised[]`, and
`_merge_ticket` replaces every copy of a ticket (its card and the copy nested under its parent) with the
freshly built one. A build carried forward because Jenkins could not be read (whole lookup, or just that
environment) gets `builds[].stale = true`: the chip tooltip says "Stale — Jenkins could not be re-read; this is
the last build seen", and `pr_report.jenkins_ci` makes the CI gate **Not verified** (never Pass) with the
build's age. With a Jenkins root, `apply_builds` first asks `jenkins.discovery_for` which pipelines exist for the
ticket's repos (cache → walk → stale cache); a repo that could not be discovered keeps its prior builds (stale).
A discovered build also carries `pipeline` / `kind` / `via`; one environment may hold several. Readers: the card's build chips, the drawer's Proof section, `pr_report.py` (CI gate,
evidence rows, fingerprint) and `ai-intern/worker.py` (via `pr_report.jenkins_ci`).

**`Ticket.vulnFixes`** (Checkmarx One, `src/types.ts::VulnFixes`) follows the same rules — written ONLY by
`daily_fetch.apply_vuln_fixes` (full path, fast path `refresh_prs_only`, single-ticket refresh), carried
untouched by `write_briefs`, the raised refresh and `_merge_ticket`. The archive rebuild never asks Checkmarx:
`completed_archive.carry_vuln_fixes` keeps the cached row's `vulnFixes`, else the copy in the current
`tickets[]` / `completed[]`, and `vulnFixes` is in `COMPLETED_KEYS`. Readers: the card's shield chip, the
drawer's Proof section, `pr_report.py` (security gate, evidence rows, fingerprint) and `ai-intern/worker.py`
(via `pr_report.vuln_gate` / `vuln_proof_rows`; it looks Checkmarx up live with the same `checkmarx.py` only
for a vulnerability ticket the dump has no results for, and never writes `data.json`).
`vulnFixes.read` (what each scan returned) and the package items' `foundOnBase` / `foundOnBranch` ride inside
it. **`Ticket.proofNotes`** and the top-level **`proofSources`** (`SourceStatus`: state, one line, `at`, counts,
the keys of tickets waiting) are written ONLY by the daily fetch (`proofNotes` also by the single-ticket
refresh); every other writer passes them through, the archive does not keep `proofNotes`. They are the
visible account of a skip — not part of the report fingerprint.

**`Ticket.dynatrace`** (Dynatrace, `src/types.ts::DynatraceEvidence`) is the third proof-source field and follows the
same rules: written ONLY by `daily_fetch.apply_dynatrace` (full path, fast path `refresh_prs_only`, single-ticket
refresh — nothing else asks Dynatrace), carried untouched by `write_briefs`, the raised refresh and `_merge_ticket`.
`{ fetchedAt, items[≤5], moreLinks? }`; an item is one Dynatrace link of the ticket's text with `status` (`read` ·
`empty` · `unreachable` · `auth-failed` · `unconfigured-tenant`), short `findings`, a small `summary` and its own
`fetchedAt` — ≤ 3 KB, scrubbed, never a raw response. A ticket with no Dynatrace link has no field; a failed lookup keeps
the item's previous answer with `stale: true`; an answer still inside its TTL is reused without a call. The archive does
not keep it (`COMPLETED_KEYS` has `vulnFixes` only), `raised[]` rows do not carry it. Readers: the drawer's Proof →
Linked traces & problems group, `evidence.py` (→ `pr_report.py`: Issue insight, evidence rows, Sources links, fingerprint
only when present; → `ai-intern/worker.py` + `brief.py`: the brief's Evidence section, the worker's Proof rows).
`proofNotes.dynatrace` (why a ticket with links has no fresh answer) and `proofSources.dynatrace` (the run's state + line;
the key window's "Last fetch") are written by the daily fetch like Checkmarx's.

**`builds[].consoleTail`** (a scrubbed string, ≤ 4 KB / ~40 lines) is part of `Ticket.builds` and written only by
`jenkins.add_console_tails` inside `apply_builds`: the latest failed, non-stale build of a ticket that is about a build /
pipeline failure carries one; it is kept while the build number is unchanged (no re-read), dropped when the build moves on,
and `""` means "tried, nothing to excerpt" (kept so it is not re-read; no view shows it). The report fingerprint includes
it only when present.

**`Ticket.aiSummaryEvidence`** (a 16-hex fingerprint, also on `raised[]` rows) is written by `write_briefs` together with
`aiSummary` / `aiSummaryAt` and says which evidence (Dynatrace / Checkmarx / Jenkins, `evidence.fingerprint`) the brief
was written from; it is removed when the new brief had none. Dynatrace, Checkmarx and Jenkins never bump Jira's `updated`,
so `brief.needs_brief` compares it with the fingerprint of what the dump says now and the brief is regenerated when they
differ. It travels with the brief wherever `aiSummary` is carried forward (`build_ticket`'s fast path,
`carry-aisummary.mjs`, `raised.fetch_raised`).

### 2. Archive rebuild — `completed_archive.py` (Archive menu; scopes all/year/since/key)

```
search: (assignee WAS currentUser() OR assignee = currentUser()) [+ scope]  → my keys
  → fetch each sub-task's PARENT (lineage only, marked mine:false)
  → /rest/api/2/myself → who "me" is (the changelog names people by user KEY; config identity as fallback)
  → rows: every CLOSED key + every key of mine that is OPEN and no longer assigned to me (taken from me)
  → one `parent in (…)` search per 100 parents: QA sub-tasks + sub-tickets I raised (nested, mine:false)
  → dev-status batch → build rows in parallel → cache/<KEY>.json
       each row of mine: takenFromMe = taken.analyse(changelog, resolution, PRs, comments) — None when not taken;
       identity unknown → the cached verdict is carried forward
  → assemble() → scoped: upsert_completed() | full: merge_completed_only()   (tickets[] untouched)
  → _refresh_raised(): raised[] rides along (sets raisedAt)
```
Flushes partial results every `FLUSH_EVERY` rows so a long rebuild shows progress on the board.
A row taken from me that is still open keeps its real `column` and `done: false` (`completed_entry`), and sorts by the
day it left me (`_row_date`). Such a ticket leaves `tickets[]` (it is no longer assigned to me) and reappears here on
the next archive rebuild. Older rows get `takenFromMe` on that rebuild too (SCHEMA 6).

### 3. Raised refresh — `daily_fetch.py --raised` (via `refresh-raised.sh`, the view's button)

```
fetch_raised(): JQL reporter = currentUser() AND issuetype not in subTaskIssueTypes()
  page 1 reveals total → remaining pages fetched CONCURRENTLY (REFRESH_WORKERS)
  per row: fields + changelog only → status/column, assigneeLog (hand-offs),
           updateLog (status timeline), issue links + epic, description (light HTML)
  carries aiSummary/aiSummaryAt forward from prior rows; re-sorts created-desc
  → data.raised replaced wholesale (HARD refresh: updates + discoveries + removals)
  → raisedAt + generatedAt stamped; everything else preserved
```

### 4. Per-ticket refresh — `daily_fetch.py --key K` (card refresh button, FIFO queue)

Re-fetches ONE issue (+ its sub-tasks) with `force_refresh`, Bitbucket skipped
(`enrich_open=False` — dev-status only), replaces EVERY copy of the key (own card, nested under
parent, archive row) via `_merge_ticket`, updates the raised row if present — and if the ticket
is raised-only and not assigned to me, it does NOT get appended to `tickets[]` — unless it is a QA ticket, which belongs on the board.

### 5. AI brief merge — `worker.py::write_briefs`

Reads the CURRENT data.json (inference takes minutes; the start-of-job copy may be stale), waits
out data-writer locks, applies each brief only if the ticket's `lastUpdate` still matches, stamps
both `tickets[]` and `raised[]` copies (`aiSummary`, `aiSummaryAt` and the `aiSummaryEvidence` fingerprint), writes via
`write_outputs`.

## Concurrency model

- `server/jobs.mjs` keeps in-memory flags (daily/archive/raised) and consults lock files
  (`dataWriterBusy`). Starting any writer while another runs → HTTP 409; the UI then attaches to
  the running job instead (`useInternJobs.begin`).
- Per-ticket refreshes queue FIFO (`KeyQueue`), one child at a time, blocked while any big writer
  runs.
- Shell runners `refuse_if_locked` (exit 3) against every other writer's lock, then write their
  own `<pid> <timestamp>` lock; dead-PID locks are cleared by both shell and server.
- The AI worker is NOT lock-exempt: `write_briefs` polls `data_writers_busy()` before merging.

## Frontend load & reload path

```
window.__JIRA_DATA__ (data.js)  ──▶ useBoardData → loadData → prepare():
   normalise columns → retire expired/user-archived Done tickets into completed[]
   (dedup by key; archive's richer row wins) → BoardView via splitBoard()
reload(): served → fetch /jira-intern/data.json (ETag; in-place swap, latest-wins seq guard)
          file:// → location.reload() to re-read data.js
indexByKey: tickets ∪ completed(adapted) ∪ raised(adapted, LAST) ∪ all nested subtasks
```

## Failure philosophy (applies everywhere)

A failed lookup **carries forward** the previous value and says so in `notes`/`_STATUS.md`;
it never writes an empty collection. Examples: Bitbucket down → PR data carried; sub-task search
failed → prior subtree kept; raised search failed → prior list kept (`ok=False` → note); no Jira
token → entire prior dump re-stamped with a note. "Couldn't fetch" and "there is nothing" are
different facts and must never be conflated.
