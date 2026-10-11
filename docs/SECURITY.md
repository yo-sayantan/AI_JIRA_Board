# Security & privacy

A personal tool that holds a copy of your company's Jira tickets and talks to Jira with your
personal token deserves a clear statement of what it does with both. This page is that statement,
written against the current code; file paths are given so you can check.

## Threat model

**In scope — what the design defends against**

- A web page you visit trying to reach the board's API (DNS rebinding, cross-site POSTs).
- Your tokens leaking into the repository, the image, logs, or another process's environment.
- Ticket content leaving your machine without you choosing a cloud AI backend.
- Hostile text inside a ticket or PR steering the AI enrichment (prompt injection).
- A crashed or killed job corrupting `data.json` or wedging the pipeline with a stale lock.
- Unverified TLS to your Jira/Bitbucket (the token travels as a bearer header).

**Out of scope**

- Another user on the same machine: there is no authentication on either HTTP surface. The board
  trusts anyone who can reach `127.0.0.1:4321` (or the LAN hosts you opt into).
- The security of your Jira / Bitbucket / Confluence servers or of the cloud AI providers.
- Someone with read access to your checkout (they have `setup/.env` anyway).

## What is stored where

| Data | Where | Leaves the machine? |
|---|---|---|
| Your tokens | `setup/.env` only — written by the board's API keys dialog (`server/secrets.mjs`, mode 0600). Git-ignored (`.env`), docker-ignored (`**/.env`, `**/.env.*`, `**/*.env`), never served. `./setup` is mounted as a **directory** — read-write into JIRA-Board, read-only into AI-Intern. | Only to the service each token belongs to. |
| Your identity and company URLs | `~/.ai/config.json` (or `$AI_CONFIG_FILE`), outside the repo. The tracked `config/jira-board.config.json` holds placeholders. | Never. |
| Ticket content, comments, PR metadata | `jira-intern/data.json` / `data.js`, `cache/`, `.state.json`, `_STATUS.md`, `logs/` — all git-ignored and excluded from the Docker build context except the baked seed copy of `data.*` (see below). | Only if you choose **Cloud AI** (next section). |
| PR Readiness Reports | `jira-intern/reports/*.json` + `reports/index.js` — git-ignored, not in the image. | Same. |
| Settings (jobs, AI) | `jira-intern/.settings.json` — git-ignored. | Never. |
| Appearance, notifications, feature switches, manual archive choices, checklist ticks | the browser's `localStorage` (below). | Never. |
| Model weights | Docker volume `jira-board_jira-ai-models`, host `~/.ollama`, or `jira-intern/models/`. | Downloaded from Ollama / Hugging Face. |

> **The image contains a seed copy of `jira-intern/`**, including whatever `data.json`/`data.js`
> existed at build time (the entrypoint restores it only into an *empty* mounted volume). If you
> ever push the image to a registry, build it from a tree with no real `data.*` first.

### Browser `localStorage` keys

| Key | Holds |
|---|---|
| `jb-settings` | The whole Settings object (theme policy, cadences, AI choices, feature switches, toast limits). |
| `jb-archived` | Ticket keys you moved to Completed by hand (pruned to keys still in the dump). |
| `jb-completed-show-context` | The Completed dialog's *Mine only / Show context* choice. |
| `jb-ac:<TICKET-KEY>` | Ticked acceptance-criteria items for that ticket. |
| `jb-theme`, `jb-hidden` | Legacy keys from older builds; migrated into `jb-settings` / `jb-archived` and removed. |
| `jb-guide-os` | The OS tab chosen in the help guide (`help/02-install-the-tools.html`). |

No cookies. No analytics or telemetry. No external fonts, scripts or images — the bundle is one
self-contained file and the guide uses system fonts.

## Secrets read

The secrets file (`setup/.env`) is **parsed, never sourced**: `KEY=value`, optional `export `, one layer of
quotes, `#` comments; `$VAR`, `$(…)` and backticks are literal (`jira-intern/_config.py
load_secrets`, `runner-env.sh export_secrets_from_file`, `server/secrets.mjs parseEnv`,
`ai-intern/worker.py load_secrets`; the IDE wrapper `setup/mcp-with-secrets.sh.template` parses its own
file the same way). These are the only names ever read:

| Name | Read by | Purpose |
|---|---|---|
| `JIRA_PERSONAL_TOKEN` | fetch scripts, AI worker | Jira REST (required). |
| `CONFLUENCE_PERSONAL_TOKEN` | fetch scripts, MCP wrapper | Confluence excerpts (optional). |
| `BITBUCKET_PAT` / `ATLASSIAN_TOKEN` | fetch scripts, AI worker | Bitbucket REST: PR comments, changed files, build status (optional). |
| `JIRA_URL` / `CONFLUENCE_URL` / `BITBUCKET_URL` | fetch scripts, AI worker | Endpoint overrides. |
| `JIRA_CA_BUNDLE` / `JIRA_INSECURE_TLS` | fetch scripts, AI worker | TLS posture (below). |
| `CURSOR_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` | AI worker (`file_secret`, re-read per call, never exported) | Cloud AI providers. |
| `OPENAI_API_KEY` | shell runners (`connector.codex.apiKeyEnv`) | Only for the optional Codex agent fallback. |
| `CHECKMARX_API_KEY` | AI worker | Optional security-scan proof rows. |
| `DYNATRACE_PAT` | AI worker | Optional production-proof rows. |

