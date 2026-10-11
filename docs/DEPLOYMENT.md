# Deployment & running

Three ways to run the board, easiest first. All of them assume you've done the one-time
[setup](SETUP.md) (a filled-in optional personal override at `~/.ai/config.json`; project
defaults are in `config/jira-board.config.json`). The Jira token is added in the board itself,
with the key button in the header — it is stored in `setup/.env`.

---

## Option A — Docker (recommended)

Self-contained: builds the app, runs the fetch on start, auto-refreshes every 15 minutes, and
serves the board. Nothing to install but Docker.

### One command

```bash
docker compose up -d --build
```

Then open **http://localhost:4321/dist/index.html**. First run: the empty board shows **Add API
keys first** — paste your Jira token there (or use the key button in the header), then **Refresh**.

### What that does

`docker-compose.yml` builds the board image and starts **JIRA-Board**, **JIRA-AI-Ollama**, and
**JIRA-AI-Intern**:

- Mounts `./setup` (the API keys, `setup/.env`) — read-write into JIRA-Board, because the API keys
  dialog writes it, and read-only into AI-Intern, which re-reads it on every cloud call. It is a
  **directory** mount: a save replaces the file (temp + rename) and a single-file bind would stay on
  the old inode. On a Linux host `./setup`, like `./jira-intern`, must be writable by uid 1000.
  Prefer environment variables? `env_file: setup/.env` or `-e JIRA_PERSONAL_TOKEN=…` still work and win
  over the file.
- Reads refresh startup/interval policy from `config/jira-board.config.json → refresh`
  (`REFRESH_ON_START` / `REFRESH_INTERVAL` can still override it).
- Persists data on the host via the `./jira-intern` volume; models on `jira-ai-models`.

### Everyday commands

```bash
docker compose logs -f            # watch fetch + server logs
docker compose down               # stop
docker compose up -d --build      # rebuild + redeploy after a code change
```

### Deploy pitfalls (read once, save hours)

- **Prefer `./scripts/start-jira-board.sh` over raw compose.** It builds `dist/` on the HOST and passes
  `--build-arg DIST_SOURCE=prebuilt`. Building inside the image needs `npm ci` over the Docker
  VM's network, which can silently skip optional native packages — TypeScript 7's platform
  binaries among them — and the build then dies with
  `Unable to resolve @typescript/typescript-linux-arm64`. The script falls back to the in-image
  build only when the host has no Node toolchain.
- **Never add `--pull`** to the image build: Docker Hub pulls can crawl from the VM, and the base
  image is already cached. If BuildKit hides a build error, rerun with
  `docker build --progress=plain .` to see the real message.
- **The data mount follows the deploy directory.** Compose bind-mounts `./jira-intern`, so your
  tickets live in whatever checkout you last deployed from. Before deploying from a NEW folder,
  copy `data.json`, `data.js`, `.state.json`, `cache/`, `reports/` (and the dot-settings files)
  across — `docker inspect JIRA-Board --format '{{range .Mounts}}{{.Source}}{{"\n"}}{{end}}'`
  shows where the current data is. Otherwise the board comes up empty until a full re-fetch.

> **After changing any code in `src/`** you must rebuild (`--build`) — the app is baked into the
> image at build time. Changing only *data* does not need a rebuild; the container refetches.

### macOS: the double-click launcher

`scripts/start-jira-board.sh` wraps all of this: it starts Docker if needed, frees the fixed port,
rebuilds, redeploys the same container on the same port, waits for health, and opens the board.
Clicking it repeatedly is always safe.

```bash
./scripts/start-jira-board.sh
```

To make it a Desktop shortcut, use [`setup/Start Jira Board.command.template`](../setup/Start%20Jira%20Board.command.template).

---

## Option B — Static file (no server at all)

The production build is a single self-contained `dist/index.html`. If a data dump already exists
(`jira-intern/data.js`), just open it:

```bash
open dist/index.html          # macOS — or double-click "scripts/Open Board.html"
```

It reads the last dump straight off `file://`. The header's **Reload** button (or press `r`)
re-reads the latest `data.js`. To refresh the *data*, run a fetch in a terminal
(`bash jira-intern/local-runner/run-intern.sh`) — you never rebuild the app to see new data.

To produce `dist/index.html` yourself:

```bash
npm install
npm run build                 # → dist/index.html (single file, JS/CSS inlined)
```

---

## Option C — Live local server

Turns the header button into a real **Refresh** that runs the fetch on your machine, shows a
spinner, and reloads when fresh data lands.

```bash
npm run serve                 # prints http://localhost:4321/dist/index.html
```

If a run is already going (even one you started in a terminal), the button reattaches to it;
refresh the page mid-run and it reconnects instead of looking idle.

---

## Refreshing the data by hand

```bash
bash jira-intern/local-runner/run-intern.sh        # active tickets (daily)
bash jira-intern/local-runner/update-completed.sh  # full Completed archive (weekly)
```

Both rewrite `jira-intern/data.json` + `data.js`; reload the board to see the result.

## PR Readiness Reports

Generated automatically in the background after each fetch (see `config/jira-board.config.json → reports`). By hand:

```bash
bash jira-intern/local-runner/pr-report.sh PROJ-290           # one ticket (base + AI enrichment)
bash jira-intern/local-runner/pr-reports-backfill.sh --year 2026    # every 2026 ticket that has a PR
bash jira-intern/local-runner/pr-reports-backfill.sh --no-ai        # deterministic only — fast, no agent
bash jira-intern/local-runner/pr-reports-backfill.sh --force        # rebuild even if current
```

Output: `jira-intern/reports/<KEY>.json` (+ `reports/index.js` for `file://`). **Git-ignored** — real
PR/Jira content never leaves the machine. Docker writes the deterministic base in JIRA-Board, then
enqueues enrichment for JIRA-AI-Intern when Settings is not None. Download a local model from
Settings, or `docker exec JIRA-AI-Ollama ollama pull qwen2.5-coder:7b`.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Board loads but is empty | No dump yet. Run a fetch (Option A refetches on boot; or run `run-intern.sh`). |
| "no JIRA_PERSONAL_TOKEN found — skipping fetch" / "no API keys yet" | No Jira token saved yet. Add it with the key button in the board header (stored in `setup/.env`), then Refresh. Check `./setup` is mounted (`docker inspect JIRA-Board`). |
| Saving a key fails ("could not write setup/.env") | `./setup` is not writable by the container's uid 1000 (Linux hosts): `sudo chown -R 1000 setup`. |
| No build chips / "Jenkins unreachable — builds carried forward" | Jenkins keys saved? `jenkins.jobs` set in `~/.ai/config.json`? The container must reach the Jenkins host (VPN, DNS, a private CA in `~/.ai/ca-bundle.pem`). See [`INTEGRATIONS.md`](INTEGRATIONS.md#jenkins-multibranch-pipelines-json-api). |
| "Checkmarx unreachable — vulnerability results carried forward" | Check `CHECKMARX_API_KEY` + `CHECKMARX_BASE_URL` (https), and `CHECKMARX_AUTH_URL` when the IAM host differs. Only vulnerability-fix tickets with a PR are asked. |
| Port 4321 in use | `scripts/start-jira-board.sh` frees it automatically; otherwise `docker compose down` or stop the process on that port. |
| `Name or service not known` for your Jira host | Docker DNS (common on VPN). Uncomment the `dns:` block in `docker-compose.yml` and recreate. |
| Container exits immediately | `docker logs JIRA-Board` — usually a bad token or unreachable host. |
| Changed `src/` but UI looks old | Rebuild the image: `docker compose up -d --build`. |
