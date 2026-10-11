# Runtime — every container, agent, queue and background process

What is actually RUNNING when the system is up, what each process owns, and the runbook for
checking on all of it. Written for both engineers and AI agents operating this deployment.

## Containers (docker compose, project `jira-project`)

| Container | Image | Port | Role | Key mounts |
|---|---|---|---|---|
| **JIRA-Board** | `jira-board:latest` | `4321` (published) | `server/serve.mjs` (UI + API) under `tini`; runs every fetch script (python3 in-image); in-container refresh loop (`REFRESH_ON_START=1`, `REFRESH_INTERVAL=900`) + the Settings-cadence scheduler | `./jira-intern` (**DATA** — read-write), `./config`, `./setup` (rw — API keys in `setup/.env`, written by the key dialog), `~/.ai` (ro, identity) |
| **AI-Intern** | `ai-intern:latest` | `4322` (internal; board proxies it) | `worker.py` — the only model-calling process: AI briefs, PR-report enrichment, model pulls; small HTTP API (`/health`, `/api/models`, `/api/jobs`) | `./jira-intern` (rw — writes briefs/reports), `./setup` (ro — cloud keys in `setup/.env`, re-read per call) |
| **AI-Ollama** | `ollama/ollama` | `11434` (internal) | Local inference for the worker when backend=local and Host Ollama is OFF | volume `jira-ai-models` (weights) |

All three restart `unless-stopped`. The **data mount follows the deploy directory**: whichever
checkout last ran `scripts/start-jira-board.sh` owns `jira-intern/` — see `DEPLOYMENT.md` before
deploying from a new folder.

Optional host-side process: **Ollama.app** on the host (Settings → Host Ollama) — the worker then
talks to `host.docker.internal:11434` instead of AI-Ollama (use for 14B+ models on Apple Silicon).

## Long-running processes inside the containers

| Process | Container | What it loops on |
|---|---|---|
| `server/serve.mjs` | JIRA-Board | HTTP; holds the in-memory writer flags (daily/archive/raised) + per-ticket FIFO queue. |
| scheduler (`server/schedule.mjs`) | JIRA-Board | Settings cadences → same start gates as the buttons; stamps `.schedule.json`. |
| entrypoint refresh loop | JIRA-Board | `REFRESH_INTERVAL` seconds → `run-intern.sh` (skips itself when a writer lock is held). |
| `worker.py` | AI-Intern | Polls `jira-intern/.ai-queue/` for jobs; serves `/api/*`; streams pull progress. |
| `ollama serve` | AI-Ollama | Model host. |

## Job inventory — everything that can run, and what starts it

| Job | Entry script | Started by | Writes | Lock |
|---|---|---|---|---|
| Daily fetch (active tickets + raised rides along) | `local-runner/run-intern.sh` → `daily_fetch.py` | Refresh button · scheduler · container loop · terminal | `data.json/js`, `.state.json`, `.progress.json` | `.intern.lock` |
| Archive rebuild (full/year/since/key; raised rides along) | `local-runner/update-completed.sh` → `completed_archive.py` | Archive menu · scheduler | `completed[]` in data, `cache/`, progress | `.completed.lock` |
| Raised-only hard refresh | `local-runner/refresh-raised.sh` → `daily_fetch.py --raised` | the Raised view's button (`POST /api/run-raised`) | `raised[]` + `raisedAt` | `.raised.lock` |
| Per-ticket refresh | `local-runner/refresh-ticket.sh` → `daily_fetch.py --key` | card/drawer refresh button (FIFO queue) | that ticket everywhere + its raised row | `.refresh.lock` |
| PR report (base) | `local-runner/pr-report.sh` → `pr_report.py` | report button · bulk menu · auto after a ticket refresh (`--if-needed`) | `reports/<KEY>.json`, `reports/index.js` | report `.status.json` PIDs |
| Report bulk backfill | `local-runner/pr-reports-backfill.sh` | Reports menu scopes · scheduler | same | same |
| AI brief pass | queue job `summarize-active` | scheduler / `POST /api/ai-jobs` | `aiSummary` into `tickets[]`+`raised[]` (≤8/pass) | defers to data-writer locks |
| AI report enrichment | queue job `enrich-report` (enqueued by `pr-report.sh` via `ai_queue.py` unless level=None) | automatic after each base report | enriched blocks into `reports/<KEY>.json` | worker-internal |
| Model pull | queue job `pull-model` | Settings download icon | Ollama store | worker-exclusive |

