# 🎫 My Jira Board — project overview

[![CI](https://github.com/yo-sayantan/AI-JIRA-Board/actions/workflows/ci.yml/badge.svg)](https://github.com/yo-sayantan/AI-JIRA-Board/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](../LICENSE)
![React 19](https://img.shields.io/badge/React-19-61dafb?logo=react&logoColor=white)
![Vite 6](https://img.shields.io/badge/Vite-6-646cff?logo=vite&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6?logo=typescript&logoColor=white)
![Tailwind v4](https://img.shields.io/badge/Tailwind-v4-38bdf8?logo=tailwindcss&logoColor=white)
![Docker ready](https://img.shields.io/badge/Docker-ready-2496ed?logo=docker&logoColor=white)

A personal, beautiful replacement for staring at the Jira web UI. A background fetcher pulls the
tickets assigned to you; a fast single-page app renders them — **no Jira login, no waiting on the
browser**, and refreshing the data never rebuilds the app.

React 19 · Vite 6 · Tailwind v4 · Motion · a Python fetch pipeline · one self-contained
`dist/index.html` you can literally double-click.

> **New here?** Open the **Setup & Deployment guide** — requirements, per-OS install steps
> (Windows/macOS/Linux), git & Docker commands, and troubleshooting, all copy-ready:
>
> | | |
> |---|---|
> | **macOS / Linux** | `./scripts/open-guide.sh` |
> | **Windows** | double-click `scripts/open-guide.bat` |
> | **Any OS** | open [`help/00-start-here.html`](../help/00-start-here.html) directly — every page in `help/` is a plain file |
> | **Board running?** | click the **?** button in the header |
>
> It needs nothing installed — it's the page to reach for when the board *won't* start.

---

## What it does

- **Kanban board** — To Do · In Progress · In Review (folds in Ready4Review + Code Review) · QA ·
  Done. Colour-coded animated cards; click any for a full detail drawer. Chips filter; live search.
- **Blocked** — a column between To Do and In Progress for stuck work. Every empty column folds to a slim rail so the columns with cards get the width.
- **On Hold** — its own small space under Blocked, in the same column; always there to drop a card on.
- **Next Sprint** — tickets queued in a sprint that hasn't started yet, kept out of the To Do box so a
  cleared sprint doesn't look full: their own space at the end of the To Do column. **All** (first chip, on by default) shows the whole board.
- **PR Readiness Report** — for every ticket with a pull request: a management-grade, colour-coded
  tabbed report (verdict + score, evidence chain, per-file change assessment, risks & release gate,
  open scope, timeline). Generated automatically in the background when a PR appears or changes —
  deterministic base from the fetch, AI-enriched via your Cursor MCP skills. One button in the ticket drawer.
- **Completed** — the full historical archive of every Done ticket, with inline peek + detail.
- **Ticket detail** — a slide-in drawer: status pipeline, PR card, description, an interactive
  acceptance-criteria checklist, comments, related issues, Confluence/docs, branch, sources.

## Quick start (Docker)

```bash
# 0. clone
git clone https://github.com/yo-sayantan/AI-JIRA-Board.git
cd AI-JIRA-Board

# 1. one-time setup — your details (see docs/SETUP.md). Lives OUTSIDE the repo.
mkdir -p ~/.ai
cp setup/config.example.json ~/.ai/config.json   # then add your name + URLs

# 2. build and serve
docker compose up -d --build
```

Open **http://localhost:4321/dist/index.html**, click **Add API keys first** (or the key button in
the header) and paste your Jira token — it is saved in `setup/.env`, git-ignored. Then **Refresh**.
From there the container fetches on start and auto-refreshes every 15 minutes. Full details and other run modes: [`DEPLOYMENT.md`](DEPLOYMENT.md).

## Repository layout

```
AI-JIRA-Board/
├── README.md                ← short landing page — ALL documentation lives in docs/
├── LICENSE                  ← MIT
├── .github/                 ← CI (typecheck + build), Dependabot, issue & PR templates
├── help/                    ← 🆘 the help guide — plain HTML, opens straight from disk (no server)
│   ├── 00-start-here.html   ←   start page: what this is, the journey, every page
│   ├── 01-requirements.html … 10-developer-documentation.html  ← numbered in the order you need them
│   ├── developer-doc-viewer.html            ← reads any docs/*.md, offline too
│   ├── legal-privacy-and-accessibility.html ← privacy, data, cookies, terms, accessibility, contact
│   └── help.css · help.js · help-data.js    ← the one stylesheet, the one script, the bundled data (generated)
├── docs/                    ← 📚 developer documentation (markdown)
│   ├── AGENTS.md            ←   onboarding for engineers & AI agents: map, rules, gotchas
│   ├── FEATURES.md          ←   every feature + where its code lives
│   ├── DATA-FLOW.md         ←   every file, writer, lock and lifecycle
│   ├── AI-PIPELINE.md       ←   briefs, report enrichment, models, queues
│   ├── INTEGRATIONS.md      ←   Jira/Bitbucket, the HTTP API, config chain
│   ├── RUNTIME.md           ←   containers, agents, queues, schedulers, runbook
│   ├── ARCHITECTURE.md      ←   how the fetch, data file, and app fit together
│   ├── DEPLOYMENT.md        ←   deploy & run: Docker / static file / live server
│   ├── USAGE.md             ←   using the board: chips, Raised by me, Next Sprint, drawer
│   ├── SETUP.md             ←   step-by-step setup: secrets, personal config, MCP, publishing checklist
│   ├── CONFIG.md            ←   key-by-key reference for the project config + personal override
│   ├── INTERN.md            ←   the fetch pipeline (jira-intern/) from the inside
│   └── OVERVIEW.md          ←   this page
├── setup/                   ← 🔐 the API key list, your keys (git-ignored) + templates (no real values)
│   ├── api-keys.json        ←   THE list of API keys the board's key dialog offers
│   ├── .env                 ←   your keys, written by that dialog — git-ignored, never served
│   ├── config.example.json
│   ├── mcp-secrets.env.template  ←   tokens for your IDE's MCP servers (not read by the board)
│   ├── mcp.cursor.json.template  ·  mcp.claude.json.template  ·  mcp-with-secrets.sh.template
│   └── Start Jira Board.command.template   ←   macOS double-click launcher
├── src/                     ← ⚛️ the React app (compiled to dist/index.html)
├── jira-intern/             ← 🐍 the fetch pipeline ("the intern") + its config
├── server/                  ← 🖥️ optional zero-dep server for live mode (entry: serve.mjs)
├── docker/                  ← 🐳 Dockerfile + docker-entrypoint.sh (compose builds with context = repo root)
├── scripts/                 ← 🧰 start-jira-board.sh (build + deploy + open) · open-guide.sh/.bat · Open Board.html
├── tooling/                 ← 🔧 vite.config.ts · vitest.config.ts (npm scripts pass --config)
└── docker-compose.yml       ← containerised deploy (`docker compose up -d --build`)
```

> The repo root keeps only what tools look for there: `package.json` / `package-lock.json` (npm),
> Vite's `index.html`, `README.md` and `LICENSE` (GitHub), `.dockerignore`, `.nvmrc`, `.gitignore`,
> `.gitattributes` and `docker-compose.yml` (its `./jira-intern` bind mount is relative to it).
> `tsconfig.json` lives in `src/`, the Vite/Vitest configs in `tooling/`, `CLAUDE.md` in `.claude/`.

## Setup

You need **one Jira Personal Access Token**; everything else is optional. Nothing personal is ever
committed — your tokens sit in a git-ignored file, your identity outside the repo:

| File | Holds | Resolution |
|---|---|---|
| `config/jira-board.config.json` | All non-secret project defaults and policy | Always loaded first and schema-validated |
| `setup/.env` | Your API tokens | Written by the board's API keys dialog (key button in the header); git-ignored, docker-ignored, never served |
| `~/.ai/config.json` | Sparse personal override: identity, company URLs, branding | Deep-merged over project defaults |

The central project config contains **placeholders only** and acts as the defaults layer,
so a fresh clone runs without breaking and your real values never enter git. Check which file is in
effect with `node jira-intern/local-runner/config.mjs path`. Full walkthrough:
[`SETUP.md`](SETUP.md) · key-by-key reference: [`CONFIG.md`](CONFIG.md).

## Develop

```bash
npm install
npm run dev        # localhost:5173 — renders a SAMPLE fixture (src/fixtures.ts), every UI state
npm run build      # → dist/index.html (single self-contained file)
npm run typecheck  # tsc --noEmit
```

`src/types.ts` is the **data contract** — the single source of truth for the ticket shape, mirrored
in prose by `jira-intern/prompts/intern-prompt.md`. Keep the two in sync. See
[`ARCHITECTURE.md`](ARCHITECTURE.md) for the full picture, and
[`AGENTS.md`](AGENTS.md) for the whole-repo onboarding written for engineers and AI agents.

## Publishing this repo

It's safe to push **because your secrets never enter it** — they live only in
`setup/.env` (git-ignored). Before going **public**, confirm no `*.env` with real
values is staged and keep `config/jira-board.config.json` generic (real identity and internal
hostnames belong in `~/.ai/config.json`). Checklist:
[`SETUP.md → Before you make the repo public`](SETUP.md#before-you-make-the-repo-public).

---

<sub>Built to dodge JIRA · made with ☕ + a refresh button</sub>
