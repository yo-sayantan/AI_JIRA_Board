#!/usr/bin/env python3
"""dynatrace.py — read the Dynatrace links of a ticket (traces, problems, logs, services), read-only, against tenants the
user LISTED, and turn what comes back into short facts.

Everything here is mocked: `dynatrace._http` is the single network seam and nothing touches the network. Every tenant id,
trace id, service id and host is invented."""
import copy
import io
import json
import os
import sys
import tempfile
import unittest
import urllib.error
import urllib.parse
from datetime import datetime, timedelta, timezone
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "jira-intern"))
import _health  # noqa: E402
import _safe_http  # noqa: E402
import daily_fetch  # noqa: E402
import dynatrace  # noqa: E402

TENANT = "abc12345"
OTHER = "def67890"
STRANGER = "zzz99999"
TRACE = "9f3c1d5e7a2b4c6d8e0f1a2b3c4d5e6f"
SERVICE = "SERVICE-1A2B3C4D5E6F7A8B"
PID = "-4513271304715619301_1772094000000V2"
TOKEN = ".".join(["dt0s16", "ABCDEFGH", "SECRETSECRETSECRETSECRETSECRETSECRETSECRETSECRETSECRETSECRETSECRETSECR"])
NOW = datetime(2026, 2, 27, 9, 0, 0, tzinfo=timezone.utc)

# The user's real link shape, anonymised: classic trace link with a global timeframe AND the trace's own custom timeframe.
TRACE_LINK = (
    f"https://{TENANT}.live.dynatrace.com/#trace;gtf=2026-02-26T13:45:00+05:30%20to%202026-02-26T14:00:00+05:30;gf=all;"
    f"traceId={TRACE};timeframe=custom1772094100000to1772094240000;serviceId={SERVICE};callURI=11111111Z1X1X0X222222222X20260226073805Y0Y0.session"
)
PROBLEM_LINK = f"https://{TENANT}.live.dynatrace.com/#problems/problemdetails;pid={PID};gtf=-2h"
SERVICE_LINK = f"https://{TENANT}.live.dynatrace.com/#serviceOverview;id={SERVICE};gtf=2026-02-26T13:45:00+05:30%20to%202026-02-26T14:00:00+05:30"
LOGS_LINK = f"https://{TENANT}.live.dynatrace.com/#logs;gtf=2026-02-26T13:45:00+05:30%20to%202026-02-26T14:00:00+05:30;serviceId={SERVICE}"
PLATFORM_TRACE = f"https://{TENANT}.apps.dynatrace.com/ui/apps/dynatrace.distributedtracing/explorer?traceId={TRACE}&gtf=2026-02-26T08%3A15%3A00.000Z%20to%202026-02-26T08%3A30%3A00.000Z&gf=all"
PLATFORM_PROBLEM = f"https://{TENANT}.apps.dynatrace.com/ui/apps/dynatrace.davis.problems/problem/{PID}?gtf=-7d"
PLATFORM_LOGS = f"https://{TENANT}.apps.dynatrace.com/ui/apps/dynatrace.logs/?gtf=2026-02-26T08%3A15%3A00.000Z%20to%202026-02-26T08%3A30%3A00.000Z&traceId={TRACE}"


def http_error(code, url="https://x"):
    return urllib.error.HTTPError(url, code, "x", {}, io.BytesIO(b'{"error":{"code":%d,"message":"nope"}}' % code))


def span(sid, svc, name, start, ms, parent=None, failed=False, code=None, method=None, route=None, events=None, entity=None, root=False):
    return {
        "start_time": f"2026-02-26T08:21:{start:02d}.000000000Z", "span.id": sid, "span.parent_id": parent, "span.name": name,
        "duration": int(ms * 1_000_000), "request.is_failed": failed, "request.is_root_span": root,
        "http.request.method": method, "http.route": route, "http.response.status_code": code,
        "service.name": svc, "dt.entity.service": entity, "span.events": events,
    }


TIMEOUT_EVENT = [{"span_event.name": "exception", "exception.type": "java.net.SocketTimeoutException", "exception.message": "Read timed out after 30000 ms"}]
TRACE_ROWS = [
    span("a1", "frontend", "POST /pay", 55, 31200, None, True, 500, "POST", "/pay", entity="SERVICE-00000000000000F1", root=True),
    span("a2", "gateway", "POST /api/pay", 56, 31100, "a1", True, 500, "POST", "/api/pay", entity="SERVICE-00000000000000A2"),
    span("a3", "payments", "POST /charge", 57, 30050, "a2", True, 504, "POST", "/charge", TIMEOUT_EVENT, entity="SERVICE-00000000000000B3"),
    span("a4", "payments", "SELECT ledger", 58, 12, "a3", False, None, entity="SERVICE-00000000000000B3"),
    span("a5", "gateway", "GET /health", 59, 3, "a2", False, 200, "GET", "/health", entity="SERVICE-00000000000000A2"),
]
PROBLEM_ROW = {
    "display_id": "P-23101234", "event.id": PID, "event.name": "Response time degradation", "event.status": "CLOSED", "event.category": "SLOWDOWN",
    "event.start": "2026-02-26T08:20:00.000000000Z", "event.end": "2026-02-26T09:02:00.000000000Z",
    "root_cause_entity_id": "SERVICE-00000000000000B3", "root_cause_entity_name": "payments",
    "affected_entity_ids": ["SERVICE-00000000000000B3", "SERVICE-00000000000000A2"],
}


class FakeDT:
    """A stand-in for dynatrace._http: routes on a substring of the DQL, records every call."""

    def __init__(self, routes=None):
        self.routes = routes or []
        self.calls = []

    def __call__(self, url, headers, data=None, timeout=None):
        body = json.loads(data.decode()) if isinstance(data, (bytes, bytearray)) else None
        self.calls.append({"url": url, "headers": dict(headers), "body": body})
        query = (body or {}).get("query", "")
        for needle, answer in self.routes:
            if needle in query or (needle.startswith("poll:") and needle[5:] in url):
                if isinstance(answer, Exception):
                    raise answer
                if isinstance(answer, int):
                    raise http_error(answer, url)
                if isinstance(answer, tuple):
                    return answer
                return 200, {"state": "SUCCEEDED", "result": {"records": copy.deepcopy(answer)}}
        return 200, {"state": "SUCCEEDED", "result": {"records": []}}

    @property
    def queries(self):
        return [c["body"]["query"] for c in self.calls if c["body"]]


class Base(unittest.TestCase):
    def setUp(self):
        dynatrace.reset_run()
        env = {"DYNATRACE_PAT": TOKEN, "DYNATRACE_TENANTS": f"prod={TENANT},uat={OTHER}"}
        p = mock.patch.dict(os.environ, env)
        p.start()
        self.addCleanup(p.stop)
        err = mock.patch.object(sys, "stderr", io.StringIO())
        self.stderr = err.start()
        self.addCleanup(err.stop)
        cfg = mock.patch.object(dynatrace, "_config_endpoints", lambda: {})
        cfg.start()
        self.addCleanup(cfg.stop)
        sec = mock.patch.object(dynatrace, "load_secrets", lambda _d: {})
        sec.start()
        self.addCleanup(sec.stop)

    def fake(self, routes=None):
        f = FakeDT(routes)
        p = mock.patch.object(dynatrace, "_http", f)
        p.start()
        self.addCleanup(p.stop)
        return f


# ── configuration ────────────────────────────────────────────────────────────


class Config(Base):
    def test_shorthand_json_and_config_all_give_the_same_tenants(self):
        self.assertEqual(dynatrace.tenants(), {"prod": TENANT, "uat": OTHER})
        with mock.patch.dict(os.environ, {"DYNATRACE_TENANTS": json.dumps({"prod": TENANT})}):
            self.assertEqual(dynatrace.tenants(), {"prod": TENANT})
        with mock.patch.dict(os.environ, {"DYNATRACE_TENANTS": ""}), mock.patch.object(dynatrace, "_config_endpoints", lambda: {"dynatraceTenants": {"dev": OTHER, "empty": ""}}):
            self.assertEqual(dynatrace.tenants(), {"dev": OTHER})

    def test_the_setting_wins_over_the_config_and_the_environment_over_the_file(self):
        with mock.patch.object(dynatrace, "_config_endpoints", lambda: {"dynatraceTenants": {"prod": "other999"}}):
            self.assertEqual(dynatrace.tenants()["prod"], TENANT)
        with mock.patch.dict(os.environ, {"DYNATRACE_TENANTS": ""}), mock.patch.object(dynatrace, "load_secrets", lambda _d: {"DYNATRACE_TENANTS": f"qa={OTHER}"}):
            self.assertEqual(dynatrace.tenants(), {"qa": OTHER})

    def test_an_id_that_could_redirect_the_request_is_dropped(self):
        bad = f"prod={TENANT},a=evil.com/x,b=abc12345.evil.com,c=ABC/../x,d=-lead,e=x,f=a b,g={OTHER}"
        with mock.patch.dict(os.environ, {"DYNATRACE_TENANTS": bad}):
            self.assertEqual(dynatrace.tenants(), {"prod": TENANT, "g": OTHER})

    def test_ids_are_lower_cased_and_labels_are_kept_short_and_plain(self):
        with mock.patch.dict(os.environ, {"DYNATRACE_TENANTS": "Prod=ABC12345"}):
            self.assertEqual(dynatrace.tenants(), {"Prod": TENANT})

    def test_enabled_needs_the_token_and_a_tenant_and_says_what_is_missing(self):
        self.assertTrue(dynatrace.enabled())
        self.assertEqual(dynatrace.missing_settings(), [])
        with mock.patch.dict(os.environ, {"DYNATRACE_PAT": ""}):
            self.assertFalse(dynatrace.enabled())
            self.assertEqual(dynatrace.missing_settings(), ["DYNATRACE_PAT"])
        with mock.patch.dict(os.environ, {"DYNATRACE_PAT": "", "DYNATRACE_TENANTS": ""}):
            self.assertEqual(dynatrace.missing_settings(), ["DYNATRACE_PAT", "DYNATRACE_TENANTS"])


