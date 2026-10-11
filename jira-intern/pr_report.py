#!/usr/bin/env python3
"""PR Readiness Report — deterministic base generator + report maintenance CLI.

One report per ticket that has a pull request, at  jira-intern/reports/<KEY>.json  (git-ignored).
Shape: src/lib/reportTypes.ts. AI enrichment brief: prompts/pr-readiness-prompt.md. Runner:
local-runner/pr-report.sh. Keep the three in sync.

TRUST MODEL — this module OWNS the verdict, the score, every count and every tone; two runs on the
same data.json are byte-identical (bar generatedAt). The AI pass may only ADD (its own violet 'ai'
tab, appended evidence rows, CI/scan gate states, a business one-liner). `validate --base` rejects
an enriched file that changed anything derived. Nothing here touches the network.

  pr_report.py base <KEY>                 write the deterministic report; print fingerprint; exit 2 if no PR
  pr_report.py uptodate <KEY>             exit 0 if reports/<KEY>.json matches the ticket's PR fingerprint
  pr_report.py needs-report [--year Y] [--since D] [--keys K1,K2] [--force] [--max N]   keys missing/stale reports
  pr_report.py context <KEY>              ticket + settings the AI pass needs (JSON, stdout)
  pr_report.py validate <KEY> [--base <path>]   exit 0 if well-formed (and derived parts preserved)
  pr_report.py mark-enriched <KEY>        stamp enriched=true / enrichedAt / generator
  pr_report.py status-add <KEY> <PID> | status-remove <KEY>     generation-in-progress registry
  pr_report.py fingerprint <KEY>
"""
import hashlib
import html
import json
import os
import re
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _config import endpoints, load_config, now_iso as configured_now_iso, time_zone  # noqa: E402
from datafile import atomic_write  # noqa: E402
import checkmarx  # noqa: E402  (classification + targets only — the report never calls Checkmarx)

INTERN = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(INTERN, "data.json")
REPORTS = os.path.join(INTERN, "reports")
STATUS = os.path.join(REPORTS, ".status.json")
SCHEMA_VERSION = 2
GENERATOR = f"pr_report.py {SCHEMA_VERSION}"
BLOCK_KINDS = {"callout", "stats", "table", "cards", "list", "timeline", "links", "kv"}
TONES = {"success", "warning", "danger", "info", "neutral", "violet"}
DONE_WORDS = ("done", "closed", "resolved", "completed", "released", "shipped")
STALE_DAYS = 14
RELEASE_BRANCH = re.compile(r"^(release/|hotfix/|main$|master$|develop$)", re.I)
TONE_CAP = {"danger": 39, "warning": 69, "info": 89, "success": 100, "neutral": 100, "violet": 100}
TONE_RANK = {"danger": 4, "warning": 3, "info": 2, "success": 1, "neutral": 0, "violet": 0}


# ── helpers ──────────────────────────────────────────────────────────────────
def now_iso():
    return configured_now_iso(INTERN)


def esc(s):
    """HTML-escape for text AND attribute values — this lands inside href="…" too, so quotes
    must be escaped as well."""
    return html.escape(str(s if s is not None else ""), quote=True)


def load_data():
    with open(DATA, encoding="utf-8") as f:
        return json.load(f)


def prs_of(t):
    prs = t.get("prs")
    if isinstance(prs, list) and prs:
        return [p for p in prs if isinstance(p, dict) and (p.get("state") or "none") != "none"]
    p = t.get("pr")
    return [p] if isinstance(p, dict) and (p.get("state") or "none") != "none" else []


def column_of(t):
    col = t.get("column")
    if col:
        return col
    s = (t.get("status") or "").lower()
    return "done" if any(w in s for w in DONE_WORDS) else "prog"


def year_of(t):
    for k in ("created", "resolved", "lastUpdate"):
        v = t.get(k)
        if isinstance(v, str) and len(v) >= 4 and v[:4].isdigit():
            return int(v[:4])
    return None


def date_of(t):
    """YYYY-MM-DD from the same field precedence as year_of — ISO strings sort as dates."""
    for k in ("created", "resolved", "lastUpdate"):
        v = t.get(k)
        if isinstance(v, str) and len(v) >= 10 and v[:4].isdigit():
            return v[:10]
    return None


def iter_tickets(data):
    seen = set()
    for t in data.get("tickets") or []:
        if t.get("key") and t["key"] not in seen:
            seen.add(t["key"])
            yield t, "active"
        for s in t.get("subtasks") or []:
            if isinstance(s, dict) and s.get("key") and s["key"] not in seen and prs_of(s):
                seen.add(s["key"])
                yield s, "subtask"
    for c in data.get("completed") or []:
        if c.get("key") and c["key"] not in seen:
            seen.add(c["key"])
            yield c, "completed"


def find_ticket(data, key):
    key = key.upper()
    for t, src in iter_tickets(data):
        if (t.get("key") or "").upper() == key:
            return t, src
    return None, None


def fingerprint(t):
    sig = {
        "status": t.get("status"),
        "fix": sorted(t.get("fixVersions") or []),
        "prs": sorted([[str(p.get("id")), p.get("state"), p.get("approvals"), p.get("openComments"), bool(p.get("merged")),
                        p.get("mergedAt"), p.get("updatedAt"), p.get("destinationBranch")] for p in prs_of(t)], key=str),
        "subtasks": sorted([[s.get("key"), s.get("status")] for s in (t.get("subtasks") or []) if isinstance(s, dict)], key=str),
    }
    # A new Jenkins build makes the report stale. Only added when there are builds, so every ticket
    # without them keeps the fingerprint it had before builds existed (no mass re-generation).
    builds = builds_of(t)
    if builds:
        sig["builds"] = sorted([[b.get("env"), b.get("repo"), b.get("branch"), b.get("number"), b.get("result")] for b in builds], key=str)
    # Same rule for Checkmarx: a status change or a newer scan makes the report stale; no results, no key.
    vf = vuln_fixes_of(t)
    if vf:
        sig["vulnFixes"] = [vf.get("branchScanAt"), vf.get("baseScanAt"),
                            sorted([[i.get("target"), i.get("kind"), i.get("status")] for i in vf["items"]], key=str)]
    return hashlib.sha1(json.dumps(sig, sort_keys=True).encode("utf-8")).hexdigest()[:16]


# ── Jenkins builds (ticket.builds — written by daily_fetch via jenkins.py) ─────
BUILD_TONE = {"SUCCESS": "success", "FAILURE": "danger", "UNSTABLE": "warning", "BUILDING": "info", "ABORTED": "neutral", "NOT_BUILT": "neutral"}
_SAFE_URL = re.compile(r"^https?://", re.I)


def builds_of(t):
    return [b for b in t.get("builds") or [] if isinstance(b, dict) and b.get("result")]


def _norm_branch(s):
    return str(s or "").strip().lower()


def ci_builds(t):
    """The builds the CI gate judges: those of the open PRs' source branches; failing that, of the
    primary branch; failing that, every build on the ticket."""
    builds = builds_of(t)
    open_src = {_norm_branch(p.get("sourceBranch")) for p in prs_of(t)
                if p.get("sourceBranch") and not p.get("merged") and p.get("state") not in ("merged", "declined")}
    for wanted in (open_src, {_norm_branch(t.get("branch"))} - {""}):
        picked = [b for b in builds if _norm_branch(b.get("branch")) in wanted]
        if picked:
            return picked
    return builds


