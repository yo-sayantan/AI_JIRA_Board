"""What the outside systems say about a ticket — ONE deterministic structure that the AI brief, the PR readiness report and
the AI enrichment all read, so they can never disagree about the facts.

    build(ticket, tz=None) -> {
        "headline": "Dynatrace: 3 failed spans in payments · Checkmarx: 3 of 4 fixed, 1 open · Jenkins: qa failed at Deploy",
        "insight":  "A timeout in payments caused 3 failed requests between 13:45 and 14:00 IST on 2026-02-26. …",   # 2–4 sentences
        "sections": [{"source": "dynatrace"|"checkmarx"|"jenkins", "title", "severity": "info"|"warning"|"problem",
                      "summary": one plain sentence, "lines": [short facts], "excerpt"?: the last console lines (jenkins)}],
    }

Sources (src/types.ts): `Ticket.dynatrace` (links read by dynatrace.py), `Ticket.vulnFixes` (checkmarx.py — vulnerability-fix
tickets only), `Ticket.builds` (jenkins.py: failing builds, and for a ticket about a build / pipeline failure the green ones
too). A source with nothing to say adds no section; a ticket with none has `sections == []` and empty strings — no evidence,
no section anywhere.

Everything is built from data already stored in data.json: no network, no clock, no randomness (two calls on the same
ticket are identical). The insight is TEMPLATED, so it works with the AI off; the AI may reword it (the report's "Issue
insight", the brief's "Evidence from linked systems" section) but `grounded` refuses a rewording that adds a number or an
identifier the evidence does not contain. `fingerprint` changes when the facts change (not when a timestamp does) — the
brief is regenerated on it. The text of Dynatrace messages and console lines is third-party text, scrubbed when it was
stored (_scrub.py) and treated as untrusted data by every consumer.
"""
import hashlib
import html
import json
import re
from datetime import datetime, timedelta, timezone

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover
    ZoneInfo = None

import _scrub
import checkmarx

PAD_MINUTES = 5  # dynatrace.PAD_MINUTES: stored windows are the link's, padded — shown unpadded
SEVERITIES = ("info", "warning", "problem")
EXCERPT_LINES = 15
EXCERPT_CHARS = 1200
MAX_SENTENCES = 4
SOURCES = ("dynatrace", "checkmarx", "jenkins")
LABEL = {"dynatrace": "Dynatrace", "checkmarx": "Checkmarx", "jenkins": "Jenkins"}
KIND = {"trace": "Trace", "problem": "Problem", "logs": "Logs", "service": "Service", "other": "Link"}
_ERROR_LINE = re.compile(r"\berror\b|\bfail(?:ed|ure|ing)?\b|exception|expected:|assert|\bFAILED\b|✗|\bFATAL\b", re.I)


# ── small helpers ────────────────────────────────────────────────────────────


def _s(v):
    return v if isinstance(v, str) else ""


