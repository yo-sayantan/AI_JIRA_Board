# AGENTS.md — working on this repo (humans and AI agents)

This is the onboarding file. Read it first; it tells you what exists, the rules that keep the
system consistent, and where the deep documentation lives. Written to be enough context for an
AI agent to make a correct change without re-deriving the architecture.

## The 60-second mental model

```
 Jira / Bitbucket / Confluence  ──(your tokens)──▶  jira-intern/*.py  ──▶  jira-intern/data.json + data.js
 Jenkins / Checkmarx / Dynatrace (proof) ────────▶  (the "intern")           │  (+ builds, vulnFixes, dynatrace)
 setup/.env ◀── server/secrets.mjs ◀── key dialog   tokens read from setup/.env │
 AI-Intern container (worker.py) ◀── .ai-queue jobs ◀── server ◀─────────────────┤ reads
        │ writes aiSummary/reports back into data.json / reports/                ▼
        └────────────────────────────────────────────────────▶  dist/index.html (React, single file)
```

- **The app never talks to Jira.** Python scripts ("the intern") fetch into `jira-intern/data.json`
  (+ a `data.js` twin for `file://`); the React app only renders that file.
- **One data contract.** `src/types.ts` is the single source of truth for every shape in
  `data.json`. `jira-intern/prompts/intern-prompt.md` restates it in prose for the LLM-agent
  fallback path. **Change one → change both.**
- **One secrets file.** Every token is in `setup/.env`, written only by the board's API keys dialog
  (`server/secrets.mjs`); `setup/api-keys.json` lists what may go there. Scripts and the worker read it.
- **One writer at a time.** Every job that writes `data.json` is serialised by lock files and the
  server's in-memory flags. Never add a second concurrent writer.

## Repo map

