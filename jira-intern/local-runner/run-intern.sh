#!/usr/bin/env bash
# JIRA Intern — Mac local runner via the Cursor CLI (cursor-agent).
# Uses the MODELS and MCP SERVERS you already have configured in Cursor (~/.cursor/mcp.json):
# jira, confluence, bitbucket, etc. Auth + tokens come from setup/.env (the board's API keys) at runtime —
# nothing is stored or read by this repo.
#
# Trigger from a Mac Shortcut ("Run Shell Script") or any scheduler:
#     bash /path/to/AI-JIRA-Board/jira-intern/local-runner/run-intern.sh
# Optional model override:  MODEL="auto" bash run-intern.sh
set -o pipefail

# shellcheck source=runner-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/runner-env.sh"
load_agent_secrets
PROMPT_FILE="$HERE/../prompts/intern-prompt.md"
LOG="$LOG_DIR/run-$(date +%Y%m%d-%H%M%S).log"
# NOTE: this DAILY run handles ACTIVE tickets only and preserves the existing completed[]. The per-ticket
# cache + the historical archive are owned by the separate weekly job local-runner/update-completed.sh
# (run `FRESH=1 bash update-completed.sh` to rebuild the archive).

# Run-lock so the board (served mode) can tell whether the intern is running, even across page
# refreshes and regardless of who launched it (button or terminal). Removed on any exit.
LOCK="$INTERN_DIR/.intern.lock"
refuse_if_locked "this daily run" "$LOCK" "$INTERN_DIR/.completed.lock" "$INTERN_DIR/.refresh.lock"
acquire_lock_or_exit "this daily run" "$LOCK"
# INT/TERM exit explicitly (130/143) so an interrupted fast path never falls through to the
# LLM fallback; the EXIT trap then removes the lock.
trap 'rm -f "$LOCK"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# The agent CLI is located LATER — only inside the fallback, if the fast path fails. The
# deterministic daily_fetch.py is the PRIMARY path and needs no agent, so a machine without
# cursor-agent (e.g. the Docker image) must still run the fast path instead of exiting here.
cd "$GIT_ROOT"   # run from git/ so the agent (fallback) can read your repos AND the MCP config
echo "$(date): starting jira-intern daily run (connector=$AGENT_CONNECTOR, cwd=$GIT_ROOT)" | tee -a "$LOG"

# Snapshot data.json so we can deterministically carry `aiSummary` forward after the rewrite
# (the agent re-fetches tickets and may drop it; this restores it by key regardless).
PREV_DATA="$INTERN_DIR/.data.prev.json"
[ -f "$INTERN_DIR/data.json" ] && cp "$INTERN_DIR/data.json" "$PREV_DATA" 2>/dev/null

# ── FAST PATH ─────────────────────────────────────────────────────────────────
# The deterministic fetch (daily_fetch.py) implements the same contract as the LLM
# agent but finishes in seconds instead of minutes. It is the PRIMARY path; the
# agent below is the fallback for when the script fails (auth, Jira quirks, drift).
# Debug the agent path with FORCE_AGENT=1.
FAST_OK=""
# daily_fetch.py reads this from its environment; shellenv only assigns it.
export REFRESH_WORKERS
if [ -z "$FORCE_AGENT" ] && command -v python3 >/dev/null 2>&1 && [ -f "$INTERN_DIR/daily_fetch.py" ]; then
  echo "$(date): fast path — deterministic daily_fetch.py (LLM agent is the fallback)…" | tee -a "$LOG"
  run_with_timeout 300 python3 "$INTERN_DIR/daily_fetch.py" >> "$LOG" 2>&1
  fast_code=$?
  if [ "$fast_code" = "0" ]; then
    FAST_OK=1
    code=0
    echo "$(date): fast path OK — skipping the agent run" | tee -a "$LOG"
  elif [ "$fast_code" = "2" ]; then
    # Configuration error (no Jira token): the agent's MCP servers need the same token, so a
    # fallback would only burn 30 minutes. Surface it instead.
    FAST_OK=1
    code=2
    echo "$(date): fast path refused (exit 2: configuration — no Jira token?) — not falling back" | tee -a "$LOG"
  else
    echo "$(date): fast path failed (exit $fast_code) — falling back to the $AGENT_CONNECTOR agent" | tee -a "$LOG"
  fi
