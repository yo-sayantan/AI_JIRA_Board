#!/usr/bin/env python3
"""Dynatrace — what the links in a ticket say. QA and support tickets are full of them: a trace of the failing request,
the Davis problem that was raised, the service, the logs. This module finds them in the ticket's text, reads each one
(read-only), and keeps SHORT FACTS — never a raw dump — in `Ticket.dynatrace` (src/types.ts::DynatraceEvidence), where
the drawer, the AI brief ("Evidence from linked systems") and the PR readiness report ("Issue insight") use them.

Link shapes (parse_link):
  classic    https://<tenant>.live.dynatrace.com/#trace;gtf=<iso> to <iso>;traceId=<hex>;timeframe=custom<ms>to<ms>
             #problems/problemdetails;pid=<id>   #serviceOverview;id=SERVICE-<hex>   #logs;…   anything else → `other`
  platform   https://<tenant>.apps.dynatrace.com/ui/apps/dynatrace.distributedtracing|davis.problems|logs|services/…
  (Dynatrace Managed — https://<host>/e/<uuid>/ — is not supported: the host of a link is only believed when it is a
   Dynatrace SaaS host, and a Managed host is anything.)
Time: the trace's own `timeframe=custom<startMs>to<endMs>` when the link has one (tighter), else `gtf=<iso> to <iso>`;
a relative one (`gtf=-2h`) names no window. Read windows are the link's, padded by 5 minutes, at most 2 hours.

What is read (plan → the exact DQL, `inspect` prints it): trace → `fetch spans | filter trace.id == "<id>"` (+ the Davis
problems of the window, only when the trace has failed spans and names services); problem → `fetch dt.davis.problems`
filtered on the id; service → the window's Davis problems (filtered in Python) and, with a window, the root-request failure
count; logs → the ERROR lines of a trace or service in the window. Every query goes through the platform query API
(`/platform/storage/query/v1/query:execute`, async `requestToken` → `query:poll`) with the window in the REQUEST
(`defaultTimeframeStart/End`), `maxResultRecords`, `maxResultBytes` and `defaultScanLimitGbytes` set — Grail bills by bytes
scanned, so every question is time-bounded and capped.

Safety, enforced here and tested:
  * SSRF — only tenants LISTED in DYNATRACE_TENANTS (or endpoints.dynatraceTenants) are ever contacted, and the URL is
    built from the listed, regex-validated tenant id; a host taken from ticket text only selects which listed tenant a link
    belongs to. A link to another tenant is listed as `unconfigured-tenant` and never fetched; a link to any other host is not a Dynatrace link.
  * injection — an id goes into DQL only after a strict regex (trace id 16–32 hex, `SERVICE-` + 16 hex, a problem id of
    letters / digits / `_.-`); a link whose id fails it is `other`. Times travel as request fields, never as DQL.
  * the token (DYNATRACE_PAT) is only ever in the Authorization header: not in a URL, a log line, the health file or data.json.
  * verified TLS (JIRA_CA_BUNDLE / ~/.ai/ca-bundle.pem added to the system roots; JIRA_INSECURE_TLS never applies,
    DYNATRACE_INSECURE_TLS=1 is its own last resort); redirects only within the same origin; response size capped.
  * everything kept from Dynatrace goes through _scrub (tokens, credentials, e-mail addresses, IPs); ticket text and Dynatrace
    text are untrusted data to every consumer.
Failure semantics follow jenkins.py / checkmarx.py: a network / auth / budget failure means the lookup FAILED — `lookup`
carries the previous items forward marked `stale`; a query the tenant rejects (HTTP 400) is a finding about the query,
not a service failure; "no spans" is an answer (`empty`). Stdlib only.

  python3 jira-intern/dynatrace.py inspect <link | TICKET-KEY> [--no-read]     what it parses, the queries, the findings
"""
import copy
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

import _health
import _safe_http
import _scrub
import _sources
import checkmarx
from _config import _parse_tenants, load_config, load_secrets

INTERN = os.path.dirname(os.path.abspath(__file__))

TIMEOUT = 30
MAX_BYTES = 2 * 1024 * 1024  # of one response
MAX_CALLS_PER_RUN = 200  # query:execute + query:poll requests, across every ticket of a fetch
MAX_RUN_SECONDS = 900  # wall-clock for all of them: a slow tenant must not stretch a fetch
SLOW_STRIKES = 2  # queries that "did not finish in time" before the tenant is treated as down for the run
MAX_ITEMS = 5  # links read per ticket
MAX_POLLS = 6
POLL_PAUSE = 1.0
ITEM_BYTES = 3000
PAD_MINUTES = 5  # around a link's window, for spans / logs / request counts
PROBLEM_PAD_MINUTES = 30  # Davis problems are few and small: read a wider window
MAX_WINDOW = timedelta(hours=2)
PROBLEM_LOOKBACK = timedelta(days=35)  # a problem link with no absolute window
SERVICE_LOOKBACK = timedelta(hours=24)
MAX_SPANS = 500
MAX_LOGS = 200
MAX_PROBLEMS = 200
SCAN_LIMIT_GB = 2
MAX_RESULT_BYTES = 1_000_000
REQUEST_TIMEOUT_MS = 15000
URL_MAX = 600
URL_PARSE_MAX = 4096  # a link longer than this is not parsed at all: a real one is a few hundred characters

KIND_ORDER = ("trace", "problem", "logs", "service", "other")
SCOPE = {"spans": "storage:spans:read", "problems": "storage:events:read", "requests": "storage:spans:read", "logs": "storage:logs:read"}

TENANT_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,62}\Z")
LABEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}\Z")
TRACE_ID_RE = re.compile(r"^[0-9a-fA-F]{16,32}\Z")
SERVICE_ID_RE = re.compile(r"^SERVICE-[0-9A-Fa-f]{16}\Z", re.I | re.A)
PROBLEM_ID_RE = re.compile(r"^(?:P-[0-9]{3,12}|-?[A-Za-z0-9_][A-Za-z0-9_.-]{3,99})\Z")
_CLASSIC_HOST = re.compile(r"^([a-z0-9][a-z0-9-]{1,62})\.live\.dynatrace\.com\Z")
_PLATFORM_HOST = re.compile(r"^([a-z0-9][a-z0-9-]{1,62})\.apps\.dynatrace\.com\Z")
_HINT_RE = re.compile(r"dynatrace", re.I)
_CONTROL_RE = re.compile(r"[\x00-\x20\x7f-\x9f]")
TICKET_KEY_RE = re.compile(r"^[A-Z][A-Z0-9]+-\d+$")

# ── settings ─────────────────────────────────────────────────────────────────


def _setting(name):
    """Environment first, then setup/.env — re-read, so a value saved in the board's API keys dialog is used without a
    restart. Never printed."""
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
    except Exception:  # noqa: BLE001
        return {}


def tenants():
    """{environment label: tenant id} — DYNATRACE_TENANTS (a JSON object, or "prod=abc12345,uat=def67890") wins over
    endpoints.dynatraceTenants. An id must be a plain DNS label (it is put into a host name) and a label plain text;
    anything else is dropped, never "fixed"."""
    raw = _setting("DYNATRACE_TENANTS")
    parsed = _parse_tenants(raw) if raw else {}
    if not parsed:
        cfg = _config_endpoints().get("dynatraceTenants")
        parsed = _parse_tenants(cfg) if isinstance(cfg, dict) else {}
    out = {}
    for label, tid in parsed.items():
        label, tid = str(label).strip(), str(tid).strip().lower()
        if LABEL_RE.match(label) and TENANT_RE.match(tid):
            out[label] = tid
    return out


