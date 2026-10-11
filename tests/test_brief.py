#!/usr/bin/env python3
"""ai-intern/brief.py — the per-ticket AI brief: stage-aware, fact-labelled, identity-checked."""
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "ai-intern"))
sys.path.insert(0, os.path.join(ROOT, "jira-intern"))
import brief  # noqa: E402
import evidence  # noqa: E402

SUB = {"key": "ABC-12", "title": "Parent POM", "column": "prog", "status": "In Progress", "parentKey": "ABC-10", "parentTitle": "Maven build",
       "epic": {"key": "ABC-10", "relation": "parent"}}
STORY = {"key": "ABC-10", "title": "Maven build", "column": "rev", "status": "In Review", "epic": {"key": "ABC-1", "relation": "epic (parent)"},
         "subtasks": [{"key": "ABC-12", "title": "Parent POM", "status": "Done", "column": "done"}, {"key": "ABC-13", "title": "CI", "status": "To Do", "column": "todo"}],
         "branches": ["feature/ABC-10"], "branch": "feature/ABC-10",
         "prs": [{"id": 61, "repo": "svc", "state": "approved", "approvals": 3, "openComments": 0, "title": "ABC-10: Maven build",
                  "sourceBranch": "feature/ABC-10", "destinationBranch": "release/x", "merged": False, "url": "https://bb/pr/61"}]}


class Facts(unittest.TestCase):
    def test_a_parent_is_a_parent_ticket_never_an_epic(self):
        f = brief.build_facts(SUB)
        self.assertEqual(f["parentTicket"]["key"], "ABC-10")
        self.assertIn("not an epic", f["parentTicket"]["note"])
        self.assertNotIn("epicLink", f)  # the "epic" Jira-intern derived from the parent must not leak through

    def test_a_real_epic_link_is_kept_under_its_own_name(self):
        f = brief.build_facts(STORY)
        self.assertEqual(f["epicLink"]["key"], "ABC-1")
        self.assertNotIn("parentTicket", f)

    def test_a_ticket_in_no_epic_says_so(self):
        f = brief.build_facts({"key": "ABC-5", "column": "todo"})
        self.assertIn("epicLink", f)
        self.assertIsNone(f["epicLink"])

    def test_code_state_and_subtask_rollup(self):
        f = brief.build_facts(STORY, required_approvals=2)
        pr = f["code"]["pullRequests"][0]
        self.assertEqual((pr["number"], pr["state"], pr["approvals"], pr["from"], pr["into"]), (61, "approved", 3, "feature/ABC-10", "release/x"))
        self.assertEqual(f["code"]["requiredApprovals"], 2)
        self.assertEqual((f["subtasks"]["done"], f["subtasks"]["total"]), (1, 2))

    def test_no_code_is_stated_as_a_fact(self):
        f = brief.build_facts({"key": "ABC-5", "column": "rev"})
        self.assertIn("No branch and no pull request", f["code"]["note"])

    def test_stage_labels(self):
        self.assertIn("In Review", brief.build_facts(STORY)["stage"])
        self.assertIn("In Progress", brief.build_facts(SUB)["stage"])


class Prompt(unittest.TestCase):
    def test_review_stage_asks_for_code_state_and_epic_rules(self):
        p = brief.system_prompt(STORY)
        self.assertIn("In Review", p)
        self.assertIn("approvals against what is required", p)
        self.assertIn("NEVER an epic", p)
        self.assertIn("Every ticket key you write must appear in the packs", p)
        self.assertNotIn("short HTML brief", p)  # the v1 prompt that produced thin briefs

    def test_new_tickets_stay_short_and_wip_tickets_go_deep(self):
        p = brief.system_prompt({"column": "todo"})
        self.assertIn("60–110 words", p)
        self.assertIn("150–300", p)


