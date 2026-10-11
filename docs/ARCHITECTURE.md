# Architecture — how it works

> **The full documentation suite** — this file is the overview; the deep dives live beside it:
> [`AGENTS.md`](AGENTS.md) (onboarding for engineers & AI agents — start there),
> [`FEATURES.md`](FEATURES.md) (every feature + where its code lives),
> [`DATA-FLOW.md`](DATA-FLOW.md) (every file, writer, lock and lifecycle),
> [`AI-PIPELINE.md`](AI-PIPELINE.md) (briefs, report enrichment, models),
> [`INTEGRATIONS.md`](INTEGRATIONS.md) (Jira/Bitbucket, the HTTP API, config chain),
> [`RUNTIME.md`](RUNTIME.md) (containers, agents, queues, runbook).

## The one idea

The board **never talks to Jira**. A separate pipeline (`jira-intern/`) fetches your tickets on
a schedule and writes them to a plain data file. The UI is a static single-page app that reads
that file. Decoupling the two means the app is a fast, dependency-free `dist/index.html` you can
double-click, and refreshing the data **never rebuilds the app**.

```
  ┌─────────────┐   fetch (Python/agent)   ┌──────────────────────┐   reads    ┌───────────────┐
  │    Jira      │ ───────────────────────▶ │  jira-intern/data.js  │ ─────────▶ │  dist/         │
  │  Confluence  │   tokens from            │  window.__JIRA_DATA__  │            │  index.html    │
  │  Bitbucket   │   setup/.env (key dialog)│  window.__JIRA_CONFIG  │            │  (React app)   │
  └─────────────┘                          └──────────────────────┘            └───────────────┘
```

## The two halves

### 1. `jira-intern/` — the data pipeline ("the intern")

Python scripts (plus an optional AI pass) that produce two files:

- **`jira-intern/data.json`** — the canonical, parseable dump.
- **`jira-intern/data.js`** — `window.__JIRA_DATA__ = <that json>;` so the app can load it from
  `file://` with no server. Also carries `window.__JIRA_CONFIG__` (the `app` branding block),
  so branding re-themes at runtime with no rebuild.

Key scripts:

| File | Role |
|---|---|
| `daily_fetch.py` | Pull active tickets assigned to you → `data.json` / `data.js`. Also refreshes one ticket in place (`--key`) or only the raised list (`--raised`). |
| `completed_archive.py` | Build the full historical "Completed" archive (also re-fetches `raised[]`). |
| `raised.py` | Raised-by-me fetch (every non-sub-task ticket you REPORTED): one parallel-paged JQL, assignee hand-off log from the changelog, issue links. Shared by the daily fetch, the archive and the view's own refresh. |
| `_jira.py` · `devinfo.py` | Shared Jira/Bitbucket HTTP, field formatting, and branch/PR dev-info used by both fetches. |
| `local-runner/*.sh` | Thin wrappers: daily, weekly, per-ticket refresh, PR reports. All source `runner-env.sh` for locks, timeouts and agent lookup. |
| `local-runner/config.mjs` | Deep-merges the project config + personal override into shell vars, rendered prompts, MCP policy, and UI defaults. |
| `prompts/intern-prompt.md` | The schema the fetch must produce, in prose — mirrors `src/types.ts`. |
| `config/jira-board.config.json` | **Canonical project defaults/policy** for identity placeholders, endpoints, AI, reports, archive, refresh, UI, timezone, and branding. |
| `config/jira-board.config.schema.json` | Validation and editor completion for the central config. |
| `pr_report.py` | **PR Readiness Reports** — deterministic base per ticket-with-PR → `reports/<KEY>.json`; validation; staleness by PR fingerprint. |
| `ai_queue.py` | File queue `jira-intern/.ai-queue/` for JIRA-AI-Intern jobs (enrich, summarize, pull-model). |
| `ai-intern/worker.py` | Queue worker + HTTP (`/health`, `/api/models`, `/api/cloud-models`, `/api/jobs`). Local Ollama, Claude Messages, or Cursor Cloud Agents. |
| `prompts/pr-readiness-prompt.md` | The AI enrichment brief (evidence chain, per-file assessment, risks, release gate) — mirrors `src/lib/reportTypes.ts`. |
| `local-runner/pr-report.sh` · `pr-reports-backfill.sh` | One ticket / every ticket-with-PR of a year. Writes the base then enqueues enrichment. |
| `local-runner/sync-reports.mjs` | `reports/*.json` → `reports/index.js` (`window.__JIRA_PR_REPORTS__`) so reports open on `file://` too. |

**PR Readiness Reports** are a second data file family beside `data.json`: one JSON per ticket in
`jira-intern/reports/` (git-ignored). The app renders them generically from a fixed set of block
kinds (callout · stats · table · cards · list · timeline · links · kv), each tagged with a tone and a
provenance (`derived` / `ai` / `unknown`), so the deterministic base and the AI-enriched version use
the same component. In served mode the app reads `/api/reports*`; on `file://` it reads
`reports/index.js`. "Generating" state is a `.status.json` of PIDs that both the server and the
`file://` sync consult, so a cron-launched generation still shows a spinner in the drawer.

The fetch needs only a **Jira token**. Confluence/Bitbucket tokens and MCP servers are optional
and only enrich the output (linked docs, real branches, PR state, AI briefings).

### 2. `src/` — the React app

Vite + React 19 + Tailwind v4 + Motion, compiled to a **single** `dist/index.html` (all JS/CSS
inlined) so it runs from a double-click. It reads `window.__JIRA_DATA__` at load.

