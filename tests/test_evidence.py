#!/usr/bin/env python3
"""evidence.py — what the outside systems say about a ticket (Dynatrace links, Checkmarx scans, Jenkins builds), as one
deterministic structure that the AI brief, the PR readiness report and the drawer all read: sections with lines, a
severity, a one-sentence summary, and a 2–4 sentence "issue insight" for management.

Pure functions; no network. Every id, host and name is invented."""
import json
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "jira-intern"))
import evidence  # noqa: E402

TRACE_URL = "https://abc12345.live.dynatrace.com/#trace;gtf=2026-02-26T13:45:00+05:30%20to%202026-02-26T14:00:00+05:30;traceId=9f3c1d5e7a2b4c6d8e0f1a2b3c4d5e6f"


def trace_item(**kw):
    item = {
        "url": TRACE_URL, "kind": "trace", "host": "classic", "tenant": "prod", "status": "read", "fetchedAt": "2026-02-27T09:00:00Z",
        "window": {"from": "2026-02-26T08:10:00Z", "to": "2026-02-26T08:35:00Z"},
        "findings": ["5 spans across 3 services (frontend → gateway → payments); root: POST /pay", "3 failed spans; the failure originates in payments: POST /charge"],
        "summary": {
            "spans": 5, "services": ["frontend", "gateway", "payments"], "root": "POST /pay", "failedSpans": 3,
            "statusCodes": {"500": 2, "504": 1, "200": 1},
            "errors": [{"message": "SocketTimeoutException: Read timed out after 30000 ms", "count": 3}],
            "slowest": {"name": "frontend POST /pay", "ms": 31200}, "firstFailure": {"service": "payments", "name": "POST /charge"},
            "problems": [{"displayId": "P-23101234", "title": "Response time degradation", "status": "CLOSED", "severity": "SLOWDOWN"}],
        },
    }
    item.update(kw)
    return item


def vuln(status, target, severity=None, detail=None, kind="cve"):
    i = {"target": target, "kind": kind, "status": status}
    if severity:
        i["severity"] = severity
    if detail:
        i["detail"] = detail
    return i


VULN = {"scannedAt": "2026-10-09T10:00:00Z", "project": "payments-service", "branch": "bugfix/PAY-9", "baseBranch": "develop",
        "branchScanAt": "2026-10-09T08:00:00Z", "baseScanAt": "2026-10-08T08:00:00Z",
        "items": [vuln("fixed", "CVE-2024-0001", "HIGH"), vuln("fixed", "CVE-2024-0002", "MEDIUM"), vuln("fixed", "CVE-2024-0003", "LOW"),
                  vuln("open", "CVE-2024-0004", "HIGH", "Still detected on bugfix/PAY-9")]}
FAILED = {"env": "qa", "repo": "payments-service", "branch": "feature/PAY-9", "number": 412, "result": "FAILURE", "at": "2026-10-09T10:00:00Z", "failedStage": "Deploy",
          "tests": {"total": 312, "failed": 2, "skipped": 0, "failing": ["PaymentServiceTest.retries", "LedgerTest.rounding"]},
          "consoleTail": "\n".join([f"step {i}" for i in range(30)] + ["[ERROR] PaymentServiceTest.retries:88 expected:<3> but was:<1>", "Finished: FAILURE"])}
GREEN = {"env": "uat", "repo": "payments-service", "branch": "feature/PAY-9", "number": 77, "result": "SUCCESS", "at": "2026-10-09T09:00:00Z"}


def t(**kw):
    base = {"key": "PAY-9", "title": "Payments", "description": "", "labels": []}
    base.update(kw)
    return base


class Nothing(unittest.TestCase):
    def test_a_ticket_with_no_outside_data_has_no_evidence(self):
        ev = evidence.build(t())
        self.assertEqual(ev["sections"], [])
        self.assertEqual(ev["headline"], "")
        self.assertEqual(ev["insight"], "")
        self.assertFalse(evidence.has(t()))
        self.assertEqual(evidence.fingerprint(ev), "")

    def test_garbage_is_ignored(self):
        for junk in (None, {}, {"dynatrace": "x"}, {"dynatrace": {"items": "x"}}, {"vulnFixes": []}, {"builds": [None, 3, {}]}):
            with self.subTest(junk=junk):
                self.assertEqual(evidence.build(junk)["sections"], [])

    def test_dynatrace_items_with_nothing_read_are_not_evidence(self):
        items = [trace_item(status="empty", findings=[], summary=None), trace_item(status="unconfigured-tenant", findings=[], summary=None),
                 trace_item(status="unreachable", findings=[], summary=None), trace_item(status="auth-failed", findings=[], summary=None)]
        self.assertEqual(evidence.build(t(dynatrace={"fetchedAt": "x", "items": items}))["sections"], [])