def ago(iso, now):
    d = parse_iso(iso)
    if not d:
        return "—"
    secs = max(0, int((now - d).total_seconds()))
    if secs < 60:
        return "just now"
    if secs < 3600:
        return f"{secs // 60}m ago"
    if secs < 86400:
        return f"{secs // 3600}h ago"
    return f"{secs // 86400}d ago"


def fmt_duration(ms):
    if not isinstance(ms, (int, float)) or ms <= 0:
        return None
    s = int(round(ms / 1000))
    if s < 60:
        return f"{s}s"
    if s < 3600:
        return f"{s // 60}m {s % 60}s"
    return f"{s // 3600}h {(s % 3600) // 60}m"


def build_label(b):
    return f"{b.get('env') or '?'} #{b.get('number') if b.get('number') is not None else '?'} {b.get('result')}"


def jenkins_ci(t):
    """The "CI green" gate from Jenkins, or None when the ticket has no builds (then Bitbucket's
    build status stays the source). Shared with ai-intern/worker.py so the two never disagree.
    Pass = the latest build of every environment that built the branch is SUCCESS; Fail = any
    FAILURE / UNSTABLE; In progress = one is still building; Not verified otherwise (aborted, not built,
    or a `stale` build — carried forward because Jenkins could not be read; its age is shown)."""
    builds = ci_builds(t)
    if not builds:
        return None
    results = {b.get("result") for b in builds}
    fresh = {b.get("result") for b in builds if not b.get("stale")}
    if fresh & {"FAILURE", "UNSTABLE"}:
        state = "Fail"
    elif any(b.get("stale") for b in builds):
        state = "Not verified"
    elif "BUILDING" in results:
        state = "In progress"
    elif results == {"SUCCESS"}:
        state = "Pass"
    else:
        state = "Not verified"
    now = datetime.now(timezone.utc)
    parts = [build_label(b) + (f" (stage '{b['failedStage']}')" if b.get("failedStage") else "")
             + (f" (stale — from {ago(b.get('at'), now)}, Jenkins not re-read)" if b.get("stale") else "") for b in builds]
    tone = {"Pass": "success", "Fail": "warning", "In progress": "info"}.get(state, "neutral")
    return {"state": state, "tone": tone, "detail": ("Jenkins: " + "; ".join(parts))[:180], "error": False, "source": "jenkins"}


def build_evidence(b, now):
    """One evidence-chain row for a Jenkins build: "#412 SUCCESS · 2h ago · 312 tests, 0 failed"."""
    n = b.get("number")
    num = f"#{n}" if n is not None else "#?"
    url = b.get("url") if isinstance(b.get("url"), str) and _SAFE_URL.match(b["url"]) else None
    link = f'<a href="{esc(url)}">{esc(num)}</a>' if url else esc(num)
    result = b.get("result") or "?"
    bits = [f"{link} {esc(result)}", ago(b.get("at"), now)]
    dur = fmt_duration(b.get("durationMs"))
    if dur:
        bits.append(f"took {dur}")
    tests = b.get("tests") if isinstance(b.get("tests"), dict) else None
    if tests:
        bits.append(f"{tests.get('total', 0)} tests, {tests.get('failed', 0)} failed" + (f", {tests['skipped']} skipped" if tests.get("skipped") else ""))
    bits.append(f"<code>{esc(b.get('branch') or '?')}</code>")
    target = b.get("deployTarget")
    if target and target != b.get("env"):
        bits.append(f"→ {esc(target)}")
    stage = f" at stage '{esc(b['failedStage'])}'" if b.get("failedStage") else ""
    failing = ", ".join(esc(x) for x in ((tests or {}).get("failing") or [])[:5])
    failing_txt = f" Failing: {failing}." if failing else ""
    conclusion = {
        "SUCCESS": f"Green{(' — deployed to ' + esc(target)) if target else ''}.",
        "FAILURE": f"Pipeline failed{stage}.{failing_txt}",
        "UNSTABLE": f"Unstable — failed{stage}.{failing_txt}",
        "BUILDING": "Build running — CI not settled yet.",
        "ABORTED": "Aborted — CI not verified.",
    }.get(result, "Not built — CI not verified.")
    return {"cells": [f"Jenkins · {esc(b.get('env') or '?')}", " · ".join(bits), conclusion], "tone": BUILD_TONE.get(result, "neutral")}


# ── Checkmarx (ticket.vulnFixes — written by daily_fetch via checkmarx.py) ──────
SECURITY_GATE = "Security scan (Checkmarx) clean"
VULN_STATUS = {"fixed": ("Fixed", "success"), "open": ("Still open", "danger"),
               "not-found": ("Not found", "warning"), "unknown": ("Unknown", "neutral")}
VULN_KIND = {"cve": "CVE", "sast": "SAST", "result": "Result", "package": "Package"}


def vuln_fixes_of(t):
    vf = t.get("vulnFixes")
    if not isinstance(vf, dict):
        return None
    items = [i for i in vf.get("items") or [] if isinstance(i, dict) and i.get("target") and i.get("status") in VULN_STATUS]
    return {**vf, "items": items} if items else None


def _cap(text, n=180):
    return text if len(text) <= n else text[: n - 1].rstrip() + "…"


def vuln_gate(t):
    """(state, evidence, tone) for the "Security scan (Checkmarx) clean" gate — the base report and
    ai-intern/worker.py both use it, so the two never disagree. Pass = every target the ticket names
    is fixed; Fail = any is still open; Not verified otherwise, saying why. Only the ticket's own
    targets count — the scan's other findings are not this ticket's to fix."""
    if not checkmarx.is_vuln_fix(t):
        return "Not verified", "Not a vulnerability-fix ticket — no scan needed", "neutral"
    vf = vuln_fixes_of(t)
    if not vf:
        if not checkmarx.extract_targets(t):
            return "Not verified", "The ticket names no CVE, Checkmarx query / CWE, result link or package to check", "neutral"
        return "Not verified", "Checkmarx not read yet — needs CHECKMARX_API_KEY + base URL and a refresh", "neutral"
    items = vf["items"]
    count = {k: sum(1 for i in items if i["status"] == k) for k in VULN_STATUS}
    head = f"{count['fixed']} of {len(items)} fixed"
    if count["open"]:
        opened = [i["target"] for i in items if i["status"] == "open"]
        branch = vf.get("branch") or "the branch"
        at = f" (scan {str(vf.get('branchScanAt'))[:10]})" if vf.get("branchScanAt") else ""
        return "Fail", _cap(f"{head} · {', '.join(opened[:4])} still open on {branch}{at}"), "warning"
    if count["fixed"] == len(items):
        at = f" (scan {str(vf.get('branchScanAt'))[:10]})" if vf.get("branchScanAt") else ""
        return "Pass", _cap(f"{head} · none left on {vf.get('branch') or 'the branch'}{at}"), "success"
    why = []
    if count["not-found"]:
        why.append(f"{count['not-found']} not found in either scan")
    if count["unknown"]:
        why.append(f"{count['unknown']} unknown")
    if vf.get("note"):
        why.append(str(vf["note"]))
    return "Not verified", _cap(" · ".join([head, *why])), "neutral"


def vuln_evidence(i):
    """One evidence-chain row per target: Observed = target · severity · where; Conclusion = the
    stored detail ("Fixed — gone on feature/x (scan …) · was HIGH on develop (scan …).")."""
    label, tone = VULN_STATUS[i["status"]]
    bits = [f"<code>{esc(i['target'])}</code>"]
    if i.get("severity"):
        bits.append(esc(i["severity"]))
    if i.get("location"):
        bits.append(f"<code>{esc(i['location'])}</code>")
    return {"cells": [f"Checkmarx · {VULN_KIND.get(i.get('kind'), 'Target')}", " · ".join(bits), esc(i.get("detail") or label)], "tone": tone}


