# Demo tickets

The sample board behind **Settings → Features → Demo mode**. Everything here is invented: no
ticket, person, URL or pull request is real, and nothing in this folder is ever sent to Jira,
Bitbucket or the AI intern. Your real dump (`../data.json`) is never read or written while Demo
mode is on.

| File | What it is |
|---|---|
| `data.json` | **The source of truth.** The whole sample dump, same shape as the real `jira-intern/data.json` (`src/types.ts::JiraData`). The board loads this. |
| `tickets/<KEY>.json` | One file per ticket — the easy way to read them by hand. Generated from `data.json`. |
| `tickets/completed-<KEY>.json` | One file per Completed-archive row. |
| `tickets/raised-<KEY>.json` | One file per Raised-by-me row. |
| `build.mjs` | Regenerates `tickets/` from `data.json`. |

## Editing

Edit `data.json`, then:

```bash
npm run demo:split      # refresh tickets/ to match
```

With the board **served** (`npm run serve`, or Docker), Demo mode fetches this `data.json`, so a
reload shows your edits — no rebuild needed. Opened from `file://`, the board falls back to the
copy compiled into `dist/index.html`, which is refreshed by `npm run build`.

## Dates stay fresh

Timestamps are stored as real dates anchored to `_demoNow`. On load the board shifts every date by
the difference between that anchor and the current time, so the sample board always looks as if it
were fetched minutes ago — a Done card still says "archives in 1d", the active sprint is still
active, and Next Sprint has still not started. Keep `_demoNow` as it is unless you want to rebase
the whole set.

## What the set covers

- **Every column** — To Do, Blocked, In Progress, In Review, QA (both the ready shelf and *QA In
  Progress*), Done, plus On Hold and Next Sprint (`DEMO-270` / `DEMO-272` in a dated sprint, `DEMO-271` in an undated READY bucket, so both captions show). Drag a Blocked or To Do card onto Next Sprint, then back to To Do; an In Progress card is refused.
- **Every pull-request state** — merged, approved, changes requested, unresolved comments,
  declined, none; one approval short of the requirement; approved while comments are still open;
  every attempt declined; several PRs across repositories; merged while the ticket is still
  blocked; closed in Jira with the code never merged.
- **The Done gate** — `DEMO-242` and `DEMO-240` pass (PR merged, QA ticket raised — finished or not).
  `DEMO-241` (no QA ticket), `DEMO-244` (fix PR #433 still open) and `DEMO-201` (no PR at all) are
  each refused for a different reason.
- **The In Review gate** — `DEMO-222` (no PR) is refused; sub-task `DEMO-220-2` rides on its parent's
  open PR #430. Hold ⌥ while dropping to force any gate, then try Undo.
- **The QA lane** — `DEMO-246` (Ready for QA) and `DEMO-245` (Under QA) are QA tickets; `DEMO-247` is a
  QA ticket in To Do. Drag them: they move only to QA · QA In Progress · Blocked · On Hold · Done, and a
  dev ticket dragged toward QA is refused. `DEMO-244` carries a `qa-failed` label and is still a dev bug.
- **Hierarchy** — my tickets with my sub-tasks, sub-tasks owned by QA, a sub-task with its own
  child, a team-mate's ticket carrying my sub-task, an unassigned ticket, and an epic.
- **Jenkins builds** — every build state, on cards and in the drawer's Proof section: `DEMO-220` green QA with
  tests plus UAT still building (two environments); `DEMO-231` a failed pipeline with its failed stage and
  failing tests (UAT still green from before); `DEMO-244` unstable at the quality gate; `DEMO-221` aborted;
  `DEMO-210` not built; `DEMO-242` green in both environments, UAT deployed to `uat-eu` (a build parameter).
- **Checkmarx vulnerability fixes** — every status and every kind of target, on the card's shield chip, in the
  drawer's Proof section and in the report's security gate: `DEMO-230` 2/3 fixed — a CVE and its package
  (`jsonwebtoken@8.5.1`) gone, `Path_Traversal` still open (red); `DEMO-243` 2/3 fixed — a Checkmarx result link and
  `CWE-639` fixed, a CVE found in neither scan (amber); `DEMO-232` 0/1 — the branch is not scanned yet (amber, with a
  note). Each ticket's description names exactly the targets its `vulnFixes` lists (a Python test checks that
  `checkmarx.extract_targets` finds them).
- **Card edges** — no story points, 21 points, no branch, several branches, no description, a very
  long title, many labels, carried across three sprints, minutes old, a year old, archiving
  tomorrow, and a long unresolved comment thread.