def _parse(value):
    try:
        return datetime.strptime(str(value), "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def _zone(tz):
    if tz and ZoneInfo is not None:
        try:
            return ZoneInfo(str(tz))
        except Exception:  # noqa: BLE001
            pass
    return timezone.utc


def _plural(n, one, many=None):
    return f"{n} {one if n == 1 else (many or one + 's')}"


def _end(sentence):
    s = str(sentence or "").strip()
    return s if not s or s[-1] in ".!?" else s + "."


def _when(item, tz):
    """"between 08:21 and 08:24 UTC on 2026-02-26" — the LINK's own window (the stored one is padded by 5 minutes),
    in the configured zone; "" without a window."""
    w = item.get("window") if isinstance(item.get("window"), dict) else {}
    a, b = _parse(w.get("from")), _parse(w.get("to"))
    if not (a and b):
        return ""
    if b - a > timedelta(minutes=2 * PAD_MINUTES):
        a, b = a + timedelta(minutes=PAD_MINUTES), b - timedelta(minutes=PAD_MINUTES)
    z = _zone(tz)
    a, b = a.astimezone(z), b.astimezone(z)
    name = a.strftime("%Z") or "UTC"
    if a.date() == b.date():
        return f"between {a:%H:%M} and {b:%H:%M} {name} on {a:%Y-%m-%d}"
    return f"between {a:%Y-%m-%d %H:%M} and {b:%Y-%m-%d %H:%M} {name}"


def _when_short(item, tz):
    w = _when(item, tz)
    m = re.match(r"between (.+?) and (.+?) (\S+)(?: on (\S+))?$", w)
    if not m:
        return ""
    a, b, name, day = m.groups()
    return f"{day} {a}–{b} {name}" if day else f"{a}–{b} {name}"


# ── Dynatrace ────────────────────────────────────────────────────────────────


def _dt_items(ticket):
    ev = ticket.get("dynatrace") if isinstance(ticket.get("dynatrace"), dict) else {}
    return [i for i in ev.get("items") or [] if isinstance(i, dict) and i.get("status") == "read" and (isinstance(i.get("summary"), dict) or i.get("findings"))]


def dynatrace_items(ticket):
    """The Dynatrace items that were read (status `read`) — the only ones that are evidence."""
    return _dt_items(ticket if isinstance(ticket, dict) else {})


def _facts(item):
    """The item's findings; for an older / sparser item, derived from its summary."""
    found = [x.strip() for x in item.get("findings") or [] if isinstance(x, str) and x.strip()]
    if found:
        return found
    s = item.get("summary") if isinstance(item.get("summary"), dict) else {}
    out = []
    r = s.get("requests") if isinstance(s.get("requests"), dict) else None
    if r and isinstance(r.get("total"), int) and r["total"]:
        failed = int(r.get("failed") or 0)
        pct = 100 * failed / r["total"]
        out.append(f"{failed} of {r['total']} root requests failed ({round(pct) if pct >= 1 or pct == 0 else round(pct, 1)}%)")
    for p in [p for p in s.get("problems") or [] if isinstance(p, dict)][:3]:
        bits = ", ".join(x for x in (_s(p.get("status")), _s(p.get("severity"))) if x)
        out.append(f"Problem {_s(p.get('displayId')) or _s(p.get('id')) or '—'}: {_s(p.get('title'))}" + (f" ({bits})" if bits else ""))
    for g in [g for g in s.get("logGroups") or [] if isinstance(g, dict)][:3]:
        out.append(f"{g.get('count')}× {_s(g.get('message'))}")
    return out


def _line_facts(item):
    """The facts one evidence line carries: the first three findings, plus the top error and the Davis problem when the
    findings were cut before them (a line is a skim, but those two are the ones a reader asks for)."""
    facts = _facts(item)
    out = facts[:3]
    joined = " ".join(out)
    s = item.get("summary") if isinstance(item.get("summary"), dict) else {}
    err = next((e for e in s.get("errors") or [] if isinstance(e, dict) and _s(e.get("message"))), None)
    if err and _s(err["message"]) not in joined:
        out.append(f"Error: {_s(err['message'])}" + (f" (×{err.get('count')})" if isinstance(err.get("count"), int) and err["count"] > 1 else ""))
    prob = next((p for p in s.get("problems") or [] if isinstance(p, dict) and _s(p.get("title"))), None)
    if prob and (_s(prob.get("displayId")) or _s(prob.get("title"))) not in joined:
        bits = ", ".join(x for x in (_s(prob.get("title")), _s(prob.get("status"))) if x)
        out.append(f"Davis problem {_s(prob.get('displayId')) or _s(prob.get('id')) or '—'} ({bits})")
    return out


def _article(word):
    return "An" if word[:1].lower() in "aeiou" else "A"


def _cause(summary):
    """What went wrong, named from the error message the trace carries — nothing is guessed."""
    errors = [e for e in summary.get("errors") or [] if isinstance(e, dict) and _s(e.get("message"))]
    msg = _s(errors[0]["message"]) if errors else ""
    low = msg.lower()
    if re.search(r"time[d ]?-?out|timed out", low):
        return "A timeout"
    if re.search(r"connection (?:refused|reset|closed|failed)|connect(?:ion)? (?:error|exception)|no route to host|broken pipe|unreachable", low):
        return "A connection failure"
    if re.search(r"out ?of ?memory|heap space|oom", low):
        return "An out-of-memory error"
    m = re.match(r"^([A-Za-z0-9_$]+(?:Exception|Error))\b", msg)
    if m:
        return f"{_article(m.group(1))} {m.group(1)}"
    codes = sorted((c for c in (summary.get("statusCodes") or {}) if str(c).isdigit() and int(c) >= 500), key=lambda c: (-int((summary.get("statusCodes") or {}).get(c) or 0), c))
    if codes:
        return f"HTTP {codes[0]} errors"
    return "An error"


def _problem_clause(summary):
    p = next((p for p in summary.get("problems") or [] if isinstance(p, dict) and _s(p.get("title"))), None)
    if not p:
        return ""
    label = _s(p.get("displayId")) or _s(p.get("id")) or "—"
    bits = ", ".join(x for x in (_s(p.get("title")), _s(p.get("status"))) if x)
    return f"Dynatrace raised problem {label} ({bits})"


def _dt_sentence(item, tz):
    """(one sentence about one linked item, its severity)."""
    s = item.get("summary") if isinstance(item.get("summary"), dict) else {}
    tenant, kind = _s(item.get("tenant")) or "Dynatrace", _s(item.get("kind"))
    when = _when(item, tz)
    problems = [p for p in s.get("problems") or [] if isinstance(p, dict)]
    active = any(_s(p.get("status")).upper() == "ACTIVE" for p in problems)
    if kind == "trace":
        failed = int(s.get("failedSpans") or 0)
        if failed:
            ff = s.get("firstFailure") if isinstance(s.get("firstFailure"), dict) else {}
            service = _s(ff.get("service")) or (_s((s.get("services") or [""])[0]) if s.get("services") else "") or "the traced request"
            text = f"{_cause(s)} in {service} caused {_plural(failed, 'failed request')}" + (f" {when}" if when else "")
            clause = _problem_clause(s)
            return text + (f"; {clause}" if clause else ""), "problem"
        n = int(s.get("spans") or 0)
        return f"The linked trace on {tenant} shows {_plural(n, 'span')} across {_plural(len(s.get('services') or []), 'service')} and no failed spans" + (f" {when}" if when else ""), "info"
    if kind == "problem" and problems:
        p = problems[0]
        text = f"Dynatrace problem {_s(p.get('displayId')) or _s(p.get('id')) or '—'}: {_s(p.get('title'))}" + (f" ({_s(p.get('status'))})" if _s(p.get("status")) else "")
        if _s(p.get("rootCause")):
            text += f", root cause {_s(p['rootCause'])}"
        return text, "problem" if active else "warning"
    if kind == "service":
        facts = [f for f in _facts(item) if not f.lower().startswith("no davis")]
        text = "; ".join(facts[:2]) or "The linked service shows nothing unusual"
        failed = int((s.get("requests") or {}).get("failed") or 0) if isinstance(s.get("requests"), dict) else 0
        return f"Service on {tenant}: {text}", "problem" if active else ("warning" if (failed or problems) else "info")
    if kind == "logs":
        g = next((g for g in s.get("logGroups") or [] if isinstance(g, dict)), None)
        if g:
            return f"Error logs on {tenant} were dominated by “{_s(g.get('message'))}” ({_plural(int(g.get('count') or 0), 'occurrence')})", "warning"
    facts = _facts(item)
    return (f"{KIND.get(kind, 'Link')} on {tenant}: " + "; ".join(facts[:2])) if facts else "", "info"


def _dt_section(ticket, tz):
    items = _dt_items(ticket)
    if not items:
        return None
    lines, sentences, severities = [], [], []
    for item in items[:5]:
        facts = _facts(item)
        win = _when_short(item, tz)
        stale = f" — not re-read since {_s(item.get('fetchedAt'))[:10]}" if item.get("stale") else ""
        lines.append(f"{KIND.get(_s(item.get('kind')), 'Link')} on {_s(item.get('tenant')) or '?'}" + (f" ({win})" if win else "") + ": " + "; ".join(_line_facts(item)) + stale)
        sentence, sev = _dt_sentence(item, tz)
        if sentence:
            sentences.append(_end(sentence))
        severities.append(sev)
    severity = "problem" if "problem" in severities else ("warning" if "warning" in severities else "info")
    first = next((i for i in items if (i.get("summary") or {}).get("failedSpans")), None)
    short = ""
    if first:
        ff = (first["summary"].get("firstFailure") or {}) if isinstance(first.get("summary"), dict) else {}
        short = f"{_plural(int(first['summary']['failedSpans']), 'failed span')} in {_s(ff.get('service')) or 'the trace'}"
    elif severity == "info":
        short = "linked data shows no failures"
    else:
        short = _s(next((s for s in sentences), "")).rstrip(".")[:70]
    tenants = []
    for i in items:
        if _s(i.get("tenant")) and i["tenant"] not in tenants:
            tenants.append(i["tenant"])
    at = _s((ticket.get("dynatrace") or {}).get("fetchedAt"))[:10] or _s(items[0].get("fetchedAt"))[:10]
    provenance = f"Read from Dynatrace ({', '.join(tenants[:3])})" + (f" on {at}" if at else "")
    return {"source": "dynatrace", "title": "Dynatrace — linked traces and problems", "severity": severity, "summary": " ".join(sentences),
            "lines": lines, "short": short, "sentences": [sentences[0] if sentences else "", _end(provenance)]}


# ── Checkmarx ────────────────────────────────────────────────────────────────

_VULN_OK = ("fixed", "open", "not-found", "unknown")


def _vulns(ticket):
    vf = ticket.get("vulnFixes") if isinstance(ticket.get("vulnFixes"), dict) else None
    if not vf or not checkmarx.is_vuln_fix(ticket):
        return None, []
    items = [i for i in vf.get("items") or [] if isinstance(i, dict) and i.get("target") and i.get("status") in _VULN_OK]
    return (vf, items) if items else (None, [])


def _cx_section(ticket):
    vf, items = _vulns(ticket)
    if not items:
        return None
    n = len(items)
    count = {k: sum(1 for i in items if i["status"] == k) for k in _VULN_OK}
    opened = [i for i in items if i["status"] == "open"]
    order = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3, "INFO": 4}
    opened.sort(key=lambda i: order.get(_s(i.get("severity")).upper(), 5))
    if count["fixed"] == n:
        summary = "The reported vulnerability is fixed" if n == 1 else f"All {n} reported vulnerabilities are fixed"
    else:
        parts = [f"{count['fixed']} of {n} reported {'vulnerability is' if n == 1 else 'vulnerabilities ' + ('is' if count['fixed'] == 1 else 'are')} fixed"]
        if len(opened) == 1:
            sev = _s(opened[0].get("severity")).lower()
            parts.append(f"1 {sev + ' ' if sev else ''}({opened[0]['target']}) is still open")
        elif opened:
            names = ", ".join(f"{i['target']}{' ' + _s(i.get('severity')).lower() if _s(i.get('severity')) else ''}" for i in opened[:3])
            parts.append(f"{len(opened)} are still open ({names})")
        if count["not-found"]:
            parts.append(f"{count['not-found']} not found in either scan")
        if count["unknown"]:
            parts.append(f"{count['unknown']} could not be decided")
        summary = "; ".join(parts)
    lines = []
    branch, base = _s(vf.get("branch")), _s(vf.get("baseBranch"))
    if branch:
        bs, cs = _s(vf.get("branchScanAt"))[:10], _s(vf.get("baseScanAt"))[:10]
        lines.append(f"Compared {branch}" + (f" (scan {bs})" if bs else "") + (f" with {base}" + (f" (scan {cs})" if cs else "") if base else ""))
    for i in opened[:4]:
        where = f" at {_s(i.get('location'))}" if _s(i.get("location")) else ""
        lines.append(f"{i['target']} ({_s(i.get('severity')) or 'severity unknown'}) still open{where}")
    for i in items:
        if i["status"] != "open" and "predates" in _s(i.get("detail")):
            lines.append(f"{i['target']}: {_s(i['detail'])}")
    if _s(vf.get("note")):
        lines.append(_s(vf["note"]))
    severity = "problem" if opened else ("warning" if count["not-found"] or count["unknown"] else "info")
    short = f"{count['fixed']} of {n} fixed" + (f", {len(opened)} open" if opened else "")
    prov = f"Compared {branch}" + (f" with {base}" if base else "") + (f" (scans {_s(vf.get('branchScanAt'))[:10]} and {_s(vf.get('baseScanAt'))[:10]})" if _s(vf.get("branchScanAt")) and _s(vf.get("baseScanAt")) else "")
    return {"source": "checkmarx", "title": "Checkmarx — vulnerability fixes", "severity": severity, "summary": summary,
            "lines": lines, "short": short, "sentences": [_end(summary), _end(prov) if branch else ""]}


