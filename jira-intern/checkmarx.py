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
  not-found  in neither scan — the ticket may name the wrong id, the finding was never there, or the fix is
             already in the base scan (the detail says what was read, and for a package upgrade the versions
             seen: "already at 6.5.9 on develop — the upgrade predates the base scan")
  unknown    no answer can be proved: the branch has no completed scan that ran the target's engine
             (SCA for CVEs / packages, SAST for queries / CWEs / result ids — "branch scan did not run
             SCA"), the base has none to compare with ("base scan did not run SAST"), the branch scan is
             OLDER than the base scan (its absence proves nothing), the ticket names a per-scan result
             id rather than a similarityId, no Checkmarx project matches the repo (exact name or
             ".../<slug>", never a substring guess), or a scan has more results than the board reads
             (MAX_PAGES)

Only the newest 20 completed scans of a branch are listed; the newest one that ran the engine wins. A merged
PR is judged against the newest base scan from BEFORE it merged — after the merge the base holds the fix, and
comparing with that scan would make every target "not found". Results are paged by what the server actually
serves (a server may cap the page size; only an empty page or totalCount ends the read) with no severity or state
filter, and every item says what was read (`vulnFixes.read`, the detail). `diagnose` (bottom of this file) prints
all of it from the terminal.
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
from types import SimpleNamespace

import _health
import _safe_http
import _sources
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

# Text from Jira is typed by anyone who can comment: every pattern is BOUNDED (a tag is at most 1,000 characters between its
# `<` and `>`, no nested lazy quantifiers) and each body is cut to MAX_BODY, so a comment of 32,000 unterminated `<a href='`
# cannot make a fetch spend minutes in the regex engine (the old patterns were cubic on exactly that).
_TAG_RE = re.compile(r"<[^<>]{1,1000}>")
_A_TAG_RE = re.compile(r"<a\b([^<>]{0,1000})>", re.I)
_HREF_ATTR_RE = re.compile(r"""\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))""", re.I)
URL_RE = re.compile(r"https?://[^\s<>\"']+", re.I)
MAX_BODY = 40_000
MAX_TICKET_TEXT = 200_000


def _plain(html_text):
    """Light HTML → text; a link's href stays in place so result URLs are seen."""

    def anchor(m):
        h = _HREF_ATTR_RE.search(m.group(1))
        url = (h.group(1) or h.group(2) or h.group(3) or "") if h else ""
        return f" {url} " if url else " "

    s = _A_TAG_RE.sub(anchor, str(html_text or "")[:MAX_BODY])
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
                parts += [str(link.get("url") or "")[:MAX_BODY], str(link.get("title") or "")[:MAX_BODY]]
    return "\n".join(p for p in parts if p)[:MAX_TICKET_TEXT]


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
    """{repo, branch, base[, mergedAt]} to compare, or None: the open PR (else the newest merged one)
    gives the repo slug, the source branch and the base (its destination) — and, for a merged PR, when it
    merged; without a PR, the ticket's branch when its repo is known (`repos`: branch → slug, from Jira's
    dev-status). Declined PRs never count."""
    t = ticket or {}
    listed = t.get("prs") if isinstance(t.get("prs"), list) and t.get("prs") else [t.get("pr")]  # old dumps: `pr` only
    prs = [p for p in listed if isinstance(p, dict) and p.get("sourceBranch")]
    open_prs = [p for p in prs if not _is_merged(p) and p.get("state") != "declined"]
    merged = sorted([p for p in prs if _is_merged(p)], key=lambda p: str(p.get("mergedAt") or ""), reverse=True)
    for p in open_prs + merged:
        repo = _pr_repo(p)
        if repo:
            plan = {"repo": repo, "branch": p["sourceBranch"], "base": p.get("destinationBranch") or None}
            if _is_merged(p) and p.get("mergedAt"):
                plan["mergedAt"] = p["mergedAt"]  # the base scan must predate it (see vuln_fixes_for)
            return plan
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


def missing_settings():
    """The NAMES of the settings that keep Checkmarx from being configured (never a value):
    CHECKMARX_BASE_URL, CHECKMARX_AUTH_URL (only when the base host gives no tenant to derive it from),
    CHECKMARX_API_KEY. Empty when `enabled()`."""
    base, auth = urls()
    gaps = []
    if not base:
        gaps.append("CHECKMARX_BASE_URL")
    elif not auth:
        gaps.append("CHECKMARX_AUTH_URL")
    if not _setting("CHECKMARX_API_KEY"):
        gaps.append("CHECKMARX_API_KEY")
    return gaps


# ── HTTP ─────────────────────────────────────────────────────────────────────

_LOCK = threading.Lock()
_STATE = {"calls": 0, "down": False, "token": None, "token_until": 0.0, "cache": {}, "failure": None}
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
        _STATE.update(calls=0, down=False, token=None, token_until=0.0, cache={}, failure=None)
        _KEY_LOCKS.clear()
    _sources.reset("checkmarx")  # the run's per-ticket account (_sources.py) starts over with the budget


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


def failure():
    """Why lookups failed this run, as (state, text) — the first failure wins — or None. `state` is
    'unreachable' | 'auth-failed' | 'budget-exhausted' (the vocabulary of `_sources`); `text` is a fixed,
    secret-free phrase, safe to store and show."""
    with _LOCK:
        return _STATE["failure"]


def _fail(state, text):
    with _LOCK:
        if _STATE["failure"] is None:
            _STATE["failure"] = (state, text)


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
            if _STATE["failure"] is None:
                _STATE["failure"] = ("budget-exhausted", f"the {MAX_CALLS_PER_RUN}-call budget for one fetch was used up")
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
            _fail("auth-failed", "the API key was rejected (HTTP 400)")
        else:
            # A 404 (no such project / scan) is a lookup answer, not a service failure — skipped.
            _health.record_exception("checkmarx", e, host=host)
        if e.code == 404:
            return None
        if e.code in (401, 403):
            with _LOCK:
                _STATE["down"] = True
            _fail("auth-failed", f"the API key was rejected (HTTP {e.code})")
            sys.stderr.write(f"WARN checkmarx {what}: HTTP {e.code} — check CHECKMARX_API_KEY; vulnerability results carried forward\n")
        else:
            _fail("unreachable", f"Checkmarx answered with an error (HTTP {e.code})")
            sys.stderr.write(f"WARN checkmarx {what}: HTTP {e.code}\n")
        raise LookupFailed(f"HTTP {e.code}") from e
    except (urllib.error.URLError, OSError) as e:
        _health.record_exception("checkmarx", e, host=host)
        with _LOCK:
            _STATE["down"] = True
        _fail("unreachable", f"{host} could not be reached" if host else "the host could not be reached")
        sys.stderr.write(f"WARN checkmarx unreachable ({what}): {getattr(e, 'reason', e)} — vulnerability results carried forward\n")
        raise LookupFailed(str(e)) from e
    except Exception as e:  # unreadable JSON and the like
        _fail("unreachable", "Checkmarx sent an answer the board could not read")
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
        _fail("unreachable", "the token endpoint gave no access token — check the Checkmarx base / auth URL")
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


def project_rows(slug):
    """Every project whose name contains `slug` (the API's name search is a substring match), at most 20."""
    def fetch():
        data = _api(f"/api/projects?limit=20&name={_q(slug)}", f"project {slug}") or {}
        return [p for p in data.get("projects") or [] if isinstance(p, dict) and p.get("id")]

    return _cached(("projects", slug.lower()), fetch)


def is_project_match(project, slug):
    """Named exactly `slug` (case-insensitive) or ending in "/<slug>" — never a substring guess."""
    name, low = str(project.get("name") or "").lower(), slug.lower()
    return name == low or name.endswith("/" + low)


def find_project(slug):
    """The project named exactly `slug` (case-insensitive) or ending in "/<slug>"; else None. Never a
    best guess — the search is a substring match, so its only hit may be another repository."""
    return next((p for p in project_rows(slug) if is_project_match(p, slug)), None)


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


def _kind_of(row):
    """Which engine a result row came from: 'sca' (type sca…), 'sast', else 'other' (kics, containers, …)."""
    rtype = str(row.get("type") or "").lower()
    if rtype.startswith("sca"):
        return "sca"
    return "sast" if rtype == "sast" else "other"


def tally(rows):
    """{total, sca, sast, other} of result rows."""
    out = {"total": len(rows), "sca": 0, "sast": 0, "other": 0}
    for r in rows:
        out[_kind_of(r)] += 1
    return out


def read_scan(scan_id):
    """One scan's results, as {rows, truncated, reported, pages, counts}.

    Paged with offset += rows actually served: a server may cap the page size below PAGE_SIZE (a short
    page is NOT the last page), so reading stops only on an EMPTY page or once `totalCount` is reached,
    or after MAX_PAGES pages. `truncated` is True unless the end was proved — the page limit hit with
    rows still coming, or an empty page while totalCount promised more. `reported` is the server's
    totalCount (None when it gave none). No severity / state filter: every result is read."""
    def fetch():
        rows, offset, total, pages = [], 0, None, 0
        truncated = True
        for _page in range(MAX_PAGES):
            data = _api(f"/api/results?scan-id={_q(scan_id)}&limit={PAGE_SIZE}&offset={offset}", f"results {scan_id}") or {}
            pages += 1
            batch = [r for r in data.get("results") or [] if isinstance(r, dict)]
            if isinstance(data.get("totalCount"), int):
                total = data["totalCount"]
            if not batch:
                truncated = isinstance(total, int) and offset < total
                break
            rows += batch
            offset += len(batch)
            if isinstance(total, int) and offset >= total:
                truncated = False
                break
        return {"rows": rows, "truncated": truncated, "reported": total, "pages": pages, "counts": tally(rows)}

    return _cached(("results", scan_id), fetch)


def scan_results(scan_id):
    """(rows, truncated) — `read_scan` without the bookkeeping."""
    r = read_scan(scan_id)
    return r["rows"], r["truncated"]


# ── matching ─────────────────────────────────────────────────────────────────

_MANAGERS = ("maven", "npm", "nuget", "pypi", "pip", "python", "go", "golang", "ruby", "rubygems", "php", "composer",
             "cocoapods", "ios", "swift", "cargo", "rust", "conan", "cpp", "gradle", "bower", "yarn")


def _vdetail(row):
    return row.get("vulnerabilityDetails") if isinstance(row.get("vulnerabilityDetails"), dict) else {}


def _data(row):
    return row.get("data") if isinstance(row.get("data"), dict) else {}


def cve_ids(row):
    """The CVE ids an SCA row carries — vulnerabilityDetails.cveName (the usual place), a few alternative spellings
    and the row's own id — trimmed and upper-cased, so " cve-2024-5555 " still matches CVE-2024-5555."""
    vals = [_vdetail(row).get(k) for k in ("cveName", "cveId", "cve")] + [_data(row).get(k) for k in ("cveName", "cveId", "cve")]
    vals += [row.get("cveName"), row.get("id")]
    return {str(v).strip().upper() for v in vals if v}


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


def package_versions(rows, target):
    """The distinct versions of the target's package that carry ANY finding in these rows, oldest first.
    (A package with no finding does not appear in a scan's results at all.)"""
    seen = set()
    for r in rows:
        if _kind_of(r) != "sca":
            continue
        name, version = package_of(r)
        if name and version and _pkg_matches(name, target):
            seen.add(version)
    return sorted(seen, key=lambda v: (_vkey(v), v))


def matches(target, row, side):
    """Does this result row stand for the target? `side` is "base" or "branch" — for a package the
    vulnerable version differs: the base may have any version ("upgrade X to 2.15"); on the branch
    only a version below the target (or equal to the named vulnerable one) still counts."""
    kind = target["kind"]
    rtype = str(row.get("type") or "").lower()
    if kind == "cve":
        return rtype.startswith("sca") and target["cve"] in cve_ids(row)
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
            if frm:
                return version == frm
            # Upgrade "X to 6.5.9": a base finding on 6.5.9 or later is not what the ticket fixes — the
            # upgrade is already in the base (package_versions / _decide say so).
            return _vkey(version) < _vkey(to) if to else True
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


def _mix(counts):
    """"SCA 380 · SAST 18 · other 14" — the non-zero parts of a tally."""
    return " · ".join(f"{label} {counts[k]}" for k, label in (("sca", "SCA"), ("sast", "SAST"), ("other", "other")) if counts.get(k))


def _read_clause(sides):
    """What was read, for the detail: "412 results on feature/x (SCA 380 · SAST 18); 0 results on develop — the
    results API returned nothing for this scan". `sides` is [(branch name, read-or-None)]."""
    out = []
    for name, r in sides:
        if r is None:
            continue
        n = r["counts"]["total"]
        out.append(f"{n} results on {name} ({_mix(r['counts'])})" if n else f"0 results on {name} — the results API returned nothing for this scan")
    return "; ".join(out)


def _unread(r):
    """"read 400 of 1200" — what a truncated scan gave versus what it holds."""
    n = r["counts"]["total"]
    return f"read {n}" + (f" of {r['reported']}" if isinstance(r.get("reported"), int) else "")


def _decide(target, c):
    """One stored item: {target, kind, status, severity?, location?, detail[, foundOnBase, foundOnBranch]}.
    `c` (a SimpleNamespace) carries: branch, base, b_scan / base_scan (the newest completed scans that ran the
    target's engine; base_scan is the newest one BEFORE the merge when the PR merged), b_read / base_read
    (read_scan results or None), b_any / base_any (a scan of another engine exists), merged_at, base_late
    (a scan that ran the engine but only after the merge) and hints (packages the ticket upgrades)."""
    branch, base, b_scan, base_scan = c.branch, c.base, c.b_scan, c.base_scan
    b_rows = c.b_read["rows"] if c.b_read else []
    base_rows = c.base_read["rows"] if c.base_read else []
    b_trunc = bool(c.b_read and c.b_read["truncated"])
    base_trunc = bool(c.base_read and c.base_read["truncated"])
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
    versions = None  # a package target: the versions of it that carry a finding on each side

    eng = ENGINE.get(target["kind"], "sast").upper()
    per_scan = target["kind"] == "result" and any(str(r.get("id") or "") == target["id"] for r in base_rows + b_rows)
    if target["kind"] == "package":
        versions = {"foundOnBase": package_versions(base_rows, target) if c.base_read else None,
                    "foundOnBranch": package_versions(b_rows, target) if c.b_read else None}
    if not b_scan:
        if c.b_any:
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
        detail = f"Unknown — {b_at} has more results than the board reads ({_unread(c.b_read)}); this one may be among the unread."
    elif in_base and base_scan and str(_stamp(b_scan.get("createdAt")) or "") < str(_stamp(base_scan.get("createdAt")) or ""):
        status = "unknown"
        detail = f"Unknown — branch scan older than base: {b_at} predates {base_at}, so its absence proves nothing. Rescan the branch."
    elif in_base:
        status = "fixed"
        detail = f"Fixed — {what}gone on {b_at}" + (f" · was {sev} on {base_at}" if sev else f" · was on {base_at}") + "."
    elif not base_scan:
        status = "unknown"
        if c.base_late:
            detail = (f"Unknown — not on {b_at}, but there is no {base_name} scan from before the PR merged ({_day(c.merged_at)}): the newest "
                      f"({_day(c.base_late.get('createdAt'))}) already contains the fix, so it cannot show the before.")
        else:
            why = f"base scan did not run {eng} on {base_name}" if c.base_any else f"{base_name} has no completed scan"
            detail = f"Unknown — not on {b_at}, but {why}, so there is nothing to compare."
    elif base_trunc:
        status = "unknown"
        detail = f"Unknown — not on {b_at}; {base_at} has more results than the board reads ({_unread(c.base_read)}), so it may have been there."
    else:
        status = "not-found"
        read = _read_clause([(branch, c.b_read), (base_name, c.base_read)])
        tail = " Check the id on the ticket."
        if target["kind"] == "package":
            to = target.get("to")
            late = [v for v in (versions["foundOnBase"] or []) if to and _vkey(v) >= _vkey(to)]
            if late:
                head = (f"Not found — {target['package']} is already at {late[-1]} on {base_at}: the upgrade predates the base scan, "
                        f"so no scan shows the before.")
                tail = ""
            else:
                head = f"Not found — in neither scan: no finding against {target['package']} on {b_at} nor on {base_at}."
        else:
            head = f"Not found — in neither scan: not on {b_at} nor on {base_at}."
            hint = _upgrade_hint(target, c)
            if hint:
                head += f" {hint}"
                tail = ""
        detail = f"{head} Read {read}.{tail}" if read else f"{head}{tail}"
    item = {"target": target["target"], "kind": target["kind"], "status": status}
    if sev and status != "not-found":
        item["severity"] = sev
    loc = _location(lead) if lead is not None and status != "unknown" else None
    if loc:
        item["location"] = loc
    item["detail"] = detail
    for key, vs in (versions or {}).items():
        if vs is not None:
            item[key] = vs
    return item


def _upgrade_hint(target, c):
    """For a CVE not found in either scan: the ticket's own package upgrade, when a scan already shows the package at
    or above the target version — the finding was probably fixed before that scan ("acme-core is already at 6.5.9
    on develop — the fix may predate that scan.")."""
    if target["kind"] != "cve":
        return ""
    for h in c.hints:
        for side, name in (("base", c.base or "the base branch"), ("branch", c.branch)):
            late = [v for v in h[side] if _vkey(v) >= _vkey(h["to"])]
            if late:
                return f"{h['package']} is already at {late[-1]} on {name} — the fix may predate that scan."
    return ""


def _now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _newest(scans):
    return max((_stamp(s.get("createdAt")) or "" for s in scans), default="") or None


def _gather(plan, targets, read_base_anyway=False, engines=None):
    """Everything Checkmarx says for one comparison — the project, the scans of both branches, and per engine the
    scans chosen and read. Raises LookupFailed. `project` is None when none matches the repository. A merged PR's
    baseline is the newest base scan from BEFORE it merged (after the merge the base holds the fix). The base scan
    is only read when the branch has one, unless `read_base_anyway`; `engines` overrides the engines the targets
    need (diagnose reads both)."""
    branch = plan["branch"]
    ctx = SimpleNamespace(project=None, branch=branch, base=plan["base"], b_all=[], base_all=[], per_engine={},
                          merged_at=_stamp(plan.get("mergedAt")))
    project = ctx.project = find_project(plan["repo"])
    if not project:
        return ctx
    pid = project["id"]
    b_all = ctx.b_all = latest_scans(pid, branch)
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
    ctx.base, ctx.base_all = base, base_all
    for eng in (engines or dict.fromkeys(ENGINE[t["kind"]] for t in targets)):
        ran = [s for s in base_all if _ran(s, eng)]
        before = [s for s in ran if not ctx.merged_at or (_stamp(s.get("createdAt")) or "") < ctx.merged_at]
        base_scan = before[0] if before else None
        b_scan = next((s for s in b_all if _ran(s, eng)), None)
        ctx.per_engine[eng] = SimpleNamespace(
            b_scan=b_scan, base_scan=base_scan,
            base_late=(ran[0] if ran and not before else None),
            b_read=read_scan(b_scan["id"]) if b_scan else None,
            base_read=read_scan(base_scan["id"]) if (base_scan and (b_scan or read_base_anyway)) else None)
    return ctx


def _read_summary(pairs):
    """vulnFixes.read — per side, what was read from the scan(s) the comparison used (summed when the SCA and SAST
    targets came from two different scans): {total, sca, sast, other, truncated[, reported]}."""
    sides = {"branch": {}, "base": {}}
    for p in pairs:
        if p.b_scan and p.b_read:
            sides["branch"][p.b_scan["id"]] = p.b_read
        if p.base_scan and p.base_read:
            sides["base"][p.base_scan["id"]] = p.base_read
    out = {}
    for side, reads in sides.items():
        if not reads:
            continue
        row = {k: sum(r["counts"][k] for r in reads.values()) for k in ("total", "sca", "sast", "other")}
        row["truncated"] = any(r["truncated"] for r in reads.values())
        reported = [r["reported"] for r in reads.values()]
        if all(isinstance(x, int) for x in reported):
            row["reported"] = sum(reported)
        out[side] = row
    return out


def _empty_note(read):
    """A scan that gave ZERO results is worth saying out loud — it is either a clean scan or an API that returned nothing."""
    empty = [side for side in ("branch", "base") if side in read and read[side]["total"] == 0]
    if not empty:
        return None
    if len(empty) == 2:
        return "The results API returned 0 results for both scans"
    return f"The results API returned 0 results for the {empty[0]} scan"


def _hints(targets, pair):
    """The ticket's package upgrades (with a target version) and the versions of each seen in the SCA scans."""
    if not pair:
        return []
    return [{"package": t["package"], "to": t["to"],
             "base": package_versions(pair.base_read["rows"], t) if pair.base_read else [],
             "branch": package_versions(pair.b_read["rows"], t) if pair.b_read else []}
            for t in targets if t["kind"] == "package" and t.get("to")]


def _context_for(target, ctx, hints):
    pair = ctx.per_engine[ENGINE[target["kind"]]]
    return SimpleNamespace(branch=ctx.branch, base=ctx.base, b_scan=pair.b_scan, base_scan=pair.base_scan, b_read=pair.b_read,
                           base_read=pair.base_read, b_any=bool(ctx.b_all), base_any=bool(ctx.base_all), merged_at=ctx.merged_at,
                           base_late=pair.base_late, hints=hints)


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
        ctx = _gather(plan, targets)
    except LookupFailed:
        return None
    if not ctx.project:
        out["note"] = f"No Checkmarx project named {plan['repo']}"
        out["items"] = [{"target": t["target"], "kind": t["kind"], "status": "unknown",
                         "detail": f"Unknown — no Checkmarx project matches the repository {plan['repo']}."} for t in targets]
        return out
    out["project"] = str(ctx.project.get("name") or plan["repo"])
    out["baseBranch"] = ctx.base
    pairs = list(ctx.per_engine.values())
    out["branchScanAt"] = _newest([p.b_scan for p in pairs if p.b_scan])
    out["baseScanAt"] = _newest([p.base_scan for p in pairs if p.base_scan])
    read = _read_summary(pairs)
    if read:
        out["read"] = read
    notes = []
    if not ctx.b_all:
        notes.append(f"{branch} has no completed Checkmarx scan yet")
    empty = _empty_note(read)
    if empty:
        notes.append(empty)
    if notes:
        out["note"] = " · ".join(notes)
    hints = _hints(targets, ctx.per_engine.get("sca"))
    out["items"] = [_decide(t, _context_for(t, ctx, hints)) for t in targets]
    return out


# ── diagnose: read-only, for the terminal ────────────────────────────────────
#
#   python3 jira-intern/checkmarx.py diagnose <TICKET-KEY | repo-slug> [--branch B] [--base B] [--target T …]
#
# Says what the board would see — the project matched, the scans considered, how many results were read from each
# (by engine, severity and status), the FIELD NAMES of the rows (never their values), and for every target what
# matched or why not. Uses setup/.env + the config like the fetch does. Prints no token, key or auth URL.
# Exit: 0 read · 1 Checkmarx could not be read (key rejected, host unreachable) · 2 not configured / bad arguments.

TICKET_KEY_RE = re.compile(r"^[A-Z][A-Z0-9]+-\d+$")


def _ticket_from_dump(key):
    """The ticket's card in jira-intern/data.json (board, completed, raised, then nested sub-tasks), or None."""
    try:
        with open(os.path.join(INTERN, "data.json"), encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    for section in ("tickets", "completed", "raised"):
        for t in data.get(section) or []:
            if isinstance(t, dict) and t.get("key") == key:
                return t
    for section in ("tickets", "completed"):
        for t in data.get(section) or []:
            for sub in (t.get("subtasks") or []) if isinstance(t, dict) else []:
                if isinstance(sub, dict) and sub.get("key") == key:
                    return sub
    return None


def _scan_summary(scan_id):
    """{engine: (total, {severity: n})} from /api/scan-summary, or None — best effort, an extra opinion on the count."""
    try:
        data = _api(f"/api/scan-summary?scan-ids={_q(scan_id)}", f"summary {scan_id}") or {}
    except LookupFailed:
        return None
    rows = data.get("scansSummaries")
    row = rows[0] if isinstance(rows, list) and rows and isinstance(rows[0], dict) else None
    if not row:
        return None
    out = {}
    for engine, key in (("sca", "scaCounters"), ("sast", "sastCounters")):
        counters = row.get(key)
        if not isinstance(counters, dict):
            continue
        sev = {str(c.get("severity") or "?").upper(): int(c.get("counter") or 0) for c in counters.get("severityCounters") or [] if isinstance(c, dict)}
        total = counters.get("totalCounter")
        out[engine] = (int(total) if isinstance(total, (int, float)) else sum(sev.values()), sev)
    return out


def _count_by(rows, field):
    out = {}
    for r in rows:
        v = str(r.get(field) or "?").upper()
        out[v] = out.get(v, 0) + 1
    return out


def _counts_line(d):
    return " · ".join(f"{k} {n}" for k, n in sorted(d.items(), key=lambda kv: -kv[1]))


def _fields(row):
    """The field names of a result row — top level, data, vulnerabilityDetails — and no values."""
    parts = [f"fields: {', '.join(sorted(row))}"]
    for sub in ("data", "vulnerabilityDetails"):
        if isinstance(row.get(sub), dict):
            parts.append(f"{sub}: {', '.join(sorted(row[sub]))}")
    return "; ".join(parts)


def _when(stamp):
    return (_stamp(stamp) or "?").replace("T", " ").rstrip("Z")[:16]


def _similar_packages(rows, target):
    """Package names in these rows that share the target's longest word — for a package the scanner names differently."""
    words = sorted(re.split(r"[-_.:/@\s]+", target["package"].lower()), key=len, reverse=True)
    word = words[0] if words and len(words[0]) >= 4 else ""
    names = {package_of(r)[0] for r in rows if _kind_of(r) == "sca"}
    return sorted(n for n in names if word and word in n.lower() and not _pkg_matches(n, target))[:5]


def diagnose(plan, targets, label):
    """(exit code, text) for one comparison — see the section header."""
    out = []
    say = out.append
    base_url, _auth = urls()
    say(f"Checkmarx diagnose — {label}")
    say(f"  host: {urllib.parse.urlsplit(base_url).hostname}   API key: set   token endpoint: "
        f"{'explicit' if (_setting('CHECKMARX_AUTH_URL') or _config_endpoints().get('checkmarxAuthUrl')) else 'derived from the host'}")
    merged = f"   (PR merged {_day(plan.get('mergedAt'))})" if plan.get("mergedAt") else ""
    say(f"  repository: {plan['repo']}   branch: {plan['branch']}   base: {plan.get('base') or 'not named — the project main branch is used'}{merged}")
    reset_run()
    try:
        rows = project_rows(plan["repo"])
        say("")
        say("Project")
        if not rows:
            say(f"  no project's name contains '{plan['repo']}' — nothing to read")
        for p in rows:
            tag = "MATCH " if is_project_match(p, plan["repo"]) else "(substring only — not used)"
            say(f"  {tag} {p.get('name')}   id {str(p.get('id'))[:8]}   main branch: {p.get('mainBranch') or '—'}")
        ctx = _gather(plan, targets, read_base_anyway=True, engines=("sca", "sast"))
        if not ctx.project:
            say("  → the board would say: no Checkmarx project matches this repository (every target unknown)")
            return 0, "\n".join(out)
        say("")
        say("Scans considered (completed only, newest first)")
        for name, scans in ((f"branch {plan['branch']}", ctx.b_all), (f"base {ctx.base or '?'}", ctx.base_all)):
            say(f"  {name}: {len(scans)} scan(s)" + ("" if scans else " — the board would say there is no scan"))
            for sc in scans[:5]:
                say(f"    {str(sc.get('id'))[:8]}  {_when(sc.get('createdAt'))}  engines: {', '.join(str(e) for e in sc.get('engines') or []) or '—'}")
        for eng, pair in ctx.per_engine.items():
            used = f"  used for {eng.upper()}: branch {str(pair.b_scan['id'])[:8] if pair.b_scan else 'none'} · base {str(pair.base_scan['id'])[:8] if pair.base_scan else 'none'}"
            if pair.base_late:
                used += (f" — the newest base scan ({str(pair.base_late['id'])[:8]}, {_when(pair.base_late.get('createdAt'))}) is after the PR "
                         f"merged ({_day(ctx.merged_at)}), so it already holds the fix and is not the baseline")
            say(used)
        say("")
        say("Results read (what the results API returned; no severity or state filter is sent)")
        shown = set()
        for eng, pair in ctx.per_engine.items():
            for side, scan, rd in (("branch", pair.b_scan, pair.b_read), ("base", pair.base_scan, pair.base_read)):
                if not scan or scan["id"] in shown:
                    continue
                shown.add(scan["id"])
                if rd is None:
                    say(f"  {side} scan {str(scan['id'])[:8]}: not read — the branch has no scan to compare it with")
                    continue
                c = rd["counts"]
                say(f"  {side} scan {str(scan['id'])[:8]} ({_when(scan.get('createdAt'))}): {c['total']} results — "
                    f"SCA {c['sca']} · SAST {c['sast']} · other {c['other']}"
                    + (f"   server reports {rd['reported']}" if rd.get("reported") is not None else "   server reported no totalCount")
                    + f"   pages {rd['pages']}" + ("   TRUNCATED (page limit)" if rd["truncated"] else ""))
                rws = rd["rows"]
                if rws:
                    say(f"    types: {_counts_line(_count_by(rws, 'type'))}   severity: {_counts_line(_count_by(rws, 'severity'))}   "
                        f"status: {_counts_line(_count_by(rws, 'status'))}")
                    for kind in ("sca", "sast"):
                        sample = next((r for r in rws if _kind_of(r) == kind), None)
                        if sample:
                            say(f"    {kind.upper()} row — {_fields(sample)}")
                    sca_rows = [r for r in rws if _kind_of(r) == "sca"]
                    if sca_rows:
                        named = sum(1 for r in sca_rows if str(_vdetail(r).get("cveName") or "").strip())
                        say(f"    SCA rows carrying vulnerabilityDetails.cveName: {named} of {len(sca_rows)}")
                summary = _scan_summary(scan["id"])
                for engine, (total, sev) in (summary or {}).items():
                    have = c[engine]
                    verdict = ("agrees with the rows read" if total == have else
                               f"but only {have} {engine.upper()} rows were read — the results are incomplete, or the summary counts something else")
                    say(f"    scan-summary counts {total} {engine.upper()} findings ({_counts_line(sev) or 'no breakdown'}) — {verdict}")
        say("")
        say("Targets" if targets else "Targets: the ticket names none the board can look up")
        hints = _hints(targets, ctx.per_engine.get("sca"))
        for t in targets:
            it = _decide(t, _context_for(t, ctx, hints))
            say(f"  {t['target']}  [{t['kind']}]  → {it['status']}")
            say(f"    {it['detail']}")
            if t["kind"] == "package":
                say(f"    versions with a finding — base: {', '.join(it.get('foundOnBase') or []) or 'none'}; branch: {', '.join(it.get('foundOnBranch') or []) or 'none'}")
                pair = ctx.per_engine["sca"]
                near = sorted(set(_similar_packages(pair.base_read["rows"] if pair.base_read else [], t)
                                  + _similar_packages(pair.b_read["rows"] if pair.b_read else [], t)))
                if near:
                    say(f"    similar package names in the scans: {', '.join(near)}")
    except LookupFailed:
        why = failure()
        out.append("")
        out.append(f"Checkmarx could not be read: {why[1] if why else 'the request failed'}.")
        return 1, "\n".join(out)
    return 0, "\n".join(out)


def main(argv=None):
    import argparse

    ap = argparse.ArgumentParser(prog="checkmarx.py", description="Checkmarx One helpers for the board (read-only).")
    sub = ap.add_subparsers(dest="cmd")
    d = sub.add_parser("diagnose", help="what Checkmarx returns for a ticket (or repository) and why each target matched or not")
    d.add_argument("what", help="a ticket key on the board (PAY-7) or a repository slug")
    d.add_argument("--branch", help="the PR source branch (needed for a repository slug)")
    d.add_argument("--base", help="the base branch to compare with (default: the PR destination, else the project's main branch)")
    d.add_argument("--target", action="append", default=[], help="a CVE / package / query to look up (repeatable; for a repository slug)")
    args = ap.parse_args(argv)
    if args.cmd != "diagnose":
        ap.print_usage()
        return 2
    gaps = missing_settings()
    if gaps:
        print(f"Checkmarx is not configured — missing {', '.join(gaps)}. Add it in the board's API keys dialog (setup/.env) "
              f"or endpoints.checkmarxBase in ~/.ai/config.json.")
        return 2
    if TICKET_KEY_RE.match(args.what):
        ticket = _ticket_from_dump(args.what)
        if ticket is None:
            print(f"{args.what} is not in jira-intern/data.json — refresh the board first, or pass the repository slug with --branch.")
            return 2
        plan = scan_plan(ticket)
        if plan is None:
            print(f"{args.what} has no pull request (or known branch) to compare — pass the repository slug with --branch instead.")
            return 2
        targets = extract_targets(ticket)
        label = f"{args.what} — {str(ticket.get('title') or '')[:70]}"
    else:
        if not args.branch:
            print("A repository slug needs --branch (the PR source branch), e.g.  diagnose my-repo --branch bugfix/x --base release/y")
            return 2
        plan = {"repo": args.what, "branch": args.branch, "base": None}
        targets = extract_targets({"title": " ".join(args.target)}) if args.target else []
        label = f"repository {args.what}"
    plan = {**plan, **({"branch": args.branch} if args.branch else {}), **({"base": args.base} if args.base else {})}
    code, text = diagnose(plan, targets, label)
    print(text)
    return code


if __name__ == "__main__":
    sys.exit(main())
