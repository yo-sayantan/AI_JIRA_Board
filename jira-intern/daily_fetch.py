#!/usr/bin/env python3
"""Daily jira-intern fetch: active tickets only; preserves completed[] archive."""
import copy
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import checkmarx  # noqa: E402
import devinfo  # noqa: E402  (needs the path fix above when run from another cwd)
import dynatrace  # noqa: E402
import jenkins  # noqa: E402
import _sources  # noqa: E402
from _config import bitbucket_hints, identity, today_str  # noqa: E402
from _jira import (  # noqa: E402
    BITBUCKET_BASE,
    CONFLUENCE_BASE,
    EXCLUDE_PROJECTS,
    FIELDS,
    ISSUE_KEY_RE,
    JIRA_BASE,
    REQUIRED_APPROVALS,
    ac_list,
    build_update_log,
    changelog_done_date,
    comments_for,
    is_excluded,
    iso,
    issue_links,
    jira_get,
    light_html,
    load_env,
    person_fmt,
    search_jira,
    status_column,
    story_points,
    wiki_to_html,
)
from _jira import bb_get as _bb_get  # noqa: E402
from _sprint import apply_sprint  # noqa: E402
from datafile import atomic_dump, data_lock, prepend_status, read_json, write_outputs  # noqa: E402
from progress import clear_progress, set_progress  # noqa: E402
from qa_rules import is_qa_ticket, qa_column  # noqa: E402
from raised import build_raised_row, fetch_raised  # noqa: E402

INTERN = os.path.dirname(os.path.abspath(__file__))
# Host-only form, used to recognise Confluence links among a ticket's remote links.
CONFLUENCE_HOST = CONFLUENCE_BASE.split("://")[-1].split("/")[0] if CONFLUENCE_BASE else ""
_ME = identity(INTERN)
USER = {"name": _ME["name"], "accountId": _ME["accountId"], "jiraBase": JIRA_BASE}
MY_ACCOUNT = _ME["accountId"].upper()
MY_EMAIL = _ME["email"].upper()

# Bitbucket key-scan hints — config → bitbucket.repoHints / bitbucket.projectMap, keyed by Jira
# project. Both empty by default: a ticket whose project has no entry is never scanned, and
# no project or repository name is built into the code.
_BB_HINTS = bitbucket_hints(INTERN)
REPO_HINTS = _BB_HINTS["repoHints"]
BB_PROJECT = _BB_HINTS["projectMap"]

BB_OK = True

# Branches/PRs/reviews for every key in this run, prefetched in one parallel batch from
# Jira's dev-status API (see devinfo.py). A key missing from the map means the lookup
# FAILED — never that the ticket has no code — so callers fall back instead of wiping data.
DEV = {}

# Tickets (and their sub-tasks) are built this many at a time — Settings → Parallel refresh.
WORKERS = max(1, min(16, int(os.environ.get("REFRESH_WORKERS") or 8)))
# Ticket builds nest Bitbucket fan-outs (repos × states per PR scan), so cap requests in flight.
_BB_SLOTS = threading.BoundedSemaphore(16)


def bb_get(path, *, mark_down=True):
    global BB_OK
    try:
        with _BB_SLOTS:
            return _bb_get(path)
    except Exception as e:
        if mark_down and BB_OK:
            BB_OK = False
            sys.stderr.write(f"WARN bitbucket unreachable ({path}): {e} — PR data carried forward this run\n")
        raise


def _utc_now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

def pr_to_obj(pr, bb_proj=None):
    if not pr:
        return None
    st = (pr.get("state") or "").upper()
    pid = pr.get("id")
    from_ref = pr.get("fromRef") or {}
    to_ref = pr.get("toRef") or {}
    repo = from_ref.get("repository") or {}
    project = bb_proj or (repo.get("project") or {}).get("key")
    slug = repo.get("slug", "")
    url = f"{BITBUCKET_BASE}/projects/{project}/repos/{slug}/pull-requests/{pid}" if project and slug and BITBUCKET_BASE else None
    merged = st == "MERGED"
    declined = st == "DECLINED" or st == "REJECTED"
    reviewers_raw = pr.get("reviewers") or []
    approvals = sum(1 for r in reviewers_raw if r.get("approved"))
    needs_work = sum(1 for r in reviewers_raw if r.get("status") == "NEEDS_WORK")
    reviewers = [((r.get("user") or {}).get("displayName")) for r in reviewers_raw if (r.get("user") or {}).get("displayName")]
    # Activity pages are only needed while a PR is still reviewable — merged/declined PRs
    # get fixed stats (saves 1-3 Bitbucket calls per closed PR).
    if project and slug and pid and not (merged or declined):
        with _BB_SLOTS:  # devinfo calls Bitbucket directly, outside bb_get's cap
            ct, cr, open_c = devinfo.pr_comment_stats(project, slug, pid)
    else:
        ct, cr, open_c = 0, 0, 0
    if merged:
        pstate = "merged"
        open_c = 0
        cr = ct
    elif declined:
        pstate = "declined"
    elif needs_work:
        pstate = "changes"
    elif approvals >= REQUIRED_APPROVALS and open_c == 0:
        pstate = "approved"
    else:
        pstate = "comments"
    return {
        "state": pstate,
        "id": pid,
        "title": pr.get("title"),
        "url": url,
        "approvals": approvals,
        "openComments": open_c,
        "commentsTotal": ct,
        "commentsResolved": cr,
        "reviewers": reviewers,
        "sourceBranch": from_ref.get("displayId"),
        "destinationBranch": to_ref.get("displayId"),
        "repo": slug or None,
        "merged": merged,
        "mergedAt": iso(pr.get("closedDate")) if merged else None,
        "updatedAt": iso(pr.get("updatedDate")),
    }


def _pr_identity(p):
    """PR numbers are per repository, so the same number in two repos is two different PRs."""
    m = devinfo._PR_URL_RE.search(p.get("url") or "")
    if m:
        proj, slug, pid = m.groups()
        return (proj.upper(), slug.lower(), pid)
    return (None, (p.get("repo") or "").lower(), str(p.get("id")))


def bb_search_all_prs(key):
    """All PRs referencing this ticket key. The repo×state listings are independent HTTP
    calls, so they run concurrently — wall-clock is one round-trip, not repos×3."""
    proj_prefix = key.split("-")[0].upper()
    bb_proj = BB_PROJECT.get(proj_prefix)
    repos = REPO_HINTS.get(proj_prefix) or []
    if not bb_proj or not repos:
        return []  # no hints configured for this project — nothing to scan
    key_u = key.upper()
    key_src = key.replace("-", "_").upper()
    combos = [(slug, state) for slug in repos for state in ("OPEN", "MERGED", "DECLINED")]

    def list_prs(combo):
        slug, state = combo
        try:
            q = urllib.parse.urlencode({"state": state, "limit": 100, "order": "NEWEST"})
            data = bb_get(f"/projects/{bb_proj}/repos/{slug}/pull-requests?{q}", mark_down=False)
            return data.get("values") or []
        except Exception as e:
            sys.stderr.write(f"WARN bitbucket PR scan {bb_proj}/{slug} ({state}): {e}\n")
            return []

    found, seen = [], set()
    with ThreadPoolExecutor(max_workers=min(8, len(combos))) as ex:
        for (slug, _state), values in zip(combos, ex.map(list_prs, combos)):
            for pr in values:
                title = (pr.get("title") or "").upper()
                src = ((pr.get("fromRef") or {}).get("displayId") or "").upper()
                if key_u in title or key_u in src or key_src in src:
                    ident = (slug, pr.get("id"))
                    if ident not in seen:
                        seen.add(ident)
                        obj = pr_to_obj(pr, bb_proj)
                        if obj:
                            found.append(obj)
    return found