def token():
    return _setting("DYNATRACE_PAT")


def enabled():
    return bool(token() and tenants())


def missing_settings():
    """The NAMES of the settings that keep Dynatrace from being configured (never a value)."""
    gaps = []
    if not token():
        gaps.append("DYNATRACE_PAT")
    if not tenants():
        gaps.append("DYNATRACE_TENANTS")
    return gaps


# ── time ─────────────────────────────────────────────────────────────────────

_ISO = re.compile(r"^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?\s*(Z|[+-]\d{2}:?\d{2}|\d{2}:\d{2})?$", re.I)
_EPOCH_MIN, _EPOCH_MAX = datetime(2015, 1, 1, tzinfo=timezone.utc), datetime(2100, 1, 1, tzinfo=timezone.utc)


def _utcnow():
    return datetime.now(timezone.utc)


def _iso(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_time(value):
    """An ISO-8601 string (any offset; a `+` that a browser or a mail client turned into a space is repaired), epoch
    milliseconds or epoch seconds → an aware UTC datetime, or None. Sanity-bounded to 2015–2100."""
    s = str(value if value is not None else "").strip()
    try:
        if re.fullmatch(r"\d{13}", s):
            dt = datetime.fromtimestamp(int(s) / 1000, tz=timezone.utc)
        elif re.fullmatch(r"\d{10}", s):
            dt = datetime.fromtimestamp(int(s), tz=timezone.utc)
        else:
            m = _ISO.match(s)
            if not m:
                return None
            date, hm, sec, frac, tz = m.groups()
            tz = (tz or "Z").upper()
            if re.fullmatch(r"\d{2}:\d{2}", tz):
                tz = "+" + tz  # "13:45:00 05:30" — the plus was read as a space
            if tz != "Z" and ":" not in tz:
                tz = tz[:3] + ":" + tz[3:]
            frac = (frac or "0")[:6].ljust(6, "0")
            dt = datetime.fromisoformat(f"{date}T{hm}:{sec or '00'}.{frac}{'+00:00' if tz == 'Z' else tz}")
        dt = dt.astimezone(timezone.utc)
    except (ValueError, OverflowError, OSError):
        return None
    return dt if _EPOCH_MIN <= dt <= _EPOCH_MAX else None


def _window_of(params):
    """(from, to) as UTC datetimes from a link's parameters, or (None, None): the trace's own custom timeframe first
    (it is the tighter of the two), else the global timeframe `gtf=<a> to <b>`."""
    tf = re.fullmatch(r"custom(\d{10,13})to(\d{10,13})", str(params.get("timeframe") or "").strip())
    if tf:
        a, b = parse_time(tf.group(1)), parse_time(tf.group(2))
        if a and b and a <= b:
            return a, b
    gtf = str(params.get("gtf") or "").strip()
    if gtf:
        parts = re.split(r"\s{1,8}to\s{1,8}", gtf[:200], maxsplit=1, flags=re.I)
        a = parse_time(parts[0])
        b = parse_time(parts[1]) if len(parts) == 2 else a
        if a and b:
            return (a, b) if a <= b else (b, a)
    return None, None


# ── parsing a link ───────────────────────────────────────────────────────────


def _valid(value, rx):
    v = str(value or "").strip()
    return v if rx.match(v) else None


def _trace_id(value):
    v = _valid(value, TRACE_ID_RE)
    return v.lower() if v else None


def _service_id(value):
    v = _valid(value, SERVICE_ID_RE)
    return v.upper() if v else None


def _problem_id(value):
    return _valid(value, PROBLEM_ID_RE)


def _fragment(fragment):
    parts = str(fragment or "").split(";")
    params = {}
    for part in parts[1:]:
        k, sep, v = part.partition("=")
        if sep and k.strip():
            params[k.strip()] = urllib.parse.unquote(v)  # unquote, not unquote_plus: a "+" is an offset sign
    return urllib.parse.unquote(parts[0]).strip().lower(), params


def _canonical(link):
    """A short link that still opens the same thing — for a stored URL that was too long to keep whole."""
    host = link["host_name"]
    w = ""
    if link.get("from") and link.get("to"):
        w = f"gtf={link['from']}%20to%20{link['to']}"
    if link["host"] == "platform":
        base = f"https://{host}/ui/apps/"
        if link["kind"] == "trace" and link.get("traceId"):
            return f"{base}dynatrace.distributedtracing/explorer?traceId={link['traceId']}" + (f"&{w}" if w else "")
        if link["kind"] == "problem" and link.get("problemId"):
            return f"{base}dynatrace.davis.problems/problem/{urllib.parse.quote(link['problemId'], safe='')}"
        return f"https://{host}/"
    prefix = f"https://{host}/#"
    ids = {"trace": f"trace;traceId={link.get('traceId')}", "problem": f"problems/problemdetails;pid={link.get('problemId')}",
           "service": f"serviceOverview;id={link.get('serviceId')}", "logs": "logs"}
    if link["kind"] in ids and link["kind"] != "other":
        return prefix + ids[link["kind"]] + (f";{w}" if w else "")
    return f"https://{host}/"


def parse_link(url):
    """One URL → {url, host, host_name, tenant_id, kind, traceId, serviceId, problemId, from, to} (ids validated or None,
    times ISO UTC or None), or None when it is not a https Dynatrace link at all. A link whose kind needs an id that
    fails validation is `other`: it is listed, never queried."""
    try:
        s = str(url or "").strip()
        if len(s) > URL_PARSE_MAX or _CONTROL_RE.search(s):
            return None  # too long to be a real link, or carries control characters (an escape sequence would be printed by `inspect`)
        p = urllib.parse.urlsplit(s)
        host_name = (p.hostname or "").lower()
        if p.scheme.lower() != "https" or not host_name or (p.port not in (None, 443)):
            return None
        fragment = p.fragment
        if m := _CLASSIC_HOST.match(host_name):
            host, tenant_id = "classic", m.group(1)
        elif m := _PLATFORM_HOST.match(host_name):
            host, tenant_id = "platform", m.group(1)
        else:
            return None
    except (ValueError, AttributeError):
        return None
    link = {"host": host, "host_name": host_name, "tenant_id": tenant_id, "kind": "other", "traceId": None, "serviceId": None,
            "problemId": None, "from": None, "to": None}
    if host == "platform":
        q = dict(urllib.parse.parse_qsl(p.query, keep_blank_values=True))
        path = [urllib.parse.unquote(x) for x in p.path.split("/") if x]
        app = path[2].lower() if len(path) >= 3 and path[0] == "ui" and path[1] == "apps" else ""
        rest = path[3:]
        after = lambda word: next((rest[i + 1] for i, seg in enumerate(rest[:-1]) if seg.lower() == word), None)  # noqa: E731
        if "tracing" in app or app.endswith(".traces"):  # not "trace": every app id contains "dynatrace"
            link["traceId"] = _trace_id(q.get("traceId") or q.get("trace_id") or q.get("trace.id") or q.get("trace") or after("trace") or after("traces"))
            link["kind"] = "trace" if link["traceId"] else "other"
        elif app.endswith("problems"):
            link["problemId"] = _problem_id(q.get("problemId") or q.get("pid") or q.get("id") or after("problem") or after("problems"))
            link["kind"] = "problem" if link["problemId"] else "other"
        elif app.endswith("logs"):
            link["traceId"] = _trace_id(q.get("traceId") or q.get("trace_id") or q.get("trace.id"))
            link["serviceId"] = _service_id(q.get("serviceId") or q.get("service_id"))
            link["kind"] = "logs"
        elif app.endswith("services"):
            link["serviceId"] = _service_id(q.get("id") or q.get("serviceId") or q.get("entityId") or after("entity") or after("service"))
            link["kind"] = "service" if link["serviceId"] else "other"
        a, b = _window_of(q)
    else:
        route, q = _fragment(fragment)
        if "trace" in route:
            link["traceId"] = _trace_id(q.get("traceId"))
            link["serviceId"] = _service_id(q.get("serviceId"))
            link["kind"] = "trace" if link["traceId"] else "other"
        elif route.startswith("problems"):
            link["problemId"] = _problem_id(q.get("pid"))
            link["kind"] = "problem" if link["problemId"] else "other"
        elif route.startswith(("serviceoverview", "services", "entity/service")):
            tail = route.split("/", 1)[1] if route.startswith("entity/") else ""
            link["serviceId"] = _service_id(q.get("id") or q.get("serviceId") or tail)
            link["kind"] = "service" if link["serviceId"] else "other"
        elif route.startswith("log"):
            link["traceId"] = _trace_id(q.get("traceId"))
            link["serviceId"] = _service_id(q.get("serviceId") or q.get("id"))
            link["kind"] = "logs"
        a, b = _window_of(q)
    link["from"], link["to"] = (_iso(a), _iso(b)) if a and b else (None, None)
    clean = urllib.parse.urlunsplit(("https", host_name, p.path, p.query, p.fragment))
    link["url"] = clean if len(clean) <= URL_MAX else _canonical(link)
    return link


def _link_key(link):
    ident = link.get("traceId") or link.get("problemId") or link.get("serviceId")
    return (link["tenant_id"], link["kind"], ident or link["url"])


def _item_key(item):
    link = parse_link(item.get("url")) if isinstance(item, dict) else None
    return _link_key(link) if link else ("url", str((item or {}).get("url")))


MAX_TEXT = 40_000  # characters of any one body looked at
MAX_TEXTS = 200


def _texts(ticket):
    """The raw strings a link may be in: title, description, acceptance criteria, comment bodies, external links, sources —
    NOT html-unescaped (`&gtf=` in a pasted link must stay `&gtf=`; only `&amp;` is undone, per URL, below)."""
    t = ticket if isinstance(ticket, dict) else {}
    parts = [t.get("title"), t.get("description")] + list(t.get("acceptanceCriteria") or [])
    parts += [c.get("body") for c in t.get("comments") or [] if isinstance(c, dict)]
    for group in ("externalLinks", "sources"):
        parts += [x.get("url") for x in t.get(group) or [] if isinstance(x, dict)]
    return [str(p)[:MAX_TEXT] for p in parts if isinstance(p, (str, int)) and str(p).strip()][:MAX_TEXTS]


def has_links(ticket):
    """Cheap pre-check (a substring search over the ticket's text) before anything is parsed."""
    return any(_HINT_RE.search(x) for x in _texts(ticket))


def _candidate_urls(raw):
    urls = []
    for m in checkmarx._A_TAG_RE.finditer(raw):
        h = checkmarx._HREF_ATTR_RE.search(m.group(1))
        if h:
            urls.append(h.group(1) or h.group(2) or h.group(3) or "")
    urls += checkmarx.URL_RE.findall(checkmarx._TAG_RE.sub(" ", raw))
    return [u.replace("&amp;", "&") for u in urls if u]


def _interleave(links):
    """Reading order: the first link of every kind (trace, problem, logs, service, other), then the second of every kind, …
    — so five links of one kind (a commenter's, say) cannot push the ticket's one problem link out of the five that are read."""
    by_kind = {k: [x for x in links if x["kind"] == k] for k in KIND_ORDER}
    out = []
    for rank in range(max((len(v) for v in by_kind.values()), default=0)):
        out += [by_kind[k][rank] for k in KIND_ORDER if rank < len(by_kind[k])]
    return out


def extract_links(ticket):
    """Every distinct Dynatrace link in the ticket (title, description, acceptance criteria, comments, external links,
    sources), parsed, in reading order (`_interleave`: one of each kind first). The caller reads the first MAX_ITEMS."""
    found, seen = [], set()
    for raw in _texts(ticket):
        if not _HINT_RE.search(raw):
            continue
        for candidate in _candidate_urls(raw):
            link = parse_link(candidate.rstrip(".,;:!?)]}>'\""))
            if not link:
                continue
            key = _link_key(link)
            if key in seen:
                continue
            seen.add(key)
            found.append(link)
    return _interleave(found)


# ── the queries ──────────────────────────────────────────────────────────────

_PROBLEM_FIELDS = ("display_id, event.id, event.name, event.status, event.category, event.start, event.end, "
                   "root_cause_entity_id, root_cause_entity_name, affected_entity_ids")
_SPAN_FIELDS = ("start_time, span.id, span.parent_id, span.name, duration, request.is_failed, request.is_root_span, "
                "http.request.method, http.route, url.path, http.response.status_code, service.name, dt.entity.service, "
                "span.status_code, span.status_message, exception.message, exception.type, span.events")


def _safe(value, rx, what):
    if not isinstance(value, str) or not rx.match(value):
        raise ValueError(f"{what} failed validation — refusing to put it in a query")
    return value


def _q(name, dql, start, end, max_records, when="always", fallback=None):
    q = {"name": name, "dql": dql, "start": _iso(start), "end": _iso(end), "maxRecords": max_records, "when": when}
    if fallback:
        q["fallback"] = fallback  # asked once, only when the tenant refuses `dql` (a field name it does not know)
    return q


def _padded(link, minutes, cap=MAX_WINDOW):
    a, b = parse_time(link.get("from")), parse_time(link.get("to"))
    if not (a and b):
        return None
    start, end = a - timedelta(minutes=minutes), b + timedelta(minutes=minutes)
    if end - start > cap:
        end = start + cap
    return start, end


def plan(link, now=None):
    """What reading this link asks of Dynatrace: {queries: [{name, dql, start, end, maxRecords, when}], note, window}.
    `note` says why nothing is asked (no time window, nothing to scope a log query, a kind that is not read). `window`
    is the link's own window, padded — what the stored item shows."""
    now = now or _utcnow()
    kind = link["kind"]
    win = _padded(link, PAD_MINUTES)
    out = {"queries": [], "note": None, "window": {"from": _iso(win[0]), "to": _iso(win[1])} if win else None}
    no_window = "The link carries no absolute time window — not queried (it would scan too much data)."
    if kind == "trace":
        if not win:
            out["note"] = no_window
            return out
        tid = _safe(link.get("traceId"), TRACE_ID_RE, "trace id")
        out["queries"].append(_q("spans", f'fetch spans\n| filter trace.id == "{tid}"\n| fields {_SPAN_FIELDS}\n| sort start_time asc\n| limit {MAX_SPANS}',
                                 win[0], win[1], MAX_SPANS, fallback=f'fetch spans\n| filter trace.id == "{tid}"\n| limit {MAX_SPANS}'))
        pw = _padded(link, PROBLEM_PAD_MINUTES, timedelta(days=7))
        out["queries"].append(_q("problems", f"fetch dt.davis.problems\n| fields {_PROBLEM_FIELDS}\n| limit {MAX_PROBLEMS}", pw[0], pw[1], MAX_PROBLEMS, "failed-spans"))
    elif kind == "problem":
        pid = _safe(link.get("problemId"), PROBLEM_ID_RE, "problem id")
        pw = _padded(link, PROBLEM_PAD_MINUTES, timedelta(days=7)) or (now - PROBLEM_LOOKBACK, now)
        out["queries"].append(_q("problems", f'fetch dt.davis.problems\n| filter display_id == "{pid}" or event.id == "{pid}"\n| fields {_PROBLEM_FIELDS}\n| limit 5',
                                 pw[0], pw[1], 5))
    elif kind == "service":
        sid = _safe(link.get("serviceId"), SERVICE_ID_RE, "service id")
        pw = _padded(link, PROBLEM_PAD_MINUTES, timedelta(days=7)) or (now - SERVICE_LOOKBACK, now)
        out["queries"].append(_q("problems", f"fetch dt.davis.problems\n| fields {_PROBLEM_FIELDS}\n| limit {MAX_PROBLEMS}", pw[0], pw[1], MAX_PROBLEMS))
        if win:
            out["queries"].append(_q("requests", f'fetch spans\n| filter dt.entity.service == "{sid}" and request.is_root_span == true\n'
                                                 "| summarize total = count(), failed = countIf(request.is_failed == true)", win[0], win[1], 1))
    elif kind == "logs":
        if not win:
            out["note"] = no_window
            return out
        if link.get("traceId"):
            scope = f'trace_id == "{_safe(link["traceId"], TRACE_ID_RE, "trace id")}"'
        elif link.get("serviceId"):
            scope = f'dt.entity.service == "{_safe(link["serviceId"], SERVICE_ID_RE, "service id")}"'
        else:
            out["note"] = "The logs link names no trace or service id — not queried (a tenant-wide log scan would cost too much)."
            return out
        out["queries"].append(_q("logs", f'fetch logs\n| filter {scope} and (loglevel == "ERROR" or status == "ERROR")\n| fields timestamp, content, loglevel, status\n| limit {MAX_LOGS}',
                                 win[0], win[1], MAX_LOGS))
    else:
        out["note"] = "This kind of Dynatrace link (a dashboard, settings, …) is not read."
    return out


# ── talking to Dynatrace ─────────────────────────────────────────────────────

_LOCK = threading.Lock()
_STATE = {"calls": 0, "down": {}, "forbidden": set(), "cache": {}, "failure": None, "started": None, "slow": {}}
_KEY_LOCKS = {}
_SLOTS = threading.BoundedSemaphore(4)
_OPENER = None


class LookupFailed(Exception):
    """The tenant could not be asked (network, token, call budget): state is 'unreachable' | 'auth-failed' | 'budget-exhausted'."""

    def __init__(self, state, text):
        super().__init__(text)
        self.state, self.text = state, text


class QueryRejected(Exception):
    """Dynatrace answered, but refused THIS query (HTTP 400, a failed DQL run) — says nothing about the tenant."""


def reset_run():
    """Forget the call budget, the tenants marked down and the per-run caches — once per fetch run."""
    with _LOCK:
        _STATE.update(calls=0, down={}, forbidden=set(), cache={}, failure=None, started=None, slow={})
        _KEY_LOCKS.clear()
    _sources.reset("dynatrace")


def unreachable():
    """True when a tenant failed (network, token, server error) this run — for the run notes."""
    with _LOCK:
        return bool(_STATE["down"])


def failure():
    """The first failure of this run as (state, text), or None: a fixed, secret-free phrase, safe to store and show."""
    with _LOCK:
        return _STATE["failure"]


def _fail(state, text):
    with _LOCK:
        if _STATE["failure"] is None:
            _STATE["failure"] = (state, text)


def make_ssl_context():
    """Verified TLS for Dynatrace, independent of JIRA_INSECURE_TLS; DYNATRACE_INSECURE_TLS=1 opts out."""
    return _safe_http.verified_context("DYNATRACE_INSECURE_TLS", "dynatrace")


def _opener():
    global _OPENER
    if _OPENER is None:
        _OPENER = _safe_http.opener(make_ssl_context())
    return _OPENER


def _http(url, headers, data=None, timeout=TIMEOUT):
    """One request → (HTTP status, parsed JSON). The single network seam (tests replace it)."""
    req = urllib.request.Request(url, data=data, headers=headers, method="POST" if data is not None else "GET")
    with _opener().open(req, timeout=timeout) as r:
        raw = r.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            raise ValueError("response too large")
        return getattr(r, "status", 200), (json.loads(raw.decode("utf-8")) if raw else {})


def _base(tenant_id):
    """The query API of a LISTED tenant — the only URL this module ever requests (plus its poll path)."""
    return f"https://{_safe(tenant_id, TENANT_RE, 'tenant id')}.apps.dynatrace.com/platform/storage/query/v1/"


def _request(tenant_id, url, data, table):
    tok = token()
    if not tok:
        raise LookupFailed("auth-failed", "DYNATRACE_PAT is not set")
    with _LOCK:
        if tenant_id in _STATE["down"]:
            raise LookupFailed(*_STATE["down"][tenant_id])
        if (tenant_id, table) in _STATE["forbidden"]:
            raise LookupFailed("auth-failed", f"the token lacks the {SCOPE.get(table, 'read')} scope (HTTP 403)")
        if _STATE["started"] is None:
            _STATE["started"] = time.monotonic()
        if _STATE["calls"] >= MAX_CALLS_PER_RUN:
            if _STATE["failure"] is None:
                _STATE["failure"] = ("budget-exhausted", f"the {MAX_CALLS_PER_RUN}-call budget for one fetch was used up")
            raise LookupFailed("budget-exhausted", f"the {MAX_CALLS_PER_RUN}-call Dynatrace budget for one fetch was used up")
        if time.monotonic() - _STATE["started"] > MAX_RUN_SECONDS:
            if _STATE["failure"] is None:
                _STATE["failure"] = ("budget-exhausted", f"the {MAX_RUN_SECONDS // 60}-minute time budget for Dynatrace in one fetch was used up")
            raise LookupFailed("budget-exhausted", f"the {MAX_RUN_SECONDS // 60}-minute Dynatrace time budget for one fetch was used up")
        _STATE["calls"] += 1
    headers = {"Authorization": f"Bearer {tok}", "Accept": "application/json"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    host = f"{tenant_id}.apps.dynatrace.com"
    try:
        with _SLOTS:
            status, obj = _http(url, headers, data)
        _health.record_ok("dynatrace")
        return status, obj if isinstance(obj, dict) else {}
    except urllib.error.HTTPError as e:
        _health.record_exception("dynatrace", e, host=host)  # a 400 (bad query) is skipped by classify_exception
        if e.code == 401:
            down = ("auth-failed", "Dynatrace rejected the token (HTTP 401)")
            with _LOCK:
                _STATE["down"][tenant_id] = down
            _fail(*down)
            sys.stderr.write("WARN dynatrace: HTTP 401 — check DYNATRACE_PAT; linked-trace results carried forward\n")
            raise LookupFailed(*down) from e
        if e.code == 403:
            with _LOCK:
                _STATE["forbidden"].add((tenant_id, table))
            text = f"the token lacks the {SCOPE.get(table, 'read')} scope (HTTP 403)"
            _fail("auth-failed", f"Dynatrace refused the token: {text}")
            sys.stderr.write(f"WARN dynatrace: HTTP 403 for {table} — {text}\n")
            raise LookupFailed("auth-failed", text) from e
        if 400 <= e.code < 500 and e.code not in (408, 429):
            raise QueryRejected(f"HTTP {e.code}") from e
        down = ("unreachable", f"Dynatrace answered with an error (HTTP {e.code})")
        with _LOCK:
            _STATE["down"][tenant_id] = down
        _fail(*down)
        sys.stderr.write(f"WARN dynatrace: HTTP {e.code} — linked-trace results carried forward\n")
        raise LookupFailed(*down) from e
    except (urllib.error.URLError, OSError) as e:
        _health.record_exception("dynatrace", e, host=host)
        down = ("unreachable", f"{host} could not be reached")
        with _LOCK:
            _STATE["down"][tenant_id] = down
        _fail(*down)
        sys.stderr.write(f"WARN dynatrace unreachable: {getattr(e, 'reason', e)} — linked-trace results carried forward\n")
        raise LookupFailed(*down) from e
    except Exception as e:  # noqa: BLE001 — an unreadable / oversized answer, or a request that could not be built
        _fail("unreachable", "Dynatrace sent an answer the board could not read")
        sys.stderr.write(f"WARN dynatrace: unreadable answer or request ({type(e).__name__})\n")  # the message could quote a header
        raise LookupFailed("unreachable", "Dynatrace sent an answer the board could not read") from e


def _records(obj):
    recs = (obj.get("result") or {}).get("records") if isinstance(obj.get("result"), dict) else None
    return [r for r in recs or [] if isinstance(r, dict)]


def _execute(tenant_id, q):
    """The records of one DQL query, via query:execute and — when the platform answers 202 / RUNNING — query:poll."""
    base = _base(tenant_id)
    table = q["name"]
    body = {"query": q["dql"], "defaultTimeframeStart": q["start"], "defaultTimeframeEnd": q["end"], "timezone": "UTC",
            "maxResultRecords": q["maxRecords"], "maxResultBytes": MAX_RESULT_BYTES, "defaultScanLimitGbytes": SCAN_LIMIT_GB,
            "fetchTimeoutSeconds": 30, "requestTimeoutMilliseconds": REQUEST_TIMEOUT_MS}
    _status, obj = _request(tenant_id, base + "query:execute", json.dumps(body).encode("utf-8"), table)
    request_token = obj.get("requestToken")
    polls = 0
    while True:
        state = str(obj.get("state") or "").upper()
        if state == "SUCCEEDED" or (not state and isinstance(obj.get("result"), dict)):
            return _records(obj)
        if state in ("FAILED", "CANCELLED", "RESULT_GONE"):
            # A query that was accepted and then failed (a timeout, a cluster hiccup) says nothing about the query itself:
            # a failed lookup, so a previous answer is carried forward instead of being replaced by "nothing found".
            _fail("unreachable", "a Dynatrace query failed")
            raise LookupFailed("unreachable", "a Dynatrace query failed on the tenant")
        if not request_token or polls >= MAX_POLLS:
            with _LOCK:  # a tenant whose queries keep not finishing is treated as down: every further one would cost minutes too
                _STATE["slow"][tenant_id] = _STATE["slow"].get(tenant_id, 0) + 1
                if _STATE["slow"][tenant_id] >= SLOW_STRIKES:
                    _STATE["down"][tenant_id] = ("unreachable", "Dynatrace queries are not finishing in time")
            _fail("unreachable", "a Dynatrace query did not finish in time")
            raise LookupFailed("unreachable", "a Dynatrace query did not finish in time")
        polls += 1
        time.sleep(POLL_PAUSE)
        url = base + "query:poll?" + urllib.parse.urlencode({"request-token": request_token, "request-timeout-milliseconds": 10000})
        _status, obj = _request(tenant_id, url, None, table)


def _cached(key, fn):
    """Per-run memo: the same question (tenant, query, window) is asked once, however many tickets name the link."""
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


class _Failure:
    """A cached refusal: the same question that was refused (or failed) once this run is not asked again for the next ticket."""

    def __init__(self, exc):
        self.exc = exc


def _run(tenant_id, q):
    def ask():
        try:
            try:
                return _execute(tenant_id, q)
            except QueryRejected:
                if not q.get("fallback"):
                    raise
                return _execute(tenant_id, {**q, "dql": q["fallback"]})  # the same question without the field list
        except (QueryRejected, LookupFailed) as e:
            return _Failure(e)

    got = _cached((tenant_id, q["name"], q["dql"], q["start"], q["end"]), ask)
    if isinstance(got, _Failure):
        raise got.exc
    return copy.deepcopy(got)


# ── from rows to facts ───────────────────────────────────────────────────────


def _first(rec, *keys):
    for k in keys:
        v = rec.get(k)
        if v not in (None, "", []):
            return v
    return None


def _truthy(v):
    return v is True or str(v).lower() == "true"


def _int(v):
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None


def _ms(duration):
    """Dynatrace durations arrive as nanoseconds (a number, or a numeric string)."""
    n = _int(duration)
    return int(round(n / 1_000_000)) if n is not None and n >= 0 else None


def _label(rec):
    name = _first(rec, "span.name")
    if name:
        return str(name)
    method, route = _first(rec, "http.request.method"), _first(rec, "http.route", "url.path")
    return f"{method} {route}".strip() if route else str(method or "span")


def _is_failed(rec):
    code = _int(rec.get("http.response.status_code"))
    return _truthy(rec.get("request.is_failed")) or str(rec.get("span.status_code") or "").lower() == "error" or (code is not None and code >= 500)


def _short_type(t):
    return str(t).rsplit(".", 1)[-1].rsplit("$", 1)[-1]


def _messages(rec):
    """The error messages a span carries: its own exception / status columns and its span events."""
    out = []
    typ, msg = rec.get("exception.type"), rec.get("exception.message")
    if typ or msg:
        out.append(f"{_short_type(typ)}: {msg}" if typ and msg else str(msg or _short_type(typ)))
    status = rec.get("span.status_message")
    if isinstance(status, str) and status.strip():
        out.append(status)
    events = rec.get("span.events")
    if isinstance(events, list):
        for ev in events:
            if not isinstance(ev, dict):
                continue
            et, em = ev.get("exception.type"), ev.get("exception.message")
            if et or em:
                out.append(f"{_short_type(et)}: {em}" if et and em else str(em or _short_type(et)))
    return out


def _norm_msg(text):
    s = re.sub(r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b", "#", str(text))
    s = re.sub(r"\b0x[0-9a-fA-F]+\b|\b[0-9a-fA-F]{12,}\b", "#", s)
    return re.sub(r"\d+", "#", s).lower()[:120]


def _group_messages(messages, limit, width=140):
    groups = {}
    for m in messages:
        clean = _scrub.line(m, width)
        if not clean:
            continue
        key = _norm_msg(clean)
        if key in groups:
            groups[key][1] += 1
        else:
            groups[key] = [clean, 1]
    ranked = sorted(groups.values(), key=lambda g: -g[1])
    return [{"message": m, "count": n} for m, n in ranked[:limit]]


def _fmt_dur(ms):
    if ms >= 60_000:
        return f"{ms / 60_000:.1f} min"
    return f"{ms / 1000:.1f} s" if ms >= 1000 else f"{ms} ms"


def _day(rec_time):
    dt = parse_time(rec_time)
    return _iso(dt) if dt else None


def _problem_of(rec):
    start, end = _day(rec.get("event.start")), _day(rec.get("event.end"))
    affected = rec.get("affected_entity_ids")
    out = {
        "id": _first(rec, "event.id"),
        "displayId": _first(rec, "display_id"),
        "title": _scrub.line(_first(rec, "event.name", "title") or "Problem", 120),
        "status": _first(rec, "event.status"),
        "severity": _first(rec, "event.category"),
        "start": start,
        "end": end,
        "rootCause": _scrub.line(_first(rec, "root_cause_entity_name", "root_cause_entity_id") or "", 80) or None,
        "affected": [str(x)[:40] for x in affected[:5]] if isinstance(affected, list) else [],
    }
    return {k: v for k, v in out.items() if v not in (None, "", [])}


def _problem_names(rec, entity_ids):
    ids = set(entity_ids)
    affected = rec.get("affected_entity_ids")
    return bool(ids & set(affected if isinstance(affected, list) else [])) or rec.get("root_cause_entity_id") in ids


def _problem_findings(problems, noun="Problem"):
    out = []
    for p in problems[:3]:
        bits = [x for x in (p.get("status"), p.get("severity")) if x]
        if p.get("start") and p.get("end"):
            a, b = parse_time(p["start"]), parse_time(p["end"])
            if a and b and b >= a:
                ms = int((b - a).total_seconds() * 1000)
                mins = max(1, round(ms / 60000))
                bits.append("lasted " + (f"{mins} min" if mins < 60 else f"{mins // 60} h {mins % 60} min"))
        label = p.get("displayId") or "problem"
        out.append(_scrub.line(f"{noun} {label}: {p.get('title')}" + (f" ({', '.join(bits)})" if bits else ""), 200))
        if p.get("rootCause"):
            out.append(_scrub.line(f"Root cause: {p['rootCause']}", 200))
    return out


def summarize_trace(rows, problem_rows=None):
    """(summary, findings) for the spans of one trace (see src/types.ts::DynatraceSummary)."""
    rows = sorted((r for r in rows if isinstance(r, dict)), key=lambda r: str(r.get("start_time") or ""))
    failed = [r for r in rows if _is_failed(r)]
    services, entity_ids = [], set()
    for r in rows:
        name = _first(r, "service.name", "dt.entity.service")
        if name and str(name) not in services:
            services.append(str(name))
        if r.get("dt.entity.service"):
            entity_ids.add(str(r["dt.entity.service"]))
    ids = {str(r.get("span.id")) for r in rows if r.get("span.id")}
    root = next((r for r in rows if _truthy(r.get("request.is_root_span"))), None) or next((r for r in rows if not r.get("span.parent_id") or str(r.get("span.parent_id")) not in ids), None)
    codes = {}
    for r in rows:
        c = _int(r.get("http.response.status_code"))
        if c is not None:
            codes[str(c)] = codes.get(str(c), 0) + 1
    codes = dict(sorted(codes.items(), key=lambda kv: (-kv[1], kv[0]))[:6])
    parents_of_failed = {str(r.get("span.parent_id")) for r in failed if r.get("span.parent_id")}
    origin = next((r for r in failed if str(r.get("span.id")) not in parents_of_failed), failed[0] if failed else None)
    timed = [(_ms(r.get("duration")), r) for r in rows if _ms(r.get("duration")) is not None]
    slowest = max(timed, key=lambda x: x[0]) if timed else None
    errors = _group_messages([m for r in failed or rows for m in _messages(r)], 3)
    summary = {"spans": len(rows), "services": services[:8], "failedSpans": len(failed)}
    if root:
        summary["root"] = _scrub.line(_label(root), 100)
    if codes:
        summary["statusCodes"] = codes
    if errors:
        summary["errors"] = errors
    if slowest:
        r = slowest[1]
        summary["slowest"] = {"name": _scrub.line(f"{_first(r, 'service.name') or ''} {_label(r)}".strip(), 100), "ms": slowest[0]}
    if origin is not None and failed:
        summary["firstFailure"] = {"service": _first(origin, "service.name", "dt.entity.service"), "name": _scrub.line(_label(origin), 100)}
    problems = [_problem_of(r) for r in problem_rows or [] if isinstance(r, dict) and entity_ids and _problem_names(r, entity_ids)]
    seen, unique = set(), []
    for p in problems:
        k = p.get("id") or p.get("displayId") or p.get("title")
        if k not in seen:
            seen.add(k)
            unique.append(p)
    if unique:
        summary["problems"] = unique[:3]

    n = len(rows)
    count = f"{'at least ' if n >= MAX_SPANS else ''}{n} span{'s' if n != 1 else ''}"
    chain = " → ".join(services[:5]) + (" …" if len(services) > 5 else "")
    head = f"{count} across {len(services)} service{'s' if len(services) != 1 else ''} ({chain})" if services else count
    findings = [head + (f"; root: {summary['root']}" if summary.get("root") else "")]
    if failed:
        where = ""
        if summary.get("firstFailure"):
            ff = summary["firstFailure"]
            where = f"; the failure originates in {ff.get('service') or 'an unnamed service'}: {ff.get('name')}"
        findings.append(f"{len(failed)} failed span{'s' if len(failed) != 1 else ''}{where}")
    else:
        findings.append("no failed spans")
    bad = [(c, k) for c, k in codes.items() if int(c) >= 400]
    if bad:
        findings.append("HTTP " + " · ".join(f"{c} ×{k}" for c, k in bad))
    for e in errors[:2]:
        findings.append(f"Error: {e['message']} (×{e['count']})")
    if slowest:
        findings.append(f"Slowest span: {summary['slowest']['name']}, {_fmt_dur(slowest[0])}")
    findings += _problem_findings(unique, "Davis problem")
    return summary, [_scrub.line(f, 200) for f in findings[:8]]


def summarize_problems(rows):
    problems, seen = [], set()
    for r in rows:
        if not isinstance(r, dict):
            continue
        p = _problem_of(r)
        k = p.get("id") or p.get("displayId") or p.get("title")
        if k not in seen:
            seen.add(k)
            problems.append(p)
    problems = problems[:3]
    return {"problems": problems}, _problem_findings(problems)[:8]


def summarize_service(problem_rows, service_id, requests=None):
    mine = [_problem_of(r) for r in problem_rows if isinstance(r, dict) and _problem_names(r, [service_id])]
    seen, problems = set(), []
    for p in mine:
        k = p.get("id") or p.get("displayId") or p.get("title")
        if k not in seen:
            seen.add(k)
            problems.append(p)
    problems = problems[:3]
    summary, findings = {}, []
    if isinstance(requests, dict) and _int(requests.get("total")) is not None:
        total, failed = _int(requests["total"]) or 0, _int(requests.get("failed")) or 0
        summary["requests"] = {"total": total, "failed": failed}
        if total:
            pct = 100 * failed / total
            findings.append(f"{failed} of {total} root requests failed ({round(pct) if pct >= 1 or pct == 0 else round(pct, 1)}%)")
        else:
            findings.append("No root requests in the window")
    if problems:
        summary["problems"] = problems
        findings += _problem_findings(problems)
    elif problem_rows is not None:
        findings.append("No Davis problem names this service in the window")
    return summary, findings[:8]


def summarize_logs(rows):
    groups = _group_messages([str(r.get("content") or "") for r in rows if isinstance(r, dict)], 5)
    findings = [_scrub.line(f"{g['count']}× {g['message']}", 200) for g in groups[:3]]
    return {"logGroups": groups}, findings


# ── reading one link ─────────────────────────────────────────────────────────


def _fit(item):
    """Keep one stored item within ITEM_BYTES: trim findings, then the long lists inside the summary."""
    def size():
        return len(json.dumps(item, ensure_ascii=False))

    while size() > ITEM_BYTES and len(item.get("findings") or []) > 3:
        item["findings"].pop()
    summary = item.get("summary") or {}
    for key in ("errors", "problems", "logGroups", "services"):
        while size() > ITEM_BYTES and len(summary.get(key) or []) > 1:
            summary[key].pop()
    while size() > ITEM_BYTES and item.get("findings"):
        item["findings"].pop()
    return item


def _label_of(tenant_id):
    for label, tid in tenants().items():
        if tid == tenant_id:
            return label
    return None


def _base_item(link, now):
    label = _label_of(link["tenant_id"])
    item = {"url": link["url"], "kind": link["kind"], "host": link["host"],
            "tenant": label or link["tenant_id"],
            "window": None, "status": "empty", "findings": [], "fetchedAt": _iso(now)}
    return item


def _read(link, now):
    """(stored item, failure) for one link — `failure` is (state, text) when the lookup FAILED (the caller may carry the
    previous answer forward), else None. Never raises."""
    item = _base_item(link, now)
    tenant_id = link["tenant_id"]
    if _label_of(tenant_id) is None:
        item.update(status="unconfigured-tenant", note=f"Tenant {tenant_id} is not in DYNATRACE_TENANTS — not read.")
        return item, None
    try:
        p = plan(link, now)
        item["window"] = p["window"]
        if not p["queries"]:
            item["note"] = p["note"]
            return item, None
        kind = link["kind"]
        rows = _run(tenant_id, p["queries"][0])
        summary, findings, status, note = {}, [], "read", None
        if kind == "trace":
            if not rows:
                status, note = "empty", "No spans for this trace in the window — Dynatrace may not keep it any more, or the link belongs to another tenant."
            else:
                problems = None
                if any(_is_failed(r) for r in rows if isinstance(r, dict)) and any(r.get("dt.entity.service") for r in rows if isinstance(r, dict)):
                    try:
                        problems = _run(tenant_id, p["queries"][1])
                    except (LookupFailed, QueryRejected):
                        problems = None  # the trace itself was read; the problem correlation is an extra
                summary, findings = summarize_trace(rows, problems)
        elif kind == "problem":
            if not rows:
                status, note = "empty", "No Davis problem with this id in the window — it may be older, or in another tenant."
            else:
                summary, findings = summarize_problems(rows)
        elif kind == "service":
            requests = None
            if len(p["queries"]) > 1:
                try:
                    got = _run(tenant_id, p["queries"][1])
                    requests = got[0] if got else {"total": 0, "failed": 0}
                except (LookupFailed, QueryRejected):
                    requests = None
            summary, findings = summarize_service(rows, link["serviceId"], requests)
            if not summary:
                status, note = "empty", "No problem and no request count for this service in the window."
        elif kind == "logs":
            if not rows:
                status, note = "empty", "No error logs matched in the window (logs are often not ingested for a tenant)."
            else:
                summary, findings = summarize_logs(rows)
        item.update(status=status, findings=findings)
        if summary:
            item["summary"] = summary
        if note:
            item["note"] = note
        return _fit(item), None
    except LookupFailed as e:
        item.update(status="auth-failed" if e.state == "auth-failed" else "unreachable", note=_scrub.line(e.text, 160))
        return item, (e.state, e.text)
    except QueryRejected as e:
        # The tenant refused THIS query (HTTP 4xx): a finding about the query, not about the service — but when an earlier
        # read of the link exists, `lookup` keeps it (marked stale) instead of replacing it with "nothing found".
        item.update(status="empty", note=f"Dynatrace rejected the query ({_scrub.line(str(e), 60)}) — the link could not be read.")
        return item, ("rejected", str(item["note"]))
    except ValueError as e:  # an id that failed validation: never put in a query
        item.update(status="empty", note=_scrub.line(str(e), 160))
        return item, None


def read_link(link, now=None):
    """The stored item (src/types.ts::DynatraceItem) for one parsed link."""
    return _read(link, now or _utcnow())[0]


# ── a ticket's links, with carry-forward and a per-run cache ─────────────────

TTL = {"problem-active": timedelta(hours=1), "read": timedelta(hours=24), "empty": timedelta(hours=6)}


def _fresh(item, link, now):
    """Is the previous item still good enough not to ask again? A failed or stale item never is; a read one is for 24 hours
    (1 hour while a problem it shows is still ACTIVE); an empty answer for 6 hours (spans can arrive late)."""
    if item.get("stale") or item.get("status") not in ("read", "empty"):
        return False
    if item.get("tenant") != _label_of(link["tenant_id"]):
        return False
    at = parse_time(item.get("fetchedAt"))
    if not at:
        return False
    ttl = TTL["empty"] if item["status"] == "empty" else TTL["read"]
    probs = (item.get("summary") or {}).get("problems") or []
    if item["status"] == "read" and any(str(p.get("status") or "").upper() == "ACTIVE" for p in probs if isinstance(p, dict)):
        ttl = TTL["problem-active"]
    return timedelta(0) <= now - at < ttl


def _flagged(item):
    if item.get("stale") or item.get("status") != "read":
        return False
    s = item.get("summary") or {}
    return bool((s.get("failedSpans") or 0) > 0 or s.get("problems") or (s.get("requests") or {}).get("failed") or s.get("logGroups"))


def lookup(ticket, prior=None, now=None):
    """What the daily fetch needs for one ticket: {evidence, waiting, statuses, flagged, links}.

      evidence  the `Ticket.dynatrace` value to store, or None (no Dynatrace link → no field)
      waiting   (state, reason) when something could not be refreshed and an older answer (or a failed item) was kept,
                or ("not-configured", "") when there are links but no token / tenant; else None
      statuses  the statuses of the items that got an answer this run (for `_sources`)
      flagged   a link shows failed requests, a Davis problem or error logs
      links     how many distinct Dynatrace links the ticket has
    """
    now = now or _utcnow()
    links = extract_links(ticket)
    prior = prior if isinstance(prior, dict) else None
    if not links:
        return {"evidence": None, "waiting": None, "statuses": [], "flagged": False, "links": 0}
    if not enabled():
        return {"evidence": copy.deepcopy(prior) if prior else None, "waiting": ("not-configured", ""), "statuses": [], "flagged": False, "links": len(links)}
    old = {_item_key(i): i for i in (prior or {}).get("items") or [] if isinstance(i, dict)}
    items, statuses, waiting, fresh_read = [], [], None, False
    for link in links[:MAX_ITEMS]:
        before = old.get(_link_key(link))
        if before and _fresh(before, link, now):
            item = {k: v for k, v in copy.deepcopy(before).items() if k != "stale"}
        else:
            item, failure = _read(link, now)
            if failure and before and before.get("status") in ("read", "empty"):
                item = {**copy.deepcopy(before), "stale": True}  # never replace an earlier answer with a failure
            if failure and failure[0] != "rejected":
                waiting = waiting or failure
            if not failure or failure[0] == "rejected" and not (before and before.get("status") in ("read", "empty")):
                fresh_read = True
        if not item.get("stale") and item["status"] not in ("unreachable", "auth-failed"):
            statuses.append(item["status"])
        items.append(item)
    stamp = _iso(now) if fresh_read or not (prior or {}).get("fetchedAt") else prior["fetchedAt"]
    evidence = {"fetchedAt": stamp, "items": items}
    if len(links) > MAX_ITEMS:
        evidence["moreLinks"] = len(links) - MAX_ITEMS
    return {"evidence": evidence, "waiting": waiting, "statuses": statuses, "flagged": any(_flagged(i) for i in items), "links": len(links)}


# ── command line ─────────────────────────────────────────────────────────────
#
#   python3 jira-intern/dynatrace.py inspect <link | TICKET-KEY> [--no-read]
#
# Read-only. Says what the board makes of a link: the tenant it maps to, the ids and window it parsed, the exact queries it
# would send, and — when Dynatrace is configured and the tenant is listed — what they return, as findings. Uses setup/.env
# and the config like the fetch does. Prints no token. Exit 0 read (or --no-read) · 1 Dynatrace could not be read ·
# 2 not configured / not a Dynatrace link / unknown ticket.


def _ticket_from_dump(key):
    try:
        with open(os.path.join(INTERN, "data.json"), encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    for section in ("tickets", "completed", "raised"):
        for t in data.get(section) or []:
            if isinstance(t, dict) and t.get("key") == key:
                return t
            for sub in (t.get("subtasks") or []) if isinstance(t, dict) else []:
                if isinstance(sub, dict) and sub.get("key") == key:
                    return sub
    return None


def _describe(link, now, read):
    """(lines, exit code) for one link."""
    out = []
    say = out.append
    label = _label_of(link["tenant_id"])
    say(f"link: {link['url']}")
    say(f"  tenant: {label or '—'} ({link['tenant_id']})   host: {link['host']}   kind: {link['kind']}")
    ids = [f"{name}: {link[key]}" for name, key in (("trace id", "traceId"), ("service id", "serviceId"), ("problem id", "problemId")) if link.get(key)]
    if ids:
        say("  " + "   ".join(ids))
    p = plan(link, now)
    if p["window"]:
        say(f"  window read: {p['window']['from']} → {p['window']['to']}   (the link's own, padded {PAD_MINUTES} min, at most {int(MAX_WINDOW.total_seconds() // 3600)} h)")
    elif link.get("from"):
        say(f"  window in the link: {link['from']} → {link['to']}")
    else:
        say("  window: the link carries none")
    show_queries = False
    if label is None and tenants():
        say(f"  → tenant {link['tenant_id']} is not in DYNATRACE_TENANTS — never fetched")
    elif not p["queries"]:
        say(f"  → not queried: {p['note']}")
    elif label is None:  # nothing configured at all: show what listing this tenant would allow
        say(f"  → Dynatrace is not configured yet; once DYNATRACE_TENANTS lists {link['tenant_id']}, these are the queries that would be sent")
        show_queries = True
    else:
        show_queries = True
    if show_queries and p["queries"]:
        say(f"  queries (read-only), POSTed to {_base(link['tenant_id'])}query:execute :")
        for i, q in enumerate(p["queries"], 1):
            when = "" if q["when"] == "always" else "  [only when the trace has failed spans and names services]"
            say(f"    {i}. {q['name']}{when}   timeframe {q['start']} → {q['end']}   maxResultRecords {q['maxRecords']}")
            for ln in q["dql"].split("\n"):
                say(f"         {ln}")
            if q.get("fallback"):
                say("         (if the tenant refuses the field list, the same query is asked without it: " + " | ".join(q["fallback"].split("\n")) + ")")
    code = 0
    if read and label is not None and p["queries"]:
        item, failure = _read(link, now)
        say(f"  result: {item['status']}" + (f" — {item['note']}" if item.get("note") else ""))
        for f in item.get("findings") or []:
            say(f"    - {f}")
        if failure:
            code = 1
    return out, code


def main(argv=None):
    import argparse

    ap = argparse.ArgumentParser(prog="dynatrace.py", description="Dynatrace helpers for the board (read-only).")
    sub = ap.add_subparsers(dest="cmd")
    i = sub.add_parser("inspect", help="what the board makes of a Dynatrace link (or of every link in a ticket)")
    i.add_argument("what", help="a Dynatrace link (quote it), or a ticket key on the board (QA-7)")
    i.add_argument("--no-read", action="store_true", help="print what would be asked, ask nothing")
    args = ap.parse_args(argv)
    if args.cmd != "inspect":
        ap.print_usage()
        return 2
    now = _utcnow()
    if TICKET_KEY_RE.match(args.what):
        t = _ticket_from_dump(args.what)
        if t is None:
            print(f"{args.what} is not in jira-intern/data.json — refresh the board first, or pass the link itself.")
            return 2
        links = extract_links(t)
        if not links:
            print(f"{args.what} has no Dynatrace link in its text.")
            return 0
        title = f"{args.what} — {_scrub.line(t.get('title') or '', 70)}"
    else:
        link = parse_link(args.what)
        if link is None:
            print("That is not a Dynatrace link (https://<tenant>.live.dynatrace.com/… or https://<tenant>.apps.dynatrace.com/…).")
            return 2
        links, title = [link], args.what[:90]
    print(f"Dynatrace inspect — {title}")
    gaps = missing_settings()
    read = not args.no_read and not gaps
    code = 0
    reset_run()
    for link in links[:MAX_ITEMS]:
        lines, c = _describe(link, now, read)
        print("\n".join(lines))
        code = max(code, c)
    if len(links) > MAX_ITEMS:
        print(f"({len(links) - MAX_ITEMS} more link(s) not shown — the board reads {MAX_ITEMS} per ticket)")
    if gaps and not args.no_read:
        print(f"\nDynatrace is not configured — missing {', '.join(gaps)}. Add them in the board's API keys dialog (setup/.env), or "
              f"endpoints.dynatraceTenants in ~/.ai/config.json. Nothing was read.")
        return 2
    if code:
        why = failure()
        print(f"\nDynatrace could not be read: {why[1] if why else 'the request failed'}.")
    return code


if __name__ == "__main__":
    sys.exit(main())
