# HTTP API

Two small HTTP surfaces exist. The **board server** (`server/serve.mjs` + the rest of `server/`, port **4321**) is
what the browser talks to; the **AI-Intern worker** (`ai-intern/worker.py`, port **4322**, never
published by compose) is reached only through the board's proxy routes. Neither has
authentication: both are meant for loopback use (see [SECURITY.md](SECURITY.md)).

The board routes below mirror the comment block at the top of `server/serve.mjs` — that comment is the
source of truth; update both together.

## Board server — `server/serve.mjs`

Responses are JSON unless noted; errors are `{ ok: false, error: '<short reason>' }`. `K` is a
Jira ticket key (`^[A-Z][A-Z0-9]+-\d+$`, any case; normalised to upper case). Parameters are query
params unless marked `body:`.

### Guards on every request

| Check | Failure |
|---|---|
| `Host` must be loopback (`localhost`, `127.0.0.1`, `[::1]`, `*.localhost`), the `BIND_HOST` address, or listed in `ALLOWED_HOSTS` (comma-separated `host[:port]`) | **403** `forbidden host` (+ `hint`) |
| Non-GET/HEAD: `Origin` (or `Referer`) host must equal `Host`, and `Sec-Fetch-Site`, when sent, must be `same-origin` or `none` | **403** `forbidden origin` |
| `POST /api/settings`, `/api/keys`, `/api/keys/test`, `/api/ai-models/pull`, `/api/ai-jobs` need `Content-Type: application/json` | **415** `unsupported media type` |
| Undecodable path | **400** `bad url` |
| Unknown `/api/*` | **404** `not found` |
| Non-GET on a static path | **405** `method not allowed` |
| Body larger than the route's limit (4 KB settings, 8 KB keys, 1 KB key test, 64 KB proxied) | **413** `too large` |
| Client went away mid-body | **400** `aborted` |
| Queue at capacity | **429** `queue full` |
| Unhandled exception | **500** `internal error` |

`HEAD` behaves like `GET` without a body. Every response carries
`X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`; API responses add
`Cache-Control: no-store`.

### Static

| Route | Notes |
|---|---|
| `GET /` | 302 → `/dist/index.html` |
| `GET /dist/*` · `/help/*` · `/docs/*` · `/setup/*` | file; ETag / 304, gzip, `Cache-Control: no-cache` |
| `GET /help` · `/help/` | 302 → `/help/00-start-here.html` (the help guide) |
| `GET /ai-intern/models.json` | file (the local model catalogue) |
| `GET /jira-intern/data.json` · `/jira-intern/data.js` | file, `Cache-Control: no-store` — Jira data never hits the disk cache |
| `GET /jira-intern/reports/index.js` | file, `Cache-Control: no-store` |

Only paths matching the allow-list in `server/serve.mjs` are ever opened (`server/http.mjs`
`createStaticHandler`); everything else under the repo is 404, including `jira-intern/*.py`,
`.settings.json` and `reports/*.json` (reports are served through the API instead). Any path with a
dot-segment (`setup/.env`, `.settings.json`, …) is 404 whatever the allow-list says.

### Data writers

The daily fetch, the archive rebuild and the per-ticket refresh all rewrite `data.json`, so one
runs at a time (`server/jobs.mjs`).

| Route | Response |
|---|---|
| `POST /api/run-intern` | **202** `{ ok, started: true, runAt }` · **409** `{ ok: false, running: true }` |
| `POST /api/run-archive?scope=all\|year\|since\|key [&year=YYYY \| &since=YYYY-MM-DD \| &key=K]` | **202** `{ ok, started: true, runAt }` · **400** `bad scope` / `bad year` / `bad since` / `bad key` · **409** running |
| `POST /api/run-archive/stop` | **200** `{ ok, stopped: bool }` — only a rebuild this server started |
| `POST /api/refresh-ticket?key=K` | **202** `{ ok, queued: true, started: bool \| already: true, key, active, position, pending[] }` · **400** `bad key` · **429** `queue full` (50 waiting) |

### PR readiness reports