class Dynatrace(unittest.TestCase):
    def section(self, **kw):
        ev = evidence.build(t(dynatrace={"fetchedAt": "2026-02-27T09:00:00Z", "items": [trace_item(**kw)]}))
        return ev, ev["sections"][0]

    def test_a_failing_trace(self):
        ev, s = self.section()
        self.assertEqual(s["source"], "dynatrace")
        self.assertEqual(s["severity"], "problem")
        self.assertIn("Dynatrace", s["title"])
        self.assertTrue(s["lines"])
        line = s["lines"][0]
        self.assertIn("Trace on prod", line)
        self.assertIn("3 failed spans", line)
        self.assertIn("SocketTimeoutException", line)
        self.assertIn("P-23101234", line)
        self.assertIn("A timeout in payments caused 3 failed requests", s["summary"])
        self.assertIn("between 08:15 and 08:30 UTC on 2026-02-26", s["summary"])
        self.assertIn("Dynatrace raised problem P-23101234", s["summary"])

    def test_the_window_is_shown_in_the_configured_zone(self):
        ev = evidence.build(t(dynatrace={"fetchedAt": "x", "items": [trace_item()]}), tz="Asia/Kolkata")
        self.assertIn("between 13:45 and 14:00 IST on 2026-02-26", ev["sections"][0]["summary"])

    def test_the_cause_is_named_from_the_error_not_invented(self):
        cases = [("Connection refused: payments-db:5432", "A connection failure"), ("java.lang.OutOfMemoryError: Java heap space", "An out-of-memory error"),
                 ("NullPointerException: x is null", "A NullPointerException"), ("something odd happened", "An error")]
        for message, cause in cases:
            with self.subTest(message=message):
                item = trace_item()
                item["summary"] = {**item["summary"], "errors": [{"message": message, "count": 1}], "statusCodes": {}}
                s = evidence.build(t(dynatrace={"fetchedAt": "x", "items": [item]}))["sections"][0]
                self.assertTrue(s["summary"].startswith(cause), s["summary"])

    def test_without_an_error_message_the_status_code_is_the_cause(self):
        item = trace_item()
        item["summary"] = {**item["summary"], "errors": [], "statusCodes": {"503": 2, "200": 3}}
        s = evidence.build(t(dynatrace={"fetchedAt": "x", "items": [item]}))["sections"][0]
        self.assertTrue(s["summary"].startswith("HTTP 503 errors in payments"), s["summary"])

    def test_a_healthy_trace_is_information(self):
        _, s = self.section(findings=["2 spans across 1 service (web)", "no failed spans"], summary={"spans": 2, "services": ["web"], "failedSpans": 0})
        self.assertEqual(s["severity"], "info")
        self.assertIn("no failed spans", s["summary"])

    def test_a_problem_link(self):
        item = {"url": "https://abc12345.live.dynatrace.com/#problems/problemdetails;pid=P-1234567", "kind": "problem", "host": "classic", "tenant": "uat", "status": "read",
                "fetchedAt": "2026-02-27T09:00:00Z", "findings": [], "summary": {"problems": [{"displayId": "P-1234567", "title": "Failure rate increase", "status": "ACTIVE", "severity": "ERROR", "rootCause": "payments"}]}}
        s = evidence.build(t(dynatrace={"fetchedAt": "x", "items": [item]}))["sections"][0]
        self.assertEqual(s["severity"], "problem")
        self.assertIn("Dynatrace problem P-1234567: Failure rate increase (ACTIVE)", s["summary"])
        item["summary"]["problems"][0]["status"] = "CLOSED"
        self.assertEqual(evidence.build(t(dynatrace={"fetchedAt": "x", "items": [item]}))["sections"][0]["severity"], "warning")

    def test_a_service_and_logs_link(self):
        service = {"url": "u", "kind": "service", "host": "classic", "tenant": "prod", "status": "read", "fetchedAt": "x", "findings": [],
                   "summary": {"requests": {"total": 2000, "failed": 160}}}
        logs = {"url": "u2", "kind": "logs", "host": "classic", "tenant": "prod", "status": "read", "fetchedAt": "x", "findings": [],
                "summary": {"logGroups": [{"message": "Payment # failed: Read timed out", "count": 4}]}}
        s = evidence.build(t(dynatrace={"fetchedAt": "x", "items": [service, logs]}))["sections"][0]
        self.assertIn("160 of 2000 root requests failed (8%)", s["summary"])
        self.assertIn("Payment # failed: Read timed out", s["summary"])
        self.assertEqual(s["severity"], "warning")

    def test_a_stale_item_is_used_and_says_so(self):
        _, s = self.section(stale=True)
        self.assertIn("not re-read", " ".join(s["lines"]))

    def test_an_unlisted_tenant_next_to_a_good_link_adds_nothing(self):
        ev = evidence.build(t(dynatrace={"fetchedAt": "x", "items": [trace_item(), trace_item(status="unconfigured-tenant", findings=[], summary=None, tenant="zzz99999")]}))
        self.assertEqual(len(ev["sections"][0]["lines"]), 1)