def code_for(key, prior=None, parent_key=None):
    """Branches + PRs for one ticket, or None when nothing could be looked up.

    Only the ticket's OWN code: a PR naming other tickets and not this one is theirs
    (devinfo.scope_to_ticket), and a sub-task (`parent_key`) also loses any PR or branch it merely
    shares with its parent because its commits sit on the parent's branch (scope_to_subtask).

    Jira's dev-status index is authoritative and repo-agnostic, so it leads. The Bitbucket
    key-scan (up to repos × 3 listings per ticket) only runs when dev-status has no PRs for
    the ticket, which is the symptom of the Jira↔Bitbucket link being down."""
    dev = DEV.get(key)
    prs = list(dev["prs"]) if dev else []
    branches = list(dev["branches"]) if dev else []

    if BB_OK and not prs:
        try:
            for extra in bb_search_all_prs(key):
                prs.append(extra)
                if extra.get("sourceBranch"):
                    branches.append(extra["sourceBranch"])
        except Exception as e:
            sys.stderr.write(f"WARN bitbucket PR scan {key}: {e}\n")
    elif dev is None:
        return None

    if dev is None:
        if not prs:
            return None
        # Without dev-status the key-scan only covered this project's hinted repos, so PRs
        # seen earlier anywhere else are kept rather than wiped.
        have = {_pr_identity(p) for p in prs}
        for old in (prior or {}).get("prs") or []:
            if _pr_identity(old) not in have:
                have.add(_pr_identity(old))
                prs.append(copy.deepcopy(old))
        branches += (prior or {}).get("branches") or []

    branches = list(dict.fromkeys(b for b in branches if b))
    info = devinfo.scope_to_ticket(key, {"branches": branches, "prs": prs, "times": (dev or {}).get("times")})
    if parent_key:
        info = devinfo.scope_to_subtask(key, info, DEV.get(parent_key))
    # The ticket's branch is the one with the newest commit (devinfo reads those times from
    # Bitbucket); last run's choice breaks the tie when no time could be read this run.
    return devinfo.settle(info, (prior or {}).get("branch"))


def apply_code(ticket, key, prior=None):
    """Overwrite a ticket's branch/PR fields from the live lookup. When the lookup could not
    be made, keep what `prior` had — by default the ticket itself, carried forward from the
    previous dump."""
    prior = ticket if prior is None else prior
    info = code_for(key, prior, ticket.get("parentKey"))
    if info is None:
        if prior is ticket:
            return ticket
        info = copy.deepcopy({
            "branches": prior.get("branches") or [],
            "prs": prior.get("prs") or [],
            "pr": prior.get("pr") or {"state": "none"},
            "branch": prior.get("branch"),
        })
    ticket["branches"] = info["branches"]
    ticket["prs"] = info["prs"]
    ticket["pr"] = info["pr"]
    ticket["branch"] = info["branch"]
    return ticket


def apply_builds(ticket, key, prior=None):
    """Latest Jenkins build per environment and pipeline for the ticket's branches (jenkins.py: the
    explicit jenkins.jobs, plus the pipelines discovered under the Jenkins root), stored as `builds`.
    The branches are the ticket's OWN, already scoped by code_for — so a sub-task never picks up
    builds of its parent's branch. Carry-forward rules, as for PRs:
      • Jenkins not configured (no jenkins.jobs and no root, or no JENKINS_USER / JENKINS_API_TOKEN)
        → nothing is asked and `prior`'s builds are kept as they were;
      • the lookup failed (network, auth) → `prior`'s builds are kept (a partial failure keeps the
        prior build for just the pipelines that failed); so are the builds of a repository whose
        discovery failed with no cached answer to fall back on;
      • no branch in a configured / discovered repo, or Jenkins has no build for any of them → no `builds`.
    `prior` defaults to the ticket itself (the fast path's deep copy of the previous card)."""
    prior = ticket if prior is None else (prior or {})
    prior_builds = prior.get("builds") if isinstance(prior.get("builds"), list) else None

    def keep(stale=False):
        if prior_builds:
            ticket["builds"] = [{**b, "stale": True} if stale and isinstance(b, dict) else b for b in copy.deepcopy(prior_builds)]
        return ticket

    jobs = jenkins.jobs_config()
    if not jenkins.enabled(jobs):
        return keep()
    repos = (DEV.get(key) or {}).get("repos")
    discovered, failed = jenkins.discovery_for(jenkins.candidate_repos(ticket, repos))
    targets = jenkins.targets_for(ticket, repos, jobs, discovered)
    # A repository whose pipelines could not be discovered keeps the builds it had (marked stale).
    lost = [{**b, "stale": True} for b in copy.deepcopy(prior_builds or []) if isinstance(b, dict) and any(jenkins._norm(b.get("repo")) == jenkins._norm(f) for f in failed)]
    if not targets:
        if lost:
            ticket["builds"] = lost
        else:
            ticket.pop("builds", None)
        return ticket
    builds = jenkins.builds_for(targets, prior_builds)
    if builds is None:
        return keep(stale=True)  # Jenkins could not be read: carried forward, marked stale
    seen = {(b.get("repo"), b.get("env"), b.get("pipeline"), b.get("branch")) for b in builds}
    builds += [b for b in lost if (b.get("repo"), b.get("env"), b.get("pipeline"), b.get("branch")) not in seen]
    # A failed build of a ticket about a build / pipeline failure carries the scrubbed tail of its console.
    jenkins.add_console_tails(ticket, builds, targets, prior_builds)
    if builds:
        ticket["builds"] = builds
    else:
        ticket.pop("builds", None)
    return ticket


# What a vulnerability-fix ticket with no (fresh) Checkmarx answer says in its Vulnerabilities group.
PROOF_NOTE_TEXT = {
    "not-configured": "Checkmarx not configured — add the URL and key in API keys",
    "auth-failed": "Checkmarx rejected the API key — results not refreshed",
    "unreachable": "Checkmarx could not be reached — results not refreshed",
    "budget-exhausted": "Checkmarx call budget for this fetch was used up — results not refreshed",
}


DYNATRACE_NOTE_TEXT = {
    "not-configured": "Dynatrace not configured — add DYNATRACE_PAT and DYNATRACE_TENANTS in API keys",
    "auth-failed": "Dynatrace rejected the token — linked traces and problems not refreshed",
    "unreachable": "Dynatrace could not be reached — linked traces and problems not refreshed",
    "budget-exhausted": "Dynatrace call budget for this fetch was used up — linked traces and problems not refreshed",
}
NOTE_TEXT = {"checkmarx": PROOF_NOTE_TEXT, "dynatrace": DYNATRACE_NOTE_TEXT}


def _proof_note(ticket, source, state=None):
    """Set (state given) or clear `ticket.proofNotes[source]`: why this ticket has no fresh answer from the source."""
    notes = dict(ticket.get("proofNotes") or {})
    if state:
        before = notes.get(source) if isinstance(notes.get(source), dict) else {}
        # `at` = since when the ticket has been in this state: an unchanged state keeps its stamp, so a fast-path
        # refresh every few minutes does not rewrite the card.
        at = before.get("at") if before.get("state") == state and before.get("at") else _utc_now()
        notes[source] = {"state": state, "detail": NOTE_TEXT.get(source, PROOF_NOTE_TEXT)[state], "at": at}
    else:
        notes.pop(source, None)
    if notes:
        ticket["proofNotes"] = notes
    else:
        ticket.pop("proofNotes", None)


