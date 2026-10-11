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
- A redirect bouncing a credential (Jenkins basic auth, the Checkmarx key or bearer token) to another host or
  down to plain http.

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
| `BITBUCKET_PAT` / `ATLASSIAN_TOKEN` | fetch scripts, AI worker | Bitbucket REST: PR comments, changed files, build status (optional). `ATLASSIAN_TOKEN` is the Atlassian Cloud token (its own row in the dialog); today it backs Bitbucket when no PAT is set. |
| `CHECKMARX_API_KEY` (+ `CHECKMARX_BASE_URL` / `CHECKMARX_AUTH_URL`) | fetch scripts (`checkmarx.py`), AI worker (same module) | Checkmarx One scan lookups for vulnerability-fix tickets (optional). The key is POSTed only to the token URL, once per run, in the request body; the short-lived bearer token it returns goes in the `Authorization` header to the configured https base URL only. |
| `JENKINS_ROOT_URL` | fetch scripts (`jenkins.py`), key Test | The Jenkins folder holding your projects (an internal host — **setup/.env only**, never the tracked config; `jenkins.root` belongs in `~/.ai/config.json`). https only. Discovery reads it with the same credentials and rules as job URLs; `jira-intern/.jenkins-discovery.json` (git/docker-ignored) caches the folder and pipeline names found there — no credentials. |
| `JENKINS_USER` / `JENKINS_API_TOKEN` | fetch scripts (`jenkins.py`) | Jenkins builds per branch and environment, HTTP basic in the `Authorization` header, sent only to the **https** job URLs in config → `jenkins.jobs` (an `http://` job is skipped, never sent the token) (optional). |
| `GITHUB_TOKEN` | nothing yet | Saved for a coming integration (`planned` in `setup/api-keys.json`). |
| `JIRA_URL` / `CONFLUENCE_URL` / `BITBUCKET_URL` | fetch scripts, AI worker | Endpoint overrides. |
| `JIRA_CA_BUNDLE` / `JIRA_INSECURE_TLS` / `JENKINS_INSECURE_TLS` / `DYNATRACE_INSECURE_TLS` | fetch scripts, AI worker | TLS posture (below). |
| `CURSOR_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` | AI worker (`file_secret`, re-read per call, never exported) | Cloud AI providers. |
| `OPENAI_API_KEY` | shell runners (`connector.codex.apiKeyEnv`) | Only for the optional Codex agent fallback. |
| `DYNATRACE_PAT` | fetch scripts (`dynatrace.py`), AI worker (its text-search probe), key Test | A Dynatrace **platform token** with read scopes only — `Authorization: Bearer`, sent solely to `https://<listed tenant id>.apps.dynatrace.com` (optional). |
| `DYNATRACE_TENANTS` | fetch scripts, AI worker, key Test | **Not a secret, but the allowlist:** `prod=abc12345,uat=def67890` — the only Dynatrace tenants ever contacted (below). Falls back to `endpoints.dynatraceTenants`. A `text` field in the dialog (shown in full; no spaces, quotes, backticks, `$(` or `${`). |

Process boundaries: the Docker entrypoint **does not export** the secrets file into the Node
server's environment (the server reads it only to mask values for the dialog) — the Python scripts load the file themselves, and `runner-env.sh` exports
only the allow-list above to its children. The worker exports only the Jira/Bitbucket/Confluence
values its imported modules read; cloud keys never enter `os.environ`. Nothing logs a token; the
entrypoint only greps for the *presence* of `JIRA_PERSONAL_TOKEN=`.

## The API keys dialog

The board's key button writes `setup/.env` through `GET`/`POST /api/keys` (`server/secrets.mjs`):

- **No full value ever leaves the server.** `GET /api/keys` returns `{ set, masked }` per key: first 4
  + `••••••••` + last 4 for 16+ characters, all bullets below that — the length is never revealed.
  Only `url`, `email` and `text` fields (their `kind` in `setup/api-keys.json`) come back in full. The browser
  keeps no copy; a new secret is typed into a password field (the saved mask is only its placeholder).
