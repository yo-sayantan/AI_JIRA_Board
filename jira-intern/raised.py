#!/usr/bin/env python3
"""Raised-by-me fetch — every non-sub-task ticket I REPORTED, whoever works it now.

Shared by daily_fetch.py (rides along with each daily run), completed_archive.py (an
archive rebuild refreshes this list too) and refresh-raised.sh (the view's own refresh
button, via `daily_fetch.py --raised`). One paginated JQL search, no per-ticket calls,
no Bitbucket — raised rows are deliberately compact: they answer "what's its status,
who holds it now, and what work is it linked to?".

Sub-tasks are excluded at the JQL level AND by the parent-field filter below: a
sub-ticket cut under my own work is mine by default, not "raised" work.
"""
import os
import sys
import urllib.error
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _jira import (  # noqa: E402
    JIRA_BASE,
    build_update_log,
    changelog_done_date,
    is_excluded,
    iso,
    issue_links,
    jira_get,
    light_html,
    person_fmt,
    status_column,
    story_points,
    wiki_to_html,
)
from _sprint import apply_sprint  # noqa: E402

# Same parallelism knob as the daily fetch (Settings → Parallel refresh).
WORKERS = max(1, min(16, int(os.environ.get("REFRESH_WORKERS") or 8)))
PAGE = 100

# No comment bodies and no subtasks here; issuelinks ARE fetched — "which ticket was this
# raised from / related to" is part of the view's contract.
RAISED_FIELDS = (
    "summary,status,issuetype,priority,updated,created,resolutiondate,assignee,reporter,"
    "labels,components,fixVersions,description,parent,issuelinks,"
    "customfield_10402,customfield_57402,customfield_10404,customfield_10405"
)


def assignee_history(changelog):
    """Chronological assignee hand-offs from the changelog: [{when, from, to}].
    The first assignment has from=None; a later entry with a `from` means the ticket
    changed hands — exactly the "has it been reassigned?" signal the Raised view shows."""
    hops = []
    for h in sorted((changelog or {}).get("histories") or [], key=lambda x: x.get("created", "")):
        day = (iso(h.get("created")) or "")[:10] or None
        for item in h.get("items") or []:
            if item.get("field") == "assignee":
                hops.append({"when": day, "from": item.get("fromString"), "to": item.get("toString")})
    return hops


def build_raised_row(issue):
    """One compact raised[] row from a search result (fields + changelog, nothing else)."""
    f = issue["fields"]
    key = issue["key"]
    status = f["status"]["name"]
    column = status_column(status)

    # Lineage: epic link if set, else parent — same precedence as the board's build_ticket.
    epic_key = f.get("customfield_10405")
    parent = f.get("parent")
    epic = None
    if epic_key:
        epic = {"key": epic_key, "url": f"{JIRA_BASE}/browse/{epic_key}", "relation": "epic (parent)"}
    elif parent:
        pk = parent.get("key")
        epic = {"key": pk, "url": f"{JIRA_BASE}/browse/{pk}", "relation": "parent"}

    row = {
        "key": key,
        "title": f.get("summary"),
        "status": status,
        "column": column,
        "type": f["issuetype"]["name"],
        "priority": (f.get("priority") or {}).get("name"),
        "project": key.split("-")[0],
        "storyPoints": story_points(f),
        "created": iso(f.get("created")),
        "lastUpdate": iso(f.get("updated")),
        "resolved": iso(f.get("resolutiondate")) or (changelog_done_date(issue.get("changelog")) if column == "done" else None),
        "done": column == "done",
        "url": f"{JIRA_BASE}/browse/{key}",
        "reporter": person_fmt(f.get("reporter")),
        "assignee": person_fmt(f.get("assignee")),
        "labels": f.get("labels") or [],
        "components": [c["name"] for c in f.get("components") or []],
        "fixVersions": [v["name"] for v in f.get("fixVersions") or []],
        "description": light_html(wiki_to_html(f.get("description"))),
        # Which ticket this was raised from / blocks / duplicates — straight off issuelinks.
        "related": issue_links(f),
        "epic": epic,
        "assigneeLog": assignee_history(issue.get("changelog")),
        "updateLog": build_update_log(key, f.get("created"), status, f.get("resolutiondate"), issue.get("changelog")),
    }
    apply_sprint(row, f.get("customfield_10404"))
    return row


def _search_parallel(jql):
    """Paginated search with every page after the first fetched CONCURRENTLY — the same
    batched parallelism the daily fetch and the archive use, applied to the one place the
    raised refresh spends wall-clock. Page 1 reveals the total; the rest fan out."""
    def page(start):
        params = {"jql": jql, "startAt": start, "maxResults": PAGE, "fields": RAISED_FIELDS, "expand": "changelog"}
        return jira_get("/rest/api/2/search?" + urllib.parse.urlencode(params))

    first = page(0)
    issues = list(first.get("issues") or [])
    total = int(first.get("total") or len(issues))
    starts = list(range(PAGE, total, PAGE))
    if starts:
        with ThreadPoolExecutor(max_workers=max(1, min(WORKERS, len(starts)))) as ex:
            for batch in ex.map(page, starts):
                issues.extend(batch.get("issues") or [])
    return issues


def fetch_raised(prior_rows):
    """All non-sub-task tickets I reported, newest first → (rows, ok). A failure keeps the
    previous list (≠ "I raised nothing") so the view never blanks on a blip."""
    try:
        try:
            issues = _search_parallel(
                "reporter = currentUser() AND issuetype not in subTaskIssueTypes() ORDER BY created DESC"
            )
        except urllib.error.HTTPError as e:
            if e.code != 400:
                raise
            # Older builds reject subTaskIssueTypes(); the parent-field filter below still
            # drops every sub-task, so the plain reporter search is equally correct.
            issues = _search_parallel("reporter = currentUser() ORDER BY created DESC")
    except Exception:
        return list(prior_rows or []), False
    # Always a HARD, full replace: every reported ticket is re-fetched (rows already listed
    # pick up their updates; newly raised ones appear; vanished ones drop). Only the AI brief
    # is carried forward — the summarize pass regenerates it once lastUpdate outruns it.
    prior_map = {r.get("key"): r for r in (prior_rows or []) if isinstance(r, dict) and r.get("key")}
    rows, seen = [], set()
    for i in issues:
        key = i.get("key")
        # Belt and braces: some setups type sub-tasks oddly, so also drop anything parented.
        if not key or key in seen or is_excluded(key) or (i["fields"].get("parent") or {}).get("key"):
            continue
        seen.add(key)
        row = build_raised_row(i)
        prior = prior_map.get(key)
        if prior and prior.get("aiSummary"):
            row["aiSummary"] = prior["aiSummary"]
            row["aiSummaryAt"] = prior.get("aiSummaryAt")
            if prior.get("aiSummaryEvidence"):
                row["aiSummaryEvidence"] = prior["aiSummaryEvidence"]
        rows.append(row)
    # Parallel pages can interleave if Jira's result set shifts mid-fetch — re-sort so the
    # list is always strictly newest-raised first.
    rows.sort(key=lambda r: r.get("created") or "", reverse=True)
    return rows, True


def refresh_raised_in_place(data):
    """Fetch and swap raised[] inside an already-loaded dump dict. Returns ok."""
    rows, ok = fetch_raised(data.get("raised") or [])
    data["raised"] = rows
    if ok:
        data["raisedAt"] = utcnow()  # the Raised view shows how fresh ITS list is
    return ok


def utcnow():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
