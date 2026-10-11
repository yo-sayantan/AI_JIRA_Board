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

Discovery (jenkins_discovery.py) finds the pipelines instead of listing them: with a root folder
(JENKINS_ROOT_URL in setup/.env, or config jenkins.root) it walks the tree for the repository's
application folder(s), labels each pipeline's environment from its name, and this module reads the
latest build of the branch from each — a multibranch pipeline's branch job, or, for a plain job that
takes the branch as a build parameter, the newest build whose parameter names the branch. Explicit
jenkins.jobs entries override discovery for that repository and environment.
`python3 jira-intern/jenkins.py discover <repo-slug>` prints what the walk found.

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

import _health
import _safe_http
import _scrub
from _config import load_config
from _jira import INTERN, iso
from checkmarx import classify_text

RESULTS = ("SUCCESS", "FAILURE", "UNSTABLE", "ABORTED", "NOT_BUILT", "BUILDING")
# Build parameters that name where a pipeline deployed, most specific first.
DEPLOY_PARAMS = ("DEPLOY_ENV", "ENVIRONMENT", "ENV", "TARGET")
FAILING_CAP = 5
TIMEOUT = 20
# (repo, env, branch) lookups per ticket, and HTTP calls per run — a ticket with a dozen stale
# branches, or a board of fifty tickets, must not turn one refresh into thousands of requests.
MAX_TARGETS_PER_TICKET = 24
MAX_CALLS_PER_RUN = 800

# The console excerpt of a failed build (a ticket about a build / pipeline failure): the LAST lines only, read from the
# configured build URL, scrubbed (_scrub.tail). A log is never downloaded whole: a ranged request first, else a bounded
# stream whose last bytes are kept; a log longer than CONSOLE_READ_CAP is skipped (its end cannot be found without reading it).
CONSOLE_LINES = 40
CONSOLE_BYTES = 4096  # stored
CONSOLE_KEEP_BYTES = 16384  # read and kept before the last lines are cut out
CONSOLE_READ_CAP = 2 * 1024 * 1024
MAX_TAILS_PER_RUN = 25

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
_STATE = {"calls": 0, "down": set(), "listings": {}, "walks": {}, "tails": 0}
_OPENER = None


def reset_run():
    """Forget the call budget and the hosts marked down — once per fetch run."""
    with _LOCK:
        _STATE["calls"] = 0
        _STATE["tails"] = 0
        _STATE["down"] = set()
        _STATE["listings"] = {}  # folder listings read this run (discovery)
        _STATE["walks"] = {}  # discovery answers this run, per root + slug


def hosts_down():
    """Jenkins hosts that failed (network or auth) this run — for the run notes."""
    with _LOCK:
        return sorted(_STATE["down"])



# ── tickets about a failing build or pipeline ────────────────────────────────

_BUILD_WORDS = r"(?:build|builds|deploy|deployment|deployments|pipeline|pipelines|ci|jenkins|job)"
_FAIL_WORDS = r"(?:fail(?:ed|s|ing|ure|ures)?|broken|red|aborted|unstable)"
BUILD_FAILURE_RE = re.compile(
    rf"\b{_BUILD_WORDS}\b(?:\s+\w+){{0,3}}?\s+(?:(?:is|was|has|keeps|started|been)\s+)*{_FAIL_WORDS}\b"
    rf"|\b(?:fail(?:ed|ing|ure|ures)|broken)\s+(?:\w+\s+){{0,2}}{_BUILD_WORDS}\b",
    re.I,
)
BUILD_FAILURE_LABEL_RE = re.compile(
    r"^(?:build|pipeline|ci|deploy|deployment|jenkins)[-_ ]?(?:fail(?:ed|ure|ing)?|broken)$|^(?:broken|failed|failing)[-_ ](?:build|pipeline|ci|deploy|deployment)$", re.I)


