#!/usr/bin/env python3
"""Checkmarx One — which vulnerabilities a vulnerability-fix ticket actually fixed.

Only for vulnerability-fix tickets (`is_vuln_fix`). The ticket names its targets — CVE ids, SAST
query names / CWE ids, Checkmarx result links or ids, vulnerable package versions
(`extract_targets`) — and every target is looked up in TWO scans of the repository behind the
ticket's pull request (`scan_plan`): the latest completed scan of the PR's source branch and the
latest completed scan of its base (the PR's destination; else the project's main branch; else the
first of main / master / develop that has a scan). Per target (`_decide`):

  fixed      in the base scan, not open on the branch: absent from the branch scan, or there with
             status FIXED, or triaged NOT_EXPLOITABLE (the detail says which — a triage is not a
             code change, but Checkmarx no longer counts it)
  open       still detected (and not triaged away) on the branch
  not-found  in neither scan — the ticket may name the wrong id, or the finding was never there
  unknown    no answer can be proved: the branch has no completed scan that ran the target's engine
             (SCA for CVEs / packages, SAST for queries / CWEs / result ids — "branch scan did not run
             SCA"), the base has none to compare with ("base scan did not run SAST"), the branch scan is
             OLDER than the base scan (its absence proves nothing), the ticket names a per-scan result
             id rather than a similarityId, no Checkmarx project matches the repo (exact name or
             ".../<slug>", never a substring guess), or a scan has more results than the board reads
             (MAX_PAGES)

Only the newest 20 completed scans of a branch are listed; the newest one that ran the engine wins.
A package target with only a from-version stays open on the branch while ANY version of it still
carries an open finding (no to-version to compare with).

Auth: CHECKMARX_API_KEY (setup/.env; the environment wins) is an API key = OAuth refresh token,
exchanged once per run at the token URL (CHECKMARX_AUTH_URL, else derived from the tenant host)
for a short-lived bearer token. The key travels only in that POST body, never in a URL or a log.
Hosts come only from the configuration (CHECKMARX_BASE_URL / endpoints.checkmarxBase).

Failure semantics follow devinfo.py / jenkins.py: a network, auth or HTTP error, or an exhausted
call budget, means the lookup FAILED — `vuln_fixes_for` returns None and callers carry the previous
`vulnFixes` forward. "No project" or "no scan" is an answer (stored, with status unknown).
Stdlib only, like the rest of jira-intern. Shared with ai-intern/worker.py, which has no Checkmarx
client of its own.
"""
import html as _html
import json
import os
import re
import ssl
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

import _health
import _safe_http
from _config import load_config, load_secrets

INTERN = os.path.dirname(os.path.abspath(__file__))

TIMEOUT = 25
PAGE_SIZE = 100
MAX_PAGES = 10  # per scan: 1,000 results; a scan with more is "truncated" (absence proves nothing)
MAX_CALLS_PER_RUN = 300
MAX_TARGETS = 12
BASE_FALLBACKS = ("main", "master", "develop")
CLIENT_ID = "ast-app"

KINDS = ("cve", "sast", "result", "package")

# ── which tickets ────────────────────────────────────────────────────────────

# A bare "dependency" used to count; it matched "blocked by a dependency". A dependency UPGRADE still does.
SECURITY_RE = re.compile(
    r"cve-\d{4}-\d+|checkmarx|vulnerab|\bsca\b|\bsast\b|cwe-\d|spring4shell|\bowasp\b"
    r"|dependenc(?:y|ies)\s+(?:upgrade|bump|update)|(?:upgrade|bump|update)s?\s+(?:the\s+)?(?:vulnerable\s+)?dependenc",
    re.I,
)

_TAG_RE = re.compile(r"<[^>]+>")
_HREF_TAG_RE = re.compile(r"""<a\b[^>]*?\bhref\s*=\s*["']([^"']*)["'][^>]*>""", re.I)
URL_RE = re.compile(r"https?://[^\s<>\"']+", re.I)


def _plain(html_text):
    """Light HTML → text; a link's href stays in place so result URLs are seen."""
    s = _HREF_TAG_RE.sub(lambda m: f" {m.group(1)} ", str(html_text or ""))
    return _html.unescape(_TAG_RE.sub(" ", s))


def classify_text(ticket):
    """What decides "vulnerability fix": title, type, labels, description, acceptance criteria —
    NOT comments (a passing "unrelated to CVE-x" in a comment must not classify a ticket)."""
    t = ticket or {}
    parts = [t.get("title"), t.get("type"), " ".join(t.get("labels") or []), _plain(t.get("description"))]
    parts += [str(a) for a in t.get("acceptanceCriteria") or []]
    return " ".join(str(p) for p in parts if p)


def is_vuln_fix(ticket):
    return bool(SECURITY_RE.search(classify_text(ticket)))


def ticket_text(ticket):
    """Where targets are read: title, description, acceptance criteria, comments, and the URLs of
    external links / sources (links in the description and comments ride along via their hrefs)."""
    t = ticket or {}
    parts = [classify_text(t)]
    parts += [_plain(c.get("body")) for c in t.get("comments") or [] if isinstance(c, dict)]
    for group in ("externalLinks", "sources"):
        for link in t.get(group) or []:
            if isinstance(link, dict):
                parts += [str(link.get("url") or ""), str(link.get("title") or "")]
    return "\n".join(p for p in parts if p)