- **Only known names, only clean values.** The name must be in `setup/api-keys.json`; the value must
  be one line, ≤ 4096 characters, without surrounding quotes. Secrets are printable ASCII only (which
  also refuses a mask sent back as a key); URL fields must be `https://` (`http://` only for localhost)
  with no user name, password, `?` or `#`. A save can never inject a second `KEY=` line. Body ≤ 8 KB,
  `Content-Type: application/json`.
- **Saving one key never touches another.** A token is removed only when the user removes it — changing a
  base URL keeps the token. The trade-off: anyone who can reach `POST /api/keys` (loopback by default) could
  point a service at a host they control and the next fetch would send that service's token there. Keep
  the board on loopback (the default); if you expose it on the LAN, treat `/api/keys` as admin access.
- **Safe writes.** One write queue; a randomly named temp file opened exclusive, no-follow, mode 0600,
  synced, then renamed over the old one (and deleted if anything fails); comments and lines the board
  does not own are kept. The log records key names, never a value.
- **Never served.** The static handler refuses any path with a dot-segment, and under `/setup/` only
  `*.template` and `*.json` are served, so `/setup/.env` (or a stray `secrets.env`) is a 404.
- **Who can save a key:** anyone whose request passes the Host/Origin guards below — by default only
  local processes and pages served by the board itself (loopback). Exposing the board on the LAN
  extends that to the LAN; there is no separate authentication. (Env vars set on the container still
  win over `setup/.env`, in Python and bash alike.)

### The Test button (`POST /api/keys/test`)

The browser sends only a service id; the server (`server/keycheck.mjs`) reads the saved key itself and makes ONE
read-only, authenticated request to the service the key belongs to — nothing else:

| Service | Goes to | Credential sent as |
|---|---|---|
| Jira · Confluence · Bitbucket | the saved `*_URL`, else `endpoints.*Base` — `/rest/api/2/myself`, `/rest/api/user/current`, `/rest/api/1.0/projects?limit=1` | `Authorization: Bearer` (Bitbucket falls back to `ATLASSIAN_TOKEN`) |
| Atlassian Cloud | `ATLASSIAN_SITE_URL/rest/api/3/myself`; on a 401 also an anonymous `…/_edge/tenant_info` (the public cloud id) and `api.atlassian.com/ex/jira/<cloudId>/rest/api/3/myself` | HTTP Basic email + token |
| Jenkins | `JENKINS_ROOT_URL` (else `jenkins.root`) + `api/json?tree=name,jobs[name,_class]`; else `JENKINS_URL` `/me/api/json`; else the first https job URL in `jenkins.jobs` + `api/json?tree=name` | HTTP Basic user + token |
| Checkmarx One | its token URL (as `checkmarx.py`) | the key in the POST body only (refresh-token grant) |
| Dynatrace | per **listed** tenant, `https://<tenant id>.apps.dynatrace.com/platform/storage/query/v1/query:execute` (+ `query:poll` while it runs): `fetch dt.davis.problems \| limit 1` over 7 days — the id is validated (`[a-z0-9-]`) before a host is built | `Authorization: Bearer` |
| Claude · Cursor · Gemini · OpenAI | the vendor's fixed `/models` URL | `x-api-key` · Basic · `x-goog-api-key` · Bearer — never in a URL |
| GitHub | `https://api.github.com/user` | Bearer |

- `https://` only (`http://` only for localhost); a base URL with a user, `?` or `#`, or the config's `.example`
  placeholder, sends nothing (`not-configured`).
- Redirects are **never followed**: a 3xx is reported as "Redirected to <host>", so a credential cannot be bounced to
  another host. 10 s timeout, 256 KB response cap, one test per service at a time (a second gets 409).