def apply_vuln_fixes(ticket, key, prior=None):
    """Which vulnerabilities a vulnerability-fix ticket fixed, from Checkmarx One (checkmarx.py),
    stored as `vulnFixes`. Same carry-forward rules as builds and PRs:
      • not a vulnerability-fix ticket, it names no CVE / query / CWE / result / package, or it has
        no pull request (or known-repo branch) to compare → no `vulnFixes` (nothing is asked);
      • Checkmarx not configured (no base URL or CHECKMARX_API_KEY) → nothing is asked and
        `prior`'s results are kept as they were;
      • the lookup failed (network, auth, budget) → `prior`'s results are kept.
    The PRs are the ticket's OWN, already scoped by code_for — a sub-task never inherits its
    parent's scan. `prior` defaults to the ticket itself (the fast path's copy of the last card).
    Nothing is silent: every ticket is reported to `_sources` (skipped / looked up / waiting, for the run's
    "Checkmarx: …" line) and a candidate that gets no fresh answer carries `proofNotes.checkmarx` — the reason
    the drawer shows in its Vulnerabilities group."""
    prior = ticket if prior is None else (prior or {})
    prior_vf = prior.get("vulnFixes") if isinstance(prior.get("vulnFixes"), dict) else None

    def keep(state, reason=""):
        _sources.waiting("checkmarx", key, state, reason)
        _proof_note(ticket, "checkmarx", state)
        if prior_vf:
            ticket["vulnFixes"] = copy.deepcopy(prior_vf)
        return ticket

    def drop(why=None):
        if why:
            _sources.skipped("checkmarx", key, why)
        _proof_note(ticket, "checkmarx")
        ticket.pop("vulnFixes", None)
        return ticket

    if not checkmarx.is_vuln_fix(ticket):
        return drop()
    targets = checkmarx.extract_targets(ticket)
    repos = (DEV.get(key) or {}).get("repos")
    if not targets:
        return drop("no-targets")
    if not checkmarx.scan_plan(ticket, repos):
        return drop("no-plan")
    if not checkmarx.enabled():
        return keep("not-configured")
    found = checkmarx.vuln_fixes_for(ticket, targets, repos)
    if found is None:
        state, reason = checkmarx.failure() or ("unreachable", "Checkmarx could not be read")
        return keep(state, reason)
    _sources.looked("checkmarx", key, [i.get("status") for i in found.get("items") or []])
    _proof_note(ticket, "checkmarx")
    ticket["vulnFixes"] = found
    return ticket


DYNATRACE_NOUN = "ticket|with Dynatrace links"


def apply_dynatrace(ticket, key, prior=None):
    """What Dynatrace says about the Dynatrace links in the ticket's text (dynatrace.py), stored as `dynatrace`. Same
    carry-forward rules as builds, PRs and vulnerability fixes:
      • no Dynatrace link in the ticket's text → no `dynatrace` (nothing is asked, nobody is told);
      • Dynatrace not configured (no DYNATRACE_PAT / DYNATRACE_TENANTS) → nothing is asked and `prior`'s answer is kept;
      • a lookup that failed (network, token, budget) → that link's previous answer is kept, marked `stale`;
      • a link to a tenant that is not listed is stored as `unconfigured-tenant` and never fetched;
      • a recent answer is not asked for again (a read link: 24 h, an open problem: 1 h, an empty answer: 1 h).
    Only tickets that HAVE such a link are touched (a cheap text search first). Nothing is silent: every candidate is
    reported to `_sources` (looked up / waiting) and one without a fresh answer carries `proofNotes.dynatrace`.
    `prior` defaults to the ticket itself (the fast path's copy of the last card)."""
    prior = ticket if prior is None else (prior or {})
    prior_ev = prior.get("dynatrace") if isinstance(prior.get("dynatrace"), dict) else None
    if not dynatrace.has_links(ticket):
        ticket.pop("dynatrace", None)
        _proof_note(ticket, "dynatrace")
        return ticket
    try:
        got = dynatrace.lookup(ticket, prior_ev)
    except Exception as e:  # noqa: BLE001 — links are other people's text: a parse bug must never take the whole fetch down
        sys.stderr.write(f"WARN dynatrace lookup for {key} failed unexpectedly ({type(e).__name__}); the previous answer is kept\n")
        got = {"evidence": copy.deepcopy(prior_ev) if prior_ev else None, "waiting": ("unreachable", "the Dynatrace lookup failed unexpectedly"), "statuses": [], "flagged": False, "links": 1}
    if not got["links"]:
        ticket.pop("dynatrace", None)
        _proof_note(ticket, "dynatrace")
        return ticket
    if got["evidence"]:
        ticket["dynatrace"] = got["evidence"]
    else:
        ticket.pop("dynatrace", None)
    if got["waiting"]:
        state, reason = got["waiting"]
        _sources.waiting("dynatrace", key, state, reason)
        _proof_note(ticket, "dynatrace", state)
    else:
        _sources.looked("dynatrace", key, got["statuses"], flagged=got["flagged"])
        _proof_note(ticket, "dynatrace")
    return ticket


def proof_sources_status():
    """The run's per-source account (`_sources`) — stored as data.json → proofSources[source], and its line goes to the
    run notes. Checkmarx and Dynatrace so far; Jenkins joins by adding its own `_sources.finish` call here."""
    cx_gap = ", ".join(checkmarx.missing_settings()) if not checkmarx.enabled() else None
    dt_gap = ", ".join(dynatrace.missing_settings()) if not dynatrace.enabled() else None
    return {
        "checkmarx": _sources.finish("checkmarx", "Checkmarx", "vulnerability-fix ticket", gap=cx_gap),
        "dynatrace": _sources.finish("dynatrace", "Dynatrace", DYNATRACE_NOUN, gap=dt_gap, statuses=("read", "empty", "unconfigured-tenant"),
                                     unit="link", flag="with failed requests or problems"),
    }


def is_mine(assignee):
    """Is this Jira user me? Exact (case-insensitive) match on the identifier fields; the
    display name only counts when it contains my id as a whole word — "ABC12" must not match
    "ABC123", and a substring test used to do exactly that."""
    if not assignee or not MY_ACCOUNT:
        return False
    for field in ("name", "key", "accountId", "emailAddress"):
        value = str(assignee.get(field) or "").strip().upper()
        if value and (value == MY_ACCOUNT or (MY_EMAIL and value == MY_EMAIL)):
            return True
    display = str(assignee.get("displayName") or "").upper()
    return bool(display) and re.search(rf"(?<![A-Z0-9]){re.escape(MY_ACCOUNT)}(?![A-Z0-9])", display) is not None


QA_WINDOW = "(statusCategory != Done OR resolved >= -10d)"


def _issue_is_qa(issue):
    f = issue.get("fields") or {}
    return is_qa_ticket((f.get("issuetype") or {}).get("name"), f.get("summary"), f.get("labels"))