# ── link parsing ─────────────────────────────────────────────────────────────


class ParseClassic(Base):
    def test_the_real_trace_link_shape(self):
        p = dynatrace.parse_link(TRACE_LINK)
        self.assertEqual((p["kind"], p["host"], p["tenant_id"]), ("trace", "classic", TENANT))
        self.assertEqual(p["traceId"], TRACE)
        self.assertEqual(p["serviceId"], SERVICE)
        # the trace's own custom timeframe (1772094100000 → 1772094240000 ms) is tighter than the 15 minute gtf, so it wins
        self.assertEqual((p["from"], p["to"]), ("2026-02-26T08:21:40Z", "2026-02-26T08:24:00Z"))
        self.assertEqual(p["url"], TRACE_LINK)

    def test_gtf_alone_with_an_offset_is_read_as_that_offset(self):
        link = f"https://{TENANT}.live.dynatrace.com/#trace;gtf=2026-02-26T13:45:00+05:30%20to%202026-02-26T14:00:00+05:30;traceId={TRACE}"
        p = dynatrace.parse_link(link)
        self.assertEqual((p["from"], p["to"]), ("2026-02-26T08:15:00Z", "2026-02-26T08:30:00Z"))

    def test_a_plus_that_turned_into_a_space_is_still_the_offset(self):
        link = f"https://{TENANT}.live.dynatrace.com/#trace;gtf=2026-02-26T13:45:00 05:30 to 2026-02-26T14:00:00 05:30;traceId={TRACE}"
        p = dynatrace.parse_link(link.replace(" ", "%20"))
        self.assertEqual(p["from"], "2026-02-26T08:15:00Z")

    def test_a_relative_timeframe_gives_no_window(self):
        p = dynatrace.parse_link(PROBLEM_LINK)
        self.assertEqual(p["kind"], "problem")
        self.assertEqual(p["problemId"], PID)
        self.assertIsNone(p["from"])
        self.assertIsNone(p["to"])

    def test_service_and_logs_links(self):
        s = dynatrace.parse_link(SERVICE_LINK)
        self.assertEqual((s["kind"], s["serviceId"], s["from"]), ("service", SERVICE, "2026-02-26T08:15:00Z"))
        lg = dynatrace.parse_link(LOGS_LINK)
        self.assertEqual((lg["kind"], lg["serviceId"]), ("logs", SERVICE))

    def test_a_display_problem_id(self):
        p = dynatrace.parse_link(f"https://{TENANT}.live.dynatrace.com/#problems/problemdetails;pid=P-23101234")
        self.assertEqual(p["problemId"], "P-23101234")

    def test_an_unrecognised_route_is_other(self):
        p = dynatrace.parse_link(f"https://{TENANT}.live.dynatrace.com/#dashboard;id=abc-123")
        self.assertEqual(p["kind"], "other")
        self.assertEqual(p["tenant_id"], TENANT)

    def test_a_bare_host_is_other(self):
        self.assertEqual(dynatrace.parse_link(f"https://{TENANT}.live.dynatrace.com/")["kind"], "other")

    def test_the_trace_id_is_lower_cased_and_the_service_id_upper_cased(self):
        link = f"https://{TENANT}.live.dynatrace.com/#trace;traceId={TRACE.upper()};serviceId={SERVICE.lower()}"
        p = dynatrace.parse_link(link)
        self.assertEqual((p["traceId"], p["serviceId"]), (TRACE, SERVICE))


class ParsePlatform(Base):
    def test_distributed_tracing_app(self):
        p = dynatrace.parse_link(PLATFORM_TRACE)
        self.assertEqual((p["kind"], p["host"], p["tenant_id"], p["traceId"]), ("trace", "platform", TENANT, TRACE))
        self.assertEqual((p["from"], p["to"]), ("2026-02-26T08:15:00Z", "2026-02-26T08:30:00Z"))

    def test_trace_id_in_the_path(self):
        p = dynatrace.parse_link(f"https://{TENANT}.apps.dynatrace.com/ui/apps/dynatrace.distributedtracing/trace/{TRACE}?gtf=-2h")
        self.assertEqual((p["kind"], p["traceId"]), ("trace", TRACE))

    def test_problems_app(self):
        p = dynatrace.parse_link(PLATFORM_PROBLEM)
        self.assertEqual((p["kind"], p["problemId"]), ("problem", PID))

    def test_logs_app_with_a_trace_id(self):
        p = dynatrace.parse_link(PLATFORM_LOGS)
        self.assertEqual((p["kind"], p["traceId"]), ("logs", TRACE))

    def test_other_app_is_other(self):
        self.assertEqual(dynatrace.parse_link(f"https://{TENANT}.apps.dynatrace.com/ui/apps/dynatrace.dashboards/dashboard/1234")["kind"], "other")


class ParseRefusals(Base):
    def test_not_dynatrace_not_https_or_not_a_url(self):
        for link in ("https://example.com/#trace;traceId=" + TRACE, f"http://{TENANT}.live.dynatrace.com/#trace;traceId={TRACE}",
                     "ftp://abc12345.live.dynatrace.com/x", "not a url", "", None, f"https://{TENANT}.live.dynatrace.com.evil.com/#trace;traceId={TRACE}",
                     f"https://evil.com/{TENANT}.live.dynatrace.com/#trace", f"https://live.dynatrace.com/#trace;traceId={TRACE}"):
            with self.subTest(link=link):
                self.assertIsNone(dynatrace.parse_link(link))

    def test_credentials_in_the_url_are_dropped(self):
        p = dynatrace.parse_link(f"https://jane:hunter2@{TENANT}.live.dynatrace.com/#trace;traceId={TRACE}")
        self.assertNotIn("hunter2", p["url"])
        self.assertNotIn("jane", p["url"])
        self.assertTrue(p["url"].startswith(f"https://{TENANT}.live.dynatrace.com/"))

    def test_an_id_that_could_break_out_of_a_query_is_never_kept(self):
        hostile = ['x" | fetch logs | limit 9', f'{TRACE}" or true', "a b c d e f 0123456789", TRACE[:10] + "'--", "0123456789abcdef0123456789abcdef0", "zzzzzzzzzzzzzzzz", "$(id)", "{x}"]
        for bad in hostile:
            with self.subTest(trace=bad):
                p = dynatrace.parse_link(f"https://{TENANT}.live.dynatrace.com/#trace;traceId={urllib.parse.quote(bad)};gtf=2026-02-26T13:45:00Z%20to%202026-02-26T14:00:00Z")
                self.assertIsNone(p["traceId"])
                self.assertEqual(p["kind"], "other")  # a trace link without a valid id is not read at all
        for bad in ("SERVICE-XYZ", f"{SERVICE}\" or 1", "SERVICE-1A2B", "service-1a2b3c4d5e6f7a8b0"):
            with self.subTest(service=bad):
                p = dynatrace.parse_link(f"https://{TENANT}.live.dynatrace.com/#serviceOverview;id={urllib.parse.quote(bad)}")
                self.assertIsNone(p["serviceId"])
                self.assertEqual(p["kind"], "other")
        for bad in ('1" | fetch logs', "a b", 'x"y', "p;q", "x\\y", "$x", "ab"):
            with self.subTest(problem=bad):
                p = dynatrace.parse_link(f"https://{TENANT}.live.dynatrace.com/#problems/problemdetails;pid={urllib.parse.quote(bad)}")
                self.assertIsNone(p["problemId"])
                self.assertEqual(p["kind"], "other")

    def test_lookalike_unicode_never_passes_the_validators(self):
        for bad in ("ſERVICE-1A2B3C4D5E6F7A8B", "SERVICE-١A2B3C4D5E6F7A8B", "SERVICE-1A2B3C4D5E6F7A8B\n"):
            with self.subTest(service=bad):
                self.assertIsNone(dynatrace._service_id(bad) if "\n" not in bad else dynatrace.SERVICE_ID_RE.match(bad))
        for bad in ("P-١٢٣٤٥٦", "٩f3c1d5e7a2b4c6d8e0f1a2b3c4d5e6"):
            with self.subTest(other=bad):
                self.assertIsNone(dynatrace._problem_id(bad) if bad.startswith("P-") else dynatrace._trace_id(bad))
        self.assertIsNone(dynatrace.TRACE_ID_RE.match(TRACE + "\n"))
        self.assertIsNone(dynatrace.TENANT_RE.match(TENANT + "\n"))

    def test_hostile_links_are_refused_fast(self):
        import time

        t0 = time.time()
        for link in (f"https://{TENANT}.live.dynatrace.com/#trace;gtf=" + "%20" * 400000 + f";traceId={TRACE}",
                     f"https://{TENANT}.live.dynatrace.com/#trace;traceId={TRACE};gtf=" + "x" * 200000,
                     f"https://{TENANT}.live.dynatrace.com/#trace;traceId={TRACE};gtf=2026-02-26T13:45:00Z" + "%20" * 5000 + "to%20" + "%20" * 5000 + "2026-02-26T14:00:00Z"):
            dynatrace.parse_link(link)
        t = ticket(description=" ".join(["https://abc12345.live.dynatrace.com/#trace;traceId=" + TRACE + ";gtf=" + "%20" * 3000] * 400))
        dynatrace.extract_links(t)
        self.assertLess(time.time() - t0, 3.0)

    def test_a_very_long_url_is_shortened_to_a_link_that_still_works(self):
        link = TRACE_LINK + ";" + "x=" + "y" * 900
        p = dynatrace.parse_link(link)
        self.assertLessEqual(len(p["url"]), 600)
        again = dynatrace.parse_link(p["url"])
        self.assertEqual(again["traceId"], TRACE)

    def test_dynatrace_managed_and_lookalike_hosts_are_not_dynatrace_links_at_all(self):
        env = "12345678-1234-1234-1234-123456789abc"
        for link in (f"https://dt.example.com/e/{env}/#trace;traceId={TRACE}", f"https://login.evil.example/e/{env}/#trace;traceId={TRACE}",
                     f"https://dynatrace.evil.example/#trace;traceId={TRACE}", f"https://{TENANT}.live.dynatrace.evil.example/#trace;traceId={TRACE}"):
            with self.subTest(link=link):
                self.assertIsNone(dynatrace.parse_link(link))

    def test_a_link_with_control_characters_is_refused(self):
        for bad in ("\x1b]0;pwned\x07", "\x1b[2J", "\x00", "\x7f", "\x85"):
            with self.subTest(bad=repr(bad)):
                self.assertIsNone(dynatrace.parse_link(f"https://{TENANT}.live.dynatrace.com/#trace;traceId={TRACE};x=a{bad}b"))


