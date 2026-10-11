# Setup — secrets, config & MCP

Everything user-, company- and token-specific lives **outside** the app bundle. The repo's
`setup/` folder holds the list of API keys the board knows (`api-keys.json`), the git-ignored file
your keys are saved in (`.env`), and a safe **template** for each file that lives elsewhere. Nothing
tracked contains a real token.

> **The golden rule:** the only file the board reads tokens from is **`setup/.env`**. You don't
> edit it by hand — the **key button in the board header** writes it. It is git-ignored,
> docker-ignored and never served over HTTP. (`JB_SECRETS_FILE` moves it, for tests or unusual layouts.)

| File in `setup/` | Where it goes | What it is |
|---|---|---|
| `.env` (created by the board) | stays in `setup/` — never committed | Your API tokens (Jira required; Bitbucket, Confluence, Cloud AI optional), saved from the API keys dialog. |
| [`api-keys.json`](../setup/api-keys.json) | tracked | THE list of keys: per service the env names, why it's needed, what uses it, where to get it. |
| [`mcp-secrets.env.template`](../setup/mcp-secrets.env.template) | `~/.cursor/mcp-secrets.env` | Tokens for your **IDE's** MCP servers / the wrapper below (optional — the board does not read it). |
| [`config.example.json`](../setup/config.example.json) | `~/.ai/config.json` | Who you are + your company URLs + preferences. **No tokens.** Lives outside the repo. |
| [`mcp.cursor.json.template`](../setup/mcp.cursor.json.template) | `~/.cursor/mcp.json` | MCP servers for Cursor (optional — richer AI briefs). |
| [`mcp.claude.json.template`](../setup/mcp.claude.json.template) | `~/.claude/.claude.json` | MCP servers for Claude Code (optional). |
| [`mcp-with-secrets.sh.template`](../setup/mcp-with-secrets.sh.template) | `~/.local/bin/mcp-with-secrets.sh` | Wrapper that keeps tokens out of the MCP JSON. |
| [`Start Jira Board.command.template`](../setup/Start%20Jira%20Board.command.template) | `~/Desktop/Start Jira Board.command` | macOS double-click launcher. |

---

## What you actually need

The board has **two moving parts**, and they need different things:

1. **The fetch** (`jira-intern/`) — pulls your tickets. Needs **one Jira token**. That's the
   only hard requirement. Confluence and Bitbucket tokens are optional and just add richer
   detail (linked docs, real branches, PR state).
2. **The app** (`src/` → `dist/index.html`) — renders whatever the fetch dumped. Needs **nothing**.

MCP servers are **optional**. Ticket briefs and report enrichment run in **JIRA-AI-Intern**
(local Ollama or a cloud API), so the fetch does not block on an LLM.

---

## Step 1 — Add your API keys (required: the Jira token)

Start the board (Docker — [`DEPLOYMENT.md`](DEPLOYMENT.md) — or `npm run serve`) and open it. A new
install has no data yet, so it shows **Add API keys first**; otherwise use the **key button** in the
header (it carries an amber dot while the Jira token is missing). Expand **Jira**, paste the token,
**Save**. Then **Refresh**.