def fetch_qa_extras(issue_map):
    """QA tickets that are NOT assigned to me but belong on my board: ones I raised (reporter = me) and ones
    linked to a ticket of mine. QA work is someone else's to do, so the assignee search never finds it.
    Returns ([issues with full fields + changelog], ok); a failed lookup is ok=False, never "none exist"."""
    try:
        found = {}
        reported = search_jira(f"reporter = currentUser() AND {QA_WINDOW} ORDER BY updated DESC")
        for i in reported:
            if i.get("key") not in issue_map and _issue_is_qa(i):
                found[i["key"]] = i
        # Linked to one of mine. The link carries only type + title, which is all the test needs
        # (labels are checked on the fully fetched issue below).
        linked = {}
        for issue in issue_map.values():
            for link in (issue.get("fields") or {}).get("issuelinks") or []:
                other = link.get("outwardIssue") or link.get("inwardIssue") or {}
                of = other.get("fields") or {}
                key = other.get("key")
                if key and key not in issue_map and key not in found and is_qa_ticket((of.get("issuetype") or {}).get("name"), of.get("summary")):
                    linked[key] = other
        wanted = list(found) + list(linked)
        out = []
        for n in range(0, len(wanted), 50):
            chunk = wanted[n : n + 50]
            out.extend(search_jira("key in (" + ",".join(chunk) + f") AND {QA_WINDOW} ORDER BY key ASC", expand="changelog"))
        return [i for i in out if not is_excluded(i.get("key"))], True
    except Exception as e:  # noqa: BLE001
        sys.stderr.write(f"WARN QA-ticket lookup failed, carrying earlier ones forward: {e}\n")
        return [], False


def extract_links(*texts, prior_conf=None, prior_ext=None):
    conf, ext, seen = [], [], set()
    for block in (prior_conf or []):
        u = block.get("url")
        if u and u not in seen:
            seen.add(u)
            conf.append(copy.deepcopy(block))
    for block in (prior_ext or []):
        u = block.get("url")
        if u and u not in seen:
            seen.add(u)
            ext.append(copy.deepcopy(block))

    def add_url(url, title=None):
        if not url or url in seen:
            return
        seen.add(url)
        title = title or url
        if (CONFLUENCE_HOST and CONFLUENCE_HOST in url) or "confluence" in url.lower():
            conf.append({"title": title, "url": url, "excerpt": next((c.get("excerpt") for c in (prior_conf or []) if c.get("url") == url), None)})
        elif url.startswith("http"):
            ext.append({"title": title, "url": url, "reachable": True})

    for text in texts:
        if not text:
            continue
        for m in re.finditer(r'href=["\']([^"\']+)["\']', text, re.I):
            add_url(m.group(1))
        for m in re.finditer(r'\[([^\]|]+)\|([^\]]+)\]', text):
            add_url(m.group(2), m.group(1))
        for m in re.finditer(r'https?://[^\s<>"\']+', text):
            add_url(m.group(0).rstrip(".,;)"))

    return conf, ext


def build_basic_subtask(si, parent_key, prior=None):
    """Sub-task owned by someone else. Deliberately not a full brief (no comments/description),
    but it carries everything needed to judge the work from the board: who owns it, where it
    stands, and its real branches, pull requests and review state. A master ticket is usually
    delivered through other people's sub-tasks, and that review state is precisely what used
    to force a trip to Jira."""
    sf = si.get("fields") or {}
    sk = si["key"]
    status = (sf.get("status") or {}).get("name")
    col = qa_column(status_column(status), (sf.get("issuetype") or {}).get("name"), sf.get("summary"), sf.get("labels"))
    sub = {
        "key": sk,
        "title": sf.get("summary"),
        "status": status,
        "column": col,
        "type": (sf.get("issuetype") or {}).get("name"),
        "priority": (sf.get("priority") or {}).get("name"),
        "storyPoints": story_points(sf),
        "url": f"{JIRA_BASE}/browse/{sk}",
        "assignee": person_fmt(sf.get("assignee")),
        "reporter": person_fmt(sf.get("reporter")),
        "parentKey": parent_key,
        "done": col == "done",
        "onHold": col == "hold",
        "created": iso(sf.get("created")),
        "lastUpdate": iso(sf.get("updated")),
        "resolved": iso(sf.get("resolutiondate")) or (changelog_done_date(si.get("changelog")) if col == "done" else None),
        "commentCount": (sf.get("comment") or {}).get("total"),
        "branch": None,
        "branches": [],
        "pr": {"state": "none"},
        "prs": [],
    }
    apply_sprint(sub, sf.get("customfield_10404"))
    return apply_code(sub, sk, prior or {})


def refresh_prs_only(ticket, key):
    """Review activity lives in Bitbucket and does NOT bump Jira's `updated` — so even an
    otherwise-unchanged in-flight ticket needs its PR badges refreshed. Jenkins builds and
    Checkmarx scans do not bump it either, so they are re-read here too. Dynatrace answers age (a problem closes, spans
    arrive late), so the links are looked at again too — dynatrace.lookup skips what was read recently."""
    return apply_dynatrace(apply_vuln_fixes(apply_builds(apply_code(ticket, key), key), key), key)