| File | Role |
|---|---|
| `src/types.ts` | **The data contract.** Single source of truth for the ticket shape; mirrored by `prompts/intern-prompt.md`. |
| `src/data.ts` | Applies lifecycle rules to a raw dump (e.g. retire old Done tickets). Falls back to a dev fixture. |
| `src/App.tsx` | Composition only: wires the hooks to the components. |
| `src/hooks/` | State and side effects: settings sync, board data + in-place reload, intern jobs, reports, drawer stack, toasts. |
| `src/lib/statusPoller.ts` | The one poller for `/api/intern-status`. Every watcher subscribes with a rate; the fastest wins, and it pauses while the tab is hidden. |
| `src/lib/boardView.ts` | Pure derivations: search → columns / On Hold / Next Sprint, the key index, counts. |
| `src/lib/runner.ts` | Typed client for the local server's API. |
| `src/lib/columns.ts` · `format.ts` · `search.ts` | Status → column mapping, display helpers, ticket search. |
| `src/components/` | Feature folders: `board/`, `header/`, `ticket/`, `completed/`, `reports/`, `settings/`, `common/`. |
| `tooling/vite.config.ts` | Single-file build; injects the external `../jira-intern/data.js` `<script>`. |

### 3. `server/` (entry `serve.mjs`) — the optional local server

Zero-dependency Node. `server/serve.mjs` is the route table; `server/` holds the pieces:

| Module | Role |
|---|---|
| `config.mjs` | Paths, ports, validation regexes. |
| `http.mjs` | JSON helpers and the static handler: path allowlist, in-memory gzip, ETag / 304. |
| `jobs.mjs` · `locks.mjs` · `queue.mjs` | The data writers (daily, archive, per-ticket FIFO) and the lock files that keep them from overlapping. |
| `reports.mjs` | Report queue, bulk scope resolution, and an mtime-cached index of `reports/`. |
| `ai.mjs` | JIRA-AI-Intern status (1 s shared cache), its file queue, and the `/api/ai-*` proxy. |
| `settings.mjs` · `schedule.mjs` | Machine-wide settings and the refresh / report scheduler. |

## How data reaches the screen

1. The fetch writes `jira-intern/data.json`, then `data.js` (`window.__JIRA_DATA__`).
2. `dist/index.html` includes `<script src="../jira-intern/data.js">` (injected by the build).
3. `src/data.ts` normalizes the dump and applies board rules.
4. React renders the board, sections, and drawer from `src/types.ts`-shaped data.

Because the data file is external to the bundle, **new data never requires a rebuild**. In served
mode a finished refresh swaps in `/jira-intern/data.json` without reloading the page (an unchanged
file costs a 304); on `file://` the board reloads to pick up `data.js`.

## Server load

One user, one tab, mostly idle with bursts of background work. So:

- The client makes **one** status request per interval, however many things it is watching:
  12 s idle, 4 s while runs or reports are in flight, 1 s only during a model download. No
  polling at all while the tab is hidden or Background auto-refresh is off with nothing running.
- `/api/intern-status` bundles run state, queues and AI status. Identical payloads don't re-render.
- The reports index is fetched when a report finishes, not on a timer. The server re-parses only
  report files whose mtime changed.
- Static files are gzipped once and revalidated by ETag.

## Board rules worth knowing

- **Columns:** To Do · Blocked · In Progress · In Review (folds in Ready4Review + Code Review) · QA (with a separate QA In Progress space under it) · Done.
- **On Hold:** its own space under Blocked in the Blocked column — a drop target that stays slim when empty.
- **Next Sprint:** To Do tickets whose sprint hasn't started yet (Jira sprint state `future`, or
  a grooming bucket like `… READY`) are pulled out of the To Do box into their own space at the end
  of the To Do column, so a cleared current-sprint To Do doesn't look full. See `src/lib/format.ts` → `isNextSprint`.
- **Completed:** the full historical archive, collapsed by default.
- **Raised by me:** every non-sub-task ticket you REPORTED (bugs filed for later), with status,
  current assignee and the full hand-off trail — its own overlay behind the indigo chip, fed by
  `raised[]` in the dump. Sub-tickets you cut under your own work are excluded by design.
- **Done retirement:** a Done ticket stays on the board a few days as a "recent win", then retires
  to Completed automatically (`app.doneBoardDays`, enforced in `src/data.ts`).

## Two ways it runs

| Mode | Command | Refresh button | Needs |
|---|---|---|---|
| **Docker** (recommended) | `docker compose up -d --build` | Runs the fetch in-container; the scheduler also refreshes on the cadences set in Settings | Docker + Jira token |
| **Static file** | open `dist/index.html` | Re-reads the last dump | Nothing |
| **Live server** | `npm run serve` | Runs the fetch on your machine | Node + a working local fetch |

See [`DEPLOYMENT.md`](DEPLOYMENT.md) for step-by-step instructions.

## JIRA-AI-Intern

`docker-compose.yml` starts three services: **JIRA-Board** (fetch + UI), **JIRA-AI-Ollama**, and
**JIRA-AI-Intern** (queue worker). They share `./jira-intern`. Settings `aiLevel` / `aiBackend` /
`aiLocalModel` live in `jira-intern/.settings.json`. The board writes a deterministic report in
seconds, then enqueues `{type: enrich-report}` unless the level is None. Local inference is Ollama
(CPU in Docker, or host Metal via `host.docker.internal`). Cloud uses the HTTP API and keys in
`setup/.env` (added with the key button in the board header). Local enrichment (Gemma / GPT-OSS / mini / nano included) reads the intern
volume plus live Jira/Bitbucket REST with those same tokens. CI / Checkmarx / Dynatrace stay **Not verified**.
