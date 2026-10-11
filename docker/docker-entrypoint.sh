#!/usr/bin/env bash
# Container entrypoint for My Jira Board.
#
# It brings the board up and keeps its data fresh on its own, so you never have to
# run the fetch by hand again:
#   1. seed an empty mounted volume from the image baseline (if needed)
#   2. check that a Jira token is reachable (mounted secrets file and/or -e/--env-file)
#   3. fetch once on start                    (REFRESH_ON_START=1, or config refresh.onStart)
#   4. hand repeat refreshes to the board server's scheduler (Settings → Jobs decides the
#      cadence; there is no fixed interval here)
#   5. serve the board in the foreground      (the in-app Refresh button also works)
set -u

APP_DIR="${APP_DIR:-/app}"
INTERN_DIR="$APP_DIR/jira-intern"
SEED_DIR="/opt/jira-intern-seed"

log() { echo "[entrypoint] $*"; }

# 1) Seed. If a volume was mounted over jira-intern and it's empty, restore the baked
#    scripts + starter data so the board isn't blank and the fetch scripts exist.
if [ ! -f "$INTERN_DIR/daily_fetch.py" ]; then
  log "jira-intern is empty — seeding from the image baseline"
  mkdir -p "$INTERN_DIR"
  if ! cp -a "$SEED_DIR/." "$INTERN_DIR/"; then
    log "ERROR: could not seed $INTERN_DIR from $SEED_DIR — is the bind mount writable by uid $(id -u)?"
    log "       (Linux hosts: sudo chown -R 1000:1000 ./jira-intern). Continuing with whatever is there."
  fi
fi

# 2) Secrets. The Python fetch scripts and the runner scripts load the secrets file
#    themselves (parsed, not sourced), and env vars passed with -e/--env-file win there
#    (load_env() uses setdefault). Nothing is exported into the Node server's
#    environment; this only checks whether a Jira token exists so the boot fetch can be
#    skipped with a clear message instead of a failed run.
SECRETS="${JB_SECRETS_FILE:-/app/setup/.env}"
have_token() {
  [ -n "${JIRA_PERSONAL_TOKEN:-}" ] && return 0
  [ -f "$SECRETS" ] && grep -qE '^(export[[:space:]]+)?JIRA_PERSONAL_TOKEN=[^[:space:]#]+' "$SECRETS"
}
if [ -f "$SECRETS" ]; then
  log "secrets file present at $SECRETS"
else
  log "no API keys yet at $SECRETS — open the board and add them with the key button (or pass JIRA_PERSONAL_TOKEN with -e)"
fi

config_get() {
  node "$INTERN_DIR/local-runner/config.mjs" get "$1" 2>/dev/null || true
}

# Explicit environment values win; otherwise use the central project config.
REFRESH_ON_START="${REFRESH_ON_START:-$(config_get refresh.onStart)}"
case "$REFRESH_ON_START" in true) REFRESH_ON_START=1 ;; false) REFRESH_ON_START=0 ;; esac
REFRESH_ON_START="${REFRESH_ON_START:-1}"

# Refresh the runtime UI config even when Jira is offline or startup fetch is disabled.
# This keeps branding, timezone, feature defaults, and polling policy aligned with config.
if ! node "$INTERN_DIR/local-runner/sync-datajs.mjs" "$INTERN_DIR"; then
  log "warning: could not refresh data.js runtime config; serving the last saved copy"
fi

# Locks left by a PREVIOUS container (its hostname is the old container id) are dead: every
# process of that container died with it. Clear them now so the boot fetch below is not
# refused for up to the lock ceiling. Locks from a host run (a Mac hostname) are left alone
# — the lock helpers judge those by age.
for lock in .intern.lock .completed.lock .refresh.lock .report.lock; do
  f="$INTERN_DIR/$lock"
  [ -f "$f" ] || continue
  owner="$(tr -d '\r' < "$f" | head -1 | awk '{print $3}')"
  if [ -n "$owner" ] && [ "$owner" != "${HOSTNAME:-}" ] && [[ "$owner" =~ ^[0-9a-f]{12}$ ]]; then
    log "removing $lock left by previous container $owner"
    rm -f "$f"
  fi
done

# Use the lock-aware runner (not raw daily_fetch.py). Writing `.intern.lock` with `$$`
# from this script is unsafe: after `exec node`, `$$` is the Node server PID, so a
# leftover lock looks "live" forever and wedges Refresh / Rebuild archive.
run_fetch() {
  if ! have_token; then
    log "no JIRA_PERSONAL_TOKEN found — skipping fetch; board serves last saved data"
    return 0
  fi
  local runner="$INTERN_DIR/local-runner/run-intern.sh"
  log "refreshing active tickets…"
  if [ -f "$runner" ]; then
    bash "$runner"
    code=$?
  else
    python3 "$INTERN_DIR/daily_fetch.py"
    code=$?
  fi
  if [ "$code" = "0" ]; then
    log "refresh done"
  elif [ "$code" = "3" ]; then
    log "refresh skipped — another job holds the data lock"
  else
    log "refresh failed (exit $code) — keeping the previous data"
  fi
}

# 3) Fetch once on boot. The server's scheduler (server/schedule.mjs) deliberately does NOT
#    run anything at start — it seeds its last-run stamps so a restart never repeats this
#    fetch — so this is the only boot-time run. Double-forked (subshell exits at once) so
#    the job is reparented to tini and reaped when done, instead of lingering as a zombie
#    child of the exec'd Node server. run-intern.sh takes .intern.lock, so a run already in
#    flight (host or button) makes this exit 3 instead of racing it.
if [ "$REFRESH_ON_START" != "0" ]; then
  ( run_fetch & )
fi

# 4) Repeat refreshes are owned by the board server, from Settings → Jobs (active,
#    full-board and PR-report cadences). There is no fixed interval in this script.
log "scheduled refreshes follow Settings (active, full board, PR reports)"

# 5) Serve the board. exec => the server is the signal target under tini.
log "serving the board on ${BIND_HOST:-0.0.0.0}:${PORT:-4321}"
exec node "$APP_DIR/server/serve.mjs"