# ── targets ──────────────────────────────────────────────────────────────────

CVE_RE = re.compile(r"\bCVE-(\d{4})-(\d{4,7})\b", re.I)
CWE_RE = re.compile(r"\bCWE[-_ ]?(\d{1,4})\b", re.I)
# A Checkmarx query name: Title_Case words joined by underscores, at least one lower-case letter
# (SCREAMING_CASE is an env var), and a vulnerability word — "Feature_Toggle" is not a query.
QUERY_RE = re.compile(r"(?<![\w-])[A-Z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b")
VULN_WORDS = (
    "injection", "xss", "scripting", "traversal", "csrf", "ssrf", "xxe", "deserializ", "redirect", "hardcoded",
    "hard_coded", "password", "credential", "crypto", "cipher", "hash", "random", "cookie", "hsts", "csp", "cors",
    "overflow", "race_condition", "privacy", "leak", "exposure", "disclosure", "forging", "forgery", "manipulation",
    "tampering", "sensitive", "trust_boundary", "unvalidated", "unsafe", "insecure", "weak", "ldap", "xpath",
    "clickjacking", "authentication", "authorization", "access_control", "redos", "file_upload", "bypass",
    "privilege", "secret", "certificate", "jwt", "eval", "mass_assignment", "idor", "object_level", "denial_of_service",
)
# The common query names people write with spaces.
QUERY_PHRASES = (
    (re.compile(r"\bsql[ -]injection\b", re.I), "SQL_Injection"),
    (re.compile(r"\bcommand[ -]injection\b", re.I), "Command_Injection"),
    (re.compile(r"\bldap[ -]injection\b", re.I), "LDAP_Injection"),
    (re.compile(r"\bxpath[ -]injection\b", re.I), "XPath_Injection"),
    (re.compile(r"\bstored[ -]xss\b", re.I), "Stored_XSS"),
    (re.compile(r"\breflected[ -]xss\b", re.I), "Reflected_XSS"),
    (re.compile(r"\bdom[ -]xss\b", re.I), "DOM_XSS"),
    (re.compile(r"\bpath[ -]traversal\b", re.I), "Path_Traversal"),
    (re.compile(r"\bopen[ -]redirect\b", re.I), "Open_Redirect"),
    (re.compile(r"\blog[ -]forging\b", re.I), "Log_Forging"),
)
# Explicit ids in prose: "similarityId: -123", "resultId=abc", "result-id abc" (not inside a URL).
RESULT_ID_RE = re.compile(r"\b(?:result[-_]?id|similarity[-_ ]?id)\s*[:=#]?\s*(-?[A-Za-z0-9+/=_-]{4,})", re.I)
RESULT_PARAMS = ("result-id", "resultid", "result_id", "similarityid", "similarity-id", "similarity_id")

_VER = r"v?(\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.]+)?)"
_VER_LOOSE = r"v?(\d+(?:\.\d+){0,3}(?:[-+][0-9A-Za-z.]+)?)"
# lodash@4.17.20, @babel/traverse@7.22.5 (not an e-mail: the version must be digits).
NPM_RE = re.compile(r"(?<![\w@/.-])(@?[a-z0-9][\w.-]*(?:/[\w.-]+)?)@" + _VER + r"(?![\w.])", re.I)
# org.apache.commons:commons-text:1.9 (group:artifact:version).
MAVEN_RE = re.compile(r"(?<![\w.:-])([a-z][\w-]*(?:\.[\w-]+)+):([a-z][\w.-]*?):" + _VER + r"(?![\w.])", re.I)
# upgrade / bump / update / patch <pkg> [from] [<ver>] to <ver>
UPGRADE_RE = re.compile(
    r"\b(?:upgrade|bump|update|patch)(?:s|d)?\s+(?:the\s+)?([@a-z][\w.@/:-]*[a-z0-9])"
    r"(?:\s+(?:dependency|library|package|lib|jar))?(?:\s+(?:from\s+)?" + _VER + r")?\s+(?:to|→|->)\s+" + _VER_LOOSE,
    re.I,
)
# log4j-core 2.14.1 — a lower-case name with a hyphen or a dot, then a version (case-sensitive on purpose).
NAME_VER_RE = re.compile(r"(?<![\w/.@:-])([a-z][a-z0-9_]*(?:[-.][a-z0-9_]+)+)\s+" + _VER + r"(?![\w.])")
NOT_PACKAGES = {"version", "release", "java", "jdk", "node", "nodejs", "python", "sprint", "build", "it", "this", "ticket",
                "branch", "pr", "tls", "ssl", "docs", "readme", "changelog", "app", "service", "code"}


def _vuln_query(token):
    low = token.lower()
    return any(c.islower() for c in token) and any(w in low for w in VULN_WORDS)


def _qnorm(s):
    return re.sub(r"[^a-z0-9]", "", str(s or "").lower())


