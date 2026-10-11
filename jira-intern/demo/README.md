# Demo tickets

The sample board behind **Settings → Features → Demo mode**. Everything here is invented: no
ticket, person, URL or pull request is real, and nothing in this folder is ever sent to Jira,
Bitbucket or the AI intern. Your real dump (`../data.json`) is never read or written while Demo
mode is on.

| File | What it is |
|---|---|
| `data.json` | **The only source.** The whole sample dump, same shape as the real `jira-intern/data.json` (`src/types.ts::JiraData`). The board loads this. |

## Editing

Edit `data.json`. With the board **served** (`npm run serve`, or Docker), Demo mode fetches this `data.json`, so a
reload shows your edits — no rebuild needed. Opened from `file://`, the board falls back to the
copy compiled into `dist/index.html`, which is refreshed by `npm run build`.

## Reset

Drag as much as you like during a demo: **Reset demo** in the amber banner puts every ticket back
where this file starts (moves forgotten, cards moved to Completed restored). The file itself is
never changed by a demo session.

## Dates stay fresh

Timestamps are stored as real dates anchored to `_demoNow`. On load the board shifts every date by
the difference between that anchor and the current time, so the sample board always looks as if it
were fetched minutes ago — a Done card still says "archives in 1d", the active sprint is still
active, and Next Sprint has still not started. Keep `_demoNow` as it is unless you want to rebase
the whole set.

## What the set covers

51 tickets in `tickets[]` (50 on the board — `DEMO-254` closed a week ago and retires straight into Completed),
12 nested sub-tasks, 19 archive rows over three years, 10 Raised-by-me rows. `src/demo/data.test.ts` and
`src/demo/gates.test.ts` assert every scenario below, so a hand edit that breaks one fails the tests.

- **Every column and move target** — To Do, Blocked, In Progress, In Review, QA (both the ready shelf and *QA In
  Progress*), Done, On Hold and Next Sprint, with several raw statuses folding into each (Open / Backlog,
  Impeded, Implementing / In Development / Work in Progress, Ready4Review / Code Review / Peer Review, Waiting /
  Paused, Closed / Resolved / Cancelled).
- **Next Sprint** — `DEMO-270` / `DEMO-272` in a dated sprint, `DEMO-271` in a READY bucket, `DEMO-273` in a
  REFINEMENT bucket, so every caption and the ordering show. `DEMO-207` sits in an undated *Team Backlog* sprint
  that is not a bucket, so it stays in the To Do box. Drag a To Do, Blocked, QA or On Hold card onto Next
  Sprint, then back to To Do; an In Progress, In Review or QA In Progress card is refused, and a Next Sprint
  card refuses everything but To Do.
- **Done is final** — every Done card (`DEMO-250`–`DEMO-253`, `DEMO-255` cancelled) refuses every zone, even with
  ⌥; only the Undo right after a move reopens one. `DEMO-252` "archives in 1d"; `DEMO-254` has already retired.
- **Every pull-request state** — merged, approved, changes requested, unresolved comments, declined, none; one
  approval short of the requirement; approved while comments are still open; every attempt declined; several
  PRs across repositories; merged while the ticket is still blocked; closed in Jira with the code never merged;
  a hotfix PR into a release branch (`DEMO-213`).