| Route | Response |
|---|---|
| `GET /api/reports` | **200** `{ reports: { K: summary }, generating: [K], exits: { K: code } }` |
| `GET /api/reports/:key` | **200** full report JSON · **400** `bad key` · **404** `no report yet` |
| `POST /api/report?key=K` | **202** `{ ok, queued: true \| already: true [, external: true], key, pending[] }` · **400** `bad key` · **429** `queue full` (500 waiting) |
| `POST /api/reports/bulk?scope=all\|year\|since\|keys [&year= \| &since= \| &keys=K,K,…] [&force=1]` | **202** `{ ok, scope, matched, queued: [K], pending: [K] [, full: true] }` · **400** `bad year` / `bad since date`. `keys=` is capped at the queue size. |
| `POST /api/reports/stop` | **200** `{ ok, stopped: true }` — clears the queue, kills the base build, writes `.ai-cancel-report`, drops unclaimed enrich jobs |

A report summary is `{ key, title, timeZone, generatedAt, enrichedAt, enriched, fingerprint, verdict }`.

### Settings

| Route | Response |
|---|---|
| `GET /api/settings` | **200** `{ ok, settings }` — project defaults overlaid by `jira-intern/.settings.json` |
| `POST /api/settings` `body:` partial settings object, ≤ 4 KB | **200** `{ ok, settings }` · **400** `bad json` / `bad <field>` / `aborted` · **413** `too large` · **415** · **500** `save failed` |

Accepted fields (`server/settings.mjs` `SCHEMA`): `aiLevel` (none/low/moderate/full),
`aiBackend` (local/cloud), `aiLocalModel` (≤ 80 chars), `aiCloudModel` (≤ 128), `aiCloudProvider`
(claude/cursor/gemini), `aiCloudEffort` (low/medium/high/auto), `aiUseHostOllama`, `reportParallel` (1–10),
`archiveParallel` (1–16), `refreshParallel` (1–16), `activeRefresh` (off/daily/twice-daily),
`fullRefresh` and `reportRefresh` (off/daily/weekly/twice-weekly). Model ids must match
`^[\w.:/-]*$`. Unknown keys are ignored; one invalid value rejects the whole patch.

### API keys

The values live in `setup/.env` (`server/secrets.mjs`); the names that exist are `setup/api-keys.json`.

| Route | Response |
|---|---|
| `GET /api/keys` | **200** `{ ok, keys: { ENV: { set, masked } } }` — one entry per key in `api-keys.json`. A secret's `masked` is first 4 + `••••••••` + last 4 (≥ 16 chars), all bullets below that — never the full value or its length; `url`, `email` and `text` fields come back as they are · **500** `could not read setup/.env` |
| `POST /api/keys` `body: { name, value }`, ≤ 8 KB | **200** `{ ok, keys }` — the new status (only the named key changes) · **400** `bad json` / `unknown key …` / `value must be a single line` / `remove the surrounding quotes` / `value too long` (> 4096) / a secret that is not printable ASCII / a URL that is not `https://` (`http://` only for localhost) or carries a user, password, `?` or `#` / `must be an email address` / a text field with spaces, quotes, backticks, `$(` or `${` (it is shown in full and read by scripts — so a JSON `DYNATRACE_TENANTS` cannot be saved here, use `prod=abc12345,uat=def67890`) · **413** · **415** · **500** `could not write setup/.env` |
| `GET /api/keys/health` | **200** `{ ok, health: { <serviceId>: record } }` — the latest REAL outcome per service, from `jira-intern/.health/*.json` (written by every fetch / AI-worker call and by Test). `record` = `{ service, state: 'ok'\|'attention', checkedAt, lastOkAt?, failingSince?, status?: 'auth-failed'\|'forbidden'\|'unreachable'\|'tls'\|'not-found'\|'error', httpStatus?, detail, source: 'fetch'\|'worker'\|'test' }`. A service never called has no entry; no secret is ever in a record. `Cache-Control: no-store`. A missing folder is `{}`, never an error |
| `POST /api/keys/test` `body: { service }`, ≤ 1 KB | **200** `{ ok, service, status, httpStatus?, ms, detail }` — `status` is `ok` · `auth-failed` · `forbidden` · `not-found` · `unreachable` · `tls` · `not-configured` · `error`; `detail` is human text (a display name, a login, a model count, the host that could not be reached) and never holds a secret · **400** `bad json` / `unknown service` · **409** `test already running` (one test per service at a time) · **413** · **415** · **500** `could not read setup/.env` |

