"""Per-service health: the latest REAL outcome of calls to Jira, Bitbucket, Jenkins, Checkmarx, the
cloud AI APIs, … one small file per service, `jira-intern/.health/<serviceId>.json`.

Every outside client calls `record*` after a real request (success AND failure) so the board's API
keys dialog can show a permanent dot per service without anyone pressing Test. The Node server
(server/health.mjs) writes the same files for the Test button and reads them for
GET /api/keys/health. A record:

    { service, state: 'ok'|'attention', checkedAt, lastOkAt?, failingSince?,
      status?: 'auth-failed'|'forbidden'|'unreachable'|'tls'|'not-found'|'error',
      httpStatus?, detail, source: 'fetch'|'worker'|'test' }

Rules:
  * Never raises, never logs. A health file is a convenience; it must not break a fetch.
  * Never records a secret: `detail` is built from fixed texts plus the HOST, and anything the caller
    passes is scrubbed (URL queries, Authorization values, any TOKEN/KEY/PAT/SECRET env value).
  * A 404 (and other 4xx but 401/403/429) on a per-ticket / per-branch lookup is NOT a service
    failure — "no build for this branch", "no such issue" — so `record_exception` skips it.
  * Throttled: the same state + status is not rewritten within 60 s (one fetch makes thousands of calls).
  * `lastOkAt` survives failures; `failingSince` is set on the first failure after ok and kept until
    the next success.
Stdlib only. Under the unittest runner nothing is written unless JB_HEALTH_DIR names a directory, so
the existing suites never touch a real .health folder.
"""
import json
import os
import re
import socket
import ssl
import sys
import tempfile
import threading
import urllib.error
import urllib.parse
from datetime import datetime, timezone

INTERN = os.path.dirname(os.path.abspath(__file__))
THROTTLE_SECONDS = 60
DETAIL_MAX = 160
SERVICE_RE = re.compile(r"^[a-z][a-z0-9-]{0,31}$")
STATUSES = ("auth-failed", "forbidden", "unreachable", "tls", "not-found", "error")
# Key problems (red in the dialog); every other failure is "needs attention" (orange).
KEY_STATUSES = ("auth-failed", "forbidden")

# Cloud AI hosts → service id (setup/api-keys.json). The on-prem trio is passed explicitly by _jira.py.
CLOUD_HOSTS = {
    "api.anthropic.com": "claude",
    "api.cursor.com": "cursor",
    "generativelanguage.googleapis.com": "gemini",
    "api.openai.com": "openai",
}

_LOCK = threading.Lock()
_LAST = {}  # (dir, service) → (state, status, epoch seconds): skips even the file read inside the window


def _now():
    return datetime.now(timezone.utc)