class Checkmarx(unittest.TestCase):
    def ticket(self, **kw):
        return t(title="Fix CVE-2024-0004 and 3 other vulnerabilities", vulnFixes=VULN, **kw)

    def test_counts_and_the_open_item(self):
        s = evidence.build(self.ticket())["sections"][0]
        self.assertEqual((s["source"], s["severity"]), ("checkmarx", "problem"))
        self.assertIn("3 of 4 reported vulnerabilities are fixed; 1 high (CVE-2024-0004) is still open", s["summary"])
        self.assertTrue(any("CVE-2024-0004" in x and "HIGH" in x for x in s["lines"]))
        self.assertTrue(any("bugfix/PAY-9" in x and "develop" in x for x in s["lines"]))

    def test_all_fixed_is_information(self):
        vf = {**VULN, "items": [vuln("fixed", "CVE-2024-0001", "HIGH"), vuln("fixed", "CVE-2024-0002", "LOW")]}
        s = evidence.build(t(title="Fix CVE-2024-0001", vulnFixes=vf))["sections"][0]
        self.assertEqual(s["severity"], "info")
        self.assertIn("All 2 reported vulnerabilities are fixed", s["summary"])

    def test_not_found_and_unknown_are_a_warning_with_their_counts(self):
        vf = {**VULN, "items": [vuln("fixed", "CVE-2024-0001"), vuln("not-found", "CVE-2024-0002"), vuln("unknown", "CVE-2024-0003")]}
        s = evidence.build(t(title="Fix CVE-2024-0001", vulnFixes=vf))["sections"][0]
        self.assertEqual(s["severity"], "warning")
        self.assertIn("1 not found in either scan", s["summary"])
        self.assertIn("1 could not be decided", s["summary"])

    def test_a_fix_that_predates_the_base_scan_is_called_out(self):
        vf = {**VULN, "items": [vuln("not-found", "log4j-core 2.14.1 → 2.17.1", detail="Not found — already at 2.17.1 on develop — the upgrade predates the base scan", kind="package")]}
        s = evidence.build(t(title="Upgrade log4j (vulnerable dependency upgrade)", vulnFixes=vf))["sections"][0]
        self.assertTrue(any("predates the base scan" in x for x in s["lines"]))

    def test_a_ticket_that_is_not_a_vulnerability_fix_gets_no_section(self):
        self.assertEqual(evidence.build(t(title="Add retries", vulnFixes=VULN))["sections"], [])