`name` must be in `api-keys.json`; `value: ''` removes the key. A save rewrites only that line (comments
and unknown lines are kept) through one write queue — temp file, mode 0600, rename. The log records the key
name only. The same Host/Origin guards as every POST apply.

`POST /api/keys/test` (`server/keycheck.mjs`) checks the SAVED values — nothing in the request body but the
service id. It re-reads `setup/.env` (an environment variable of the same name wins, as in the Python scripts),
takes base URLs from the saved `*_URL` keys, else the config's `endpoints`, and makes ONE authenticated read:

| `service` | Request |
|---|---|
| `jira` | `GET {JIRA_URL \| endpoints.jiraBase}/rest/api/2/myself`, `Authorization: Bearer JIRA_PERSONAL_TOKEN` → "Signed in as <displayName>" |
| `confluence` | `GET {CONFLUENCE_URL \| endpoints.confluenceBase}/rest/api/user/current`, Bearer `CONFLUENCE_PERSONAL_TOKEN` |
| `bitbucket` | `GET {BITBUCKET_URL \| endpoints.bitbucketBase}/rest/api/1.0/projects?limit=1`, Bearer `BITBUCKET_PAT` (else `ATLASSIAN_TOKEN`) |
| `atlassian` | `GET {ATLASSIAN_SITE_URL}/rest/api/3/myself`, Basic `ATLASSIAN_EMAIL:ATLASSIAN_TOKEN` (not-configured "needs email + site URL" without them) On a 401 it retries once through Atlassian's gateway (`api.atlassian.com/ex/jira/<cloudId>/…`, cloud id read anonymously from the site's `/_edge/tenant_info`) — **scoped API tokens** (`ATATT…`) are rejected on the site URL and work only there; success says "scoped token, via api.atlassian.com". A refusal reports each attempt — "Rejected — site 401 (AUTHENTICATED_FAILED) · gateway 401" — using Atlassian's own `X-Seraph-LoginReason` header; a gateway 403 means a valid scoped token that lacks the `read:jira-user` scope (reported as forbidden, not rejected). |
| `jenkins` | `GET {first https URL in jenkins.jobs}api/json?tree=name`, Basic `JENKINS_USER:JENKINS_API_TOKEN` |
| `checkmarx` | `POST` the token URL (`CHECKMARX_AUTH_URL` \| `endpoints.checkmarxAuthUrl`, else `<base>/auth/realms/<tenant>/protocol/openid-connect/token`), form `grant_type=refresh_token&client_id=ast-app&refresh_token=CHECKMARX_API_KEY` — as `jira-intern/checkmarx.py`; a 400 `invalid_grant` is `auth-failed` |
| `dynatrace` | one probe **per listed tenant**, all at once: `POST https://<tenant id>.apps.dynatrace.com/platform/storage/query/v1/query:execute`, Bearer `DYNATRACE_PAT`, body `fetch dt.davis.problems \| limit 1` over the last 7 days with `maxResultRecords: 1` (a `202` / `RUNNING` answer is polled up to 3 times with `query:poll`). Tenants: `DYNATRACE_TENANTS` (`prod=abc12345,uat=def67890`, or JSON from the environment), else `endpoints.dynatraceTenants`; an id must be a bare tenant id (`[a-z0-9-]`, no dots or slashes) — the host is built from it and from nothing a response says. → "Connected · N tenants"; with a failure the worst one wins and every tenant is named ("prod: OK · uat: token accepted but lacks a scope (storage:events:read)"). Not configured: "needs DYNATRACE_PAT" / "needs DYNATRACE_TENANTS …" |
| `claude` | `GET https://api.anthropic.com/v1/models`, `x-api-key`, `anthropic-version: 2023-06-01` |
| `cursor` | `GET https://api.cursor.com/v1/models`, Basic `CURSOR_API_KEY:` (as the worker) |
| `gemini` | `GET https://generativelanguage.googleapis.com/v1beta/models`, `x-goog-api-key` (never in the URL) |
| `openai` | `GET https://api.openai.com/v1/models`, Bearer |
| `github` | `GET https://api.github.com/user`, Bearer + `User-Agent` → "Signed in as <login>" |