Process boundaries: the Docker entrypoint **does not export** the secrets file into the Node
server's environment (the server reads it only to mask values for the dialog) — the Python scripts load the file themselves, and `runner-env.sh` exports
only the allow-list above to its children. The worker exports only the Jira/Bitbucket/Confluence
values its imported modules read; cloud keys never enter `os.environ`. Nothing logs a token; the
entrypoint only greps for the *presence* of `JIRA_PERSONAL_TOKEN=`.

## The API keys dialog

The board's key button writes `setup/.env` through `GET`/`POST /api/keys` (`server/secrets.mjs`):

- **No full value ever leaves the server.** `GET /api/keys` returns `{ set, masked }` per key: first 4
  + `••••••••` + last 4 for 16+ characters, all bullets below that — the length is never revealed.
  Only the base-URL fields (`secret: false` in `setup/api-keys.json`) come back in full. The browser
  keeps no copy; a new secret is typed into a password field (the saved mask is only its placeholder).
- **Only known names, only clean values.** The name must be in `setup/api-keys.json`; the value must
  be one line, ≤ 4096 characters, without surrounding quotes. Secrets are printable ASCII only (which
  also refuses a mask sent back as a key); URL fields must be `https://` (`http://` only for localhost)
  with no user name, password, `?` or `#`. A save can never inject a second `KEY=` line. Body ≤ 8 KB,
  `Content-Type: application/json`.
- **A token stays with its host.** Saving a new base URL (`JIRA_URL`, `BITBUCKET_URL`, `CONFLUENCE_URL`)
  clears that service's tokens in the same write (`cleared` in the reply), so a stored token is never
  sent to a host it was not entered for — re-pointing a service needs the token re-entered.
- **Safe writes.** One write queue; a randomly named temp file opened exclusive, no-follow, mode 0600,
  synced, then renamed over the old one (and deleted if anything fails); comments and lines the board
  does not own are kept. The log records key names, never a value.
- **Never served.** The static handler refuses any path with a dot-segment, and under `/setup/` only
  `*.template` and `*.json` are served, so `/setup/.env` (or a stray `secrets.env`) is a 404.
- **Who can save a key:** anyone whose request passes the Host/Origin guards below — by default only
  local processes and pages served by the board itself (loopback). Exposing the board on the LAN
  extends that to the LAN; there is no separate authentication. (Env vars set on the container still
  win over `setup/.env`, in Python and bash alike.)

## Data flow per AI backend

**Settings → AI → None.** No model is called. Reports are deterministic (`pr_report.py`); briefs
are not written. Network: your Jira / Bitbucket / Confluence only.

**Local AI (default).** AI-Intern sends the prompt to Ollama — the `AI-Ollama` container, or
`host.docker.internal:11434` with *Host Ollama* on. Nothing leaves the machine except the same
Jira/Bitbucket reads (with your tokens) and the model download from Ollama's registry.

**Cloud AI.** For each enrichment or brief, AI-Intern sends to the chosen provider, under your
key: the ticket title, description, comments, acceptance criteria, PR metadata, the **list of
changed file paths** (not diffs), related tickets' summaries, Confluence excerpts already on the
ticket, and the deterministic base report. Providers and endpoints:

| Provider | Endpoint | Notes |
|---|---|---|
| Claude | `api.anthropic.com` Messages API | Haiku models only are listed. |
| Gemini | `generativelanguage.googleapis.com` | Flash / Lite models only. |
| Cursor | `api.cursor.com/v1/agents` (Cloud Agents) | The agent is created with `autoCreatePR: false`, no repository, and archived after the run. **Known limitation:** Cursor Cloud Agents run in *agent* mode — the model can call its own tools while reasoning over the prompt, so the untrusted-data boundary below relies on the prompt alone there. Prefer Local AI or the Claude/Gemini chat APIs for sensitive tickets. |

Optional proof lookups run only when configured: Bitbucket build status (needs `BITBUCKET_PAT`),
Checkmarx (`CHECKMARX_API_KEY` + `endpoints.checkmarxBase`), Dynatrace (`DYNATRACE_PAT` +
`endpoints.dynatraceTenants`). Each is a read; results become gate rows in the report.

## Prompt-injection boundary