def _split_version(name, version):
    """'org.x:lib:1.9' / 'pkg@1.2' captured as a name → (name, version)."""
    m = re.match(r"^(.+?)[:@]v?(\d+(?:\.\d+)+[\w.-]*)$", name)
    if m and not version:
        return m.group(1), m.group(2)
    return name, version


def _package_label(pkg, frm, to):
    return pkg + (f" {frm}" if frm else "") + (f" → {to}" if to else "")


_NEG_BEFORE_RE = re.compile(
    r"(?:\bnot|\bunrelated\s+to|\bisn't|\baren't|\bnever|\bnothing\s+to\s+do\s+with)\s+(?:the\s+|a\s+|an\s+)?$", re.I)
_NEG_AFTER_RE = re.compile(
    r"^[\s,)\]]*(?:(?:is|was|are|were|seems|looks)\s+)?(?:unrelated|not\s+(?:affected|relevant|applicable|related))", re.I)


def _negated(text, start, end):
    """"not CVE-x", "unrelated to CVE-x", "CVE-x is unrelated" — a mention that says it is NOT a target."""
    before = re.split(r"[.;:!?\n]", text[max(0, start - 40):start])[-1]
    return bool(_NEG_BEFORE_RE.search(before) or _NEG_AFTER_RE.match(text[end:end + 40]))


def _main_text(ticket):
    """Everything but the comments: title, type, labels, description, AC, external links / sources."""
    t = ticket or {}
    parts = [classify_text(t)]
    for group in ("externalLinks", "sources"):
        for link in t.get(group) or []:
            if isinstance(link, dict):
                parts += [str(link.get("url") or ""), str(link.get("title") or "")]
    return "\n".join(p for p in parts if p)


def _comment_text(ticket):
    return "\n".join(_plain(c.get("body")) for c in (ticket or {}).get("comments") or [] if isinstance(c, dict))


def extract_targets(ticket):
    """What the ticket says it fixes, as [{target, kind, …match keys}] — CVEs first, then SAST queries
    and CWEs, result ids, packages; each kind in the order the text names them. Targets named only in
    comments come after all the others (a passing mention is weaker evidence), and negated mentions
    ("not CVE-x", "unrelated to …") are ignored. At most MAX_TARGETS."""
    out, seen = [], set()
    for text in (_main_text(ticket), _comment_text(ticket)):
        for key, target in _extract(text):
            if key not in seen:
                seen.add(key)
                out.append(target)
    return out[:MAX_TARGETS]


def _extract(text):
    """[((kind, key), target)] found in one text, kind-ordered, then by position."""
    found = {k: [] for k in KINDS}  # kind → [(pos, target dict)]
    seen = set()

    def add(kind, pos, key, target, end=None):
        if (kind, key) in seen:
            return
        if end is not None and _negated(text, pos, end):
            return
        seen.add((kind, key))
        found[kind].append((pos, ((kind, key), target)))

    for m in CVE_RE.finditer(text):
        cve = f"CVE-{m.group(1)}-{m.group(2)}"
        add("cve", m.start(), cve, {"target": cve, "kind": "cve", "cve": cve}, m.end())

    for m in QUERY_RE.finditer(text):
        tok = m.group(0)
        if _vuln_query(tok):
            add("sast", m.start(), "q:" + _qnorm(tok), {"target": tok, "kind": "sast", "query": tok}, m.end())
    for rx, name in QUERY_PHRASES:
        for m in rx.finditer(text):
            add("sast", m.start(), "q:" + _qnorm(name), {"target": name, "kind": "sast", "query": name}, m.end())
    for m in CWE_RE.finditer(text):
        n = int(m.group(1))
        add("sast", m.start(), f"cwe:{n}", {"target": f"CWE-{n}", "kind": "sast", "cwe": n}, m.end())

    ui_host = None
    for m in URL_RE.finditer(text):
        url = m.group(0).rstrip(".,;)")
        parts = urllib.parse.urlsplit(url)
        host = (parts.hostname or "").lower()
        if "checkmarx" not in host and "cxone" not in host:
            ui_host = _ui_host() if ui_host is None else ui_host
            if not ui_host or host != ui_host:
                continue
        for k, v in urllib.parse.parse_qsl(parts.query + "&" + parts.fragment.split("?", 1)[-1]):
            if k.lower() in RESULT_PARAMS and re.match(r"^-?[A-Za-z0-9+/=_-]{4,}$", v or ""):
                add("result", m.start(), v, {"target": f"result {v}", "kind": "result", "id": v})
    no_urls = URL_RE.sub(lambda m: " " * len(m.group(0)), text)
    for m in RESULT_ID_RE.finditer(no_urls):
        v = m.group(1)
        add("result", m.start(), v, {"target": f"result {v}", "kind": "result", "id": v}, m.end())

    pkgs = {}  # name → [pos, from, to]

    def pkg(pos, name, frm, to, end):
        name, frm = _split_version(name, frm)
        if name.lower() in NOT_PACKAGES or not re.search(r"[a-z]", name, re.I) or _negated(text, pos, end):
            return
        cur = pkgs.get(name.lower())
        if cur is None:
            pkgs[name.lower()] = [pos, name, frm, to]
        else:
            cur[2] = cur[2] or frm
            cur[3] = cur[3] or to

    for m in UPGRADE_RE.finditer(no_urls):
        pkg(m.start(1), m.group(1), m.group(2), m.group(3), m.end(1))
    for m in MAVEN_RE.finditer(no_urls):
        pkg(m.start(), f"{m.group(1)}:{m.group(2)}", m.group(3), None, m.end())
    for m in NPM_RE.finditer(no_urls):
        pkg(m.start(), m.group(1), m.group(2), None, m.end())
    for m in NAME_VER_RE.finditer(no_urls):
        pkg(m.start(), m.group(1), m.group(2), None, m.end())
    # "bcprov-jdk15on 1.53" next to "org.bouncycastle:bcprov-jdk15on:1.53" is one package: keep the coordinate.
    for low, (pos, name, frm, to) in list(pkgs.items()):
        if ":" in low:
            continue
        full = next((k for k in pkgs if ":" in k and k.rsplit(":", 1)[1] == low), None)
        if full:
            pkgs[full][0] = min(pkgs[full][0], pos)
            pkgs[full][2] = pkgs[full][2] or frm
            pkgs[full][3] = pkgs[full][3] or to
            del pkgs[low]
    for pos, name, frm, to in pkgs.values():
        add("package", pos, "p:" + name.lower(),
            {"target": _package_label(name, frm, to), "kind": "package", "package": name, "from": frm, "to": to})

    out = []
    for kind in KINDS:
        out += [t for _pos, t in sorted(found[kind], key=lambda x: x[0])]
    return out