def is_build_failure(ticket):
    """Is this ticket ABOUT a failing build / pipeline / deployment? Title, type, labels, description and acceptance criteria
    count (not comments — a passing "the build failed once" must not classify a ticket): "Jenkins pipeline failed on QA",
    "Build failed for payments-service", "UAT deploy failed again", "CI is red", a `build-failure` label. "Jenkins" or
    "pipeline" alone is not enough — there has to be a failure beside it. Decides which failed builds get a console excerpt
    and which tickets get a Jenkins section in the evidence."""
    t = ticket if isinstance(ticket, dict) else {}
    if any(BUILD_FAILURE_LABEL_RE.match(str(label).strip()) for label in t.get("labels") or []):
        return True
    return bool(BUILD_FAILURE_RE.search(classify_text(t)))


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
    cfg = _load_cfg(cfg)
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


def _load_cfg(cfg=None):
    if cfg is not None:
        return cfg
    try:
        return load_config(INTERN)
    except Exception as e:  # a broken config already fails loudly elsewhere
        sys.stderr.write(f"WARN jenkins config unreadable: {e}\n")
        return {}


def root_url(cfg=None):
    """The folder that holds the projects (https only): JENKINS_ROOT_URL from setup/.env wins over
    config jenkins.root. "" when unset or not https (credentials are never sent over http)."""
    raw = (os.environ.get("JENKINS_ROOT_URL") or "").strip()
    if not raw:
        raw = str((_load_cfg(cfg).get("jenkins") or {}).get("root") or "")
    url = _http_url(raw)
    if url and not _https_url(url):
        sys.stderr.write("WARN jenkins root: URL is not https — discovery skipped (credentials are never sent over http)\n")
        return ""
    return url


# Words (regex fragments, matched between non-alphanumerics, case-insensitive) that label an
# environment from a folder or pipeline name. Order = the order chips are listed and the order labels are tried.
DEFAULT_ENV_PATTERNS = {
    "dev": ["dev", "develop", "development"],
    "qa": ["qa", "test", "testing", "tst"],
    "stage": ["stage", "staging", "stg", "uat", "preprod", "pre-?prod", "pre-?production"],
    "demo": ["demo"],
    "prod": ["prod", "production", "prd", "live"],
}
DEFAULT_KIND_PATTERNS = {"build": ["build", "builds", "ci", "compile"], "deploy": ["deploy", "deploys", "deployment", "deployments", "release", "promote", "rollout"]}
DISCOVERY_DEFAULTS = {"appFolderRegex": "", "maxDepth": 4, "cacheMinutes": 60, "buildScan": 25, "maxCalls": 150}
DISCOVERY_LIMITS = {"maxDepth": (1, 8), "cacheMinutes": (0, 10080), "buildScan": (1, 100), "maxCalls": (5, 500)}


def _pattern_map(given, defaults):
    """Defaults overlaid label by label: a label with a usable list of strings replaces its default;
    a new label is added after the defaults; anything else is ignored."""
    out = {k: list(v) for k, v in defaults.items()}
    for label, words in (given if isinstance(given, dict) else {}).items():
        label = str(label).strip()
        words = [str(w).strip() for w in words if isinstance(w, str) and w.strip()] if isinstance(words, list) else []
        if label and words:
            out[label] = words
    return out


def discovery_config(cfg=None):
    """config → jenkins.discovery with defaults: {appFolderRegex, envPatterns, kindPatterns, maxDepth,
    cacheMinutes, buildScan, maxCalls}. Numbers are clamped; junk falls back to the default."""
    given = (_load_cfg(cfg).get("jenkins") or {}).get("discovery")
    given = given if isinstance(given, dict) else {}
    out = {"envPatterns": _pattern_map(given.get("envPatterns"), DEFAULT_ENV_PATTERNS)}
    kinds = given.get("kindPatterns") if isinstance(given.get("kindPatterns"), dict) else {}
    out["kindPatterns"] = {k: _pattern_map({k: kinds.get(k)}, {k: DEFAULT_KIND_PATTERNS[k]})[k] for k in DEFAULT_KIND_PATTERNS}
    regex = given.get("appFolderRegex")
    out["appFolderRegex"] = regex.strip() if isinstance(regex, str) else DISCOVERY_DEFAULTS["appFolderRegex"]
    for key, (lo, hi) in DISCOVERY_LIMITS.items():
        v = given.get(key)
        out[key] = max(lo, min(hi, v)) if isinstance(v, int) and not isinstance(v, bool) else DISCOVERY_DEFAULTS[key]
    return out


