#!/usr/bin/env python3
"""Jira Development-Information client — branches, pull requests and review state.

This reads Jira's dev-status API, the same source that renders the "Development"
panel on a Jira issue. Bitbucket indexes every commit and branch against the ticket
keys it mentions and pushes that to Jira, so one call per issue returns work in ANY
repository — including repos this tool has never been told about.

That matters most for sub-tasks: a master ticket is usually delivered through
sub-tasks that several people own, and their branches often live in infrastructure
or pipeline repos far away from the team's main application repo.

Bitbucket is still called, but only to enrich a pull request that is still open
(reviewer NEEDS_WORK flags and unresolved comment counts, which dev-status omits).
Those calls address the PR by its exact project/repo/id taken from the dev-status
URL, so there is no repo guessing anywhere in this module.
"""
import re
import sys
import urllib.error
import urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed

from _jira import REQUIRED_APPROVALS, bb_get, iso, jira_get

_PR_URL_RE = re.compile(r"/projects/([^/]+)/repos/([^/]+)/pull-requests/(\d+)")


def resolve_issue_ids(keys):
    """Map issue keys → numeric ids (dev-status only accepts ids), 100 keys per search."""
    ids = {}
    keys = [k for k in keys if k]
    for i in range(0, len(keys), 100):
        chunk = keys[i : i + 100]
        try:
            q = urllib.parse.urlencode(
                {"jql": "key in (" + ",".join(chunk) + ")", "maxResults": 100, "fields": "summary"}
            )
            for issue in jira_get("/rest/api/2/search?" + q, timeout=90).get("issues", []):
                ids[issue["key"]] = issue["id"]
        except Exception as e:
            # Degrade: these keys get no dev info this run (callers keep their cached PRs).
            sys.stderr.write(f"WARN dev-status id lookup ({len(chunk)} keys): {e}\n")
            continue
    return ids


def pr_comment_stats(proj, slug, pid):
    """Unresolved vs resolved review comments — dev-status reports neither."""
    total, resolved = 0, 0
    try:
        start, pages = 0, 0
        while pages < 3:
            data = bb_get(f"/projects/{proj}/repos/{slug}/pull-requests/{pid}/activities?start={start}&limit=100", timeout=30)
            for act in data.get("values") or []:
                if act.get("action") == "COMMENTED":
                    total += 1
                    c = act.get("comment") or {}
                    if c.get("state") == "RESOLVED" or c.get("severity") == "BLOCKER":
                        resolved += 1
            pages += 1
            if data.get("isLastPage", True):
                break
            start += data.get("size", 100)
    except Exception as e:
        sys.stderr.write(f"WARN bitbucket PR comments {proj}/{slug}#{pid}: {e}\n")
    return total, resolved, max(0, total - resolved)


# Set once Bitbucket proves unreachable (DNS, TLS, refused) so the rest of the run does not pay a
# timeout per PR and per branch. A 4xx answer means Bitbucket IS reachable and never trips it.
_BB_UNREACHABLE = False


def _bb(path, timeout, what):
    """bb_get for the lookups below. Returns (data, http_status_or_None). Never raises."""
    global _BB_UNREACHABLE
    if _BB_UNREACHABLE:
        return None, None
    try:
        return bb_get(path, timeout=timeout), 200
    except urllib.error.HTTPError as e:
        sys.stderr.write(f"WARN bitbucket {what}: HTTP {e.code}\n")
        return None, e.code
    except (urllib.error.URLError, OSError) as e:
        _BB_UNREACHABLE = True
        sys.stderr.write(f"WARN bitbucket unreachable ({what}): {e} — skipping Bitbucket for the rest of this run\n")
        return None, None
    except Exception as e:
        sys.stderr.write(f"WARN bitbucket {what}: {e}\n")
        return None, None


def _bb_pull_request(proj, slug, pid):
    """Bitbucket's own record of one pull request, or None when it cannot be read. Unlike the
    copy Jira's dev-status index keeps, this is current: it is the authority for which branch
    the PR really comes from and goes to, and for reviewer verdicts."""
    return _bb(f"/projects/{proj}/repos/{slug}/pull-requests/{pid}", 15, f"PR {proj}/{slug}#{pid}")[0]