# ── which repo / branches ────────────────────────────────────────────────────

_PR_REPO_RE = re.compile(r"/projects/[^/]+/repos/([^/]+)/pull-requests/")


def _pr_repo(p):
    m = _PR_REPO_RE.search(p.get("url") or "")
    return m.group(1) if m else (p.get("repo") or None)


def _is_merged(p):
    return bool(p.get("merged")) or p.get("state") == "merged"


def scan_plan(ticket, repos=None):
    """{repo, branch, base} to compare, or None: the open PR (else the newest merged one) gives the
    repo slug, the source branch and the base (its destination); without a PR, the ticket's branch
    when its repo is known (`repos`: branch → slug, from Jira's dev-status). Declined PRs never count."""
    t = ticket or {}
    listed = t.get("prs") if isinstance(t.get("prs"), list) and t.get("prs") else [t.get("pr")]  # old dumps: `pr` only
    prs = [p for p in listed if isinstance(p, dict) and p.get("sourceBranch")]
    open_prs = [p for p in prs if not _is_merged(p) and p.get("state") != "declined"]
    merged = sorted([p for p in prs if _is_merged(p)], key=lambda p: str(p.get("mergedAt") or ""), reverse=True)
    for p in open_prs + merged:
        repo = _pr_repo(p)
        if repo:
            return {"repo": repo, "branch": p["sourceBranch"], "base": p.get("destinationBranch") or None}
    branch = t.get("branch")
    repo = (repos or {}).get(branch) if branch else None
    if branch and repo:
        return {"repo": repo, "branch": branch, "base": None}
    return None


# ── config ───────────────────────────────────────────────────────────────────


def _setting(name):
    """Environment first, then setup/.env — re-read, so a key saved in the board's API keys dialog
    is used without a restart. Never printed."""
    v = (os.environ.get(name) or "").strip()
    if v:
        return v
    try:
        return (load_secrets(INTERN).get(name) or "").strip()
    except OSError:
        return ""


def _config_endpoints():
    try:
        return load_config(INTERN).get("endpoints") or {}
    except Exception:
        return {}


def _strip(url):
    url = str(url or "").strip().rstrip("/")
    return url if re.match(r"^https://[^/\s]+", url, re.I) else ""


def urls():
    """(api_base, token_url); both "" when Checkmarx One is not configured.

    CHECKMARX_BASE_URL (or CHECKMARX_URL) / endpoints.checkmarxBase is the tenant's API host, e.g.
    https://your-tenant.cxone.cloud. CHECKMARX_AUTH_URL / endpoints.checkmarxAuthUrl is the full
    OAuth token endpoint; absent, it is <base>/auth/realms/<tenant>/protocol/openid-connect/token,
    <tenant> being the first DNS label of the base host. https only."""
    ep = _config_endpoints()
    base = _strip(_setting("CHECKMARX_BASE_URL") or _setting("CHECKMARX_URL") or ep.get("checkmarxBase"))
    if not base:
        return "", ""
    auth = _strip(_setting("CHECKMARX_AUTH_URL") or ep.get("checkmarxAuthUrl"))
    if not auth:
        host = urllib.parse.urlsplit(base).hostname or ""
        tenant = host.split(".")[0] if host else ""
        if not tenant:
            return base, ""
        auth = f"{base}/auth/realms/{urllib.parse.quote(tenant, safe='')}/protocol/openid-connect/token"
    return base, auth


def _ui_host():
    base = _strip(_setting("CHECKMARX_BASE_URL") or _setting("CHECKMARX_URL"))
    return (urllib.parse.urlsplit(base).hostname or "").lower() if base else ""


def enabled():
    base, auth = urls()
    return bool(base and auth and _setting("CHECKMARX_API_KEY"))


