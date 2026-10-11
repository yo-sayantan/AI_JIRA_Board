# Features — what the board does and where each piece lives

Every user-facing capability, its behaviour rules, and the code that implements it. File paths
are the fastest way into any feature.

## The kanban board

| Aspect | Behaviour | Code |
|---|---|---|
| Columns | To Do · **Blocked** · In Progress · In Review (folds Ready4Review/Code Review) · QA · Done, fixed order. Blocked is a side state (not a pipeline stage). **To Do, QA and Done are drawn thinner** (`ColumnMeta.slim`) and the spare width goes to Blocked · In Progress · In Review, whose cards carry the most (a card narrower than 13rem drops its age). **Every empty column folds to a slim labelled rail** and its width goes to the columns that have cards; while a card is dragged it opens only to a compact (7rem) drop zone labelled *Drop here*, so the board barely moves under the cursor. A column focused by a stat chip never folds. The rule is one pure function, `columnMode` | `src/lib/columns.ts` (`BOARD_COLUMNS`, `columnMode`), mapping fallback `mapStatusToColumn`; widths in `board/Column.tsx` |
| Column assignment | The intern maps raw Jira status → `column`; the app trusts it, with a word-boundary fallback for unknown statuses | `jira-intern/_jira.py::status_column`, `src/data.ts::normalizeTicket` |
| QA In Progress | Its own space under QA, in the same column — a separate header and box, built exactly like On Hold under Blocked (`board/SubSection.tsx`), slim when empty — for tickets the QA team has picked up (`In QA`, `Under QA`, `In Testing`, `QA In Progress`… — any QA status that is not a ready/awaiting word). A drop target of its own (`qaip`): dropping on it lands on an in-progress QA status, dropping on the QA box lands on a ready-for-QA one. QA folds to a rail only when both spaces are empty. See **The QA lane** below | `src/lib/columns.ts` (`isQaInProgress`, `QA_IN_PROGRESS`), `board/Column.tsx`, `transition.py` (`PREFERRED['qa']`, `PREFERRED['qaip']`) |
| Cards | Key, title, type glyph, a **priority tile** (rounded square, one bold glyph per tier — Critical a solid red tile with `!`; Highest double chevron up, High single chevron up, Medium a dash, Low chevron down, Lowest double chevron down, each tinted in the tier's colour), points, **branch** (parent cards: the branch(es) a PR was raised from with `+N` for more; no PR → only the newest branch; no branch → nothing; `cardBranches` in `lib/format.ts`), PR badge (the PR of the ticket's newest branch), `+N PR` for the others, comment count, age, sprint-carryover marker | `src/components/board/TicketCard.tsx` |
| Done retirement | A Done ticket stays ~3 days as a "recent win", then auto-retires into Completed (`app.doneBoardDays`) | `src/data.ts::prepare` |
| Manual archive | Trophy button on a Done card/drawer moves it to Completed immediately; undoable until reload drops it | `src/data.ts` (localStorage `jb-archived`), `ArchivedUndo` in `board/BoardNotices.tsx` |
| Empty board | Celebration state when nothing is active | `board/FunEmptyBoard.tsx` |
| Drag to change status | Drop a card in To Do / Blocked / **On Hold** / In Progress / In Review / QA / QA In Progress / Done and the ticket is transitioned **in Jira** in the background. The card moves at once; Jira's verdict arrives a few seconds later and a refusal slides it back. **Done is final:** a ticket in Done cannot be dragged to any other column — the card is not draggable, every zone refuses it, and the server refuses it too (never forcible; only the Undo right after the move reopens it). **The QA lane:** QA and QA In Progress hold *QA tickets* — raised by you or linked to your work. A QA ticket is one whose type is QA/Test, whose Jira label marks it (`QA`, `qa-ticket`, `testing`… — not `qa-failed` / `needs-qa`, which describe a dev ticket), or whose title starts "QA:" / "[QA]"; anything sitting in QA counts. QA tickets are rarely assigned to you, so the fetch brings in the ones **you raised** and the ones **linked to your tickets** (they show in To Do or wherever their status puts them, whoever holds them). Only a QA ticket may enter QA / QA In Progress, and a QA ticket — wherever it sits, To Do included — moves only to **QA · QA In Progress · Blocked · On Hold · Done**. Every other ticket moves freely outside the lane. **In Review** needs a PR (open or merged; declined does not count) — a sub-ticket may instead ride on an *open* PR of its parent. **Done** needs no PR still open (each merged or declined), at least one PR (a sub-ticket may have none of its own), and a **QA ticket raised** — not finished — on the ticket (a sub-ticket's parent's QA ticket counts). QA tickets close freely. On Hold warns when a PR is still open. The parent's PR never counts as a sub-ticket's own, and no ticket counts a PR that names only other tickets (a release PR, a merge from dev). While you drag, a refusing zone says why (the full reason on hover): the QA lane fades it out of the way and can never be forced; a PR / QA gate shows *⌥ + drop to force* — hold Option while dropping and a notification asks *Force move?* first (the board's data can be a refresh behind Jira). A drop the server refuses on live data offers *Move anyway*. Every finished move offers **Undo** for 8 s (it puts the ticket back, no rules). The board judges the cached dump (`src/lib/moveRules.ts`); the server re-judges live Jira (`transition.py`), so the rules hold for any client. Settings → *Drag to change status*; needs the local server. | `src/lib/moveRules.ts` (every rule), `board/Column.tsx` (zones, reasons, ⌥), `board/TicketCard.tsx` (native drag), `src/hooks/useTicketMoves.ts` (optimistic override, bounce-back, force, Undo), `POST /api/move-ticket` in `server/serve.mjs` → `server/jobs.mjs::moveTicket` → `jira-intern/transition.py` |
| Move readiness on cards | Two small dots on every In Progress / Blocked / On Hold / In Review card: **Rev** (could it go to In Review now?) and **Done** (could it close?). Green = the move would go through; amber = something is missing — hover for what. Not on To Do, Done or QA tickets. Judged from the board's data, the same rules as the drop zones. Settings → *Move readiness on cards* (shown only while drag-and-drop is on) | `src/lib/moveRules.ts::readinessOf`, `ReadinessDots` in `board/TicketCard.tsx` |