# ── Jenkins ──────────────────────────────────────────────────────────────────


def _builds(ticket):
    return [b for b in ticket.get("builds") or [] if isinstance(b, dict) and b.get("result")]


def _is_build_failure(ticket):
    try:
        from jenkins import is_build_failure
    except Exception:  # noqa: BLE001 — a missing Jenkins client must not take the evidence down
        return False
    return is_build_failure(ticket)


def _pipeline(b):
    return f"{_s(b.get('env')) or 'the'} pipeline" + (f" {_s(b['pipeline'])}" if _s(b.get("pipeline")) else "")


def _excerpt(tail):
    rows = [r for r in str(tail or "").splitlines() if r.strip()][-EXCERPT_LINES:]
    out = "\n".join(rows)
    if len(out) > EXCERPT_CHARS:
        out = out[-EXCERPT_CHARS:]
        if "\n" in out:
            out = out.split("\n", 1)[1]
    return out


def key_console_lines(tail, limit=3):
    """The lines of a console tail that say what broke (errors, failures, assertions), last first-found kept in order."""
    rows = [r.strip() for r in str(tail or "").splitlines() if r.strip()]
    hits = [r for r in rows if _ERROR_LINE.search(r) and not re.match(r"^(?:\[Pipeline\]|Finished:)", r)]
    return hits[-limit:] if hits else rows[-limit:]