def build_ticket(issue, prior, state_entry, force_refresh=False):
    f = issue.get("fields") or {}
    key = issue["key"]
    status = (f.get("status") or {}).get("name")
    itype = (f.get("issuetype") or {}).get("name")
    column = qa_column(status_column(status), itype, f.get("summary"), f.get("labels"))
    resolved = iso(f.get("resolutiondate")) or (changelog_done_date(issue.get("changelog")) if column == "done" else None)

    # ── Unchanged short-circuit — skips the expensive Jira side (comments, links, changelog).
    # Jira bumps `updated` on every edit/comment/transition, so matching (status, updated)
    # means the ticket TEXT is identical to what we already have. But some fields are driven
    # by an object that mutates independently of the issue, so `updated` says nothing about
    # them — each needs its own carve-out to stay live on this fast path:
    #   • Code state: approving, declining or merging a PR happens in Bitbucket and never
    #     touches Jira's `updated`, and a PR can still land after the ticket itself is closed.
    #   • Sprint: starting/closing a SPRINT edits the sprint object, not the issues in it, so
    #     an issue's `updated` never moves when its sprint goes future → active → closed. Jira
    #     still reports the sprint's CURRENT state on every read of customfield_10404 though —
    #     it's already in `f` from this run's search, so refreshing it here costs nothing.
    #     (Without this, a ticket can get stuck in the Next Sprint bar forever once its sprint
    #     starts, because the fast path was returning a stale, deep-copied `prior["sprint"]`.)
    prev = state_entry or {}
    if (
        prior and not force_refresh
        and prev.get("status") == status
        and prev.get("last_update") == iso(f.get("updated"))
    ):
        ticket = copy.deepcopy(prior)
        ticket["column"] = column  # the status → column rules can change between runs (e.g. a QA ticket's lane)
        if ticket.get("resolved") and column != "done":
            ticket["resolved"] = None  # self-heal: a reopened ticket must not keep a resolved date
        apply_sprint(ticket, f.get("customfield_10404"))
        return refresh_prs_only(ticket, key)

    comments, comment_count, latest_comment = comments_for(key, f)

    epic_key = f.get("customfield_10405")
    parent = f.get("parent")
    epic = None
    if epic_key:
        epic = {"key": epic_key, "url": f"{JIRA_BASE}/browse/{epic_key}", "relation": "epic (parent)"}
    elif parent:
        pk = parent.get("key")
        epic = {"key": pk, "url": f"{JIRA_BASE}/browse/{pk}", "relation": "parent"}

    desc_html = light_html(wiki_to_html(f.get("description")))
    conf, ext = extract_links(
        f.get("description"), *[c.get("body") for c in comments],
        prior_conf=(prior or {}).get("confluence"),
        prior_ext=(prior or {}).get("externalLinks"),
    )

    # Branches/PRs from Jira dev-status (+ Bitbucket supplement); carry forward on failure.
    info = code_for(key, prior, (f.get("parent") or {}).get("key"))
    if info is None:
        prs = copy.deepcopy((prior or {}).get("prs") or [])
        branches = copy.deepcopy((prior or {}).get("branches") or [])
        pr = (prior or {}).get("pr") or {"state": "none"}
        branch = (prior or {}).get("branch")
    else:
        prs, branches, pr, branch = info["prs"], info["branches"], info["pr"], info["branch"]

    update_log = build_update_log(
        key, f.get("created"), status, resolved, issue.get("changelog"), (prior or {}).get("updateLog")
    )

    def carry_ai_fields(ticket_obj):
        """aiSummary is written by the AI intern's summarize-active job — never drop it on refresh."""
        if prior:
            if prior.get("aiSummary") and not ticket_obj.get("aiSummary"):
                ticket_obj["aiSummary"] = prior["aiSummary"]
            if prior.get("aiSummaryAt") and not ticket_obj.get("aiSummaryAt"):
                ticket_obj["aiSummaryAt"] = prior["aiSummaryAt"]
            if prior.get("aiSummaryEvidence") and not ticket_obj.get("aiSummaryEvidence"):
                ticket_obj["aiSummaryEvidence"] = prior["aiSummaryEvidence"]
        return ticket_obj

    ticket = {
        "key": key,
        "title": f.get("summary"),
        "status": status,
        "column": column,
        "type": itype,
        "priority": (f.get("priority") or {}).get("name"),
        "storyPoints": story_points(f),
        "branch": branch,
        "branches": branches,
        "pr": pr if pr else {"state": "none"},
        "prs": prs,
        "commentCount": comment_count,
        "latestComment": latest_comment,
        "lastUpdate": iso(f.get("updated")),
        "created": iso(f.get("created")),
        "resolved": resolved,
        "done": column == "done",
        "onHold": column == "hold",
        "url": f"{JIRA_BASE}/browse/{key}",
        "reporter": person_fmt(f.get("reporter")),
        "assignee": person_fmt(f.get("assignee")),
        "epic": epic,
        "parentKey": parent.get("key") if parent else None,
        "labels": f.get("labels") or [],
        "components": [c.get("name") for c in f.get("components") or [] if c.get("name")],
        "fixVersions": [v.get("name") for v in f.get("fixVersions") or [] if v.get("name")],
        "description": desc_html,
        "acceptanceCriteria": ac_list(f.get("customfield_10700")),
        "comments": comments,
        "related": issue_links(f),
        "confluence": conf,
        "externalLinks": ext,
        "proposedSolution": (prior or {}).get("proposedSolution"),
        "effortEstimate": (prior or {}).get("effortEstimate"),
        "openQuestions": (prior or {}).get("openQuestions") or [],
        "sources": (prior or {}).get("sources") or [{"title": f"Jira {key}", "url": f"{JIRA_BASE}/browse/{key}"}],
        "updateLog": update_log,
    }
    apply_sprint(ticket, f.get("customfield_10404"))
    apply_builds(ticket, key, prior or {})
    apply_vuln_fixes(ticket, key, prior or {})
    apply_dynatrace(ticket, key, prior or {})
    if (prior or {}).get("estDays"):
        ticket["estDays"] = prior["estDays"]

    # New assignment
    if not state_entry and not prior:
        day = today_str(INTERN)
        ticket["updateLog"].insert(0, {"when": day, "text": "Assigned — initial brief"})
    elif prev.get("status") != status or prev.get("comments") != comment_count:
        day = today_str(INTERN)
        if prev.get("status") != status:
            ticket["updateLog"].insert(0, {"when": day, "text": status})
        if prev.get("comments") != comment_count and comment_count > (prev.get("comments") or 0):
            ticket["updateLog"].insert(0, {"when": day, "text": f"New comment ({comment_count})"})

    return carry_ai_fields(ticket)


def build_subtasks(parent_key, sub_issues, prior_map, state, pool=None):
    """Sub-tasks from the single batched `parent in (…)` search — the issues already carry
    full FIELDS + changelog, so no per-subtask GETs. Mine → full brief; others → basic.
    With `pool`, sub-tasks build concurrently; order is kept either way."""
    prior_subs = {s.get("key"): s for s in (prior_map.get(parent_key) or {}).get("subtasks") or []}

    def one(si):
        sk = si["key"]
        prior = prior_map.get(sk) or prior_subs.get(sk)
        if is_mine((si.get("fields") or {}).get("assignee")):
            full = build_ticket(si, prior, state.get(sk))
            full["parentKey"] = parent_key
            return full
        return build_basic_subtask(si, parent_key, prior)

    if pool is None or len(sub_issues) < 2:
        return [one(si) for si in sub_issues]
    return list(pool.map(one, sub_issues))


def _issue_ids(*groups):
    """key → numeric id for issues already fetched, so devinfo skips its own id search."""
    return {i["key"]: i["id"] for group in groups for i in group if i.get("id")}


def ticket_to_state(t):
    pr = t.get("pr") or {}
    return {
        "title": t.get("title"), "status": t.get("status"), "column": t.get("column"),
        "type": t.get("type"), "priority": t.get("priority"),
        "story_points": t.get("storyPoints"), "branch": t.get("branch"),
        "est_days": t.get("estDays"), "pr_state": pr.get("state"),
        "pr_comments": pr.get("openComments"),
        "comments": t.get("commentCount"), "latest_comment": t.get("latestComment"),
        "last_update": t.get("lastUpdate"), "done": t.get("done", False),
    }


def main():
    load_env()
    existing_path = os.path.join(INTERN, "data.json")
    state_path = os.path.join(INTERN, ".state.json")
    set_progress("daily", done=0, total=0, phase="starting")

    try:
        return _main(existing_path, state_path)
    finally:
        clear_progress()


