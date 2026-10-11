# AI pipeline — how every AI feature works

AI is strictly **optional and layered on top** of a deterministic core: with AI level `None` the
board still fetches, renders, and produces base PR reports — nothing breaks, nothing is sent to
any model. This file explains the full pipeline when AI is on.

## The dial: Settings → AI usage

| Level | Meaning |
|---|---|
| **None** | Deterministic only. No briefs, no report enrichment, no model calls at all. |
| **Low / Moderate / Max** | Same features, increasing inference timeout/depth (`full` is the stored value for Max). |

Backend choice is independent of level:

- **Local** — Ollama. Either the `AI-Ollama` container (CPU) or, with the **Host Ollama**
  checkbox, Ollama.app on the host via `host.docker.internal:11434` (Apple-Silicon Metal; use for
  14B+ models). Ticket text never leaves the machine.
- **Cloud** — Cursor, Anthropic (Claude), or Gemini, with per-provider model dropdowns and (Cursor
  an effort setting (Low · Medium · High · Auto). The models, their efforts and the costly line (output ≥ $10 per 1M by default) are all `ai-intern/cloud-models.json`; a model with no effort parameter of its own gets the effort as prompt guidance. Uses YOUR API keys from `setup/.env` (added with the key button in the board header; re-read on every call); the summarised
  ticket text goes to that provider under its terms.

Settings relevant to jobs mirror to `jira-intern/.settings.json` (`server/settings.mjs`), which
`local-runner/config.mjs shellenv` and the worker both read — so a cron/terminal run honours the
same level/backend/model as the button.

## The components

```
 board (server/serve.mjs) ── enqueue ──▶ jira-intern/.ai-queue/*.json ──▶ ai-intern/worker.py
      ▲                                                             │  infer() → Ollama │ Claude │ Cursor │ Gemini
      └────────── /api/ai-status · /api/ai-models · /api/ai-jobs ◀──┘  writes briefs / enriched reports back
```

- **`ai-intern/worker.py`** — the only process that talks to models. File-queue consumer + small
  HTTP server (`/health`, `/api/models`, `/api/cloud-models`, `/api/jobs`, pull progress).
  Job types: `enrich-report`, `summarize-active`, `pull-model`. Report jobs run several in
  parallel (Settings → parallelism); summarize and pulls are exclusive.
- **`ai-intern/models.json`** — the local-model catalog (Ollama tag, RAM, GGUF download links,
  container-vs-host fit). The Settings dropdown, the help guide's tables (`help/06-ai-local-models.html`), and pull commands all
  derive from this one file; add a model by adding a row.
- **`server/ai.mjs`** — proxies the board's `/api/ai-*` to the worker with a 1-second status cache.

## Feature 1 — AI briefs (`summarize-active`)

Purpose: the paragraph at the top of a ticket drawer (and in Raised row peeks) answering
"what is this and where does it stand".

Lifecycle:
1. A `summarize-active` job runs (scheduled, or enqueued via `POST /api/ai-jobs`).
2. The worker waits out any data-writer lock, reads `data.json`, and walks **`tickets[]` first,
   then `raised[]`** (a key in both is briefed once, from the richer board copy).
3. A ticket needs a brief (`brief.needs_brief`) when it has none, it still *looks like a wrapped
   JSON object*, `aiSummaryAt < lastUpdate`, or it was written by an older generation: current briefs
   are wrapped in `<div data-brief="N">` (the sanitiser drops the attribute at render time), and
   anything without the current N is regenerated once — the first-generation prompt asked for "a
   short brief" and carried no code state.
4. Context, all read-only: **FACTS** (`brief.build_facts` — stage, sprint, parent *as a parent*, the
   real Epic Link only, sub-task roll-up, branches and PRs with approvals/comments, "no PR" stated as
   a fact), `local_disk_pack`, and `live_mcp_pack` — live Jira (description, recent comments,
   sub-tasks, linked issues, fix versions, the epic's title) and, per PR, Bitbucket's own record
   (title, state, reviewers, newest commits, last review comments) plus changed files.
   The system prompt is **stage-aware** (`brief.STAGE`): To Do → the ask, acceptance, dependencies;
   In Progress → built so far, remaining, blockers; In Review → PR state, approvals vs required, where
   to look; QA → what to verify, merge state; Blocked/On hold → why and what unblocks. A new ticket
   with little data stays 60–110 words; a WIP / review / QA ticket with code runs 150–300.
5. Output is cleaned by `_clean_brief` (fences, `{"html": …}` wrappers, plain text → `<p>`) and then
   checked by `brief.scrub`: a ticket key in none of the packs is removed with its link, and "epic" is
   dropped in front of any key that is not the ticket's Epic Link — a parent ticket is never an epic.
6. **Cap: 8 briefs per pass** — a full board fills in over a few scheduled passes.
7. `write_briefs` merges into the CURRENT data.json (not the stale start-of-job copy), only where
   `lastUpdate` still matches, stamping both the `tickets[]` and `raised[]` copies of a key.

Frontend: rendered via `SafeHtml` (sanitising), with `unwrapBrief` (`src/lib/format.ts`) as a
second healing layer so even a bad stored brief never displays as raw JSON. Hidden entirely when
Settings → AI briefs is off. The daily fetch and the raised fetch both **carry briefs forward**
so a refresh never wipes them (`carry_ai_fields`, `fetch_raised`'s prior-map).

## Feature 2 — PR Readiness Report enrichment (`enrich-report`)

1. `pr_report.py` writes a **deterministic base report** in seconds — approvals, open comments,
   merge state, QA sub-task, fixVersion, release-branch checks → verdict + gate checklist. This
   exists at every AI level, including None.
2. Unless level is None, an `enrich-report` job is enqueued. The worker adds the AI-only blocks:
   per-file change assessment (Required/Neutral/Risky), review focus, risks, business impact,
   ticket-specific release gate — each block tagged with provenance `ai` so the UI renders it
   distinctly from `derived` facts.
3. Staleness is a **PR fingerprint** (ids/states/approvals hash): a report regenerates only when
   the underlying PRs actually changed, and `--if-needed` runs (auto after a ticket refresh) are
   cheap no-ops otherwise.
4. Bulk runs queue through one pump (`server/reports.mjs` + `pr-reports-backfill.sh`) with
   scope all/year/since/keys; `.status.json` records in-flight PIDs so even a cron-launched run
   shows a spinner in the drawer.

**Why a report was not generated.** `pr_report.py base` exits `3` (ticket not in `data.json`), `4`
(no pull request linked in Jira) or `1` (internal consistency failure); the server's report queue
keeps each key's exit code and `GET /api/reports` returns it as `exits`. The board turns it into a
sentence (`src/lib/reportFailure.ts`) — e.g. "Jira shows no pull request for it … link a PR, refresh
the ticket, then try again" — and groups a bulk run's failures into one toast.


## Feature 3 — model management (`pull-model`)

Settings' download icon enqueues a pull; the worker streams Ollama's progress (bytes/percent)
into `/api/ai-status`, which the status poller surfaces at a 1s cadence (the only time the UI
polls that fast). Host-vs-container choice decides where the weights land (`~/.ollama/models` vs
the `jira-ai-models` volume). GGUF files you downloaded by hand become visible only after
`ollama create <tag>` with the catalog's exact tag — the guide documents both paths.

## Prompts

| Prompt file | Consumed by | Purpose |
|---|---|---|
| `jira-intern/prompts/intern-prompt.md` | LLM-agent **fallback** for the daily fetch (`run-intern.sh` when the Python fast path fails) | Restates the whole data contract in prose; preservation rules for `completed[]`/`raised[]`. |
| `jira-intern/prompts/intern-completed-prompt.md` | agent fallback for the archive | Same, for history. |
| `jira-intern/prompts/pr-readiness-prompt.md` | `enrich-report` jobs | Evidence-chain rules, block vocabulary, release-gate logic — mirrors `src/lib/reportTypes.ts`. |

The **primary** fetch path is always the deterministic Python; the agent prompts are the fallback
when scripts fail (auth drift, Jira quirks). Keep prompts in sync with `src/types.ts` — the
contract comment at the top of that file says so for a reason.

## Safety rails worth knowing

- The worker refuses to merge briefs while a data writer holds a lock, and drops a brief whose
  ticket moved on mid-inference (lastUpdate mismatch) rather than overwriting fresh data.
- Inference failures skip the ticket with a log line — never block the pass, never write junk.
- `SKIP_SUMMARY=1` in the fetch container: no model runs inside JIRA-Board itself; everything
  AI lives in AI-Intern.
- Cloud keys are read from `setup/.env` (the board's API keys dialog) at job time and never logged or persisted elsewhere.