def _jk_section(ticket):
    builds = _builds(ticket)
    failing = [b for b in builds if b["result"] in ("FAILURE", "UNSTABLE")]
    if not failing and not (builds and _is_build_failure(ticket)):
        return None
    if not failing:
        green = [b for b in builds if b["result"] == "SUCCESS"]
        if not green:
            return None
        names = ", ".join(f"{_s(b.get('env')) or '?'} #{b.get('number')}" for b in green[:3])
        summary = f"The latest builds are green ({names})"
        return {"source": "jenkins", "title": "Jenkins — builds", "severity": "info", "summary": summary,
                "lines": [f"{_s(b.get('env')) or '?'} #{b.get('number')} SUCCESS" + (f" ({_s(b.get('at'))[:10]})" if _s(b.get("at")) else "") for b in green[:4]],
                "short": "latest builds are green", "sentences": [_end(summary), ""]}
    failing.sort(key=lambda b: (_s(b.get("at")), b.get("number") if isinstance(b.get("number"), int) else 0), reverse=True)
    lead = failing[0]
    tests = lead.get("tests") if isinstance(lead.get("tests"), dict) else {}
    failed_tests = int(tests.get("failed") or 0)
    stage = f" at stage {_s(lead.get('failedStage'))}" if _s(lead.get("failedStage")) else ""
    summary = f"The {_pipeline(lead)} {'failed' if lead['result'] == 'FAILURE' else 'is unstable'}{stage}"
    if failed_tests:
        summary += f"; {_plural(failed_tests, 'test is', 'tests are')} failing"
    if len(failing) > 1:
        summary += f", and {_plural(len(failing) - 1, 'more pipeline')} {'is' if len(failing) == 2 else 'are'} failing too"
    lines = []
    stale_any = False
    for b in failing[:3]:
        line = f"{_s(b.get('env')) or '?'}" + (f" · {_s(b['pipeline'])}" if _s(b.get("pipeline")) else "") + f" #{b.get('number')} {b['result']}" + (f" ({_s(b.get('at'))[:10]})" if _s(b.get("at")) else "")
        if _s(b.get("failedStage")):
            line += f" at stage {_s(b['failedStage'])}"
        t = b.get("tests") if isinstance(b.get("tests"), dict) else {}
        if t.get("failed"):
            line += f" · {t.get('failed')} of {t.get('total')} tests failing"
        if b.get("stale"):
            line += f" — not re-read since {_s(b.get('at'))[:10] or 'the last run'}"
            stale_any = True
        lines.append(line)
        names = [x for x in t.get("failing") or [] if isinstance(x, str)]
        if names:
            lines.append("Failing tests: " + ", ".join(names[:5]))
    severity = "warning" if all(b.get("stale") for b in failing) else "problem"
    out = {"source": "jenkins", "title": "Jenkins — failing builds", "severity": severity, "summary": summary, "lines": lines,
           "short": f"{_s(lead.get('env')) or 'the'} {'failed' if lead['result'] == 'FAILURE' else 'unstable'}{(' at ' + _s(lead['failedStage'])) if _s(lead.get('failedStage')) else ''}",
           "sentences": [_end(summary), _end(f"Latest failed build: {_s(lead.get('env')) or '?'} #{lead.get('number')}" + (f" on {_s(lead.get('at'))[:10]}" if _s(lead.get("at")) else ""))]}
    tail = _excerpt(lead.get("consoleTail"))
    if tail and not lead.get("stale"):
        out["excerpt"] = tail
    return out


