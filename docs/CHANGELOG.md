# Changelog

Notable changes by area. Dates are omitted for the unreleased section; entries describe what the
code does now, so a reader can check them against the tree.

## Unreleased — primary branch

- **Liquid Glass UI.** The whole board is re-skinned as Apple-style Liquid Glass (`src/styles/glass.css`, following the
  `liquid-glass-design` skill's rules for the web): translucent frosted panels and cards with a bright specular rim and
  sheen over a vivid ambient background; a floating rounded header and footer; dialogs and the ticket drawer as blurred
  sheets; recessed glass fields; rounder corners; and a highlight that follows the pointer over board cards and the Settings
  switches. Blur is used only over content (header, footer, dialogs, menus, tooltips), not on every card. It goes opaque for
  *reduce transparency*, *increase contrast* and browsers without `backdrop-filter`, switches off with Motion & animations,
  and print is untouched. Colours, gradients and animations are unchanged. To undo it, delete `glass.css` and its import.

- **Settings: one AI dial, and two master switches.** Settings → AI now has just **Low · Medium · High · Max** (`None` is
  gone; the old Effort dropdown is gone — the level sets the effort). The level also decides which cloud models can be picked,
  by output price per 1M tokens: Low ≤ $1 · Medium ≤ $5 · High < $10 · Max everything (costly ≥ $10 included); models outside
  the level are greyed out, and the worker refuses one (`level_allows`). Two new switches under **Features** — **AI** and
  **Background jobs** — grey out their section; AI off stops every AI feature (briefs, report write-ups, summary pass, model
  pulls, queued jobs, the AI-Ollama container) and Background jobs off stops every scheduled run and the post-fetch report pass.
  Both are server settings (`aiEnabled`, `jobsEnabled`; config defaults `ai.enabled`, `schedule.enabled`) and **on by default**,
  so nothing changes until a switch is turned off. An old saved level `none` reads as AI off. `aiCloudEffort` is still accepted
  but ignored.

- **Proof: Dynatrace evidence, the Evidence section of the AI brief, the report's Issue insight, a Jenkins console excerpt.**
  QA and support tickets carry Dynatrace links; `jira-intern/dynatrace.py` now reads **only what those links point at**
  (classic `#trace;…`, `#problems/problemdetails;pid=`, `#serviceOverview;id=SERVICE-…`, `#logs;…` and platform
  `…apps.dynatrace.com/ui/apps/…` links; a Managed host is not a Dynatrace link) through the platform query API, with
  read-only DQL bounded by the link's own time window (padded 5 minutes, at most 2 hours), result and scan caps, 200 calls
  per run, 15 minutes of wall-clock and a 24 h / 1 h / 6 h cache. **Only tenants listed in `DYNATRACE_TENANTS`** (else `endpoints.dynatraceTenants`, which the
  fetch now reads too) are ever contacted; ids are regex-validated before they reach a query; the token (`DYNATRACE_PAT`, a
  platform token with `storage:spans|events|logs|buckets:read`) lives only in the `Authorization` header; TLS is verified
  (`DYNATRACE_INSECURE_TLS` is its own opt-out). Stored as `Ticket.dynatrace` (≤ 5 links, short scrubbed findings, a failed
  lookup carries the previous answer forward as `stale`) by `daily_fetch.apply_dynatrace`; shown in the drawer's **Proof →
  Linked traces & problems** group, with `proofNotes.dynatrace`, `proofSources.dynatrace` (the key window's *Last fetch*) and
  `python3 jira-intern/dynatrace.py inspect <link | KEY> [--no-read]` to see what a link maps to. `_sources.finish` takes
  its own status vocabulary (`statuses`, `unit`, `flag`).
  New **Observability** group and **Dynatrace** service in the API keys dialog (`DYNATRACE_PAT`, `DYNATRACE_TENANTS`; Test sends
  `fetch dt.davis.problems | limit 1` to each listed tenant).
  `jira-intern/evidence.py` builds, once and without network, what Dynatrace / Checkmarx / Jenkins say about a ticket; the
  AI brief ends with a separate **Evidence from linked systems** section (the evidence goes in the untrusted block,
  `brief.enforce_evidence` adds, replaces or removes the section so only the evidence's facts appear, and the brief is
  regenerated when its `aiSummaryEvidence` fingerprint changes), and the PR readiness report gets an **Issue insight**
  callout, evidence-chain rows and Sources links (templated, so present at AI level None; the AI may reword it only if
  `evidence.grounded`). `jira-intern/_scrub.py` cleans every Dynatrace message and console line first. For the latest failed
  build of a ticket about a failing build / pipeline, `jenkins.add_console_tails` keeps the scrubbed last ~40 lines (≤ 4 KB)
  of its console as `builds[].consoleTail`, shown in a collapsed **Console (last lines)** box. Docs: INTEGRATIONS.md
  (Dynatrace, Jenkins console), SECURITY.md, AI-PIPELINE.md, DATA-FLOW.md, SETUP.md, the help page 11.
- **Proof: Jenkins builds on every card.** `jira-intern/jenkins.py` reads the latest build of each of a ticket's own
  branches per environment from the multibranch jobs in `jenkins.jobs.<repo>.<env>` (new, empty by default) with
  `JENKINS_USER` / `JENKINS_API_TOKEN`: result, number, tests, up to five failing test names, failed stage, deploy target.
  Stored as `Ticket.builds` by `daily_fetch.apply_builds` (full and fast path, `--key` refresh); a failed lookup carries
  the prior builds forward. Shown as build chips on the card and in the drawer's new **Proof → Builds** group; the PR
  readiness report's "CI green" gate uses it (`pr_report.jenkins_ci`), Bitbucket build status as the fallback.
- **Proof: Checkmarx One vulnerability fixes.** For a vulnerability-fix ticket with a PR, `jira-intern/checkmarx.py`
  compares the latest completed scan of the PR's source branch with the base branch's and gives each CVE / query / CWE /
  result / package the ticket names a status — fixed, open, not-found, unknown. Stored as `Ticket.vulnFixes`
  (`daily_fetch.apply_vuln_fixes`; kept by the archive), shown as a shield chip and **Proof → Vulnerabilities**, and
  gated in the report's "Security scan (Checkmarx) clean" row (`pr_report.vuln_gate`, deterministic base and worker).
- **API keys dialog: key kinds, planned keys, new services.** Each key in `setup/api-keys.json` has a `kind` —
  `secret` (masked), `url`, `email`, `text` (shown in full) — and `planned: true` marks a key that can be saved before
  anything reads it (the only keys `tests/test_api_keys.py` exempts). New rows: Atlassian Cloud (`ATLASSIAN_TOKEN`, used
  for Bitbucket when no HTTP access token is set; email and site planned), Checkmarx One, Jenkins, GitHub (planned).
  One eye per secret, compact rows; a new base URL clears its service's secrets.
- **Help guide: `help/11-api-keys-and-integrations.html`.** The key dialog, what each key unlocks, Jenkins jobs and
  Checkmarx setup, where the results show, troubleshooting. Architecture docs gained "API keys" and "External proof
  sources" sections ([ARCHITECTURE.md](ARCHITECTURE.md)) and a "How to add a proof source" worked example ([AGENTS.md](AGENTS.md)).
- **API keys are added in the board, and live in `setup/.env`.** A key button in the header (amber dot while the
  Jira token is missing; also **Add API keys first** on a new install's empty screen) opens one list with a row
  per service from `setup/api-keys.json` — why it's needed, what uses it, where to get it, one field per key.
  Saved keys come back masked only (`GET`/`POST /api/keys`, `server/secrets.mjs`: temp file + rename, mode 0600).
  The board no longer reads `~/.cursor/mcp-secrets.env`: `setup/.env` (git-ignored, docker-ignored via `**/` rules,
  never served) is the only secrets file; `JB_SECRETS_FILE` moves it. `AGENT_SECRETS` and
  `connector.<name>.secretsFile` are gone. Compose drops the `~/.cursor` mounts and mounts `./setup` instead
  (read-write for JIRA-Board, read-only for AI-Intern). The `setup/mcp*` templates stay for your IDE's MCP servers.
- **Move rules, enforced everywhere.** One rule set (`src/lib/moveRules.ts`, mirrored by
  `jira-intern/transition.py` on live Jira): only QA tickets (type QA/Test, a `QA` label, a "QA:" title)
  enter QA / QA In Progress, and a QA ticket moves only to QA · QA In Progress · Blocked · On Hold ·
  Done. In Review needs a PR (or, for a sub-ticket, an open PR on its parent); Done needs every PR
  merged or declined and a QA ticket raised — no longer a finished one. The old "no PR" warning for
  In Review is now a refusal.
- **The help guide moved to `help/` and works with nothing deployed.** The single `docs/index.html` became numbered,
  plainly named pages — `00-start-here.html`, `01-requirements.html`, `02-install-the-tools.html`,
  `03-get-the-code-with-git.html`, `04-configure-token-and-settings.html`, `05-deploy-with-docker.html`,
  `06-ai-local-models.html`, `07-ai-cloud-models-and-prices.html`, `08-other-ways-to-run.html`,
  `09-troubleshooting-and-faq.html`, `10-developer-documentation.html` — plus `developer-doc-viewer.html` and
  `legal-privacy-and-accessibility.html`, sharing one `help.css` and one `help.js`. The model and price tables and the
  developer-doc viewer used to need the server (they fetched JSON / markdown); they now read `help/help-data.js`, a
  copy every build makes (`scripts/build-help-data.mjs`), and still read the live files when served. The board's ?
  and ⓘ buttons, `/help` on the server, the Docker image and `scripts/open-guide.*` all point at `help/`. Also fixed
  in the move: the guide's `docker compose build --pull` (never `--pull` here) and `docker build .` (the Dockerfile is
  in `docker/`).
- **Model picker tidy-up.** The effort dropdown is always there: for a costly model it shows **Medium**, disabled (the worker runs it at Medium); every other model defaults to **Auto**. The notes under the picker no longer mention your Cursor catalog, and a costly model's note no longer repeats its price (the Output tile has it). More room between the picker, its note and the tiles.
- **One file lists the cloud models: `ai-intern/cloud-models.json`.** Models, per-model efforts (Low · Medium · High ·
  **Auto**), prices and a **costly** line (`costlyOutputUsd`, default 10, output at or above it) live there; add or delete
  a row and Settings follows within a minute — no rebuild. It replaces the price-based selection (`maxOutputUsd`,
  `exclude`, `include`, `pin` in `cursor-prices.json`) and the name filters for Claude and Gemini; the Cursor
  catalog now only resolves each model's id and effort variants. The effort dropdown shows for every provider;
  a costly model has none (`costlyShowEffort` changes that). Auto = the model's own default.
- **PR reports can be built up to 10 at once** (Settings → At once; was 6).
- **Report progress bar covers the AI pass.** The generating list the bar watched empties as soon as the quick base
  reports are built, so a large run read "done" while the AI intern was still working through them. The bar now
  counts a report until its AI pass finishes too (`useReports.working`), and its batch size resets only after a few
  quiet seconds, so the hand-over between the two queues cannot zero it. Queued AI passes of a downed intern don't count.
- **Effort dropdown for every non-pricey model.** Low / Medium / High is offered for each Cursor model except those
  marked ⚠ (output above $10 per 1M); it used to appear only for models that advertised an effort parameter. A model
  without one gets the effort as guidance in the prompt.
- **Smoother no-op drops.** Dropping a card back where it started no longer stutters: the board holds still
  (columns snap, cards skip their position animation) during the drag and for a moment after, and the card fades back in.
- **Done is final.** A ticket in Done can't be moved to another column: its card is not draggable, every zone refuses it, and `transition.py` refuses it too (never forcible). Only the Undo right after a move into Done can reopen it.
- **Next Sprint is a drop target with its own rules.** Only To Do, Blocked, QA (ready) and On Hold tickets can
  be moved in — Jira: nearest dated future sprint, else the READY bucket, else REFINEMENT, status To Do — and a
  Next Sprint ticket can only go back to To Do (active sprint). Nothing else. Next Sprint = a dated future
  sprint or the READY / REFINEMENT bucket (`move_targets.json` gains `next`; `transition.py::move_sprint`).
- **Next Sprint moves into To Do; All comes first.** Tickets in a sprint that has not started now live in a
  space at the end of the To Do column (like QA In Progress under QA). The old bar below the board, its
  Next Sprint chip and the expand / scroll behaviour are removed. The chip row starts with **All N**,
  selected by default; the old "N active" chip is gone.
- **QA tickets show up on the board.** The daily fetch now also pulls QA tickets that are not assigned to you — ones you raised and ones linked to your tickets (`qa_rules.py`, shared with the move rules) — so a QA ticket linked to a Blocked ticket appears in To Do, and can then move only within the QA lane.
- **Why, force, undo.** While dragging, a refusing zone says why. ⌥-drop on a PR / QA gate asks to
  force it; a live refusal from the server offers *Move anyway*; every finished move has **Undo** for
  8 s (`mode=force|undo` on `/api/move-ticket`). The QA lane can never be forced.
- **Rev / Done readiness dots** on In Progress, Blocked, On Hold and In Review cards (Settings →
  *Move readiness on cards*).
- **Cursor models are offered by price, from the full table.** The hand-typed id allow-list is gone
  (it had silently shrunk the Settings dropdown to three models, and an earlier refresh had read
  only the first 20 of Cursor's 59 rows). `ai-intern/cursor-prices.json` holds the whole
  cursor.com/docs/models-and-pricing table; a model is offered when it is in the API key's Cursor
  catalog and costs $10 or less per 1M output tokens — 28 models across Cursor, Anthropic, OpenAI,
  Google, Z.ai, Moonshot and Meta, grouped by maker and cheapest first. Ids are matched ignoring
  punctuation and case, and a catalog model with no price on file is reported, not dropped. The
  Settings key strip says how many were shown / over the cap / unpriced, the cache-read tile reads
  the live price, and the guide's table (now with **Cache write**) renders from the same file.
- **Curated, with a cost warning.** `cursor-prices.json` has an `exclude` list (hidden: Grok 4.5,
  Gemini 2.5 / 3 / 3.5 / 3.6 / 3.7 Flash, GPT-5.4 Nano, Claude 4.5 Haiku) and an `include` list of
  exceptions above the $10 cap (GPT-5.6 Terra, Gemini 3.1 Pro). Any model whose output costs $10 or
  more per 1M tokens is marked ⚠ in the dropdown, the Output tile and the guide.
- **Effort now has a High level** (Low · Medium · High) for Cursor models, wherever the catalog's
  effort parameter lists it.
- A ticket with several branches now shows the one with the **newest commit** as its branch, and
  the PR banners (card badge, approvals, drawer badge) follow that branch's own PR instead of
  whichever PR was updated last. Other PRs stay listed and count toward `+N PR`. Commit times come
  from Bitbucket (`devinfo.py`), one call per branch and only for tickets with more than one; the
  previous choice is kept when Bitbucket cannot be reached. See
  [INTEGRATIONS.md](INTEGRATIONS.md#bitbucket-serverdc-rest-10--jira-dev-status).

## Unreleased — codebase audit

### Security

- TLS verification is **on by default** for every Jira / Bitbucket / cloud call
  (`jira-intern/_jira.py ssl_context()`, `ai-intern/worker.py _verified_ssl()`). Private CA via
  `JIRA_CA_BUNDLE` (compose has a commented mount); `JIRA_INSECURE_TLS=1` is the logged last resort.
- The board server rejects unknown `Host` headers with 403 (`ALLOWED_HOSTS` opt-in) to block DNS
  rebinding, checks `Origin`/`Referer`/`Sec-Fetch-Site` on every write, requires
  `Content-Type: application/json` on JSON routes, caps body sizes (413) and queue depth (429),
  supports `HEAD`, and sends `X-Content-Type-Options: nosniff` + `Referrer-Policy: no-referrer`.
  Jira data (`data.json`, `data.js`, `reports/index.js`) is served `Cache-Control: no-store`.
- Compose publishes the board on `127.0.0.1` only by default (`BIND_IP` to change).
- The board image runs as the unprivileged `node` user (uid 1000); mounts moved to `/home/node`.
- Secrets are **parsed, never sourced** everywhere (`_config.load_secrets`, `runner-env.sh
  export_secrets_from_file`, the MCP wrapper template, the worker). The entrypoint no longer
  exports the secrets file into the Node server; the runners export an allow-list; the worker
  keeps cloud keys out of `os.environ`.
- Ticket keys, years, dates, archive scopes and model tags are validated on every path (server,
  `ai_queue.py`, runners, worker); children are spawned with argument arrays.
- Untrusted ticket/PR text is wrapped in `<untrusted_data>` for the model; AI output may only add
  to a report (`validate_report` + `preserved_errors`); failures restore the base atomically.
- `jira-intern/light_html` drops `javascript:`/`data:` links; `pr_report.py` escapes attributes.

### Robustness

- No fixed refresh loop: one fetch on boot through the locked runner, then `server/schedule.mjs`
  runs the cadences from Settings → Background jobs (`.schedule.json` seeded on start so a restart
  never repeats the boot fetch). `REFRESH_INTERVAL` and `SKIP_SUMMARY` are gone.
- Lock protocol unified between `lock-util.sh` and `server/locks.mjs`: one-line
  `<pid> <ISO> <hostname>` format, atomic `noclobber` acquisition, three staleness rules (dead
  PID; PID-less after 45 min; live PID until an 8 h ceiling; other-host PIDs ignored). The
  entrypoint clears locks left by a previous container. Python writers take an advisory `flock`
  on `.data.lock`.
- Exit codes are explicit: 2 configuration (no token — no LLM fallback), 3 locked, 4 partial
  archive (previous rows kept, runner exits 0 with a warning), 6 unrendered prompt, 124 timeout,
  127 agent CLI missing; a signal-killed child is reported as 1.
- Jira HTTP: 429 honours `Retry-After`; other 4xx fail fast; 5xx/network back off. Transient-DNS
  and VPN flaps no longer produce multi-page tracebacks.
- `data.json`/`data.js` are written atomically together (`datafile.write_outputs`), byte-identical
  to `sync-datajs.mjs`; a run that leaves `data.json` invalid restores the pre-run snapshot.
- The AI queue dedups against claimed jobs, requeues orphaned `.running` jobs on restart, and
  honours the `.ai-cancel-report` marker; `/health` turns 503 when a worker thread dies.
- Both images carry `HEALTHCHECK`s; `tini` is PID 1 in the board; the `jira-ai-models` volume is
  created automatically; `start-jira-board.sh` no longer re-pulls base images (`PULL=1`).
- `docker compose up jira-board` works without the AI pair (`required: false`); the board shows
  "AI intern offline".
- Node `>= 22.12` is declared in `package.json`; images and CI use Node 26 (`.nvmrc`).
- A React `ErrorBoundary` wraps the app; settings parsing validates every field and falls back to
  defaults.

### Features and configuration

- Optional proof rows for PR reports — Bitbucket build status (CI), Checkmarx, Dynatrace — are
  queried when `CHECKMARX_API_KEY` / `DYNATRACE_PAT` and `endpoints.checkmarxBase` /
  `checkmarxAuthUrl` / `dynatraceTenants` (or their env equivalents) are configured.
- New config keys `bitbucket.projectMap` and `bitbucket.repoHints` replace built-in repository
  names; both default to empty. `jira-intern/config.json` (dead) was deleted; the only config is
  `config/jira-board.config.json` plus the sparse `~/.ai/config.json` override.
- Won't fix / cancelled / rejected statuses map to Done on both sides of the column contract.
- Cursor cloud models are filtered by price (`cursor-prices.json`); Claude lists Haiku, Gemini lists
  Flash/Lite.

### Tests and CI

- Python `unittest` suites under `tests/`: HTTP retry/pagination/TLS, daily fetch flow and
  single-key refresh, archive rebuild and scopes, `data.js` parity and atomic writes, data lock,
  config helpers and Node ↔ Python config parity, sprint fields. `npm test` runs them with the
  vitest suite (`npm run test:py` / `npm run test:js`).
- CI runs shellcheck, config validation, the tests, typecheck, the single-file build and a Docker
  build smoke test on every push and pull request.

### Documentation

- Every guide now lives under `docs/`: new `API.md`, `RUNTIME-FILES.md`, `SECURITY.md`,
  `CONTRIBUTING.md`, `AGENTS.md`, `CHANGELOG.md`; `ARCHITECTURE.md`, `DEPLOYMENT.md`, `USAGE.md`,
  `index.html`, `README.md` and `setup/README.md` rewritten against the current code (three
  containers, loopback default, `BIND_IP`/`ALLOWED_HOSTS`, non-root mounts, TLS, cadence from
  Settings, backfill flags, Completed dialog, header menus, Settings sections, shortcuts).
- A 5-line root `CLAUDE.md` imports `docs/AGENTS.md`.
- `jira-intern/prompts/pr-readiness-prompt.md` and `intern-summary-prompt.md` are marked as
  reference specifications (the live prompt is `ai-intern/prompts/enrich.txt`);
  `intern-prompt.md` now states the 5-day "recent win" window (`app.doneBoardDays`).
- `setup/README.md` gained a private-CA step and a pre-publish checklist that covers git history.
- The PR template asks for passing tests and updated docs.