class Staleness(unittest.TestCase):
    def test_v1_briefs_are_regenerated_once(self):
        old = {"aiSummary": "<p>short</p>", "aiSummaryAt": "2026-10-09T00:00:00Z", "lastUpdate": "2026-10-01T00:00:00Z"}
        self.assertTrue(brief.needs_brief(old))

    def test_current_stamped_brief_is_kept_until_the_ticket_changes(self):
        cur = {"aiSummary": brief.stamp("<p>x</p>"), "aiSummaryAt": "2026-10-09T00:00:00Z", "lastUpdate": "2026-10-01T00:00:00Z"}
        self.assertFalse(brief.needs_brief(cur))
        self.assertTrue(brief.needs_brief({**cur, "lastUpdate": "2026-10-10T00:00:00Z"}))

    def test_missing_or_json_wrapped_briefs_are_regenerated(self):
        self.assertTrue(brief.needs_brief({}))
        self.assertTrue(brief.needs_brief({"aiSummary": '{"html": "x"}', "aiSummaryAt": "9", "lastUpdate": "1"}))

    def test_stamp_is_idempotent(self):
        once = brief.stamp("<p>x</p>")
        self.assertEqual(brief.stamp(once), once)


class Scrub(unittest.TestCase):
    ALLOWED = {"ABC-10", "ABC-12", "ABC-1"}

    def test_an_invented_key_is_removed_with_its_link(self):
        out = brief.scrub('<p>See <a href="https://j/browse/ZZZ-9">ZZZ-9</a> and ABC-12 and QQQ-4.</p>', self.ALLOWED, None)
        self.assertNotIn("ZZZ-9", out)
        self.assertNotIn("QQQ-4", out)
        self.assertIn("ABC-12", out)

    def test_a_parent_called_an_epic_stops_being_one(self):
        out = brief.scrub('<p>Sub-task under parent epic <a href="u">ABC-10</a>.</p>', self.ALLOWED, None)
        self.assertNotRegex(out.lower(), r"epic\s*(<a[^>]*>)?\s*abc-10")
        self.assertIn("ABC-10", out)

    def test_the_real_epic_link_keeps_its_label(self):
        out = brief.scrub("<p>In epic ABC-1 (Release train).</p>", self.ALLOWED, "ABC-1")
        self.assertIn("epic ABC-1", out)

    def test_a_wrong_epic_is_unlabelled_even_when_a_real_one_exists(self):
        out = brief.scrub("<li><b>Epic:</b> ABC-12</li>", self.ALLOWED, "ABC-1")
        self.assertNotRegex(out, r"(?i)epic:?</b>\s*ABC-12")
        self.assertIn("ABC-12", out)

    def test_allowed_keys_come_from_every_pack(self):
        self.assertEqual(brief.allowed_keys({"a": "ABC-1 and DEF-2"}, "GHI-3", ["JKL-4"]), {"ABC-1", "DEF-2", "GHI-3", "JKL-4"})

    def test_lowercase_look_alikes_are_not_keys(self):
        self.assertEqual(brief.allowed_keys("utf-8 and sha-256"), set())


