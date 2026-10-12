#!/usr/bin/env python3
"""Completed-archive intern — refresh cache + merge completed[] only into data.json.

Scope. Only work I was actually part of:
  1. Every issue ever assigned to me (standalone tickets AND my sub-tickets).
  2. The PARENT of each of my sub-tickets — pulled in purely for lineage/context, even when
     the parent belongs to someone else. Marked `mine: false`.
We deliberately do NOT fetch the parent's OTHER children. A sibling sub-ticket a team-mate
delivered, that I never touched, is not my work — fetching it wasted Jira/Bitbucket calls and
buried my own tickets in team noise. `mine` still distinguishes my tickets from the context
parents so the UI can tint the latter.
The one exception is QA: a parent's QA / test sub-tasks (qa_rules.is_qa_ticket) are nested too,
as `mine: false`, because the closure report asks "is the QA sub-task done?" and a tester usually
owns it. Without them every closed ticket reads "no QA sub-task on the ticket".

Branches, pull requests and review state come from Jira's dev-status index via devinfo.py —
see that module for why repo-guessing was removed.
"""
import json
import os
import re
import sys
import urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import devinfo  # noqa: E402  (needs the path fix above when run from another cwd)
from _jira import (  # noqa: E402
    EXCLUDE_PROJECTS,
    ISSUE_KEY_RE,
    JIRA_BASE,
    ac_list,
    changelog_done_date,
    comments_from_issue,
    fetch_comments,
    is_excluded,
    iso,
    issue_links,
    light_html,
    load_env,
    person_fmt,
    search_jira,
    search_keys,
    status_column,
    story_points,
    wiki_to_html,
)
from _sprint import apply_sprint  # noqa: E402
from datafile import atomic_write, data_lock, dumps, prepend_status, read_json, write_outputs  # noqa: E402
from progress import clear_progress, set_progress  # noqa: E402
from qa_rules import is_qa_ticket  # noqa: E402
from raised import refresh_raised_in_place  # noqa: E402

INTERN = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(INTERN, "cache")
DATA_JSON = os.path.join(INTERN, "data.json")
# Identity is resolved server-side via JQL currentUser(); the `mine` flag is set from
# membership in that search's result set, not by comparing account ids here.

# Bump when the cached ticket shape changes so old entries are refetched exactly once.
# 2: branches/PRs come from Jira dev-status (repo + reviewers + real URLs).
# 3: a master's subtasks[] now nests ONLY my sub-tickets, never team-mates'.
# 4: `mine` = ever-assigned-to-me (membership in the mine-search), not the current assignee,
#    so work I finished and handed off stays mine instead of flipping to a context parent.
# 5: a master's subtasks[] also nests the parent's QA sub-tasks (mine=False); older rows get
#    them on the next archive rebuild.
SCHEMA = 5

MAX_FETCH = int(os.environ.get("COMPLETED_MAX_FETCH", "999"))
WORKERS = int(os.environ.get("COMPLETED_WORKERS", "6"))
# How many freshly built tickets to accumulate before flushing data.json. A deep rebuild
# takes minutes; flushing as we go means an interrupted run still leaves the board better
# off than it started, instead of throwing everything away.
FLUSH_EVERY = 10


def is_done(issue):
    f = issue.get("fields") or {}
    cat = ((f.get("status") or {}).get("statusCategory") or {}).get("key")
    if cat:
        return cat == "done"
    return status_column((f.get("status") or {}).get("name")) == "done"


def build_update_log(created, changelog):
    """Status lifecycle from the changelog that rode along with the search — newest first."""
    opened = iso(created)
    events = []
    for h in sorted((changelog or {}).get("histories") or [], key=lambda x: x.get("created", "")):
        when = iso(h.get("created"))
        for item in h.get("items") or []:
            if item.get("field") == "status" and item.get("toString"):
                events.append({"when": when, "text": item["toString"]})
    deduped, prev = [], None
    for e in reversed(events):
        if e["text"] == prev:
            continue
        deduped.append(e)
        prev = e["text"]
    if not deduped or deduped[-1]["text"] != "Opened":
        deduped.append({"when": opened, "text": "Opened"})
    return deduped