def _main(existing_path, state_path):
    global BB_OK, DEV

    if not os.environ.get("JIRA_PERSONAL_TOKEN"):
        if not os.path.isfile(existing_path):
            raise SystemExit("No JIRA token and no existing data.json")
        # Never invent data: re-stamp the last known dump with a notice, log it, and stop with
        # the same exit code / error shape as completed_archive so the runner can tell.
        note = f"{today_str(INTERN)}: Jira unavailable (no token) — showing last known state"
        with data_lock(INTERN):
            out = copy.deepcopy(read_json(existing_path, {}) or {})
            out["generatedAt"] = _utc_now()
            out["notes"] = [note]
            write_outputs(out)
        prepend_status(note)
        print(json.dumps({"error": "no jira token", "stopped": True, "note": note}, indent=2))
        raise SystemExit(2)

    existing = read_json(existing_path, None) or {"tickets": [], "completed": []}
    completed_preserved = copy.deepcopy(existing.get("completed") or [])
    raised_preserved = copy.deepcopy(existing.get("raised") or [])
    try:
        state = read_json(state_path, {}) or {}
    except Exception as e:
        # corrupt hidden memory just means "treat everything as changed" — never fatal
        sys.stderr.write(f"WARN .state.json unreadable, rebuilding every ticket: {e}\n")
        state = {}

    prior_map = {t["key"]: t for t in existing.get("tickets", [])}
    carried_qa = []
    jenkins.reset_run()
    checkmarx.reset_run()
    dynatrace.reset_run()

    # Probe Bitbucket once; the key-scan supplement is skipped for the run when it is down.
    BB_OK = True
    try:
        bb_get("/projects?limit=1")
    except Exception:
        BB_OK = False

    # Fetch window (-10d) is wider than the board's "recent win" display window (app.doneBoardDays,
    # default 5) on purpose: the app hides done tickets after that many days and the weekly job
    # archives them — a ticket must never drop out of tickets[] before it has landed in completed[].
    # expand=changelog rides along with the search — updateLog and the resolved-date fallback
    # come from this single query instead of one extra GET per ticket.
    set_progress("daily", done=0, total=0, phase="searching")
    jql = "(assignee = currentUser() AND statusCategory != Done) OR (assignee = currentUser() AND statusCategory = Done AND resolved >= -10d)"
    issues = search_jira(jql + " ORDER BY updated DESC", expand="changelog")
    # Drop excluded projects (config → excludeProjects) so they never reach the board.
    if EXCLUDE_PROJECTS:
        issues = [i for i in issues if not is_excluded(i.get("key"))]
    active_keys, issue_map = [], {}
    for i in issues:
        if i["key"] not in issue_map:
            issue_map[i["key"]] = i
            active_keys.append(i["key"])
    # QA tickets raised by me / linked to my tickets ride the same pipeline (sub-tasks, PRs, build).
    qa_issues, qa_ok = fetch_qa_extras(issue_map)
    for i in qa_issues:
        if i["key"] not in issue_map:
            issue_map[i["key"]] = i
            active_keys.append(i["key"])
    if not qa_ok:
        # "Couldn't look" is not "there are none": keep the QA tickets the board already had.
        for k, t in prior_map.items():
            if k not in issue_map and is_qa_ticket(t.get("type"), t.get("title"), t.get("labels")):
                carried_qa.append(t)

    total = len(active_keys)
    set_progress("daily", done=0, total=total, phase="subtasks")

    # ONE batched search for every parent's sub-tasks (instead of one search per ticket,
    # plus one GET per sub-task of mine). None ⇒ the search itself failed (≠ "no subtasks"),
    # so existing subtask lists are carried forward rather than wiped.
    subs_by_parent = {}
    if active_keys:
        try:
            sub_issues = search_jira(
                "parent in (" + ",".join(active_keys) + ") ORDER BY key ASC", expand="changelog"
            )
            for si in sub_issues:
                pk = ((si.get("fields") or {}).get("parent") or {}).get("key")
                if pk:
                    subs_by_parent.setdefault(pk, []).append(si)
        except Exception as e:
            sys.stderr.write(f"WARN sub-task search failed, carrying existing sub-tasks forward: {e}\n")
            subs_by_parent = None

    # One parallel dev-status batch covering parents AND every sub-task, before any ticket is
    # built. Sub-tasks are included unconditionally: their PRs are the whole point of showing
    # a master ticket's children here.
    set_progress("daily", done=0, total=total, phase="devinfo")
    dev_keys = list(active_keys)
    for subs in (subs_by_parent or {}).values():
        dev_keys.extend(si["key"] for si in subs)
    # A sub-task of mine whose parent is someone else's ticket is judged against that parent's
    # code too (devinfo.scope_to_subtask), so the parent joins the batch.
    parent_ids = {}
    for i in issues:
        ref = (i.get("fields") or {}).get("parent") or {}
        if ref.get("key"):
            dev_keys.append(ref["key"])
            if ref.get("id"):
                parent_ids[ref["key"]] = ref["id"]
    try:
        DEV = devinfo.fetch_many(list(dict.fromkeys(dev_keys)), ids={**parent_ids, **_issue_ids(issues, *(subs_by_parent or {}).values())}, workers=WORKERS)
    except Exception as e:
        sys.stderr.write(f"WARN dev-status batch failed, PR data carried forward: {e}\n")
        DEV = {}

    changes = {"new": [], "refreshed": [], "done": []}
    tickets = []
    new_state = {}
    failed, carried = [], set()

    def build_one(key):
        prior = prior_map.get(key)
        ticket = build_ticket(issue_map[key], prior, state.get(key, {}), force_refresh=key not in state or not prior)
        if subs_by_parent is not None:
            subs = build_subtasks(key, subs_by_parent.get(key, []), prior_map, state, pool=sub_pool)
            if subs:
                ticket["subtasks"] = subs
                ticket["subtaskCount"] = len(subs)
            else:
                ticket.pop("subtasks", None)
                ticket["subtaskCount"] = 0
        return ticket

    built_lock = threading.Lock()
    built_count = [0]

    def on_built(key):
        with built_lock:
            built_count[0] += 1
            set_progress("daily", done=built_count[0], total=total, phase="building", current=key)

    def build_tracked(key):
        """One bad ticket (odd payload, restricted link, Jira hiccup) must not kill the whole
        refresh: log it, carry the previous card forward (or skip it when there is none)."""
        try:
            ticket = build_one(key)
        except Exception as e:
            sys.stderr.write(f"WARN build {key}: {e}\n")
            prior = prior_map.get(key)
            ticket = copy.deepcopy(prior) if prior else None
            with built_lock:
                failed.append(key)
                if ticket is not None:
                    carried.add(key)
        on_built(key)
        return ticket

    set_progress("daily", done=0, total=total, phase="building")
    # Separate pools: parents wait on their sub-tasks, so sharing one pool could deadlock.
    with ThreadPoolExecutor(max_workers=WORKERS) as sub_pool, \
            ThreadPoolExecutor(max_workers=max(1, min(WORKERS, total))) as pool:
        built = list(pool.map(build_tracked, active_keys))

    if active_keys and len(failed) == len(active_keys):
        print(json.dumps({"error": "every ticket build failed", "failed": failed[:10]}, indent=2))
        raise SystemExit(1)

    for key, ticket in zip(active_keys, built):
        if ticket is None:
            continue  # build failed and there was no previous card to keep
        prior = prior_map.get(key)
        prev_state = state.get(key, {})

        if key in carried:
            pass  # unchanged copy of the previous run — not news
        elif not prev_state and not prior:
            changes["new"].append(f"{key}: {(ticket.get('title') or '')[:60]}")
        elif ticket.get("done") and not prev_state.get("done"):
            changes["done"].append(key)
        elif (
            prev_state.get("status") != ticket.get("status")
            or prev_state.get("comments") != ticket.get("commentCount")
            or prev_state.get("last_update") != ticket.get("lastUpdate")
        ):
            parts = []
            if prev_state.get("status") != ticket.get("status"):
                parts.append(f"status → {ticket.get('status')}")
            if prev_state.get("comments") != ticket.get("commentCount"):
                parts.append(f"comments {prev_state.get('comments')}→{ticket.get('commentCount')}")
            changes["refreshed"].append(f"{key}: {', '.join(parts) if parts else 'updated'}")

        tickets.append(ticket)
        new_state[key] = ticket_to_state(ticket)
        # Nested sub-tasks get their own state too (same as refresh_one), so a later single-ticket
        # refresh of a sub-task has a baseline instead of logging everything as new.
        for s in ticket.get("subtasks") or []:
            if isinstance(s, dict) and s.get("key"):
                new_state[s["key"]] = ticket_to_state(s)

    for t in carried_qa:
        tickets.append(copy.deepcopy(t))
        new_state[t["key"]] = ticket_to_state(t)

    # Raised-by-me rides along with every daily run — one extra search, no per-ticket calls.
    set_progress("daily", done=total, total=total, phase="raised")
    raised_rows, raised_ok = fetch_raised(raised_preserved)

    set_progress("daily", done=total, total=total, phase="writing")
    day = today_str(INTERN)
    jenkins_down = jenkins.hosts_down()
    notes = [f"{day}: Daily fetch — Jira REST" + ("" if BB_OK else "; Bitbucket unreachable — PR/branch data carried forward")
             + ("; Jenkins unreachable — builds carried forward" if jenkins_down else "")
             + ("" if raised_ok else "; raised-tickets search failed — previous list kept") + "."]
    if changes["new"]:
        notes.append("New: " + ", ".join(k.split(":")[0] for k in changes["new"]))
    if changes["done"]:
        notes.append("Marked done: " + ", ".join(changes["done"]))
    if failed:
        notes.append("Build failed (previous card kept): " + ", ".join(failed))
    # What each proof source did this run — a skip is never silent (_sources.py): one line each, and the record
    # goes to data.json → proofSources so the board can show it too.
    proof_status = proof_sources_status()
    for status in proof_status.values():
        if _sources.noteworthy(status):
            notes.append(status["detail"])
            sys.stderr.write(f"INFO {status['detail']}\n")

    with data_lock(INTERN):
        # The archive may have rewritten completed[] while this run was talking to Jira — take
        # the newest copy on disk, not the snapshot from the start of the run (lost-update guard).
        try:
            latest = read_json(existing_path, None)
            if isinstance(latest, dict) and isinstance(latest.get("completed"), list):
                completed_preserved = latest["completed"]
        except Exception as e:
            sys.stderr.write(f"WARN data.json re-read before write failed, keeping the earlier completed[]: {e}\n")
        out = {
            "generatedAt": _utc_now(),
            "user": USER,
            "notes": notes,
            "tickets": tickets,
            "completed": completed_preserved,
            "raised": raised_rows,
            "raisedAt": _utc_now() if raised_ok else existing.get("raisedAt"),
            "proofSources": {**(existing.get("proofSources") or {}), **proof_status},
        }
        write_outputs(out)
        atomic_dump(state_path, new_state)

    # Keep _STATUS.md the audit log for script-driven runs too (the agent used to own this).
    changed = len(changes["new"]) + len(changes["refreshed"]) + len(changes["done"])
    summary = (
        f"new {len(changes['new'])} · refreshed {len(changes['refreshed'])} · done {len(changes['done'])}"
        if changed else "no new or changed tickets"
    )
    prepend_status(
        f"{day}: Daily fetch (fast path) — {len(tickets)} active ({summary}); "
        f"completed[] {len(completed_preserved)} preserved unchanged; "
        f"raised[] {len(raised_rows)}" + (" refreshed." if raised_ok else " carried forward (search failed).")
        + (f" {len(failed)} build(s) failed — previous card kept." if failed else "")
        + ("" if BB_OK else " Bitbucket unreachable — PR data carried forward.")
    )
    set_progress("daily", done=total, total=total, phase="done")
    return out, changes, notes


