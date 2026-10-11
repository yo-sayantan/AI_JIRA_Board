# Central project configuration

[`config/jira-board.config.json`](../config/jira-board.config.json) is the versioned source
of truth for every non-secret default and policy in jira-board + jira-intern. Its schema is
[`config/jira-board.config.schema.json`](../config/jira-board.config.schema.json).

## Precedence

Configuration is deep-merged in this order:

| # | Location | Purpose |
|---|---|---|
| 1 | `config/jira-board.config.json` | Complete tracked defaults and policy. |
| 2 | `$AI_CONFIG_FILE` or `~/.ai/config.json` | Optional sparse personal override. |
| 3 | `jira-intern/.settings.json` | Saved runtime AI choices from the Settings window. |

Only put fields that differ from project defaults in the personal override:

```bash
mkdir -p ~/.ai
cp setup/config.example.json ~/.ai/config.json
chmod 600 ~/.ai/config.json
```

Check which file is actually in effect at any time:

```bash
node jira-intern/local-runner/config.mjs path
```

Node, Python, the local server, shell runners, Docker, and the AI worker all use the same
deep-merge contract. Run `node jira-intern/local-runner/config.mjs validate` to validate it,
or `... export` to inspect the effective configuration.

> **Note:** no API tokens live in `config.json` — add them with the key button in the board header
> (stored in `setup/.env`, git-ignored; the list of keys is `setup/api-keys.json`).

Consumed by:
- `local-runner/config.mjs` — resolver. Runners call it for shell vars (`shellenv`), rendered
  prompts (`render`, substituting the `{{TOKENS}}` below), and the MCP policy block (`policy`).
- `local-runner/*.sh` — daily / weekly / per-ticket runners (connector, models, timeouts).
- `jira-board/server/serve.mjs` — port.
- `local-runner/sync-datajs.mjs` — injects the `app` section into `data.js` as
  `window.__JIRA_CONFIG__`, so the **built** app re-themes at runtime (no rebuild needed).

The tracked project config is required. Invalid JSON, schema fields, port, or AI policy fails
validation loudly. An invalid timezone falls back to UTC; legacy `IST` normalizes to
`Asia/Kolkata`.

---

## `user` — who you are
| key | meaning |
|---|---|
| `name` | Your display name exactly as Jira shows it. Used for prompt tokens and attribution; the fetch resolves "assigned to me" through Jira itself (`currentUser()` in JQL). In the board it is the fallback for spotting *me* in a stored assignee (`"Display Name (ID)"`) when there is no id to compare — `src/lib/format.ts::isAssignedToMe`. |
| `accountId` | Your corporate user id (e.g. `ABC1234`). Decides which sub-tasks are *mine*: compared case-insensitively and **exactly** with the assignee's `name` / `key` / `accountId`; the display name only counts when it contains the id as a whole word. The board does the same on the dump (Raised "With me", the drawer's sub-ticket tree): the `(ID)` suffix of a stored assignee must equal this id — a namesake with another id is not you. |
| `email` | Informational, plus an exact match against the assignee's `emailAddress`. |

## `endpoints` — your company's servers
`jiraBase`, `confluenceBase`, `bitbucketBase` — base URLs, no trailing slash. Injected into
every prompt (`{{JIRA_BASE}}` etc.), so ticket/PR links and JQL all point at YOUR instances.
Env `JIRA_URL` / `CONFLUENCE_URL` / `BITBUCKET_URL` override them for one run or one container.

Optional evidence sources for PR-readiness proof (each disabled while empty). Checkmarx is read by the daily
fetch (`jira-intern/checkmarx.py` → `Ticket.vulnFixes`, vulnerability-fix tickets only) and by the AI worker
through the same module; Dynatrace only by the worker:

| key | meaning |
|---|---|
| `checkmarxBase` | Checkmarx One tenant base URL (https), e.g. `https://your-tenant.cxone.cloud`; leave empty to disable the Checkmarx lookup. Env `CHECKMARX_BASE_URL` (canonical; `CHECKMARX_URL` also accepted) overrides. |
| `checkmarxAuthUrl` | Full Checkmarx One token endpoint; leave empty to derive from `checkmarxBase`. Only needed when the IAM host differs from the API host. Env `CHECKMARX_AUTH_URL` overrides. |
| `dynatraceTenants` | Dynatrace tenant ids per environment, e.g. `{"prod": "abc12345", "uat": "", "dev": ""}`; leave empty to disable the Dynatrace proof lookup. Env `DYNATRACE_TENANTS` overrides — a JSON object or the shorthand `prod=abc12345,uat=def67890`. |

