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
- **Card edges** — no story points, 21 points, no branch, several branches, no description, a very
  long title, many labels, carried across three sprints, minutes old, a year old, archiving
  tomorrow, and a long unresolved comment thread.