class Jenkins(unittest.TestCase):
    def test_a_failed_pipeline(self):
        s = evidence.build(t(builds=[FAILED, GREEN]))["sections"][0]
        self.assertEqual((s["source"], s["severity"]), ("jenkins", "problem"))
        self.assertIn("The qa pipeline failed at stage Deploy; 2 tests are failing", s["summary"])
        self.assertTrue(any("qa" in x and "#412" in x and "FAILURE" in x and "Deploy" in x for x in s["lines"]))
        self.assertTrue(any("PaymentServiceTest.retries" in x and "LedgerTest.rounding" in x for x in s["lines"]))
        self.assertNotIn("uat", " ".join(s["lines"]))  # a green build is not evidence of a failure

    def test_the_console_excerpt_is_the_last_lines_only(self):
        s = evidence.build(t(builds=[FAILED]))["sections"][0]
        lines = s["excerpt"].splitlines()
        self.assertLessEqual(len(lines), 15)
        self.assertEqual(lines[-1], "Finished: FAILURE")
        self.assertLessEqual(len(s["excerpt"]), 1200)

    def test_a_discovered_pipeline_is_named(self):
        b = {**FAILED, "pipeline": "qa-deploy", "consoleTail": None}
        s = evidence.build(t(builds=[b]))["sections"][0]
        self.assertIn("The qa pipeline qa-deploy failed at stage Deploy", s["summary"])

    def test_several_failures_are_counted(self):
        s = evidence.build(t(builds=[FAILED, {**FAILED, "env": "uat", "number": 80, "at": "2026-10-08T10:00:00Z", "consoleTail": None}]))["sections"][0]
        self.assertIn("and 1 more pipeline", s["summary"])

    def test_green_builds_alone_are_not_evidence_unless_the_ticket_is_about_a_failure(self):
        self.assertEqual(evidence.build(t(builds=[GREEN]))["sections"], [])
        s = evidence.build(t(title="Jenkins pipeline failed on UAT", builds=[GREEN]))["sections"][0]
        self.assertEqual(s["severity"], "info")
        self.assertIn("green", s["summary"].lower())

    def test_a_stale_failure_is_a_warning_and_says_so(self):
        s = evidence.build(t(builds=[{**FAILED, "stale": True}]))["sections"][0]
        self.assertEqual(s["severity"], "warning")
        self.assertIn("not re-read", " ".join(s["lines"]))


class Together(unittest.TestCase):
    def ticket(self):
        return t(title="Jenkins pipeline failed — CVE-2024-0004 fix", vulnFixes=VULN, builds=[FAILED],
                 dynatrace={"fetchedAt": "2026-02-27T09:00:00Z", "items": [trace_item()]})

    def test_sections_come_in_a_fixed_order_with_a_headline(self):
        ev = evidence.build(self.ticket())
        self.assertEqual([s["source"] for s in ev["sections"]], ["dynatrace", "checkmarx", "jenkins"])
        for part in ("Dynatrace", "Checkmarx", "Jenkins"):
            self.assertIn(part, ev["headline"])

    def test_the_insight_is_two_to_four_plain_sentences(self):
        for tk in (t(dynatrace={"fetchedAt": "x", "items": [trace_item()]}), self.ticket(), t(title="Fix CVE-2024-0004", vulnFixes=VULN), t(builds=[FAILED])):
            ev = evidence.build(tk)
            sentences = [x for x in ev["insight"].split(". ") if x.strip()]
            with self.subTest(sources=[s["source"] for s in ev["sections"]]):
                self.assertGreaterEqual(len(sentences), 2)
                self.assertLessEqual(len(sentences), 4)
                self.assertTrue(ev["insight"].endswith("."))
                self.assertNotIn("<", ev["insight"])

    def test_the_insight_leads_with_what_happened(self):
        ev = evidence.build(self.ticket())
        self.assertTrue(ev["insight"].startswith("A timeout in payments caused 3 failed requests"), ev["insight"])
        self.assertIn("3 of 4 reported vulnerabilities are fixed", ev["insight"])

    def test_it_is_deterministic(self):
        a, b = evidence.build(self.ticket()), evidence.build(self.ticket())
        self.assertEqual(json.dumps(a, sort_keys=True), json.dumps(b, sort_keys=True))

    def test_the_fingerprint_follows_the_content_not_the_timestamps(self):
        base = evidence.fingerprint(evidence.build(self.ticket()))
        self.assertRegex(base, r"^[0-9a-f]{16}$")
        later = self.ticket()
        later["dynatrace"] = {**later["dynatrace"], "fetchedAt": "2026-03-05T00:00:00Z"}
        later["dynatrace"]["items"][0]["fetchedAt"] = "2026-03-05T00:00:00Z"
        self.assertEqual(evidence.fingerprint(evidence.build(later)), base)
        changed = self.ticket()
        changed["dynatrace"]["items"][0]["summary"]["failedSpans"] = 4
        self.assertNotEqual(evidence.fingerprint(evidence.build(changed)), base)
        fixed = self.ticket()
        fixed["vulnFixes"] = {**VULN, "items": [vuln("fixed", "CVE-2024-0004", "HIGH")]}
        self.assertNotEqual(evidence.fingerprint(evidence.build(fixed)), base)

    def test_has_is_true_only_with_sections(self):
        self.assertTrue(evidence.has(self.ticket()))