Python reads these through `_config.proof_endpoints(intern_dir)` →
`{"checkmarxBase", "checkmarxAuthUrl", "dynatraceTenants"}` (empty ids are dropped).

## `excludeProjects`
Project keys to DROP from the board AND the completed archive entirely — even if a ticket was
once assigned to you. The daily fetch and the weekly archive both honour this list.

## `bitbucket` — key-scan hints (optional)
Jira's dev-status index is the source of truth for branches and PRs in any repository. When
the Jira↔Bitbucket link is down, the daily fetch can fall back to scanning Bitbucket pull
requests for the ticket key — but only for projects you list here. Both maps are keyed by
**Jira project key**:

```json
"bitbucket": {
  "projectMap": { "PROJ": "BBPROJ" },
  "repoHints":  { "PROJ": ["service-api", "service-ui"] }
}
```
`projectMap` → the Bitbucket project that holds the repos; `repoHints` → which repos to scan
(up to repos × 3 listings per ticket). A project missing from either map is never scanned.
Both default to `{}` — there is no built-in project or repository name anywhere in the code.

## `jenkins` — multibranch build jobs (optional)
The board reads the **latest build of each of your tickets' branches** from Jenkins multibranch
pipelines, one job per repository and environment (`jira-intern/jenkins.py`). Keyed by
**repository slug** (as in the Bitbucket URL), then by environment name — any names you like,
shown in the order you write them:

```json
"jenkins": {
  "jobs": {
    "payments-service": {
      "qa":  "https://jenkins.example.com/job/team/job/payments-service-qa/",
      "uat": "https://jenkins.example.com/job/team/job/payments-service-uat/"
    }
  }
}
```
Each URL is the **multibranch job itself** (the page listing one child job per branch), not a
branch or a build, and must be **https** — an `http://` URL is skipped with a WARN (the API token is
sent with every call). TLS to Jenkins is always verified (`JIRA_INSECURE_TLS` does not apply; see
`JENKINS_INSECURE_TLS` below). The tracked config ships `"jobs": {}`; put real links in `~/.ai/config.json`
(deep-merged, so you only write the `jenkins` block). Credentials are `JENKINS_USER` +
`JENKINS_API_TOKEN` (key button → Jenkins, saved to `setup/.env`). With no jobs or no credentials
nothing is asked and builds already on the board are kept. Repos not listed here are never looked
up. Hosts come only from these URLs — the API keys dialog has no Jenkins URL.

## `connector` — which agent CLI provides the MCP servers
`active` selects the profile: `"cursor"` (default), `"codex"`, or `"claude"` — add your own
profile object with the same keys for any other CLI.

