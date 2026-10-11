#!/usr/bin/env python3
"""Jenkins multibranch builds — the latest build of a ticket's branch, per environment.

Config → jenkins.jobs maps a repository slug to one multibranch pipeline job per environment:

    "jenkins": { "jobs": { "payments-service": {
        "qa":  "https://jenkins.example.com/job/team/job/payments-service-qa/",
        "uat": "https://jenkins.example.com/job/team/job/payments-service-uat/" } } }

For every branch of a ticket that lives in a configured repo, each environment's job is asked for
`lastBuild` of that branch: result (or BUILDING), number, link, time, duration, JUnit totals, and —
for a failed or unstable pipeline — up to five failing test names and the stage that failed. A
branch is a child job of the multibranch job; see `item_name` for how its name is encoded.

Auth is HTTP basic with JENKINS_USER + JENKINS_API_TOKEN (setup/.env). The token goes in the
Authorization header only — never in a URL, never in a log line. Hosts come only from the config,
and every follow-up call is built from the configured job URL, never from a URL Jenkins returned.

Transport: https job URLs only (an http one is skipped with a note), TLS always verified — JIRA_INSECURE_TLS
does not apply; JENKINS_INSECURE_TLS=1 is Jenkins' own last-resort opt-out; a CA bundle (JIRA_CA_BUNDLE /
~/.ai/ca-bundle.pem) is still added. Redirects are followed only within the same origin, so the
Authorization header never reaches another host or plain http (_safe_http.SameOriginRedirect).

Failure semantics follow devinfo.py: a 404 means "this branch has no build here" (an answer); a
network or auth failure means the lookup FAILED, and callers carry the previous builds forward
(`builds_for` returns None, or keeps the prior entry for just the failed environment, marked
`stale: true`).
Stdlib only, like the rest of jira-intern.
"""
import base64
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import _safe_http
from _config import load_config
from _jira import INTERN, iso

RESULTS = ("SUCCESS", "FAILURE", "UNSTABLE", "ABORTED", "NOT_BUILT", "BUILDING")
# Build parameters that name where a pipeline deployed, most specific first.
DEPLOY_PARAMS = ("DEPLOY_ENV", "ENVIRONMENT", "ENV", "TARGET")
FAILING_CAP = 5
TIMEOUT = 20
# (repo, env, branch) lookups per ticket, and HTTP calls per run — a ticket with a dozen stale
# branches, or a board of fifty tickets, must not turn one refresh into thousands of requests.
MAX_TARGETS_PER_TICKET = 12
MAX_CALLS_PER_RUN = 800

OK, NONE, FAILED = "ok", "none", "failed"

BUILD_TREE = (
    "number,result,building,timestamp,duration,url,displayName,description,"
    "actions[parameters[name,value],failCount,skipCount,totalCount,urlName]"
)
REPORT_TREE = "suites[cases[className,name,status]]"

# Characters Jenkins refuses in an item name. Multibranch (branch-api's NameEncoder) writes each
# as %XX, so `feature/ABC-1` becomes the job `feature%2FABC-1` — and that name is URL-encoded
# again in the path: /job/feature%252FABC-1/.
_UNSAFE = set('%/\\?*!@#$^&|<>[]:;"')

_SLOTS = threading.BoundedSemaphore(8)  # requests in flight, across every ticket being built
_LOCK = threading.Lock()
_STATE = {"calls": 0, "down": set()}
_OPENER = None


def reset_run():
    """Forget the call budget and the hosts marked down — once per fetch run."""
    with _LOCK:
        _STATE["calls"] = 0
        _STATE["down"] = set()


def hosts_down():
    """Jenkins hosts that failed (network or auth) this run — for the run notes."""
    with _LOCK:
        return sorted(_STATE["down"])


# ── config ───────────────────────────────────────────────────────────────────


def _http_url(value):
    url = str(value or "").strip()
    if not re.match(r"^https?://[^/\s]+", url, re.I):
        return ""
    return url.rstrip("/") + "/"


