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
       BUT still re-apply sprint + re-check PRs (both mutate without touching `updated`)
  → fetch_raised() rides along (one parallel-paged JQL; see below)
  → write_outputs({tickets, completed: PRESERVED, raised, raisedAt, notes, user, generatedAt})
  → atomic_dump(.state.json)
```
The 10-day Done window is wider than the board's 3-day display window **on purpose**: a ticket
must never leave `tickets[]` before the weekly archive has captured it.

### 2. Archive rebuild — `completed_archive.py` (Archive menu; scopes all/year/since/key)

```
search: (assignee WAS currentUser() OR assignee = currentUser()) [+ scope]  → my keys
  → fetch each sub-task's PARENT (lineage only, marked mine:false)
  → dev-status batch → build rows in parallel → cache/<KEY>.json
  → assemble() → scoped: upsert_completed() | full: merge_completed_only()   (tickets[] untouched)
  → _refresh_raised(): raised[] rides along (sets raisedAt)
```
Flushes partial results every `FLUSH_EVERY` rows so a long rebuild shows progress on the board.

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
both `tickets[]` and `raised[]` copies, writes via `write_outputs`.

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
