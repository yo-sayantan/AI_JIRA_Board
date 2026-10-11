#!/usr/bin/env bash
# Shared environment for the local-runner jobs. Source it, do not run it:
#   . "$(dirname "${BASH_SOURCE[0]}")/runner-env.sh"
#
# Launchd, Mac Shortcuts and the Docker entrypoint start with a minimal environment, so this
# restores a complete PATH, then loads the central config (config.mjs shellenv). The user's
# zsh profile is deliberately NOT sourced: it is zsh syntax, may be slow or interactive, and
# everything the runners need is on the PATH below.

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INTERN_DIR="$(cd "$HERE/.." && pwd)"
GIT_ROOT="$(cd "$HERE/../../.." && pwd)"
LOG_DIR="$INTERN_DIR/logs"; mkdir -p "$LOG_DIR"

# Fallbacks for a machine without node; config.mjs shellenv overrides every one of them.
AGENT_CONNECTOR=cursor; AGENT_BIN=cursor-agent; AGENT_BIN_FALLBACKS="$HOME/.local/bin/cursor-agent"
AGENT_PROMPT_FLAG='-p'; AGENT_EXTRA_ARGS='--output-format text --force'; AGENT_MODEL_FLAG='--model'
AGENT_API_KEY_ENV='CURSOR_API_KEY'
AGENT_INSTALL_HINT='curl https://cursor.com/install -fsS | bash'
MODEL_MAIN=auto; TIMEOUT_DAILY=1800; TIMEOUT_WEEKLY=7200; TIMEOUT_REFRESH=600; REQUIRED_APPROVALS=2
command -v node >/dev/null 2>&1 && eval "$(node "$HERE/config.mjs" shellenv 2>/dev/null)"

# The board's own secrets file (written by its API keys dialog): setup/.env at the repo root.
# The same path as jira-intern/_config.py secrets_path(); JB_SECRETS_FILE moves both.
APP_SECRETS="${JB_SECRETS_FILE:-$(cd "$INTERN_DIR/.." && pwd)/setup/.env}"

# coreutils timeout (Linux) or Homebrew gtimeout; empty on a stock Mac — see run_with_timeout.
TIMEOUT_BIN="$(command -v timeout || command -v gtimeout || true)"

# shellcheck source=lock-util.sh
. "$HERE/lock-util.sh"