# ── HTTP ─────────────────────────────────────────────────────────────────────

_LOCK = threading.Lock()
_STATE = {"calls": 0, "down": False, "token": None, "token_until": 0.0, "cache": {}}
_KEY_LOCKS = {}
_SSL = None
_OPENER = None
# One lookup "run" at a time in a long-lived process (the AI worker): reset_run + vuln_fixes_for
# under this lock, so a second job cannot wipe the token / budget / caches mid-lookup.
RUN_LOCK = threading.Lock()


class LookupFailed(Exception):
    pass


def reset_run():
    """Forget the call budget, the token, the "down" flag and the per-run caches — once per run."""
    with _LOCK:
        _STATE.update(calls=0, down=False, token=None, token_until=0.0, cache={})
        _KEY_LOCKS.clear()


def isolated_lookup(ticket, targets=None, repos=None):
    """A fresh run (reset_run) and one vuln_fixes_for, serialised by RUN_LOCK — for callers that run
    concurrent jobs in one process (ai-intern/worker.py). The daily fetch uses reset_run once per run."""
    with RUN_LOCK:
        reset_run()
        return vuln_fixes_for(ticket, targets, repos)


def unreachable():
    """True when Checkmarx failed (network, auth) this run — for the run notes."""
    with _LOCK:
        return bool(_STATE["down"])


def _ssl_context():
    """ALWAYS verified (Checkmarx One is SaaS — JIRA_INSECURE_TLS never applies). A corporate proxy CA
    is ADDED from JIRA_CA_BUNDLE / ~/.ai/ca-bundle.pem, as for every other fetch."""
    global _SSL
    if _SSL is None:
        _SSL = _safe_http.verified_context(None, "checkmarx")
    return _SSL


def _opener():
    """Verified TLS, and redirects only within the same origin — the bearer token and the API key
    never follow a redirect to another host or down to http (_safe_http.SameOriginRedirect)."""
    global _OPENER
    if _OPENER is None:
        _OPENER = _safe_http.opener(_ssl_context())
    return _OPENER


def _http(url, headers, data=None, timeout=TIMEOUT):
    """One request → parsed JSON. The single network seam (tests replace it)."""
    req = urllib.request.Request(url, data=data, headers=headers, method="POST" if data is not None else "GET")
    with _opener().open(req, timeout=timeout) as r:
        raw = r.read()
        return json.loads(raw.decode("utf-8")) if raw else {}


def _call(url, headers, data=None, what=""):
    """JSON, or None for a 404. Raises LookupFailed for anything else that went wrong; a network or
    auth failure also stops every further call this run (one timeout is enough to know)."""
    with _LOCK:
        if _STATE["down"]:
            raise LookupFailed("checkmarx unreachable earlier in this run")
        if _STATE["calls"] >= MAX_CALLS_PER_RUN:
            raise LookupFailed("checkmarx call budget for this run used up")
        _STATE["calls"] += 1
    host = _health.host_of(url)
    try:
        result = _http(url, headers, data)
        _health.record_ok("checkmarx")
        return result
    except urllib.error.HTTPError as e:
        if what == "token" and e.code == 400:
            # Keycloak answers a revoked / invalid refresh token (the API key) with 400 invalid_grant.
            _health.record("checkmarx", False, status="auth-failed", http=400, detail="Key rejected (HTTP 400)")
        else:
            # A 404 (no such project / scan) is a lookup answer, not a service failure — skipped.
            _health.record_exception("checkmarx", e, host=host)
        if e.code == 404:
            return None
        if e.code in (401, 403):
            with _LOCK:
                _STATE["down"] = True
            sys.stderr.write(f"WARN checkmarx {what}: HTTP {e.code} — check CHECKMARX_API_KEY; vulnerability results carried forward\n")
        else:
            sys.stderr.write(f"WARN checkmarx {what}: HTTP {e.code}\n")
        raise LookupFailed(f"HTTP {e.code}") from e
    except (urllib.error.URLError, OSError) as e:
        _health.record_exception("checkmarx", e, host=host)
        with _LOCK:
            _STATE["down"] = True
        sys.stderr.write(f"WARN checkmarx unreachable ({what}): {getattr(e, 'reason', e)} — vulnerability results carried forward\n")
        raise LookupFailed(str(e)) from e
    except Exception as e:  # unreadable JSON and the like
        sys.stderr.write(f"WARN checkmarx {what}: {e}\n")
        raise LookupFailed(str(e)) from e


def _token():
    with _LOCK:
        if _STATE["token"] and time.time() < _STATE["token_until"]:
            return _STATE["token"]
    base, auth = urls()
    key = _setting("CHECKMARX_API_KEY")
    if not (base and auth and key):
        raise LookupFailed("checkmarx not configured")
    body = urllib.parse.urlencode({"grant_type": "refresh_token", "client_id": CLIENT_ID, "refresh_token": key}).encode()
    try:
        tok = _call(auth, {"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"}, body, "token") or {}
    except LookupFailed:
        with _LOCK:  # any token failure (5xx, bad JSON, redirect) — no bearer token, so stop asking this run
            _STATE["down"] = True
        raise
    access = tok.get("access_token") if isinstance(tok, dict) else None
    if not access:
        with _LOCK:
            _STATE["down"] = True
        raise LookupFailed("no access token")
    life = tok.get("expires_in") if isinstance(tok.get("expires_in"), (int, float)) else 300
    with _LOCK:
        _STATE["token"], _STATE["token_until"] = access, time.time() + max(30, life - 60)
    return access