def vuln_proof_rows(t):
    """The worker's "Proof · vulnerability fix" rows: one per target, from the stored results."""
    vf = vuln_fixes_of(t) if checkmarx.is_vuln_fix(t) else None
    if not vf:
        return []
    rows = []
    for i in vf["items"]:
        label, tone = VULN_STATUS[i["status"]]
        detail = " · ".join(x for x in (i.get("severity"), i.get("location"), i.get("detail")) if x)
        rows.append({"check": i["target"], "result": label, "detail": detail, "tone": tone})
    return rows


def _enrich_warning(builds, vf):
    missing = [name for name, have in (("CI", builds), ("Checkmarx", vf), ("Dynatrace", False)) if not have]
    joined = missing[0] if len(missing) == 1 else (" or ".join(missing) if len(missing) == 2 else ", ".join(missing[:-1]) + ", or " + missing[-1])
    return f"{joined} is added for the matching ticket type when the report is enriched."


def report_path(key):
    return os.path.join(REPORTS, key.upper() + ".json")


def read_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def write_json_atomic(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    atomic_write(path, json.dumps(obj, indent=2, ensure_ascii=False))


def parse_iso(s):
    """Aware datetime (UTC assumed for a naive stamp) so subtracting from an aware `now`
    never raises; None for anything unparsable."""
    try:
        d = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except Exception:
        return None
    return d if d.tzinfo is not None else d.replace(tzinfo=timezone.utc)


def days_since(iso, now=None):
    d = parse_iso(iso)
    if not d:
        return None
    now = now or datetime.now(timezone.utc)
    return max(0, (now - d).days)


def fmt_day(iso):
    return (iso or "")[:10] or "—"


def pr_label(p):
    pid = p.get("id")
    return f"PR #{pid}" if pid not in (None, "") else "PR"


def worst(tones):
    best = "neutral"
    for t in tones:
        if t and TONE_RANK.get(t, 0) > TONE_RANK[best]:
            best = t
    return best


# ── analysis ─────────────────────────────────────────────────────────────────
def pr_rank(p, required):
    """Worst first: changes < open comments < short approvals < approved < merged < declined."""
    st = p.get("state")
    if st == "merged" or p.get("merged"):
        return 4
    if st == "declined":
        return 5
    if st == "changes":
        return 0
    if int(p.get("openComments") or 0) > 0:
        return 1
    if int(p.get("approvals") or 0) < required:
        return 2
    return 3


def pr_tone(p, required):
    r = pr_rank(p, required)
    return {0: "danger", 1: "danger", 2: "warning", 3: "success", 4: "success", 5: "neutral"}[r]


def is_qa(s):
    t = f"{s.get('type') or ''} {s.get('title') or ''}".lower()
    return "qa" in t or "test" in t or "verif" in t


def analyse(t, required, now):
    prs = sorted(prs_of(t), key=lambda p: pr_rank(p, required))
    col = column_of(t)
    open_prs = [p for p in prs if pr_rank(p, required) <= 3]
    merged = [p for p in prs if pr_rank(p, required) == 4]
    declined = [p for p in prs if pr_rank(p, required) == 5]
    subs = [s for s in (t.get("subtasks") or []) if isinstance(s, dict)]
    subs_open = [s for s in subs if column_of(s) != "done"]
    deps_open = [r for r in (t.get("related") or []) if isinstance(r, dict)
                 and re.search(r"block|depend", str(r.get("relation") or ""), re.I)
                 and not any(w in str(r.get("status") or "").lower() for w in DONE_WORDS)]
    fix = list(t.get("fixVersions") or [])
    blockers = [f"QA sub-task {s.get('key')}" if is_qa(s) else f"sub-task {s.get('key')}" for s in subs_open]
    blockers += [f"dependency {r.get('key')}" for r in deps_open]
    if not fix:
        blockers.append("no fixVersion")
    last_act = None
    for p in open_prs:
        d = parse_iso(p.get("updatedAt"))
        if d and (last_act is None or d > last_act):
            last_act = d
    stale = bool(open_prs) and last_act is not None and (now - last_act).days > STALE_DAYS
    repos = {p.get("repo") for p in prs if p.get("repo")}
    return dict(prs=prs, col=col, open=open_prs, merged=merged, declined=declined, subs=subs, subs_open=subs_open,
                deps_open=deps_open, fix=fix, blockers=blockers, stale=stale, last_act=last_act, repos=repos,
                unresolved=sum(int(p.get("openComments") or 0) for p in open_prs),
                min_appr=min([int(p.get("approvals") or 0) for p in open_prs], default=None))


def owner_of(t, s=None, p=None):
    if s and s.get("assignee"):
        return str(s["assignee"]).split(" (")[0]
    if p and p.get("author"):
        return str(p["author"])
    if t.get("assignee"):
        return str(t["assignee"]).split(" (")[0]
    return "UNASSIGNED"


def verdict_for(t, a, required):
    """Rules in order, first match wins. Returns id,label,tone,reason,next{owner,action}."""
    key = t["key"]
    sprint = (t.get("sprint") or "").split(" (")[0] or None
    due = sprint or "not scheduled"
    o = a["open"][0] if a["open"] else None
    fixs = ", ".join(a["fix"]) if a["fix"] else None
    m, d = len(a["merged"]), len(a["declined"])
    last_merge = max([fmt_day(p.get("mergedAt")) for p in a["merged"]], default=None)

    def V(vid, label, tone, reason, owner, action):
        return dict(id=vid, label=label, tone=tone, reason=reason,
                    next={"owner": owner, "action": action, "due": due} if action else None)

    if a["col"] in ("hold", "blocked"):
        state = "blocked" if a["col"] == "blocked" else "on hold"
        return V("on_hold", state.capitalize(), "neutral", f"{len(a['prs'])} PR(s) shown, not judged while the ticket is {state}.",
                 owner_of(t), "clear the blocker, then re-run the report")
    if a["col"] == "done" and a["open"]:
        return V("done_code_not_merged", "Closed in Jira, code not merged", "danger",
                 f"{pr_label(o)} is still open ({o.get('state')}).", owner_of(t, p=o), f"merge or decline {pr_label(o)}; reopen {key} if the fix did not ship")
    if a["col"] == "done" and m == 0:
        return V("done_code_not_merged", "Closed in Jira, code not merged", "danger",
                 f"all {d} PR(s) declined, none merged.", owner_of(t), f"confirm how {key} was delivered or reopen it")
    if a["col"] == "done":
        if a["fix"]:
            return V("shipped", "Shipped", "success", f"{m} PR(s) merged (last {last_merge}), {d} declined, fixVersion {fixs}. Nothing outstanding.", None, None)
        return V("shipped_unversioned", "Shipped · no fixVersion", "info", f"{m} PR(s) merged (last {last_merge}) but no fixVersion — not traceable to a release.",
                 owner_of(t), "set the fixVersion")
    if not a["open"] and m == 0:
        return V("declined_no_replacement", "Declined · no replacement PR", "danger", f"{d} PR(s) declined, none merged, none open.",
                 owner_of(t), "raise a new pull request")
    if not a["open"] and m > 0:
        if not a["blockers"]:
            return V("ready_to_close", "Ready to close", "success", f"all {m} PR(s) merged (last {last_merge}); scope complete; ticket still {t.get('status')}.",
                     owner_of(t), f"move {key} to Done")
        s0 = a["subs_open"][0] if a["subs_open"] else None
        return V("merged_awaiting_verification", "Merged · awaiting verification", "info",
                 f"all {m} PR(s) merged (last {last_merge}); closure blocked by {', '.join(a['blockers'])}.",
                 owner_of(t, s=s0) if s0 else owner_of(t), f"complete {s0.get('key')}" if s0 else "set the fixVersion and verify")
    # open PR(s) — worst first
    appr = int(o.get("approvals") or 0)
    if any(p.get("state") == "changes" for p in a["open"]):
        c = next(p for p in a["open"] if p.get("state") == "changes")
        return V("changes_requested", "Blocked · changes requested", "danger", f"a reviewer requested changes on {pr_label(c)}.",
                 owner_of(t, p=c), f"address the requested changes on {pr_label(c)} and re-request review")
    if a["unresolved"] > 0:
        c = next(p for p in a["open"] if int(p.get("openComments") or 0) > 0)
        return V("comments_unresolved", "Blocked · unresolved comments", "danger",
                 f"{pr_label(c)}: {c.get('openComments')} open review comment(s), {c.get('approvals') or 0} approvals ({required} required).",
                 owner_of(t, p=c), f"resolve the {c.get('openComments')} thread(s) on {pr_label(c)}, then re-request review")
    if any(int(p.get("approvals") or 0) < required for p in a["open"]):
        c = next(p for p in a["open"] if int(p.get("approvals") or 0) < required)
        need = required - int(c.get("approvals") or 0)
        rev = ", ".join((c.get("reviewers") or [])[:2]) or "reviewers"
        return V("awaiting_approvals", "Awaiting approvals", "warning",
                 f"{pr_label(c)}: {c.get('approvals') or 0} of {required} required approvals, 0 open comments.", rev, f"approve {pr_label(c)} ({need} more needed)")
    if a["blockers"]:
        s0 = a["subs_open"][0] if a["subs_open"] else None
        return V("merge_ready_scope_open", "Merge-ready · scope open", "warning",
                 f"{pr_label(o)}: {appr} approvals ({required} required), 0 open comments. Closure blocked by {', '.join(a['blockers'])}.",
                 owner_of(t, s=s0) if s0 else owner_of(t), f"merge {pr_label(o)}; complete {s0.get('key')}" if s0 else f"merge {pr_label(o)} and set the fixVersion")
    return V("ready", "Ready to merge", "success", f"{pr_label(o)}: {appr} approvals ({required} required), 0 open comments, no blockers.",
             owner_of(t, p=o), f"merge {pr_label(o)} into {o.get('destinationBranch') or 'target'}")


def score_for(v, a, required):
    if v["id"] == "on_hold":
        return None
    code = 40 if (not a["open"] and a["merged"]) else (
        20 * min(a["min_appr"] if a["min_appr"] is not None else 0, required) / required
        + (10 if a["unresolved"] == 0 else 0) + (10 if not any(p.get("state") == "changes" for p in a["open"]) else 0))
    subs_done = len(a["subs"]) - len(a["subs_open"])
    scope = (15 * subs_done / len(a["subs"]) if a["subs"] else 15) + (5 if not a["deps_open"] else 0) + (5 if a["fix"] else 0)
    process = (10 if v["id"] != "done_code_not_merged" else 0) + (5 if not a["stale"] else 0) + (5 if not (a["declined"] and not a["merged"] and not a["open"]) else 0)
    verification = 15 if a["col"] == "done" and a["merged"] else (10 if a["merged"] and not a["open"] else (5 if not a["subs_open"] else 0))
    s = max(0, min(100, round(code + scope + process + verification)))
    return min(s, TONE_CAP.get(v["tone"], 100))


# ── the deterministic report ─────────────────────────────────────────────────
def build_base(t, src, cfg):
    required = int((cfg.get("app") or {}).get("requiredApprovals") or 2)
    jira_base, _c, _b = endpoints(INTERN)
    now = datetime.now(timezone.utc)
    key = t["key"]
    a = analyse(t, required, now)
    v = verdict_for(t, a, required)
    score = score_for(v, a, required)
    if a["stale"] and v["id"] in ("changes_requested", "comments_unresolved", "awaiting_approvals", "merge_ready_scope_open", "ready"):
        v["label"] += " · stale"
        v["reason"] += f" No PR activity for {(now - a['last_act']).days} days."
    multi = f" Across {len(a['repos'])} repos: {len(a['merged'])} merged, {len(a['open'])} open, {len(a['declined'])} declined." if len(a["repos"]) > 1 else ""
    nxt = v.get("next")
    headline = f"{v['label']} — {v['reason']}{multi}" + (f" Next: {nxt['owner']} → {nxt['action']}." if nxt else "")
    verdict = {"id": v["id"], "label": v["label"], "tone": v["tone"], "headline": headline, "summary": None,
               "score": score, "provenance": "derived", "reason": v["reason"], "next": nxt}
    o = a["open"][0] if a["open"] else None

    # deciding tile(s) get colour; everything else stays neutral
    drive = {"changes_requested": {"comments"}, "comments_unresolved": {"comments"}, "awaiting_approvals": {"approvals"},
             "merge_ready_scope_open": {"blockers"}, "merged_awaiting_verification": {"blockers"}, "done_code_not_merged": {"prs"},
             "declined_no_replacement": {"prs"}, "ready": {"approvals"}, "shipped": {"prs"}, "ready_to_close": {"prs"}}.get(v["id"], set())
    if a["stale"]:
        drive = drive | {"activity"}

    # ── gates (fixed order = verdict-rule order) ───────────────────────────
    ci = jenkins_ci(t)
    sec_state, sec_evidence, sec_tone = vuln_gate(t)

    def gate(name, state, evidence, blocks, tone_override=None):
        tone = tone_override or ("success" if state == "Pass" else ("danger" if state == "Fail" and blocks == "Yes" else ("warning" if state == "Fail" else "neutral")))
        return {"cells": [name, state, evidence, blocks], "tone": tone}
    open_txt = "; ".join(f"{pr_label(p)}: {p.get('approvals') or 0} of {required}" for p in a["open"]) or ("no open PR" if a["merged"] else "—")
    gates = [
        gate("Code approved", "Pass" if (a["open"] and a["min_appr"] is not None and a["min_appr"] >= required) or (not a["open"] and a["merged"]) else ("Fail" if a["open"] else "Not verified"), open_txt, "Yes"),
        gate("Review comments resolved", "Pass" if a["unresolved"] == 0 else "Fail", f"{a['unresolved']} open across open PRs", "Yes"),
        gate("No changes requested", "Fail" if any(p.get('state') == 'changes' for p in a["open"]) else "Pass", ", ".join(pr_label(p) for p in a["open"] if p.get("state") == "changes") or "none", "Yes"),
        gate("All PRs merged or closed", "Pass" if not a["open"] and a["merged"] else "Fail", f"{len(a['merged'])} merged · {len(a['open'])} open · {len(a['declined'])} declined", "Yes"),
        gate("QA / test sub-task done", "Not verified" if not any(is_qa(s) for s in a["subs"]) else ("Fail" if any(is_qa(s) for s in a["subs_open"]) else "Pass"),
             ", ".join(f"{s.get('key')} ({s.get('status')}, {owner_of(t, s=s)})" for s in a["subs"] if is_qa(s)) or "no QA sub-task on the ticket", "Yes"),
        gate("Other sub-tasks & dependencies done", "Pass" if not [s for s in a["subs_open"] if not is_qa(s)] and not a["deps_open"] else "Fail",
             ", ".join([f"{s.get('key')} ({s.get('status')})" for s in a["subs_open"] if not is_qa(s)] + [f"{r.get('key')} ({r.get('status')})" for r in a["deps_open"]]) or "none open", "Yes"),
        gate("fixVersion set", "Pass" if a["fix"] else "Fail", ", ".join(a["fix"]) or "none", "Yes"),
        gate("Target is a release branch", "Pass" if o and RELEASE_BRANCH.match(o.get("destinationBranch") or "") else ("Not verified" if not o else "Fail"),
             (o.get("destinationBranch") or "?") if o else "no open PR", "No"),
        (gate("CI green", ci["state"], ci["detail"], "No", ci["tone"]) if ci else
         gate("CI green", "Not verified", "Read from Bitbucket when the report is enriched", "No")),
        gate(SECURITY_GATE, sec_state, sec_evidence, "No", sec_tone),
    ]
    blockers_yes = sum(1 for g in gates if g["cells"][1] == "Fail" and g["cells"][3] == "Yes")

    stats = [
        {"label": "Approvals", "value": (f"{a['min_appr']} of {required} required" if a["min_appr"] is not None else ("merged" if a["merged"] else "—")),
         "tone": ("success" if a["min_appr"] is not None and a["min_appr"] >= required else "warning") if "approvals" in drive else "neutral"},
        {"label": "Open comments", "value": str(a["unresolved"]), "tone": ("danger" if a["unresolved"] else "success") if "comments" in drive else "neutral"},
        {"label": "Pull requests", "value": f"{len(a['merged'])} merged · {len(a['open'])} open · {len(a['declined'])} declined",
         "tone": v["tone"] if "prs" in drive else "neutral"},
        {"label": "Open blockers", "value": str(blockers_yes), "tone": ("warning" if blockers_yes else "success") if "blockers" in drive else "neutral"},
        {"label": "Last PR activity", "value": f"{(now - a['last_act']).days}d ago" if a["last_act"] else (fmt_day(a["merged"][-1].get("mergedAt")) if a["merged"] else "—"),
         "tone": "warning" if "activity" in drive else "neutral", "hint": "stale after 14 days" if a["stale"] else None},
    ]

    release_gate = None
    if a["col"] == "done" and a["open"]:
        release_gate = ("danger", f"<p><b>{esc(key)} is Done in Jira while {esc(pr_label(o))} is still open.</b> Either the fix shipped another way or the ticket was closed early — verify before treating it as delivered.</p>")
    elif not a["fix"]:
        release_gate = ("warning", "<p><b>No fixVersion.</b> Merging is not shipping — without a fixVersion this change cannot be traced to a release. Set it before closing.</p>")
    elif o and o.get("destinationBranch") and not RELEASE_BRANCH.match(o["destinationBranch"]):
        release_gate = ("warning", f"<p><b>{esc(pr_label(o))} targets <code>{esc(o['destinationBranch'])}</code>, not a release branch.</b> A merge there does not reach production on its own.</p>")
    elif a["merged"] and not a["open"] and a["col"] != "done":
        dm = max([days_since(p.get("mergedAt"), now) or 0 for p in a["merged"]], default=0)
        if dm > 7:
            release_gate = ("warning", f"<p><b>Merged {dm} days ago, ticket still {esc(t.get('status'))}.</b> Deploy, verify the fix in the target environment, then close.</p>")

    verdict_tab = {"id": "verdict", "title": "Verdict", "tone": v["tone"], "summary": None, "blocks": [
        {"kind": "callout", "title": "Decision", "tone": v["tone"], "provenance": "derived",
         "body": f"<p><b>{esc(v['label'])}.</b> {esc(v['reason'])}{esc(multi)}</p>"
                 + (f"<p><b>Next:</b> {esc(nxt['owner'])} → {esc(nxt['action'])} <i>(due {esc(nxt['due'])})</i></p>" if nxt else "")
                 + f"<p><i>{esc(t.get('type') or 'Ticket')} · {esc((t.get('epic') or {}).get('key') or 'no epic')} · {esc(t.get('title'))}</i></p>",
         "note": "Business impact one-liner is replaced by the AI pass when it has read the Jira description / Confluence spec."},
        {"kind": "stats", "title": "At a glance", "tone": "neutral", "provenance": "derived", "items": stats},
        {"kind": "table", "title": "Gate checklist", "tone": worst(g["tone"] for g in gates), "provenance": "derived",
         "headers": ["Gate", "State", "Evidence", "Blocks closure?"], "rows": gates,
         "note": "Rows are in verdict-rule order: the first Fail is the reason for the verdict. 'Not verified' is grey, never green."},
    ]}
    if release_gate:
        verdict_tab["blocks"].append({"kind": "callout", "title": "Release gate", "tone": release_gate[0], "provenance": "derived", "body": release_gate[1]})

    # ── evidence ───────────────────────────────────────────────────────────
    ev = []
    for p in a["open"]:
        st, appr, oc = p.get("state"), int(p.get("approvals") or 0), int(p.get("openComments") or 0)
        obs = f"{esc(pr_label(p))} → <code>{esc(p.get('destinationBranch') or '?')}</code>: {esc(st)}, {appr} of {required} approvals, {oc} open comment(s)"
        if st == "changes":
            ev.append({"cells": ["Bitbucket (dev-status)", obs, "Reviewer requested changes — blocks merge."], "tone": "danger"})
        elif oc > 0:
            ev.append({"cells": ["Bitbucket (dev-status)", obs, f"{oc} review thread(s) unresolved — blocks merge regardless of approvals."], "tone": "danger"})
        elif appr < required:
            ev.append({"cells": ["Bitbucket (dev-status)", obs, f"Needs {required - appr} more approval(s)."], "tone": "warning"})
        else:
            ev.append({"cells": ["Bitbucket (dev-status)", obs, "Approved to the required level; mergeable."], "tone": "success"})
    for p in a["merged"]:
        ev.append({"cells": ["Bitbucket (dev-status)", f"{esc(pr_label(p))} → <code>{esc(p.get('destinationBranch') or '?')}</code>: merged {fmt_day(p.get('mergedAt'))}",
                             f"Code is in {esc(p.get('destinationBranch') or 'target')}."], "tone": "success"})
    for p in a["declined"]:
        ev.append({"cells": ["Bitbucket (dev-status)", f"{esc(pr_label(p))}: declined", "Not part of the delivered change."], "tone": "neutral"})
    for s in a["subs"]:
        done = column_of(s) == "done"
        ev.append({"cells": [f"Sub-task {esc(s.get('key'))}", f"{esc(s.get('type') or 'Sub-task')} · {esc(s.get('status') or '—')} · {esc(owner_of(t, s=s))}",
                             "Done." if done else ("QA not done — closure blocked." if is_qa(s) else "Open — part of closure scope.")],
                   "tone": "success" if done else ("danger" if is_qa(s) and owner_of(t, s=s) == "UNASSIGNED" else "warning")})
    ev.append({"cells": ["Jira fixVersion", esc(", ".join(a["fix"]) or "none"), "Traceable to a release." if a["fix"] else "Not traceable to a release."], "tone": "success" if a["fix"] else "warning"})
    ev.append({"cells": ["Jira status", f"{esc(t.get('status') or '—')} · {esc(t.get('sprint') or 'no sprint')}",
                         "Consistent with PR state." if not (a["col"] == "done" and a["open"]) else "INCONSISTENT — Done with an open PR."],
               "tone": "danger" if (a["col"] == "done" and a["open"]) else "info"})
    builds = builds_of(t)
    ev += [build_evidence(b, now) for b in builds]
    vf = vuln_fixes_of(t) if checkmarx.is_vuln_fix(t) else None
    ev += [vuln_evidence(i) for i in (vf or {}).get("items") or []]

    pr_items = []
    for p in a["prs"]:
        badge = {"merged": "Merged", "declined": "Declined", "changes": "Changes requested", "approved": "Approved", "comments": "In review"}.get(p.get("state"), esc(p.get("state") or "open"))
        pr_items.append({"title": f"{pr_label(p)}{' · ' + esc(p.get('repo')) if p.get('repo') else ''}{' · ' + esc(p.get('title')) if p.get('title') else ''}",
                         "badge": badge, "badgeTone": pr_tone(p, required),
                         "body": f"<p><code>{esc(p.get('sourceBranch') or '?')}</code> → <code>{esc(p.get('destinationBranch') or '?')}</code></p>"
                                 f"<p>{p.get('approvals') or 0} of {required} approvals · {p.get('openComments') or 0} open of {p.get('commentsTotal') or 0} comments"
                                 f"{' · merged ' + fmt_day(p.get('mergedAt')) if pr_rank(p, required) == 4 else ' · updated ' + fmt_day(p.get('updatedAt'))}</p>",
                         "detail": ("Reviewers: " + ", ".join(p.get("reviewers") or [])) if p.get("reviewers") else None, "href": p.get("url")})
    if len(a["prs"]) <= 4:
        pr_block = {"kind": "cards", "title": "Pull requests", "tone": worst(pr_tone(p, required) for p in a["prs"]), "provenance": "derived", "items": pr_items}
    else:
        pr_block = {"kind": "table", "title": f"Pull requests ({len(a['prs'])}, worst first)", "tone": worst(pr_tone(p, required) for p in a["prs"]), "provenance": "derived",
                    "headers": ["Repo", "PR", "State", "Approvals", "Open comments", "Target", "Updated", "Blocks?"],
                    "rows": [{"cells": [esc(p.get("repo") or "—"), f"<a href=\"{esc(p.get('url') or '#')}\">{esc(pr_label(p))}</a>", esc(p.get("state")),
                                        f"{p.get('approvals') or 0} of {required}", str(p.get("openComments") or 0), esc(p.get("destinationBranch") or "?"),
                                        fmt_day(p.get("mergedAt") or p.get("updatedAt")), "Yes" if pr_rank(p, required) <= 2 else "No"],
                              "tone": pr_tone(p, required)} for p in a["prs"]]}

    tl = []
    if t.get("created"):
        tl.append({"when": fmt_day(t["created"]), "label": "Ticket created", "tone": "neutral"})
    for e in t.get("updateLog") or []:
        if isinstance(e, dict) and e.get("text"):
            tl.append({"when": fmt_day(e.get("when")), "label": esc(e["text"]), "tone": "info"})
    for p in a["prs"]:
        r = pr_rank(p, required)
        tl.append({"when": fmt_day(p.get("mergedAt") if r == 4 else p.get("updatedAt")),
                   "label": f"{pr_label(p)} {'merged → ' + esc(p.get('destinationBranch') or '?') if r == 4 else ('declined' if r == 5 else 'last review activity')}",
                   "tone": pr_tone(p, required)})
    if t.get("resolved"):
        tl.append({"when": fmt_day(t["resolved"]), "label": "Resolved", "tone": "success"})
    seen, tl2 = set(), []
    for e in sorted(tl, key=lambda x: x.get("when") or "", reverse=True):
        if (e.get("when"), e["label"]) not in seen:
            seen.add((e.get("when"), e["label"]))
            tl2.append(e)
    evidence_tab = {"id": "evidence", "title": "Evidence", "tone": worst(r["tone"] for r in ev), "badge": len(ev), "blocks": [
        {"kind": "table", "title": "Evidence chain", "tone": worst(r["tone"] for r in ev), "provenance": "derived",
         "headers": ["Source", "Observed", "Conclusion"], "rows": ev,
         "note": "Rows in verdict-rule order — the first non-green row is the deciding fact. The AI pass appends rows (diff, CI, Confluence, telemetry) below these."},
        pr_block,
        {"kind": "timeline", "title": "Timeline", "tone": "neutral", "provenance": "derived", "items": tl2[:20]},
    ]}

    # ── open scope ─────────────────────────────────────────────────────────
    rows = []
    for s in a["subs_open"]:
        own = owner_of(t, s=s)
        rows.append({"cells": [f"{'QA sub-task' if is_qa(s) else 'Sub-task'} {esc(s.get('key'))}", esc(s.get("status")), esc(own), "Complete and verify.", "Yes"],
                     "tone": "danger" if own == "UNASSIGNED" else ("warning" if column_of(s) == "todo" else "info")})
    for r in a["deps_open"]:
        rows.append({"cells": [f"Dependency {esc(r.get('key'))}", esc(r.get("status") or "open"), "—", "Resolve the linked ticket.", "Yes"], "tone": "warning"})
    for p in a["open"]:
        need = max(0, required - int(p.get("approvals") or 0))
        acts = ([("address requested changes")] if p.get("state") == "changes" else []) + ([f"resolve {p.get('openComments')} comment(s)"] if int(p.get("openComments") or 0) else []) \
            + ([f"get {need} more approval(s)"] if need else []) + [f"merge to {p.get('destinationBranch') or 'target'}"]
        rows.append({"cells": [f"{esc(pr_label(p))} review", f"{esc(p.get('state'))} · {p.get('approvals') or 0} of {required} · {p.get('openComments') or 0} open comments",
                               esc(owner_of(t, p=p) if pr_rank(p, required) <= 1 else (", ".join((p.get('reviewers') or [])[:2]) or owner_of(t))), "; ".join(acts).capitalize(), "Yes"],
                     "tone": pr_tone(p, required)})
    if not a["fix"]:
        rows.append({"cells": ["fixVersion", "not set", esc(owner_of(t)), "Set the release this ships in.", "Yes"], "tone": "warning"})
    if a["merged"] and not a["open"] and a["col"] != "done":
        rows.append({"cells": ["Deployment & verification", f"merged {max(fmt_day(p.get('mergedAt')) for p in a['merged'])}; ticket {esc(t.get('status'))}", esc(owner_of(t)),
                               "Deploy, verify in the target environment, close the ticket.", "Yes"], "tone": "info"})
    for p in a["declined"]:
        rows.append({"cells": [f"{esc(pr_label(p))} (declined)", "declined", "—", "Nothing — superseded." if a["merged"] or a["open"] else "Raise a replacement PR.", "No" if a["merged"] or a["open"] else "Yes"],
                     "tone": "neutral" if a["merged"] or a["open"] else "danger"})
    rows.sort(key=lambda r: (0 if r["cells"][4] == "Yes" else 1, -TONE_RANK.get(r["tone"], 0)))
    if not rows:
        rows.append({"cells": ["—", "nothing open", "—", "—", "No"], "tone": "success"})
    actions = []
    if nxt:
        actions.append({"text": f"{nxt['owner']} → {nxt['action']} → due {nxt['due']}", "tone": "danger" if nxt["owner"] == "UNASSIGNED" else v["tone"]})
    for r in rows:
        if r["cells"][4] == "Yes" and len(actions) < 3 and not any(r["cells"][0] in x["text"] for x in actions):
            actions.append({"text": f"{r['cells'][2]} → {r['cells'][3].rstrip('.')} ({r['cells'][0]}) → due {nxt['due'] if nxt else 'not scheduled'}",
                            "tone": "danger" if r["cells"][2] == "UNASSIGNED" else "warning"})
    scope_tab = {"id": "scope", "title": "Open scope", "tone": worst([r["tone"] for r in rows if r["cells"][4] == "Yes"] or ["success"]),
                 "badge": sum(1 for r in rows if r["cells"][4] == "Yes"), "blocks": [
        {"kind": "table", "title": "What still blocks closure", "tone": "warning", "provenance": "derived",
         "headers": ["Item", "State", "Owner", "Required action", "Blocks closure?"], "rows": rows},
        {"kind": "list", "title": "Next actions", "tone": "info", "provenance": "derived", "items": actions or [{"text": "Nothing outstanding.", "tone": "success"}]},
    ]}
    if a["col"] == "done" and a["open"]:
        scope_tab["blocks"].append({"kind": "callout", "title": "Status consistency", "tone": "danger", "provenance": "derived",
                                    "body": f"<p>Closed in Jira, code not merged: {esc(pr_label(o))} is still open.</p>"})
    elif a["merged"] and not a["open"] and a["col"] not in ("done", "qa"):
        scope_tab["blocks"].append({"kind": "callout", "title": "Status consistency", "tone": "warning", "provenance": "derived",
                                    "body": f"<p>All PRs merged (last {max(fmt_day(p.get('mergedAt')) for p in a['merged'])}) but the ticket is still {esc(t.get('status'))}.</p>"})

    # ── sources ────────────────────────────────────────────────────────────
    links = []
    if t.get("url"):
        links.append({"label": f"Jira {key}", "href": t["url"]})
    elif jira_base:
        links.append({"label": f"Jira {key}", "href": f"{jira_base}/browse/{key}"})
    if (t.get("epic") or {}).get("url"):
        links.append({"label": f"Epic {t['epic'].get('key')}", "href": t["epic"]["url"]})
    links += [{"label": f"Sub-task {s['key']}", "href": s["url"]} for s in a["subs"] if s.get("url")]
    links += [{"label": pr_label(p) + (f" · {p.get('repo')}" if p.get("repo") else ""), "href": p["url"]} for p in a["prs"] if p.get("url")]
    links += [{"label": f"Confluence: {c.get('title') or 'page'}", "href": c["url"]} for c in (t.get("confluence") or [])[:5] if isinstance(c, dict) and c.get("url")]
    links += [{"label": f"Jenkins {b.get('env')} #{b.get('number')}", "href": b["url"]} for b in builds
              if isinstance(b.get("url"), str) and _SAFE_URL.match(b["url"])]
    sources_tab = {"id": "sources", "title": "Sources", "tone": "neutral", "blocks": [
        {"kind": "links", "title": "Links", "tone": "neutral", "provenance": "derived", "items": links},
        {"kind": "kv", "title": "Run metadata", "tone": "neutral", "provenance": "derived", "items": [
            {"label": "Generated", "value": now_iso()}, {"label": "Ticket last update", "value": fmt_day(t.get("lastUpdate"))},
            {"label": "PR fingerprint", "value": fingerprint(t)}, {"label": "Generator", "value": GENERATOR},
            {"label": "Score", "value": str(score) if score is not None else "—", "tone": v["tone"]},
            {"label": "AI enrichment", "value": "not run", "tone": "neutral"}]},
    ]}

    return {
        "schemaVersion": SCHEMA_VERSION, "key": key, "title": t.get("title") or key,
        "timeZone": time_zone(INTERN), "generatedAt": now_iso(),
        "fingerprint": fingerprint(t), "enriched": False, "enrichedAt": None, "generator": GENERATOR,
        "verdict": verdict, "stats": stats, "tabs": [verdict_tab, evidence_tab, scope_tab, sources_tab], "links": links,
        "sources": "Jira (last fetch) · Bitbucket via Jira dev-status" + (" · Jenkins builds (last fetch)" if builds else "")
                   + (" · Checkmarx (last fetch)" if vf else "") + ". Deterministic — no AI, no live calls.",
        "warnings": [_enrich_warning(builds, vf)],
    }


# ── validation ────────────────────────────────────────────────────────────────
def validate_report(r, t=None, base=None):
    errs = []
    if not isinstance(r, dict):
        return ["not an object"]
    for k in ("schemaVersion", "key", "title", "generatedAt", "fingerprint", "verdict", "stats", "tabs", "links"):
        if k not in r:
            errs.append(f"missing {k}")
    v = r.get("verdict") or {}
    for k in ("id", "label", "tone", "headline"):
        if not v.get(k):
            errs.append(f"verdict.{k} missing")
    if v.get("tone") not in TONES:
        errs.append(f"verdict.tone invalid: {v.get('tone')}")
    tabs = r.get("tabs")
    if not isinstance(tabs, list) or not tabs:
        errs.append("tabs empty")
        tabs = []
    if len(tabs) > 6:
        errs.append("more than 6 tabs")
    for i, tab in enumerate(tabs):
        if not isinstance(tab, dict) or not tab.get("id") or not tab.get("title"):
            errs.append(f"tab {i} missing id/title")
            continue
        if tab.get("tone") not in TONES:
            errs.append(f"tab {tab.get('id')} tone invalid")
        for j, b in enumerate(tab.get("blocks") or []):
            if not isinstance(b, dict) or b.get("kind") not in BLOCK_KINDS:
                errs.append(f"tab {tab.get('id')} block {j} bad kind")
                continue
            if b.get("tone") and b["tone"] not in TONES:
                errs.append(f"{tab.get('id')}/{j} bad tone")
            k = b["kind"]
            if k == "callout" and not isinstance(b.get("body"), str):
                errs.append(f"{tab.get('id')}/{j} callout needs body")
            if k == "table" and (not isinstance(b.get("headers"), list) or not isinstance(b.get("rows"), list)):
                errs.append(f"{tab.get('id')}/{j} table needs headers+rows")
            if k in ("stats", "cards", "list", "timeline", "links", "kv") and not isinstance(b.get("items"), list):
                errs.append(f"{tab.get('id')}/{j} {k} needs items")
    if t is not None and (r.get("key") or "").upper() != (t.get("key") or "").upper():
        errs.append("key mismatch")
    if base:
        errs += preserved_errors(r, base)
    return errs


AI_MAY_EDIT_GATES = ("CI green", "Security scan (Checkmarx) clean")


def preserved_errors(r, base):
    """The AI pass may only ADD. Everything derived must survive byte-for-byte, except: the two
    'Not verified' gate rows it may fill, the Decision callout body (business line), verdict.summary,
    and appended rows/blocks/tabs (an 'ai' tab, violet)."""
    errs = []
    bv, rv = base.get("verdict") or {}, r.get("verdict") or {}
    for k in ("id", "label", "tone", "score"):
        if bv.get(k) != rv.get(k):
            errs.append(f"verdict.{k} changed by enrichment ({bv.get(k)!r} → {rv.get(k)!r})")
    if r.get("fingerprint") != base.get("fingerprint"):
        errs.append("fingerprint changed")
    if r.get("stats") != base.get("stats"):
        errs.append("stats changed")
    btabs = {tb["id"]: tb for tb in base.get("tabs") or []}
    rtabs = [tb for tb in r.get("tabs") or [] if isinstance(tb, dict)]
    rids = [tb.get("id") for tb in rtabs]
    if [tb["id"] for tb in base.get("tabs") or []] != [i for i in rids if i in btabs]:
        errs.append("base tab ids/order changed")
    for extra in [tb for tb in rtabs if tb.get("id") not in btabs]:
        if extra.get("id") != "ai" or extra.get("tone") != "violet":
            errs.append(f"unexpected tab {extra.get('id')} (only an 'ai' tab, tone violet, may be added)")
    for tb in rtabs:
        b = btabs.get(tb.get("id"))
        if not b:
            continue
        bblocks, rblocks = b.get("blocks") or [], tb.get("blocks") or []
        if len(rblocks) < len(bblocks):
            errs.append(f"tab {tb['id']}: derived blocks removed")
            continue
        for j, bb in enumerate(bblocks):
            rb = rblocks[j]
            if bb.get("provenance") != "derived":
                continue
            if bb.get("kind") == "table":
                if rb.get("headers") != bb.get("headers"):
                    errs.append(f"tab {tb['id']} block {j}: table headers changed")
                brows, rrows = bb.get("rows") or [], rb.get("rows") or []
                if len(rrows) < len(brows):
                    errs.append(f"tab {tb['id']} block {j}: derived rows removed")
                    continue
                for i, br in enumerate(brows):
                    rr = rrows[i]
                    if br == rr:
                        continue
                    if bb.get("title") == "Gate checklist" and br["cells"][0] in AI_MAY_EDIT_GATES and rr.get("cells", [None])[0] == br["cells"][0]:
                        continue
                    errs.append(f"tab {tb['id']} block {j} row {i} ('{br['cells'][0]}') changed by enrichment")
            elif bb.get("kind") == "callout" and bb.get("title") == "Decision":
                if rb.get("kind") != "callout" or rb.get("tone") != bb.get("tone") or rb.get("title") != "Decision":
                    errs.append("Decision callout tone/title changed")
            else:
                bbc, rbc = dict(bb), dict(rb)
                bbc.pop("note", None)
                rbc.pop("note", None)
                if bbc != rbc:
                    errs.append(f"tab {tb['id']} block {j} ('{bb.get('title')}') changed by enrichment")
    return errs


# ── status file ───────────────────────────────────────────────────────────────
def _status_load():
    st = read_json(STATUS) or {}
    if not isinstance(st.get("generating"), dict):
        st["generating"] = {}
    return st


def _status_update(fn):
    """Read-modify-write under an exclusive lock — several report workers run at once."""
    import fcntl

    os.makedirs(REPORTS, exist_ok=True)
    with open(STATUS + ".lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        st = _status_load()
        fn(st["generating"])
        write_json_atomic(STATUS, st)


def status_add(key, pid):
    _status_update(lambda g: g.__setitem__(key.upper(), {"pid": int(pid), "startedAt": now_iso()}))


def status_remove(key):
    _status_update(lambda g: g.pop(key.upper(), None))


# ── CLI ───────────────────────────────────────────────────────────────────────
EXIT_NOT_IN_DATA = 3
EXIT_NO_PR = 4


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    cmd, args = argv[1], argv[2:]
    cfg = load_config(INTERN)
    if cmd == "status-add":
        status_add(args[0], args[1] if len(args) > 1 else 0)
        return 0
    if cmd == "status-remove":
        status_remove(args[0])
        return 0
    data = load_data()
    if cmd == "needs-report":
        year = int(args[args.index("--year") + 1]) if "--year" in args else None
        mx = int(args[args.index("--max") + 1]) if "--max" in args else None
        since = args[args.index("--since") + 1] if "--since" in args else None
        force = "--force" in args
        # --needs-ai: a deterministic-only report has a CURRENT fingerprint, so the normal
        # staleness check skips it forever and it never gets upgraded. This selects those too,
        # which is what makes an interrupted AI backfill resumable without redoing finished work.
        needs_ai = "--needs-ai" in args
        # --keys: only these tickets (the board's own cards), still subject to every filter below.
        only = {k.strip().upper() for k in args[args.index("--keys") + 1].split(",") if k.strip()} if "--keys" in args else None
        out = []
        for t, src in iter_tickets(data):
            if only is not None and (t.get("key") or "").upper() not in only:
                continue
            if not prs_of(t) or (year and year_of(t) != year):
                continue
            if since:
                d = date_of(t)
                if not d or d < since:
                    continue
            rep = None if force else read_json(report_path(t["key"]))
            if rep and rep.get("fingerprint") == fingerprint(t) and rep.get("schemaVersion") == SCHEMA_VERSION:
                if not (needs_ai and not rep.get("enriched")):
                    continue
            out.append(t["key"])
        print("\n".join(out[:mx] if mx is not None else out))
        return 0
    key = (args[0] if args else "").upper()
    if not key:
        print("missing <KEY>", file=sys.stderr)
        return 2
    t, src = find_ticket(data, key)
    if cmd == "fingerprint":
        if not t:
            return 2
        print(fingerprint(t))
        return 0
    if cmd == "uptodate":
        rep = read_json(report_path(key)) if t else None
        return 0 if rep and rep.get("fingerprint") == fingerprint(t) and rep.get("schemaVersion") == SCHEMA_VERSION else 1
    if cmd == "context":
        if not t:
            print(json.dumps({"error": f"{key} not found"}))
            return 2
        jb, cb, bb = endpoints(INTERN)
        print(json.dumps({"key": key, "source": src, "requiredApprovals": int((cfg.get("app") or {}).get("requiredApprovals") or 2),
                          "endpoints": {"jira": jb, "confluence": cb, "bitbucket": bb}, "reportPath": report_path(key), "ticket": t}, indent=2, ensure_ascii=False))
        return 0
    if cmd == "base":
        # Distinct exit codes so the board can say WHY there is no report (src/lib/reportFailure.ts):
        #   3 = the ticket is not in data.json, 4 = it has no pull request, 1 = internal error.
        if not t:
            print(f"{key}: not in data.json", file=sys.stderr)
            return EXIT_NOT_IN_DATA
        if not prs_of(t):
            print(f"{key}: no pull request", file=sys.stderr)
            return EXIT_NO_PR
        rep = build_base(t, src, cfg)
        errs = validate_report(rep, t)
        if errs:
            print("internal error — base report invalid: " + "; ".join(errs), file=sys.stderr)
            return 1
        write_json_atomic(report_path(key), rep)
        print(rep["fingerprint"])
        return 0
    if cmd == "validate":
        rep = read_json(report_path(key))
        if rep is None:
            print("no report / unreadable JSON", file=sys.stderr)
            return 1
        base = read_json(args[args.index("--base") + 1]) if "--base" in args else None
        errs = validate_report(rep, t, base)
        if errs:
            print("invalid: " + "; ".join(errs), file=sys.stderr)
            return 1
        print("valid")
        return 0
    if cmd == "mark-enriched":
        # Callers: pr-report.sh after validate; ai-intern/worker.py after merge_enrichment.
        # Optional --generator stamps "jira-ai-intern · local · qwen2.5-coder:7b".
        rep = read_json(report_path(key))
        if rep is None:
            return 1
        gen = None
        if "--generator" in args:
            i = args.index("--generator")
            if i + 1 < len(args):
                gen = args[i + 1]
        rep["enriched"] = True
        rep["enrichedAt"] = now_iso()
        rep["generator"] = gen or f"{((cfg.get('connector') or {}).get('active')) or 'agent'} · {((cfg.get('models') or {}).get('report')) or 'auto'}"
        rep["warnings"] = [w for w in (rep.get("warnings") or []) if "AI enrichment pass" not in w and "File-only AI" not in w]
        for tb in rep.get("tabs") or []:
            if tb.get("id") == "sources":
                for b in tb.get("blocks") or []:
                    for it in b.get("items") or []:
                        if isinstance(it, dict) and it.get("label") == "AI enrichment":
                            it["value"], it["tone"] = f"run {rep['enrichedAt']}", "violet"
        write_json_atomic(report_path(key), rep)
        return 0
    print(f"unknown command {cmd}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