## Demo mode

Settings → Features → **Demo mode**. Replaces the board with ~50 invented tickets so every
feature can be exercised without real data — and with every server call switched off.

| Aspect | Behaviour | Code |
|---|---|---|
| Where the tickets live | **`jira-intern/demo/`** — beside the real dump, so they can be read and edited by hand. `data.json` is the one file the board loads. Served mode fetches the folder, so an edit shows on reload with no rebuild; `file://` uses the copy compiled into the bundle | `jira-intern/demo/`, `src/demo/data.ts` |
| Dates stay fresh | The file stores real dates anchored to `_demoNow`; every date is shifted onto the current clock at load, so the active sprint is still running, Next Sprint still has not started, and the oldest Done card still says "archives in 1d" | `src/demo/data.ts::rebaseDemoDump` |
| What you get | 50 board tickets covering every column and move target — To Do, Blocked, In Progress, In Review, both QA shelves, Done, On Hold and Next Sprint (a dated sprint, a READY and a REFINEMENT bucket, plus an undated non-bucket sprint that stays in To Do) — with QA tickets recognised by type, by label (`DEMO-248`) and by title (`DEMO-249`), a QA ticket I raised linked to my Blocked ticket in To Do (`DEMO-247`), every priority (Critical/Blocker → Lowest, plus unprioritised) and issue type (the title-derived Release and Onboarding included), nested and standalone sub-tasks, PRs in **every** state (merged · approved · one approval short · approved-with-open-comments · changes requested · declined-then-retried · all attempts declined · declined only · none · several across repos), Done cards that are locked (closed, resolved, cancelled; one archiving tomorrow, one already retired), every optional drawer section and AI briefs (one JSON-wrapped, healed at render), search targets for every query form, a 19-row Completed archive over three years (releases to Prod/Stage/Demo, cycle times, context parents), 10 Raised-by-me rows in every status bucket with hand-off trails, and two sample PR Readiness Reports (`DEMO-230` ships, `DEMO-210` does not). The full scenario list is in `jira-intern/demo/README.md`; `src/demo/data.test.ts` and `gates.test.ts` assert each one | `jira-intern/demo/data.json`, `src/demo/reports.ts` |
| The move gates, both ways | Done: `DEMO-242` and `DEMO-240` go through (PR merged, QA sub-task raised), `DEMO-237` on a linked QA ticket; `DEMO-241` (no QA ticket), `DEMO-244` (fix PR #433 still open) and `DEMO-201` (no PR) are each refused for a different reason; sub-task `DEMO-220-2` may close on its parent's QA ticket, `DEMO-223-1` may not. In Review: `DEMO-222` (no PR) and `DEMO-226` (declined PR only) are refused; sub-task `DEMO-220-2` rides on its parent's open PR, `DEMO-225-1` is refused because its parent has none. Done cards refuse every zone; Next Sprint takes To Do / Blocked / QA / On Hold cards and gives them back only to To Do; QA tickets stay in the lane. Hold ⌥ while dropping to force a PR / QA gate, then Undo | `src/demo/gates.ts` |
| Drag-and-drop | Works fully, and runs the **same PR / QA gates in the browser** — a Done with an unmerged PR or open QA still slides back with the reason. `src/demo/gates.ts` mirrors `jira-intern/transition.py::evaluate`; `gates.test.ts` pins both | `src/demo/gates.ts` |
| Nothing is sent | Board/archive/raised refreshes, per-ticket refresh, report generation and transitions are all refused with one message. `runner.ts::setDemoMode` is the hard switch — it makes those calls return a refusal before any `fetch`, so a path nobody guarded still cannot reach Jira or the AI intern. Settings (including an AI model pull) still work: they configure the machine and are never triggered by a demo ticket | `src/lib/runner.ts`, `src/hooks/useInternJobs.ts`, `useReports.ts`, `useTicketMoves.ts` |
| Your real data | Untouched. The dump is built in the browser, never written; the archive set is kept in memory so `jb-archived` keeps the real board's keys. Turning the toggle off restores the real board immediately, no reload | `src/hooks/useBoardData.ts` |
| Telling them apart | An amber **Demo mode** banner sits above the chips with a "Show my real board" button; `DataSource` reports `demo`; every URL in the data points at `example.com` | `board/BoardNotices.tsx::DemoBanner` |
| Reset | **Reset demo** in the banner (beside "Show my real board") puts every card back where the sample board starts: it forgets every move (the pins in `useTicketMoves`), restores cards moved to Completed, closes drawers and clears the old Undo toasts. It shows how many changes it will undo and is greyed while there are none. Entering or leaving Demo mode starts clean too, so demo moves never carry over | `App.tsx::resetDemoBoard`, `useTicketMoves.reset`, `useBoardData.resetDemo` |

## Stat chips (the row above the board)

`src/components/board/Stats.tsx` — one selection drives everything (`StatSelection`): **All N**
comes first and is selected by default (the whole board); a column chip filters the board to that
column and clicking it again returns to All. The counts include On Hold and Next Sprint tickets.
Right-aligned: the indigo **Raised open/total** chip and the gold **Completed N** trophy.

## Search

`src/lib/search.ts` — one grammar shared by the board, Completed and Raised views:

- A **bare number is an identifier**, matched only against ticket numbers (own, parent's,
  sub-tickets') and PR ids — never free text. `611` prefix-matches `6115`; single digits match
  exactly only.
- `PROJ-6115` / `proj6115` count as exact key matches (lazy project parse so `proj6115` reads as
  `proj`+`6115`).
- Everything else is token-AND substring search over a cached haystack (title, status, people,
  labels, branches, PR metadata, sub-tickets). Rows are indexed once per load (`WeakMap`).

## Completed archive

Near-full-screen overlay (gold trophy chip) listing every Done ticket ever assigned to you.

- Hero stat band (tickets done, story points, PRs merged, releases, onboarding).
- Sticky controls: search, PR filters (any/merged/declined), project chips, type chips,
  expand-all; **Mine only** hides "context parents" (`mine: false` rows — someone else's parent
  shown because you delivered a sub-ticket under it; never counted in totals).
- Pure chronology: year → month by `resolved`; row peek shows lead time vs dev time
  (`cycleTime`), branches/PRs, sub-ticket delivery table.
- Data: weekly `completed_archive.py` rebuild (full or scoped year/since/key via the header's
  Archive menu), per-ticket `cache/*.json`, schema-version busting.
- Code: `src/components/completed/Completed.tsx`, `jira-intern/completed_archive.py`,
  `header/ArchiveMenu.tsx`.

## Raised by me

Overlay (indigo megaphone chip, `open/total` count) for every non-sub-task ticket you
**reported** — bugs filed for later, whoever works them now.

- Answers three questions per row: current **status** (colour-coded pill + left border), **who
  holds it** (me / other / unassigned), and **hand-offs** (↻ count; full `assigneeLog` trail
  from the Jira changelog, rendered as a pill chain with dates).
- Linked tickets: Jira issue links + epic shown as a `⇄ KEY` chip and a "Linked tickets"
  section — what the bug was raised from / blocks / duplicates.
- Row peek: AI brief (when present), full description (scrollable), field grid, hand-off trail.
- Filters: status buckets (Open / In progress / Review-QA / Fixed), assignment
  (With me / With others / Unassigned / Reassigned), projects, types; same search grammar.
  "With me" reads the stored `"Display Name (ID)"` assignee through `format.ts::isAssignedToMe`
  (id against `user.accountId`, else name against `user.name`).
- **Hard refresh** button: full re-pull of every reported ticket (existing rows update, new ones
  appear) — these tickets never ride the normal board refresh once someone else works them.
  Shows a "fetched X ago" stamp (`raisedAt`).
- Sub-tasks are excluded twice (JQL + parent-field filter): a sub-ticket you cut under your own
  work is yours by default, not "raised" work.
- Code: `src/components/raised/Raised.tsx`, `jira-intern/raised.py`,
  `local-runner/refresh-raised.sh`, `POST /api/run-raised`, counts in `lib/boardView.ts`.

## Next Sprint

To Do tickets in a sprint that hasn't started are pulled OUT of the To Do box into their own space **at the
end of the To Do column** — a separate header and box built exactly like QA In Progress under QA
(`board/SubSection.tsx`). Which sprints count: a **dated** future sprint, or the **READY** or **REFINEMENT**
bucket (e.g. "Team READY"); any other undated future-state sprint leaves its tickets in the To Do box.
Inside it each sprint is captioned with its name and when it starts ("starts in 3 days · Oct 14", or "not
started" for a bucket / a slipped start), soonest first, then READY, then REFINEMENT. The space is always
there to drop on (slim when empty). The fetch needs nothing special: every ticket assigned to you, in any
sprint, is already imported, and the buckets are sprints like any other.

**Moves — and only these:**
- Into Next Sprint: **To Do, Blocked, QA (the ready shelf — not QA In Progress) and On Hold** tickets, QA tickets
  included. In Jira the ticket joins the **nearest dated future sprint**, else the **READY** bucket, else
  **REFINEMENT**, and is set to **To Do** when it was Blocked / On Hold / QA. No future sprint at all → refused
  with that reason. In Progress, In Review, Done and QA In Progress tickets cannot enter.
- Out of Next Sprint: **only to To Do** — in Jira the ticket joins the **active sprint** (status stays To Do).
  Every other zone dims ("Next Sprint: back to To Do only").
- It is a sprint assignment, so no PR / QA gate applies; it is never forcible with ⌥; Undo works.

`src/lib/format.ts::isNextSprint`, `src/lib/moveRules.ts` (rules), `board/Column.tsx` (`queued`),
`jira-intern/transition.py::move_sprint` (Jira Agile API: `/rest/agile/1.0/board/{id}/sprint`,
`/sprint/{id}/issue`). The old bar below the board, its Next Sprint chip and the chip-driven expand/scroll are gone.

## On Hold

Its **own space in the Blocked column**, under Blocked and separate from it — its own header and
its own box, never nested inside Blocked's. It is always there to drop on — a card dropped on it is
put On Hold in Jira (`transition.py` picks an On Hold status; an open PR earns a notice, never a
refusal) — but stays a slim box when empty, and Blocked's box shrinks to its cards so On Hold sits
right below it. When both are empty the column folds to a rail of two separate boxes (Blocked above
⏸ On Hold); during a drag it opens to two separate drop boxes at the top. Settings → *On Hold section* off hides the space and its tickets and removes the target. The column's one set of drag listeners tells the two targets
apart by `closest('[data-drop="hold"]')`. `board/OnHold.tsx` (`OnHoldSection`), `board/Column.tsx`,
`splitBoard` in `lib/boardView.ts`.

Drag targets are ONE list, `jira-intern/move_targets.json`, read by the board
(`lib/columns.ts::MOVE_TARGETS`), the server (`server/jobs.mjs`) and `transition.py`.

## Ticket detail drawer

Click any card/row anywhere → a right-side drawer with the full ticket: AI brief, description,
acceptance criteria, code (branches + PRs with reviewers/approvals/comment-resolution), Proof (which
vulnerabilities a fix ticket fixed per Checkmarx, latest Jenkins build per environment — shown only when
there is something), comments,
links (related/Confluence/external), update log, sub-tickets (each openable — drawers **stack**,
with breadcrumb depth and Esc closing only the top layer).
`src/components/ticket/TicketDetail.tsx`, stack in `hooks/useDrawerStack.ts`; archive/raised rows
are adapted via `completedToTicket` / `raisedToTicket` so one component renders all three.

## Jenkins builds (cards, drawer, CI gate)

For every branch of my tickets, the **latest build in each environment's Jenkins multibranch job**
(config → `jenkins.jobs`, credentials `JENKINS_USER` / `JENKINS_API_TOKEN`). Fetched by
`jira-intern/jenkins.py` inside the daily fetch (fast path included) and the single-ticket refresh,
stored as `Ticket.builds`, carried forward when Jenkins is unreachable — each carried build marked
`stale: true`. Job URLs must be https (an http one is skipped).
- **Card**: one flat chip per environment on one row — `QA ✓ #412` green, `✗` red for a failure, amber
  for unstable, a turning blue ring while building, grey for aborted / not built. The primary branch's
  build stands for the environment; the tooltip has branch, age, duration, tests and the failed stage —
  and, for a stale build, "· stale" plus "Stale — Jenkins could not be re-read; this is the last build seen".
  `components/common/Builds.tsx::BuildChip`, picked by `lib/format.ts::cardBuilds`.
- **Drawer → Proof → Builds**: per build a result pill, environment, `#number ↗` (opens Jenkins), repo,
  age · duration, deploy target, branch, tests (passed / failed / skipped + up to 5 failing names) and the
  failed stage. Hidden when the ticket has no builds. `components/ticket/Proof.tsx` is the Proof section —
  one group per outside source (Builds, Vulnerabilities).
- **PR readiness report**: the "CI green" gate and one evidence row per build come from these builds in
  the deterministic base report (Bitbucket's commit build status is the fallback) — see `docs/AI-PIPELINE.md`.
  A stale build never passes the gate: it is **Not verified** with the build's age (a fresh failure still fails it).

## Vulnerability fixes (Checkmarx One: cards, drawer, security gate)

For **vulnerability-fix tickets only**, which of the vulnerabilities the ticket names are fixed — and only
those: CVE ids, SAST query names / CWE ids, Checkmarx result links, vulnerable package versions, read from the
title, description, comments and links. Each is looked up in the latest completed Checkmarx One scan of the
PR's source branch and of its base branch: **fixed** (in the base, gone from — or triaged away on — the
branch), **open** (still on the branch), **not found** (in neither), **unknown** (branch not scanned yet, nothing
to compare, no project). Fetched by `jira-intern/checkmarx.py` inside the daily fetch (fast path included) and
the single-ticket refresh, stored as `Ticket.vulnFixes`, carried forward when Checkmarx cannot be read. Needs
`CHECKMARX_API_KEY` + the tenant URL (key button → Checkmarx One); without them nothing is asked.
- **Card**: one flat shield chip, `2/3 fixed` — green when all are fixed, red when any is still open, amber when
  one is not found or not known yet; the tooltip lists every target with its status and the two scans compared.
  `components/common/VulnFixes.tsx::VulnChip`, numbers from `lib/format.ts::vulnSummary`.
- **Drawer → Proof → Vulnerabilities · Checkmarx**: the two scans compared (branch and base, with dates), then
  per target a status pill, kind (CVE / SAST / Result / Package), the target as the ticket names it, severity,
  `file:line` or package version, and the evidence line. `VulnRow`.
- **PR readiness report**: the "Security scan (Checkmarx) clean" gate — Pass when every named target is fixed,
  Fail when any is open, Not verified otherwise (with the reason) — and one "Checkmarx · <kind>" evidence row per
  target, in the deterministic base report (AI level None included). `pr_report.vuln_gate`, shared with the
  AI worker's "Proof · vulnerability fix" table.

## PR Readiness Reports

Ship/no-ship verdict per ticket-with-PR. Deterministic base in seconds
(`jira-intern/pr_report.py` → `reports/<KEY>.json`), optional AI enrichment on top. Rendered from
a fixed block vocabulary (callout/stats/table/cards/list/timeline/links/kv) with per-block
provenance (derived/ai). Bulk generation from the header menu; staleness by PR fingerprint.
`src/components/reports/PrReport.tsx`, `header/ReportsMenu.tsx`, `hooks/useReports.ts`,
`server/reports.mjs`. Details in `docs/AI-PIPELINE.md`.

**PDF export (Print → Save as PDF).** A 16:9 slide deck (13.33 × 7.5 in) built for casting: a
cover, the executive summary, then one coloured section per topic (gates, open items, code review,
evidence, proof, technical assessment, risk, appendix). No running footer or page numbers. Laid out
in three passes before the print dialog opens (`reports/PrReportPrint.tsx`): every block is
**measured** offscreen at true slide width; `reports/printPlan.ts` **paginates** by measured height
— tables split between rows only with the header repeated, list numbering continues, a two-column
composite too tall for one slide falls back to its parts, a nearly empty last slide is rebalanced
with the one before, and short sections share a slide; then `reports/printFit.ts` **fits** each
slide, enlarging sparse content (up to 1.3×) and shrinking dense content (down to 0.62×). Slides
are exactly one page and clip, so nothing ever spills onto the next page.

## AI briefs

Per-ticket summary at the top of the drawer (and in Raised row peeks). Written by the AI
intern's `summarize-active` pass; staleness = `aiSummaryAt` vs `lastUpdate`; ≤8 per pass;
raised rows queue after active tickets. Render path heals JSON-wrapped model output
(`unwrapBrief`). Toggle: Settings → AI briefs; level None disables generation entirely.

## Header

- **Freshness pill** — when the intern last ran, coloured by staleness (`lib/format.ts::freshness`).
- **Sprint block** — active sprint name, dates, working-days-left, progress bar (`sprintStatus`).
- **Refresh board** — the quick daily fetch; the button IS its own progress bar (fill + x/y count
  from `.progress.json`). **Archive menu** — full/year/since/key rebuild with live progress and
  Stop. **Reports menu** — bulk PR-report generation with scope.
- **API keys** (key button beside Settings; an amber dot while the required Jira token is missing) → the API keys
  dialog, below.
- Settings gear, help (?) → the help guide (`help/00-start-here.html`; plain pages, also open from disk), theme toggle.
- `src/components/header/Header.tsx`, `ArchiveMenu.tsx`, `ReportsMenu.tsx`.

## API keys

The one place to add tokens and keys — no file to edit by hand. One list, clustered by kind of service (`groups` in `setup/api-keys.json`: Atlassian · Code hosting · CI/CD & security · AI models) and alphabetical inside each cluster; each row shows a one-line summary (`why`, ≤ 44 characters so it never truncates) and opens to the full explanation (`details`). A row per service from
`setup/api-keys.json` (Jira — required, Atlassian Cloud, Bitbucket, Confluence, Jenkins, Checkmarx One, Claude, Cursor, Gemini, OpenAI, GitHub): lit in the service's
colour when its non-optional keys are set, greyed when not. Each key has a kind — `secret` (masked), `url`, `email` or
`text` (shown in full) — and keys marked `planned` say **not used yet**: they can be saved before the integration that reads
them lands. Each key is one compact row (label · box · Save), with its hint underneath only when it has one; the browser's own
password-reveal button is hidden so there is a single eye. A row expands in place: why it is needed, **Used by**
chips, where to get it, and one field per key (the optional base-URL fields override `endpoints.*` from the config).
An unsaved key shows an empty box and a greyed Save; a saved key shows its **masked** value in the box (first 4 + bullets + last 4;
keys under 16 characters show bullets only, and the length is never revealed) with Save greyed until you type a new one.
Saving a new base URL clears that service's token, so it is never sent to a host it was not entered for. A new secret is typed
as a password with an eye toggle; **Remove** (asks twice) clears a key. **Test** (a small chip on the expanded row, offered
once the service's non-URL keys are saved) checks the SAVED key and URL with one read-only call through the server
(`POST /api/keys/test`, `server/keycheck.mjs`) and shows the answer inline — green **✓ Connected · Signed in as … · 240 ms**,
red **✗ Key rejected (401)** / **Access denied (403)** / **Not found (404)**, amber **Can't reach host** / **Certificate not trusted**,
grey **Not configured: …** — plus a coloured dot on the collapsed row; saving one of the service's keys clears the stale answer.
GitHub (planned) is testable once its token is saved. The empty-state screen of a new install
(no `data.json` yet) has an **Add API keys first** button. Values are written to `setup/.env` by the server
(`GET`/`POST /api/keys`) — the browser never receives a full secret back. Hidden on `file://` (needs the server);
works in demo mode (it configures the machine, like Settings).
`src/components/keys/ApiKeys.tsx`, `src/hooks/useApiKeys.ts`, `src/lib/apiKeys.ts`, `server/secrets.mjs`, `server/keycheck.mjs`.

## Settings

Overlay with three areas (`src/components/settings/Settings.tsx`):
- **Appearance** — theme auto/fixed/scheduled (+ day window).
- **Board sections** — one compact multi-select (`SectionPicker.tsx`) for the optional parts of the
  board: Blocked, On Hold, QA In Progress, Next Sprint, Completed archive, Raised by me. **A section
  switched off is gone**: its tickets are not on the board and not in any count (`inHiddenSection` in
  `lib/boardView.ts`), and the stat chip disappears. Blocked off with On Hold on leaves the column as
  On Hold alone; QA In Progress off leaves QA listing only what is waiting for QA. Hidden work still
  counts as work, so the empty-board celebration does not fire over it. The chosen ones show as coloured chips;
  the dropdown is a checklist with Select all / Clear, fully keyboard operable (↑↓ Home End, Space/Enter
  toggle; Esc closes only the list, not Settings). Which keys count as sections is `SECTION_KEYS` in
  `Settings.tsx`; adding a section is one entry in `FEATURES` + its colour/icon in `FEATURE_STYLE` + one
  key there — never another switch card.
- **Features** — a switch per *behaviour* (drag to change status, demo mode, PR reports, AI briefs,
  shortcuts, refresh on open, auto-refresh, motion & animations, the AI-Ollama container), generated from
  `src/lib/settings.ts::FEATURES` (entry + colour/icon in `FEATURE_STYLE`; TypeScript enforces both).
- **AI usage** — level None/Low/Moderate/Max, backend local (Ollama tag dropdown, host-Ollama
  checkbox, model pulls with live progress) or cloud (provider / model / effort — the models, their efforts Low · Medium · High · Auto and the ⚠ costly line all come from `ai-intern/cloud-models.json`), parallelism knobs (PR reports 1–10 at once),
  server cadences. Server-relevant keys mirror to `jira-intern/.settings.json`.

## Live jobs & notifications

- `useInternJobs` — start/attach/watch daily, archive, raised and per-ticket refresh jobs with
  one shared status poller (`lib/statusPoller.ts`: 12s idle / 4s busy / 1s pulls; pauses when
  the tab is hidden). Toast lifecycle per job; stale-run attach on page load.
- Toasts (`useToasts` + `common/Toast.tsx`), run notices dock (`common/NoticesDock.tsx`),
  stale-data handling via the freshness pill.

## Keyboard & accessibility

`/` focuses search, `r` refreshes, Esc closes the top layer; disabled while typing/overlays and
toggleable. Reduce-motion honoured via the animations toggle (`jb-no-anim`). Colour is never the
only signal (labels/glyphs everywhere). See `help/legal-privacy-and-accessibility.html#a11y` for the public statement.