# ── finding the links in a ticket ────────────────────────────────────────────


def ticket(**kw):
    t = {"key": "QA-1", "title": "Payment timeout", "type": "Bug", "description": "", "comments": [], "externalLinks": [], "sources": []}
    t.update(kw)
    return t


class ExtractLinks(Base):
    def test_description_comments_external_links_and_sources(self):
        t = ticket(
            description=f'<p>See <a href="{TRACE_LINK.replace("&", "&amp;")}">the trace</a>.</p>',
            comments=[{"author": "a", "body": f"<p>Problem: {PROBLEM_LINK}</p>"}],
            externalLinks=[{"title": "logs", "url": LOGS_LINK, "reachable": True}],
            sources=[{"title": "Jira QA-1", "url": "https://jira.example.com/browse/QA-1"}, {"title": "svc", "url": SERVICE_LINK}],
        )
        kinds = [(x["kind"], x["tenant_id"]) for x in dynatrace.extract_links(t)]
        self.assertEqual(sorted(kinds), sorted([("trace", TENANT), ("problem", TENANT), ("logs", TENANT), ("service", TENANT)]))

    def test_a_link_is_found_once_and_in_priority_order(self):
        t = ticket(description=f"{SERVICE_LINK} {TRACE_LINK} {PROBLEM_LINK} {TRACE_LINK} {PLATFORM_TRACE}", externalLinks=[{"url": TRACE_LINK}])
        links = dynatrace.extract_links(t)
        self.assertEqual([x["kind"] for x in links], ["trace", "problem", "service"])  # the platform trace is the same trace

    def test_trailing_punctuation_is_not_part_of_the_link(self):
        t = ticket(description=f"Look ({PROBLEM_LINK}). Also {SERVICE_LINK}, and that.")
        self.assertEqual({x["kind"] for x in dynatrace.extract_links(t)}, {"problem", "service"})
        self.assertFalse(any(x["url"].endswith((")", ".", ",")) for x in dynatrace.extract_links(t)))

    def test_a_link_pasted_with_a_raw_ampersand_keeps_its_parameters(self):
        raw = f"https://{TENANT}.apps.dynatrace.com/ui/apps/dynatrace.distributedtracing/explorer?traceId={TRACE}&gtf=2026-02-26T08%3A15%3A00.000Z%20to%202026-02-26T08%3A30%3A00.000Z&gf=all"
        for text, why in ((f"See {raw} please", "raw text"), (f"<p>See {raw.replace('&', '&amp;')}</p>", "html-escaped text"),
                          (f'<p><a href="{raw.replace("&", "&amp;")}">trace</a></p>', "a quoted href"), (f"<a href='{raw}'>t</a>", "a single-quoted href"),
                          (f"<a href={raw}>t</a>", "an unquoted href")):
            with self.subTest(why=why):
                (link,) = dynatrace.extract_links(ticket(description=text))
                self.assertEqual((link["traceId"], link["from"], link["to"]), (TRACE, "2026-02-26T08:15:00Z", "2026-02-26T08:30:00Z"))

    def test_five_links_of_one_kind_do_not_push_the_others_out(self):
        traces = " ".join(TRACE_LINK.replace(TRACE, f"{i:032x}") for i in range(1, 8))
        t = ticket(description=f"{traces} {PROBLEM_LINK} {SERVICE_LINK}")
        kinds = [x["kind"] for x in dynatrace.extract_links(t)][:5]
        self.assertEqual(kinds, ["trace", "problem", "service", "trace", "trace"])

    def test_a_hostile_comment_cannot_stall_the_fetch(self):
        """Anyone who can comment can post 32,000 characters of unterminated tags: every text path of the fetch must shrug it off
        (the old Checkmarx tag patterns took 45 s on exactly this)."""
        import time

        import checkmarx
        import jenkins

        bodies = ["<a href='" * 3555, "<" + "<a href='" * 3555, "<a " * 10000, "<a href=\"" * 3555, "<" * 32000, "&" * 32000, "<a href=x" + ">" * 20000]
        t = ticket(description=bodies[0], comments=[{"body": b} for b in bodies])
        t0 = time.time()
        self.assertEqual(dynatrace.extract_links(t), [])
        dynatrace.has_links(t)
        checkmarx.ticket_text(t)
        checkmarx.classify_text(t)
        checkmarx.is_vuln_fix(t)
        jenkins.is_build_failure(t)
        self.assertLess(time.time() - t0, 3.0)

    def test_a_ticket_without_any_gives_nothing(self):
        self.assertEqual(dynatrace.extract_links(ticket(description="<p>nothing here https://example.com/x</p>")), [])
        self.assertEqual(dynatrace.extract_links({}), [])
        self.assertFalse(dynatrace.has_links(ticket()))
        self.assertTrue(dynatrace.has_links(ticket(description=TRACE_LINK)))

    def test_other_links_come_last(self):
        t = ticket(description=f"https://{TENANT}.live.dynatrace.com/#dashboard;id=x {TRACE_LINK}")
        self.assertEqual([x["kind"] for x in dynatrace.extract_links(t)], ["trace", "other"])


# ── the queries ──────────────────────────────────────────────────────────────