### The LLM-agent fallback

`run-intern.sh`, `refresh-ticket.sh` and `update-completed.sh` each try the deterministic Python
FIRST; only if it exits non-zero do they look for an agent CLI (`cursor-agent` by default,
configurable via `config.mjs` → connector settings) and re-run the job as a prompted agent using
`prompts/*.md` + the user's MCP servers. Docker images have no agent CLI — in containers the
Python path must succeed. `FORCE_AGENT=1` exists for debugging the fallback.

## Queues

| Queue | Medium | Consumer | Ordering |
|---|---|---|---|
| Per-ticket refresh | in-memory `KeyQueue` (server) | one bash child at a time | FIFO, dedup by key, blocked while any big writer runs |
| PR reports | in-memory `KeyQueue` (server) + `.status.json` for external runs | report script children | FIFO, dedup, skips keys already generating anywhere |
| AI jobs | files in `jira-intern/.ai-queue/` | `worker.py` | reports run in parallel (Settings knob); summarize/pull exclusive |

## Runbook — checking on everything

```bash
docker compose ps                        # the three containers, health at a glance
docker logs -f JIRA-Board                # server + fetch output (also AI-Intern / AI-Ollama)
curl -s localhost:4321/api/intern-status # running? which job? progress? queues? AI health?
curl -s localhost:4321/api/ai-status     # worker state, current job, installed models, pulls
cat jira-intern/_STATUS.md | head        # newest-first audit log of every run
ls jira-intern/*.lock                    # who holds a writer lock right now (pid + started-at)
ls jira-intern/logs/ | tail              # per-run log files
```

Stop things: `docker compose down` (everything) · `POST /api/run-archive/stop` (archive) ·
`POST /api/reports/stop` (report queue) · locks from dead processes clear themselves (server and
runners both prune dead-PID locks; PID-less locks expire after 45 min).

Redeploy after a code change: `bash scripts/start-jira-board.sh` — reclaims port 4321, host-builds
`dist/`, rebuilds images with the prebuilt dist, force-recreates the stack, health-checks, opens
the board. Safe to run repeatedly; never stacks containers or drifts ports.

## What runs where — one picture

```
HOST (your machine)
│  scripts/start-jira-board.sh (deploy)        Ollama.app (optional, Metal)
│  npm run serve / dev (alt run modes)      ▲ host.docker.internal:11434
│
└─ Docker VM ────────────────────────────────────────────────────────────────
   JIRA-Board:4321 ── server/serve.mjs ── scheduler ── refresh loop ── fetch scripts
   │         ▲ /api/ai-* proxy                      │ locks + queue files
   │         ▼                                      ▼
   AI-Intern:4322 ── worker.py ◀── .ai-queue ── jira-intern/  (shared bind mount = THE data)
   │         │ local inference
   │         ▼
   AI-Ollama:11434 (volume jira-ai-models)
```

## AI-Ollama lifecycle

The Ollama container runs only while **both** conditions hold (`server/ollama.mjs`):

1. Settings → AI → **AI-Ollama container** is on (`ollamaEnabled`, saved in `jira-intern/.settings.json`; default from `config.ai.ollamaEnabled`).
2. **`jira-intern/models/` contains a model** — an Ollama manifest under `models/manifests/` (a pull from Settings lands there, because `docker-compose.yml` binds that directory to the container's `/root/.ollama`) or a loose `*.gguf` file.

| Moment | Behaviour |
|---|---|
| Deploy (`scripts/start-jira-board.sh`) | `node server/ollama.mjs wanted` → **yes** only when both hold. Otherwise the container is *created but left stopped* and `jira-board`/`jira-ai` come up with `--no-deps`. A one-time migration copies models from the old `jira-ai-models` volume when the directory is still empty. |
| Board server boot | Same rule via the Docker socket: stops a running Ollama that is not wanted, starts a wanted one. |
| Toggle flipped | On → start (or `no-models`, surfaced as an error toast naming the directory); off → stop. The toggle row shows the live container state and the models found. |
| Model pull | Starts the container on demand (toggle permitting) and waits for it to answer before proxying the pull. |

Control goes through the Docker Engine API on `/var/run/docker.sock` (mounted in `docker-compose.yml`,
with `group_add: "${DOCKER_GID:-0}"` so the unprivileged `node` user may use it). Without the socket every
action reports `unavailable`, the Settings row says so, and Ollama simply follows compose.
`restart: unless-stopped` keeps a stopped Ollama stopped across Docker restarts.