def _read_cache(key):
    try:
        with open(os.path.join(CACHE, f"{key}.json"), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def dev_fields(key, dev_map, prior, parent_key=None):
    """Branch/PR block for a ticket. A key missing from dev_map means the lookup failed —
    keep whatever the cache already had rather than blanking real review history.
    A sub-task (`parent_key`) keeps only its own code, not what it shares with its parent."""
    info = dev_map.get(key)
    if info is None:
        return {
            "branch": (prior or {}).get("branch"),
            "branches": (prior or {}).get("branches") or [],
            "pr": (prior or {}).get("pr") or {"state": "none"},
            "prs": (prior or {}).get("prs") or [],
        }
    # Same primary-branch rule as the daily fetch; last run's branch breaks a tie when this
    # lookup carried no commit times.
    info = devinfo.scope_to_ticket(key, info)
    if parent_key:
        info = devinfo.scope_to_subtask(key, info, dev_map.get(parent_key))
    info = devinfo.settle(info, (prior or {}).get("branch"))
    return {"branch": info["branch"], "branches": info["branches"], "pr": info["pr"], "prs": info["prs"]}


def build_subtask(si, parent_key, dev_map, pr_overrides, mine=True):
    """Compact child row shown under its parent. Carries owner + review state so a master
    ticket's delivery is readable without opening Jira. My sub-tickets are nested (`mine` True)
    and so are the parent's QA sub-tasks, whoever owns them (`mine` False)."""
    sf = si.get("fields") or {}
    sk = si["key"]
    status = (sf.get("status") or {}).get("name")
    col = status_column(status)
    sub = {
        "key": sk,
        "title": sf.get("summary"),
        "status": status,
        "column": col,
        "type": (sf.get("issuetype") or {}).get("name"),
        "priority": (sf.get("priority") or {}).get("name"),
        "parentKey": parent_key,
        "url": f"{JIRA_BASE}/browse/{sk}",
        "assignee": person_fmt(sf.get("assignee")),
        "mine": mine,
        "done": col == "done",
        "onHold": col == "hold",
        "created": iso(sf.get("created")),
        "resolved": iso(sf.get("resolutiondate")) or (changelog_done_date(si.get("changelog")) if col == "done" else None),
    }
    sub.update(dev_fields(sk, dev_map, None, parent_key))
    if pr_overrides.get(sk) and sub["pr"].get("state") == "none":
        sub["pr"] = pr_overrides[sk]
    return sub


def build_completed(issue, prior, dev_map, children, pr_overrides, mine, inherit_details=True, qa_children=None):
    """`mine` = was this ever assigned to me (membership in the mine-search set), NOT the
    current assignee — a ticket I finished and handed off is still my work. Only pure context
    parents (pulled in solely because I own a sub-ticket under them) are mine=False.

    `prior` is the cached row. With `inherit_details` (scoped runs) its AI/link fields are
    carried over; a full rebuild passes False so those are rebuilt clean — but the cached
    branch/PR block is ALWAYS the fallback when this run's dev-status lookup failed."""
    f = issue.get("fields") or {}
    key = issue["key"]
    status = (f.get("status") or {}).get("name")
    column = status_column(status)
    details = prior if inherit_details else None

    # Full comment history is worth an extra request for my own tickets; for a context parent
    # the inline page that came free with the search is plenty.
    inline = comments_from_issue(f)
    if inline is not None:
        comments, comment_count, latest_comment = inline
    elif mine:
        comments, comment_count, latest_comment = fetch_comments(key)
    else:
        comments, comment_count, latest_comment = [], (f.get("comment") or {}).get("total", 0), None

    parent = f.get("parent") or {}
    parent_key = parent.get("key")
    parent_title = (parent.get("fields") or {}).get("summary")
    epic_key = f.get("customfield_10405")
    if epic_key:
        epic = {"key": epic_key, "url": f"{JIRA_BASE}/browse/{epic_key}", "relation": "epic (parent)"}
    elif parent_key:
        epic = {"key": parent_key, "url": f"{JIRA_BASE}/browse/{parent_key}", "relation": "parent"}
    else:
        epic = (details or {}).get("epic")

    # Nested children: my own sub-tickets, plus the parent's QA sub-tasks whoever owns them.
    subtasks = [build_subtask(si, key, dev_map, pr_overrides, mine=True) for si in children]
    have = {s["key"] for s in subtasks}
    if qa_children is None:
        # The QA lookup failed — "could not fetch" is not "there is none": keep the QA sub-tasks
        # the cached row already had instead of dropping them.
        subtasks += [s for s in (prior or {}).get("subtasks") or []
                     if isinstance(s, dict) and s.get("mine") is False and s.get("key") and s["key"] not in have]
    else:
        subtasks += [build_subtask(si, key, dev_map, pr_overrides, mine=False) for si in qa_children if si["key"] not in have]
    subtasks.sort(key=lambda s: s["key"])

    ticket = {
        "schema": SCHEMA,
        "key": key,
        "title": f.get("summary"),
        "status": status,
        "column": column,
        "type": (f.get("issuetype") or {}).get("name"),
        "priority": (f.get("priority") or {}).get("name"),
        "storyPoints": story_points(f),
        "commentCount": comment_count,
        "latestComment": latest_comment,
        "lastUpdate": iso(f.get("updated")),
        "created": iso(f.get("created")),
        "resolved": iso(f.get("resolutiondate")) or changelog_done_date(issue.get("changelog")),
        "done": column == "done",
        "onHold": column == "hold",
        "mine": mine,
        "url": f"{JIRA_BASE}/browse/{key}",
        "reporter": person_fmt(f.get("reporter")),
        "assignee": person_fmt(f.get("assignee")),
        "epic": epic,
        "parentKey": parent_key,
        "parentTitle": parent_title,
        "labels": f.get("labels") or [],
        "components": [c.get("name") for c in f.get("components") or [] if c.get("name")],
        "fixVersions": [v.get("name") for v in f.get("fixVersions") or [] if v.get("name")],
        "description": light_html(wiki_to_html(f.get("description"))),
        "acceptanceCriteria": ac_list(f.get("customfield_10700")),
        "comments": comments,
        "related": issue_links(f),
        "confluence": (details or {}).get("confluence") or [],
        "externalLinks": (details or {}).get("externalLinks") or [],
        "proposedSolution": (details or {}).get("proposedSolution"),
        "effortEstimate": (details or {}).get("effortEstimate"),
        "openQuestions": (details or {}).get("openQuestions") or [],
        "sources": (details or {}).get("sources") or [{"title": f"Jira {key}", "url": f"{JIRA_BASE}/browse/{key}"}],
        "updateLog": build_update_log(f.get("created"), issue.get("changelog")),
        "subtasks": subtasks,
        "subtaskCount": len(subtasks),
    }
    apply_sprint(ticket, f.get("customfield_10404"))
    ticket.update(dev_fields(key, dev_map, prior, parent_key))
    if pr_overrides.get(key) and ticket["pr"].get("state") == "none":
        ticket["pr"] = pr_overrides[key]
    return ticket


COMPLETED_KEYS = (
    "key", "title", "type", "priority", "status", "created", "resolved", "storyPoints",
    "branch", "branches", "pr", "prs", "url", "lastUpdate", "sprint", "sprintOverflow", "sprintCount", "reporter", "assignee",
    "epic", "parentKey", "parentTitle", "mine", "labels", "components", "fixVersions",
    "description", "acceptanceCriteria", "comments", "commentCount", "related", "confluence",
    "externalLinks", "proposedSolution", "effortEstimate", "openQuestions", "sources",
    "updateLog", "subtasks", "subtaskCount", "vulnFixes",
)


def known_vuln_fixes(data):
    """{key: vulnFixes} from the current dump — board tickets (and their nested sub-tasks) first,
    then completed rows. The archive never asks Checkmarx; it only keeps what the daily fetch found."""
    out = {}
    for section in ("tickets", "completed"):
        for row in (data or {}).get(section) or []:
            if not isinstance(row, dict):
                continue
            for t in [row, *[s for s in row.get("subtasks") or [] if isinstance(s, dict)]]:
                if t.get("key") and isinstance(t.get("vulnFixes"), dict) and t["key"] not in out:
                    out[t["key"]] = t["vulnFixes"]
    return out


def carry_vuln_fixes(ticket, prior, known):
    """Carry `vulnFixes` onto a rebuilt archive row: the cached row's first, else the dump's copy.
    Preserve, never wipe — a rebuild from Jira has no way to know them."""
    vf = (prior or {}).get("vulnFixes") if isinstance((prior or {}).get("vulnFixes"), dict) else known.get(ticket.get("key"))
    if vf:
        ticket["vulnFixes"] = vf
    return ticket


def completed_entry(t):
    c = {k: t[k] for k in COMPLETED_KEYS if k in t}
    c["project"] = t["key"].split("-")[0]
    c["column"] = "done"
    c["done"] = True
    return c


def assemble(keys, fallback=None):
    """Archive rows for every key that has a cache file, newest first. `fallback` maps keys
    without a cache file to a row to keep (the previous completed[] entry of a failed build)."""
    rows = []
    for key in keys:
        path = os.path.join(CACHE, f"{key}.json")
        try:
            cached = read_json(path, None)
        except Exception as e:
            sys.stderr.write(f"WARN cache read {key}: {e}\n")
            cached = None
        if cached is None:
            cached = (fallback or {}).get(key)
        if not isinstance(cached, dict) or not cached.get("key"):
            continue
        try:
            rows.append(completed_entry(cached))
        except Exception as e:
            sys.stderr.write(f"WARN cache row {key}: {e}\n")
    rows.sort(key=lambda r: (r.get("resolved") or "", r["key"]), reverse=True)
    return rows


def merge_completed_only(completed_list):
    """Replace completed[] and nothing else — tickets[] belongs to the daily fetch."""
    with data_lock(INTERN):
        data = read_json(DATA_JSON, None) or {"tickets": [], "completed": []}
        data["completed"] = completed_list
        write_outputs(data)


def _refresh_raised():
    """Re-fetch raised[] into data.json → (ok, count). Failure keeps the previous list."""
    try:
        data = json.loads(open(DATA_JSON, "r", encoding="utf-8").read())
        ok = refresh_raised_in_place(data)
        if ok:
            write_outputs(data)
        return ok, len(data.get("raised") or [])
    except Exception:
        return False, 0


def _scope():
    """all | year | since | key, from the board menu. Anything else is a full archive."""
    scope = (os.environ.get("ARCHIVE_SCOPE") or "all").strip().lower()
    year = (os.environ.get("ARCHIVE_YEAR") or "").strip()
    since = (os.environ.get("ARCHIVE_SINCE") or "").strip()[:10]
    key = (os.environ.get("ARCHIVE_KEY") or "").strip().upper()
    if scope == "year" and not re.fullmatch(r"\d{4}", year):
        scope = "all"
    elif scope == "since" and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", since):
        scope = "all"
    elif scope == "key" and not ISSUE_KEY_RE.fullmatch(key):
        scope = "all"
    elif scope not in ("all", "year", "since", "key"):
        scope = "all"
    return scope, year, since, key


def upsert_completed(rows):
    """Replace only these keys inside completed[]. A full rebuild still uses merge_completed_only."""
    with data_lock(INTERN):
        data = read_json(DATA_JSON, None) or {"tickets": [], "completed": []}
        by = {}
        for row in data.get("completed") or []:
            if isinstance(row, dict) and row.get("key"):
                by[row["key"]] = row
        for row in rows:
            by[row["key"]] = row
        for row in rows:
            parent = by.get(row.get("parentKey") or "")
            if not parent or parent.get("key") in {r["key"] for r in rows}:
                continue
            subs = [s for s in (parent.get("subtasks") or []) if isinstance(s, dict)]
            subs = [row if s.get("key") == row["key"] else s for s in subs]
            if not any(s.get("key") == row["key"] for s in subs):
                subs.append(row)
            parent["subtasks"] = subs
            parent["subtaskCount"] = len(subs)
        data["completed"] = sorted(by.values(), key=lambda r: (r.get("resolved") or "", r.get("key") or ""), reverse=True)
        write_outputs(data)


def _membership(keys):
    """Which of `keys` were ever assigned to me — one explicit JQL per 100 keys. Used by scoped
    runs, whose search result set is not a membership set (scope=key returns the key itself
    whether or not it was ever mine)."""
    member = set()
    keys = sorted({k for k in keys if k})
    for i in range(0, len(keys), 100):
        chunk = keys[i : i + 100]
        jql = "key in (" + ",".join(chunk) + ") AND (assignee was currentUser() OR assignee = currentUser())"
        member.update(issue["key"] for issue in search_jira(jql, fields="summary") if issue.get("key"))
    return member


def mine_flags(keys, priors, mine_keys, scoped):
    """key → mine for every key being rebuilt. A full run's search IS the membership set; a
    scoped run trusts the cached row's flag and asks Jira only for keys with no cache."""
    if not scoped:
        return {k: k in mine_keys for k in keys}
    flags, unknown = {}, []
    for k in keys:
        cached = priors.get(k)
        if isinstance(cached, dict) and isinstance(cached.get("mine"), bool):
            flags[k] = cached["mine"]
        else:
            unknown.append(k)
    if unknown:
        member = _membership(unknown)
        for k in unknown:
            flags[k] = k in member
    return flags


def main():
    load_env()
    os.makedirs(CACHE, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    set_progress("archive", done=0, total=0, phase="starting", pct=0)

    try:
        return _main(ts)
    finally:
        clear_progress()


def fetch_qa_children(parent_keys):
    """{parent key: [QA sub-task issues]} for these parents — one `parent in (…)` search per 100.
    A parent whose chunk failed is left OUT of the map (not mapped to []), so the caller can tell
    "no QA sub-task" from "could not look"."""
    found = {}
    keys = sorted(k for k in parent_keys if k)
    for i in range(0, len(keys), 100):
        chunk = keys[i : i + 100]
        try:
            issues = search_jira("parent in (" + ",".join(chunk) + ") ORDER BY key ASC", expand="changelog")
        except Exception as e:
            sys.stderr.write(f"WARN QA sub-task search failed for {len(chunk)} parents, earlier ones kept: {e}\n")
            continue
        for k in chunk:
            found[k] = []
        for si in issues:
            f = si.get("fields") or {}
            pk = (f.get("parent") or {}).get("key")
            if pk in found and is_qa_ticket((f.get("issuetype") or {}).get("name"), f.get("summary"), f.get("labels")):
                found[pk].append(si)
    return found


def _main(ts):
    if not os.environ.get("JIRA_PERSONAL_TOKEN"):
        prepend_status(f"**{ts}** — Jira unavailable (no token). Left data.json + cache unchanged.")
        print(json.dumps({"error": "no jira token", "stopped": True}))
        return 1
    if not os.path.isfile(DATA_JSON):
        print(json.dumps({"error": "data.json missing"}))
        return 1

    pr_overrides_path = os.path.join(INTERN, ".pr_overrides.json")
    try:
        pr_overrides = read_json(pr_overrides_path, {}) or {}
    except Exception as e:
        sys.stderr.write(f"WARN .pr_overrides.json unreadable, ignored: {e}\n")
        pr_overrides = {}
    # Previous completed[] rows: the fallback for a key whose build fails and has no cache file.
    try:
        current = read_json(DATA_JSON, {}) or {}
        existing_rows = {
            row["key"]: row
            for row in current.get("completed") or []
            if isinstance(row, dict) and row.get("key")
        }
        vuln_known = known_vuln_fixes(current)
    except Exception as e:
        sys.stderr.write(f"WARN data.json unreadable for fallback rows: {e}\n")
        existing_rows = {}
        vuln_known = {}

    # ── 1. Everything ever assigned to me — standalone tickets AND my sub-tickets.
    # `was` catches work reassigned away from me after I finished it.
    # A scoped run (year, since, or one key) narrows the Jira search. The merge then
    # updates only those rows so the rest of completed[] stays.
    set_progress("archive", done=0, total=0, phase="searching", pct=0)
    scope, year, since, one_key = _scope()
    scoped = scope != "all"
    base_jql = "(assignee was currentUser() OR assignee = currentUser())"
    if scope == "key":
        jql = f"(key = {one_key} OR (parent = {one_key} AND {base_jql})) ORDER BY resolved DESC"
    elif scope == "year":
        y = int(year)
        jql = f'{base_jql} AND resolved >= "{y}-01-01" AND resolved < "{y + 1}-01-01" ORDER BY resolved DESC'
    elif scope == "since":
        jql = f'{base_jql} AND resolved >= "{since}" ORDER BY resolved DESC'
    else:
        jql = base_jql + " ORDER BY resolved DESC"
    mine = search_jira(jql, expand="changelog")
    # Drop excluded projects (config → excludeProjects) up front, so their context parents
    # are never pulled in and they never reach completed[].
    if EXCLUDE_PROJECTS:
        mine = [i for i in mine if not is_excluded(i["key"])]
    issues = {i["key"]: i for i in mine}
    mine_keys = set(issues)  # capture BEFORE adding context parents
    parent_keys = {((i.get("fields") or {}).get("parent") or {}).get("key") for i in mine}
    parent_keys.discard(None)

    # ── 2. Pull in the PARENT of each of my sub-tickets, for lineage/context only — even when
    # it belongs to someone else. We do NOT fetch its other children: a team-mate's sibling
    # sub-ticket I never touched is not my work to track (see the module docstring).
    set_progress("archive", done=0, total=0, phase="parents", pct=5)
    for issue in search_keys(sorted(parent_keys), expand="changelog"):
        issues.setdefault(issue["key"], issue)

    # ── 3. Nest ONLY my own sub-tickets under their parent (they are already in `mine`).
    children_by_parent = {}
    for key in mine_keys:
        pk = ((issues[key].get("fields") or {}).get("parent") or {}).get("key")
        if pk:
            children_by_parent.setdefault(pk, []).append(issues[key])

    # ── 4. Only closed work belongs in the archive (and never an excluded project).
    done_keys = [k for k, i in issues.items() if is_done(i) and not is_excluded(k)]
    done_keys.sort(key=lambda k: (issues[k].get("fields") or {}).get("resolutiondate") or "", reverse=True)

    # ── 5. Every menu action is an explicit refresh of its result set: Jira is the source of
    # truth, so every matching ticket is rebuilt. The cached row is always loaded: it is the
    # fallback for the branch/PR block when dev-status fails for a key, and on a scoped run its
    # AI/link details are inherited too. A full rebuild rebuilds those details clean.
    clean_rebuild = scope == "all"
    stale = done_keys[:MAX_FETCH]
    priors = {key: _read_cache(key) for key in stale}
    total = len(stale) or 1
    # A parent's QA sub-tasks, whoever owns them — for the closure gates (see the module docstring).
    # Only top-level tickets can have sub-tasks, so a sub-ticket row is not asked.
    set_progress("archive", done=0, total=total, phase="qa", pct=5)
    qa_by_parent = fetch_qa_children(
        k for k in stale if not ((issues[k].get("fields") or {}).get("parent") or {}).get("key")
    )
    # `mine` per rebuilt key — the scoped search result is not a membership set (see mine_flags).
    set_progress("archive", done=0, total=total, phase="membership", pct=5)
    mine_by_key = mine_flags(stale, priors, mine_keys, scoped)

    # ── 6. One parallel dev-status batch for the rebuilt tickets AND their children, so no
    # ticket build has to make its own branch/PR calls.
    set_progress("archive", done=0, total=total, phase="devinfo", pct=5)
    dev_targets = set(stale)
    dev_ids = {}
    for key in stale:
        dev_targets.update(c["key"] for c in children_by_parent.get(key, []))
        # A sub-ticket is judged against its parent's code, so the parent joins the batch.
        ref = (issues[key].get("fields") or {}).get("parent") or {} if key in issues else {}
        if ref.get("key"):
            dev_targets.add(ref["key"])
            if ref.get("id"):
                dev_ids[ref["key"]] = ref["id"]

    def dev_progress(done, phase_total, key):
        weighted = 5 + (50 * done / phase_total if phase_total else 50)
        set_progress("archive", done=done, total=phase_total, phase="devinfo", current=key, pct=weighted)

    dev_map = {}
    if dev_targets:
        try:
            dev_map = devinfo.fetch_many(
                sorted(dev_targets),
                ids={**dev_ids, **{k: issues[k]["id"] for k in dev_targets if k in issues and issues[k].get("id")}},
                workers=WORKERS,
                on_progress=dev_progress,
            )
        except Exception as e:
            # Every key then counts as "lookup failed" → cached branch/PR blocks are kept.
            sys.stderr.write(f"WARN dev-status batch failed, PR data carried forward: {e}\n")
            dev_map = {}

    newly_cached, failed = [], []
    pending = 0

    def build(key):
        """Rebuild one cache file. atomic_write replaces the old file in one step, so there
        is no pre-delete: a failed build leaves the previous row in place instead of a hole."""
        try:
            ticket = build_completed(
                issues[key], priors.get(key), dev_map, children_by_parent.get(key, []),
                pr_overrides, mine_by_key.get(key, key in mine_keys),
                inherit_details=not clean_rebuild,
                qa_children=qa_by_parent.get(key),
            )
            carry_vuln_fixes(ticket, priors.get(key), vuln_known)
            atomic_write(os.path.join(CACHE, f"{key}.json"), dumps(ticket))
            return key, None
        except Exception as e:
            return key, e

    set_progress("archive", done=0, total=total, phase="building", pct=55)
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futures = {ex.submit(build, key): key for key in stale}
        for future in as_completed(futures):
            key, err = future.result()
            if err is not None:
                sys.stderr.write(f"WARN build {key}: {err}\n")
                failed.append(key)
            else:
                newly_cached.append(key)
                pending += 1
                if pending >= FLUSH_EVERY:
                    partial = assemble(done_keys, fallback=existing_rows)
                    if scoped:
                        upsert_completed(partial)
                    else:
                        merge_completed_only(partial)
                    pending = 0
            done_n = len(newly_cached) + len(failed)
            set_progress("archive", done=done_n, total=total, phase="building", current=key, pct=55 + 43 * done_n / total)

    set_progress("archive", done=total, total=total, phase="writing", pct=99)
    # Failed keys keep their previous row: the untouched cache file, else the old completed[] entry.
    rows = assemble(done_keys, fallback={k: existing_rows[k] for k in failed if k in existing_rows})
    if scoped:
        upsert_completed(rows)
    else:
        merge_completed_only(rows)
    completed = rows

    # The rebuild is the "refresh my history" action, so the raised-by-me list (tickets I
    # REPORTED, for the board's Raised view) rides along — one extra search on a long run.
    set_progress("archive", done=total, total=total, phase="raised", pct=99)
    raised_ok, raised_count = _refresh_raised()

    mine_count = sum(1 for r in completed if r.get("mine"))
    context_count = len(completed) - mine_count
    sub_count = sum(1 for r in completed if r.get("parentKey"))
    note = (
        f"**{ts}** — Completed-archive intern: **{len(completed)}** rows "
        f"({mine_count} mine + {context_count} parent tickets I have a sub-ticket under; "
        f"{sub_count} of the rows are sub-tickets). {len(newly_cached)} rebuilt this run, "
        f"{len(done_keys) - len(stale)} skipped over maxFetch, {len(failed)} failed. "
        f"Jira dev-status; merged completed[] — tickets[] untouched. "
        + (f"raised[] refreshed ({raised_count})." if raised_ok else "raised[] carried forward (search failed).")
    )
    prepend_status(note)
    set_progress("archive", done=total, total=total, phase="done", pct=100)
    print(json.dumps({
        "completed_in_archive": len(completed),
        "raised": raised_count,
        "raised_refreshed": raised_ok,
        "mine": mine_count,
        "context_parents": context_count,
        "subtasks": sub_count,
        "with_prs": sum(1 for r in completed if r.get("prs")),
        "universe_scanned": len(issues),
        "rebuilt_this_run": len(newly_cached),
        "cache_cleared_and_rebuilt": len(newly_cached) if clean_rebuild else 0,
        "skipped_over_max_fetch": len(done_keys) - len(stale),
        "failed": failed[:10],
    }, indent=2))
    # Exit 4 = "partial": the rows are already merged (previous entry kept for every failed
    # key), so the shell runner logs a warning but must NOT fall back to the LLM agent.
    # 1 is reserved for "nothing usable was produced" (search failed, no token, HTTP error).
    return 4 if failed else 0


if __name__ == "__main__":
    try:
        sys.exit(main() or 0)
    except urllib.error.HTTPError as e:
        # HTTPError subclasses URLError — test it first so an expired PAT (401) is not
        # reported as "jira unreachable".
        print(json.dumps({
            "error": "jira http",
            "status": e.code,
            "detail": str(getattr(e, "reason", e)),
        }, indent=2))
        sys.exit(1)
    except urllib.error.URLError as e:
        print(json.dumps({
            "error": "jira unreachable",
            "detail": str(getattr(e, "reason", e)),
        }, indent=2))
        sys.exit(1)