# Read KEY=VALUE lines from a secrets file WITHOUT executing it, exporting only the named
# keys. Mirrors jira-intern/_config.py load_secrets(): blank lines and #-comments are
# skipped, a leading "export " and a trailing CR are dropped, one layer of surrounding
# quotes is removed. Values are taken literally — $(…), backticks and $VARS never expand,
# so a hostile or merely odd line in setup/.env cannot run code here.
#   export_secrets_from_file FILE KEY...
export_secrets_from_file() {
  local file="$1" line key value k
  shift
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    case "$line" in ''|'#'*) continue ;; esac
    case "$line" in *=*) ;; *) continue ;; esac
    key="${line%%=*}"
    value="${line#*=}"
    key="${key%"${key##*[![:space:]]}"}"
    [[ "$key" =~ ^export[[:space:]]+(.*)$ ]] && key="${BASH_REMATCH[1]}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    case "$value" in
      \"*\") value="${value#\"}"; value="${value%\"}" ;;
      \'*\') value="${value#\'}"; value="${value%\'}" ;;
    esac
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    for k in "$@"; do
      # A variable already in the environment wins (docker -e / env_file), like Python's setdefault.
      if [ "$k" = "$key" ]; then [ -n "${!key+x}" ] || export "$key=$value"; break; fi
    done
  done < "$file"
}

# Jira / Bitbucket / connector tokens, exported to child processes. Only the variables the
# fetch scripts and the agent CLI actually read leave the file (same list as the AI intern).
load_agent_secrets() {
  export_secrets_from_file "$APP_SECRETS" \
    JIRA_URL CONFLUENCE_URL BITBUCKET_URL \
    JIRA_PERSONAL_TOKEN CONFLUENCE_PERSONAL_TOKEN BITBUCKET_PAT ATLASSIAN_TOKEN \
    JIRA_CA_BUNDLE JIRA_INSECURE_TLS \
    ${AGENT_API_KEY_ENV:+"$AGENT_API_KEY_ENV"}
}

# Every data.json writer refuses to start while another one holds its lock (exit 3), so two
# jobs never interleave writes. Stale locks (dead PID, Docker recreate) are cleared first.
# Each runner lists its OWN lock here too, then takes it with acquire_lock_or_exit.
refuse_if_locked() {
  local what="$1" lock
  shift
  for lock in "$@"; do
    lock_clear_stale "$lock"
    if lock_is_held "$lock"; then
      echo "$(date): $(basename "$lock") held by another intern job — skipping $what" | tee -a "$LOG"
      exit 3
    fi
  done
}

# Take our own lock atomically (noclobber); exit 3 if a concurrent start beat us to it.
# The caller installs the EXIT trap that removes it.
acquire_lock_or_exit() {
  local what="$1" lock="$2"
  if ! lock_acquire "$lock"; then
    echo "$(date): $(basename "$lock") taken by a concurrent intern job — skipping $what" | tee -a "$LOG"
    exit 3
  fi
}

# `timeout SECS cmd…` with coreutils when present; on a stock Mac (no coreutils) perl's
# alarm stands in, keeping the exit codes the runners test for (124 on timeout). With
# neither, the command runs unbounded and we warn once.
run_with_timeout() {
  local secs="$1"
  shift
  if [ -n "$TIMEOUT_BIN" ]; then
    "$TIMEOUT_BIN" "$secs" "$@"
  elif command -v perl >/dev/null 2>&1; then
    perl -e '
      my $secs = shift @ARGV;
      my $pid = fork; defined $pid or exit 125;
      if (!$pid) { exec @ARGV; exit 127 }
      my $stop = sub { my $code = shift; kill "TERM", $pid; sleep 2; kill "KILL", $pid; waitpid($pid, 0); exit $code };
      $SIG{ALRM} = sub { $stop->(124) };
      $SIG{TERM} = sub { $stop->(143) };
      $SIG{INT}  = sub { $stop->(130) };
      alarm $secs;
      waitpid($pid, 0);
      my $st = $?;
      exit(($st & 127) ? 128 + ($st & 127) : ($st >> 8));
    ' "$secs" "$@"
  else
    if [ -z "${_TIMEOUT_WARNED:-}" ]; then
      echo "$(date): WARNING neither timeout/gtimeout nor perl found — running without a time limit" | tee -a "${LOG:-/dev/null}" >&2
      _TIMEOUT_WARNED=1
    fi
    "$@"
  fi
}

# Keep the newest <keep> logs matching logs/<prefix>-*.log; handles spaces in paths.
rotate_logs() {
  local prefix="$1" keep="$2" f
  ls -1t "$LOG_DIR/$prefix"-*.log 2>/dev/null | tail -n +"$((keep + 1))" | while IFS= read -r f; do
    rm -f -- "$f"
  done
}

# Sets AGENT to the connector CLI; returns 1 when it is not installed.
find_agent() {
  AGENT="$(command -v "$AGENT_BIN")"
  if [ -z "$AGENT" ]; then
    local fallbacks f
    IFS=':' read -r -a fallbacks <<< "$AGENT_BIN_FALLBACKS"
    for f in "${fallbacks[@]}"; do [ -x "$f" ] && AGENT="$f" && break; done
  fi
  [ -n "$AGENT" ]
}

# The agent command line for a prompt, with the model flag unless the model is "auto".
agent_command() {
  RUN=( "$AGENT" "$AGENT_PROMPT_FLAG" "$1" $AGENT_EXTRA_ARGS )
  local model="${MODEL:-$MODEL_MAIN}"
  [ -n "$model" ] && [ "$model" != "auto" ] && RUN+=( "$AGENT_MODEL_FLAG" "$model" )
}

# data.js must always match data.json; the board loads it directly on file://.
sync_datajs() {
  [ -f "$INTERN_DIR/data.json" ] && command -v node >/dev/null 2>&1 || return 0
  if node "$HERE/sync-datajs.mjs" "$INTERN_DIR" 2>>"$LOG"; then
    echo "$(date): regenerated data.js from data.json" | tee -a "$LOG"
  else
    echo "$(date): WARNING could not regenerate data.js (is data.json valid JSON?)" | tee -a "$LOG"
  fi
}
