#!/usr/bin/env bash
# Carry the board's RUNTIME data into a checkout that has none, so a deploy from a new folder does not come up empty.
#
#   seed-runtime-data.sh <from-repo> <to-repo>
#
# Why: compose bind-mounts ./jira-intern and ./setup, so the board's data lives in whichever checkout was deployed last
# (docs/DEPLOYMENT.md, "The data mount follows the deploy directory"). A git worktree, or a fresh clone, has none of it —
# data.json and the archive cache are git-ignored — and the board then serves nothing.
#
# Rules: it only acts when <to-repo> has no data.json; it never overwrites a file that exists there; it never copies a
# lock or a half-finished run (.*.lock, .progress.json, .data.prev.json), a log, a model store or a .bak. It prints names,
# never contents.
#
# API KEYS ARE NEVER COPIED. setup/.env holds credentials; duplicating it into another folder is the owner's decision, so
# when it is missing here but present there this script only says so and prints the one command to run (exit 0 either way).
set -u

FROM="${1:-}"
TO="${2:-}"
[ -n "$FROM" ] && [ -n "$TO" ] || { echo "usage: seed-runtime-data.sh <from-repo> <to-repo>" >&2; exit 2; }
FROM="$(cd "$FROM" 2>/dev/null && pwd)" || exit 0
TO="$(cd "$TO" 2>/dev/null && pwd)" || exit 0
[ "$FROM" = "$TO" ] && exit 0
[ -f "$FROM/jira-intern/data.json" ] || exit 0   # nothing worth carrying
[ -f "$TO/jira-intern/data.json" ] && exit 0     # this checkout has its own data: leave it alone

copied=()
copy() {  # copy <path relative to the repo> — a file or a directory; never replaces what is already there
  local rel="$1" src="$FROM/$1" dst="$TO/$1"
  [ -e "$src" ] || return 0
  mkdir -p "$(dirname "$dst")"
  if [ -d "$src" ]; then
    mkdir -p "$dst"
    cp -Rn "$src/." "$dst/" 2>/dev/null || true
  else
    [ -e "$dst" ] || cp -p "$src" "$dst" 2>/dev/null || return 0
  fi
  copied+=("$rel")
}

for f in data.json data.js .state.json .settings.json .schedule.json .pr_overrides.json _STATUS.md status.html; do
  copy "jira-intern/$f"
done
for d in cache reports tickets assets .health; do
  copy "jira-intern/$d"
done

if [ "${#copied[@]}" -gt 0 ]; then
  printf '   ✓ Carried your board data over from %s:\n' "$FROM"
  printf '       %s\n' "${copied[@]}"
fi
if [ -f "$FROM/setup/.env" ] && [ ! -e "$TO/setup/.env" ]; then
  printf '   ! Your API keys (setup/.env) are NOT copied automatically. Without them every refresh stops at\n'
  printf '     "No JIRA token". To use the same keys here, run:\n'
  printf '       cp -p "%s/setup/.env" "%s/setup/.env" && chmod 600 "%s/setup/.env"\n' "$FROM" "$TO" "$TO"
  printf '     (or add them again with the key button in the board header).\n'
fi
exit 0