def _to_pr(raw, enrich_open=True):
    status = (raw.get("status") or "").upper()
    merged = status == "MERGED"
    declined = status in ("DECLINED", "REJECTED")
    src = raw.get("source") or {}
    dst = raw.get("destination") or {}
    reviewers_raw = raw.get("reviewers") or []
    approvals = sum(1 for r in reviewers_raw if r.get("approved"))
    url = raw.get("url")

    total = resolved = open_c = 0
    needs_work = False
    source_branch, destination_branch = src.get("branch"), dst.get("branch")
    m = _PR_URL_RE.search(url or "")
    if m and not (merged or declined):
        proj, slug, pid = m.groups()
        # Comment counts page through the activity feed (slow) — only when enriching. The PR
        # record itself is one short call and is ALWAYS read: Jira's index can name a branch the
        # PR does not come from, and the single-ticket refresh must not keep showing that.
        if enrich_open:
            total, resolved, open_c = pr_comment_stats(proj, slug, pid)
        bb = _bb_pull_request(proj, slug, pid)
        if bb:
            needs_work = any(r.get("status") == "NEEDS_WORK" for r in bb.get("reviewers") or [])
            # Jira's copy of the branch names can be stale or wrong; Bitbucket's record is not.
            source_branch = (bb.get("fromRef") or {}).get("displayId") or source_branch
            destination_branch = (bb.get("toRef") or {}).get("displayId") or destination_branch

    if merged:
        state = "merged"
    elif declined:
        state = "declined"
    elif needs_work:
        state = "changes"
    elif approvals >= REQUIRED_APPROVALS and open_c == 0:
        state = "approved"
    else:
        state = "comments"

    pid_raw = str(raw.get("id") or "").lstrip("#")
    return {
        "state": state,
        "id": int(pid_raw) if pid_raw.isdigit() else (pid_raw or None),
        "title": raw.get("name"),
        "url": url,
        "approvals": approvals,
        "openComments": open_c,
        "commentsTotal": total,
        "commentsResolved": resolved,
        "reviewers": [r.get("name") for r in reviewers_raw if r.get("name")],
        "sourceBranch": source_branch,
        "destinationBranch": destination_branch,
        # Which repository the review actually happened in. With dev-status a single ticket
        # can span several repos, so the badge is meaningless without it.
        "repo": (src.get("repository") or {}).get("name") or (m.group(2) if m else None),
        "author": (raw.get("author") or {}).get("name"),
        "merged": merged,
        "mergedAt": iso(raw.get("lastUpdate")) if merged else None,
        "updatedAt": iso(raw.get("lastUpdate")),
    }


def pick_primary_pr(prs):
    """Badge PR: an in-flight review outranks history; otherwise newest merged, else newest."""
    if not prs:
        return {"state": "none"}
    open_prs = [p for p in prs if not p.get("merged") and p.get("state") != "declined"]
    if open_prs:
        return open_prs[0]
    merged = [p for p in prs if p.get("merged")]
    return merged[0] if merged else prs[0]


# ── Which branch is "the" branch? ────────────────────────────────────────────────────────
# A ticket can accumulate several branches (renames, a restarted attempt, one per repo). The
# board shows ONE as the ticket's branch and builds its PR banners from that branch's own PR,
# so the choice has to be the branch the work is actually on: the one with the newest commit.
# Jira's dev-status carries no commit time per branch, so Bitbucket is asked — one cheap call
# per branch, and only for tickets that have more than one.

_REPO_URL_RE = re.compile(r"/projects/([^/]+)/repos/([^/?#]+)")


def _same_branch(a, b):
    return bool(a) and bool(b) and str(a).strip().lower() == str(b).strip().lower()


def _repo_of(url):
    m = _REPO_URL_RE.search(url or "")
    return (m.group(1), m.group(2)) if m else None


def branch_head(proj, slug, branch):
    """(epoch seconds of the newest commit on `branch`, gone). `gone` is True only when Bitbucket
    answered 404 — the branch does not exist, although Jira's index may still list it. Any other
    failure (network down) is (None, False): unknown, so nothing is dropped on missing data."""
    q = urllib.parse.urlencode({"until": "refs/heads/" + branch, "limit": 1})
    data, status = _bb(f"/projects/{proj}/repos/{slug}/commits?{q}", 20, f"latest commit {proj}/{slug} {branch}")
    if data is None:
        return None, status == 404
    commit = next(iter(data.get("values") or []), None)
    if not isinstance(commit, dict):
        return None, False
    stamps = [t for t in (commit.get("committerTimestamp"), commit.get("authorTimestamp")) if isinstance(t, (int, float))]
    return (max(stamps) / 1000.0 if stamps else None), False