# ── the whole picture ────────────────────────────────────────────────────────


def build(ticket, tz=None):
    t = ticket if isinstance(ticket, dict) else {}
    sections = []
    for make in (lambda: _dt_section(t, tz), lambda: _cx_section(t), lambda: _jk_section(t)):
        try:
            s = make()
        except Exception:  # noqa: BLE001 — malformed stored data must not break a brief or a report
            s = None
        if s:
            sections.append(s)
    if not sections:
        return {"headline": "", "insight": "", "sections": []}
    headline = " · ".join(f"{LABEL[s['source']]}: {s['short']}" for s in sections if s.get("short"))
    mains = [s["sentences"][0] for s in sections if s["sentences"][0]]
    provs = [s["sentences"][1] for s in sections if s["sentences"][1]]
    sentences = (mains + provs)[:MAX_SENTENCES] if len(mains) >= MAX_SENTENCES else (mains + provs[: MAX_SENTENCES - len(mains)])
    public = [_clean_section({k: v for k, v in s.items() if k not in ("sentences", "short")}) for s in sections]
    return {"headline": headline, "insight": _scrub.line(" ".join(sentences), 1200), "sections": public}


def _clean_section(s):
    """Everything that leaves this module for a model or a report passes the CURRENT scrubber once more — what was stored
    earlier (by an older version, or edited by hand) is not trusted to be clean."""
    s["summary"] = _scrub.line(s.get("summary"), 600)
    s["lines"] = [_scrub.line(x, 600) for x in s.get("lines") or []]
    if s.get("excerpt"):
        s["excerpt"] = _scrub.tail(s["excerpt"], EXCERPT_LINES, EXCERPT_CHARS)
    return s