def fetch_issue(key):
    """One issue with the same FIELDS + changelog the daily search returns."""
    q = urllib.parse.urlencode({"expand": "changelog", "fields": FIELDS})
    return jira_get(f"/rest/api/2/issue/{urllib.parse.quote(key)}?{q}")


def _find_prior(data, key):
    """Locate an existing ticket object by key. A sub-task of mine is stored twice — as its own
    card and under its parent — so top-level rows are searched before any nested copy."""
    for section, where in (("tickets", "tickets"), ("completed", "completed")):
        for t in data.get(section) or []:
            if t.get("key") == key:
                return t, where
    for section in ("tickets", "completed"):
        for t in data.get(section) or []:
            for s in t.get("subtasks") or []:
                if s.get("key") == key:
                    return s, "subtask"
    return None, None


def _merge_ticket(data, ticket):
    """Replace EVERY copy of the ticket (its own card and any copy nested under a parent), or
    append when the key is new to the dump. Updating one copy left the other showing stale data."""
    key = ticket["key"]
    hits = set()
    for section in ("tickets", "completed"):
        rows = data.get(section) or []
        for i, row in enumerate(rows):
            if row.get("key") == key:
                rows[i] = ticket
                hits.add(section)
                continue
            subs = row.get("subtasks") or []
            for j, s in enumerate(subs):
                if s.get("key") == key:
                    subs[j] = ticket
                    hits.add("subtask")
    for where in ("tickets", "completed", "subtask"):
        if where in hits:
            return where
    # New to the dump — active board first; done tickets still land in tickets[] so the
    # "recent win" column can show them (same as the daily fetch window).
    data.setdefault("tickets", []).append(ticket)
    return "tickets-new"