class Plan(Base):
    def test_trace_plan_asks_for_the_trace_in_its_window_and_nothing_else(self):
        p = dynatrace.plan(dynatrace.parse_link(TRACE_LINK), NOW)
        self.assertIsNone(p["note"])
        spans = p["queries"][0]
        self.assertEqual(spans["name"], "spans")
        self.assertIn("fetch spans", spans["dql"])
        self.assertIn(f'filter trace.id == "{TRACE}"', spans["dql"])
        self.assertIn("limit 500", spans["dql"])
        # ±5 minutes around the link's custom timeframe
        self.assertEqual((spans["start"], spans["end"]), ("2026-02-26T08:16:40Z", "2026-02-26T08:29:00Z"))
        self.assertEqual(spans["when"], "always")
        problems = p["queries"][1]
        self.assertEqual(problems["name"], "problems")
        self.assertEqual(problems["when"], "failed-spans")

    def test_the_window_is_capped_at_two_hours_from_its_start(self):
        link = f"https://{TENANT}.live.dynatrace.com/#trace;traceId={TRACE};gtf=2026-02-26T00:00:00Z%20to%202026-02-26T12:00:00Z"
        q = dynatrace.plan(dynatrace.parse_link(link), NOW)["queries"][0]
        self.assertEqual(q["start"], "2026-02-25T23:55:00Z")
        self.assertEqual(q["end"], "2026-02-26T01:55:00Z")

    def test_a_trace_link_without_an_absolute_window_is_not_queried(self):
        p = dynatrace.plan(dynatrace.parse_link(f"https://{TENANT}.live.dynatrace.com/#trace;traceId={TRACE};gtf=-2h"), NOW)
        self.assertEqual(p["queries"], [])
        self.assertIn("no absolute time window", p["note"])

    def test_problem_plan_filters_on_the_id_only_and_defaults_to_35_days(self):
        p = dynatrace.plan(dynatrace.parse_link(PROBLEM_LINK), NOW)
        q = p["queries"][0]
        self.assertIn(f'filter display_id == "{PID}" or event.id == "{PID}"', q["dql"])
        self.assertIn("fetch dt.davis.problems", q["dql"])
        self.assertEqual(q["end"], "2026-02-27T09:00:00Z")
        self.assertEqual(q["start"], "2026-01-23T09:00:00Z")

    def test_service_plan_reads_problems_client_side_and_counts_root_requests_only_with_a_window(self):
        p = dynatrace.plan(dynatrace.parse_link(SERVICE_LINK), NOW)
        names = [q["name"] for q in p["queries"]]
        self.assertEqual(names, ["problems", "requests"])
        self.assertNotIn(SERVICE, p["queries"][0]["dql"])  # filtered in Python: no array function to get wrong
        self.assertIn(f'dt.entity.service == "{SERVICE}"', p["queries"][1]["dql"])
        self.assertIn("countIf(request.is_failed == true)", p["queries"][1]["dql"])
        no_window = dynatrace.plan(dynatrace.parse_link(f"https://{TENANT}.live.dynatrace.com/#serviceOverview;id={SERVICE}"), NOW)
        self.assertEqual([q["name"] for q in no_window["queries"]], ["problems"])

    def test_logs_plan_needs_a_scope(self):
        with_trace = dynatrace.plan(dynatrace.parse_link(PLATFORM_LOGS), NOW)["queries"][0]
        self.assertIn(f'trace_id == "{TRACE}"', with_trace["dql"])
        with_service = dynatrace.plan(dynatrace.parse_link(LOGS_LINK), NOW)["queries"][0]
        self.assertIn(f'dt.entity.service == "{SERVICE}"', with_service["dql"])
        bare = dynatrace.plan(dynatrace.parse_link(f"https://{TENANT}.live.dynatrace.com/#logs;gtf=2026-02-26T13:45:00Z%20to%202026-02-26T14:00:00Z"), NOW)
        self.assertEqual(bare["queries"], [])
        self.assertIn("no trace or service id", bare["note"])

    def test_other_links_are_not_queried(self):
        p = dynatrace.plan(dynatrace.parse_link(f"https://{TENANT}.live.dynatrace.com/#dashboard;id=x"), NOW)
        self.assertEqual(p["queries"], [])
        self.assertIn("not read", p["note"])

    def test_every_query_is_read_only(self):
        for link in (TRACE_LINK, PROBLEM_LINK, SERVICE_LINK, PLATFORM_LOGS):
            for q in dynatrace.plan(dynatrace.parse_link(link), NOW)["queries"]:
                self.assertTrue(q["dql"].lstrip().startswith("fetch "), q["dql"])
                self.assertNotRegex(q["dql"].lower(), r"\b(delete|ingest|create|update|drop)\b")


# ── talking to Dynatrace ─────────────────────────────────────────────────────