def latest_commit_time(proj, slug, branch):
    """Epoch seconds of the newest commit reachable from `branch`, or None when Bitbucket
    cannot say (branch deleted, network down). A None never ranks a branch — it only keeps
    it from winning on missing data."""
    return branch_head(proj, slug, branch)[0]


def _bb_pr_as_devstatus(p, slug):
    """A Bitbucket REST pull request in the shape dev-status uses, so `_to_pr` handles both."""
    from_ref, to_ref = p.get("fromRef") or {}, p.get("toRef") or {}
    self_links = ((p.get("links") or {}).get("self")) or [{}]
    return {
        "id": p.get("id"),
        "name": p.get("title"),
        "status": p.get("state"),
        "url": (self_links[0] or {}).get("href"),
        "source": {
            "branch": from_ref.get("displayId"),
            "repository": {"name": ((from_ref.get("repository") or {}).get("name")) or slug},
        },
        "destination": {"branch": to_ref.get("displayId")},
        "reviewers": [
            {"name": (r.get("user") or {}).get("displayName"), "approved": bool(r.get("approved"))}
            for r in p.get("reviewers") or []
            if isinstance(r, dict)
        ],
        "author": {"name": ((p.get("author") or {}).get("user") or {}).get("displayName")},
        "lastUpdate": p.get("updatedDate"),
    }


def prs_from_branch(proj, slug, branch, enrich_open=True):
    """Pull requests opened FROM `branch`, straight from Bitbucket. Used when Jira's index has
    none for the branch the ticket is on — the index can lag a new PR by a while."""
    try:
        q = urllib.parse.urlencode(
            {"direction": "OUTGOING", "at": "refs/heads/" + branch, "state": "ALL", "order": "NEWEST", "limit": 10}
        )
        data = bb_get(f"/projects/{proj}/repos/{slug}/pull-requests?{q}", timeout=30)
        return [
            _to_pr(_bb_pr_as_devstatus(p, slug), enrich_open)
            for p in data.get("values") or []
            if isinstance(p, dict) and _same_branch((p.get("fromRef") or {}).get("displayId"), branch)
        ]
    except Exception as e:
        sys.stderr.write(f"WARN bitbucket PRs from {proj}/{slug} {branch}: {e}\n")
        return []


def _pr_identity(p):
    m = _PR_URL_RE.search(p.get("url") or "")
    return (m.group(1).upper(), m.group(2).lower(), m.group(3)) if m else (None, (p.get("repo") or "").lower(), str(p.get("id")))


def mentions_key(key, *texts):
    """Does any of `texts` (a PR title, a branch name) name `key` as a whole ticket key?
    "ABC-12" is not in "ABC-123"; the underscore spelling used in branch names counts."""
    if not key:
        return False
    spellings = "|".join(re.escape(k) for k in dict.fromkeys((key, key.replace("-", "_"))))
    pattern = re.compile(rf"(?<![A-Za-z0-9])(?:{spellings})(?![0-9])", re.IGNORECASE)
    return any(pattern.search(t) for t in texts if t)


# Anything shaped like a Jira key in a PR title or branch name. Upper-case only — Jira keys and
# Bitbucket's auto-generated PR titles are upper-case, while "fix-123" or "utf-8" are not tickets —
# minus a few upper-case standards that look like keys.
_KEY_SHAPE = re.compile(r"(?<![A-Za-z0-9])([A-Z][A-Z0-9]{1,9})[-_](\d+)(?![0-9])")
_NOT_PROJECTS = {"AES", "CVE", "HTTP", "HTTPS", "ISO", "JDK", "JRE", "MD", "PR", "RFC", "RSA", "SHA", "SSL", "TLS", "UTF"}


def other_keys(key, *texts):
    """Ticket keys named in `texts` other than `key` (either spelling, ABC-1 or ABC_1)."""
    own = (key or "").upper()
    found = set()
    for t in texts:
        for proj, num in _KEY_SHAPE.findall(t or ""):
            k = f"{proj}-{num}"
            if proj not in _NOT_PROJECTS and k != own:
                found.add(k)
    return found