def refresh_one(key):
    """Re-fetch ONE ticket from Jira and merge it into data.json / data.js.

    Used by refresh-ticket.sh so Docker (no cursor-agent) can still update a single card.
    Always force-rebuilds the ticket body — the user clicked refresh because they expect
    the latest status even when our .state.json short-circuit would skip work.
    """
    global BB_OK, DEV
    load_env()
    key = (key or "").strip().upper()
    if not key:
        raise SystemExit("refresh_one: missing key")
    if not ISSUE_KEY_RE.fullmatch(key):
        raise SystemExit("refresh_one: bad key")
    if is_excluded(key):
        raise SystemExit(f"refresh_one: {key} is in excludeProjects — refused")
    if not os.environ.get("JIRA_PERSONAL_TOKEN"):
        raise SystemExit("refresh_one: JIRA_PERSONAL_TOKEN missing")

    existing_path = os.path.join(INTERN, "data.json")
    state_path = os.path.join(INTERN, ".state.json")
    data = read_json(existing_path, None) or {"tickets": [], "completed": []}
    try:
        state = read_json(state_path, {}) or {}
    except Exception as e:
        sys.stderr.write(f"WARN .state.json unreadable: {e}\n")
        state = {}

    prior, prior_where = _find_prior(data, key)
    prior_map = {t["key"]: t for t in data.get("tickets") or []}
    if prior and prior_where == "subtask":
        prior_map[key] = prior

    jenkins.reset_run()
    checkmarx.reset_run()
    dynatrace.reset_run()
    # Skip Bitbucket entirely for single-ticket refresh. A hung BB from Docker was
    # timing out the shell (and before that, making the agent-only path look "successful"
    # while never writing). Status/column come from Jira; PR badges from Jira's own
    # dev-status (enrich_open=False). Setting BB_OK=False also stops code_for()'s
    # Bitbucket key-scan supplement.
    BB_OK = False

    issue = fetch_issue(key)
    # Sub-tasks of this parent (if any) — same batch shape as the daily path.
    subs_by_parent = {}
    try:
        sub_issues = search_jira(f"parent = {key} ORDER BY key ASC", expand="changelog")
        if sub_issues:
            subs_by_parent[key] = sub_issues
    except Exception as e:
        sys.stderr.write(f"WARN sub-task search for {key} failed, keeping the previous tree: {e}\n")
        subs_by_parent = None

    dev_keys = [key]
    for si in (subs_by_parent or {}).get(key, []):
        dev_keys.append(si["key"])
    parent_ref = (issue.get("fields") or {}).get("parent") or {}
    if parent_ref.get("key"):
        dev_keys.append(parent_ref["key"])  # a sub-task is judged against its parent's code
    try:
        # enrich_open=False: skip Bitbucket activity pages (30s timeouts each). Jira
        # dev-status still supplies branches/PRs/approvals — enough for the card badge.
        DEV = devinfo.fetch_many(
            list(dict.fromkeys(dev_keys)),
            ids={**_issue_ids([issue], (subs_by_parent or {}).get(key, [])),
                 **({parent_ref["key"]: parent_ref["id"]} if parent_ref.get("key") and parent_ref.get("id") else {})},
            workers=6,
            enrich_open=False,
        )
    except Exception as e:
        sys.stderr.write(f"WARN dev-status for {key} failed, PR data carried forward: {e}\n")
        DEV = {}

    ticket = build_ticket(issue, prior, state.get(key, {}), force_refresh=True)

    if subs_by_parent is not None:
        subs = build_subtasks(key, subs_by_parent.get(key, []), prior_map, state)
        if subs:
            ticket["subtasks"] = subs
            ticket["subtaskCount"] = len(subs)
        else:
            ticket.pop("subtasks", None)
            ticket["subtaskCount"] = 0
    elif prior and prior.get("subtasks"):
        # Search failed — keep the previous tree rather than wiping children.
        ticket["subtasks"] = copy.deepcopy(prior["subtasks"])
        ticket["subtaskCount"] = prior.get("subtaskCount") or len(ticket["subtasks"])

    # Parent link when refreshing a sub-task in isolation.
    parent = (issue.get("fields") or {}).get("parent")
    if parent and parent.get("key") and not ticket.get("parentKey"):
        ticket["parentKey"] = parent["key"]

    day = today_str(INTERN)
    with data_lock(INTERN):
        # Re-read under the lock: the daily fetch or the archive may have written data.json
        # while Jira was being queried, and merging into the stale copy would undo their work.
        data = read_json(existing_path, None) or {"tickets": [], "completed": []}
        raised_rows = data.get("raised") or []
        in_raised = any(r.get("key") == key for r in raised_rows)
        if in_raised:
            row = build_raised_row(issue)
            data["raised"] = [row if r.get("key") == key else r for r in raised_rows]
        # A QA ticket belongs on the board even when it is raised by me / assigned to someone else.
        if prior is None and in_raised and not is_mine((issue.get("fields") or {}).get("assignee")) and not _issue_is_qa(issue):
            where = "raised"
        else:
            where = _merge_ticket(data, ticket)
        data["generatedAt"] = _utc_now()
        note = f"{day}: Refreshed {key} (status={ticket.get('status')}, column={ticket.get('column')})."
        notes = list(data.get("notes") or [])
        notes = [note] + [n for n in notes if not (isinstance(n, str) and n.startswith(f"{day}: Refreshed {key}"))]
        data["notes"] = notes[:12]
        write_outputs(data)
        try:
            state = read_json(state_path, {}) or {}
        except Exception:
            state = {}
        state[key] = ticket_to_state(ticket)
        for s in ticket.get("subtasks") or []:
            if s.get("key"):
                state[s["key"]] = ticket_to_state(s)
        atomic_dump(state_path, state)

    # Optional per-ticket cache (same path the agent refresh wrote).
    cache_dir = os.path.join(INTERN, "cache")
    os.makedirs(cache_dir, exist_ok=True)
    atomic_dump(os.path.join(cache_dir, f"{key}.json"), ticket)

    prepend_status(f"{day}: Single-ticket refresh {key} → {ticket.get('status')} ({where}).")
    return data, ticket, where


def refresh_raised_only():
    """Re-fetch ONLY raised[] and merge it into data.json / data.js.

    Backs the Raised view's own refresh button (local-runner/refresh-raised.sh): tickets I
    reported but don't work are invisible to the normal board refresh, so this is the one
    cheap pull that keeps that list current without touching tickets[] or completed[].
    """
    load_env()
    if not os.environ.get("JIRA_PERSONAL_TOKEN"):
        raise SystemExit("refresh_raised: JIRA_PERSONAL_TOKEN missing")
    existing_path = os.path.join(INTERN, "data.json")
    data = json.load(open(existing_path)) if os.path.isfile(existing_path) else {"tickets": [], "completed": []}
    before = len(data.get("raised") or [])
    rows, ok = fetch_raised(data.get("raised") or [])
    if not ok:
        raise SystemExit("refresh_raised: Jira search failed — kept the previous list")
    data["raised"] = rows
    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    data["raisedAt"] = now_iso
    data["generatedAt"] = now_iso
    day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    note = f"{day}: Refreshed raised tickets ({len(rows)})."
    notes = [note] + [n for n in (data.get("notes") or []) if not (isinstance(n, str) and n.startswith(f"{day}: Refreshed raised tickets"))]
    data["notes"] = notes[:12]
    write_outputs(data)
    prepend_status(f"{day}: Raised-only refresh — {len(rows)} tickets reported by me ({before} before).")
    return data, rows


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(description="Daily jira-intern fetch (or --key for one ticket, --raised for the raised-by-me list)")
    ap.add_argument("--key", help="Refresh a single ticket and merge into data.json")
    ap.add_argument("--raised", action="store_true", help="Refresh only the raised-by-me list and merge into data.json")
    args = ap.parse_args()

    t0 = time.monotonic()
    try:
        if args.raised:
            out, rows = refresh_raised_only()
            print(json.dumps({
                "mode": "refresh_raised",
                "raised": len(rows),
                "open": sum(1 for r in rows if not r.get("done")),
                "generatedAt": out["generatedAt"],
                "durationSec": round(time.monotonic() - t0, 1),
            }, indent=2))
        elif args.key:
            out, ticket, where = refresh_one(args.key)
            print(json.dumps({
                "mode": "refresh_one",
                "key": ticket.get("key"),
                "status": ticket.get("status"),
                "column": ticket.get("column"),
                "where": where,
                "generatedAt": out["generatedAt"],
                "durationSec": round(time.monotonic() - t0, 1),
                "bb_ok": BB_OK,
            }, indent=2))
        else:
            out, changes, notes = main()
            changed_count = sum(len(v) for v in changes.values() if isinstance(v, list))
            print(json.dumps({
                "generatedAt": out["generatedAt"],
                "durationSec": round(time.monotonic() - t0, 1),
                "tickets": len(out["tickets"]),
                "completed": len(out["completed"]),
                "raised": len(out.get("raised") or []),
                "keys": [t["key"] for t in out["tickets"]],
                "changes": changes,
                "changedCount": changed_count,
                "notes": notes,
                "bb_ok": BB_OK,
            }, indent=2))
    except urllib.error.HTTPError as e:
        # HTTPError is a URLError subclass — test it first, or an expired PAT (401) is reported
        # as "unreachable" and the fix (a new token) is never obvious from the log.
        print(json.dumps({
            "error": "jira http",
            "status": e.code,
            "detail": str(getattr(e, "reason", e)),
            "durationSec": round(time.monotonic() - t0, 1),
        }, indent=2))
        sys.exit(1)
    except urllib.error.URLError as e:
        # DNS / VPN / offline — keep prior data; no multi-page traceback in docker logs.
        print(json.dumps({
            "error": "jira unreachable",
            "detail": str(getattr(e, "reason", e)),
            "durationSec": round(time.monotonic() - t0, 1),
        }, indent=2))
        sys.exit(1)