def _https_url(value):
    url = _http_url(value)
    return url if url.lower().startswith("https://") else ""


def jobs_config(cfg=None):
    """{repo slug: [(env, job url), …]} from config → jenkins.jobs, environments in config order.
    Only https job URLs are used (the token travels with every call); an http one is skipped with a note.
    Repos with no usable job URL are left out."""
    if cfg is None:
        try:
            cfg = load_config(INTERN)
        except Exception as e:  # a broken config already fails loudly elsewhere
            sys.stderr.write(f"WARN jenkins config unreadable: {e}\n")
            return {}
    jobs = {}
    for repo, envs in ((cfg.get("jenkins") or {}).get("jobs") or {}).items():
        if not str(repo).strip() or not isinstance(envs, dict):
            continue
        pairs = []
        for env, raw in envs.items():
            env, url = str(env).strip(), _http_url(raw)
            if env and url and not _https_url(url):
                sys.stderr.write(f"WARN jenkins {str(repo).strip()}/{env}: job URL is not https — skipped (credentials are never sent over http)\n")
                continue
            if env and url:
                pairs.append((env, url))
        if pairs:
            jobs[str(repo).strip()] = pairs
    return jobs


def credentials():
    user = (os.environ.get("JENKINS_USER") or "").strip()
    token = (os.environ.get("JENKINS_API_TOKEN") or "").strip()
    return (user, token) if user and token else None


def enabled(jobs=None):
    """Jenkins is consulted only with at least one job configured AND both secrets set."""
    return bool(jobs if jobs is not None else jobs_config()) and credentials() is not None


# ── addressing ───────────────────────────────────────────────────────────────


def item_name(branch):
    """The Jenkins item name multibranch gives a branch job: each character Jenkins refuses in a
    name becomes %XX ('/' → %2F, '%' → %25), and '.' / '..' are spelled out."""
    name = str(branch or "")
    if name in (".", ".."):
        return "%2E" * len(name)
    return "".join(f"%{ord(c):02X}" if c in _UNSAFE else c for c in name)


def branch_segment(branch):
    """The branch job's path segment: its item name, URL-encoded (so %2F turns into %252F)."""
    return urllib.parse.quote(item_name(branch), safe="")


def branch_job_url(job_url, branch):
    return f"{str(job_url).rstrip('/')}/job/{branch_segment(branch)}/"


# ── HTTP ─────────────────────────────────────────────────────────────────────


def make_ssl_context():
    """Verified TLS for Jenkins, independent of JIRA_INSECURE_TLS; JENKINS_INSECURE_TLS=1 opts out."""
    return _safe_http.verified_context("JENKINS_INSECURE_TLS", "jenkins")


def _opener():
    global _OPENER
    if _OPENER is None:
        _OPENER = _safe_http.opener(make_ssl_context())
    return _OPENER


def get_json(url, headers, timeout, retries=1):
    """GET → JSON through the same-origin opener. 4xx raises at once; 5xx / network errors retry."""
    last = None
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers=headers)
            with _opener().open(req, timeout=timeout) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            last = e
            if e.code < 500 or attempt >= retries:
                raise
        except Exception as e:
            last = e
            if attempt >= retries:
                raise
        time.sleep(min(10, 2 ** attempt))
    raise last


def _host(url):
    return urllib.parse.urlsplit(url).netloc.lower()


