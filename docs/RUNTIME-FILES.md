# Runtime files, locks and exit codes

Everything the pipeline, the server and the AI worker exchange at run time is a **file under
`jira-intern/`**. That is the IPC contract: a shell runner, a Python script, the Node server and
the Python worker — in one container, two containers or on the host — coordinate only through
these files. All of them are git-ignored; none is ever needed in a commit.

## The files

| Path (under `jira-intern/`) | Written by | Read by | What it is |
|---|---|---|---|
| `data.json` | `daily_fetch.py`, `completed_archive.py`, AI worker (briefs) — via `datafile.write_outputs` | everything | The canonical dump: `tickets[]`, `completed[]`, `notes[]`, `generatedAt`. Shape: `src/types.ts`. |
| `data.js` | same writers (`datafile.py`) and `local-runner/sync-datajs.mjs` | the browser on `file://` | `window.__JIRA_DATA__ = …; window.__JIRA_CONFIG__ = <config.app>;` — regenerated atomically with `data.json`. |
| `cache/<KEY>.json` | `completed_archive.py` (and the agent fallback) | `completed_archive.py` | Per-ticket archive cache; makes the archive rebuild resumable. `FRESH=1` wipes it. |
| `logs/*.log` | every shell runner | you | `run-*.log`, `completed-*.log`, `refresh-<KEY>-*.log`, `report-<KEY>-*.log`, `reports-backfill-*.log`, `reports-auto.log`. Rotated (40 daily, 60 report, 20 backfill). |
| `_STATUS.md` | `datafile.prepend_status` | you | Newest-first audit log of runs and notices ("Jira unavailable — showing last known state"). |
| `.state.json` | `daily_fetch.py` | `daily_fetch.py` | Incremental memory per ticket (last update seen, done-once flags). Unreadable → every ticket is rebuilt. |
| `.progress.json` | `progress.py` (both fetches) | `server/jobs.mjs` → `/api/intern-status` | `{ job, phase, done, total, pct, current, updatedAt }` for the header progress bar. Removed when idle. |
| `.settings.json` | `server/settings.mjs` (atomic temp + rename) | scheduler, runners (`config.mjs shellenv`), `ai_queue.py`, worker | Saved **Settings → Background jobs / AI** choices; overlays the project config. |
| `.schedule.json` | `server/schedule.mjs` | `server/schedule.mjs` | `{ activeAt, fullAt, reportAt }` last-run stamps; seeded with "now" on start. |
| `.ai-queue/<id>.json` | `server/ai.mjs`, `ai_queue.py enqueue` (CLI, runners, worker HTTP) | AI worker | One job per file. Claimed by renaming to `.json.running`; removed when finished. |
| `.ai-status.json` | AI worker (`ai_queue.write_status`) | `server/ai.mjs`, worker `/api/status` | `{ state, current, active[], lastError, pulling, pullProgress, queued, updatedAt }`. |
| `.ai-cancel-report` | `server/reports.mjs` (**Stop reports**) | AI worker `stop_requested()` | Marker: abandon enrich jobs claimed before its mtime; removed when the worker goes idle. |
| `.data.lock` | `datafile.data_lock` (advisory `flock`) | the Python writers | Serialises every read-modify-write of `data.json` across processes and containers. No content. |
| `.intern.lock` · `.completed.lock` · `.refresh.lock` · `.report.lock` | `run-intern.sh` · `update-completed.sh` · `refresh-ticket.sh` · `pr-reports-backfill.sh` | all runners, `server/locks.mjs`, worker (`data_writers_busy`) | Run locks — see below. |
| `.data.prev.json` · `.data.prev.<KEY>.json` | `run-intern.sh`, `refresh-ticket.sh` | the same script | Pre-run snapshot for crash recovery and the `aiSummary` carry-forward. Deleted at the end. |
| `reports/<KEY>.json` | `pr_report.py base`, AI worker (enriched, atomic) | `server/reports.mjs`, `sync-reports.mjs`, the app | One PR Readiness Report per ticket. Shape: `src/lib/reportTypes.ts`. |
| `reports/.status.json` | `pr_report.py status-add/remove` (runners, worker) | `server/reports.mjs externalGenerating`, `sync-reports.mjs` | `{ generating: { KEY: { pid, startedAt } } }` — who is building what; dead PIDs and rows older than 25 min are ignored. |
| `reports/.base-<KEY>.json` | AI worker | AI worker | Snapshot of the deterministic base while enriching; restored on failure, deleted after. |
| `reports/index.js` | `local-runner/sync-reports.mjs` | the browser on `file://` | `window.__JIRA_PR_REPORTS__` — every report inlined, plus `generating`. |
| `demo/data.json` | you (by hand) | the board in Demo mode, `src/demo/data.ts` (compiled copy) | The sample board behind Settings → Demo mode — invented tickets, kept beside the real dump so they can be read and edited. **Tracked in git**, unlike the real dump. |
| `models/` | Ollama (pulls), you (`*.gguf`) | `server/ollama.mjs` (gates the container), Ollama (`/root/.ollama`) | Ollama's whole store plus hand-dropped weights. The AI-Ollama container runs only when Settings' toggle is on **and** this holds a model. |