Every piece of third-party text the model sees — ticket fields, comments, PR titles and comments,
Confluence excerpts — is placed inside `<untrusted_data source="jira,bitbucket,confluence"> …
</untrusted_data>` (`worker.py UNTRUSTED_OPEN`), and the system prompt (`ai-intern/prompts/
enrich.txt`) instructs the model to treat it strictly as data, to ignore instructions found in it,
and to flag deliberate-looking ones as a risk. The model's output is **structured JSON only** and is
merged, not trusted: `pr_report.validate_report` + `preserved_errors` reject any output that changes
the verdict, score, tones, stats, fingerprint, base tabs or derived blocks; the AI may only add its
own violet tab, extra evidence rows, the two proof gate states and a business one-liner. A rejected
or failed enrichment restores the deterministic base (`_restore_report`). Light HTML in reports is
sanitised by the app; links are restricted to `http(s)://` and site-relative paths.

## TLS posture

Certificate verification is **on** for every outbound call: `jira-intern/_jira.py ssl_context()`
(fetch) and `ai-intern/worker.py _verified_ssl()` (worker; the public AI, Checkmarx and Dynatrace
endpoints always verify and ignore `JIRA_INSECURE_TLS`).

- **Private corporate CA:** put the PEM at `~/.ai/ca-bundle.pem` — both containers mount `~/.ai`,
  so the fetch scripts and the worker pick it up with no further setting — or point
  `JIRA_CA_BUNDLE` at it. The bundle is **added** to the system roots, never a replacement (Jira
  may use a public certificate while Bitbucket uses the company CA). An explicit `JIRA_CA_BUNDLE`
  that cannot be read fails loudly; an unreadable default bundle is warned about and skipped.
- **Last resort:** `JIRA_INSECURE_TLS=1` disables verification for Jira/Bitbucket only and prints
  `WARN: TLS verification disabled (JIRA_INSECURE_TLS=1)` on every run. The bearer token then
  travels over an unverified channel; do not leave this on.
- The MCP templates in `setup/` show `*_SSL_VERIFY=false` lines for the community Atlassian MCP
  server; remove them (or point that server at your CA bundle) unless you really need them.

## Network exposure

- The board is published on **`127.0.0.1:4321` only** by default (`docker-compose.yml`
  `${BIND_IP:-127.0.0.1}`; `npm run serve` binds `127.0.0.1` too). AI-Intern (4322) and Ollama
  (11434) are never published; the board proxies the worker.
- **Host header check** (`server/serve.mjs hostAllowed`): requests whose `Host` is not loopback, the
  server's own bind address, or an `ALLOWED_HOSTS` entry get **403 `forbidden host`**. A page on
  another origin cannot make your browser send a loopback `Host`, which is what blocks DNS
  rebinding.
- **Cross-site writes** (`originAllowed`): every non-GET must carry an `Origin`/`Referer` whose
  host equals `Host`, and `Sec-Fetch-Site` must be `same-origin` or `none`. Requests with neither
  header (curl, scripts) are allowed — there is no page they could have been forged from.
- JSON routes require `Content-Type: application/json`; bodies are capped (4 KB settings, 8 KB API
  keys, 64 KB proxied, 1 MB at the worker); queues are bounded (50 refreshes, 500 reports).
- Static serving is an **allow-list** (`/dist`, `/help`, `/docs`, `/setup`, `models.json`, `data.*`,
  `reports/index.js`) that never matches a dotfile (`setup/.env`, `.settings.json` are 404); every response has `X-Content-Type-Options: nosniff` and
  `Referrer-Policy: no-referrer`; Jira data is `Cache-Control: no-store`.
- **Exposing on the LAN** (`BIND_IP=0.0.0.0 ALLOWED_HOSTS=my-laptop.local,192.168.1.20`) means
  anyone on that network can read your tickets, start jobs and overwrite your API keys (never read
  them back in full). Do it only on a network you trust,
  and keep the list of names tight.

## Input validation at the edges

Ticket keys (`^[A-Z][A-Z0-9]+-\d+$`), years, dates, archive scopes and model tags are validated in
the server, in `ai_queue.py`, in the runners and in the worker before they reach a file name, a
REST path or a spawned command; children are spawned with argument arrays, never a shell string.
`pr_report.py` HTML-escapes everything it emits; `_jira.light_html` reduces Jira HTML to a handful
of tags and drops `javascript:`/`data:` links.

## Git history

The current tree uses neutral placeholders everywhere (`PROJ-123`, `jira.your-company.example`),
and CI builds from it. **Early commits of this repository did contain internal hostnames**, and
nothing in the tree can undo that. Before making the repository public, either rewrite history
(`git filter-repo --replace-text`) or publish from a fresh-history mirror. The checklist, with a
grep you can extend with your own company names, is in
[`../setup/README.md`](../setup/README.md#before-you-make-the-repo-public).

## Reporting a problem

Open a GitHub issue using the bug template **without** real ticket content, tokens, hostnames or
tenant ids. For anything that would expose data if posted publicly, describe the class of problem
and ask for a private channel in the issue; the maintainer will follow up. Please include the
run mode (Docker / static / live server), the relevant `docs/RUNTIME-FILES.md` log, and redacted
`docker compose logs` lines.