def credentials():
    user = (os.environ.get("JENKINS_USER") or "").strip()
    token = (os.environ.get("JENKINS_API_TOKEN") or "").strip()
    return (user, token) if user and token else None


def enabled(jobs=None):
    """Jenkins is consulted only with at least one job configured or a root to discover under,
    AND both secrets set."""
    return bool((jobs if jobs is not None else jobs_config()) or root_url()) and credentials() is not None


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
            data = get_json(url, headers, timeout=TIMEOUT, retries=1)
        _health.record_ok("jenkins")
        return data, 200
    except urllib.error.HTTPError as e:
        # A 404 here is "no build for this branch" — not a service failure; record_exception skips it.
        _health.record_exception("jenkins", e, host=host)
        if e.code in (401, 403):
            with _LOCK:
                _STATE["down"].add(host)
            sys.stderr.write(f"WARN jenkins {host}: HTTP {e.code} — check JENKINS_USER / JENKINS_API_TOKEN; builds carried forward\n")
        elif e.code != 404:
            sys.stderr.write(f"WARN jenkins {what}: HTTP {e.code}\n")
        return None, e.code
    except (urllib.error.URLError, OSError) as e:
        _health.record_exception("jenkins", e, host=host)
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


def _enrich(b, build_url):
    """Failing test names and the failed stage, read from the CONFIGURED build URL (so credentials
    never follow a URL Jenkins handed back). Extras that fail leave the build as it is."""
    if b.get("tests", {}).get("failed"):
        failing = _failing_names(build_url)
        if failing:
            b["tests"]["failing"] = failing
    if b["result"] in ("FAILURE", "UNSTABLE"):
        stage = _failed_stage(build_url)
        if stage:
            b["failedStage"] = stage
    return b


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
        _enrich(b, f"{branch_job}{number}/")
    return OK, b


# ── parameterised pipelines: the branch is a build parameter ─────────────────

_BRANCH_PARAM_RANKS = (re.compile(r"branch", re.I), re.compile(r"git_?ref", re.I), re.compile(r"revision", re.I), re.compile(r"(?<![a-z])tag", re.I))
SCAN_TREE = "builds[number,result,building,timestamp,duration,url,actions[parameters[name,value]]]"
_REF_PREFIXES = ("refs/remotes/origin/", "refs/heads/", "remotes/origin/", "origin/")


def branch_param(names):
    """The build parameter that carries the branch: branch > git ref > revision > tag, first by that
    order, then by position. None when no parameter name looks like one."""
    names = [str(n) for n in names or [] if n]
    for rx in _BRANCH_PARAM_RANKS:
        for n in names:
            if rx.search(n):
                return n
    return None


def norm_ref(value):
    """A parameter value as a plain branch name: no `origin/`, `refs/heads/`, `refs/remotes/origin/`."""
    v = str(value if value is not None else "").strip()
    for prefix in _REF_PREFIXES:
        if v.startswith(prefix):
            return v[len(prefix):]
    return v