Per-profile keys:
| key | meaning |
|---|---|
| `bin` | CLI executable name on PATH. |
| `binFallbacks` | Extra absolute paths to try (supports `~`). |
| `promptFlag` | Flag/subcommand that takes the prompt (`-p` for cursor/claude, `exec` for codex). |
| `extraArgs` | Additional args. **Each arg must not contain spaces** (they are space-joined for the shell). |
| `modelFlag` | Flag that selects a model (`--model`). |
| `apiKeyEnv` | Env var the CLI needs for headless auth (warned about when empty). Its value comes from `setup/.env` (the board's API keys dialog), like every other token. |
| `install` | One-liner shown when the CLI is missing. |

The MCP **servers themselves** (jira/confluence/bitbucket) are configured in the connector's
own config (e.g. `~/.cursor/mcp.json`) — this file decides which of them the agent MAY use.

## `mcp` — allow-list + read/write policy per MCP server
```json
"jira": { "enabled": true, "read": true, "write": false }
```
- `enabled: false` → the server is FORBIDDEN (the generated policy tells the agent not to call it).
- `read: true, write: false` → READ-ONLY: query/fetch, but never create/update/delete/
  transition/comment/push on that system.
- `write: true` → write operations are also allowed when a task requires them.
- `read: false, write: false` → treated as FORBIDDEN (nothing is permitted).
- `read: false, write: true` → WRITE-ONLY (may create/update, told not to browse).

This map is rendered into the `{{MCP_POLICY}}` block of every prompt (daily, weekly,
per-ticket refresh), so tightening/loosening permissions is a config-only change.

### Prompt tokens (rendered by `config.mjs render`)
`{{USER_NAME}} {{USER_ID}} {{USER_EMAIL}} {{JIRA_BASE}} {{CONFLUENCE_BASE}} {{BITBUCKET_BASE}}
{{REQUIRED_APPROVALS}} {{MCP_POLICY}} {{INTERN_DIR}}` — the last one is machine-derived (the
absolute path of this folder), so the prompts are path-portable with zero configuration.

## `models`
| key | meaning |
|---|---|
| `summary` | Ignored — nothing reads it any more. Still accepted so older personal configs keep validating; safe to delete from yours. |
| `main` | Model for the daily/weekly/refresh runs. `"auto"` = let the connector pick (no flag passed). Env `MODEL=` overrides per run. |

## `ai`
Defaults for Settings and the intern worker: `level`, `backend`, local/cloud models,
`cloudProvider`, `cloudEffort` (low / medium / high / auto), `useHostOllama`, and `parallel` (1–10, PR reports built at once). Saved choices
in `jira-intern/.settings.json` override these defaults. The local model catalog remains
`ai-intern/models.json`; `models.catalog` points to it. The **cloud** model list — models, efforts, what counts as
costly — is `ai-intern/cloud-models.json`, not this file (see CONTRIBUTING → Add a model).

## `reports` — PR Readiness Reports
| key | meaning |
|---|---|
| `autoGenerate` | `true` (default): after every fetch / single-ticket refresh, (re)generate the report of any ticket whose PR appeared or changed — in the background, never delaying the fetch. `false` turns the automation off (the drawer button still works). |
| `year` | Which tickets the automatic pass and `pr-reports-backfill.sh` consider (by created/resolved year). Default `2026`. |
| `maxPerRun` | Cap per automatic pass so a backlog never runs for hours. Default `5`. Manual backfills are uncapped unless `--max` is given. |

Models: `models.report` picks the connector-agent model (`"auto"` = connector default; env
`REPORT_MODEL=` overrides). `timeouts.reportSec` (default 600) bounds one enrichment run.
Settings AI usage **None** skips report AI; otherwise enrichment is queued for the AI-Intern container.
Reports are written to `jira-intern/reports/` — git-ignored; they contain real ticket and PR content.

`defaultWindowDays` and `presetWindowDays` control the report menu's custom-date default and
quick ranges.

## `archive`
`maxFetch`, `workers`, `defaultWindowDays`, and `presetWindowDays` control archive rebuild
capacity and the archive menu.

## `refresh`
`onStart` fetches active tickets once when the container starts. `REFRESH_ON_START` overrides it.
Repeat runs are `schedule`, not a fixed interval.
`workers` (1–16, default 8) is how many tickets and sub-tasks the dashboard refresh builds at once.
Settings → Parallel refresh overrides it; `REFRESH_WORKERS` does too for a direct `daily_fetch.py` run.

## `schedule`
Defaults for Settings → Jobs. A choice saved in the app wins over this file.

| key | values | meaning |
|---|---|---|
| `activeRefresh` | `off`, `daily`, `twice-daily` | Fetch tickets still in flight. |
| `fullRefresh` | `off`, `daily`, `weekly`, `twice-weekly` | Active tickets, then the Completed archive. |
| `reportRefresh` | `off`, `daily`, `weekly`, `twice-weekly` | PR reports that are missing, stale, or under 100. |

## `timeouts` (seconds)
`dailySec` (default 1800), `weeklySec` (7200, env `TIMEOUT_SEC` overrides), `refreshSec` (600).

## Environment variables read by the Python fetch scripts
Set these in the shell, the Docker environment, or `setup/.env` (loaded by `load_env()` before the
first request; a variable already in the environment wins). Tokens and the three base URLs can be
saved from the board's API keys dialog. Config keys they override are in brackets.

| variable | meaning |
|---|---|
| `JIRA_PERSONAL_TOKEN` | Jira PAT (required). `BITBUCKET_PAT` (or the Atlassian Cloud `ATLASSIAN_TOKEN`) for Bitbucket; `CHECKMARX_API_KEY` for Checkmarx One; `JENKINS_USER` + `JENKINS_API_TOKEN` (HTTP basic) for Jenkins builds [`jenkins.jobs`]. All are entered with the key button. |
| `JIRA_CA_BUNDLE` | Path to your corporate root-CA bundle (PEM). TLS verification is **on** by default; an on-prem Jira/Bitbucket behind a private CA fails with a certificate error until it is trusted. The bundle is **added** to the system roots (a public-CDN Jira keeps working). Unset, `~/.ai/ca-bundle.pem` is used when it exists — the easiest route, because both containers already mount `~/.ai` (see [SETUP.md](SETUP.md#step-6--trust-your-companys-certificate-authority-optional)). |
| `JIRA_INSECURE_TLS` | `1` disables TLS verification for Jira and Bitbucket — **last resort only**: the bearer PAT then travels over an unverified channel. Every run announces it with `WARN: TLS verification disabled (JIRA_INSECURE_TLS=1)` on stderr. Prefer `JIRA_CA_BUNDLE`. |
| `JENKINS_INSECURE_TLS` | `1` disables TLS verification for Jenkins only — Jenkins' own **last resort**, separate from `JIRA_INSECURE_TLS` (which never applies to it). Announced with a WARN on every run. Prefer the CA bundle (`JIRA_CA_BUNDLE` / `~/.ai/ca-bundle.pem`), which Jenkins honours too. Passed through by `docker-compose.yml` and `runner-env.sh` like `JIRA_INSECURE_TLS`. |
| `JIRA_URL` / `CONFLUENCE_URL` / `BITBUCKET_URL` | Override `endpoints.*Base` for one run or container. |
| `CHECKMARX_BASE_URL` (or `CHECKMARX_URL`), `CHECKMARX_AUTH_URL`, `DYNATRACE_TENANTS` | Override the optional proof endpoints — see `endpoints` above. |
| `AI_CONFIG_FILE` | Path of the personal override instead of `~/.ai/config.json`. |
| `JB_SECRETS_FILE` | Path of the secrets env file instead of `setup/.env` (tests, unusual layouts). The server, runners, entrypoint and worker all honour it. |
| `REFRESH_WORKERS` | Parallel ticket builds in `daily_fetch.py` (1–16) [`refresh.workers`, Settings → Parallel refresh]. |
| `COMPLETED_WORKERS` | Parallel ticket builds in `completed_archive.py` [`archive.workers`, Settings]. |
| `COMPLETED_MAX_FETCH` | Max tickets rebuilt per archive run; the rest stay as cached [`archive.maxFetch`]. |
| `ARCHIVE_SCOPE` | `all` (default) rebuilds the whole archive; `year`, `since` or `key` rebuild a slice and leave other rows untouched. |
| `ARCHIVE_YEAR` / `ARCHIVE_SINCE` / `ARCHIVE_KEY` | The slice for `ARCHIVE_SCOPE`: a `YYYY` year, a `YYYY-MM-DD` lower bound, or one issue key (`PROJ-123`). An invalid value falls back to `all`. |
| `REFRESH_ON_START` | Fetch active tickets when the container starts [`refresh.onStart`]. |
| `TIMEOUT_SEC` | Ceiling for the weekly archive run [`timeouts.weeklySec`]. |

Writers of `data.json` / `data.js` (`daily_fetch.py`, `completed_archive.py`, single-ticket
refresh) also take an advisory `flock` on `jira-intern/.data.lock`, so runs started from
different containers or launchers never interleave a read-modify-write.

## `app` — UI/runtime settings (picked up without a rebuild)
| key | meaning |
|---|---|
| `servePort` | Port for `npm run serve` (env `PORT` overrides). |
| `requiredApprovals` | How many PR approvals count as "approved" (badge + pips). |
| `timeZone` | IANA timezone used for report generation, enrichment, UI, PDF timestamps and the day stamps in `notes[]` / `updateLog`. |
| `doneBoardDays` | Days a newly Done ticket remains on the active board (default 5; the fetch keeps done tickets for 10 days so none drops out before the archive has it). |
| `polling` | Status poll intervals: `aiIdleMs` idle, `reportsBusyMs` while work is in flight, `aiBusyMs` during a model download. |
| `progress` | Header progress phase percentages. |
| `settingsDefaults` | Appearance, notification time and count, and feature defaults before saved browser choices. |
| `branding.tagline` | Left footer text. |
| `branding.badgeText` / `badgeUrl` / `badgeTitle` | The footer "made by" badge — put your own name/portfolio here. |

> The `app` section reaches the built app through `data.js` (`window.__JIRA_CONFIG__`), which
> is regenerated by every runner — so after editing it, run any intern job (or
> `node local-runner/sync-datajs.mjs .` from this folder) to see it in the UI.

---

## Porting checklist (new user)
0. `mkdir -p ~/.ai && cp setup/config.example.json ~/.ai/config.json` — optional sparse
   personal override, outside the repo.
1. Edit `~/.ai/config.json`: your `user`, your `endpoints`, your `connector.active`, your
   `app.branding`. Tokens and API keys go in through the board's key button (→ `setup/.env`).
2. Make sure your connector CLI has the three MCP servers (jira / confluence / bitbucket)
   configured (e.g. `~/.cursor/mcp.json` for cursor).
3. `bash local-runner/run-intern.sh` → daily data; `bash local-runner/update-completed.sh` →
   full archive; open `dist/index.html`.