def _get(url, what):
    """(json, status) for one Jenkins GET; status None when it could not be asked. Never raises.
    401/403 and network failures mark the host down for the rest of the run (one timeout, or one
    rejected token, is enough to know)."""
    creds = credentials()
    host = _host(url)
    with _LOCK:
        if not creds or host in _STATE["down"]:
            return None, None
        if _STATE["calls"] >= MAX_CALLS_PER_RUN:
            return None, None
        _STATE["calls"] += 1
    auth = base64.b64encode(f"{creds[0]}:{creds[1]}".encode()).decode()
    headers = {"Authorization": f"Basic {auth}", "Accept": "application/json"}
    try:
        with _SLOTS:
            return get_json(url, headers, timeout=TIMEOUT, retries=1), 200
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            with _LOCK:
                _STATE["down"].add(host)
            sys.stderr.write(f"WARN jenkins {host}: HTTP {e.code} — check JENKINS_USER / JENKINS_API_TOKEN; builds carried forward\n")
        elif e.code != 404:
            sys.stderr.write(f"WARN jenkins {what}: HTTP {e.code}\n")
        return None, e.code
    except (urllib.error.URLError, OSError) as e:
        with _LOCK:
            _STATE["down"].add(host)
        sys.stderr.write(f"WARN jenkins {host} unreachable ({what}): {getattr(e, 'reason', e)} — builds carried forward\n")
        return None, None
    except Exception as e:
        sys.stderr.write(f"WARN jenkins {what}: {e}\n")
        return None, None


def _tree(tree):
    return "tree=" + urllib.parse.quote(tree, safe=",")


# ── parsing ──────────────────────────────────────────────────────────────────


def _tests(actions):
    for a in actions:
        if isinstance(a, dict) and isinstance(a.get("totalCount"), int):
            return {"total": a["totalCount"], "failed": int(a.get("failCount") or 0), "skipped": int(a.get("skipCount") or 0)}
    return None


def _params(actions):
    out = {}
    for a in actions:
        for p in (a.get("parameters") if isinstance(a, dict) else None) or []:
            if isinstance(p, dict) and p.get("name"):
                out[str(p["name"]).upper()] = p.get("value")
    return out


def parse_build(raw, env, repo, branch):
    """One `lastBuild` answer → the stored shape (src/types.ts::JenkinsBuild)."""
    actions = [a for a in raw.get("actions") or [] if isinstance(a, dict)]
    building = bool(raw.get("building"))
    result = str(raw.get("result") or "").upper()
    if building:
        result = "BUILDING"
    elif result not in RESULTS:
        result = "NOT_BUILT"
    params = _params(actions)
    target = next((str(params[k]).strip() for k in DEPLOY_PARAMS if isinstance(params.get(k), str) and params[k].strip()), None)
    duration = raw.get("duration")
    out = {
        "env": env,
        "repo": repo,
        "branch": branch,
        "number": raw.get("number"),
        "result": result,
        "url": raw.get("url") if _http_url(raw.get("url")) else None,
        "at": iso(raw.get("timestamp")) if raw.get("timestamp") else None,
        "durationMs": int(duration) if isinstance(duration, (int, float)) and duration > 0 and not building else None,
        "deployTarget": target or env,
    }
    tests = _tests(actions)
    if tests:
        out["tests"] = tests
    return out


def _failing_names(build_url):
    data, _ = _get(build_url + "testReport/api/json?" + _tree(REPORT_TREE), "test report")
    if not isinstance(data, dict):
        return None
    names = []
    for suite in data.get("suites") or []:
        for case in (suite or {}).get("cases") or []:
            if isinstance(case, dict) and str(case.get("status") or "").upper() in ("FAILED", "REGRESSION"):
                cls, name = case.get("className") or "", case.get("name") or ""
                names.append(f"{cls}.{name}" if cls else name)
                if len(names) >= FAILING_CAP:
                    return names
    return names


def _failed_stage(build_url):
    data, _ = _get(build_url + "wfapi/describe", "stage view")
    stages = data.get("stages") if isinstance(data, dict) else None
    for stage in stages or []:
        if isinstance(stage, dict) and str(stage.get("status") or "").upper() in ("FAILED", "UNSTABLE"):
            return stage.get("name")
    return None