Paths the Node server knows are listed in `server/config.mjs` `PATHS`; the Python side builds the
same names from `INTERN = dirname(__file__)`.

## Locks

`data.json` has **one writer at a time**. Each runner owns one lock file and refuses to start
while any sibling lock is held:

| Runner | Takes | Refuses while held |
|---|---|---|
| `run-intern.sh` (active tickets) | `.intern.lock` | `.completed.lock`, `.refresh.lock` |
| `update-completed.sh` (archive) | `.completed.lock` | `.intern.lock`, `.refresh.lock` |
| `refresh-ticket.sh KEY` | `.refresh.lock` | `.intern.lock`, `.completed.lock` |
| `pr-reports-backfill.sh` | `.report.lock` | (its own only — reports read `data.json`, they don't write it) |

**Format.** One line: `<pid> <ISO-8601 UTC timestamp> <hostname>` — for example
`4242 2026-10-08T07:15:02Z 3f9c1a2b7d4e`. In Docker the hostname is the container id. Older
readers that only parse the first two fields keep working. The AI worker (`data_writers_busy`)
runs in another container, so it ignores PIDs and treats a lock as held until it is older than
that job's own timeout (`timeouts.dailySec` / `weeklySec` / `refreshSec`).

**Acquisition** is atomic: `lock_acquire` creates the file with `noclobber` (`O_EXCL`), so two
runners that both saw "free" cannot both win; it retries once after clearing a stale lock. A
runner that loses exits **3**.

**Staleness** — three rules, implemented identically in `jira-intern/local-runner/lock-util.sh`
and `server/locks.mjs`:

1. **Dead PID (same host) → stale.** Recovers from a SIGKILLed runner whose EXIT trap never ran.
2. **No usable PID (missing, 0 or 1) → stale after 45 min** (`LOCK_MAX_AGE_SEC=2700` /
   `LOCK_MAX_AGE_MS`). Age is all there is to go on.
3. **Live PID (same host) → held**, however old — an archive legitimately runs for hours — **until
   the 8 h hard ceiling** (`LOCK_HARD_MAX_AGE_SEC=28800` / `HARD_MAX_AGE_MS`): after a container
   recreate the PID may belong to an unrelated process.

A lock written on **another host** (your Mac vs the container, or a previous container) is judged
by rule 2 only — its PID means nothing in this PID namespace. The entrypoint additionally removes
locks whose owner is a *previous container id* at boot, since every process of that container is
gone. Stale locks are deleted on sight so the runners stop refusing work. A lock whose PID is the
Node server's own PID (a leftover from an `exec node` entrypoint) counts as stale too.

The Python writers hold **`.data.lock`** (`fcntl.flock`, re-entrant per thread) around each
read-modify-write of `data.json`/`data.js`, which protects the AI worker's brief writes and any
two scripts started from different containers. On Windows (no `fcntl`) only the run locks apply.

## Exit codes

Shell runners return these; the board maps them to toasts (`exitMessage` in
`src/hooks/useInternJobs.ts`), and the entrypoint logs them.

| Code | Meaning | Who |
|---|---|---|
| **0** | OK (also: archive finished *partially* — see 4) | all |
| **1** | Failed: nothing usable produced (Jira HTTP error such as an expired PAT, host unreachable, every ticket build failed, `needs-report` failed, or any report in a backfill failed) | Python scripts, `pr-reports-backfill.sh` |
| **2** | **Configuration error — no Jira token.** The fetch re-stamps the last dump with a notice and stops; the runner does **not** fall back to the LLM agent (it would hit the same wall). Also: bad usage / bad key, `pr-report.sh` on a ticket without a PR or with no `data.json`. | `daily_fetch.py`, `completed_archive.py`, runners |
| **3** | **Locked / skipped** — another refresh or archive holds a lock. Nothing was done; try again later. | all runners |
| **4** | **Partial** (`completed_archive.py` only): some tickets failed to rebuild, their previous rows were kept and the rest were merged. `update-completed.sh` logs a `WARN` and **exits 0**. | `completed_archive.py` |
| **6** | Unrendered prompt — the agent fallback refused to run because `config.mjs render` left `{{TOKENS}}` in the prompt (no identity, no MCP policy). | `run-intern.sh`, `update-completed.sh` |
| **124** | Timeout (`timeouts.dailySec` 1800 s, `weeklySec` 7200 s, `refreshSec` 600 s). The archive resumes from `cache/` next run. | runners |
| **127** | Agent CLI not found — the fast path failed *and* the fallback connector (`cursor-agent`, `claude`, `codex`) is not installed. In Docker this means the Python path failed; read its log. | runners |
| **130 / 143** | Interrupted (SIGINT / SIGTERM). The EXIT trap removes the lock. | runners |

The Node server reports a signal-killed child as **1** so a stopped job never looks successful.

## The AI queue

A job file (`.ai-queue/<id>.json`) is a flat JSON object:

```json
{
  "id": "1759907702123-PROJ-123",
  "type": "enrich-report",
  "key": "PROJ-123",
  "level": "moderate",
  "backend": "local",
  "model": "qwen2.5-coder:7b",
  "cloudProvider": "cursor",
  "cloudEffort": "low",
  "useHostOllama": false,
  "enqueuedAt": "2026-10-08T07:15:02Z"
}
```

`type` is `enrich-report`, `summarize-active` or `pull-model` (`model` = Ollama tag). Keys are
validated against `^[A-Z][A-Z0-9]+-\d+$` and model tags against
`^[a-z0-9][a-z0-9._-]*(:[a-z0-9._-]+)?$` on every enqueue path. Lifecycle: `*.json` (pending) →
rename to `*.json.running` (claimed) → deleted (done or failed). A `.running` file older than
30 min is treated by the board as a crashed claim; the worker renames every `.running` back to
pending on start. `summarize-active` and `pull-model` run one at a time; enrich jobs run up to
`reportParallel` wide (1–10).

## How to debug a failed fetch

1. **What did the board say?** The toast after Refresh carries the exit code's message
   (`another refresh/archive was already running` = 3; `tooling missing` = 127; otherwise a
   generic failure). `/api/intern-status` shows `lastExit`, `job`, `running` and `progress`.
2. **Read the runner log.** `ls -t jira-intern/logs/ | head` — the newest `run-*.log`
   (daily), `completed-*.log` (archive) or `refresh-<KEY>-*.log`. The Python fast path prints a
   one-object JSON summary at the end (`{"error": "jira http", "status": 401, …}` is an expired
   token; `"jira unreachable"` is DNS/VPN; `"no jira token"` is configuration).
3. **Check `_STATUS.md`.** The top line is the most recent notice the fetch left for you.
4. **Container logs.** `docker logs JIRA-Board` shows the entrypoint (`secrets file present…`,
   `refresh done` / `refresh skipped — another job holds the data lock` / `refresh failed
   (exit N)`) and the scheduler (`[schedule] active ticket refresh`). `docker logs AI-Intern`
   shows enrichment (`PROJ-123 enriched via …` or `job failed: …`); its `/health` turns 503 when
   a worker thread has died.
5. **Locks.** `cat jira-intern/.intern.lock` (or `.completed.lock`, `.refresh.lock`): if the
   hostname is a stale container id or the PID is dead, the next run clears it itself. A lock
   from a *host* run blocks a container run for up to 45 min — stop the host run or delete the
   file once you are sure nothing is running.
6. **TLS.** `certificate verify failed` → `JIRA_CA_BUNDLE` ([SECURITY.md](SECURITY.md#tls-posture)).
7. **Reproduce by hand.** `docker exec -it JIRA-Board bash jira-intern/local-runner/run-intern.sh`
   (or on the host, with Python 3.11+ and your secrets file in place). `python3
   jira-intern/daily_fetch.py` runs the fast path alone and prints its JSON summary.
8. **Data sanity.** `node -e 'JSON.parse(require("fs").readFileSync("jira-intern/data.json","utf8"))'`
   — the runners restore the pre-run snapshot automatically if a run leaves `data.json` invalid.