def _api(path, what):
    base, _auth = urls()
    return _call(base + path, {"Authorization": f"Bearer {_token()}", "Accept": "application/json"}, None, what)


def _cached(key, fn):
    """Per-run memo (the base branch's scan is shared by every ticket of a repo). One lock per key,
    so parallel ticket builds do not fetch the same scan twice."""
    with _LOCK:
        if key in _STATE["cache"]:
            return _STATE["cache"][key]
        lock = _KEY_LOCKS.setdefault(key, threading.Lock())
    with lock:
        with _LOCK:
            if key in _STATE["cache"]:
                return _STATE["cache"][key]
        val = fn()
        with _LOCK:
            _STATE["cache"][key] = val
        return val


def _q(s):
    return urllib.parse.quote(str(s), safe="")


# ── Checkmarx One reads ──────────────────────────────────────────────────────


def find_project(slug):
    """The project named exactly `slug` (case-insensitive) or ending in "/<slug>"; else None. Never a
    best guess — the search is a substring match, so its only hit may be another repository."""
    def fetch():
        data = _api(f"/api/projects?limit=20&name={_q(slug)}", f"project {slug}") or {}
        rows = [p for p in data.get("projects") or [] if isinstance(p, dict) and p.get("id")]
        low = slug.lower()
        for p in rows:
            name = str(p.get("name") or "").lower()
            if name == low or name.endswith("/" + low):
                return p
        return None

    return _cached(("project", slug.lower()), fetch)


# Which scan engine can see a target: SCA for CVEs and packages, SAST for queries / CWEs / result ids.
ENGINE = {"cve": "sca", "package": "sca", "sast": "sast", "result": "sast"}


def latest_scans(project_id, branch):
    """The COMPLETED scans of exactly this branch, newest first (at most 20)."""
    def fetch():
        path = (f"/api/scans?project-id={_q(project_id)}&branch={_q(branch)}&statuses=Completed&limit=20"
                f"&sort={_q('-created_at')}")
        data = _api(path, f"scans {branch}") or {}
        rows = [s for s in data.get("scans") or [] if isinstance(s, dict) and s.get("id") and s.get("branch") == branch
                and str(s.get("status") or "Completed").lower() == "completed"]
        rows.sort(key=lambda s: str(s.get("createdAt") or ""), reverse=True)
        return rows

    return _cached(("scans", project_id, branch), fetch)


def _ran(scan, engine):
    return engine in {str(e).lower() for e in scan.get("engines") or []}


def latest_scan(project_id, branch, engine=None):
    """The newest completed scan of this branch that ran `engine` ("sca" / "sast"; None = any), or None.
    A scan that did not run the engine cannot say anything about that engine's findings."""
    return next((s for s in latest_scans(project_id, branch) if engine is None or _ran(s, engine)), None)


def scan_results(scan_id):
    """(rows, truncated): the scan's results, PAGE_SIZE at a time, at most MAX_PAGES pages."""
    def fetch():
        rows, offset = [], 0
        for _page in range(MAX_PAGES):
            data = _api(f"/api/results?scan-id={_q(scan_id)}&limit={PAGE_SIZE}&offset={offset}", f"results {scan_id}") or {}
            batch = [r for r in data.get("results") or [] if isinstance(r, dict)]
            rows += batch
            offset += len(batch)
            total = data.get("totalCount")
            if not batch or len(batch) < PAGE_SIZE or (isinstance(total, int) and offset >= total):
                return rows, False
        total = data.get("totalCount")
        return rows, not (isinstance(total, int) and offset >= total)

    return _cached(("results", scan_id), fetch)


# ── matching ─────────────────────────────────────────────────────────────────

_MANAGERS = ("maven", "npm", "nuget", "pypi", "pip", "python", "go", "golang", "ruby", "rubygems", "php", "composer",
             "cocoapods", "ios", "swift", "cargo", "rust", "conan", "cpp", "gradle", "bower", "yarn")


def _vdetail(row):
    return row.get("vulnerabilityDetails") if isinstance(row.get("vulnerabilityDetails"), dict) else {}


def _data(row):
    return row.get("data") if isinstance(row.get("data"), dict) else {}


def package_of(row):
    """(name, version) of an SCA result — data.packageName/packageVersion when present, else parsed
    from data.packageIdentifier ("Maven-org.x:lib-1.2.3", "Npm-lodash-4.17.20")."""
    d = _data(row)
    if d.get("packageName"):
        return str(d["packageName"]), (str(d["packageVersion"]) if d.get("packageVersion") else None)
    ident = d.get("packageIdentifier")
    if isinstance(ident, dict):
        ident = ident.get("name") or ident.get("id") or ""
    ident = str(ident or "").strip()
    if not ident:
        return "", None
    head, _, rest = ident.partition("-")
    if rest and head.lower() in _MANAGERS:
        ident = rest
    m = re.match(r"^(.*?)[-@:]v?(\d+(?:\.\d+)*(?:[-.+][0-9A-Za-z.]+)?)$", ident)
    return (m.group(1), m.group(2)) if m else (ident, None)