**Where the Jira token comes from:** Jira → your avatar → **Profile** → **Personal Access
Tokens** → **Create token**. Copy it immediately (you can't see it again). Read scope is enough.

Optional, for richer cards: Bitbucket (`BITBUCKET_PAT`) for real branches and PR state; Claude /
Cursor / Gemini keys for Cloud AI. Each row in the dialog says why it's needed and where to get
it. A key works from the next fetch or AI call — no restart. The optional base-URL fields override
`endpoints.*` from the config.

Without the board (a host-only run, no server)? Create `setup/.env` yourself with `KEY=value`
lines (`chmod 600`); the names are the `env` fields in `setup/api-keys.json`. Variables already set
in the environment win over the file.

## Step 2 — Create a personal override (required for real identity/URLs)

Complete non-secret defaults live in `config/jira-board.config.json`. Your sparse override
holds only identity, company URLs, and personal branding outside git:

```bash
mkdir -p ~/.ai
cp setup/config.example.json ~/.ai/config.json
chmod 600 ~/.ai/config.json
```

Edit `~/.ai/config.json` and set your `user` (name **exactly** as Jira shows it, so
"assigned to me" matches), your `endpoints` (company URLs), and the `app.branding` footer.
Full reference for every key: [`CONFIG.md`](CONFIG.md).

The project config is loaded first. `$AI_CONFIG_FILE` or `~/.ai/config.json` is then
deep-merged over it, and saved Settings AI choices are the final runtime overlay.

Confirm what's actually in effect:

```bash
node jira-intern/local-runner/config.mjs path
```

> Docker mounts `~/.ai/config.json` read-only into the container, so it resolves the same way
> there. Create the file **before** your first `docker compose up` — if the path is missing,
> Docker creates a stray directory in its place.

## Step 3 — Configure MCP servers (optional)

Only if you want the **agent fallback** (or your IDE) to read Jira/Confluence/Bitbucket through MCP.
These servers belong to your IDE / agent CLI and keep their tokens in their own env file
(`~/.cursor/mcp-secrets.env`, from [`mcp-secrets.env.template`](../setup/mcp-secrets.env.template)) —
separate from the board's `setup/.env`. Pick the client you use:

- **Cursor:** merge [`mcp.cursor.json.template`](../setup/mcp.cursor.json.template) into `~/.cursor/mcp.json`.
- **Claude Code / Desktop:** merge [`mcp.claude.json.template`](../setup/mcp.claude.json.template) into
  `~/.claude/.claude.json`, and install the wrapper so tokens stay out of that JSON:
  ```bash
  cp setup/mcp-with-secrets.sh.template ~/.local/bin/mcp-with-secrets.sh
  chmod +x ~/.local/bin/mcp-with-secrets.sh
  ```

The Atlassian MCP server used above is the community [`mcp-atlassian`](https://pypi.org/project/mcp-atlassian/)
(`pipx install mcp-atlassian`). Point each server's URL at your host; drop the `*_SSL_VERIFY=false`
lines unless your company uses a private/internal certificate authority.

## Step 4 — Set the connector API key (optional)

The agent fallback runs through an agent CLI (`config.json → connector.active`, default
`cursor`). Add its key in the API keys dialog — Cursor (`CURSOR_API_KEY`), Claude
(`ANTHROPIC_API_KEY`) for `claude`, or OpenAI (`OPENAI_API_KEY`) for `codex`. Not needed for Docker deployment.

## Step 5 — The Desktop launcher (optional, macOS)

```bash
cp "setup/Start Jira Board.command.template" ~/Desktop/"Start Jira Board.command"
# edit REPO_DIR inside it to your clone path, then:
chmod +x ~/Desktop/"Start Jira Board.command"
```

Double-click it to build + deploy in Docker and open the board. See
[`DEPLOYMENT.md`](DEPLOYMENT.md) for all the ways to run it.

---

## Step 6 — Trust your company's certificate authority (optional)

If your Bitbucket (or Jira) uses a certificate from a private company CA, every Bitbucket call fails
inside Docker with `CERTIFICATE_VERIFY_FAILED` and the board silently falls back to what Jira's
index says — stale branch names, no review state from Bitbucket, no newest-branch ranking. Fix it
once by putting the CA in `~/.ai/ca-bundle.pem`; both containers mount `~/.ai`, and the bundle is
added to (not swapped for) the public roots.

```bash
# macOS — company roots are normally installed in the System keychain by IT
security find-certificate -a -p /Library/Keychains/System.keychain > ~/.ai/ca-bundle.pem
```

On Linux/Windows ask IT for the root CA as PEM and save it to the same path. Then redeploy
(`bash start-jira-board.sh`) and refresh: the run summary shows `bb_ok: true`.

A host that cannot even **resolve** the Bitbucket name (off VPN, or Docker's DNS proxy flapping) is
a network problem, not a certificate one — reconnect the VPN, or uncomment the `dns:` block in
`docker-compose.yml`.

## Before you make the repo public

This repo is safe to push **as long as your real secrets never enter it** — they don't, by
design (tokens live only in `setup/.env`, which is git-ignored and docker-ignored). Two things to
double-check first:

1. **No secrets file staged.** `git status` should never show `setup/.env` or any `*.env`
   with real values. The root `.gitignore` already blocks these; `.dockerignore` keeps them out of
   the image (`**/.env` rules — a bare `.env` there matches only the root).
2. **Keep `config/jira-board.config.json` generic.** It is intentionally tracked and must
   contain placeholders/defaults only. Real identity and internal URLs belong in the
   untracked `~/.ai/config.json` override.

A quick pre-push scan for anything token-shaped:

```bash
git grep -niE '(personal_token|api[_-]?key|pat|secret)\s*[=:]\s*[A-Za-z0-9]{12,}' -- . ':!setup' ':!*.md'
```