- TLS always verified; `JIRA_CA_BUNDLE` / `~/.ai/ca-bundle.pem` is **added** to the system roots; `JIRA_INSECURE_TLS=1`
  relaxes only the Jira / Confluence / Bitbucket hosts, `JENKINS_INSECURE_TLS=1` only Jenkins and
  `DYNATRACE_INSECURE_TLS=1` only Dynatrace — the same switches the fetch honours, so Test and the real fetch agree.
- The answer carries a status, the HTTP code, the time and a short detail built only from safe fields (a display name,
  a login, a model count, a host name); every saved secret is scrubbed from it, and the remote error text is never
  echoed. The log line is `[keys] test <service> → <status>`. Same Host/Origin guards and JSON-only rule as every POST.

## Health records record nothing secret

`jira-intern/.health/<service>.json` (the API keys dialog's dots) holds only a state, timestamps, an HTTP status and a
short `detail` built from fixed texts plus the host name — never a header, a token, a URL path or query. Anything a caller
passes is scrubbed (auth values, `?query`, long opaque blobs, any saved secret value) and capped at 160 characters; the
exception's own message is never echoed. The folder is git-ignored, docker-ignored and, being a dot-segment, never served;
`GET /api/keys/health` carries the same Host guards as every route.

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
Checkmarx (`CHECKMARX_API_KEY` + `endpoints.checkmarxBase`), Dynatrace (`DYNATRACE_PAT` + a listed tenant).
Each is a read; results become gate rows in the report. What these systems say about a ticket also reaches the
model, in the AI brief's "Evidence" and the report's "Issue insight" — see the paragraphs below.

**What goes to Checkmarx One.** Only for a vulnerability-fix ticket with a pull request, the daily fetch (and,
for a ticket the fetch has no results for, the AI worker) sends: the API key to the token URL, then GETs with the
PR's **repository slug** (project search), its **source and destination branch names** (scan search) and scan ids
(results). No ticket text, title, CVE list or comment ever leaves — the targets are matched locally against the
results that come back. Nothing is written to Checkmarx.

**What goes to Dynatrace.** Only for a ticket whose own text contains a Dynatrace link, the daily fetch sends the
platform token (in the `Authorization` header, nowhere else) and read-only DQL queries to
`https://<tenant id>.apps.dynatrace.com/platform/storage/query/v1/` — the exact queries are listed in
[INTEGRATIONS.md](INTEGRATIONS.md#dynatrace-links-in-a-ticket-read-only-dql); `python3 jira-intern/dynatrace.py inspect <link> --no-read`
prints them without sending anything. What is in a query: an id taken from the link (a trace id, a service id or a
problem id), and the link's time window as request fields. Nothing else from the ticket — no title, description, comment
or person — is ever sent, and nothing is written to Dynatrace. The controls, all enforced in code and tested:
  - **Tenant allowlist (SSRF).** Only tenants listed in `DYNATRACE_TENANTS` / `endpoints.dynatraceTenants` are contacted. The request
    URL is built from the *listed, validated tenant id* (`^[a-z0-9][a-z0-9-]{1,62}$` — no dots, slashes, ports or user info) and a
    fixed path. A host in the ticket text only selects which listed tenant a link belongs to; a link to any other host is
    stored as `unconfigured-tenant` and never fetched (a host that is not `*.live.dynatrace.com` / `*.apps.dynatrace.com` — a Dynatrace Managed link included — is not treated as a Dynatrace link at all, so it is never shown under Dynatrace's name), and
    no URL a response contains is ever requested — the poll URL is rebuilt from the same id and the `requestToken` (URL-encoded),
    and a redirect is followed only within the same origin. The key dialog's Test validates the id again in Node before it builds a host.
  - **No query injection.** An id enters DQL only after a strict regex (a trace id is 16–32 hex characters, a service id
    `SERVICE-` + 16 hex, a problem id letters / digits / `_ . -`); a link whose id fails is `other` — listed, never queried. Times
    travel as `defaultTimeframeStart` / `End`, never as DQL text. Every query is a `fetch … | filter … | fields/summarize | limit`:
    nothing writes, and nothing the ticket says is concatenated into a query beyond the validated id.
  - **Cost and size caps.** The window is the link's own, padded 5 minutes, at most 2 hours (problems: 30 minutes, at most 7 days;
    a trace or log link with no absolute window is not queried); at most 500 spans / 200 log lines / 200 problems per query, `maxResultBytes` 1 MB,
    `defaultScanLimitGbytes` 2, a 15 s query timeout, a 2 MiB response cap, at most 5 links per ticket (one of each kind first), **200 calls
    and 15 minutes of wall-clock per fetch run**, 4 in flight, cached per run (refusals too) and not re-asked while fresh (24 h; 1 h
    for an open problem; 6 h for an empty answer); two queries that do not finish mark the tenant down for the run.
  - **Token handling.** The token is read from `setup/.env` / the environment at the moment of use and goes only in the header: never in
    a URL, a log line, the health record (`detail` = fixed text + host), `data.json`, a run note or an error message (an unreadable
    response logs only the exception's type).
  - **TLS and redirects.** Verified, a private CA is added (`JIRA_CA_BUNDLE`, `~/.ai/ca-bundle.pem`); `JIRA_INSECURE_TLS` never applies,
    `DYNATRACE_INSECURE_TLS=1` is the separate last resort; a redirect to another scheme / host / port is refused.
  - **Least privilege.** The token needs only `storage:spans:read`, `storage:events:read`, `storage:logs:read` and
    `storage:buckets:read`. A 403 names the scope and blocks that table for the run.

**What is stored, and what reaches a model.** Dynatrace answers and a Jenkins console tail are written by other people's
software and can hold a token a service logged by mistake, a password on a command line, a URL with credentials, a customer's
e-mail address. So everything the board keeps of them goes through `jira-intern/_scrub.py` **before** it is stored, shown or
sent to a model: `Authorization` / `Bearer` / `Basic` values, `password=` / `secret:` / `token=` / `api_key=` values (any
spelling containing those words), credentials in URLs and token-like query parameters, JWTs, Dynatrace / AWS / GitHub / Slack
tokens, private-key blocks, long opaque base64-like blobs, the value of any environment variable whose name looks secret,
e-mail addresses (`[email]`) and IP addresses (`[ip]`), plus ANSI colours and control characters — deliberately aggressive. Its
patterns are bounded (no catastrophic backtracking on hostile text) and only the first 64 K characters of a text — the last 64 K
of a log — are looked at; if the scrub itself ever fails it keeps nothing rather than the raw text. Only
short facts are kept (≤ 8 findings of ≤ 200 characters, ≤ 3 KB per link; ≤ 40 lines / 4 KB of a console), never a raw span,
log record or console. A Jenkins console is never downloaded whole (a ranged request, else a bounded stream; a log past 2 MiB
is not read further), only for the latest failed build of a ticket about a failing build / pipeline, only from the configured
build URL, 25 per run. With a **cloud** AI backend those stored facts (and the console excerpt) are part of what is sent to the
provider with the ticket, exactly like the ticket's text; **local** AI and AI level **None** send nothing. They travel only inside
`<untrusted_data>` (below).

## Prompt-injection boundary

Every piece of third-party text the model sees — ticket fields, comments, PR titles and comments,
Confluence excerpts, and the evidence from Dynatrace, Checkmarx and Jenkins — is placed inside
`<untrusted_data source="jira,bitbucket,confluence,dynatrace,checkmarx,jenkins"> …
</untrusted_data>` (`worker.py UNTRUSTED_OPEN`; the brief's trusted FACTS keep only the *names* of the sources read —
`brief.split_evidence`), and the system prompt (`ai-intern/prompts/
enrich.txt`) instructs the model to treat it strictly as data, to ignore instructions found in it,
and to flag deliberate-looking ones as a risk. The model's output is **structured JSON only** and is
merged, not trusted: `pr_report.validate_report` + `preserved_errors` reject any output that changes
the verdict, score, tones, stats, fingerprint, base tabs or derived blocks; the AI may only add its
own violet tab, extra evidence rows, the two proof gate states and a business one-liner. A rejected
or failed enrichment restores the deterministic base (`_restore_report`). Light HTML in reports is
sanitised by the app; links are restricted to `http(s)://` and site-relative paths.

The evidence the model may restate is checked after it answers: a brief's **Evidence** section that holds a number or an
identifier (anything with a digit in it) the evidence does not contain, more than a few words the evidence does not use, or a link,
is replaced by the deterministic section, a missing one is added, one with no evidence behind it is removed
(`brief.enforce_evidence`); a reworded **Issue insight** is applied only when `evidence.grounded` accepts it (≤ 700 characters, no
new number or identifier, almost no new vocabulary) — otherwise the templated text stays; and the model's HTML is cut down to the
tags the prompt allows, a link to an address that is in none of the packs or that is not `http(s)` is unwrapped
(`brief.scrub(allowed_urls=…)` → `sanitize_html`, bounded patterns). Evidence is also scrubbed again as it is assembled
(`evidence.build`), so text stored by an older version or edited by hand is not trusted, and a `</untrusted_data>` inside any pack
is defanged. Every regular expression that reads text other people can write (comment bodies, log lines, console output, model
output) is bounded and its input capped — a comment of 32,000 unterminated tags must not stall a fetch. An
injected instruction in a console line or a Dynatrace message can therefore at most change wording inside those two checks —
never add a fact, a link or a verdict.

## TLS posture

Certificate verification is **on** for every outbound call: `jira-intern/_jira.py ssl_context()`
(fetch) and `ai-intern/worker.py _verified_ssl()` (worker; the public AI endpoints and its Dynatrace text-search probe always
verify and ignore `JIRA_INSECURE_TLS`). Checkmarx One (`jira-intern/checkmarx.py`, used by both) always verifies
too and ignores `JIRA_INSECURE_TLS`. Jenkins (`jira-intern/jenkins.py`) has its **own** verified context and
ignores `JIRA_INSECURE_TLS` as well; it reads https job URLs only. Dynatrace (`jira-intern/dynatrace.py`) likewise: its own
verified context, https tenant hosts only. All three proof clients build their TLS context and
opener from `jira-intern/_safe_http.py` (`verified_context`, `opener`).

- **Redirects never carry a credential off its origin:** Jenkins, Checkmarx and Dynatrace requests follow a redirect only to
  the same scheme + host + port (`_safe_http.SameOriginRedirect`). A redirect to another host, or from https to
  http, is refused and counts as a failed lookup (prior data carried forward) — so the `Authorization` header and
  the POSTed Checkmarx key never reach a host the config did not name, and never travel in clear text.

- **Private corporate CA:** put the PEM at `~/.ai/ca-bundle.pem` — both containers mount `~/.ai`,
  so the fetch scripts and the worker pick it up with no further setting — or point
  `JIRA_CA_BUNDLE` at it. The bundle is **added** to the system roots, never a replacement (Jira
  may use a public certificate while Bitbucket uses the company CA). An explicit `JIRA_CA_BUNDLE`
  that cannot be read fails loudly; an unreadable default bundle is warned about and skipped.
- **Last resort:** `JIRA_INSECURE_TLS=1` disables verification for Jira/Bitbucket only and prints
  `WARN: TLS verification disabled (JIRA_INSECURE_TLS=1)` on every run. The bearer token then
  travels over an unverified channel; do not leave this on.
- **Jenkins' own last resort:** `JENKINS_INSECURE_TLS=1` disables verification for Jenkins only (WARN on every run);
  the CA bundle above is the better fix. **Dynatrace's:** `DYNATRACE_INSECURE_TLS=1` for the fetch's Dynatrace reads (WARN on every run) and the
  dialog's Dynatrace Test and the worker's text-search probe. Checkmarx has none.
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