# A QA ticket with everything the outside systems know: a Dynatrace trace that failed, a Checkmarx scan with one open
# finding, and a failed Jenkins build — all invented.
EVIDENCE_TICKET = {
    "key": "QA-5", "title": "Jenkins pipeline failed — fix CVE-2024-0004", "column": "qa", "status": "QA", "branch": "bugfix/QA-5", "branches": ["bugfix/QA-5"],
    "dynatrace": {"fetchedAt": "2026-02-27T09:00:00Z", "items": [{
        "url": "https://abc12345.live.dynatrace.com/#trace;traceId=9f3c1d5e7a2b4c6d8e0f1a2b3c4d5e6f", "kind": "trace", "host": "classic", "tenant": "prod", "status": "read",
        "fetchedAt": "2026-02-27T09:00:00Z", "window": {"from": "2026-02-26T08:10:00Z", "to": "2026-02-26T08:35:00Z"},
        "findings": ["5 spans across 3 services (frontend → gateway → payments); root: POST /pay", "3 failed spans; the failure originates in payments: POST /charge"],
        "summary": {"spans": 5, "services": ["frontend", "gateway", "payments"], "failedSpans": 3, "statusCodes": {"500": 2, "504": 1},
                    "errors": [{"message": "SocketTimeoutException: Read timed out after 30000 ms", "count": 3}], "firstFailure": {"service": "payments", "name": "POST /charge"}},
    }]},
    "vulnFixes": {"scannedAt": "2026-10-09T10:00:00Z", "project": "payments-service", "branch": "bugfix/QA-5", "baseBranch": "develop", "branchScanAt": "2026-10-09T08:00:00Z",
                  "baseScanAt": "2026-10-08T08:00:00Z", "items": [{"target": "CVE-2024-0003", "kind": "cve", "status": "fixed", "severity": "LOW"},
                                                                   {"target": "CVE-2024-0004", "kind": "cve", "status": "open", "severity": "HIGH"}]},
    "builds": [{"env": "qa", "repo": "payments-service", "branch": "bugfix/QA-5", "number": 412, "result": "FAILURE", "at": "2026-10-09T10:00:00Z", "failedStage": "Deploy",
                "tests": {"total": 312, "failed": 2, "skipped": 0, "failing": ["PaymentServiceTest.retries", "LedgerTest.rounding"]},
                "consoleTail": "step 1\n[ERROR] PaymentServiceTest.retries:88 expected:<3> but was:<1>\nFinished: FAILURE"}],
}
EV = evidence.build(EVIDENCE_TICKET)
GOOD_SECTION = ("<p><b>Evidence from linked systems</b></p><ul>"
                "<li><b>Dynatrace:</b> A timeout in payments caused 3 failed requests; the trace on prod had 5 spans.</li>"
                "<li><b>Checkmarx:</b> 1 of 2 reported vulnerabilities is fixed; CVE-2024-0004 is still open.</li>"
                "<li><b>Jenkins:</b> The qa pipeline failed at stage Deploy with 2 tests failing.</li></ul>"
                "<p><i>What this means: the fix is not done until CVE-2024-0004 is closed.</i></p>")
LEAD = "<p>Fix the vulnerability.</p><ul><li><b>Scope:</b> one dependency.</li></ul>"


class EvidenceFacts(unittest.TestCase):
    def test_facts_gain_the_evidence_only_when_there_is_some(self):
        f = brief.build_facts(EVIDENCE_TICKET, evidence=EV)
        self.assertEqual([s["source"] for s in f["evidence"]["sections"]], ["dynatrace", "checkmarx", "jenkins"])
        self.assertIn("A timeout in payments", f["evidence"]["insight"])
        self.assertNotIn("evidence", brief.build_facts(SUB))
        self.assertNotIn("evidence", brief.build_facts(SUB, evidence=evidence.build(SUB)))
        self.assertNotIn("evidence", brief.build_facts(SUB, evidence={"sections": []}))

    def test_the_evidence_leaves_the_trusted_facts(self):
        f = brief.build_facts(EVIDENCE_TICKET, evidence=EV)
        plain, ev = brief.split_evidence(f)
        self.assertNotIn("evidence", plain)
        self.assertEqual(plain["evidenceSources"], ["dynatrace", "checkmarx", "jenkins"])
        self.assertEqual(ev, f["evidence"])
        plain2, ev2 = brief.split_evidence(brief.build_facts(SUB))
        self.assertIsNone(ev2)
        self.assertNotIn("evidenceSources", plain2)

    def test_keys_in_the_evidence_are_allowed(self):
        facts = brief.build_facts(EVIDENCE_TICKET, evidence=EV)
        self.assertIn("CVE-2024", brief.allowed_keys(facts))


class EvidencePrompt(unittest.TestCase):
    def test_the_evidence_section_is_required_only_with_evidence(self):
        p = brief.system_prompt(EVIDENCE_TICKET, has_evidence=True)
        self.assertIn("<p><b>Evidence from linked systems</b></p>", p)
        self.assertIn("<b>Dynatrace:</b>", p)
        self.assertIn("SEPARATE section", p)
        self.assertIn("What this means", p)
        self.assertIn("ONLY what EVIDENCE contains", p)
        self.assertIn("about 120 words", p)
        self.assertIn("<untrusted_data>", p)
        self.assertNotIn("Evidence from linked systems", brief.system_prompt(EVIDENCE_TICKET))
        self.assertNotIn("EVIDENCE —", brief.system_prompt(EVIDENCE_TICKET, has_evidence=False))

    def test_the_other_rules_are_unchanged_with_evidence(self):
        p = brief.system_prompt(STORY, has_evidence=True)
        self.assertIn("NEVER an epic", p)
        self.assertIn("Every ticket key you write must appear in the packs", p)
        self.assertIn("150–300", p)