def parameter_builds(job_url, param, env, repo, branch, pipeline, kind, env_param, scan):
    """(OK, [build, …]) | (NONE, []) | (FAILED, []) for a plain job that takes the branch as a build
    parameter: ONE call reads its last `scan` builds, and the newest whose `param` names `branch` is
    the latest run of that branch (the latest deployment, for a deploy job). With `env_param` (a job
    that serves several environments) it is the newest per value of that parameter, and the value
    labels the environment. A deploy job has no test report to read; a failure still names its stage."""
    job = str(job_url).rstrip("/") + "/"
    raw, status = _get(job + "api/json?" + _tree(SCAN_TREE + "{0,%d}" % scan), f"{repo}/{env} {pipeline}")
    if status == 404:
        return NONE, []
    if not isinstance(raw, dict):
        return FAILED, []
    want, key = norm_ref(branch), str(param).upper()
    builds = sorted((x for x in raw.get("builds") or [] if isinstance(x, dict) and isinstance(x.get("number"), int)), key=lambda x: -x["number"])
    out, seen = [], set()
    for x in builds:
        params = _params([a for a in x.get("actions") or [] if isinstance(a, dict)])
        if norm_ref(params.get(key)) != want or not isinstance(params.get(key), str):
            continue
        label = env
        if env_param:
            value = params.get(str(env_param).upper())
            value = str(value).strip() if isinstance(value, str) else ""
            if value:
                import jenkins_discovery  # lazy: it imports this module
                label = jenkins_discovery.infer_env([value], discovery_config()["envPatterns"]) or value.lower()
        if label in seen:
            continue
        seen.add(label)
        b = parse_build(x, label, repo, branch)
        build_url = f"{job}{x['number']}/"
        b["url"] = build_url
        if kind != "deploy":
            detail, _ = _get(build_url + "api/json?" + _tree(BUILD_TREE), f"{repo}/{label} {pipeline} #{x['number']}")
            tests = _tests([a for a in (detail or {}).get("actions") or [] if isinstance(a, dict)]) if isinstance(detail, dict) else None
            if tests:
                b["tests"] = tests
        _enrich(b, build_url)
        out.append(b)
        if not env_param:
            break
    return (OK, out) if out else (NONE, [])


# ── which branches ───────────────────────────────────────────────────────────

_PR_REPO_RE = re.compile(r"/projects/[^/]+/repos/([^/]+)/pull-requests/")


def _norm(s):
    return re.sub(r"\s+", "-", str(s or "").strip().lower())


def _pr_repo(p):
    m = _PR_REPO_RE.search(p.get("url") or "")
    return m.group(1) if m else p.get("repo")


def _candidates(ticket, repos):
    """[(branch, repo slug or None)] — the primary branch and open-PR branches first; source
    branches of merged / declined PRs (usually deleted) last."""
    repos = {b: r for b, r in (repos or {}).items() if b}
    prs = [p for p in ticket.get("prs") or [] if isinstance(p, dict) and p.get("sourceBranch")]
    history = {p["sourceBranch"] for p in prs if p.get("merged") or p.get("state") in ("merged", "declined")}
    open_prs = [p for p in prs if p["sourceBranch"] not in history]
    out = []
    if ticket.get("branch"):
        out.append((ticket["branch"], repos.get(ticket["branch"])))
    out += [(p["sourceBranch"], _pr_repo(p) or repos.get(p["sourceBranch"])) for p in open_prs]
    out += [(b, repos.get(b)) for b in ticket.get("branches") or [] if b and b not in history]
    out += [(p["sourceBranch"], _pr_repo(p) or repos.get(p["sourceBranch"])) for p in prs if p["sourceBranch"] in history]
    return out


def candidate_repos(ticket, repos=None):
    """The repository slugs the ticket's branches live in, as devinfo / the PR urls name them — what
    discovery is asked about. A branch whose repo is unknown is not guessed against a whole tree."""
    out = []
    for _branch, repo in _candidates(ticket, repos):
        if repo and _norm(repo) not in {_norm(r) for r in out}:
            out.append(repo)
    return out


