"""What each outside proof source did in THIS fetch run — so a skip is never silent.

The fetch asks Checkmarx (and, next, Jenkins) about some tickets and not others, and when a source is not
configured, unreachable or out of call budget it asks nothing and carries the old answers forward. This module
is the bookkeeping that turns those quiet outcomes into ONE state and ONE human line per source per run:

    not-configured   no base URL / key (the line names the missing SETTINGS, never a value)
    no-candidates    configured, but no ticket qualified (the line says how many were skipped and why)
    read             N tickets looked up, M targets: fixed / open / not found / unknown
    unreachable | auth-failed | budget-exhausted   the lookups failed; the previous results were carried forward

A client reports per ticket — `skipped`, `looked`, `waiting` — and the run ends with `finish`, whose record goes to
`data.json → proofSources[source]` (src/types.ts::SourceStatus) and, via `noteworthy`, the run notes. The state
model deliberately lives beside, not inside, `_health.py`: health is the latest REAL call outcome per service (a
dot); this is the per-run account of what was done with it. Reason texts are scrubbed with `_health.scrub`.

Thread-safe (tickets are built in a pool). `reset(source)` is called by the client's own `reset_run`.
"""
import threading
from datetime import datetime, timezone

import _health

STATES = ("not-configured", "no-candidates", "read", "unreachable", "auth-failed", "budget-exhausted")
WAITING_STATES = ("not-configured", "unreachable", "auth-failed", "budget-exhausted")
# What a wait is blamed on when several differ: a rejected key matters more than a timeout.
PRIORITY = ("auth-failed", "unreachable", "budget-exhausted")
TARGET_STATUSES = ("fixed", "open", "not-found", "unknown")
MAX_KEYS = 25  # ticket keys kept in a record's `waiting`
SKIP_REASONS = {
    "no-plan": "without a pull request or known branch",
    "no-targets": "naming no CVE, query, CWE, result or package",
}
DEFAULT_REASON = {
    "auth-failed": "the API key was rejected",
    "unreachable": "the host could not be reached",
    "budget-exhausted": "the call budget for one fetch was used up",
}

_LOCK = threading.Lock()
_RUN = {}  # source → {"looked": {key: [target status]}, "flags": {key: bool}, "waiting": {key: (state, reason)}, "skipped": {key: reason}}


def _slot(source):
    return _RUN.setdefault(source, {"looked": {}, "flags": {}, "waiting": {}, "skipped": {}})


def reset(source=None):
    """Forget one source's account of the run (all of them with no argument)."""
    with _LOCK:
        if source is None:
            _RUN.clear()
        else:
            _RUN.pop(source, None)


def skipped(source, key, why):
    """A ticket that never qualified for a lookup: `why` is 'no-plan' (no PR / known branch) or 'no-targets'."""
    with _LOCK:
        _slot(source)["skipped"][key] = why if why in SKIP_REASONS else "no-targets"


def looked(source, key, statuses, flagged=None):
    """A ticket that was looked up; `statuses` is one entry per target ('fixed' | 'open' | 'not-found' | 'unknown' for
    Checkmarx; a source with its own vocabulary names it in `finish`). `flagged` says whether the ticket has something
    worth a second look (default: a target is 'open')."""
    with _LOCK:
        slot = _slot(source)
        slot["looked"][key] = [str(s) for s in statuses]
        slot["flags"][key] = bool(flagged) if flagged is not None else "open" in slot["looked"][key]


def waiting(source, key, state, reason=""):
    """A ticket that wanted an answer and got none this run (its previous results were carried forward)."""
    if state not in WAITING_STATES:
        raise ValueError(f"not a waiting state: {state!r}")
    with _LOCK:
        _slot(source)["waiting"][key] = (state, _health.scrub(reason))


def _plural(n, noun):
    """"3 vulnerability-fix tickets"; a noun may carry a trailer after "|" ("ticket|with Dynatrace links" → "3 tickets with Dynatrace links")."""
    head, _, tail = str(noun).partition("|")
    return f"{n} {head}{'' if n == 1 else 's'}" + (f" {tail}" if tail else "")


def _skip_text(skipped_by):
    kinds = {}
    for why in skipped_by.values():
        kinds[why] = kinds.get(why, 0) + 1
    return ", ".join(f"{n} {SKIP_REASONS[why]}" for why, n in kinds.items())


def finish(source, label, noun, gap=None, statuses=TARGET_STATUSES, unit="target", flag="with open findings"):
    """The run's record for `source`: {state, detail, at[, looked, counts, waiting]}. `label` names the source in the
    line ("Checkmarx"), `noun` the thing looked up ("vulnerability-fix ticket"), `gap` the missing settings
    ("CHECKMARX_BASE_URL, CHECKMARX_API_KEY") when the source is not configured, else None. `statuses` is the source's
    vocabulary for what a looked-up item can be (the keys of `counts`), `unit` what one of them is called ("target",
    "link") and `flag` how a ticket worth a second look is described ("with open findings")."""
    with _LOCK:
        slot = _slot(source)
        looked_by, waiting_by, skipped_by, flags = dict(slot["looked"]), dict(slot["waiting"]), dict(slot["skipped"]), dict(slot["flags"])
    out = {"at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    wait_keys = sorted(waiting_by)[:MAX_KEYS]
    counts = {s: 0 for s in statuses}
    for item_statuses in looked_by.values():
        for s in item_statuses:
            counts[s] = counts.get(s, 0) + 1
    flagged = sum(1 for k in looked_by if flags.get(k))
    targets = sum(len(v) for v in looked_by.values())
    skip = f"{_plural(len(skipped_by), noun)} skipped ({_skip_text(skipped_by)})" if skipped_by else ""

    if gap:
        state = "not-configured"
        detail = f"{label} not configured — missing {gap}"
        if waiting_by:
            n = len(waiting_by)
            detail += f"; {_plural(n, noun)} {'is' if n == 1 else 'are'} waiting for it"
    elif waiting_by:
        state = next((s for s in PRIORITY if any(w[0] == s for w in waiting_by.values())), "unreachable")
        reason = next((w[1] for w in waiting_by.values() if w[0] == state and w[1]), "") or DEFAULT_REASON[state]
        parts = ([f"{_plural(len(looked_by), noun)} looked up"] if looked_by else []) + [f"{len(waiting_by)} carried forward"]
        detail = f"{label}: {'; '.join(parts)} — {reason}"
    elif looked_by:
        state = "read"
        tail = " · ".join(f"{counts[s]} {s.replace('-', ' ')}" for s in statuses if counts.get(s))
        flag_text = f"{flagged} {flag}" if flagged else f"none {flag}"
        detail = f"{label}: {_plural(len(looked_by), noun)} looked up ({_plural(targets, unit)}: {tail}) — {flag_text}"
        if skip:
            detail += f"; {len(skipped_by)} skipped ({_skip_text(skipped_by)})"
    else:
        state = "no-candidates"
        detail = f"{label}: no {str(noun).replace('|', ' ')} to look up" + (f" — {skip}" if skip else "")
    out.update(state=state, detail=detail)
    if looked_by:
        out["looked"] = len(looked_by)
        out["counts"] = counts
    if wait_keys:
        out["waiting"] = wait_keys
    return {k: out[k] for k in ("state", "detail", "at", "looked", "counts", "waiting") if k in out}


def noteworthy(status):
    """Worth a line in the run notes? Everything but "not configured, and nobody was waiting" — someone who does not
    use the source should not be told about it on every refresh."""
    return not (status.get("state") == "not-configured" and not status.get("waiting"))
