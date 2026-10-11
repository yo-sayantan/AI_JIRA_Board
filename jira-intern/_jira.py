"""Jira / Bitbucket REST access and field formatting shared by the fetch scripts.

daily_fetch.py (active board), completed_archive.py (history) and devinfo.py (branches/PRs)
all read the same Jira fields and render them the same way, so that logic lives here once.
"""
import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from html import escape

import _health
from _config import endpoints, load_config, load_secrets

INTERN = os.path.dirname(os.path.abspath(__file__))
JIRA_BASE, CONFLUENCE_BASE, BITBUCKET_BASE = endpoints(INTERN)
BB_BASE = f"{BITBUCKET_BASE}/rest/api/1.0" if BITBUCKET_BASE else ""

FIELDS = (
    "summary,status,issuetype,priority,updated,created,resolutiondate,assignee,reporter,"
    "labels,components,fixVersions,description,comment,issuelinks,parent,subtasks,"
    "customfield_10402,customfield_57402,customfield_10404,customfield_10405,customfield_10700"
)

# Jira issue key, e.g. PROJ-123 — shared by every entry point that accepts a key from outside.
ISSUE_KEY_RE = re.compile(r"[A-Z][A-Z0-9]+-\d+")

# TLS for every Jira/Bitbucket call. Verification is ON by default; an on-prem instance behind a
# private CA needs JIRA_CA_BUNDLE=<root CA .pem>. JIRA_INSECURE_TLS=1 is the last resort — the
# bearer PAT then travels over an unverified channel, so it is announced on stderr once.
# Built lazily so values from the secrets file (load_env) are honoured, not just the shell's.
_SSL_CTX = None


# Drop the company's root CA(s) here (PEM) and every fetch — on the host and in both containers,
# which mount ~/.ai — trusts it with no further configuration. JIRA_CA_BUNDLE overrides the path.
DEFAULT_CA_BUNDLE = os.path.expanduser("~/.ai/ca-bundle.pem")


def ssl_context():
    global _SSL_CTX
    if _SSL_CTX is not None:
        return _SSL_CTX
    if os.environ.get("JIRA_INSECURE_TLS") == "1":
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        sys.stderr.write("WARN: TLS verification disabled (JIRA_INSECURE_TLS=1)\n")
    else:
        # The system roots always stay: Jira often sits behind a public CDN certificate while
        # Bitbucket uses the company's private CA, so the bundle ADDS trust, never replaces it.
        ctx = ssl.create_default_context()
        explicit = (os.environ.get("JIRA_CA_BUNDLE") or "").strip()
        bundle = explicit or (DEFAULT_CA_BUNDLE if os.path.isfile(DEFAULT_CA_BUNDLE) else "")
        if bundle:
            try:
                ctx.load_verify_locations(cafile=bundle)
            except (OSError, ssl.SSLError) as e:
                if explicit:
                    raise RuntimeError(f"JIRA_CA_BUNDLE is not a readable PEM bundle: {bundle} ({e})") from e
                sys.stderr.write(f"WARN: CA bundle {bundle} not loaded ({e}); system roots only\n")
    _SSL_CTX = ctx
    return ctx


def config_int(path_keys, default):
    try:
        node = load_config(INTERN)
        for k in path_keys:
            node = node[k]
        return int(node)
    except Exception:
        return default


REQUIRED_APPROVALS = config_int(("app", "requiredApprovals"), 2)


def _excluded_projects():
    try:
        raw = load_config(INTERN).get("excludeProjects") or []
    except Exception:
        return set()
    return {str(p).strip().upper() for p in raw if str(p).strip()}


EXCLUDE_PROJECTS = _excluded_projects()


def is_excluded(key):
    """True when a key belongs to a project listed in config → excludeProjects
    (config/jira-board.config.json, or the personal override merged over it)."""
    return bool(key) and key.split("-")[0].upper() in EXCLUDE_PROJECTS


def load_env():
    for key, value in load_secrets(INTERN).items():
        os.environ.setdefault(key, value)


# ── HTTP ─────────────────────────────────────────────────────────────────────


def _is_transient_net(exc):
    """DNS blips, timeouts and 5xx are worth retrying; other 4xx is not."""
    if isinstance(exc, urllib.error.HTTPError):
        return exc.code >= 500 or exc.code == 429
    if isinstance(exc, urllib.error.URLError):
        return True
    return isinstance(exc, (TimeoutError, ConnectionError, OSError))


def _retry_after(err, attempt):
    """Seconds to wait after a 429: the server's Retry-After when it sent one, else backoff."""
    try:
        wait = int(str(err.headers.get("Retry-After") or "").strip() or 0)
    except (AttributeError, ValueError):
        wait = 0
    return min(60, wait or 2 ** attempt)