def targets_for(ticket, repos=None, jobs=None, discovered=None):
    """The lookups for a ticket, one per environment / pipeline and branch: its branches and its PRs'
    source branches in a repo that has configured jobs (an explicit jobs entry is a plain
    `(repo, env, job url, branch)` tuple) or discovered pipelines (a dict: repo, env, url, branch,
    pipeline, kind, via, param, envParam, envFrom). An explicit job for a repo and environment
    OVERRIDES the discovered pipelines labelled with that environment for that repo. Open-PR branches
    come first, the list is capped at MAX_TARGETS_PER_TICKET. `repos` maps branch → repo slug
    (devinfo's dev-status lookup); a branch whose repo is unknown is tried in every configured
    repo's explicit jobs (never in discovery)."""
    jobs = jobs_config() if jobs is None else jobs
    found = {_norm(k): v for k, v in (discovered or {}).items() if v}
    if not jobs and not found:
        return []
    by_norm = {_norm(r): r for r in jobs}
    out, seen = [], set()
    for branch, repo in _candidates(ticket, repos):
        if repo:
            matched = [by_norm[_norm(repo)]] if _norm(repo) in by_norm else []
            discovered_here = found.get(_norm(repo), [])
        else:
            matched, discovered_here = list(jobs), []
        for r in matched:
            if (r, branch) in seen:
                continue
            seen.add((r, branch))
            out += [(r, env, url, branch) for env, url in jobs[r]]
        if discovered_here and ("discovered", _norm(repo), branch) not in seen:
            seen.add(("discovered", _norm(repo), branch))
            explicit = by_norm.get(_norm(repo))
            explicit_envs = {str(e).strip().lower() for e, _u in jobs.get(explicit, [])} if explicit else set()
            for p in discovered_here:
                if str(p.get("env") or "").strip().lower() in explicit_envs:
                    continue
                out.append({"repo": explicit or repo, "env": p.get("env"), "url": p.get("url"), "branch": branch, "pipeline": p.get("name"),
                            "kind": p.get("kind"), "via": p.get("via") or "branch-job", "param": p.get("param"),
                            "envParam": p.get("envParam"), "envFrom": p.get("envFrom")})
    return out[:MAX_TARGETS_PER_TICKET]


def discovery_for(slugs, cfg=None, use_cache=True):
    """({slug: [pipeline, …]}, {slugs that could not be read}) — jenkins_discovery's answer for each
    repository, served from the cache inside its TTL and from a stale entry when the walk fails.
    Nothing is asked without a root; a slug that failed with no cache to fall back on is in the
    second set, so the caller carries that repository's builds forward instead of dropping them."""
    root = root_url(cfg)
    if not root or not slugs:
        return {}, set()
    import jenkins_discovery
    dcfg = discovery_config(cfg)
    found, failed = {}, set()
    for slug in slugs:
        r = jenkins_discovery.discover(root, slug, dcfg, use_cache=use_cache)
        if r["status"] == "failed":
            failed.add(slug)
        else:
            found[slug] = r["pipelines"]
    return found, failed


def _as_target(t):
    if isinstance(t, dict):
        return {"pipeline": None, "kind": None, "via": "branch-job", "param": None, "envParam": None, "envFrom": None, **t}
    repo, env, url, branch = t
    return {"repo": repo, "env": env, "url": url, "branch": branch, "pipeline": None, "kind": None, "via": "branch-job", "param": None, "envParam": None, "envFrom": None}


def _tag(b, t):
    """Say which pipeline a discovered build came from (explicit jobs add nothing, so old dumps and
    new ones agree for them)."""
    if t["pipeline"]:
        b["pipeline"] = t["pipeline"]
        if t["kind"]:
            b["kind"] = t["kind"]
        b["via"] = t["via"]
    return b


def lookup(target, scan=None):
    """(OK, [build, …]) | (NONE, []) | (FAILED, []) for one target tuple / dict."""
    t = _as_target(target)
    if t["via"] == "parameter" and t["param"]:
        status, builds = parameter_builds(t["url"], t["param"], t["env"], t["repo"], t["branch"], t["pipeline"], t["kind"],
                                          t["envParam"] if t["envFrom"] == "pipeline" else None, scan or DISCOVERY_DEFAULTS["buildScan"])
    else:
        status, build = latest_build(t["url"], t["env"], t["repo"], t["branch"])
        builds = [build] if build else []
    return status, [_tag(b, t) for b in builds]