- **The Done gate** — `DEMO-242` and `DEMO-240` pass (PR merged, QA sub-task raised — finished or not);
  `DEMO-237` passes on a *linked* QA ticket. `DEMO-241` (no QA ticket), `DEMO-244` (fix PR #433 still open)
  and `DEMO-201` (no PR at all) are each refused for a different reason. Sub-tickets: `DEMO-220-2` may close
  on its parent's QA ticket with no PR of its own; `DEMO-223-1` is refused on both counts.
- **The In Review gate** — `DEMO-222` (no PR) and `DEMO-226` (only a declined PR) are refused; sub-task
  `DEMO-220-2` rides on its parent's open PR #430, while `DEMO-225-1` is refused because its parent has none.
  Hold ⌥ while dropping to force any gate, then try Undo. Dropping `DEMO-220` on On Hold warns about its open PR.
- **The QA lane** — QA tickets recognised by type (`DEMO-245` Under QA, `DEMO-246` Ready for QA, `DEMO-247`),
  by label only (`DEMO-248`, a Task labelled `qa-ticket`, in Blocked) and by title only (`DEMO-249`, "[QA] …",
  On Hold). They move only to QA · QA In Progress · Blocked · On Hold · Next Sprint · Done, and a dev ticket
  dragged toward QA is refused. `DEMO-244` carries a `qa-failed` label and is still a dev bug.
- **QA tickets that are not assigned to me** — `DEMO-247` I raised, linked to my Blocked `DEMO-210`, so it shows
  in To Do (and under Raised by me); `DEMO-248` I raised too; `DEMO-249` is QA's own, shown because it is
  linked to my `DEMO-261`.
- **Jenkins builds** — every build state, on cards and in the drawer's Proof section: `DEMO-220` green QA with
  tests, a running UAT build, and in Stage a build pipeline next to a deploy pipeline (the failed deploy wins
  the chip); `DEMO-231` a red QA build with its failing tests and a collapsed **Console (last lines)** box — the
  scrubbed tail the fetch keeps for a failed build (`builds[].consoleTail`, an `Authorization: •••` line
  included); `DEMO-244` unstable, `DEMO-221` aborted, `DEMO-210` not built.
- **Checkmarx vulnerability fixes** — every status and every kind of target, on the card's shield chip, in the
  drawer's Proof section with what each scan returned (`DEMO-230`, `DEMO-232`, `DEMO-243`).
- **Dynatrace evidence** — the drawer's *Linked traces & problems* group (`Ticket.dynatrace`), every link status
  across three tickets: `DEMO-210` a trace with failed spans (the link shape Dynatrace produces: `#trace;gtf=…;traceId=…`)
  and a closed Davis problem, both read; `DEMO-247` a service with nothing found and a link to a tenant that is not in
  `DYNATRACE_TENANTS` (listed muted, never read, with the reason); `DEMO-213` a read trace, a log query that timed out
  (its earlier answer shown, marked stale, with the ticket's *unreachable* note above it) and a tenant whose token was
  rejected (the one red). Every host is an invented tenant (`abc12345`, `def67890`, `zzz99999`). The API keys
  window's *Last fetch* line for Dynatrace and its green health dot come from `proofSources.dynatrace` and
  `src/demo/health.ts`; `DEMO-210`'s canned PR report carries an **Issue insight** callout right after its decision.
- **AI briefs with evidence** — `DEMO-210` (Dynatrace), `DEMO-230` (Checkmarx) and `DEMO-231` (Jenkins console) end
  with an *Evidence from linked systems* section and a *What this means* line, stamped `<div data-brief="2">` with an
  `aiSummaryEvidence` fingerprint, as the AI worker writes them.
- **Every priority and type** — Critical / Blocker, Highest, High, Medium, Low / Minor, Lowest and an
  unprioritised ticket; Story, Task, Bug, Security, Requirement, Dev Task, QA Task, Incident, Spike,
  Improvement, Tech Debt, Epic, Sub-task, Documentation (the default glyph), and the title-derived Release
  (`DEMO-208`) and Onboarding (`DEMO-209`).
- **Hierarchy** — my tickets with my sub-tasks, sub-tasks owned by QA, a sub-task with its own child, a
  team-mate's ticket carrying my sub-task (`DEMO-223-1`, also stored as its own card, as real dumps do), an
  unassigned ticket, and an epic.
- **Card and drawer edges** — no story points, 21 points, no branch, several branches with no PR (only the
  newest shows), no description, a very long title, many labels, carried across three sprints, minutes old, a
  year old, a long unresolved comment thread, readiness dots green and amber, an estimate in days, AI briefs
  (deep, a sub-task's short one, and one the model wrapped as `{"html": …}` that the board unwraps), and every
  optional drawer section (acceptance criteria, proposed solution, effort, open questions, Confluence,
  external links, sources).
- **Search** — a bare number (`230`), a prefix (`23`), a PR number (`425`), a key with or without the hyphen
  (`demo230`), a parent number that pulls its sub-ticket (`223`), and free text across people, labels and
  repositories (`okafor qa-failed`, `demo-infra`).
- **Completed** — rows over three years with lead and dev times, releases to Prod, Stage and Demo, onboarding,
  declined-then-merged and all-declined PRs, Won't Fix, a team-mate's parent shown only as context
  (`DEMO-170`) with my sub-task archived as its own row (`DEMO-170-4`), and two projects.
- **Raised by me** — a row in every status bucket (To Do, Blocked, On Hold, In Progress, In Review, QA, Done,
  Won't Fix), unassigned, handed on three times, an AI brief, linked tickets and an epic, and rows from last year.
