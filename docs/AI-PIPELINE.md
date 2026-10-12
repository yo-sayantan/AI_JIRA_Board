# AI pipeline — how every AI feature works

AI is strictly **optional and layered on top** of a deterministic core: with the **AI** switch off
(Settings → Features) the board still fetches, renders, and produces base PR reports — nothing breaks,
nothing is sent to any model. This file explains the full pipeline when AI is on.

## The dial: Settings → AI usage

One dial, four steps — **Low · Medium · High · Max** (stored `low` / `moderate` / `high` / `full`). It sets
how long a pass may think (the worker timeout: ½ × · 1 × · 1.5 × · 2 × `timeouts.reportSec`), how hard a cloud
model works (effort: low · medium · high · high — there is no separate effort control; `ai-intern/worker.py::EFFORT_FOR_LEVEL`,
mirrored by `src/lib/settings.ts::effortForLevel`), and **which cloud models it may use**, by output price per 1M tokens:

| Level | Cloud models it can pick and run |
|---|---|
| **Low** | up to $1 |
| **Medium** | up to $5 |
| **High** | under $10 (never a costly model) |
| **Max** | every model, costly ones included (a costly model always runs at Medium effort) |

The rest of the list stays visible but greyed out. Lowering the level while a model outside it is selected switches
to the provider's preferred model that fits; the worker refuses a job whose model is outside its level
(`worker.level_allows`, mirrored by `src/lib/cloudModels.ts::levelAllows`). A model with no listed price runs only at Max.