fi

if [ "$FAST_OK" != "1" ]; then
# The fast path failed — NOW we need the LLM agent. Locate it (config: connector.<name>.bin /
# binFallbacks). If it isn't installed there's nothing more we can do, so fail with 127.
if ! find_agent; then
  echo "$(date): fast path failed and $AGENT_BIN not found (connector: $AGENT_CONNECTOR). Install:  $AGENT_INSTALL_HINT" | tee -a "$LOG"
  exit 127
fi
if [ -n "$AGENT_API_KEY_ENV" ] && [ -z "${!AGENT_API_KEY_ENV}" ]; then
  echo "$(date): WARNING: $AGENT_API_KEY_ENV is empty after reading $APP_SECRETS." | tee -a "$LOG"
  echo "$(date):   -> add it in the board's API keys dialog (key button in the header), or log the $AGENT_CONNECTOR CLI in once." | tee -a "$LOG"
fi
echo "$(date): falling back to $AGENT (connector=$AGENT_CONNECTOR)" | tee -a "$LOG"
# Render the prompt: {{TOKENS}} (user id, endpoints, MCP allow/read-write policy) come from config.json.
PROMPT_TEXT="$(node "$HERE/config.mjs" render "$PROMPT_FILE" 2>>"$LOG" || cat "$PROMPT_FILE")"
# NEVER launch with an unrendered prompt (node/config.mjs unavailable): the agent would run for
# up to 30m with no identity and — worse — no MCP read-only policy. Fail loud instead.
if printf '%s' "$PROMPT_TEXT" | grep -q '{{'; then
  echo "$(date): prompt render failed (node/config.mjs unavailable?) — refusing to run with unrendered prompt" | tee -a "$LOG"
  rm -f "$PREV_DATA"
  exit 6
fi

agent_command "$PROMPT_TEXT"
run_with_timeout "$TIMEOUT_DAILY" "${RUN[@]}" >> "$LOG" 2>&1
code=$?
[ "$code" = "124" ] && echo "$(date): TIMED OUT after ${TIMEOUT_DAILY}s (headless agent runs can hang)" | tee -a "$LOG"
fi

# Crash-safety: a timed-out/killed agent can leave data.json truncated or invalid. If it no longer
# parses, restore the pre-run snapshot (the only known-good copy) BEFORE we touch data.js — otherwise
# a bad run permanently corrupts the canonical file.
if [ -f "$PREV_DATA" ] && command -v node >/dev/null 2>&1; then
  if [ ! -f "$INTERN_DIR/data.json" ] || ! node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$INTERN_DIR/data.json" 2>/dev/null; then
    echo "$(date): data.json missing/invalid after run — restoring pre-run snapshot" | tee -a "$LOG"
    cp "$PREV_DATA" "$INTERN_DIR/data.json"
  fi
fi

# Deterministically carry aiSummary forward from the pre-run snapshot (independent of the agent),
# then drop the snapshot. Runs regardless of exit code so summaries survive a failed/timed-out run.
if [ -f "$PREV_DATA" ] && [ -f "$INTERN_DIR/data.json" ] && command -v node >/dev/null 2>&1; then
  node "$HERE/carry-aisummary.mjs" "$PREV_DATA" "$INTERN_DIR/data.json" >>"$LOG" 2>&1 || true
fi
rm -f "$PREV_DATA"

# Log rotation — keep the most recent 40 run logs so logs/ doesn't grow forever.
rotate_logs run 40

sync_datajs