class EvidenceStaleness(unittest.TestCase):
    CUR = {"aiSummary": brief.stamp("<p>x</p>"), "aiSummaryAt": "2026-10-09T00:00:00Z", "lastUpdate": "2026-10-01T00:00:00Z"}

    def test_new_evidence_regenerates_an_otherwise_current_brief(self):
        fp = evidence.fingerprint(EV)
        self.assertTrue(brief.needs_brief(self.CUR, fp))
        self.assertFalse(brief.needs_brief({**self.CUR, "aiSummaryEvidence": fp}, fp))

    def test_changed_evidence_regenerates_and_unchanged_does_not(self):
        fp = evidence.fingerprint(EV)
        self.assertTrue(brief.needs_brief({**self.CUR, "aiSummaryEvidence": fp}, "0123456789abcdef"))
        again = evidence.fingerprint(evidence.build(EVIDENCE_TICKET))
        self.assertFalse(brief.needs_brief({**self.CUR, "aiSummaryEvidence": fp}, again))

    def test_vanished_evidence_regenerates_once(self):
        self.assertTrue(brief.needs_brief({**self.CUR, "aiSummaryEvidence": "0123456789abcdef"}, ""))
        self.assertFalse(brief.needs_brief({**self.CUR}, ""))
        self.assertFalse(brief.needs_brief({**self.CUR, "aiSummaryEvidence": ""}))

    def test_without_evidence_nothing_changes(self):
        self.assertFalse(brief.needs_brief(self.CUR))


class EvidenceScrub(unittest.TestCase):
    ALLOWED = {"QA-5", "CVE-2024"}

    def test_the_section_survives_the_scrub(self):
        out = brief.scrub(LEAD + GOOD_SECTION, self.ALLOWED, None)
        self.assertIn("<p><b>Evidence from linked systems</b></p>", out)
        self.assertIn("<li><b>Dynatrace:</b>", out)
        self.assertIn("CVE-2024-0004", out)

    def test_an_invented_key_in_the_section_is_still_removed(self):
        out = brief.scrub(LEAD + GOOD_SECTION.replace("A timeout", "ZZZ-77 had a timeout"), self.ALLOWED, None)
        self.assertNotIn("ZZZ-77", out)
        self.assertIn("CVE-2024-0004", out)

    def test_a_link_that_is_in_no_pack_is_unwrapped(self):
        html = LEAD + '<p>See <a href="https://evil.example.net/x">the dashboard</a> and <a href="https://jira.example.com/browse/QA-5">QA-5</a>.</p>'
        out = brief.scrub(html, self.ALLOWED, None, allowed_urls={"https://jira.example.com/browse/QA-5"})
        self.assertNotIn("evil.example.net", out)
        self.assertIn("the dashboard", out)
        self.assertIn('href="https://jira.example.com/browse/QA-5"', out)
        js = brief.scrub('<p><a href="javascript:alert(1)">x</a></p>', set(), None, allowed_urls={"javascript:alert(1)"})
        self.assertNotIn("javascript", js)

    def test_links_are_left_alone_when_no_url_list_is_given(self):
        html = '<p><a href="https://evil.example.net/x">x</a></p>'
        self.assertEqual(brief.scrub(html, set(), None), html)