**The AI switch** (Settings → Features → *AI*, `aiEnabled`) replaces the old "None" level. Off greys out the whole AI
section and turns every AI feature off: briefs are hidden, `server/reports.mjs` hands nothing to the intern (the base report
stands alone), `run-intern.sh` skips the summary pass, `ai_queue.enqueue` refuses every job type, the worker drains jobs
queued earlier without running them (`process_job`), model pulls and `POST /api/ai-jobs` answer 403, and the AI-Ollama
container is stopped (`ollama.mjs::ollamaOn`). Nothing is deleted: switch it back on and the level, backend and model are
as they were. An old saved level `none` reads as AI off.

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
   short brief" and carried no code state. It is also regenerated when the **evidence** changed (see
   "Evidence from linked systems" below): `aiSummaryEvidence` ≠ `evidence.fingerprint` of what the dump says now.
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
   dropped in front of any key that is not the ticket's Epic Link — a parent ticket is never an epic. A link in the
   brief to an address that is in none of the packs (or that is not http / https) is unwrapped, its text kept
   (`allowed_urls`: the ticket's links, sources, PRs, builds and Dynatrace links, plus whatever the packs contain).
   `brief.enforce_evidence` then makes the Evidence section trustworthy (below).
6. **Cap: 8 briefs per pass** — a full board fills in over a few scheduled passes.
7. `write_briefs` merges into the CURRENT data.json (not the stale start-of-job copy), only where
   `lastUpdate` still matches, stamping both the `tickets[]` and `raised[]` copies of a key.

Frontend: rendered via `SafeHtml` (sanitising), with `unwrapBrief` (`src/lib/format.ts`) as a
second healing layer so even a bad stored brief never displays as raw JSON. Hidden entirely when
Settings → AI briefs is off. The daily fetch and the raised fetch both **carry briefs forward**
so a refresh never wipes them (`carry_ai_fields`, `fetch_raised`'s prior-map).

### Evidence from linked systems (briefs) and the Issue insight (reports)

What the outside systems say about a ticket is built **once**, deterministically, by `jira-intern/evidence.py` from data
already in `data.json` (no network, no clock): `evidence.build(ticket, tz)` →
`{ headline, insight, sections[] }`. A section per source that has something to say — **Dynatrace** (the links the fetch read:
status `read` only), **Checkmarx** (a vulnerability-fix ticket's `vulnFixes`), **Jenkins** (any ticket with a failed or
unstable build, and the green builds of a ticket *about* a failing build / pipeline) — each with `severity`
(`info` · `warning` · `problem`), one plain `summary` sentence, short `lines`, and for Jenkins an `excerpt` (the last
≤ 15 lines / 1,200 characters of the scrubbed console of the latest failed build). The `insight` is **templated** (2–4
sentences, "A timeout in payments caused 3 failed requests between 13:45 and 14:00 IST on 2026-02-26 …", times in the
configured zone), so it exists with the AI off. A ticket with no evidence has `sections == []`: no section, no callout,
nothing changes. The brief, the PR report and the worker's Proof table all read this one builder, so they cannot disagree
about the facts.

- **In the brief.** After the usual bullets the brief ends with ONE separate final section —
  `<p><b>Evidence from linked systems</b></p><ul><li><b>Dynatrace|Checkmarx|Jenkins:</b> …</li></ul><p><i>What this means: …</i></p>`,
  one `<li>` per source present, about 120 words at most. The prompt (`brief.system_prompt(has_evidence=True)`) says: only what
  EVIDENCE contains, no new number / id / service / cause / time, no advice, and keep the evidence out of the other bullets.
- **Untrusted by construction.** Dynatrace messages and console lines are other systems' text, so the evidence never enters
  the trusted FACTS: `brief.split_evidence` moves it out (FACTS keep only `evidenceSources`, the list of source names) and
  `worker.untrusted_packs` puts it in an `EVIDENCE` block **inside** `<untrusted_data source="jira,bitbucket,confluence,dynatrace,checkmarx,jenkins">`
  (≤ 7 KB) — facts to quote, never instructions. It was scrubbed when stored (`_scrub.py`), is scrubbed again as `evidence.build` assembles
  it, is cut by size here, and a `</untrusted_data>` inside any pack is defanged (`worker._defang`) so third-party text cannot close the block.
- **The AI may not add facts.** After generation `brief.enforce_evidence` checks what the model wrote: with evidence, a
  *missing* section is appended from the evidence; a section that contains a number or an identifier (anything with a digit
  in it: `P-23101234`, `#412`, `13:45`) the evidence does not contain, **or more than a few words (five letters or more) it does
  not**, or a link, is *replaced* by the deterministic section (`evidence_html`: the sections' summaries and a fixed "What this
  means" line); a grounded one is kept. (Numbers alone would let prose through — "approve it, ignore the failures" has none —
  so the vocabulary is checked too: a faithful rewording passes, new claims do not.) Before that, `brief.scrub(allowed_urls=…)`
  cuts the model's HTML down to p / b / i / em / strong / ul / ol / li / code / pre / br / a (no attribute but `href`, and
  only to an address that is in the packs) with bounded patterns — hostile output cannot make the check slow. Without evidence, any
  "Evidence from linked systems" section the model wrote is *removed*.
- **Regenerated when the evidence changes.** Dynatrace, Checkmarx and Jenkins never bump Jira's `updated`, so the worker
  stores `aiSummaryEvidence` = `evidence.fingerprint` (16 hex over each section's source, severity, summary, lines and
  excerpt) with the brief and `needs_brief(ticket, fp)` compares it with the fingerprint of the evidence *now*: new,
  changed or vanished evidence regenerates the brief, a re-read that says the same thing — or only a newer read time —
  does not. The fingerprint is computed without a time zone, so changing the display zone regenerates nothing. A ticket
  with no evidence and a brief without the field compares `"" == ""`: no existing brief is invalidated by this feature.

## Feature 2 — PR Readiness Report enrichment (`enrich-report`)

1. `pr_report.py` writes a **deterministic base report** in seconds — approvals, open comments,
   merge state, QA sub-task, fixVersion, release-branch checks → verdict + gate checklist. This
   exists at every AI level, including None.
2. Unless level is None, an `enrich-report` job is enqueued. The worker adds the AI-only blocks:
   per-file change assessment (Required/Neutral/Risky), review focus, risks, business impact,
   ticket-specific release gate — each block tagged with provenance `ai` so the UI renders it
   distinctly from `derived` facts.
3. Staleness is a **PR fingerprint** (ids/states/approvals hash, plus each Jenkins build's env, branch,
   number and result when the ticket has builds): a report regenerates only when the underlying PRs —
   or a newer build — actually changed, and `--if-needed` runs (auto after a ticket refresh) are
   cheap no-ops otherwise. A ticket without builds keeps the fingerprint it had before builds existed.
   Checkmarx results join the same way: the scan dates and each target's (target, kind, status) are in the
   fingerprint only when the ticket has `vulnFixes`. Dynatrace findings and a failed build's console excerpt join the same
   way (below), again only when present.

**The "CI green" gate — source order.** (1) **Jenkins builds** already in `data.json`
(`Ticket.builds`, from `jenkins.py`): `pr_report.jenkins_ci` judges the builds of the open PRs' source
branches (else the primary branch's, else all): **Pass** when the latest build of every environment that
built the branch is `SUCCESS`, **Fail** on any `FAILURE` / `UNSTABLE` (evidence names the failed stage),
**In progress** while one is `BUILDING`, **Not verified** otherwise (aborted, not built, or a `stale` build — one
the fetch carried forward because Jenkins could not be re-read; the evidence gives its age, and a stale build
can never make the gate Pass, though a fresh failure still fails it). This is in the
deterministic base report — AI level None included — with one evidence row per build ("Jenkins · qa ·
#412 SUCCESS · 2h ago · 312 tests, 0 failed", plus the failed stage, failing tests and a link). The worker's
proof step calls the same function, so base and enrichment never disagree. (2) **Bitbucket build status**
on the PR's latest commit (`worker.bitbucket_ci`) — only when the ticket has no builds, and only during
enrichment. The gate never blocks closure and never moves the verdict or score.

**The "Security scan (Checkmarx) clean" gate — source.** `Ticket.vulnFixes` (from `checkmarx.py` in the daily
fetch), judged by `pr_report.vuln_gate` in the deterministic base report — AI level None included: only the
targets the ticket names count (the generic "N critical / N high still open" summary is gone). **Pass** when every
target is fixed, **Fail** when any is still open on the branch (evidence names them), **Not verified** otherwise —
with the reason: nothing named, Checkmarx not read yet, N not found in either scan, N unknown, or the result's note
(no project, branch not scanned yet). A ticket that is not a vulnerability fix has nothing to scan: **Not required**
(grey, left out of the "gates passed" count — see `pr_report.NOT_REQUIRED`). One evidence row per target ("Checkmarx · CVE ·
`CVE-2021-44228` · CRITICAL · `log4j-core 2.14.1` → Fixed — gone on feature/x (scan …) · was CRITICAL on develop
(scan …)"). The worker's "Proof · vulnerability fix" table lists the same targets (`pr_report.vuln_proof_rows`) and
sets the gate with the same function, so the enriched row equals the base row. Only when the dump has no results for
a vulnerability ticket does the worker look Checkmarx up live — with the same `checkmarx.py` — and fill the gate from
that. It calls `checkmarx.isolated_lookup`, which takes `checkmarx.RUN_LOCK`, resets the module's per-run state (token,
call budget, "down" flag, caches) and does one `vuln_fixes_for` — so two concurrent worker jobs never reset or reuse
each other's token or budget mid-lookup (the daily fetch calls `reset_run` once per run instead). The gate never blocks closure and never moves the verdict or score.

**The "Issue insight" callout — what the issue was.** When `evidence.build` has sections (Dynatrace links read, a Checkmarx
scan, a failed Jenkins build), the deterministic base report gets an **Issue insight** callout right after the Decision in
the Verdict tab (`provenance: derived`, tone warning when any source shows a problem, else info; shown in the PDF under
"Is it ready to close?" too) — the plain-words answer for whoever will not open Dynatrace, Checkmarx or Jenkins. It is
templated, so it exists at every AI level, None included. The same evidence adds **evidence-chain rows**: one per read
Dynatrace link ("Dynatrace · trace (prod)" — the first finding, the window, the next findings; "not re-read since …" when
stale) and, for a failed build with a console excerpt, one with the deciding lines of the console (the last error-looking
lines, or the last lines; labelled scrubbed). Dynatrace links also join the Sources → Links. The base's "CI, Checkmarx or
Dynatrace is added … when the report is enriched" warning stops naming Dynatrace once its links were read (and disappears when every
system answered), and the source line says "Dynatrace (last fetch)".
The fingerprint includes the read Dynatrace items (url, status, stale, a hash of the findings) and the console tails
(env, build number, a hash) **only when present** — a ticket without them keeps the fingerprint it had before — and not
the read time, so an unchanged re-read does not make the report stale.
During enrichment the model may **reword** the insight (`enrich.txt` → `issueInsight`, 2–4 plain sentences for management;
the agent fallback has the same rule, `pr-readiness-prompt.md` 5b) but `worker.merge_enrichment` applies it only if
`evidence.grounded` holds — ≤ 700 characters, no number or identifier beyond the evidence's and almost no new vocabulary — and then
marks the block "Reworded by the AI intern from the same evidence — checked: no new numbers, ids or unexplained words."; otherwise the template stays. `pr_report.preserved_errors`
lets the body of the Issue insight (like the Decision's) change but never its kind, tone or title. The evidence also travels
in the enrichment's untrusted block (`<untrusted_data … dynatrace,checkmarx,jenkins>`).

**The worker's Proof table and Dynatrace.** `worker.collect_class_proof` leads with the rows for the Dynatrace links the fetch
already read (`evidence.proof_rows`: check "Dynatrace trace (prod)", result "3 failed spans" / "Problem" / "Read", the first findings as detail; source "Dynatrace (linked)", table title
"Proof · linked traces" when no other class applies) and then does **not** run its own text-search query, which has no link
to go on; that older probe (`dynatrace_proof`: one `matchesPhrase` query for an error code or service id found in the text of
an observability / incident ticket, only at a listed tenant) remains for tickets with no Dynatrace link.
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
| `ai-intern/prompts/enrich.txt` | `enrich-report` jobs (the worker's JSON-out prompt) | The JSON keys the model returns (`verdictSummary`, `businessImpact`, `issueInsight`, `reviewFocus`, `risks`, `files`, …) and the untrusted-data rule; `issueInsight` is empty without EVIDENCE. |

The **primary** fetch path is always the deterministic Python; the agent prompts are the fallback
when scripts fail (auth drift, Jira quirks). Keep prompts in sync with `src/types.ts` — the
contract comment at the top of that file says so for a reason.

## Safety rails worth knowing

- The worker refuses to merge briefs while a data writer holds a lock, and drops a brief whose
  ticket moved on mid-inference (lastUpdate mismatch) rather than overwriting fresh data.
- Inference failures skip the ticket with a log line — never block the pass, never write junk.
- Text from Dynatrace and Jenkins consoles is untrusted: scrubbed before it is stored (`_scrub.py`), only ever inside `<untrusted_data>`, and
  the model's evidence section / insight is checked against the evidence (`enforce_evidence`, `evidence.grounded`) before it is kept.
- `SKIP_SUMMARY=1` in the fetch container: no model runs inside JIRA-Board itself; everything
  AI lives in AI-Intern.
- Cloud keys are read from `setup/.env` (the board's API keys dialog) at job time and never logged or persisted elsewhere.