def _ident(b):
    return (str(b.get("repo") or "").lower(), b.get("env"), b.get("pipeline") or None, b.get("branch"))


def builds_for(targets, prior=None, workers=4, scan=None):
    """Latest build per target (a discovered pipeline may give one per environment it serves). A
    target with no build is left out; a target whose lookup failed keeps its build(s) from `prior`
    (the previous dump), marked stale. Returns None when every lookup failed — the caller then keeps
    what it had, untouched."""
    if not targets:
        return []
    prior = [b for b in prior or [] if isinstance(b, dict)]
    scan = scan or DISCOVERY_DEFAULTS["buildScan"]

    with ThreadPoolExecutor(max_workers=max(1, min(workers, len(targets)))) as ex:
        results = list(ex.map(lambda t: (_as_target(t), lookup(t, scan)), targets))

    out, answered = [], False
    for t, (status, builds) in results:
        if status == OK:
            answered = True
            out += builds
        elif status == NONE:
            answered = True
        else:
            repo = t["repo"].lower()
            for old in prior:
                same = str(old.get("repo") or "").lower() == repo and old.get("branch") == t["branch"] and (old.get("pipeline") or None) == t["pipeline"]
                # An explicit job is one environment; a discovered job may serve several (its parameter names them).
                if same and (t["pipeline"] or old.get("env") == t["env"]):
                    out.append({**old, "stale": True})  # could not re-read it: the UI and the CI gate must not trust it
    if not answered:
        return None
    return out


# ── console excerpt ──────────────────────────────────────────────────────────


def _read_tail(url, headers, timeout, keep=CONSOLE_KEEP_BYTES, cap=CONSOLE_READ_CAP):
    """(HTTP status, the last `keep` bytes of the body, whether the end was reached). The network seam for the console:
    a server that honours the Range header sends only the tail (206); otherwise the body is streamed, only the last
    bytes are kept, and the read stops at `cap` (then the end was NOT reached)."""
    req = urllib.request.Request(url, headers=headers)
    with _opener().open(req, timeout=timeout) as r:
        status = getattr(r, "status", 200)
        window, total = b"", 0
        while True:
            chunk = r.read(65536)
            if not chunk:
                return status, window, True
            total += len(chunk)
            window = (window + chunk)[-keep:]
            if status != 206 and total > cap:
                return status, window, False


def console_tail(build_url):
    """The last CONSOLE_LINES lines (at most CONSOLE_BYTES) of a build's console, scrubbed of secrets.

      a non-empty string   the excerpt
      ""                   there is nothing to excerpt and asking again will not change that: no such log (404), an empty
                           log, or one too long to find the end of without reading all of it — stored as is, so the next
                           run does not read it again
      None                 it could not be asked this time (not configured, an http URL, the call / tail budget is spent,
                           the host is down, a network or server error) — the next run tries again

    `build_url` must be the CONFIGURED build address (never a URL Jenkins returned): the token goes only in the header."""
    url = _https_url(build_url)
    creds = credentials()
    if not url or not creds:
        return None
    host = _host(url)
    with _LOCK:
        if host in _STATE["down"] or _STATE["calls"] >= MAX_CALLS_PER_RUN or _STATE["tails"] >= MAX_TAILS_PER_RUN:
            return None
        _STATE["calls"] += 1
        _STATE["tails"] += 1
    auth = base64.b64encode(f"{creds[0]}:{creds[1]}".encode()).decode()
    headers = {"Authorization": f"Basic {auth}", "Accept": "text/plain", "Range": f"bytes=-{CONSOLE_KEEP_BYTES}"}
    try:
        with _SLOTS:
            status, data, complete = _read_tail(url.rstrip("/") + "/consoleText", headers, TIMEOUT)
        _health.record_ok("jenkins")
    except urllib.error.HTTPError as e:
        _health.record_exception("jenkins", e, host=host)  # a 404 is "no log for this build", not a service failure
        if e.code in (401, 403):
            with _LOCK:
                _STATE["down"].add(host)
            sys.stderr.write(f"WARN jenkins {host}: HTTP {e.code} — check JENKINS_USER / JENKINS_API_TOKEN; console excerpts skipped\n")
            return None
        if e.code == 404:
            return ""
        sys.stderr.write(f"WARN jenkins console: HTTP {e.code}\n")
        return None
    except (urllib.error.URLError, OSError) as e:
        _health.record_exception("jenkins", e, host=host)
        with _LOCK:
            _STATE["down"].add(host)
        sys.stderr.write(f"WARN jenkins {host} unreachable (console): {getattr(e, 'reason', e)}\n")
        return None
    except Exception as e:  # noqa: BLE001
        sys.stderr.write(f"WARN jenkins console: unexpected {type(e).__name__}\n")
        return None
    if status != 206 and not complete:
        sys.stderr.write("WARN jenkins console: log too long to find its end — no excerpt\n")
        return ""
    text = data.decode("utf-8", "replace")
    if len(data) >= CONSOLE_KEEP_BYTES and "\n" in text:
        text = text.split("\n", 1)[1]  # the window starts mid-line
    return _scrub.tail(text, CONSOLE_LINES, CONSOLE_BYTES)