def scope_to_ticket(key, info):
    """A ticket's own code, without other tickets' pull requests.

    Jira links a PR to every ticket mentioned in any commit inside it, so a rebase or a merge from
    dev drags other people's PRs onto a ticket (one ticket here carried eleven PRs for other keys).
    A PR whose title and source branch name some OTHER ticket and never this one is that ticket's
    PR and is dropped; so is a branch that names only other tickets, unless a kept PR comes from it.
    A PR that names no ticket at all cannot be judged and stays."""
    if not info or not key:
        return info
    def foreign(*texts):
        return not mentions_key(key, *texts) and bool(other_keys(key, *texts))
    prs = [p for p in info.get("prs") or [] if not foreign(p.get("title"), p.get("sourceBranch"))]
    kept_sources = {p.get("sourceBranch") for p in prs}
    branches = [b for b in info.get("branches") or [] if b in kept_sources or not foreign(b)]
    return {**info, "prs": prs, "branches": branches}


def scope_to_subtask(key, info, parent_info):
    """A sub-task's own code, without the code of the ticket it belongs to.

    Jira links a PR to every ticket with a commit on its branch, so when the sub-tasks are
    committed on the parent's branch the parent's PR shows up on every one of them. That PR is
    the parent's, not theirs. A PR or branch the sub-task shares with its parent is dropped
    unless its own title / branch name names the sub-task's key. Code only the sub-task has is
    never touched. `parent_info` is the parent's fetch_one result; without it (the lookup
    failed) nothing can be told apart, so `info` is returned as it is."""
    if not info or not parent_info:
        return info
    parent_prs = {_pr_identity(p) for p in parent_info.get("prs") or []}
    parent_branches = {b for b in parent_info.get("branches") or [] if b}
    prs = [
        p for p in info.get("prs") or []
        if _pr_identity(p) not in parent_prs or mentions_key(key, p.get("title"), p.get("sourceBranch"))
    ]
    own_pr_branches = {p.get("sourceBranch") for p in prs}
    shared_pr_branches = {
        p.get("sourceBranch") for p in info.get("prs") or [] if p not in prs and p.get("sourceBranch")
    }
    branches = [
        b for b in info.get("branches") or []
        if mentions_key(key, b) or b in own_pr_branches or not (b in parent_branches or b in shared_pr_branches)
    ]
    return {**info, "prs": prs, "branches": branches}


def choose_primary(branches, prs, times=None, prior_branch=None):
    """Settle the ticket's primary branch and primary PR.

    Returns (branch, pr, branches, prs). `branches` and `prs` come back reordered with the
    primary branch (and its PRs) first and nothing dropped, so the board's lists keep every
    entry. `pr` is the primary PR OF THAT BRANCH: when the branch has no PR of its own it is
    {"state": "none"}, even if another branch has one — that PR is still in `prs`.

    Order of preference for the branch, only when there is more than one to choose from:
      1. the newest commit (`times`: branch → epoch seconds, branches without a time never win);
      2. the branch chosen last time (`prior_branch`), when no commit time could be read — so a
         refresh that skips Bitbucket does not flip the choice back and forth;
      3. the source branch of the primary PR (how it was chosen before commit times existed).
    """
    branches = [b for b in dict.fromkeys(branches or []) if b]
    prs = list(prs or [])
    known = {b: t for b, t in (times or {}).items() if t and b in branches}

    branch, legacy = None, None
    if len(branches) > 1:
        if known:
            branch = max(known, key=known.get)  # ties keep list order
        else:
            branch = next((b for b in branches if _same_branch(b, prior_branch)), None)
    if branch is None:
        # The rule before commit times existed: the in-flight PR decides. Its pick is kept
        # as is, even for a PR that carries no source branch.
        legacy = pick_primary_pr(prs)
        branch = legacy.get("sourceBranch") or (branches[0] if branches else None)
    if branch and branch not in branches:
        branches = [branch] + branches

    own = [p for p in prs if _same_branch(p.get("sourceBranch"), branch)]
    pr = legacy if legacy is not None else pick_primary_pr(own)
    ordered_prs = (
        [p for p in prs if p is pr]
        + [p for p in own if p is not pr]
        + [p for p in prs if p not in own and p is not pr]
    )
    ordered_branches = ([branch] if branch else []) + [b for b in branches if b != branch]
    return branch, pr, ordered_branches, ordered_prs


def settle(info, prior_branch=None):
    """`info` (a fetch_one result) with branch/pr/branches/prs re-derived by choose_primary.
    Callers that know last run's branch pass it so a lookup without commit times stays put."""
    branch, pr, branches, prs = choose_primary(info.get("branches"), info.get("prs"), info.get("times"), prior_branch)
    return {**info, "branch": branch, "pr": pr, "branches": branches, "prs": prs}