# PR Readiness Reports (best-effort, BACKGROUND): for every ticket whose PR appeared or changed since
# its last report, (re)generate jira-intern/reports/<KEY>.json. Detached with nohup so a slow agent
# never delays this run; the board shows "report in progress" from reports/.status.json meanwhile.
# Off with config.json → reports.autoGenerate=false (REPORTS_AUTO=0). Capped by reports.maxPerRun.
if [ "$code" = "0" ] && [ "${REPORTS_AUTO:-1}" != "0" ] && [ -f "$HERE/pr-reports-backfill.sh" ]; then
  echo "$(date): launching PR readiness report pass in the background…" | tee -a "$LOG"
  nohup bash "$HERE/pr-reports-backfill.sh" --auto >>"$LOG_DIR/reports-auto.log" 2>&1 &
fi

# AI-summary pass: enqueue for JIRA-AI-Intern (never blocks this fetch). The intern
# skips the job when Settings AI usage is None. SKIP_SUMMARY no longer gates this —
# it only means the fetch container itself does not invoke an LLM.
NEED_SUMMARY=1
if command -v python3 >/dev/null 2>&1 && [ -f "$INTERN_DIR/data.json" ]; then
  NEED_SUMMARY="$(python3 -c '
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    stale = sum(1 for t in d.get("tickets", []) if (t.get("aiSummaryAt") or "") < (t.get("lastUpdate") or ""))
    print(1 if stale else 0)
except Exception:
    print(1)
' "$INTERN_DIR/data.json" 2>/dev/null || echo 1)"
fi
if [ "${AI_ENABLED:-1}" = "0" ]; then
  echo "$(date): AI is switched off in Settings — skipping the summary pass" | tee -a "$LOG"
elif [ "$code" = "0" ] && [ "$NEED_SUMMARY" = "1" ]; then
  echo "$(date): enqueueing AI-summary pass for JIRA-AI-Intern…" | tee -a "$LOG"
  python3 "$INTERN_DIR/ai_queue.py" enqueue --type summarize-active >>"$LOG" 2>&1 \
    || echo "$(date): could not enqueue summary job (ignored)" | tee -a "$LOG"
elif [ "$code" = "0" ] && [ "$NEED_SUMMARY" = "0" ]; then
  echo "$(date): AI summaries all current — skipping the summary pass" | tee -a "$LOG"
fi

echo "$(date): finished (exit $code) — log: $LOG" >> "$LOG"

# --- Final one-line result for Mac Shortcuts ---------------------------------
# `run-intern.sh | tail -n 1` feeds this single line into the Shortcut
# notification, so it MUST be the last thing written to stdout.
case "$code" in
  0)   RESULT="✅ JIRA Intern done" ;;
  124) RESULT="⏱️ JIRA Intern timed out ($((TIMEOUT_DAILY / 60))m)" ;;
  127) RESULT="⚠️ JIRA Intern: agent CLI not found" ;;
  2)   RESULT="⚠️ JIRA Intern skipped: no Jira token configured (see setup/)" ;;
  *)   RESULT="❌ JIRA Intern failed (exit $code)" ;;
esac

# Append brief counts when data.json is available (best-effort, never fails the run).
if [ -f "$INTERN_DIR/data.json" ] && command -v node >/dev/null 2>&1; then
  COUNTS="$(node -e 'try{const d=require(process.argv[1]+"/data.json");const t=Array.isArray(d.tickets)?d.tickets.length:0;const c=Array.isArray(d.completed)?d.completed.length:0;process.stdout.write(" — "+t+" tickets, "+c+" completed")}catch(e){}' "$INTERN_DIR" 2>/dev/null)"
  RESULT="$RESULT$COUNTS"
fi

echo "$(date): $RESULT" >> "$LOG"   # keep the summary in the log too
echo "$RESULT"                       # <-- LAST stdout line == Shortcut notification
exit "$code"