| Path | What it is |
|---|---|
| `src/` | React 19 + Tailwind v4 + Motion app → built into ONE `dist/index.html` (vite-plugin-singlefile). |
| `src/types.ts` | **THE CONTRACT** — `Ticket`, `CompletedTicket`, `RaisedTicket`, `JiraData`, adapters. |
| `src/data.ts` | Dump → board rules (normalise columns, retire old Done tickets, merge user-archived keys). |
| `src/lib/` | Pure logic: `boardView` (derivations/index), `search` (query grammar), `columns` (status→column), `format` (every display helper), `runner` (typed API client), `settings` (feature registry), `statusPoller`. |
| `src/hooks/` | Stateful glue: `useBoardData`, `useInternJobs` (daily/archive/raised/per-ticket jobs), `useReports`, `useDrawerStack`, `useBoardSettings`, `useToasts`. |
| `src/components/` | Feature folders: `board/` `header/` `ticket/` `completed/` `raised/` `reports/` `settings/` `common/`. |
| `jira-intern/` | The data pipeline. `daily_fetch.py` (active tickets + raised list + single-ticket refresh), `completed_archive.py` (historical archive), `raised.py` (raised-by-me fetch, shared), `_jira.py` (HTTP + field formatting), `devinfo.py` (branches/PRs via Jira dev-status), `jenkins.py` (latest Jenkins build per branch, environment and pipeline → `Ticket.builds`) with `jenkins_discovery.py` (finds the pipelines under the Jenkins root; cache `.jenkins-discovery.json`), `checkmarx.py` (Checkmarx One: which vulnerabilities a fix ticket fixed, branch scan vs base scan → `Ticket.vulnFixes`; also the worker's Checkmarx client; `diagnose` from the terminal), `dynatrace.py` (the Dynatrace links in a ticket's text, read-only DQL at listed tenants only → `Ticket.dynatrace`; `inspect` from the terminal), `evidence.py` (the ONE builder of "what Dynatrace / Checkmarx / Jenkins say about a ticket": headline, templated insight, sections, fingerprint — read by the AI brief, the PR report and the worker), `_scrub.py` (cleans outside text — Dynatrace messages, Jenkins console lines — before it is stored or sent to a model), `_sources.py` (what each proof source did this run → `proofSources`, the run notes), `_safe_http.py` (the proof clients' hardened urllib: verified TLS context with an opt-out per source, same-origin-only redirects), `pr_report.py` (deterministic PR reports), `_health.py` (per-service health files `.health/<id>.json` every outside client writes after a real call — the API keys dialog's dots), `datafile.py` (atomic writes, data.js sync), `progress.py` (progress file for button fills). |
| `jira-intern/local-runner/` | Shell entrypoints the server invokes: `run-intern.sh`, `update-completed.sh`, `refresh-ticket.sh`, `refresh-raised.sh`, `pr-report.sh`; `runner-env.sh` (env, locks, timeouts), `config.mjs` (config merge → shellenv/prompts), `sync-datajs.mjs`. |
| `server/` (entry: `server/serve.mjs`) | Zero-dependency Node server: static allowlist + the `/api/*` routes (jobs, reports, settings, API keys, AI proxy, status). `secrets.mjs` reads/writes `setup/.env` for the API keys dialog; `keycheck.mjs` is the dialog's Test button (`POST /api/keys/test`: one cheap authenticated call per service, redirects never followed); `health.mjs` reads/writes `jira-intern/.health/` (`GET /api/keys/health`). |
| `docker/` | `Dockerfile` (build context is the repo root — `docker-compose.yml` sets `dockerfile: docker/Dockerfile`) and `docker-entrypoint.sh`. `docker-compose.yml` stays at the root on purpose. |
| `scripts/` | `start-jira-board.sh` (host build + Docker deploy), `open-guide.sh` / `open-guide.bat` (open `help/00-start-here.html`, no server), `build-help-data.mjs` (writes `help/help-data.js`; `npm run build` runs it first) and `Open Board.html`. |
| `tooling/` | `vite.config.ts`, `vitest.config.ts` — selected by `--config` in the npm scripts. `src/tsconfig.json` is the TypeScript config; `.claude/CLAUDE.md` is the agent entry point. |
| `ai-intern/` | The AI worker container: `worker.py` (job queue + HTTP; Ollama local or Claude/Cursor/Gemini cloud), `brief.py` (the AI brief's facts, prompt and post-checks, incl. the Evidence section), `models.json` (local model catalog), `cloud-models.json` (THE cloud model list: models, efforts, costly line) + `cloud_config.py`, `cursor-prices.json` (Cursor's price table — reference data). |
| `config/` | `jira-board.config.json` — tracked, **generic** project defaults (+ JSON schema). Personal values live OUTSIDE the repo in `~/.ai/config.json`. |
| `setup/` | `api-keys.json` (tracked: THE list of API keys the board knows), the git-ignored `.env` the board's API keys dialog writes (the only secrets file the board reads), and templates (personal config, IDE MCP servers, Desktop launcher) — the guide is `docs/SETUP.md`. Shipped into the Docker image minus `.env` (docker-ignored); compose mounts `./setup` instead. |
| `help/` | **The help guide** (the board's **?** button): plain HTML pages that open straight from disk, numbered in deploy order — `00-start-here.html` … `11-api-keys-and-integrations.html`, `developer-doc-viewer.html` (renders `docs/*.md`), `legal-privacy-and-accessibility.html`. One `help.css`, one `help.js`, and `help-data.js` — a GENERATED copy of `ai-intern/models.json`, `cursor-prices.json`, `cloud-models.json` and `docs/*.md` so tables and docs work offline (`scripts/build-help-data.mjs`; a test fails when it is stale). |
| `docs/` | **Developer documentation** (markdown, see index at the bottom). The only `.md` files outside are runtime inputs, not docs: `jira-intern/prompts/*.md` (LLM prompts read by scripts) and `.github/pull_request_template.md` (GitHub requires its location). |
| `jira-intern/demo/` | Demo mode's sample board: `data.json` (the only source — tracked in git, unlike the real dump) and `README.md`. |
| `src/demo/` | Demo mode's code: loads + re-dates `jira-intern/demo/data.json`, two canned PR reports, and a browser-side mirror of the move gates. Driven by the `demoMode` feature toggle; `runner.ts::setDemoMode` blocks every server call while it is on. |
| `tests/` | Python unittests (`npm test`). |

## Golden rules (break these and the system corrupts)

1. **The contract is law.** Any new field flows `types.ts` → intern script(s) → (if the agent
   fallback should produce it) `prompts/intern-prompt.md`. The UI must tolerate the field being
   absent — old dumps keep rendering.
2. **Single writer.** `data.json` writers: `daily_fetch.py` (daily + `--key` + `--raised`),
   `completed_archive.py`, `ai-intern/worker.py::write_briefs`. All are serialised via
   `.intern.lock` / `.completed.lock` / `.refresh.lock` / `.raised.lock` + `server/jobs.mjs`
   state flags. A new write path must take a lock and be registered in `dataWriterBusy()`.
3. **Preserve, never wipe.** Each job rewrites ONLY its slice and carries the rest forward:
   the daily fetch preserves `completed[]`; the archive preserves `tickets[]` and refreshes
   `raised[]`; every writer preserves keys it does not own (`raisedAt`, `aiSummary`, notes…).
   A FAILED lookup must carry forward prior data, never write an empty list — "couldn't fetch"
   ≠ "there is nothing" (see `code_for`, `fetch_raised`, `subs_by_parent=None` patterns).
4. **Atomic writes + twin sync.** All dump writes go through `datafile.write_outputs()` /
   `atomic_dump()` (temp file + `os.replace`). `data.js` must always equal `data.json` —
   `write_outputs` does both; shell paths re-sync with `sync-datajs.mjs`.
5. **No secrets in the repo. Ever.** Tokens live in `setup/.env` (written by the board's API keys
   dialog; git-ignored, docker-ignored, never served), identity in `~/.ai/config.json`. The repo is public. Before every commit run the leak scan:
   `git diff --cached | grep -icE "<internal hostnames / ids / names>"` must print 0, stage files
   by name (never `git add -A`), and keep `config/jira-board.config.json` generic.
6. **`npm run build` must pass before any commit** (`tsc --noEmit && vite build`), and
   `npm test` runs the Python unittests.
7. **Deploy packages the host-built dist.** `scripts/start-jira-board.sh` builds `dist/` on the host and
   passes `--build-arg DIST_SOURCE=prebuilt`; in-image `npm ci` over the Docker VM's slow network
   silently drops optional native binaries (TypeScript 7's platform packages) and the build dies.
   Never add `--pull` to compose build. See `docs/DEPLOYMENT.md`.

## How to add a feature (worked example: the Raised-by-me view)

The "Raised by me" view (every non-sub-task ticket the user REPORTED, its status, current
assignee, hand-off history) is the most recent full-stack feature — copy its shape:

1. **Fetch** — `jira-intern/raised.py`: one JQL (`reporter = currentUser() AND issuetype not in
   subTaskIssueTypes()`), pages fetched in parallel (`REFRESH_WORKERS`), compact rows built from
   search fields + changelog only (no per-ticket calls, no Bitbucket). Failure keeps prior rows.
2. **Contract** — `src/types.ts`: `RaisedTicket`, `AssigneeHop`, `JiraData.raised`/`raisedAt`,
   adapter `raisedToTicket` so the existing detail drawer renders rows.
3. **Wire into every write path** — daily fetch rides it along; `refresh_one` updates the raised
   row in place (and must NOT plant someone else's ticket into `tickets[]`); the archive rebuild
   refreshes it; the agent prompt says "preserve raised[] unchanged".
4. **Index** — `src/lib/boardView.ts::indexByKey` adds adapted rows LAST (board/archive copies
   are richer and must win).
5. **UI** — `src/components/raised/Raised.tsx`: overlay cloned from the Completed anatomy
   (hero + stat tiles + sticky filter bar + year/month timeline + expandable rows), own colour
   identity. Entry chip in `board/Stats.tsx`, state in `App.tsx`.
6. **Server job** — `local-runner/refresh-raised.sh` → `server/jobs.mjs::startRaised` (respects
   `dataWriterBusy`) → route in `server/serve.mjs` → `src/lib/runner.ts` client → `useInternJobs`.
7. **Feature flag** — one entry in `src/lib/settings.ts::FEATURES` + colour/icon in
   `Settings.tsx::FEATURE_STYLE` (TypeScript forces this) + `FEATURE_ORDER`.
8. **AI** — `ai-intern/worker.py::summarize_active` walks `raised[]` after `tickets[]`;
   `write_briefs` stamps both copies of a key; `fetch_raised` carries briefs across refreshes.

## How to add a proof source (worked example: Jenkins and Checkmarx)

A proof source is an outside system that confirms what a ticket claims — Jenkins builds
(`Ticket.builds`), Checkmarx One fixes (`Ticket.vulnFixes`) and the Dynatrace links in a ticket (`Ticket.dynatrace`) are the three
so far. Copy their shape (Dynatrace is the example of a source that reads *links found in the ticket's text* rather than the
ticket's branches, and that has its own status words):

1. **Key** — a service row in `setup/api-keys.json` (id, colour, why, usedBy, getIt, keys with a `kind`).
   Add the key names to `runner-env.sh::load_agent_secrets` (and the worker if it reads them), or
   `tests/test_api_keys.py` fails. A key nothing reads yet must say `planned: true`.
2. **Config** — non-secret wiring in `config/jira-board.config.json` + schema, generic and empty by default
   (`jenkins.jobs: {}`, `endpoints.checkmarxBase: ""`); real hosts go in `~/.ai/config.json`, never the repo.
   Unconfigured = nothing is asked and prior data is kept. Document it in `docs/CONFIG.md`.
3. **Client** — one module in `jira-intern/` (`jenkins.py`, `checkmarx.py`): credentials only in headers or
   POST bodies, never URLs or logs; follow-up URLs built from config, never from what the server returns; a
   per-run call budget and a "host unreachable → stop asking this run" switch. Return **None when the lookup
   failed**, an empty/absent answer when there is genuinely nothing. A client that is told WHERE to look by ticket text
   (Dynatrace) also needs an allowlist of hosts from config — see the Dynatrace gotcha below.
4. **Contract** — the field in `src/types.ts` (`JenkinsBuild[]`, `VulnFixes`), optional so old dumps render,
   and in `prompts/intern-prompt.md` ("preserve unchanged").
5. **One writer** — `daily_fetch.apply_<x>` on every fully built ticket, full AND fast path (outside systems
   never bump Jira's `updated`) and in `--key` refresh; only the ticket's own branches/PRs after
   `scope_to_subtask`; None → carry the prior value forward. Every other writer passes the field through
   (the archive: `carry_vuln_fixes` + `COMPLETED_KEYS`, if Completed should keep it). Never skip silently: report every ticket
   to `_sources.py` (skipped / looked up / waiting), set `ticket.proofNotes.<source>` when a candidate has no fresh answer, and end
   the run with `_sources.finish` in `daily_fetch.proof_sources_status` (→ the run note, `data.json → proofSources`, the key window's
   "Last fetch" line via `PROOF_SOURCES` in `lib/proofStatus.ts`). A source with its own status words says so there —
   `_sources.finish(statuses=("read", "empty", "unconfigured-tenant"), unit="link", flag="with failed requests or problems")` —
   and `_sources.looked(…, flagged=…)` says which tickets deserve a second look.
6. **UI** — a chip on the card (`common/Builds.tsx`, `common/VulnFixes.tsx`, rendered by `board/TicketCard.tsx`)
   and a group in the drawer's Proof section (`ticket/Proof.tsx`); format helpers in `src/lib/format.ts` with tests.
   Hidden when the field is absent; demo data in `jira-intern/demo/data.json` exercises it.
7. **Report gate / evidence** — one gate function in `pr_report.py` (`jenkins_ci`, `vuln_gate`) used by the deterministic
   base and the worker alike, plus evidence rows; include the field in the fingerprint only when present, so
   adding it does not make every existing report stale. A source that is *context* rather than a pass/fail gate (Dynatrace)
   adds a section to `evidence.py` instead — that is how it reaches the AI brief's Evidence section, the report's Issue
   insight and the worker's Proof rows with no per-consumer code.
8. **Tests + docs** — `tests/test_<x>.py` (URL building, failure → None, matching), the INTEGRATIONS.md
   section (endpoints, failure semantics), DATA-FLOW.md writer/reader lines, FEATURES/USAGE, and the help page
   `help/11-api-keys-and-integrations.html`.

## UI style guardrails

- Controls are **flat chips**: thin outline `hexToRgba(color, 0.45)`, tinted fill
  `hexToRgba(color, 0.07)`, coloured text/icon, Motion spring on hover/tap. **No 3D/skeuomorphic
  buttons** (tried; rejected). The gold `gold-sheen` Completed trophy is the single exception.
- Colour accents are welcome and each view owns a hue — columns: To Do cool grey `#8b94a8` (quiet) · Blocked
  rose `#fb3f5f` · In Progress blue `#2f86ff` · In Review purple `#b05cff` · QA muted grey-teal `#6aa9a1` (quiet; QA In Progress
  `#5f9a93`) · Done green `#2fcf6f` · On Hold orange `#ff8a1f`; views — Completed green/gold · Raised
  indigo · Next Sprint pink. States (`prMeta`): merged `#9a63ff` · approved `#17c47a` · open `#ff9f1c` ·
  changes `#ff4466` · declined `#e11d48`. Cards carry their column's tint at rest — except the `quiet` columns (To Do, QA), which only whisper; badges are gradients (`Pill`).
  Never monochrome; keep gradients, the freshness pill, the sprint block, and animations.
- **Liquid Glass** (`src/styles/glass.css`, the web translation of `ecc:liquid-glass-design`): panels are CLEAR, NEUTRAL
  frosted glass — light from the top, a 1px gradient rim on bars / sheets / menus — over a near-white (dark: near-black) page
  with only a faint ambient hint. Never tint the glass itself (tried: lavender page, coloured dims — rejected as too strong);
  colour comes from the content. Anything floating over the board without its own blur (menus inside the blurred header,
  toasts: `.jb-float`) uses the near-opaque `--pop` fill. It is applied through the TOKENS
  (`--surface-solid`, `--surface-2`, `--sheet`, `--bar`, `--pop`, `--field`) and one attribute selector on `bg-[var(--surface-solid)]`,
  so a new panel needs nothing but that class. Rules: **blur only where glass sits over content** (header, footer,
  `.jb-dialog-panel` / `.jb-sheet`, menus, tooltips) — never on cards or list rows (stacked backdrop-filters wreck scrolling);
  dialogs and drawers are `.jb-dialog-panel` / `.jb-sheet`, never an opaque `bg-[var(--bg)]` (opaque behind glass defeats it);
  an interactive surface gets `.glass-interactive` (pointer-following highlight, `lib/glassPointer.ts`); text on glass must stay
  readable without the blur — the three fallbacks (prefers-reduced-transparency, prefers-contrast: more, no backdrop-filter) go opaque.
  Print slides (`.jb-pdf`) stay flat. Keep the column colours, gradients and animations — glass is the material, not a monochrome.
- Drag and drop: a zone must arm on `dragenter` as well as `dragover`, columns overlap their gap by 6px so
  hit areas touch, widths do not animate while a drag is in flight (`jb-dragging`), and the carried card is a
  translucent clone (`DRAG_GHOST_OPACITY`) so the drop zone shows through it. The board stays "calm"
  (`Board.tsx::SETTLE_MS`: widths snap, cards skip `layout="position"`) during a drag and for 450 ms after it —
  dropping a card back where it was changes nothing in Jira, but the columns re-flow, and a width
  transition plus card springs on top of each other stuttered. The card itself fades back in (`ticket-card-return`).
- Fixed-width right-hand "rails" in list rows (one width table shared by header + rows) so
  columns align to the pixel; labels truncate, never overflow.
- Every icon-only button gets `aria-label`; toggles get `aria-pressed`; overlays are
  `role="dialog"` with focus management; Esc closes ONLY the top layer (`pauseEsc` pattern).

## Build · test · run · deploy

```bash
npm run dev          # Vite dev server with fixture data (src/fixtures.ts)
npm run build        # tsc --noEmit && vite build → dist/index.html (single file)
npm test             # python unittest under tests/
npm run serve        # zero-dependency local server on :4321
bash scripts/start-jira-board.sh   # Docker deploy (host-builds dist, DIST_SOURCE=prebuilt)
```

Docker compose runs three containers: **JIRA-Board** (server + fetch), **AI-Intern** (worker),
**AI-Ollama**. `./jira-intern` is bind-mounted — **the live data lives in whatever directory you
deployed from** (see `docs/DEPLOYMENT.md` → "the data mount follows the deploy directory").

## Gotcha catalogue (hard-won; check before "fixing")

- `search_jira` retries `statusCategory = Done` as explicit statuses on 400 (old Jira);
  `fetch_raised` retries without `subTaskIssueTypes()` the same way.
- A sub-task shares its parent's PR/branch in Jira's dev-status whenever its commits sit on the
  parent's branch. That code is the PARENT's: `devinfo.scope_to_subtask` strips it from the
  sub-task (unless the PR title / branch name has the sub-task's key) in every path that fills
  `prs`/`branches` — and the Done gate (`transition.py::evaluate(is_subtask=…)`, mirrored in
  `src/lib/moveRules.ts`) lets a sub-ticket close with no PR but not with an open one of its own.
- Jira's dev-status links a PR to every ticket named in ANY of its commits (release PRs, merges from
  dev). `devinfo.scope_to_ticket` keeps only PRs whose title/branch name this ticket (or no ticket);
  on real data that removed about half the PRs attached to tickets. Run it in every path that fills `prs`.
- Jira's dev-status index can list a branch that does not exist and claim a PR comes from it. An open PR's
  `sourceBranch` comes from Bitbucket's PR record, and a branch Bitbucket 404s is dropped (`devinfo.branch_head`).
  None of that works while Bitbucket is unreachable from the container — check `bb_ok` in the refresh log first;
  a private-CA certificate error is fixed by `~/.ai/ca-bundle.pem` (added to, never replacing, the system roots).
- Jira comment lists in search payloads are TRUNCATED when long — `comments_for` falls back to
  pagination; don't read `fields.comment.comments` directly.
- `devinfo` returning **no entry** for a key means the LOOKUP failed; `{}`-with-empty-lists means
  "genuinely no code". Callers must carry prior PR data forward on failure.
- PR review state lives in Bitbucket and does NOT bump Jira `updated` — the daily fast path
  re-checks PRs even for "unchanged" tickets (`refresh_prs_only`); sprints are re-applied on the
  fast path too (sprint objects mutate without touching the issue).
- Jenkins, Checkmarx and Dynatrace send credentials, so they never use `_jira`'s opener: `_safe_http.opener` follows a redirect only to
  the same scheme + host + port, and `verified_context` ignores `JIRA_INSECURE_TLS` (Jenkins has its own
  `JENKINS_INSECURE_TLS`, Dynatrace `DYNATRACE_INSECURE_TLS`, passed through wherever `JIRA_INSECURE_TLS` is — compose, `runner-env.sh`, the worker; a test
  checks). Jenkins job URLs must be https. A carried-forward build is `stale: true` and can never pass the CI gate.
- Jenkins multibranch names a branch's job with `/` written as `%2F` (and `%` as `%25`), and that name is URL-encoded
  AGAIN in the path: `feature/ABC-1` → `<job>/job/feature%252FABC-1/`. One function does it (`jenkins.branch_segment`);
  never hand-build a branch job URL. A 404 there = "no build for this branch", not an error.
- Jenkins discovery: the root (`JENKINS_ROOT_URL`, or `jenkins.root` in the personal config) is an internal host — it lives in
  `setup/.env` and must never be committed, not in the tracked config, tests, docs or demo (use `jenkins.example.com` and
  invented names). Names in Jenkins are free-form and **double-encoded in URLs** (a branch job `release%2Fx` is
  `/job/release%252Fx/`; folder / pipeline names are quoted once from the NAMES the listing gives, never from the `url`
  Jenkins returns). The walk's answer is cached in `jira-intern/.jenkins-discovery.json` (git- and docker-ignored; TTL
  `jenkins.discovery.cacheMinutes`; keyed with a signature of the discovery config); a failed walk serves the stale entry
  and, with none, the repo's builds are carried forward — "could not discover" is never "no pipelines". An explicit
  `jenkins.jobs` entry overrides discovery for that repo + environment. A parameterised job's branch match strips
  `origin/` / `refs/heads/`. One card chip per environment: a failed pipeline wins, then the deploy, then the newest
  (`format.ts::cardBuilds`); the CI gate judges every pipeline. Tune labels with `python3 jira-intern/jenkins.py discover <repo>`.
- `Ticket.builds` follows the PR rules: re-read on the daily fast path (a build never bumps `updated`), only for
  the ticket's OWN branches after `scope_to_subtask` (a sub-task never shows its parent's builds), and a failed
  Jenkins lookup CARRIES FORWARD the prior builds (`jenkins.builds_for` → None). Only `daily_fetch.apply_builds`
  writes the field; every other writer passes it through. The report fingerprint includes builds only when a
  ticket has some, so adding the field did not make every existing report stale.
- `Ticket.vulnFixes` (Checkmarx) answers "did THIS ticket fix what it names" by comparing TWO scans — the latest completed
  scan of the PR's source branch against the base branch's — never by reading one scan's totals (a clean-looking count
  says nothing about the ticket's CVE, and a CVE absent from one scan may never have been there: that is `not-found`, not
  `fixed`). A truncated or missing scan is `unknown`, not a verdict. Same rules as builds: re-read on the fast path, only
  for the ticket's own PRs, a failed lookup CARRIES FORWARD the prior results (`checkmarx.vuln_fixes_for` → None), only
  `daily_fetch.apply_vuln_fixes` writes it (the archive carries it), fingerprint only when present. `pr_report.vuln_gate`
  is the one gate rule (base and worker). The worker has no Checkmarx client of its own — it imports `checkmarx.py` and
  calls `isolated_lookup` (under `RUN_LOCK`), never `reset_run` + `vuln_fixes_for` bare: the module state is per run.
  "Unknown, not a verdict" also covers: a scan that did not run the target's ENGINE (SCA for CVEs/packages, SAST for
  queries/CWEs/result ids — the newest of the last 20 completed scans that ran it is used), a branch scan OLDER than the
  base scan, and a per-scan result `id` (only `similarityId` is stable across scans). The project must be named exactly
  `<slug>` or `…/<slug>` — the API's name search is a substring match, never take its only hit as a guess.
  Reading a scan (`checkmarx.read_scan`): a short results page is NOT the last page — a server may cap the page size
  below the `limit` asked, so paging advances by the rows served and ends only on an empty page, `totalCount` or the
  page limit (then `truncated` → `unknown`); never `len(batch) < PAGE_SIZE` (on a server that caps the page size that stops after
  page 1 and calls every target past it "not found"). No severity / state filter. A merged PR's baseline is the newest base scan from BEFORE the
  merge (`scan_plan` → `mergedAt`); after it the base holds the fix. Every `not-found` says what was read
  (`vulnFixes.read`, the detail) — an answer without that is not believable; `python3 jira-intern/checkmarx.py diagnose
  <KEY>` prints it. A proof source never skips silently: `daily_fetch.apply_vuln_fixes` reports every ticket to
  `_sources.py` (skipped / looked up / waiting) and a candidate with no fresh answer gets `ticket.proofNotes.<source>`;
  the run ends in ONE state + line per source (`proofSources`, the run notes, the key window's "Last fetch"). Not
  configured is a quiet grey state, never red or orange.
- `Ticket.dynatrace` follows the same proof-source rules (only `daily_fetch.apply_dynatrace` writes it — full path, fast path,
  `--key`; the archive and `raised[]` rows do not keep it; a failed lookup carries each link's prior answer forward with
  `stale: true`; not configured keeps the prior value; a recent answer — 24 h, 1 h for an open problem, 6 h for an empty answer — is
  not asked again). **Dynatrace is told where to look by ticket text, which is untrusted**, so: (1) only tenants LISTED in
  `DYNATRACE_TENANTS` / `endpoints.dynatraceTenants` are ever contacted — a host found in a ticket only SELECTS which listed
  tenant a link belongs to, and a link to any other host is stored `unconfigured-tenant` and never fetched; (2) never build a
  request URL from ticket text or from anything a response contains: `dynatrace._base` builds it from the validated tenant id
  and the poll URL is rebuilt from the `requestToken`; (3) an id goes into DQL only after its regex (`_safe`), times travel as
  request fields never as DQL, and a link whose id fails validation is kind `other`; (4) every query is time-bounded with
  `maxResultRecords` / `maxResultBytes` / `defaultScanLimitGbytes` (Grail bills by bytes scanned) — a trace or logs link
  with no absolute window is not queried. The DQL **field names are assumptions** (`trace.id`, `request.is_failed`,
  `dt.entity.service`, `loglevel` …): the span query retries once without its field list when a tenant answers 400, but when
  a real tenant disagrees run `python3 jira-intern/dynatrace.py inspect <link | KEY>` (it prints the queries and what they
  return) before changing a summary. A 400 is a finding about the query, not a service failure — it must not turn the health
  dot orange.
- Text that other people write — Jira comments, Dynatrace messages, console lines, the model's own HTML — is **attacker-controlled
  input to every regex that reads it**: patterns are bounded (no nested lazy quantifiers; a tag is ≤ 1,000 characters between `<`
  and `>`: `checkmarx._TAG_RE` / `_A_TAG_RE`, `brief._TAG`, `_scrub`'s `{0,n}` bounds) and each body is capped (`MAX_BODY`,
  `_scrub.MAX_INPUT`, `dynatrace.URL_PARSE_MAX`). Each of these has a "hostile input is fast" test; add one when you add a pattern.
  Never `html.unescape` text you are about to read URLs out of (`&gtf=` becomes `>f=`): `dynatrace._candidate_urls` undoes only `&amp;`.
- **Evidence is built once, in `evidence.py`, and shared** by the AI brief, the PR report and the worker (`build(ticket)` →
  headline / insight / sections; no network, no clock, same input → same output). Do not re-derive facts in a consumer. The AI
  **may not add facts**: a reworded Issue insight is applied only if `evidence.grounded` (no number or identifier — anything with a
  digit — beyond the evidence's; `worker.merge_enrichment`), and `brief.enforce_evidence` appends a missing Evidence section,
  replaces one that adds a number / id, and removes one when there is no evidence (`brief._grounded` mirrors
  `evidence.grounded` — change both). Evidence quotes other systems' text, so it goes in the **untrusted** block
  (`worker.untrusted_packs`), never the trusted FACTS (`brief.split_evidence` leaves only `evidenceSources`). The brief's
  regeneration key is a fingerprint over the FACTS (`evidence.fingerprint`: source, severity, summary, lines, excerpt — never
  a read time, and built without the display time zone), stored as `aiSummaryEvidence`; `needs_brief` compares it both ways, so
  no evidence + no stored fingerprint (`"" == ""`) invalidates nothing. The PR report fingerprint gets `dynatrace` / `consoleTail`
  entries **only when present** (same reason as builds and vulnFixes). Anything stored from Dynatrace or a console passes
  `_scrub` first.
- `builds[].consoleTail` (Jenkins console excerpt): only on the LATEST failed (`FAILURE` / `UNSTABLE`), non-stale build of a ticket
  that `jenkins.is_build_failure` says is ABOUT a failing build / pipeline (title, type, labels, description, acceptance criteria — not
  comments); read from the CONFIGURED build URL (never one Jenkins returned) as a ranged request, else a bounded stream (never
  the whole log; > 2 MiB = not read), scrubbed, ≤ 40 lines / 4 KB, 25 per run. `console_tail` returns a string (the excerpt),
  `""` (nothing to excerpt and asking again will not change it — 404, empty, too long: stored so it is not re-read) or `None` (could
  not be asked: tried again next run); a tail is kept while the build number is unchanged and dropped from every other build.
- `resolutiondate` can be null for tickets transitioned straight to Done —
  `changelog_done_date()` is the fallback.
- A sub-task of yours is stored TWICE (own card + nested under parent); `_merge_ticket` must
  replace every copy. `indexByKey` prefers standalone rows.
- PR numbers are per-repository — identity is `(project, repo, id)` (`_pr_identity`), never id alone.
- The "Motion & animations" switch has TWO halves: the `jb-no-anim` class on `<html>` (tames CSS
  animations/transitions) and `MotionGlobalConfig.skipAnimations` (`src/lib/motionPolicy.ts`, set from
  `applySettings`) for framer-motion, whose JS animations ignore CSS and otherwise follow only the OS
  reduce-motion setting. New motion code needs no extra wiring — but a CSS "off" rule must also set
  `animation-iteration-count: 1`, or a 0.001 ms infinite loop becomes a strobe.
- Drag targets live in ONE file, `jira-intern/move_targets.json`, read by `src/lib/columns.ts`,
  `server/jobs.mjs` and `transition.py` (whose `PREFERRED` must have an entry per target — a test
  checks). Adding a target means that file plus a `PREFERRED` row, nothing else.
- Every move rule exists twice: `src/lib/moveRules.ts` (the board, on the cached dump: zone reasons, readiness
  dots, demo mode, the move hook's pre-check) and `jira-intern/transition.py` (the server, on live Jira:
  `is_qa_ticket`, `lane_blocker`, `evaluate`). `isQaTicket` / `is_qa_ticket` (type QA/Test, a `QA_LABEL`
  label, a "QA:" title) must stay identical; the looser `looksLikeQa` / `is_qa` only find LINKED QA tickets.
  The lane is never forcible; `--force` skips gates only; `--undo` skips everything. Change one side →
  change the other, tests on both (`moveRules.test.ts`, `tests/test_transition.py`).
- `next` (Next Sprint) is a sprint assignment, not a status: `transition.py::move_sprint` talks to the Jira Agile
  API, the board decides membership with `isNextSprint` (a dated future sprint or READY / REFINEMENT; the
  optimistic `Ticket.queued` flag overrides it between a drop and the refresh), and `moveRules.laneBlocker` /
  `lane_blocker` keep it one-way (4 entrances, only To Do out). Mirror both sides.
- The cloud model list is `ai-intern/cloud-models.json` (read by `cloud_config.py`, re-read on edit). Don't add model
  ids or price filters to `worker.py`; `cursor-prices.json` is reference data only. A model the worker may run is one
  Settings offers (`_cloud_allowed`), at an effort the file lists for it (`_effort_for`).
- The help guide must keep working from `file://`: no `fetch` for anything it needs (it reads `help-data.js` via
  `<script src>`, and only refreshes from the live files when served), no CDN or web fonts, no absolute paths.
  `tests/test_help_pages.py` checks every link and anchor, the shared nav / sidebar / pager on every page, and that
  `help-data.js` matches its sources — after editing `docs/*.md` or the model JSONs, run `npm run build` (or
  `npm run help:data`). A new page: next free number, plain lowercase name, add it to every page's nav (the test says where).
- Native drag with ⌥ held asks the browser for a COPY: cards set `effectAllowed = 'copyMove'` and zones set
  `dropEffect = 'move'`, or an Option-drop is refused before the board sees it.
- `.dockerignore` patterns only match at the root unless prefixed `**/` (unlike `.gitignore`) — `setup/.env`
  stays out of the image only because of the `**/.env`, `**/.env.*`, `**/*.env` rules. Likewise the static
  allowlist (`server/config.mjs::STATIC_ALLOW`) must never match a dotfile; `server/http.mjs` also refuses any
  dot-segment path. Break either and the API keys leak.
- `setup/api-keys.json` is the list of keys the dialog offers and `POST /api/keys` accepts. A key added there must be
  READ by something — `runner-env.sh::load_agent_secrets`'s list, `ai-intern/worker.py`, or a connector's `apiKeyEnv`
  in the config; `tests/test_api_keys.py` fails otherwise. The board reads only `setup/.env` (`JB_SECRETS_FILE` moves
  it): `_config.py::secrets_path`, `runner-env.sh` (`APP_SECRETS`), `docker-entrypoint.sh` and the worker must agree.
- Service health: every outside client that sends a credential calls `_health.record_ok` / `record_exception` (Python:
  `jira-intern/_health.py`) after a REAL request, so the API keys dialog's dots follow the latest outcome with no Test
  press — a new client (a new `setup/api-keys.json` service) must do this or its dot stays empty. Only transport / auth / 5xx
  failures count: the **404 (and other 4xx) of a per-ticket / per-branch lookup is NOT a service failure** (Jenkins "no
  build for this branch", Checkmarx "no project"), `classify_exception` skips it, and a failing lookup you add must
  never turn a dot orange for that reason. A record never holds a secret (`detail` = fixed text + host). Colour mapping lives
  once per language and is test-pinned: `_health.tone_of`, `health.mjs::toneOf`, `apiKeys.ts::healthTone` (green ok · red
  401/403 · orange the rest). Header key dot precedence: red, then orange, then the amber "required key missing" dot.
  Under `unittest` nothing is written unless `JB_HEALTH_DIR` is set, so suites never touch a real `.health/`.
- localStorage keys in use: `jb-settings`, `jb-archived`, `jb-completed-show-context`,
  `jb-guide-os` (+ legacy `jb-theme`, `jb-hidden` migrations). No cookies anywhere.
- The board can run from `file://` — every feature must degrade: served-only controls hide or
  toast, data comes from `data.js`, reports from `reports/index.js`.
- Models sometimes return `{"html": "..."}` for briefs despite the prompt — `_clean_brief`
  (worker) unwraps at generation, `unwrapBrief` (src/lib/format.ts) heals at render.

## The full documentation suite

| File | Read it for |
|---|---|
| `docs/FEATURES.md` | Every user-facing feature, how it behaves, where its code lives. |
| `docs/DATA-FLOW.md` | Every file on disk, every writer/reader, locks, lifecycles, flows per job. |
| `docs/AI-PIPELINE.md` | Levels, backends, model catalog, briefs, PR-report enrichment, queues. |
| `docs/INTEGRATIONS.md` | Jira/Bitbucket/Jenkins/Checkmarx/Dynatrace/Confluence specifics, the full HTTP API, Docker topology, config/settings chain. |
| `docs/ARCHITECTURE.md` | The component-level overview (start here if new). |
| `docs/DEPLOYMENT.md` | Run modes, Docker details, deploy pitfalls. |
| `docs/USAGE.md` | The board as a user sees it. |
| `docs/SETUP.md` | API keys (`setup/.env` via the key dialog), the personal config, MCP templates, the public-repo checklist. |
| `docs/SECURITY.md` | Where every secret lives, who reads it, what is served, TLS, the leak scan. |
| `docs/CONFIG.md` | Key-by-key reference for `config/jira-board.config.json` and the personal override. |
| `docs/INTERN.md` | The fetch pipeline (`jira-intern/`) from the inside: scripts, runners, behaviours. |
| `docs/OVERVIEW.md` | The project overview (features, quick start, repository layout). |