def fetch_one(issue_id, enrich_open=True):
    """Branches + PRs for one issue id. Returns None when the call fails OR the payload cannot
    be read, so callers can tell "Jira says there is no code" apart from "we could not ask" —
    and one malformed dev-status answer never takes down a whole batch in fetch_many.

    `enrich_open=False` skips the per-PR comment lookups (the single-ticket refresh uses it to
    avoid slow calls). Ranking branches by newest commit stays on — it is one short call per
    branch, only for tickets with several. Without a commit time the primary branch falls back
    to last run's choice via `settle`."""
    try:
        data = jira_get(
            f"/rest/dev-status/latest/issue/detail?issueId={issue_id}"
            f"&applicationType=stash&dataType=pullrequest",
            timeout=45,
        )
        detail = (data.get("detail") or [{}])[0] or {}
        prs = [_to_pr(p, enrich_open) for p in detail.get("pullRequests") or [] if isinstance(p, dict)]
        prs.sort(key=lambda p: (p.get("updatedAt") or ""), reverse=True)

        # branch → (project, repo): the repo each branch lives in, for the Bitbucket lookups below.
        refs = {}
        branches = []
        for b in detail.get("branches") or []:
            if isinstance(b, dict) and b.get("name"):
                branches.append(b["name"])
                refs[b["name"]] = _repo_of(b.get("url")) or _repo_of((b.get("repository") or {}).get("url"))
        for p in prs:
            if p.get("sourceBranch"):
                branches.append(p["sourceBranch"])
                refs.setdefault(p["sourceBranch"], _repo_of(p.get("url")))
        branches = list(dict.fromkeys(branches))

        times = {}
        if len(branches) > 1:
            # Which branch is the work on? Ask Bitbucket for each branch's newest commit.
            gone = set()
            for b in branches:
                if refs.get(b):
                    t, missing = branch_head(*refs[b], b)
                    if t:
                        times[b] = t
                    elif missing:
                        gone.add(b)
            # Jira's index keeps branches that were deleted or never existed under that name; a
            # branch Bitbucket says does not exist is not the ticket's. A merged / declined PR's
            # source branch is history (usually deleted on merge) and stays listed.
            history = {p.get("sourceBranch") for p in prs if p.get("merged") or p.get("state") == "declined"}
            branches = [b for b in branches if b not in gone or b in history]
            if times:
                branch, own_pr, _b, _p = choose_primary(branches, prs, times)
                # Jira's index can lag a new PR: look for one from the branch we settled on.
                if branch and refs.get(branch) and not own_pr.get("id") and own_pr.get("state") == "none":
                    seen = {_pr_identity(p) for p in prs}
                    for extra in prs_from_branch(*refs[branch], branch, enrich_open):
                        if _pr_identity(extra) not in seen:
                            seen.add(_pr_identity(extra))
                            prs.append(extra)

        # branch → repo slug, for lookups keyed by repository (jenkins.py's build per branch).
        repos = {b: refs[b][1] for b in branches if refs.get(b)}
        return settle({"branches": branches, "prs": prs, "times": times, "repos": repos})
    except Exception as e:
        sys.stderr.write(f"WARN dev-status issue {issue_id}: {e}\n")
        return None


def fetch_many(keys, ids=None, workers=10, enrich_open=True, on_progress=None):
    """Dev info for many issue keys at once. Keys whose lookup failed are omitted, never
    reported as empty — an empty result would wipe good cached data. `on_progress`, when
    supplied, receives (completed_count, total_count, key) as each lookup finishes.
    Pass `ids` (key → issue id) when the caller already has the issues, to skip a search."""
    ids = dict(ids or {})
    missing = [k for k in keys if k not in ids]
    if missing:
        ids.update(resolve_issue_ids(missing))
    todo = [(k, ids[k]) for k in keys if k in ids]
    out = {}
    if not todo:
        return out

    def one(pair):
        key, issue_id = pair
        return key, fetch_one(issue_id, enrich_open)

    with ThreadPoolExecutor(max_workers=min(workers, len(todo))) as ex:
        futures = {ex.submit(one, pair): pair[0] for pair in todo}
        for completed, future in enumerate(as_completed(futures), start=1):
            key, info = future.result()
            if info is not None:
                out[key] = info
            if on_progress:
                on_progress(completed, len(todo), key)
    return out