def get_json(url, headers, timeout, retries=4, service=None):
    """GET with backoff — Docker DNS and corporate VPN flaps are common here.

    Retry policy: 429 waits Retry-After (capped at 60 s) and retries; any other 4xx (expired PAT,
    bad JQL, missing issue) raises at once — retrying cannot fix it and only hides the real
    error behind a timeout; 5xx and network errors back off and retry.

    `service` (jira | bitbucket | confluence) records the outcome in jira-intern/.health/ for the
    API keys dialog: success → ok; the FINAL failure → attention (a 404 / 400 on one lookup is not a
    service failure — _health.record_exception skips it)."""
    last = None
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, context=ssl_context(), timeout=timeout) as r:
                data = json.loads(r.read())
            if service:
                _health.record_ok(service)
            return data
        except urllib.error.HTTPError as e:
            last = e
            if e.code == 429:
                if attempt >= retries:
                    break
                time.sleep(_retry_after(e, attempt))
                continue
            if e.code < 500:
                if service:
                    _health.record_exception(service, e, host=_health.host_of(url))
                raise
            if attempt >= retries:
                break
            time.sleep(min(30, 2 ** attempt))
        except Exception as e:
            last = e
            if attempt >= retries:
                break
            time.sleep(min(30, 2 ** attempt) if _is_transient_net(e) else 1 + attempt)
    if service:
        _health.record_exception(service, last, host=_health.host_of(url))
    raise last


# The shell runners kill a fetch at 300 s, so one hung Jira call must not eat the whole budget.
def jira_get(path, timeout=60, retries=4):
    return get_json(
        JIRA_BASE + path,
        {"Authorization": f"Bearer {os.environ['JIRA_PERSONAL_TOKEN']}", "Accept": "application/json"},
        timeout=timeout,
        retries=retries,
        service="jira",
    )