def has(ticket, tz=None):
    return bool(build(ticket, tz)["sections"])


def fingerprint(ev):
    """16 hex characters over what the evidence SAYS (source, severity, summary, lines, excerpt) — not over when it was read.
    "" for no evidence."""
    sections = (ev or {}).get("sections") or []
    if not sections:
        return ""
    sig = [[s.get("source"), s.get("severity"), s.get("summary"), s.get("lines"), s.get("excerpt")] for s in sections]
    return hashlib.sha1(json.dumps(sig, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()[:16]


# ── is a rewording still the same facts? ─────────────────────────────────────

_NUM = re.compile(r"\d+")
_TOKEN = re.compile(r"\b[A-Za-z][\w.\-]*\d[\w.\-]*")
_WORD = re.compile(r"[A-Za-z]{5,}")
# Mirrors ai-intern/brief.py: longer words a reworded sentence may use without the evidence having said them.
_STOP = frozenset("""about above after again against already also although always among another because before being below between
cause caused causes could during either every first given other others since still their there these those three under until
where which while whose would ticket tickets owner means linked system systems evidence shows shown showing indicates indicate
therefore however overall remains remain status result results""".split())


def _stem(w):
    w = w.lower()
    return w[:-1] if w.endswith("s") and len(w) > 5 else w


def corpus(ev):
    parts = [ev.get("headline"), ev.get("insight")]
    for s in ev.get("sections") or []:
        parts += [s.get("title"), s.get("summary"), s.get("excerpt")] + list(s.get("lines") or [])
    return "\n".join(str(p) for p in parts if p)


def grounded(text, ev, limit=700):
    """True when `text` adds no NUMBER and no IDENTIFIER (anything with a digit in it: CVE-2024-0004, P-23101234, #412,
    13:45) that the evidence does not contain, and almost no WORD (five letters or more) it does not — a reworded insight
    may say it differently, never say more; prose that is not the evidence's (approve it, ignore the failures …) fails."""
    if not isinstance(text, str) or not text.strip() or len(text) > limit or not (ev or {}).get("sections"):
        return False
    have = corpus(ev)
    have_nums = set(_NUM.findall(have))
    have_tokens = {t.rstrip(".-") for t in _TOKEN.findall(have)}
    if not set(_NUM.findall(text)) <= have_nums:
        return False
    if not all(t.rstrip(".-") in have_tokens or t.rstrip(".-") in have for t in _TOKEN.findall(text)):
        return False
    known = {_stem(w) for w in _WORD.findall(have)}
    words = _WORD.findall(text)
    unknown = [w for w in words if _stem(w) not in known and w.lower() not in _STOP]
    return len(unknown) <= max(2, int(0.12 * len(words)))


# ── rows for the report and the worker's proof table ─────────────────────────


def _esc(s):
    return html.escape(str(s if s is not None else ""))


def report_rows(ticket, tz=None):
    """Evidence-chain rows ({cells: [source, observed, conclusion], tone}, HTML-escaped) for what Dynatrace read and for the
    deciding lines of a failed build's console. (Checkmarx and the per-build rows are pr_report's own.)"""
    try:
        return _report_rows(ticket if isinstance(ticket, dict) else {}, tz)
    except Exception:  # noqa: BLE001 — malformed stored data must not break a report
        return []


def _report_rows(t, tz):
    rows = []
    for item in _dt_items(t)[:5]:
        facts = [_scrub.line(x, 400) for x in _facts(item)]  # through the CURRENT scrubber again
        if not facts:
            continue
        win = _when_short(item, tz)
        s = item.get("summary") if isinstance(item.get("summary"), dict) else {}
        req = s.get("requests") if isinstance(s.get("requests"), dict) else {}
        flagged = bool(s.get("failedSpans") or s.get("problems") or req.get("failed"))
        observed = facts[0] + (f" · {win}" if win else "")
        conclusion = " · ".join(facts[1:4]) or ("Read — nothing unusual." if not flagged else "Read.")
        if item.get("stale"):
            conclusion += f" (not re-read since {_s(item.get('fetchedAt'))[:10]})"
        rows.append({"cells": [_esc(f"Dynatrace · {_s(item.get('kind')) or 'link'} ({_s(item.get('tenant')) or '?'})"), _esc(observed), _esc(conclusion)], "tone": "warning" if flagged else "info"})
    sec = _jk_section(t)
    if sec and sec.get("excerpt"):
        lead = next((b for b in _builds(t) if b.get("consoleTail")), None)
        lines = key_console_lines(_scrub.tail(sec["excerpt"], EXCERPT_LINES, EXCERPT_CHARS))
        if lead and lines:
            rows.append({"cells": [_esc(f"Jenkins · {_s(lead.get('env')) or '?'} console"), "<code>" + _esc(" ⏎ ".join(lines)) + "</code>",
                                   f"Last lines of build #{lead.get('number')}'s console (scrubbed)."], "tone": "warning"})
    return rows


def proof_rows(ticket, tz=None):
    """The worker's "Proof" table rows ({check, result, detail, tone}) for the Dynatrace links already read."""
    try:
        return _proof_rows(ticket if isinstance(ticket, dict) else {})
    except Exception:  # noqa: BLE001
        return []


def _proof_rows(ticket):
    rows = []
    for item in _dt_items(ticket)[:5]:
        facts = [_scrub.line(x, 400) for x in _facts(item)]
        if not facts:
            continue
        s = item.get("summary") if isinstance(item.get("summary"), dict) else {}
        failed = int(s.get("failedSpans") or 0)
        result = f"{_plural(failed, 'failed span')}" if failed else ("Problem" if s.get("problems") else "Read")
        rows.append({"check": f"Dynatrace {_s(item.get('kind')) or 'link'} ({_s(item.get('tenant')) or '?'})", "result": result,
                     "detail": "; ".join(facts[:3])[:180], "tone": "warning" if (failed or s.get("problems")) else "info"})
    return rows
