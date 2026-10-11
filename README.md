# 🎫 My Jira Board

[![CI](https://github.com/yo-sayantan/AI-JIRA-Board/actions/workflows/ci.yml/badge.svg)](https://github.com/yo-sayantan/AI-JIRA-Board/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![React 19](https://img.shields.io/badge/React-19-61dafb?logo=react&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-7-3178c6?logo=typescript&logoColor=white)
![Docker ready](https://img.shields.io/badge/Docker-ready-2496ed?logo=docker&logoColor=white)
![AI](https://img.shields.io/badge/AI-local%20%26%20cloud-8b5cf6)

### Your Jira, without the Jira UI — fast, private, and AI-assisted.

A self-hosted kanban board that mirrors **your** Jira tickets and pull requests in one place.
Open it and everything is already there: no login, no spinner, no waiting on a slow web app.
Drag a card to change its status **in Jira**, see which PRs are ready to ship, and let an AI
write the briefings you would otherwise piece together from five tabs.

> **One command to install. Your data never leaves your machine** (unless you choose a cloud AI).

```bash
git clone https://github.com/yo-sayantan/AI-JIRA-Board.git && cd AI-JIRA-Board
mkdir -p ~/.ai && cp setup/config.example.json ~/.ai/config.json   # add your name + URLs
bash scripts/start-jira-board.sh                                     # build, deploy, open :4321
# then click the key button in the board header and paste your Jira token
```

## ✨ Why you'll like it

| | |
|---|---|
| ⚡ **Instant** | A single-file React app reads a local snapshot. Refreshing data never rebuilds the app. |
| 🖱️ **Drag to update Jira** | Drop a card on To Do / In Progress / In Review / QA / Done — the ticket moves in Jira, in the background, while you keep working. |
| 🛡️ **Guard-rails built in** | The **QA lane** only takes QA tickets (and keeps them among QA · QA In Progress · Blocked · On Hold · Done), **In Review needs a PR**, and **Done needs every PR merged or declined plus a QA ticket** — a zone that won't take the card says why while you drag, ⌥-drop forces past a PR / QA rule, and every move has **Undo**. Checked against live Jira, not just the cached data. |
| 🤖 **AI that explains the work** | Per-ticket briefs and **PR Readiness Reports** with a ship / no-ship verdict, evidence, risks and file-by-file notes. |
| 🔒 **Private by default** | Local AI (Ollama) means no tokens and no data leaving the box. Loopback-only, non-root containers, verified TLS. |
| 🧩 **Works with what you have** | Jira + Bitbucket (on-prem or cloud). Cursor, Gemini or Claude for cloud AI. No lock-in. |

## 📋 Everything it does

**Board & workflow**
- Six-column kanban — **To Do · Blocked · In Progress · In Review · QA · Done** — with an **On Hold** drop space under Blocked and a **Next Sprint** space at the end of To Do; empty columns fold to slim rails so the busy ones get the width; sprint-carry-over markers, priority and story-point glyphs, PR badges with approval counts.
- **Drag-and-drop status changes** written through to Jira, with live PR / QA gates and automatic bounce-back.
- Smart search (`PROJ-6115`, bare numbers, people, branches, PR ids) and one-click stat chips.
- **Completed archive** — your whole delivery history by year and month, with lead-time vs dev-time.
- **Raised by me** — every ticket you filed, who holds it now, and the full hand-off trail.
- **Proof on every card** — the latest Jenkins build per environment (result, tests, failed stage) and, for vulnerability-fix tickets, which named CVEs / Checkmarx findings are really fixed on the branch; both feed the PR report's CI and security gates.
- Toasts that appear instantly and queue politely (you choose how many and for how long).

**🤖 AI features**
- **AI briefs** — a deep summary on To Do / In Progress tickets (enriched from linked Confluence pages, related tickets and PR diffs) and a short one for review/QA.
- **PR Readiness Reports** — ship / no-ship verdict, evidence chain, release gates (approvals, comments, QA, scans), and file-level notes. Deterministic base report always available; AI enrichment layered on top.
- **Four AI levels** — None · Low · Moderate · Max — trading speed and cost for depth.
- **Local or Cloud, your choice** — run a model on your own machine (Gemma, Qwen, Llama, Phi… catalog included) or use **Cursor, Gemini or Claude** with a value-priced model shortlist and a built-in [price table](help/07-ai-cloud-models-and-prices.html#ai-cloud-prices).
- **Smart Ollama management** — the local-model container only runs when you switch it on *and* a model is present; it starts and stops itself as you change settings.
- **Model manager** — pick a model, click download, watch progress; or drop in your own `.gguf`.

**Operate it your way**
- **Settings that matter** — appearance (auto / light / dark / scheduled), schedules for background refreshes, parallelism, notification behaviour, and a feature toggle for every section.
- **Background jobs** — scheduled active refresh, full-board rebuild and report refresh; per-ticket refresh from any card.
- **Docker, static file, or live server** — the same board runs from a double-click or a container.
- **Guide built in** — a step-by-step setup & deployment guide in [`help/`](help/) (plain HTML that opens from disk, even before anything is deployed) with per-OS commands, model downloads and a prices table; the board's **?** and Settings' **i** open it.

## 🧠 Local AI (the AI-Ollama container)

The `AI-Ollama` container is **off by default on every boot and deploy** and only runs while **both** hold:

1. **Settings → AI → "AI-Ollama container" is on**, and
2. **`jira-intern/models/` contains a model** — a model pulled from the Settings list (that directory *is* Ollama's store), or a `.gguf` file you place there yourself (then register it once: `docker exec AI-Ollama ollama create <tag> -f /root/.ollama/Modelfile`, see `jira-intern/models/README.md`).

Turn the toggle on and the container starts within seconds (if a model is present — otherwise the board tells you what is missing); turn it off and it stops. Cloud AI never needs it. Details: [`docs/RUNTIME.md`](docs/RUNTIME.md#ai-ollama-lifecycle).

## 🚀 Get started in minutes

1. Follow the five commands at the top, or open the in-app **?** guide.
2. Open **http://localhost:4321** — your board is already populated.
3. Optional: Settings → **AI** to pick *Local* or *Cloud*; Settings → **Features** to shape the board.

Need help? The **help guide** is plain HTML in [`help/`](help/) — open [`help/00-start-here.html`](help/00-start-here.html) straight from disk, **nothing needs to be installed or running**. Its pages are numbered in the order you need them (requirements → install → Git → configure → deploy …), it covers Windows, macOS and Linux, and [`09-troubleshooting-and-faq.html`](help/09-troubleshooting-and-faq.html) answers the usual snags.

## 🗺️ Where everything is

### "I want to…" — the file to open

| I want to… | Open / edit | Notes |
|---|---|---|
| Install and deploy, step by step | [`help/00-start-here.html`](help/00-start-here.html) | Double-click it — works with nothing installed |
| Add my **Jira token** (and Bitbucket / Confluence / AI keys) | The **key button** in the board header | Saved in `setup/.env` — git-ignored, docker-ignored, never served. The list of keys: [`setup/api-keys.json`](setup/api-keys.json) |
| Set **my name**, company URLs, footer branding | `~/.ai/config.json` | Copy from [`setup/config.example.json`](setup/config.example.json). Outside the repo |
| Change the **project defaults** (columns, schedules, AI defaults…) | [`config/jira-board.config.json`](config/jira-board.config.json) | Generic, tracked. Every key: [`docs/CONFIG.md`](docs/CONFIG.md) |
| Add / remove a **cloud AI model** (Cursor, Claude, Gemini), its efforts, the costly line | [`ai-intern/cloud-models.json`](ai-intern/cloud-models.json) | Settings follows within a minute — no rebuild. [Guide](help/07-ai-cloud-models-and-prices.html) |
| Add a **local AI model** (Ollama tag / GGUF) | [`ai-intern/models.json`](ai-intern/models.json) | Then `docker compose restart jira-ai`. [Guide](help/06-ai-local-models.html) |
| Update a **cloud price** | [`ai-intern/cursor-prices.json`](ai-intern/cursor-prices.json) | Reference table; an entry in `cloud-models.json` can override it |
| Trust my **company's certificate** (on-prem Jira / Bitbucket) | `~/.ai/ca-bundle.pem` | [`docs/SETUP.md`](docs/SETUP.md) step 6 |
| Change the **port**, containers, mounts | [`docker-compose.yml`](docker-compose.yml) | `PORT=8080 bash scripts/start-jira-board.sh` for a one-off |
| Deploy / redeploy | [`scripts/start-jira-board.sh`](scripts/start-jira-board.sh) | Builds on your machine, then Docker. [Guide](help/05-deploy-with-docker.html) |
| Fix a problem | [`help/09-troubleshooting-and-faq.html`](help/09-troubleshooting-and-faq.html) | Every real problem met so far, with the fix |
| Try the board without Jira | Settings → **Demo mode** | Sample data: [`jira-intern/demo/`](jira-intern/demo/) |

### Configuration files — what, where, who reads it

Settings are layered: **project defaults** → your **personal override** → what you save in **Settings** (the last one wins).

| File | Where | In git? | What it holds | Read by |
|---|---|---|---|---|
| `.env` | `setup/` | **No — never** (git- and docker-ignored) | Tokens: `JIRA_PERSONAL_TOKEN`, Bitbucket / Confluence PATs, `CURSOR_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` — written by the board's API keys dialog | the fetch, the AI Intern (`./setup` mounted into both containers; read-only for the AI Intern) |
| [`api-keys.json`](setup/api-keys.json) | `setup/` | Yes | The list of API keys the dialog offers: per service the names, why, what uses it, where to get it | the board, the server |
| `config.json` | `~/.ai/` | **No** | Your identity (display name as Jira shows it, account id), company URLs, branding — only the keys that differ from the defaults | everything, via `jira-intern/local-runner/config.mjs` |
| `ca-bundle.pem` | `~/.ai/` | **No** | Your company's root certificate(s), added to the system roots | the fetch, the AI Intern |
| [`jira-board.config.json`](config/jira-board.config.json) | `config/` | Yes (generic only) | Project defaults: columns, refresh windows, AI defaults, report settings, Bitbucket hints. Validated by [`jira-board.config.schema.json`](config/jira-board.config.schema.json) | the board, the server, the fetch, the AI Intern |
| `.settings.json` | `jira-intern/` | No (runtime) | Everything saved from **Settings** in the board: schedules, parallelism, AI level / backend / model / effort, feature toggles | the server, the scheduler, the runners, the AI Intern |
| [`cloud-models.json`](ai-intern/cloud-models.json) | `ai-intern/` | Yes | **The** cloud model list: provider, name, id, maker, `outputUsd`, `efforts` (low · medium · high · auto), `costlyOutputUsd` | the AI Intern → Settings; the help guide |
| [`models.json`](ai-intern/models.json) | `ai-intern/` | Yes | The local model catalog: Ollama tags, GGUF downloads, RAM needs | the AI Intern → Settings; the help guide |
| [`cursor-prices.json`](ai-intern/cursor-prices.json) | `ai-intern/` | Yes | Cursor's published per-model prices (reference data) | the AI Intern (fills missing prices); the help guide |
| [`move_targets.json`](jira-intern/move_targets.json) | `jira-intern/` | Yes | The drag-and-drop targets, shared by the board, the server and `transition.py` | developers only |
| [`docker-compose.yml`](docker-compose.yml) | repo root | Yes | The three containers (`JIRA-Board`, `AI-Intern`, `AI-Ollama`), port 4321, mounts, environment | Docker |
| Browser `localStorage` | your browser | — | `jb-settings` (theme, toggles), `jb-archived`, `jb-guide-os` … — no cookies | the board, the help guide |

Templates for the files outside the repo live in [`setup/`](setup/): `config.example.json`,
`mcp.cursor.json.template` / `mcp.claude.json.template` / `mcp-with-secrets.sh.template` + `mcp-secrets.env.template`
(Jira & Confluence MCP for your editor — the board itself reads only `setup/.env`), and `Start Jira Board.command.template` (a macOS double-click launcher). Step by step:
[`docs/SETUP.md`](docs/SETUP.md).

### Repository index — every folder

| Path | What it is | You'll touch it when… |
|---|---|---|
| [`help/`](help/) | **The help guide** — plain HTML pages, numbered in the order you need them (below). One `help.css`, one `help.js`, and `help-data.js` (generated by every build so tables and docs work offline) | setting up, deploying, troubleshooting |
| [`docs/`](docs/) | **Developer documentation** (markdown) — architecture, data flow, API, config reference, changelog | changing the code |
| [`setup/`](setup/) | `api-keys.json` (the list of keys), your keys in the git-ignored `.env` (written by the board), and templates for personal config, editor MCP and the Desktop launcher | first setup |
| [`config/`](config/) | Project defaults (`jira-board.config.json`) and its JSON schema | changing defaults |
| [`scripts/`](scripts/) | `start-jira-board.sh` (build + deploy + open), `open-guide.sh` / `open-guide.bat` (open the help guide), `build-help-data.mjs`, `Open Board.html` | deploying |
| [`docker/`](docker/) | `Dockerfile` (built with the repo root as context) and `docker-entrypoint.sh` | changing the image |
| [`docker-compose.yml`](docker-compose.yml) | The containers, port and mounts | changing ports or mounts |
| [`src/`](src/) | The React 19 board — built into one self-contained `dist/index.html`. `src/types.ts` is the data contract | changing the UI |
| [`server/`](server/) | The zero-dependency Node server (`serve.mjs`): serves the board and the help guide, runs jobs, saves API keys (`secrets.mjs`), proxies the AI Intern | changing the API |
| [`jira-intern/`](jira-intern/) | **The fetch pipeline** (Python): `daily_fetch.py` (your tickets), `completed_archive.py`, `raised.py`, `devinfo.py` (PRs / branches), `pr_report.py`, `transition.py` (drag → Jira), `local-runner/*.sh` (what the server runs). Also **your data** (below) | changing what is fetched |
| [`ai-intern/`](ai-intern/) | **The AI Intern** container: `worker.py` (job queue, local or cloud models), `brief.py`, `cloud_config.py` + `cloud-models.json`, `models.json`, `cursor-prices.json` | changing AI behaviour or models |
| [`tests/`](tests/) | Python tests (`npm test` runs them with the JavaScript ones in `src/**/*.test.ts`) | before every commit |
| [`tooling/`](tooling/) | `vite.config.ts`, `vitest.config.ts` | rarely |
| [`index.html`](index.html) | The Vite entry for `npm run dev` (not a page to open) | never |
| `dist/` | The built board, `dist/index.html` — open it directly, or let the server serve it | after `npm run build` |

### Your data — created at runtime, never committed

All in `jira-intern/` (the folder you deploy from is the one the containers mount — see the
[FAQ](help/09-troubleshooting-and-faq.html#faq)):

| File / folder | What it is |
|---|---|
| `data.json` · `data.js` | The board's whole dump: active tickets, the Completed archive, Raised by me (`data.js` is the same, for opening the board from disk) |
| `reports/` | PR Readiness Reports, one JSON per ticket (`index.js` for offline viewing) |
| `cache/` | Per-ticket cache that makes the archive rebuild fast |
| `models/` | Local AI models (Ollama's store, or a `.gguf` you drop in) |
| `logs/` · `_STATUS.md` | Run logs and a newest-first audit of every run |
| `.settings.json` · `.schedule.json` · `.state.json` · `.progress.json` | Saved Settings, schedule stamps, incremental fetch memory, live progress |
| `.ai-queue/` · `.ai-status.json` | The AI Intern's job queue and status |
| `*.lock` | One-writer-at-a-time locks (cleared automatically when their process is gone) |

Every file, its writer and its reader: [`docs/RUNTIME-FILES.md`](docs/RUNTIME-FILES.md).

### The help guide — one file per step

| File | Open it to… |
|---|---|
| [`00-start-here.html`](help/00-start-here.html) | See what this is, the five-step journey, and every page |
| [`01-requirements.html`](help/01-requirements.html) | Know what to install (Docker, Git, a Jira token) and where to get it |
| [`02-install-the-tools.html`](help/02-install-the-tools.html) | Install them on Windows, macOS or Linux, and check they work |
| [`03-get-the-code-with-git.html`](help/03-get-the-code-with-git.html) | Clone the repository; everyday Git |
| [`04-configure-token-and-settings.html`](help/04-configure-token-and-settings.html) | Get your Jira token (pasted in the board's key dialog) and create your personal config |
| [`05-deploy-with-docker.html`](help/05-deploy-with-docker.html) | Deploy, redeploy, manage the containers |
| [`06-ai-local-models.html`](help/06-ai-local-models.html) | Run AI on your own machine (Ollama, GGUF) |
| [`07-ai-cloud-models-and-prices.html`](help/07-ai-cloud-models-and-prices.html) | Use Cursor, Claude or Gemini; prices; `cloud-models.json` |
| [`08-other-ways-to-run.html`](help/08-other-ways-to-run.html) | Run without Docker, develop the app, refresh by hand |
| [`09-troubleshooting-and-faq.html`](help/09-troubleshooting-and-faq.html) | Fix a problem |
| [`10-developer-documentation.html`](help/10-developer-documentation.html) | Find the developer docs (readable in [`developer-doc-viewer.html`](help/developer-doc-viewer.html)) |
| [`11-api-keys-and-integrations.html`](help/11-api-keys-and-integrations.html) | Add API keys, connect Jenkins and Checkmarx One, see what each unlocks |
| [`legal-privacy-and-accessibility.html`](help/legal-privacy-and-accessibility.html) | Privacy, your data, cookies, terms, accessibility |

### Everyday commands

```bash
bash scripts/start-jira-board.sh   # build + deploy + open http://localhost:4321
./scripts/open-guide.sh            # open the help guide (Windows: scripts\open-guide.bat)
npm run dev                        # develop the UI with sample data
npm run build                      # typecheck + build dist/index.html (also refreshes help/help-data.js)
npm test                           # Python + JavaScript tests
docker compose logs -f             # watch the containers
```

## 📚 Help in [`help/`](help/), developer docs in [`docs/`](docs/)

| Start here | |
|---|---|
| [`help/00-start-here.html`](help/00-start-here.html) | **Setup & Deployment guide** — numbered pages, per-OS install, copy-ready commands, FAQ (also the board's **?** button). Opens from disk. |
| [`docs/OVERVIEW.md`](docs/OVERVIEW.md) | What it does, quick start, repository layout |
| [`docs/AGENTS.md`](docs/AGENTS.md) | **Onboarding for engineers & AI agents** — repo map, golden rules, worked example, gotchas |

| Deep dives | |
|---|---|
| [`docs/FEATURES.md`](docs/FEATURES.md) | Every feature and where its code lives |
| [`docs/DATA-FLOW.md`](docs/DATA-FLOW.md) | Every file, writer, lock and lifecycle |
| [`docs/AI-PIPELINE.md`](docs/AI-PIPELINE.md) | Briefs, report enrichment, models, queues |
| [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md) | Jira/Bitbucket/Jenkins/Checkmarx One, the full HTTP API, config chain |
| [`docs/RUNTIME.md`](docs/RUNTIME.md) | Containers, agents, queues, schedulers, runbook |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | How the fetch, data file and app fit together |
| [`docs/INTERN.md`](docs/INTERN.md) | The fetch pipeline (`jira-intern/`) from the inside |

| Operating it | |
|---|---|
| [`docs/SETUP.md`](docs/SETUP.md) | Secrets, personal config, MCP templates, the public-repo checklist |
| [`docs/CONFIG.md`](docs/CONFIG.md) | Key-by-key reference for `config/jira-board.config.json` |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | Docker / static file / live server, deploy pitfalls |
| [`docs/USAGE.md`](docs/USAGE.md) | Using the board: chips, Raised by me, Next Sprint, the drawer |
| [`help/legal-privacy-and-accessibility.html`](help/legal-privacy-and-accessibility.html) | Privacy, your data, cookies, terms, accessibility, contact |

Every `docs/*.md` file above is also readable styled in [`help/developer-doc-viewer.html`](help/developer-doc-viewer.html) —
from disk or, with the board running, at `http://localhost:4321/help/`.

---

<sub>Built to dodge JIRA · made with ☕ + a refresh button · MIT</sub>