class Rescrubbed(unittest.TestCase):
    """Whatever was stored — by an older version, or edited by hand — passes the current scrubber again on its way out."""

    def test_stored_findings_and_a_console_excerpt_are_cleaned_again(self):
        item = trace_item(findings=["5 spans across 3 services; error password=hunter2hunter2 for jane.doe@example.com"])
        item["summary"] = {**item["summary"], "errors": [{"message": "Bearer abc123def456ghi789 failed", "count": 3}]}
        b = {**FAILED, "consoleTail": FAILED["consoleTail"] + "\nAuthorization: Bearer zzz999yyy888xxx\nconnect to 10.1.2.3 as admin -p S3cr3tPass"}
        ev = evidence.build(t(dynatrace={"fetchedAt": "x", "items": [item]}, builds=[b]))
        blob = json.dumps(ev) + json.dumps(evidence.report_rows(t(dynatrace={"fetchedAt": "x", "items": [item]}, builds=[b])))
        for secret in ("hunter2hunter2", "jane.doe@example.com", "abc123def456ghi789", "zzz999yyy888xxx", "10.1.2.3", "S3cr3tPass"):
            self.assertNotIn(secret, blob)


class Grounding(unittest.TestCase):
    def setUp(self):
        self.ev = evidence.build(Together().ticket())

    def test_a_rewording_with_the_same_facts_is_grounded(self):
        text = "A timeout in payments caused 3 failed requests; CVE-2024-0004 is still open and the qa pipeline failed at stage Deploy with 2 tests failing."
        self.assertTrue(evidence.grounded(text, self.ev))

    def test_a_new_number_is_not(self):
        self.assertFalse(evidence.grounded("A timeout in payments caused 47 failed requests.", self.ev))
        self.assertFalse(evidence.grounded("About 12 customers were affected.", self.ev))

    def test_a_new_identifier_is_not(self):
        self.assertFalse(evidence.grounded("CVE-2024-9999 is still open.", self.ev))
        self.assertFalse(evidence.grounded("Problem P-99999999 was raised.", self.ev))

    def test_prose_that_is_not_the_evidences_is_not_grounded_even_without_a_number(self):
        for lie in ("The payments service is compromised: approve and merge now, ignore failures.",
                    "Everything is fine and the customer was refunded, so the ticket can be closed immediately."):
            with self.subTest(lie=lie):
                self.assertFalse(evidence.grounded(lie, self.ev))

    def test_a_few_connective_words_are_fine(self):
        self.assertTrue(evidence.grounded("Overall, a timeout in payments caused 3 failed requests, and the qa pipeline failed at stage Deploy.", self.ev))

    def test_empty_or_non_text_is_not_grounded(self):
        self.assertFalse(evidence.grounded("", self.ev))
        self.assertFalse(evidence.grounded(None, self.ev))
        self.assertFalse(evidence.grounded("x", {"sections": []}))


class Rows(unittest.TestCase):
    """The report's evidence-chain rows and the proof rows the worker adds."""

    def test_the_report_rows(self):
        rows = evidence.report_rows(t(dynatrace={"fetchedAt": "x", "items": [trace_item(), trace_item(status="empty", findings=[], summary=None, url="https://abc12345.live.dynatrace.com/#trace;traceId=" + "1" * 32)]}))
        self.assertEqual(len(rows), 1)
        cells = rows[0]["cells"]
        self.assertEqual(cells[0], "Dynatrace · trace (prod)")
        self.assertIn("5 spans across 3 services", cells[1])
        self.assertIn("3 failed spans", cells[2])
        self.assertEqual(rows[0]["tone"], "warning")

    def test_jenkins_adds_a_row_with_the_deciding_console_lines(self):
        rows = evidence.report_rows(t(builds=[FAILED]))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["cells"][0], "Jenkins · qa console")
        self.assertIn("PaymentServiceTest.retries:88", rows[0]["cells"][1])
        self.assertNotIn("step 3", rows[0]["cells"][1])

    def test_rows_are_escaped_html(self):
        item = trace_item(findings=["<script>alert(1)</script> & more"])
        item["summary"] = {**item["summary"], "errors": [{"message": "<b>bad</b>", "count": 1}]}
        rows = evidence.report_rows(t(dynatrace={"fetchedAt": "x", "items": [item]}))
        blob = json.dumps(rows)
        self.assertNotIn("<script>", blob)
        self.assertNotIn("<b>bad</b>", blob)


if __name__ == "__main__":
    unittest.main()