HTTP 2xx → `ok`, 401 → `auth-failed`, 403 → `forbidden`, 404 → `not-found`, 3xx → `error` "Redirected to <host>"
(never followed, the credential is never resent), anything else → `error`. A timeout (10 s) or a refused / unknown
host → `unreachable`; an untrusted certificate → `tls`. Missing key or base URL (or an `http://` one other than
localhost, or the config's `.example` placeholder) → `not-configured`, and nothing is sent. TLS is always verified;
`JIRA_CA_BUNDLE` (else `~/.ai/ca-bundle.pem`) is added to the system roots; `JIRA_INSECURE_TLS=1` relaxes only the
Jira, Confluence and Bitbucket hosts (`JENKINS_INSECURE_TLS=1` only Jenkins, `DYNATRACE_INSECURE_TLS=1` only Dynatrace). Response bodies are capped at 256 KB. The log line is `[keys] test <service> → <status>`.

### AI intern (proxied to `AI_INTERN_URL`)

When the worker is unreachable these answer **503** `{ ok: false, down: true, state: 'down', error }`
(`/api/ai-status` and `/api/ai-models` answer 200 with `down: true` and the local catalogue instead).

| Route | Response |
|---|---|
| `GET /api/ai-status` | **200** worker status + `{ queuedKeys: [K], queued }` from `.ai-queue/` |
| `GET /api/ai-models` | **200** worker `/api/models`, or `{ ok: false, down: true, catalog, installed, ollamaOk: false }` |
| `GET /api/cloud-models` | **200** worker `/api/cloud-models` |
| `POST /api/ai-models/pull` `body: { model, useHostOllama? }` | worker reply · **400** `aborted` · **413** · **415** |
| `POST /api/ai-jobs` `body:` job object | worker reply · **400** `aborted` · **413** · **415** |

### Polling

| Route | Response |
|---|---|
| `GET /api/intern-status` | **200** `{ running, job: 'daily' \| 'archive' \| 'external' \| null, lastExit, lastRunAt, startedAt, progress, dataModified, refreshingKeys[], refreshExits{}, reportsGenerating[], reportsEnriching[], ai }` |

One call carries everything the board polls for; `progress` is the parsed `.progress.json` while
a job runs. The Docker `HEALTHCHECK` probes this route.

## AI-Intern worker — `ai-intern/worker.py`

Plain `http.server`, JSON bodies up to 1 MB, listens on `0.0.0.0:4322` **inside the compose
network only**. The board is its only intended client.

| Route | Response |
|---|---|
| `GET /health` | **200** `{ ok: true, workers }` · **503** `{ ok: false, error: 'worker thread died', dead }` (the Docker `HEALTHCHECK`) |
| `GET /api/status` | **200** `{ ok, state: idle \| working \| pulling \| down, backend, model, cloudProvider, cloudEffort, useHostOllama, ollamaOk, ollamaError, installedModels, catalog, memGb, parallel, current, active[], lastError, pulling, pullProgress, queued, updatedAt }` — the `.ai-status.json` record plus live settings and Ollama facts |
| `GET /api/models` | **200** `{ ok, catalog, installed, ollamaOk, memGb }` |
| `GET /api/cloud-models` | **200** `{ ok, claude: { configured, models, error }, cursor: {…}, gemini: {…} }` — curated lists, cached 60 s; `configured` is false when the key is absent from `setup/.env` |
| `POST /api/jobs` `body:` `{ type: enrich-report \| summarize-active \| pull-model, key?, model?, level?, backend?, cloudProvider?, cloudEffort?, useHostOllama? }` | **202** `{ ok, job }` · **400** bad key / bad model tag / validation error |
| `POST /api/models/pull` `body: { model, useHostOllama? }` | **202** `{ ok, job }` · **400** `missing model` / bad tag |
| anything else | **404** |

Jobs are written to `jira-intern/.ai-queue/` through `ai_queue.enqueue` (same validation as the
CLI); the worker threads pick them up within ~2 s. Job and status file formats:
[RUNTIME-FILES.md](RUNTIME-FILES.md#the-ai-queue).