def jira_post(path, body, timeout=60):
    """POST JSON, no retries: a write that timed out may still have landed, and replaying a
    status transition is not safe. Returns the parsed reply, or {} for an empty 204."""
    req = urllib.request.Request(
        JIRA_BASE + path,
        data=json.dumps(body).encode(),
        method="POST",
        headers={
            "Authorization": f"Bearer {os.environ['JIRA_PERSONAL_TOKEN']}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, context=ssl_context(), timeout=timeout) as r:
            raw = r.read()
    except Exception as e:
        _health.record_exception("jira", e, host=_health.host_of(req.full_url))
        raise
    _health.record_ok("jira")
    return json.loads(raw) if raw else {}


def bb_get(path, timeout=45):
    tok = os.environ.get("BITBUCKET_PAT") or os.environ.get("ATLASSIAN_TOKEN", "")
    return get_json(BB_BASE + path, {"Authorization": f"Bearer {tok}", "Accept": "application/json"}, timeout=timeout, retries=1, service="bitbucket")


def _legacy_status_jql(jql):
    """Older Jira builds reject statusCategory in JQL — rewrite both the = and != forms."""
    return (
        jql.replace("statusCategory != Done", "status not in (Done, Closed, Resolved)")
        .replace("statusCategory = Done", "status in (Done, Closed, Resolved)")
    )


def search_jira(jql, fields=FIELDS, expand=None):
    """Every issue matching `jql`, paginated and de-duplicated by key."""
    issues, seen, start = [], set(), 0
    while True:
        params = {"jql": jql, "startAt": start, "maxResults": 100, "fields": fields}
        if expand:
            params["expand"] = expand
        try:
            data = jira_get("/rest/api/2/search?" + urllib.parse.urlencode(params))
        except urllib.error.HTTPError as e:
            if e.code == 400 and "statusCategory" in jql:
                alt = _legacy_status_jql(jql)
                if alt != jql:
                    return search_jira(alt, fields, expand)
            raise
        batch = data.get("issues") or []
        fresh = 0
        for issue in batch:
            key = issue.get("key")
            if key in seen:
                continue
            seen.add(key)
            issues.append(issue)
            fresh += 1
        # Permission-filtered results can leave total > returned, and a server that ignores
        # startAt returns the same page forever — never spin on either.
        if not batch or not fresh:
            break
        start += len(batch)
        if start >= int(data.get("total") or 0):
            break
    return issues


def search_keys(keys, expand=None):
    """Batched `key in (...)` lookup — one request per 100 keys."""
    keys = [k for k in keys if k]
    out = []
    for i in range(0, len(keys), 100):
        out.extend(search_jira("key in (" + ",".join(keys[i : i + 100]) + ")", expand=expand))
    return out


# ── Field formatting ─────────────────────────────────────────────────────────


def iso(value):
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        ts = value / 1000 if value > 1e12 else value
        return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    # Staleness checks compare these as strings, so every timestamp must share one shape:
    # UTC, second precision, trailing Z — whatever offset or milliseconds Jira sent.
    s = str(value).strip()
    for fmt in ("%Y-%m-%dT%H:%M:%S.%f%z", "%Y-%m-%dT%H:%M:%S%z"):
        try:
            return datetime.strptime(s, fmt).astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        except ValueError:
            continue
    try:
        d = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None  # not a timestamp — never leak the raw string into a field compared as one
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# Keep in step with src/lib/columns.ts (the board's own safety-net mapping).
_STATUS_COLUMNS = (
    (("to do", "todo", "open", "backlog", "reopened", "selected for development", "new"), "todo"),
    (("in progress", "dev in progress", "work in progress", "in development", "development", "implementing"), "prog"),
    (("in review", "code review", "ready4review", "ready for review", "review", "peer review", "pr review"), "rev"),
    (("qa", "in qa", "under qa", "ready for qa", "ready4qa", "awaiting qa",
      "testing", "in test", "in testing", "test", "verification", "verify"), "qa"),
    (("done", "completed", "closed", "resolved", "released", "shipped",
      "won't fix", "wont fix", "won’t fix", "cancelled", "canceled", "rejected"), "done"),
    (("blocked", "impeded", "blocker", "stuck"), "blocked"),
    (("on hold", "hold", "waiting", "parked", "paused", "stalled"), "hold"),
)


def status_column(name):
    """Board column for a raw Jira status: exact aliases, then a whole-word fallback so
    variants like "Moved to QA" land in QA. Unknown statuses count as in-flight work."""
    n = (name or "").lower().strip()
    for aliases, col in _STATUS_COLUMNS:
        if n in aliases:
            return col
    tokens = set(re.findall(r"[a-z0-9]+", n))
    if tokens & {"blocked", "impeded"}:
        return "blocked"
    if tokens & {"qa", "testing", "verification"}:
        return "qa"
    if "review" in tokens:
        return "rev"
    return "prog"


def changelog_done_date(changelog):
    """Jira stamps resolutiondate only when Resolution is set, so a transition straight to
    Done can leave it null. Use the newest changelog transition into a done status instead."""
    dates = [
        h.get("created")
        for h in (changelog or {}).get("histories") or []
        for it in h.get("items") or []
        if it.get("field") == "status" and status_column(it.get("toString")) == "done" and h.get("created")
    ]
    return iso(max(dates)) if dates else None


def build_update_log(key, created, status, resolved, changelog, prior_log=None):
    """Status lifecycle: newest first; text = new status name only; earliest = Opened.
    Uses the changelog that came back with the search (expand=changelog) — no extra call."""
    opened_day = (iso(created) or "")[:10] or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    hist = (changelog or {}).get("histories") or []
    transitions = []
    for h in sorted(hist, key=lambda x: x.get("created", "")):
        day = iso(h.get("created"))[:10] if h.get("created") else opened_day
        for item in h.get("items") or []:
            if item.get("field") == "status":
                to_st = item.get("toString")
                if to_st:
                    transitions.append((day, to_st))
    # dedupe consecutive same status
    deduped = []
    prev = None
    for day, st in transitions:
        if st != prev:
            deduped.append({"when": day, "text": st})
            prev = st
    entries = list(reversed(deduped))
    if not entries or entries[-1]["text"] != "Opened":
        entries.append({"when": opened_day, "text": "Opened"})

    if status_column(status) == "done":
        done_day = (iso(resolved) or "")[:10] or datetime.now(timezone.utc).strftime("%Y-%m-%d")
        if not any(e.get("text", "").startswith("Marked DONE") for e in entries):
            entries.insert(0, {"when": done_day, "text": f"Marked DONE — {done_day}"})

    # merge prior custom entries (Assigned — initial brief, etc.)
    if prior_log:
        prior_texts = {e.get("text") for e in entries}
        has_done = any((e.get("text") or "").startswith("Marked DONE") for e in entries)
        for e in prior_log:
            t = e.get("text") or ""
            # The fresh "Marked DONE — <resolved day>" is authoritative: an older one (a different
            # day, e.g. before the ticket was reopened) must not sit beside it.
            if t.startswith("Marked DONE") and has_done:
                continue
            if t.startswith("Assigned") or t.startswith("Marked DONE") or t.startswith("Refreshed"):
                if t not in prior_texts:
                    entries.insert(0, e)
    return entries


_LIGHT_TAGS = {"p", "b", "ul", "li", "code", "a", "i", "h3"}
_TAG_RE = re.compile(r"<(/?)([\w]+)([^>]*)>")
_HREF_RE = re.compile(r"""\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))""", re.I)
_SAFE_HREF_RE = re.compile(r"^(https?://|/)", re.I)


def _light_tag(m):
    closing, tag, attrs = m.group(1), m.group(2).lower(), m.group(3) or ""
    if tag not in _LIGHT_TAGS:
        return ""
    if tag == "a" and not closing:
        hm = _HREF_RE.search(attrs)
        href = (hm.group(1) or hm.group(2) or hm.group(3) or "").strip() if hm else ""
        # Only web and site-relative links survive — javascript:/data: and friends are dropped.
        if href and _SAFE_HREF_RE.match(href):
            return f'<a href="{escape(href, quote=True)}">'
        return "<a>"
    return f"<{closing}{tag}>"


def light_html(html):
    """Reduce rendered Jira HTML to the handful of tags the board styles. One pass: unknown
    tags vanish (their text stays), allowed tags lose every attribute except a safe href."""
    if not html:
        return None
    if "<" not in html:
        return f"<p>{escape(html)}</p>"
    html = _TAG_RE.sub(_light_tag, html)
    return html.strip() or None


def wiki_to_html(text):
    if not text:
        return None
    if text.strip().startswith("<"):
        return light_html(text)
    out, in_ul = [], False
    for line in text.split("\n"):
        s = line.strip()
        if s.startswith("* ") or s.startswith("- "):
            if not in_ul:
                out.append("<ul>")
                in_ul = True
            out.append(f"<li>{escape(s[2:])}</li>")
        else:
            if in_ul:
                out.append("</ul>")
                in_ul = False
            if s:
                out.append(f"<p>{escape(s)}</p>")
    if in_ul:
        out.append("</ul>")
    return "".join(out) or None


def ac_list(raw):
    if not raw:
        return []
    if isinstance(raw, list):
        return [str(x).strip() for x in raw if str(x).strip()]
    items = []
    for p in re.split(r"\n(?=\*|\d+\.|- )|\n\n", str(raw)):
        p = re.sub(r"^\d+\.\s*", "", re.sub(r"^[\*\-]\s*", "", p.strip()))
        if p:
            items.append(p)
    return items or ([str(raw).strip()] if str(raw).strip() else [])


def person_fmt(user):
    if not user:
        return None
    return f"{user.get('displayName')} ({(user.get('name') or user.get('key') or '').upper()})"


def issue_links(fields):
    """Linked issues. A link to an issue I cannot see comes back with no `fields` at all, so
    summary/status are best-effort — the link itself is still worth showing."""
    related = []
    for link in fields.get("issuelinks") or []:
        for direction, rel_key in (("outwardIssue", "outward"), ("inwardIssue", "inward")):
            o = link.get(direction)
            if not isinstance(o, dict) or not o.get("key"):
                continue
            of = o.get("fields") or {}
            related.append({
                "key": o["key"],
                "url": f"{JIRA_BASE}/browse/{o['key']}",
                "summary": of.get("summary"),
                "status": (of.get("status") or {}).get("name"),
                "relation": (link.get("type") or {}).get(rel_key, "relates"),
            })
    return related


def story_points(fields):
    """Story points as a number (int when integral — src/types.ts says `number | null`).
    Some Jira builds hand the estimate back as a string ("3.0"); garbage becomes None."""
    sp = fields.get("customfield_10402") or fields.get("customfield_57402")
    if sp is None or sp == "":
        return None
    try:
        value = float(sp)
    except (TypeError, ValueError):
        return None
    if value != value or value in (float("inf"), float("-inf")):
        return None
    return int(value) if value == int(value) else value


# ── Comments ─────────────────────────────────────────────────────────────────


def _format_comments(raw):
    ordered = sorted(raw, key=lambda c: c.get("created", ""), reverse=True)
    out = []
    for c in ordered:
        body = c.get("renderedBody") or wiki_to_html(c.get("body", "")) or f"<p>{escape(c.get('body', ''))}</p>"
        out.append({
            "author": (c.get("author") or {}).get("displayName"),
            "when": iso(c.get("created")),
            "body": light_html(body) or body,
        })
    return out, len(ordered), (iso(ordered[0]["created"]) if ordered else None)


def comments_from_issue(fields):
    """Comments straight off the search payload when complete (saves one call per ticket).
    None when Jira truncated the list, so the caller paginates instead."""
    c = fields.get("comment") or {}
    listed = c.get("comments") or []
    if c.get("total", len(listed)) > len(listed):
        return None
    return _format_comments(listed)


def fetch_comments(key):
    comments, start = [], 0
    while True:
        data = jira_get(f"/rest/api/2/issue/{key}/comment?startAt={start}&maxResults=100&expand=renderedBody")
        batch = data.get("comments", [])
        comments.extend(batch)
        if not batch:
            break
        start += len(batch)
        if start >= data.get("total", 0):
            break
    return _format_comments(comments)


def comments_for(key, fields):
    inline = comments_from_issue(fields)
    return inline if inline is not None else fetch_comments(key)
