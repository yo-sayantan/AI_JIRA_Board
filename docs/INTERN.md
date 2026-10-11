# The intern — `jira-intern/` from the inside

The "intern" is the headless data pipeline: on every run it fetches your Jira work and **dumps
it as structured data** (`data.json` + `data.js`) for the board to render. It never writes UI.
This page is the folder-level tour; the mechanics live in [`DATA-FLOW.md`](DATA-FLOW.md),
[`RUNTIME.md`](RUNTIME.md) and [`INTEGRATIONS.md`](INTEGRATIONS.md).

## What it writes (all under `jira-intern/`)

| File | Role |
|---|---|
| `data.json` | The canonical dump — shape = `src/types.ts::JiraData` (tickets, completed, raised, notes). |
| `data.js` | `window.__JIRA_DATA__ = <that json>;` so the board loads from `file://` with no server. Always written together with `data.json`. |
| `.state.json` | Hidden memory for the unchanged-ticket fast path. You never open it; corrupt = "treat all as changed". |
| `cache/<KEY>.json` | Rich per-ticket rows the Completed archive assembles from. |
| `reports/<KEY>.json` | PR Readiness Reports (+ `reports/index.js` for `file://`). |
| `logs/`, `_STATUS.md` | Per-run logs and the newest-first audit trail. |

## The scripts

| Script | Role |
|---|---|
| `daily_fetch.py` | **Primary.** Active tickets assigned to you (+ sub-tasks, code state, sprint) → `tickets[]`; the raised-by-me list rides along. `--key K` refreshes one ticket in place; `--raised` refreshes only `raised[]`. |
| `completed_archive.py` | The full historical archive → `completed[]` (full or scoped to year / since / key); refreshes `raised[]` too. |
| `raised.py` | Every non-sub-task ticket you **reported**: parallel-paged JQL, assignee hand-off log from the changelog, issue links. Shared by the daily fetch, the archive and the Raised view's own refresh. |
| `_jira.py` | Shared Jira/Bitbucket HTTP (token auth, retries), field formatting, status→column mapping, changelog helpers, comment pagination. |
| `devinfo.py` | Branches / PRs / reviewers via Jira's dev-status index, batched and parallel. |
| `jenkins.py` | Latest Jenkins multibranch build of each of a ticket's branches, per environment (config → `jenkins.jobs`): result, tests, failed stage, deploy target → `Ticket.builds`. Called by `daily_fetch.apply_builds`; a failed lookup carries the prior builds forward. |
| `checkmarx.py` | Checkmarx One for vulnerability-fix tickets: classifies the ticket, extracts what it names (CVE, SAST query / CWE, result id, package version), compares the latest completed scan of the PR branch with the base branch's → `Ticket.vulnFixes` (fixed / open / not-found / unknown per target). Called by `daily_fetch.apply_vuln_fixes`; a failed lookup carries the prior results forward. Also the AI worker's only Checkmarx client. |
| `pr_report.py` | Deterministic PR Readiness Report base + fingerprint staleness. |
| `datafile.py` | The ONLY writer of `data.json`/`data.js` (atomic temp-file + rename, both files together). |
| `progress.py` | `.progress.json` for the header buttons' live fill. |
| `ai_queue.py` | File queue (`.ai-queue/`) feeding the AI-Intern container (briefs, report enrichment, model pulls). |
| `_config.py` · `_sprint.py` | Config/identity resolution (project defaults + `~/.ai/config.json`); sprint parsing. |
| `config.json` | Intern-local config (repo hints, excluded projects, limits). Non-secret. |
| `prompts/*.md` | **Runtime inputs, not documentation**: the prompts the LLM-agent fallback and the AI worker consume. `intern-prompt.md` restates the data contract — keep it in sync with `src/types.ts`. |

## The runners (`local-runner/`)

Thin shell wrappers the server (and cron / Shortcuts / your terminal) invoke. All source
`runner-env.sh` for PATH, secrets, locks and timeouts.

| Runner | Does |
|---|---|
| `run-intern.sh` | Daily fetch. Python fast path first; LLM-agent fallback (`cursor-agent` by default) only if it fails. Holds `.intern.lock`. |
| `update-completed.sh` | Archive rebuild (scope via `ARCHIVE_SCOPE` / `ARCHIVE_YEAR` / `ARCHIVE_SINCE` / `ARCHIVE_KEY`). Holds `.completed.lock`. |
| `transition.py <KEY> <column>` | The only Jira **write**: checks PR / QA gates on live Jira, picks a workflow transition into the target column, POSTs it. Prints one JSON verdict line. Uses the REST PAT directly, not MCP. |
| `refresh-ticket.sh <KEY>` | Single-ticket refresh (Bitbucket skipped; dev-status only). Holds `.refresh.lock`. Auto-triggers a PR report `--if-needed`. |
| `refresh-raised.sh` | Raised-by-me hard refresh, deterministic only. Holds `.raised.lock`. |
| `pr-report.sh <KEY>` · `pr-reports-backfill.sh` | Base report(s), then enqueue AI enrichment unless the AI level is None. |
| `config.mjs` | Deep-merges project config + personal override + saved Settings → `shellenv` vars, prompt rendering, MCP policy. |
| `sync-datajs.mjs` · `sync-reports.mjs` | Regenerate `data.js` / `reports/index.js` from the JSON (safety nets for the agent path). |

Every runner **refuses to start** (exit 3) while another writer holds its lock, writes its own
`<pid> <timestamp>` lock, and clears dead-PID locks it finds.

## How it behaves

- **Columns:** the intern maps raw Jira statuses onto `todo · prog · rev · qa · done · hold`
  (`_jira.py::status_column`, exact aliases then whole-word fallback); the app trusts it.
- **Fast path:** a ticket whose `(status, updated)` matches `.state.json` is deep-copied from the
  previous dump — but sprint and PR state are ALWAYS re-applied, because both change without
  touching Jira's `updated`.
- **Done window:** the daily search keeps Done tickets for 10 days (the board shows them 3) so
  nothing can leave `tickets[]` before the archive has captured it.
- **Preserve, never wipe:** each job rewrites only its own slice and carries everything else
  forward; failed lookups keep prior data and leave a dated note (`notes[]`, `_STATUS.md`).
- **Never invents data:** with no Jira token, the previous dump is re-stamped with a
  "Jira unavailable — showing last known state" note and the run stops.
- **Excluded projects:** `config.json → excludeProjects` keys never reach any list.

## Branch convention

`<type>/<KEY>_<short_description>` — `feature` for stories/tasks, `bugfix` for bugs. Real branch
names always come from Bitbucket/dev-status, never predicted.

## Notes

- Requires the corporate network / VPN for on-prem Jira.
- The LLM-agent fallback (`cursor-agent -p`) can hang; runners kill it at the configured timeout
  (`timeouts.dailySec` etc.). Docker images have no agent CLI — the Python path must succeed
  there.