def _vkey(v):
    return tuple(int(x) for x in re.findall(r"\d+", str(v or ""))[:4])


def _pkg_matches(name, target):
    want = target["package"].lower()
    n = name.lower()
    return n == want or n.endswith(":" + want) or n.endswith("/" + want)


def matches(target, row, side):
    """Does this result row stand for the target? `side` is "base" or "branch" — for a package the
    vulnerable version differs: the base may have any version ("upgrade X to 2.15"); on the branch
    only a version below the target (or equal to the named vulnerable one) still counts."""
    kind = target["kind"]
    rtype = str(row.get("type") or "").lower()
    if kind == "cve":
        return rtype.startswith("sca") and target["cve"] in (str(_vdetail(row).get("cveName") or "").upper(), str(row.get("id") or "").upper())
    if kind == "sast":
        if rtype != "sast":
            return False
        if "cwe" in target:
            try:
                return int(_vdetail(row).get("cweId")) == target["cwe"]
            except (TypeError, ValueError):
                return False
        want, got = _qnorm(target["query"]), _qnorm(_data(row).get("queryName"))
        return bool(got) and (got == want or (len(want) >= 8 and got.startswith(want)))
    if kind == "result":
        # similarityId is stable across scans; a result's own id is per scan, so it never proves absence.
        return target["id"] == str(row.get("similarityId") or "")
    if kind == "package":
        if not rtype.startswith("sca"):
            return False
        name, version = package_of(row)
        if not name or not _pkg_matches(name, target):
            return False
        if version is None:
            return True
        frm, to = target.get("from"), target.get("to")
        if side == "base":
            return not frm or version == frm
        if frm and version == frm:
            return True
        if to:
            return _vkey(version) < _vkey(to)
        # Only a from-version: any version still carrying an open finding keeps the target open.
        return True
    return False


def _closed(row):
    """Checkmarx no longer counts it: status FIXED, or triaged NOT_EXPLOITABLE."""
    return str(row.get("status") or "").upper() == "FIXED" or str(row.get("state") or "").upper() == "NOT_EXPLOITABLE"


def _location(row):
    if str(row.get("type") or "").lower().startswith("sca"):
        name, version = package_of(row)
        return f"{name} {version}".strip() if name else None
    d = _data(row)
    nodes = d.get("nodes") if isinstance(d.get("nodes"), list) else []
    node = next((n for n in nodes if isinstance(n, dict) and n.get("fileName")), None) or {}
    file = node.get("fileName") or d.get("fileName")
    line = node.get("line") or d.get("line")
    if not file:
        return None
    return f"{file}:{line}" if line else str(file)


def _what(target, row):
    """The finding's own name when the target is an id or a CWE ("Stored_XSS"), else ''."""
    if not row or target["kind"] in ("cve", "package"):
        return ""
    if target["kind"] == "sast" and "query" in target:
        return ""
    q = _data(row).get("queryName")
    if q:
        return str(q)
    return str(_vdetail(row).get("cveName") or "")


def _day(stamp):
    return str(stamp or "")[:10] or "?"