def latest_build(job_url, env, repo, branch):
    """(OK, build) | (NONE, None) when the branch has no build in this job | (FAILED, None)."""
    branch_job = branch_job_url(job_url, branch)
    raw, status = _get(branch_job + "lastBuild/api/json?" + _tree(BUILD_TREE), f"{repo}/{env} {branch}")
    if status == 404:
        return NONE, None
    if not isinstance(raw, dict):
        return FAILED, None
    b = parse_build(raw, env, repo, branch)
    number = b.get("number")
    if isinstance(number, int):
        # Built from the CONFIGURED job URL, so credentials never follow a URL Jenkins handed back.
        build_url = f"{branch_job}{number}/"
        if b.get("tests", {}).get("failed"):
            failing = _failing_names(build_url)
            if failing:
                b["tests"]["failing"] = failing
        if b["result"] in ("FAILURE", "UNSTABLE"):
            stage = _failed_stage(build_url)
            if stage:
                b["failedStage"] = stage
    return OK, b


# ── which branches ───────────────────────────────────────────────────────────

_PR_REPO_RE = re.compile(r"/projects/[^/]+/repos/([^/]+)/pull-requests/")


def _norm(s):
    return re.sub(r"\s+", "-", str(s or "").strip().lower())


def _pr_repo(p):
    m = _PR_REPO_RE.search(p.get("url") or "")
    return m.group(1) if m else p.get("repo")


def targets_for(ticket, repos=None, jobs=None):
    """[(repo, env, job url, branch)] to look up for a ticket: its branches and its PRs' source
    branches, in a configured repo, one entry per environment (config order). The primary branch
    and open-PR branches come first; source branches of merged / declined PRs (usually deleted)
    come last; the list is capped at MAX_TARGETS_PER_TICKET. `repos` maps branch → repo slug
    (devinfo's dev-status lookup); a branch whose repo is unknown is tried in every configured repo."""
    jobs = jobs_config() if jobs is None else jobs
    if not jobs:
        return []
    by_norm = {_norm(r): r for r in jobs}
    repos = {b: r for b, r in (repos or {}).items() if b}

    prs = [p for p in ticket.get("prs") or [] if isinstance(p, dict) and p.get("sourceBranch")]
    history = {p["sourceBranch"] for p in prs if p.get("merged") or p.get("state") in ("merged", "declined")}
    open_prs = [p for p in prs if p["sourceBranch"] not in history]
    candidates = []  # (branch, repo or None)
    if ticket.get("branch"):
        candidates.append((ticket["branch"], repos.get(ticket["branch"])))
    candidates += [(p["sourceBranch"], _pr_repo(p) or repos.get(p["sourceBranch"])) for p in open_prs]
    candidates += [(b, repos.get(b)) for b in ticket.get("branches") or [] if b and b not in history]
    candidates += [(p["sourceBranch"], _pr_repo(p) or repos.get(p["sourceBranch"])) for p in prs if p["sourceBranch"] in history]

    out, seen = [], set()
    for branch, repo in candidates:
        if repo:
            matched = [by_norm[_norm(repo)]] if _norm(repo) in by_norm else []
        else:
            matched = list(jobs)
        for r in matched:
            if (r, branch) in seen:
                continue
            seen.add((r, branch))
            out += [(r, env, url, branch) for env, url in jobs[r]]
    return out[:MAX_TARGETS_PER_TICKET]


def _ident(b):
    return (str(b.get("repo") or "").lower(), b.get("env"), b.get("branch"))


def builds_for(targets, prior=None, workers=4):
    """Latest build per target. A target with no build is left out; a target whose lookup failed
    keeps its build from `prior` (the previous dump). Returns None when every lookup failed — the
    caller then keeps what it had, untouched."""
    if not targets:
        return []
    prior_by = {_ident(b): b for b in prior or [] if isinstance(b, dict)}

    def one(t):
        repo, env, url, branch = t
        return t, latest_build(url, env, repo, branch)

    with ThreadPoolExecutor(max_workers=max(1, min(workers, len(targets)))) as ex:
        results = list(ex.map(one, targets))

    out, answered = [], False
    for (repo, env, _url, branch), (status, build) in results:
        if status == OK:
            answered = True
            out.append(build)
        elif status == NONE:
            answered = True
        else:
            old = prior_by.get((repo.lower(), env, branch))
            if old:
                out.append({**old, "stale": True})  # could not re-read it: the UI and the CI gate must not trust it
    if not answered:
        return None
    return out