def _build_url(t, number):
    """The configured address of build `number` of a target — the same one `_enrich` reads the test report from."""
    if t["via"] == "parameter":
        return f"{str(t['url']).rstrip('/')}/{number}/"
    return f"{branch_job_url(t['url'], t['branch'])}{number}/"


def _same_build(a, b):
    return _ident(a) == _ident(b) and a.get("number") == b.get("number")


def add_console_tails(ticket, builds, targets, prior=None):
    """Put `consoleTail` on the LATEST failed (FAILURE / UNSTABLE, not stale) build of a ticket that is about a build /
    pipeline failure (`is_build_failure`) — and on no other. A tail already stored for the same build number is kept
    without a call; a build that was carried forward stale keeps what it had; any other build loses a tail it carried
    (it has moved on). `consoleTail: ""` means "tried, nothing to excerpt" and is kept like an excerpt. `builds` is changed
    in place and returned."""
    prior = [b for b in prior or [] if isinstance(b, dict)]
    wanted = is_build_failure(ticket)
    failed = [b for b in builds if wanted and b.get("result") in ("FAILURE", "UNSTABLE") and not b.get("stale") and isinstance(b.get("number"), int)]
    pick = max(failed, key=lambda b: (b.get("at") or "", b["number"])) if failed else None
    for b in builds:
        if b is not pick and not b.get("stale"):
            b.pop("consoleTail", None)
    if pick is None:
        return builds
    old = next((o for o in prior if isinstance(o.get("consoleTail"), str) and _same_build(o, pick)), None)
    if old:  # an excerpt, or "" (tried: nothing to excerpt) — either way not asked again for this build
        pick["consoleTail"] = _scrub.tail(old["consoleTail"], CONSOLE_LINES, CONSOLE_BYTES)  # through the CURRENT scrubber again
        return builds
    pick.pop("consoleTail", None)
    for raw in targets or []:
        t = _as_target(raw)
        if _norm(t["repo"]) == _norm(pick.get("repo")) and t["branch"] == pick.get("branch") and (t["pipeline"] or None) == (pick.get("pipeline") or None) \
                and (t["pipeline"] or t["env"] == pick.get("env")):
            tail = console_tail(_build_url(t, pick["number"]))
            if tail is not None:
                pick["consoleTail"] = tail
            break
    return builds


# ── command line ─────────────────────────────────────────────────────────────


def cli(argv):
    """`jenkins.py discover <repo-slug> [--json]` — print what discovery finds, read-only. Exit 0 ok,
    1 the walk failed, 2 not configured (no root / credentials / slug)."""
    import jenkins_discovery
    return jenkins_discovery.main(argv)


if __name__ == "__main__":
    import jenkins as _self  # the module other code imports — one copy of the run state

    sys.exit(_self.cli(sys.argv[1:]))