def _stamp(value):
    """Checkmarx timestamps ("2026-10-09T08:00:00.123456Z") → "2026-10-09T08:00:00Z"."""
    if not value:
        return None
    try:
        d = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return str(value)
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _decide(target, branch, base, b_scan, base_scan, b_rows, b_trunc, base_rows, base_trunc, b_any=False, base_any=False):
    """One stored item: {target, kind, status, severity?, location?, detail}. b_scan / base_scan are the
    newest completed scans that ran the target's engine; b_any / base_any say a scan of another engine exists."""
    on_branch = [r for r in b_rows if matches(target, r, "branch")]
    in_base = [r for r in base_rows if matches(target, r, "base")]
    still = [r for r in on_branch if not _closed(r)]
    b_at = f"{branch} (scan {_day(b_scan.get('createdAt'))})" if b_scan else branch
    base_name = base or "the base branch"
    base_at = f"{base_name} (scan {_day(base_scan.get('createdAt'))})" if base_scan else base_name
    lead = (still or on_branch or in_base or [None])[0]
    sev = str(((in_base or on_branch or [{}])[0]).get("severity") or "").upper() or None
    what = _what(target, lead)
    what = f"{what} " if what else ""

    eng = ENGINE.get(target["kind"], "sast").upper()
    per_scan = target["kind"] == "result" and any(str(r.get("id") or "") == target["id"] for r in base_rows + b_rows)
    if not b_scan:
        if b_any:
            status, detail = "unknown", f"Unknown — branch scan did not run {eng}: {branch} has no completed {eng} scan."
        else:
            status, detail = "unknown", f"Unknown — {branch} has no completed Checkmarx scan yet."
        lead, sev = None, None
    elif still:
        status = "open"
        detail = f"Open — {what}still on {b_at}" + (f" · {len(still)} findings" if len(still) > 1 else "") + "."
    elif on_branch:
        status = "fixed"
        how = "marked Not exploitable" if any(str(r.get("state") or "").upper() == "NOT_EXPLOITABLE" for r in on_branch) else "status Fixed"
        detail = f"Fixed — {what}{how} on {b_at}" + (" — still detected, triaged rather than removed." if how.startswith("marked") else ".")
    elif per_scan:
        status = "unknown"
        detail = (f"Unknown — {target['id']} is a per-scan result id, not a similarityId; it changes with every scan, "
                  f"so {b_at} cannot be compared. Name the similarityId on the ticket.")
    elif b_trunc:
        status = "unknown"
        detail = f"Unknown — {b_at} has more results than the board reads ({MAX_PAGES * PAGE_SIZE}); this one may be among the unread."
    elif in_base and base_scan and str(_stamp(b_scan.get("createdAt")) or "") < str(_stamp(base_scan.get("createdAt")) or ""):
        status = "unknown"
        detail = f"Unknown — branch scan older than base: {b_at} predates {base_at}, so its absence proves nothing. Rescan the branch."
    elif in_base:
        status = "fixed"
        detail = f"Fixed — {what}gone on {b_at}" + (f" · was {sev} on {base_at}" if sev else f" · was on {base_at}") + "."
    elif not base_scan:
        status = "unknown"
        why = f"base scan did not run {eng} on {base_name}" if base_any else f"{base_name} has no completed scan"
        detail = f"Unknown — not on {b_at}, but {why}, so there is nothing to compare."
    elif base_trunc:
        status = "unknown"
        detail = f"Unknown — not on {b_at}; {base_at} has more results than the board reads, so it may have been there."
    else:
        status = "not-found"
        detail = f"Not found — in neither scan: not on {b_at} nor on {base_at}. Check the id on the ticket."
    item = {"target": target["target"], "kind": target["kind"], "status": status}
    if sev and status != "not-found":
        item["severity"] = sev
    loc = _location(lead) if lead is not None and status != "unknown" else None
    if loc:
        item["location"] = loc
    item["detail"] = detail
    return item


def _now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def vuln_fixes_for(ticket, targets=None, repos=None):
    """The stored `vulnFixes` object (src/types.ts::VulnFixes), or None when there is nothing to ask
    (no targets, no PR / known branch) or the lookup FAILED — the caller then keeps what it had."""
    targets = targets if targets is not None else extract_targets(ticket)
    plan = scan_plan(ticket, repos)
    if not targets or not plan:
        return None
    branch = plan["branch"]
    out = {"scannedAt": _now_iso(), "project": plan["repo"], "branch": branch, "baseBranch": plan["base"],
           "branchScanAt": None, "baseScanAt": None}
    try:
        project = find_project(plan["repo"])
        if not project:
            out["note"] = f"No Checkmarx project named {plan['repo']}"
            out["items"] = [{"target": t["target"], "kind": t["kind"], "status": "unknown",
                             "detail": f"Unknown — no Checkmarx project matches the repository {plan['repo']}."} for t in targets]
            return out
        pid = project["id"]
        out["project"] = str(project.get("name") or plan["repo"])
        b_all = latest_scans(pid, branch)
        base, base_all = plan["base"], []
        if base:
            base_all = latest_scans(pid, base) if base != branch else []
        else:
            for cand in dict.fromkeys([project.get("mainBranch"), *BASE_FALLBACKS]):
                if cand and cand != branch:
                    base_all = latest_scans(pid, cand)
                    if base_all:
                        base = cand
                        break
            base = base or project.get("mainBranch") or None
        out["baseBranch"] = base
        per_engine = {}  # engine → (b_scan, base_scan, b_rows, b_trunc, base_rows, base_trunc)
        for eng in dict.fromkeys(ENGINE[t["kind"]] for t in targets):
            b_scan = next((s for s in b_all if _ran(s, eng)), None)
            base_scan = next((s for s in base_all if _ran(s, eng)), None)
            b_rows, b_trunc = scan_results(b_scan["id"]) if b_scan else ([], False)
            base_rows, base_trunc = scan_results(base_scan["id"]) if (base_scan and b_scan) else ([], False)
            per_engine[eng] = (b_scan, base_scan, b_rows, b_trunc, base_rows, base_trunc)
    except LookupFailed:
        return None
    used_b = [v[0] for v in per_engine.values() if v[0]]
    used_base = [v[1] for v in per_engine.values() if v[1]]
    newest = lambda scans: max((_stamp(s.get("createdAt")) or "" for s in scans), default="") or None  # noqa: E731
    out["branchScanAt"] = newest(used_b)
    out["baseScanAt"] = newest(used_base)
    if not b_all:
        out["note"] = f"{branch} has no completed Checkmarx scan yet"
    items = []
    for t in targets:
        b_scan, base_scan, b_rows, b_trunc, base_rows, base_trunc = per_engine[ENGINE[t["kind"]]]
        items.append(_decide(t, branch, base, b_scan, base_scan, b_rows, b_trunc, base_rows, base_trunc,
                             b_any=bool(b_all), base_any=bool(base_all)))
    out["items"] = items
    return out