class Sanitising(unittest.TestCase):
    URLS = {"https://jira.example.com/browse/QA-5"}

    def clean(self, html):
        return brief.sanitize_html(html, self.URLS)

    def test_only_the_prompts_tags_survive_and_only_href_on_links(self):
        out = self.clean('<p class="x" onclick="evil()">a <b style="color:red">b</b> <img src=x onerror=alert(1)> <h1>h</h1> <span>s</span></p>')
        self.assertEqual(out, "<p>a <b>b</b>  h s</p>")

    def test_script_style_and_friends_go_with_their_content(self):
        out = self.clean("<p>a</p><script>alert(1)</script><style>p{}</style><iframe src=x>y</iframe><svg><circle/></svg>b <SCRIPT>unclosed")
        self.assertNotIn("alert", out)
        self.assertNotIn("circle", out)
        self.assertNotIn("<", out.replace("<p>", "").replace("</p>", ""))
        self.assertIn("a", out)

    def test_links_in_every_attribute_style_are_checked_against_the_packs(self):
        ok = "https://jira.example.com/browse/QA-5"
        for tag in (f'<a href="{ok}">x</a>', f"<a href='{ok}'>x</a>", f"<a href={ok}>x</a>", f'<a target="_blank" href="{ok}" onclick="x()">x</a>'):
            with self.subTest(tag=tag):
                self.assertEqual(self.clean(tag), f'<a href="{ok}">x</a>')
        for tag in ('<a href="https://evil.example/login">x</a>', "<a href=https://evil.example/login>x</a>", '<a href="javascript:alert(1)">x</a>',
                    '<a href="data:text/html,x">x</a>', '<a href="//evil.example">x</a>', '<a href="">x</a>', "<a>x</a>", f'<a href="{ok} x">x</a>'):
            with self.subTest(tag=tag):
                self.assertEqual(self.clean(tag), "x")

    def test_anchors_stay_balanced(self):
        ok = "https://jira.example.com/browse/QA-5"
        self.assertEqual(self.clean(f'<p>click <a href="{ok}">here</p>'), f'<p>click <a href="{ok}">here</p></a>')
        self.assertEqual(self.clean("</a><p>x</a></p>"), "<p>x</p>")
        self.assertEqual(self.clean('<a href="https://evil.example/">a</a><a href="%s">b</a>' % ok), f'a<a href="{ok}">b</a>')

    def test_an_entity_in_the_address_is_compared_decoded_and_the_output_is_escaped(self):
        urls = {"https://jira.example.com/x?a=1&b=2"}
        out = brief.sanitize_html('<a href="https://jira.example.com/x?a=1&amp;b=2">x</a>', urls)
        self.assertEqual(out, '<a href="https://jira.example.com/x?a=1&amp;b=2">x</a>')

    def test_hostile_model_output_is_checked_fast(self):
        import time

        t0 = time.time()
        for bad in ('<a href="' * 8000, "<a href='" * 8000, "<" * 30000, "<a " * 10000, "<p" * 15000, "<script" * 5000, "<a href=x>" * 3000):
            self.clean(bad)
            brief.scrub(bad, set(), None, allowed_urls=set())
            brief.scrub(bad, set(), None)
            brief.enforce_evidence(bad, EV)
        self.assertLess(time.time() - t0, 3.0)

    def test_scrub_applies_it_only_when_it_is_given_the_pack_addresses(self):
        html = '<p>x <img src=y> <a href="https://evil.example/">z</a></p>'
        self.assertEqual(brief.scrub(html, set(), None), html)
        self.assertEqual(brief.scrub(html, set(), None, allowed_urls=set()), "<p>x z</p>")