class Transport(Base):
    def test_the_url_comes_from_the_configured_tenant_never_from_the_link(self):
        f = self.fake([("fetch spans", TRACE_ROWS)])
        dynatrace.read_link(dynatrace.parse_link(TRACE_LINK), NOW)
        self.assertTrue(f.calls)
        for c in f.calls:
            self.assertTrue(c["url"].startswith(f"https://{TENANT}.apps.dynatrace.com/platform/storage/query/v1/query:"), c["url"])

    def test_the_token_is_only_ever_in_the_authorization_header(self):
        f = self.fake([("fetch spans", TRACE_ROWS)])
        dynatrace.read_link(dynatrace.parse_link(TRACE_LINK), NOW)
        for c in f.calls:
            self.assertEqual(c["headers"]["Authorization"], f"Bearer {TOKEN}")
            self.assertNotIn(TOKEN, c["url"])
            self.assertNotIn(TOKEN, json.dumps(c["body"]))

    def test_the_request_body_is_bounded_and_carries_the_window_not_a_timestamp_literal(self):
        f = self.fake([("fetch spans", TRACE_ROWS)])
        dynatrace.read_link(dynatrace.parse_link(TRACE_LINK), NOW)
        body = f.calls[0]["body"]
        self.assertEqual(body["defaultTimeframeStart"], "2026-02-26T08:16:40Z")
        self.assertEqual(body["defaultTimeframeEnd"], "2026-02-26T08:29:00Z")
        self.assertEqual(body["maxResultRecords"], 500)
        self.assertLessEqual(body["maxResultBytes"], 2_000_000)
        self.assertLessEqual(body["defaultScanLimitGbytes"], 20)
        self.assertNotIn("from:", body["query"])

    def test_an_async_answer_is_polled_with_the_token_url_encoded(self):
        token = "tok+/=abc"
        calls = []

        healthy = [span("a1", "frontend", "GET /", 55, 40, None, False, 200, root=True)]

        def http(url, headers, data=None, timeout=None):
            calls.append(url)
            if data is not None:
                return 202, {"state": "RUNNING", "requestToken": token}
            if len([c for c in calls if "query:poll" in c]) < 2:
                return 200, {"state": "RUNNING"}
            return 200, {"state": "SUCCEEDED", "result": {"records": healthy}}

        with mock.patch.object(dynatrace, "_http", http), mock.patch.object(dynatrace.time, "sleep", lambda _s: None):
            item = dynatrace.read_link(dynatrace.parse_link(TRACE_LINK), NOW)
        polls = [c for c in calls if "query:poll" in c]
        self.assertEqual(len(polls), 2)
        self.assertIn("request-token=tok%2B%2F%3Dabc", polls[0])
        self.assertTrue(all(c.startswith(f"https://{TENANT}.apps.dynatrace.com/platform/storage/query/v1/query:") for c in calls))
        self.assertEqual(item["status"], "read")

    def test_a_query_that_never_finishes_is_a_failure_not_an_empty_answer(self):
        def http(url, headers, data=None, timeout=None):
            return (202, {"state": "RUNNING", "requestToken": "t"}) if data is not None else (200, {"state": "RUNNING"})

        with mock.patch.object(dynatrace, "_http", http), mock.patch.object(dynatrace.time, "sleep", lambda _s: None):
            item = dynatrace.read_link(dynatrace.parse_link(TRACE_LINK), NOW)
        self.assertEqual(item["status"], "unreachable")

    def test_a_rejected_query_is_a_finding_about_the_query_not_about_the_tenant(self):
        f = self.fake([("fetch spans", 400)])
        item = dynatrace.read_link(dynatrace.parse_link(TRACE_LINK), NOW)
        self.assertEqual(item["status"], "empty")
        self.assertIn("rejected the query", item["note"])
        self.assertFalse(dynatrace.unreachable())
        f2 = self.fake([("fetch dt.davis.problems", [])])
        again = dynatrace.read_link(dynatrace.parse_link(PROBLEM_LINK), NOW)
        self.assertEqual(again["status"], "empty")
        self.assertTrue(f2.calls)  # the tenant was not marked down

    def test_a_tenant_that_refuses_the_field_list_is_asked_once_more_without_it(self):
        f = self.fake([("fields start_time", 400), ("fetch spans", TRACE_ROWS), ("fetch dt.davis.problems", [])])
        item = dynatrace.read_link(dynatrace.parse_link(TRACE_LINK), NOW)
        self.assertEqual(item["status"], "read")
        spans = [q for q in f.queries if q.startswith("fetch spans")]
        self.assertEqual(len(spans), 2)
        self.assertIn("fields start_time", spans[0])
        self.assertNotIn("fields", spans[1])
        self.assertIn('filter trace.id == "' + TRACE + '"', spans[1])
        self.assertFalse(dynatrace.unreachable())

    def test_a_query_that_was_accepted_and_then_failed_is_a_failed_lookup_not_an_empty_answer(self):
        for state in ("FAILED", "CANCELLED", "RESULT_GONE"):
            with self.subTest(state=state):
                dynatrace.reset_run()
                self.fake([("fetch spans", (200, {"state": state}))])
                item = dynatrace.read_link(dynatrace.parse_link(TRACE_LINK), NOW)
                self.assertEqual(item["status"], "unreachable")
                self.assertEqual(dynatrace.failure()[0], "unreachable")
                self.assertFalse(dynatrace.unreachable(), "a failed query does not mark the tenant down")

    def test_a_refusal_is_remembered_for_the_run(self):
        f = self.fake([("fetch spans", (200, {"state": "FAILED"}))])
        for _ in range(3):
            self.assertEqual(dynatrace.read_link(dynatrace.parse_link(TRACE_LINK), NOW)["status"], "unreachable")
        self.assertEqual(len([q for q in f.queries if "fetch spans" in q]), 1)
        dynatrace.reset_run()
        g = self.fake([("fetch spans", 400)])
        for _ in range(3):
            self.assertEqual(dynatrace.read_link(dynatrace.parse_link(TRACE_LINK), NOW)["status"], "empty")
        self.assertEqual(len([q for q in g.queries if q.startswith("fetch spans")]), 2, "the question and its fallback — once")

    def test_the_wall_clock_budget(self):
        f = self.fake([("fetch spans", TRACE_ROWS)])
        with mock.patch.object(dynatrace, "MAX_RUN_SECONDS", -1):
            item = dynatrace.read_link(dynatrace.parse_link(TRACE_LINK), NOW)
        self.assertEqual(item["status"], "unreachable")
        self.assertIn("time budget", item["note"])
        self.assertEqual(dynatrace.failure()[0], "budget-exhausted")
        self.assertEqual(f.calls, [])

    def test_a_tenant_whose_queries_keep_not_finishing_is_treated_as_down(self):
        calls = []

        def http(url, headers, data=None, timeout=None):
            calls.append(url)
            return (202, {"state": "RUNNING", "requestToken": "t"}) if data is not None else (200, {"state": "RUNNING"})

        with mock.patch.object(dynatrace, "_http", http), mock.patch.object(dynatrace.time, "sleep", lambda _s: None):
            for i in range(dynatrace.SLOW_STRIKES):
                dynatrace.read_link(dynatrace.parse_link(TRACE_LINK.replace(TRACE, f"{i + 1:032x}")), NOW)
            n = len(calls)
            again = dynatrace.read_link(dynatrace.parse_link(TRACE_LINK.replace(TRACE, "f" * 32)), NOW)
        self.assertEqual(len(calls), n)
        self.assertEqual(again["status"], "unreachable")
        self.assertTrue(dynatrace.unreachable())

    def test_a_401_marks_the_tenant_down_for_the_rest_of_the_run(self):
        f = self.fake([("fetch", 401)])
        item = dynatrace.read_link(dynatrace.parse_link(TRACE_LINK), NOW)
        self.assertEqual(item["status"], "auth-failed")
        n = len(f.calls)
        again = dynatrace.read_link(dynatrace.parse_link(PROBLEM_LINK), NOW)
        self.assertEqual(again["status"], "auth-failed")
        self.assertEqual(len(f.calls), n, "no second call to a tenant that rejected the token")
        self.assertEqual(dynatrace.failure()[0], "auth-failed")

    def test_a_403_names_the_missing_scope_but_only_blocks_that_table(self):
        self.fake([("fetch spans", 403), ("fetch dt.davis.problems", [PROBLEM_ROW])])
        item = dynatrace.read_link(dynatrace.parse_link(TRACE_LINK), NOW)
        self.assertEqual(item["status"], "auth-failed")
        self.assertIn("storage:spans:read", item["note"])
        ok = dynatrace.read_link(dynatrace.parse_link(PROBLEM_LINK), NOW)
        self.assertEqual(ok["status"], "read")

    def test_a_network_failure_marks_the_tenant_down(self):
        f = self.fake([("fetch", urllib.error.URLError(OSError("no route")))])
        item = dynatrace.read_link(dynatrace.parse_link(TRACE_LINK), NOW)
        self.assertEqual(item["status"], "unreachable")
        n = len(f.calls)
        dynatrace.read_link(dynatrace.parse_link(PROBLEM_LINK), NOW)
        self.assertEqual(len(f.calls), n)
        self.assertTrue(dynatrace.unreachable())
        self.assertEqual(dynatrace.failure()[0], "unreachable")

    def test_one_tenant_down_does_not_stop_the_other(self):
        f = self.fake([("fetch spans", urllib.error.URLError(OSError("no route")))])
        dynatrace.read_link(dynatrace.parse_link(TRACE_LINK), NOW)
        other = dynatrace.parse_link(TRACE_LINK.replace(TENANT, OTHER))
        f.routes = [("fetch spans", TRACE_ROWS)]
        item = dynatrace.read_link(other, NOW)
        self.assertEqual(item["status"], "read")

    def test_the_call_budget_is_spent_once_and_then_everything_waits(self):
        f = self.fake([("fetch spans", TRACE_ROWS)])
        with mock.patch.object(dynatrace, "MAX_CALLS_PER_RUN", 1):
            first = dynatrace.read_link(dynatrace.parse_link(TRACE_LINK), NOW)
            second = dynatrace.read_link(dynatrace.parse_link(TRACE_LINK.replace(TRACE, "1" * 32)), NOW)
        self.assertEqual(first["status"], "read")
        self.assertEqual(second["status"], "unreachable")
        self.assertIn("budget", second["note"])
        self.assertEqual(dynatrace.failure()[0], "budget-exhausted")
        self.assertEqual(len(f.calls), 1)

    def test_the_same_question_is_asked_once_per_run(self):
        f = self.fake([("fetch spans", TRACE_ROWS)])
        a = dynatrace.read_link(dynatrace.parse_link(TRACE_LINK), NOW)
        n_spans = len([q for q in f.queries if "fetch spans" in q])
        again = dynatrace.read_link(dynatrace.parse_link(TRACE_LINK), NOW)
        self.assertEqual((a["status"], again["status"]), ("read", "read"))
        self.assertEqual(len([q for q in f.queries if "fetch spans" in q]), n_spans)
        self.assertEqual(n_spans, 1)
        # a different window is a different question
        other = TRACE_LINK.replace("timeframe=custom1772094100000to1772094240000", "timeframe=custom1772094100000to1772094340000")
        dynatrace.read_link(dynatrace.parse_link(other), NOW)
        self.assertEqual(len([q for q in f.queries if "fetch spans" in q]), 2)

    def test_the_opener_never_follows_a_redirect_to_another_origin(self):
        opener = dynatrace._opener()
        handlers = [h for h in opener.handlers if isinstance(h, _safe_http.SameOriginRedirect)]
        self.assertTrue(handlers)

    def test_tls_has_its_own_opt_out_and_jira_s_does_not_apply(self):
        with mock.patch.dict(os.environ, {"JIRA_INSECURE_TLS": "1"}):
            ctx = dynatrace.make_ssl_context()
            self.assertTrue(ctx.check_hostname)
        with mock.patch.dict(os.environ, {"DYNATRACE_INSECURE_TLS": "1"}):
            ctx = dynatrace.make_ssl_context()
            self.assertFalse(ctx.check_hostname)

    def test_health_follows_the_real_calls_and_never_holds_a_secret(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.dict(os.environ, {"JB_HEALTH_DIR": d}):
            _health._reset_cache()
            self.fake([("fetch spans", TRACE_ROWS)])
            dynatrace.read_link(dynatrace.parse_link(TRACE_LINK), NOW)
            self.assertEqual(_health.read("dynatrace", d)["state"], "ok")
            _health._reset_cache()
            dynatrace.reset_run()
            self.fake([("fetch", 401)])
            dynatrace.read_link(dynatrace.parse_link(TRACE_LINK.replace(TRACE, "2" * 32)), NOW)
            rec = _health.read("dynatrace", d)
            self.assertEqual((rec["state"], rec["status"]), ("attention", "auth-failed"))
            self.assertNotIn(TOKEN, json.dumps(rec))

    def test_a_dql_error_is_not_a_service_failure_for_health(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.dict(os.environ, {"JB_HEALTH_DIR": d}):
            _health._reset_cache()
            self.fake([("fetch spans", 400)])
            dynatrace.read_link(dynatrace.parse_link(TRACE_LINK), NOW)
            self.assertIsNone(_health.read("dynatrace", d))


# ── reading a link end to end ────────────────────────────────────────────────


class ReadLink(Base):
    def test_a_trace_with_a_failure_chain(self):
        f = self.fake([("fetch spans", TRACE_ROWS), ("fetch dt.davis.problems", [PROBLEM_ROW])])
        item = dynatrace.read_link(dynatrace.parse_link(TRACE_LINK), NOW)
        self.assertEqual(item["status"], "read")
        self.assertEqual((item["kind"], item["host"], item["tenant"]), ("trace", "classic", "prod"))
        self.assertEqual(item["window"], {"from": "2026-02-26T08:16:40Z", "to": "2026-02-26T08:29:00Z"})
        self.assertEqual(item["fetchedAt"], "2026-02-27T09:00:00Z")
        s = item["summary"]
        self.assertEqual(s["spans"], 5)
        self.assertEqual(s["services"], ["frontend", "gateway", "payments"])
        self.assertEqual(s["root"], "POST /pay")
        self.assertEqual(s["failedSpans"], 3)
        self.assertEqual(s["statusCodes"], {"500": 2, "504": 1, "200": 1})
        self.assertEqual(s["firstFailure"], {"service": "payments", "name": "POST /charge"})
        self.assertEqual(s["slowest"], {"name": "frontend POST /pay", "ms": 31200})
        self.assertEqual(s["errors"][0], {"message": "SocketTimeoutException: Read timed out after 30000 ms", "count": 1})
        self.assertEqual(s["problems"][0]["displayId"], "P-23101234")
        self.assertEqual(s["problems"][0]["rootCause"], "payments")
        text = " | ".join(item["findings"])
        self.assertIn("5 spans across 3 services (frontend → gateway → payments)", text)
        self.assertIn("root: POST /pay", text)
        self.assertIn("3 failed spans", text)
        self.assertIn("originates in payments: POST /charge", text)
        self.assertIn("HTTP 500 ×2 · 504 ×1", text)
        self.assertIn("SocketTimeoutException", text)
        self.assertIn("Davis problem P-23101234", text)
        self.assertLessEqual(len(json.dumps(item)), 3200)
        self.assertEqual(len(f.calls), 2)

    def test_a_healthy_trace_asks_for_no_problems(self):
        ok = [span("a1", "frontend", "GET /", 55, 40, None, False, 200, "GET", "/", root=True), span("a2", "gateway", "GET /x", 56, 30, "a1", False, 200)]
        f = self.fake([("fetch spans", ok)])
        item = dynatrace.read_link(dynatrace.parse_link(TRACE_LINK), NOW)
        self.assertEqual(item["status"], "read")
        self.assertEqual(item["summary"]["failedSpans"], 0)
        self.assertIn("no failed spans", " | ".join(item["findings"]))
        self.assertEqual(len(f.calls), 1)

    def test_the_failure_origin_is_the_deepest_failed_span_not_the_first_in_time(self):
        rows = [span("r", "web", "GET /", 10, 900, None, True, 500, root=True), span("m", "api", "GET /a", 11, 800, "r", True, 500), span("l", "db-gateway", "query", 12, 700, "m", True, None)]
        item = dynatrace.summarize_trace(rows, [])[0]
        self.assertEqual(item["firstFailure"], {"service": "db-gateway", "name": "query"})

    def test_a_trace_with_no_spans_is_empty_not_failed(self):
        self.fake([("fetch spans", [])])
        item = dynatrace.read_link(dynatrace.parse_link(TRACE_LINK), NOW)
        self.assertEqual(item["status"], "empty")
        self.assertIn("No spans", item["note"])
        self.assertEqual(item["findings"], [])

    def test_a_problem(self):
        self.fake([("fetch dt.davis.problems", [PROBLEM_ROW])])
        item = dynatrace.read_link(dynatrace.parse_link(PROBLEM_LINK), NOW)
        self.assertEqual((item["status"], item["kind"]), ("read", "problem"))
        pr = item["summary"]["problems"][0]
        self.assertEqual((pr["title"], pr["status"], pr["severity"], pr["displayId"]), ("Response time degradation", "CLOSED", "SLOWDOWN", "P-23101234"))
        self.assertEqual(pr["rootCause"], "payments")
        text = " | ".join(item["findings"])
        self.assertIn("Problem P-23101234: Response time degradation", text)
        self.assertIn("CLOSED", text)
        self.assertIn("42 min", text)
        self.assertIn("Root cause: payments", text)

    def test_a_service_lists_only_problems_that_name_it_and_counts_requests(self):
        other = {**PROBLEM_ROW, "display_id": "P-1", "event.id": "x1", "affected_entity_ids": ["SERVICE-FFFFFFFFFFFFFFFF"], "root_cause_entity_id": "SERVICE-FFFFFFFFFFFFFFFF"}
        mine = {**PROBLEM_ROW, "display_id": "P-2", "event.id": "x2", "affected_entity_ids": [SERVICE], "root_cause_entity_id": None}
        self.fake([("fetch dt.davis.problems", [other, mine]), ("summarize total", [{"total": 2000, "failed": 160}])])
        item = dynatrace.read_link(dynatrace.parse_link(SERVICE_LINK), NOW)
        self.assertEqual(item["status"], "read")
        self.assertEqual([p["displayId"] for p in item["summary"]["problems"]], ["P-2"])
        self.assertEqual(item["summary"]["requests"], {"total": 2000, "failed": 160})
        self.assertIn("160 of 2000 root requests failed (8%)", " | ".join(item["findings"]))

    def test_logs_are_grouped_scrubbed_and_counted(self):
        rows = [{"content": f"Payment 1234{i} failed for jane.doe@example.com: Read timed out", "loglevel": "ERROR"} for i in range(4)]
        rows += [{"content": "Connection pool exhausted password=hunter2hunter2", "loglevel": "ERROR"}]
        self.fake([("fetch logs", rows)])
        item = dynatrace.read_link(dynatrace.parse_link(LOGS_LINK), NOW)
        self.assertEqual(item["status"], "read")
        groups = item["summary"]["logGroups"]
        self.assertEqual(groups[0]["count"], 4)
        blob = json.dumps(item)
        self.assertNotIn("jane.doe@example.com", blob)
        self.assertNotIn("hunter2hunter2", blob)

    def test_empty_logs_are_empty(self):
        self.fake([("fetch logs", [])])
        self.assertEqual(dynatrace.read_link(dynatrace.parse_link(LOGS_LINK), NOW)["status"], "empty")

    def test_an_unconfigured_tenant_is_listed_and_never_fetched(self):
        f = self.fake([("fetch", TRACE_ROWS)])
        item = dynatrace.read_link(dynatrace.parse_link(TRACE_LINK.replace(TENANT, STRANGER)), NOW)
        self.assertEqual(item["status"], "unconfigured-tenant")
        self.assertEqual(item["tenant"], STRANGER)
        self.assertIn("not in DYNATRACE_TENANTS", item["note"])
        self.assertEqual(item["findings"], [])
        self.assertEqual(f.calls, [])

    def test_an_other_link_and_a_trace_without_a_window_are_empty_with_a_reason(self):
        f = self.fake([("fetch", TRACE_ROWS)])
        a = dynatrace.read_link(dynatrace.parse_link(f"https://{TENANT}.live.dynatrace.com/#dashboard;id=x"), NOW)
        b = dynatrace.read_link(dynatrace.parse_link(f"https://{TENANT}.live.dynatrace.com/#trace;traceId={TRACE}"), NOW)
        self.assertEqual((a["status"], b["status"]), ("empty", "empty"))
        self.assertIn("not read", a["note"])
        self.assertIn("no absolute time window", b["note"])
        self.assertEqual(f.calls, [])

    def test_the_stored_item_never_holds_a_secret_or_a_raw_message(self):
        evil = [{"content": "x", "loglevel": "ERROR"}]
        rows = [span("a1", "svc", "GET /", 55, 5, None, True, 500, root=True,
                     events=[{"exception.type": "RuntimeError", "exception.message": f"Bearer abc123def456ghi789 and {TOKEN} and https://u:p4ss@h.example.com/x"}])]
        self.fake([("fetch spans", rows), ("fetch dt.davis.problems", [])])
        item = dynatrace.read_link(dynatrace.parse_link(TRACE_LINK), NOW)
        blob = json.dumps(item)
        for secret in ("abc123def456ghi789", TOKEN, "p4ss"):
            self.assertNotIn(secret, blob)
        self.assertTrue(evil)

    def test_findings_are_capped(self):
        rows = [span(f"s{i}", f"svc{i}", f"op {i}", 10 + (i % 40), 5, None if i == 0 else "s0", True, 500 + i, root=i == 0,
                     events=[{"exception.type": f"E{i}Exception", "exception.message": "boom " + "x" * 400}]) for i in range(60)]
        self.fake([("fetch spans", rows), ("fetch dt.davis.problems", [PROBLEM_ROW] * 5)])
        item = dynatrace.read_link(dynatrace.parse_link(TRACE_LINK), NOW)
        self.assertLessEqual(len(item["findings"]), 8)
        self.assertTrue(all(len(x) <= 200 for x in item["findings"]))
        self.assertLessEqual(len(json.dumps(item)), 3200)


# ── the per-ticket lookup the fetch uses ─────────────────────────────────────


class Lookup(Base):
    def read_item(self, **over):
        item = {"url": TRACE_LINK, "kind": "trace", "host": "classic", "tenant": "prod", "window": {"from": "2026-02-26T08:16:40Z", "to": "2026-02-26T08:29:00Z"},
                "status": "read", "findings": ["old finding"], "summary": {"spans": 3}, "fetchedAt": "2026-02-27T08:30:00Z"}
        item.update(over)
        return item

    def test_no_links_means_no_field(self):
        r = dynatrace.lookup(ticket(), None, NOW)
        self.assertIsNone(r["evidence"])
        self.assertEqual(r["links"], 0)

    def test_not_configured_keeps_what_there_was(self):
        prior = {"fetchedAt": "2026-02-01T00:00:00Z", "items": [self.read_item()]}
        with mock.patch.dict(os.environ, {"DYNATRACE_PAT": ""}):
            r = dynatrace.lookup(ticket(description=TRACE_LINK), prior, NOW)
        self.assertEqual(r["evidence"], prior)
        self.assertEqual(r["waiting"][0], "not-configured")

    def test_a_fresh_read_is_not_repeated(self):
        f = self.fake([("fetch spans", TRACE_ROWS)])
        prior = {"fetchedAt": "2026-02-27T08:30:00Z", "items": [self.read_item()]}
        r = dynatrace.lookup(ticket(description=TRACE_LINK), prior, NOW)
        self.assertEqual(f.calls, [])
        self.assertEqual(r["evidence"]["items"][0]["findings"], ["old finding"])
        self.assertEqual(r["evidence"]["fetchedAt"], "2026-02-27T08:30:00Z")
        self.assertEqual(r["statuses"], ["read"])

    def test_an_old_read_is_repeated(self):
        f = self.fake([("fetch spans", TRACE_ROWS)])
        prior = {"fetchedAt": "2026-02-20T08:30:00Z", "items": [self.read_item(fetchedAt="2026-02-20T08:30:00Z")]}
        r = dynatrace.lookup(ticket(description=TRACE_LINK), prior, NOW)
        self.assertTrue(f.calls)
        self.assertEqual(r["evidence"]["fetchedAt"], "2026-02-27T09:00:00Z")
        self.assertNotEqual(r["evidence"]["items"][0]["findings"], ["old finding"])

    def test_an_empty_answer_is_retried_after_six_hours_and_an_open_problem_sooner_than_a_closed_one(self):
        f = self.fake([("fetch spans", [])])
        recent = {"fetchedAt": "x", "items": [self.read_item(status="empty", findings=[], summary=None, fetchedAt="2026-02-27T07:30:00Z")]}
        dynatrace.lookup(ticket(description=TRACE_LINK), recent, NOW)
        self.assertEqual(f.calls, [], "an empty answer from 90 minutes ago is not asked again")
        old = {"fetchedAt": "x", "items": [self.read_item(status="empty", findings=[], summary=None, fetchedAt="2026-02-27T02:30:00Z")]}
        dynatrace.lookup(ticket(description=TRACE_LINK), old, NOW)
        self.assertTrue(f.calls)
        dynatrace.reset_run()
        g = self.fake([("fetch dt.davis.problems", [PROBLEM_ROW])])
        active = {"title": "t", "status": "ACTIVE"}
        item = self.read_item(url=PROBLEM_LINK, kind="problem", summary={"problems": [active]}, fetchedAt="2026-02-27T07:30:00Z")
        dynatrace.lookup(ticket(description=PROBLEM_LINK), {"fetchedAt": "x", "items": [item]}, NOW)
        self.assertTrue(g.calls)
        dynatrace.reset_run()
        h = self.fake([("fetch dt.davis.problems", [PROBLEM_ROW])])
        closed = self.read_item(url=PROBLEM_LINK, kind="problem", summary={"problems": [{"title": "t", "status": "CLOSED"}]}, fetchedAt="2026-02-27T07:30:00Z")
        dynatrace.lookup(ticket(description=PROBLEM_LINK), {"fetchedAt": "x", "items": [closed]}, NOW)
        self.assertEqual(h.calls, [])

    def test_a_failed_lookup_carries_the_previous_answer_forward_marked_stale(self):
        self.fake([("fetch", urllib.error.URLError(OSError("down")))])
        prior = {"fetchedAt": "2026-02-20T08:30:00Z", "items": [self.read_item(fetchedAt="2026-02-20T08:30:00Z")]}
        r = dynatrace.lookup(ticket(description=TRACE_LINK), prior, NOW)
        item = r["evidence"]["items"][0]
        self.assertEqual(item["status"], "read")
        self.assertTrue(item["stale"])
        self.assertEqual(item["findings"], ["old finding"])
        self.assertEqual(item["fetchedAt"], "2026-02-20T08:30:00Z")
        self.assertEqual(r["evidence"]["fetchedAt"], "2026-02-20T08:30:00Z")
        self.assertEqual(r["waiting"][0], "unreachable")

    def test_a_rejected_query_never_replaces_an_earlier_answer(self):
        self.fake([("fetch", 400)])
        prior = {"fetchedAt": "2026-02-20T08:30:00Z", "items": [self.read_item(fetchedAt="2026-02-20T08:30:00Z")]}
        r = dynatrace.lookup(ticket(description=TRACE_LINK), prior, NOW)
        item = r["evidence"]["items"][0]
        self.assertEqual((item["status"], item["findings"], item.get("stale")), ("read", ["old finding"], True))
        self.assertIsNone(r["waiting"], "a query the tenant refuses is not a service failure — no 'unreachable' note")
        self.assertEqual(r["evidence"]["fetchedAt"], "2026-02-20T08:30:00Z")

    def test_a_rejected_query_with_nothing_before_it_is_stored_with_the_reason(self):
        self.fake([("fetch", 400)])
        item = dynatrace.lookup(ticket(description=TRACE_LINK), None, NOW)["evidence"]["items"][0]
        self.assertEqual(item["status"], "empty")
        self.assertIn("rejected the query", item["note"])

    def test_a_failed_lookup_with_nothing_before_it_is_stored_as_failed(self):
        self.fake([("fetch", 401)])
        r = dynatrace.lookup(ticket(description=TRACE_LINK), None, NOW)
        self.assertEqual(r["evidence"]["items"][0]["status"], "auth-failed")
        self.assertEqual(r["waiting"][0], "auth-failed")

    def test_a_good_read_after_a_stale_one_clears_the_stale_mark(self):
        self.fake([("fetch spans", TRACE_ROWS)])
        prior = {"fetchedAt": "x", "items": [self.read_item(stale=True, fetchedAt="2026-02-27T08:59:00Z")]}
        item = dynatrace.lookup(ticket(description=TRACE_LINK), prior, NOW)["evidence"]["items"][0]
        self.assertNotIn("stale", item)

    def test_at_most_five_links_are_read_and_the_rest_are_counted(self):
        links = " ".join(TRACE_LINK.replace(TRACE, f"{i:032x}") for i in range(1, 9))
        f = self.fake([("fetch spans", TRACE_ROWS)])
        r = dynatrace.lookup(ticket(description=links), None, NOW)
        self.assertEqual(len(r["evidence"]["items"]), 5)
        self.assertEqual(r["evidence"]["moreLinks"], 3)
        self.assertEqual(len([q for q in f.queries if "fetch spans" in q]), 5)

    def test_an_unconfigured_tenant_next_to_a_good_link(self):
        self.fake([("fetch spans", TRACE_ROWS)])
        t = ticket(description=f"{TRACE_LINK} {TRACE_LINK.replace(TENANT, STRANGER)}")
        r = dynatrace.lookup(t, None, NOW)
        self.assertEqual(sorted(r["statuses"]), ["read", "unconfigured-tenant"])
        self.assertIsNone(r["waiting"])

    def test_flagged_when_a_link_shows_failures_or_a_problem(self):
        self.fake([("fetch spans", TRACE_ROWS), ("fetch dt.davis.problems", [])])
        self.assertTrue(dynatrace.lookup(ticket(description=TRACE_LINK), None, NOW)["flagged"])
        dynatrace.reset_run()
        ok = [span("a1", "frontend", "GET /", 55, 40, None, False, 200, root=True)]
        self.fake([("fetch spans", ok)])
        self.assertFalse(dynatrace.lookup(ticket(description=TRACE_LINK.replace(TRACE, "3" * 32)), None, NOW)["flagged"])

    def test_a_link_that_is_gone_from_the_ticket_is_dropped_from_the_field(self):
        self.fake([("fetch spans", TRACE_ROWS)])
        prior = {"fetchedAt": "x", "items": [self.read_item(), self.read_item(url=PROBLEM_LINK, kind="problem")]}
        r = dynatrace.lookup(ticket(description=TRACE_LINK), prior, NOW)
        self.assertEqual([i["kind"] for i in r["evidence"]["items"]], ["trace"])


# ── the daily fetch ──────────────────────────────────────────────────────────


class DailyFetch(Base):
    def setUp(self):
        super().setUp()
        daily_fetch._sources.reset()

    def read_item(self):
        return {"url": TRACE_LINK, "kind": "trace", "host": "classic", "tenant": "prod", "status": "read", "findings": ["old"], "fetchedAt": "2026-02-20T08:30:00Z"}

    def test_it_stores_the_evidence_on_a_ticket_that_has_links(self):
        self.fake([("fetch spans", TRACE_ROWS), ("fetch dt.davis.problems", [PROBLEM_ROW])])
        t = ticket(description=TRACE_LINK)
        daily_fetch.apply_dynatrace(t, "QA-1", {})
        self.assertEqual(t["dynatrace"]["items"][0]["status"], "read")
        self.assertNotIn("proofNotes", t)

    def test_a_ticket_without_links_gets_nothing_and_loses_an_old_field(self):
        t = ticket(dynatrace={"fetchedAt": "x", "items": [self.read_item()]}, proofNotes={"dynatrace": {"state": "unreachable", "detail": "x", "at": "y"}})
        daily_fetch.apply_dynatrace(t, "QA-1", t)
        self.assertNotIn("dynatrace", t)
        self.assertNotIn("proofNotes", t)

    def test_never_configured_keeps_the_prior_field_and_says_so(self):
        prior = ticket(description=TRACE_LINK, dynatrace={"fetchedAt": "2026-02-20T08:30:00Z", "items": [self.read_item()]})
        t = ticket(description=TRACE_LINK)
        with mock.patch.dict(os.environ, {"DYNATRACE_PAT": ""}):
            daily_fetch.apply_dynatrace(t, "QA-1", prior)
        self.assertEqual(t["dynatrace"]["items"][0]["findings"], ["old"])
        self.assertEqual(t["proofNotes"]["dynatrace"]["state"], "not-configured")
        self.assertIn("DYNATRACE_PAT", t["proofNotes"]["dynatrace"]["detail"])
        st = daily_fetch._sources.finish("dynatrace", "Dynatrace", "ticket with Dynatrace links", gap="DYNATRACE_PAT")
        self.assertEqual(st["state"], "not-configured")
        self.assertEqual(st["waiting"], ["QA-1"])

    def test_a_failed_lookup_keeps_the_prior_answer_and_notes_it(self):
        self.fake([("fetch", urllib.error.URLError(OSError("down")))])
        prior = ticket(description=TRACE_LINK, dynatrace={"fetchedAt": "2026-02-20T08:30:00Z", "items": [self.read_item()]})
        t = ticket(description=TRACE_LINK)
        daily_fetch.apply_dynatrace(t, "QA-1", prior)
        self.assertTrue(t["dynatrace"]["items"][0]["stale"])
        self.assertEqual(t["proofNotes"]["dynatrace"]["state"], "unreachable")
        self.assertIn("Dynatrace could not be reached", t["proofNotes"]["dynatrace"]["detail"])

    def test_the_fast_path_re_reads_and_a_fresh_answer_clears_the_note(self):
        self.fake([("fetch spans", TRACE_ROWS), ("fetch dt.davis.problems", [])])
        t = ticket(description=TRACE_LINK, dynatrace={"fetchedAt": "2026-02-01T08:30:00Z", "items": [{**self.read_item(), "fetchedAt": "2026-02-01T08:30:00Z"}]},
                   proofNotes={"dynatrace": {"state": "unreachable", "detail": "x", "at": "2026-02-02T00:00:00Z"}})
        with mock.patch.object(daily_fetch, "apply_code", lambda ticket, key, prior=None: ticket), \
                mock.patch.object(daily_fetch, "apply_builds", lambda ticket, key, prior=None: ticket), \
                mock.patch.object(daily_fetch, "apply_vuln_fixes", lambda ticket, key, prior=None: ticket):
            daily_fetch.refresh_prs_only(t, "QA-1")
        self.assertNotIn("proofNotes", t)
        self.assertNotEqual(t["dynatrace"]["items"][0]["findings"], ["old"])

    def test_a_bug_in_the_lookup_never_takes_the_fetch_down(self):
        prior = ticket(description=TRACE_LINK, dynatrace={"fetchedAt": "2026-02-20T08:30:00Z", "items": [self.read_item()]})
        t = ticket(description=TRACE_LINK)
        with mock.patch.object(dynatrace, "lookup", side_effect=KeyError("boom")):
            daily_fetch.apply_dynatrace(t, "QA-1", prior)
        self.assertEqual(t["dynatrace"]["items"][0]["findings"], ["old"])
        self.assertEqual(t["proofNotes"]["dynatrace"]["state"], "unreachable")

    def test_the_run_line_says_what_happened(self):
        self.fake([("fetch spans", TRACE_ROWS), ("fetch dt.davis.problems", [PROBLEM_ROW])])
        a = ticket(key="QA-1", description=TRACE_LINK)
        b = ticket(key="QA-2", description=TRACE_LINK.replace(TENANT, STRANGER))
        c = ticket(key="QA-3", description="nothing")
        for t in (a, b, c):
            daily_fetch.apply_dynatrace(t, t["key"], {})
        status = daily_fetch.proof_sources_status()["dynatrace"]
        self.assertEqual(status["state"], "read")
        self.assertEqual(status["looked"], 2)
        self.assertEqual(status["counts"], {"read": 1, "empty": 0, "unconfigured-tenant": 1})
        self.assertIn("Dynatrace: 2 tickets with Dynatrace links looked up (2 links: 1 read · 1 unconfigured tenant)", status["detail"])
        self.assertIn("1 with failed requests", status["detail"])

    def test_not_configured_is_quiet_when_nobody_waits(self):
        with mock.patch.dict(os.environ, {"DYNATRACE_PAT": "", "DYNATRACE_TENANTS": ""}):
            status = daily_fetch.proof_sources_status()["dynatrace"]
        self.assertEqual(status["state"], "not-configured")
        self.assertIn("missing DYNATRACE_PAT, DYNATRACE_TENANTS", status["detail"])
        self.assertFalse(daily_fetch._sources.noteworthy(status))

    def test_no_candidates_says_so_when_configured(self):
        status = daily_fetch.proof_sources_status()["dynatrace"]
        self.assertEqual(status["state"], "no-candidates")
        self.assertIn("no ticket with Dynatrace links to look up", status["detail"])


# ── the terminal command ─────────────────────────────────────────────────────


class Cli(Base):
    def run_cli(self, *argv):
        out = io.StringIO()
        with mock.patch.object(sys, "stdout", out):
            code = dynatrace.main(list(argv))
        return code, out.getvalue()

    def test_inspect_prints_the_link_the_queries_and_the_findings_and_never_the_token(self):
        self.fake([("fetch spans", TRACE_ROWS), ("fetch dt.davis.problems", [PROBLEM_ROW])])
        code, out = self.run_cli("inspect", TRACE_LINK)
        self.assertEqual(code, 0)
        self.assertIn("tenant: prod", out)
        self.assertIn("kind: trace", out)
        self.assertIn(TRACE, out)
        self.assertIn("fetch spans", out)
        self.assertIn("3 failed spans", out)
        self.assertNotIn(TOKEN, out)
        self.assertNotIn(f"Bearer", out)

    def test_not_configured_still_shows_what_it_would_do_and_exits_2(self):
        with mock.patch.dict(os.environ, {"DYNATRACE_PAT": ""}):
            code, out = self.run_cli("inspect", TRACE_LINK)
        self.assertEqual(code, 2)
        self.assertIn("not configured", out.lower())
        self.assertIn("DYNATRACE_PAT", out)
        self.assertIn("fetch spans", out)

    def test_an_unlisted_tenant_is_explained_and_not_read(self):
        f = self.fake([("fetch", TRACE_ROWS)])
        code, out = self.run_cli("inspect", TRACE_LINK.replace(TENANT, STRANGER))
        self.assertEqual(code, 0)
        self.assertIn("not in DYNATRACE_TENANTS", out)
        self.assertEqual(f.calls, [])

    def test_a_failed_read_exits_1(self):
        self.fake([("fetch", 401)])
        code, out = self.run_cli("inspect", TRACE_LINK)
        self.assertEqual(code, 1)
        self.assertNotIn(TOKEN, out)

    def test_the_ticket_title_is_scrubbed_in_the_output(self):
        t = ticket(key="QA-7", title="token=hunter2hunter2 \x1b[2J broken", description=TRACE_LINK)
        self.fake([("fetch spans", TRACE_ROWS), ("fetch dt.davis.problems", [])])
        with mock.patch.object(dynatrace, "_ticket_from_dump", lambda key: t):
            code, out = self.run_cli("inspect", "QA-7")
        self.assertNotIn("hunter2hunter2", out)
        self.assertNotIn("\x1b", out)

    def test_not_a_dynatrace_link_exits_2(self):
        code, out = self.run_cli("inspect", "https://example.com/x")
        self.assertEqual(code, 2)
        self.assertIn("not a Dynatrace link", out)

    def test_no_read_prints_the_plan_only(self):
        f = self.fake([("fetch", TRACE_ROWS)])
        code, out = self.run_cli("inspect", "--no-read", TRACE_LINK)
        self.assertEqual(code, 0)
        self.assertIn("fetch spans", out)
        self.assertEqual(f.calls, [])

    def test_a_ticket_key_reads_every_link_on_the_board_copy(self):
        self.fake([("fetch spans", TRACE_ROWS), ("fetch dt.davis.problems", [PROBLEM_ROW])])
        t = ticket(key="QA-7", description=f"{TRACE_LINK} {PROBLEM_LINK}")
        with mock.patch.object(dynatrace, "_ticket_from_dump", lambda key: t if key == "QA-7" else None):
            code, out = self.run_cli("inspect", "QA-7")
        self.assertEqual(code, 0)
        self.assertIn("kind: trace", out)
        self.assertIn("kind: problem", out)
        code, out = self.run_cli("inspect", "QA-99")
        self.assertEqual(code, 2)


if __name__ == "__main__":
    unittest.main()
