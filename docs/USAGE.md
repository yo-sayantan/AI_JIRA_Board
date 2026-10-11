# Using the board

A tour of what's on screen and how to drive it.

## Layout, top to bottom

- **Header** — your name, last-fetch freshness, the current-sprint pill (name · dates · working
  days left · progress bar), live **search**, light/dark toggle, **Refresh/Reload**, and the
  **API keys** key button (amber dot until the Jira token is saved — see below).
- **Stat chips** — one per column plus scope toggles. Click to filter; click again to clear.
- **Board** — the kanban columns: To Do · Blocked · In Progress · In Review · QA · Done. Any empty column folds to a slim rail so the columns with cards get the width (it opens to a compact *Drop here* zone while you drag); QA has a separate **QA In Progress** space under it, in the same column, for tickets the QA team has picked up (like On Hold under Blocked, but you cannot drop on it).
- **QA lane** — QA and QA In Progress are for QA tickets (raised by you or linked to your work — type QA/Test, a `QA` label, or a "QA:" title). A ticket of yours can't be dropped there, and a QA ticket can only go to QA · QA In Progress · Blocked · On Hold · Done.
- **Move rules** — a ticket in **Done** is final: its card can't be dragged anywhere. Next Sprint takes only To Do, Blocked, QA and On Hold cards and releases them only to To Do. In Review needs a PR (a sub-ticket can use its parent's open PR); Done needs every PR merged or declined and a QA ticket raised. While you drag, a zone that won't take the card says why. For a PR / QA rule, hold **⌥ Option** while dropping to force it (you confirm in the notification). Every move can be undone from its notification for 8 s. The **Rev / Done dots** on cards show ahead of time whether those moves would go through.
- **On Hold** — its own small space under Blocked, in the same column: drop a card on it to put the ticket On Hold in Jira; held tickets are listed there. Blocked, On Hold and QA In Progress can each be switched off in Settings → Board sections — a switched-off section and its tickets are not shown at all.
- **Demo mode** (Settings → Features) — swaps in a sample board to try drag-and-drop and the
  gates on. Nothing reaches Jira while it is on, and your real board returns when you turn it off.
- **Next Sprint** — a space at the end of the To Do column for tickets queued in a sprint that hasn't started (see below).
- **Completed** — the full historical archive (top-right trophy chip).

## The chips (top row)

| Chip | Does |
|---|---|
| **All N** | First in the row and selected by default — the whole board. Picking a column chip filters; click it again (or All) to return. |
| **To Do / In Progress / In Review / QA / Done** | Filters the board to that one column. Click again to clear. |
| **Raised open/total** | Opens the Raised-by-me view — every ticket you reported (see below). |
| **Completed** | Opens the full archive of every Done ticket. |

Search (`/` to focus) narrows everything live; a bare number is treated as a ticket/PR id.

## Raised by me

The indigo chip (e.g. **Raised 6/12** — six still open of twelve you ever reported) opens an
archive-style view of every **non-sub-task ticket you raised**: bugs you spotted and filed for
someone to fix later. It answers three questions per row, straight off the aligned right rail:

- **Status** — colour-coded pill (the row's left edge carries the same colour).
- **Assignee** — teal *me*, a violet name for someone else, or grey *unassigned*.
- **Hands** — `↻ N`, how many times it changed owners since you filed it; hover for the chain.

Expand a row for the quick peek: the AI brief, the full description you filed, dates, the
hand-off trail as a pill chain (*raised by you → A → B* with dates), and **Linked tickets** —
what it was raised from / blocks / duplicates (also shown inline as a `⇄ KEY` chip). Clicking a
row opens the full ticket drawer like anywhere else.

Filters: status buckets (Open · In progress · Review/QA · Fixed), assignment (With me · With
others · Unassigned · Reassigned), projects and types — plus the same search grammar as the rest
of the board. Rows group by the year/month you raised them.

**Hard refresh** (top-right of the view) re-pulls *every* ticket you ever reported straight from
Jira — rows already listed pick up updates, newly raised ones appear. You need it because tickets
other people work never ride the normal board refresh; the "fetched X ago" stamp under the button
shows this list's own freshness. The daily refresh and an archive rebuild also update the list.

Sub-tickets you created under your own tickets don't count — those are yours by default and live
on the board. The whole feature toggles in Settings → **Raised by me**.

## Next Sprint

Tickets assigned to you whose sprint **hasn't started yet** — a dated future sprint, or the **READY** /
**REFINEMENT** bucket — are kept **out** of the To Do box, so a sprint where you've finished all your To Do work
doesn't look full. They live in their own space at the **end of the To Do column** (like QA In Progress under QA):

- Tickets are grouped by sprint, each headed by its name and when it starts ("starts in 3 days · Oct 14", or "not started" for a bucket).
- It's always there to drop on, and counts in the To Do chip.
- **Into it:** drag a To Do, Blocked, QA (not QA In Progress) or On Hold card. In Jira it joins the nearest
  dated future sprint (else READY, else REFINEMENT) and becomes To Do. In Progress, In Review, Done and QA In Progress cards can't go.
- **Out of it:** a Next Sprint card can only go back to **To Do** (it joins the active sprint). Everything else dims.

## PR Readiness Report

Every ticket that has a pull request gets a management-grade **PR Readiness Report** — the
2-second verdict on "can this ship?", with the evidence behind it. Open a ticket: the report
button sits **above the AI brief**, coloured by its verdict.

| Button state | Meaning |
|---|---|
| **PR Readiness Report · Ready 90/100** (coloured) | A report exists — click to open it. |
| **Generating PR readiness report…** (spinner) | Being built in the background; the button appears when it lands. |
| **Generate PR readiness report** (dashed) | None yet — click to build one (server/Docker mode). |

The report opens as a tabbed overlay. Tabs are **colour-coded by relevance** so you can skip the green ones:

| Tab | Colour | What's in it |
|---|---|---|
| **Verdict** | the verdict's colour | Decision + next action (owner → action → due sprint), 5 at-a-glance tiles, the **gate checklist** (approvals, comments, changes requested, merged, QA sub-task, dependencies, fixVersion, release branch, CI, security scan — the first *Fail* is the reason for the verdict), release-gate warning when triggered |
| **Evidence** | worst row wins | Evidence chain — *Source · Observed · Conclusion*, one row per fact; every PR (cards, or a worst-first table when >4); timeline |
| **Open scope** | red / amber / green | What still blocks closure with an **Owner** column (UNASSIGNED in red), ≤3 next actions, status-consistency warning (e.g. closed in Jira but PR never merged) |
| **AI assessment** | violet | Only after the AI pass: per-file change classification (Required / Neutral / Risky), review focus, production proof (Dynatrace), deployment & rollback facts, risks, the ticket-specific release gate |
| **Sources** | grey | Every link, run metadata, fingerprint |

Verdicts: *Ready to merge · Merge-ready, scope open · Awaiting approvals · Blocked (unresolved comments /
changes requested) · Merged, awaiting verification · Ready to close · Shipped · Shipped, no fixVersion ·
Closed in Jira, code not merged · Declined, no replacement · On hold* — plus a *stale* modifier after 14
idle days. The deterministic pass **owns** the verdict, score and every colour; the AI pass may only add
(its own tab, extra evidence rows, CI/scan gate states) — a report that changes anything derived is
rejected and the base is restored. Every block carries a provenance chip: **measured**, **AI-enriched**,
or **not verified** (a gap — shown, never hidden). A ring shows the 0–100 readiness score.

**How reports are produced.** Two passes, so a report always exists once a PR appears:
1. *Deterministic base* — `jira-intern/pr_report.py`, from the fetched ticket data. No AI, no network.
2. *AI enrichment* — **JIRA-AI-Intern** (Ollama locally, or Cloud AI) merges structured JSON
   (business impact, per-file notes when a file list exists, risks). Settings **None** stops after
   the base. **Max** is the longest timeout (`full`). Cloud AI is Claude or Cursor; the intern
   reads `ANTHROPIC_API_KEY`, `CURSOR_API_KEY`, or `GEMINI_API_KEY` only from `setup/.env` — add them with the key button.
   Cursor lists a few Gemini Flash models, GPT-4o, Grok, and Chinese models (Qwen, DeepSeek, Kimi, GLM).
   The models in the dropdown are the ones in `ai-intern/cloud-models.json` — add or delete a row there and it follows. Effort is **Auto** (default — the model's own), **Low**, **Medium** or **High**, as listed for each model; a **costly** model (⚠, output at or above the file's `costlyOutputUsd`, $10 by default) is fixed at **Medium** and its effort dropdown is shown disabled. An effort the model cannot take as a parameter is passed as guidance in the prompt. Local models see on-disk
   intern data plus live Jira/Bitbucket (MCP tokens). CI / Checkmarx / live Dynatrace stay Not verified.

**When they are generated.** Automatically after every fetch for any ticket whose PR appeared or
changed (background, capped by `reports.maxPerRun`), after a single-ticket refresh, or on demand from
the button. Reports live in `jira-intern/reports/` — **git-ignored**, they contain real company data.
Backfill a whole year by hand: `bash jira-intern/local-runner/pr-reports-backfill.sh --year 2026`.

## API keys

The key button in the header (beside Settings) opens one list with a row per service — Jira (required), Atlassian Cloud, Bitbucket, Confluence, Jenkins, Checkmarx One, Claude, Cursor, Gemini, OpenAI, GitHub. A row is lit in its colour once its keys are saved,
grey until then; a row marked **Not used yet** (Jenkins, GitHub, the Atlassian Cloud email and site) can be filled in now for
integrations that are coming. Click a row to see why it is needed, what uses it and where to get it, then paste the key
and **Save**. A saved key shows masked (first and last few characters only); paste a new key into the box to replace it,
or **Remove** it (asks to confirm). Keys are stored in `setup/.env` on this machine — git-ignored, never
served — and take effect on the next fetch or AI call, no restart. A brand-new board with no data yet
shows **Add API keys first** on its empty screen. The button is hidden when the board is opened as a file.

## Cards

Every card is a **fixed height**, full column width. Pills wrap inside a two-line cap so banners
never grow the shell. Hover lifts with a light 3D tilt (off when motion is disabled). A **red
border** means the ticket carried across more than one sprint. Done cards spark once on first
paint after a page load. **Click a card** to open its full detail drawer. On a Done card, the
trophy button retires it to Completed immediately (undo from the strip under the board).

## Ticket detail (drawer)

A slide-in with every section expanded: status pipeline, overview (sprint/people/epic/labels),
PR card, description, an interactive acceptance-criteria checklist, comments, related issues,
Confluence/docs, proposed solution, effort, open questions, a copy-able branch, and sources.
Open a sub-task to stack another drawer on top; **Esc** or the backdrop closes.

## Completed archive

Collapsed by default. Expand to a compact list (number · name · status); each row has a ▸ to
**peek inline** (opened, closed, branch, PR/merged) without leaving the page, plus *Expand all*.
Click a row for the full detail page.

## Keyboard

| Key | Action |
|---|---|
| `/` | Focus search |
| `r` | Refresh / reload data |
| `Esc` | Close the top drawer / overlay |
| `Enter` / `Space` | Open the focused card |

## Refreshing

- **Docker / live server:** the header **Refresh** runs the fetch and reloads when data lands.
- **Static file:** **Reload** re-reads the last dump; run a fetch in a terminal for new tickets.

See [`DEPLOYMENT.md`](DEPLOYMENT.md) for the fetch commands.