def _iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse(value):
    try:
        return datetime.strptime(str(value), "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def _reset_cache():
    with _LOCK:
        _LAST.clear()


def health_dir():
    explicit = (os.environ.get("JB_HEALTH_DIR") or "").strip()
    if explicit:
        return explicit
    if "unittest" in sys.modules:  # the test runner: record only where a test asked for it
        return ""
    return os.path.join(INTERN, ".health")


def tone_of(rec):
    """'ok' (green) | 'key' (red: credentials rejected) | 'attention' (orange) | 'none' (never called)."""
    if not isinstance(rec, dict):
        return "none"
    if rec.get("state") == "ok":
        return "ok"
    if rec.get("state") == "attention":
        return "key" if rec.get("status") in KEY_STATUSES else "attention"
    return "none"


# ── reading ──────────────────────────────────────────────────────────────────


def read(service, directory=None):
    directory = directory or health_dir()
    if not directory or not SERVICE_RE.match(str(service or "")):
        return None
    try:
        with open(os.path.join(directory, f"{service}.json"), encoding="utf-8") as f:
            rec = json.load(f)
    except (OSError, ValueError):
        return None
    return rec if isinstance(rec, dict) and rec.get("state") in ("ok", "attention") else None


def read_all(directory=None):
    directory = directory or health_dir()
    out = {}
    try:
        names = os.listdir(directory) if directory else []
    except OSError:
        return out
    for name in names:
        if name.endswith(".json"):
            rec = read(name[:-5], directory)
            if rec:
                out[name[:-5]] = rec
    return out


# ── scrubbing ────────────────────────────────────────────────────────────────

_SECRET_ENV = re.compile(r"TOKEN|KEY|PAT|SECRET|PASSWORD", re.I)


def scrub(text):
    """A one-line, secret-free, URL-query-free string of at most DETAIL_MAX characters."""
    out = re.sub(r"[\x00-\x1f\x7f]+", " ", str(text or ""))
    for name, value in os.environ.items():
        if _SECRET_ENV.search(name) and isinstance(value, str) and len(value) >= 4:
            out = out.replace(value, "•••")
    out = re.sub(r"(?i)\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{6,}", r"\1 •••", out)
    out = re.sub(r"(?i)(authorization|x-api-key|api[_-]?key|token|secret|password)\s*[:=]\s*\S+", r"\1 •••", out)
    out = re.sub(r"(\bhttps?://[^\s?#]+)[?#]\S*", r"\1", out)  # a URL's query / fragment can carry a key
    out = re.sub(r"(?<![A-Za-z0-9])[A-Za-z0-9+/=_-]{32,}(?![A-Za-z0-9])", "•••", out)  # a long opaque blob
    out = re.sub(r"\?\S*", "", out)
    return re.sub(r"\s+", " ", out).strip()[:DETAIL_MAX]


# ── writing ──────────────────────────────────────────────────────────────────


def _write_atomic(directory, service, rec):
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{service}.", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(rec, f, ensure_ascii=False, indent=2)
            f.write("\n")
        os.chmod(tmp, 0o644)
        os.replace(tmp, os.path.join(directory, f"{service}.json"))
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def record(service, ok, status=None, http=None, detail="", source="fetch"):
    """Write the latest outcome for `service`. Returns the record written, or None (throttled,
    disabled, bad id, or any error). Never raises."""
    try:
        directory = health_dir()
        if not directory or not SERVICE_RE.match(str(service or "")):
            return None
        state = "ok" if ok else "attention"
        status = None if ok else (status if status in STATUSES else "error")
        now = _now()
        key = (directory, service)
        with _LOCK:
            last = _LAST.get(key)
            if last and last[0] == state and last[1] == status and now.timestamp() - last[2] < THROTTLE_SECONDS:
                return None
            prior = read(service, directory)
            if prior and prior.get("state") == state and prior.get("status") == status:
                at = _parse(prior.get("checkedAt"))
                if at and 0 <= (now - at).total_seconds() < THROTTLE_SECONDS:
                    _LAST[key] = (state, status, at.timestamp())
                    return None
            stamp = _iso(now)
            rec = {"service": service, "state": state, "checkedAt": stamp}
            if ok:
                rec["lastOkAt"] = stamp
            else:
                if prior and prior.get("lastOkAt"):
                    rec["lastOkAt"] = prior["lastOkAt"]
                rec["failingSince"] = prior["failingSince"] if prior and prior.get("state") == "attention" and prior.get("failingSince") else stamp
                rec["status"] = status
                if isinstance(http, int) and not isinstance(http, bool):
                    rec["httpStatus"] = http
            rec["detail"] = scrub(detail)
            rec["source"] = source if source in ("fetch", "worker", "test") else "fetch"
            _write_atomic(directory, service, rec)
            _LAST[key] = (state, status, now.timestamp())
            return rec
    except Exception:  # noqa: BLE001 — health is best-effort by contract
        return None


def record_ok(service, source="fetch"):
    return record(service, True, source=source)


def classify_exception(exc, host=None):
    """An exception from a real request → (status, http, detail), or None when it says nothing about
    the SERVICE (a 404 on a lookup, a 400 for a bad query, unreadable JSON). The exception's own
    message is never echoed — only fixed texts and the host."""
    where = f" {host}" if host else " the host"
    if isinstance(exc, urllib.error.HTTPError):
        code = exc.code
        if code == 401:
            return "auth-failed", code, "Key rejected (HTTP 401)"
        if code == 403:
            return "forbidden", code, "Access denied (HTTP 403)"
        if code == 429:
            return "error", code, "Rate limited (HTTP 429)"
        if code >= 500:
            return "error", code, f"Server error (HTTP {code})"
        if 300 <= code < 400:
            return "error", code, "Redirected — not followed"
        return None
    reason = getattr(exc, "reason", None) if isinstance(exc, urllib.error.URLError) else None
    if isinstance(exc, ssl.SSLError) or isinstance(reason, ssl.SSLError):
        return "tls", None, f"Certificate of{where} not trusted"
    if isinstance(exc, (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError, OSError)):
        timeout = isinstance(exc, (socket.timeout, TimeoutError)) or isinstance(reason, (socket.timeout, TimeoutError))
        return "unreachable", None, f"Can't reach{where}" + (" — timed out" if timeout else "")
    return None


def record_exception(service, exc, source="fetch", host=None):
    """Record a failed real call — unless it is a per-lookup answer (404 …) that is not a service failure."""
    try:
        got = classify_exception(exc, host)
        if not got:
            return None
        status, http, detail = got
        return record(service, False, status=status, http=http, detail=detail, source=source)
    except Exception:  # noqa: BLE001
        return None


def host_of(url):
    try:
        return urllib.parse.urlsplit(str(url)).hostname or None
    except ValueError:
        return None


def service_for_url(url):
    """The service id a request URL belongs to (cloud AI hosts), else None."""
    return CLOUD_HOSTS.get((host_of(url) or "").lower())