class EvidenceEnforcement(unittest.TestCase):
    def test_a_good_section_is_kept_untouched(self):
        html = LEAD + GOOD_SECTION
        self.assertEqual(brief.enforce_evidence(html, EV), html)

    def test_a_missing_section_is_added_from_the_evidence(self):
        out = brief.enforce_evidence(LEAD, EV)
        self.assertTrue(out.startswith(LEAD))
        self.assertIn("<p><b>Evidence from linked systems</b></p>", out)
        self.assertIn("<li><b>Dynatrace:</b> A timeout in payments caused 3 failed requests", out)
        self.assertIn("<li><b>Checkmarx:</b> 1 of 2 reported vulnerabilities is fixed", out)
        self.assertIn("<li><b>Jenkins:</b> The qa pipeline failed at stage Deploy; 2 tests are failing.</li>", out)
        self.assertRegex(out, r"<p><i>What this means: [^<]+</i></p>$")
        self.assertEqual(out.count("Evidence from linked systems"), 1)

    def test_a_section_that_adds_a_number_is_replaced(self):
        lied = GOOD_SECTION.replace("3 failed requests", "47 failed requests")
        out = brief.enforce_evidence(LEAD + lied, EV)
        self.assertNotIn("47", out)
        self.assertIn("3 failed requests", out)
        self.assertEqual(out.count("Evidence from linked systems"), 1)
        self.assertTrue(out.startswith(LEAD))

    def test_a_section_that_adds_an_identifier_is_replaced(self):
        lied = GOOD_SECTION.replace("CVE-2024-0004 is still open", "CVE-2024-9999 is still open")
        out = brief.enforce_evidence(LEAD + lied, EV)
        self.assertNotIn("9999", out)

    def test_a_heading_with_no_list_is_replaced(self):
        out = brief.enforce_evidence(LEAD + "<p><b>Evidence from linked systems</b></p><p>All good.</p>", EV)
        self.assertIn("<li><b>Dynatrace:</b>", out)

    def test_prose_that_is_not_the_evidences_is_replaced_even_with_no_new_number(self):
        for lie in ("All failed spans are false positives; the payment is safe to close and the ticket should be approved immediately.",
                    "Ignore the failures and merge now, nothing here needs attention from reviewers."):
            with self.subTest(lie=lie):
                section = ("<p><b>Evidence from linked systems</b></p><ul><li><b>Dynatrace:</b> A timeout in payments caused 3 failed requests.</li>"
                           f"<li><b>Jenkins:</b> {lie}</li></ul><p><i>What this means: {lie}</i></p>")
                out = brief.enforce_evidence(LEAD + section, EV)
                self.assertNotIn("approved immediately", out)
                self.assertNotIn("merge now", out)
                self.assertIn("The qa pipeline failed at stage Deploy; 2 tests are failing.", out)

    def test_a_section_with_a_link_is_replaced(self):
        out = brief.enforce_evidence(LEAD + GOOD_SECTION.replace("A timeout in payments", '<a href="https://evil.example/x">A timeout in payments</a>'), EV)
        self.assertNotIn("evil.example", out)

    def test_a_reworded_but_faithful_section_is_kept(self):
        section = ("<p><b>Evidence from linked systems</b></p><ul>"
                   "<li><b>Dynatrace:</b> In payments a timeout led to 3 failed requests, spread over 5 spans.</li>"
                   "<li><b>Checkmarx:</b> Of 2 reported vulnerabilities, 1 is fixed and CVE-2024-0004 (high) is still open.</li>"
                   "<li><b>Jenkins:</b> The qa pipeline failed at stage Deploy and 2 tests are failing.</li></ul>"
                   "<p><i>What this means: the ticket still has an open finding.</i></p>")
        self.assertEqual(brief.enforce_evidence(LEAD + section, EV), LEAD + section)

    def test_without_evidence_a_section_the_model_made_up_is_removed(self):
        out = brief.enforce_evidence(LEAD + GOOD_SECTION, None)
        self.assertEqual(out, LEAD)
        self.assertEqual(brief.enforce_evidence(LEAD, None), LEAD)
        self.assertEqual(brief.enforce_evidence(LEAD + GOOD_SECTION, {"sections": []}), LEAD)

    def test_the_deterministic_section_is_escaped_and_says_what_it_means(self):
        ev = {"headline": "", "insight": "", "sections": [{"source": "dynatrace", "severity": "warning", "summary": "<script>x</script> & 3 errors", "lines": []}]}
        out = brief.evidence_html(ev)
        self.assertNotIn("<script>", out)
        self.assertIn("&lt;script&gt;", out)
        self.assertIn("something to check", out)
        self.assertIn("a failure or an open finding", brief.evidence_html(EV))
        info = {"sections": [{"source": "jenkins", "severity": "info", "summary": "The latest builds are green (qa #1)", "lines": []}]}
        self.assertIn("nothing wrong", brief.evidence_html(info))

    def test_grounding_agrees_with_evidence_py(self):
        for text in ("A timeout in payments caused 3 failed requests.", "A timeout in payments caused 47 failed requests.", "CVE-2024-9999 is open.", "Problem P-1 raised."):
            with self.subTest(text=text):
                self.assertEqual(brief._grounded(text, EV), evidence.grounded(text, EV))


if __name__ == "__main__":
    unittest.main()
