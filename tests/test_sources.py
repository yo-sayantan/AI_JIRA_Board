#!/usr/bin/env python3
"""_sources.py — what each outside proof source did in a fetch run, instead of a silent skip.

Pure bookkeeping: tickets are reported as skipped / looked up / waiting, `finish` turns that into one
state + one human line ("Checkmarx: 3 vulnerability-fix tickets looked up — 2 with open findings")."""
import os
import sys
import threading
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "jira-intern"))
import _sources  # noqa: E402

NOUN = "vulnerability-fix ticket"


def finish(**kw):
    return _sources.finish("checkmarx", "Checkmarx", NOUN, **kw)


class Run(unittest.TestCase):
    def setUp(self):
        _sources.reset("checkmarx")

    def test_states_are_the_documented_vocabulary(self):
        self.assertEqual(_sources.STATES, ("not-configured", "no-candidates", "read", "unreachable", "auth-failed", "budget-exhausted"))

    def test_nothing_to_look_up_when_configured(self):
        st = finish()
        self.assertEqual(st["state"], "no-candidates")
        self.assertEqual(st["detail"], "Checkmarx: no vulnerability-fix ticket to look up")
        self.assertTrue(_sources.noteworthy(st))  # a configured source that did nothing says so

    def test_skipped_tickets_explain_why_nothing_was_looked_up(self):
        _sources.skipped("checkmarx", "PAY-1", "no-plan")
        _sources.skipped("checkmarx", "PAY-2", "no-targets")
        _sources.skipped("checkmarx", "PAY-3", "no-plan")
        st = finish()
        self.assertEqual(st["state"], "no-candidates")
        self.assertIn("3 vulnerability-fix tickets skipped", st["detail"])
        self.assertIn("2 without a pull request or known branch", st["detail"])
        self.assertIn("1 naming no CVE, query, CWE, result or package", st["detail"])

    def test_not_configured_says_which_settings_are_missing(self):
        st = finish(gap="CHECKMARX_BASE_URL, CHECKMARX_API_KEY")
        self.assertEqual(st["state"], "not-configured")
        self.assertIn("missing CHECKMARX_BASE_URL, CHECKMARX_API_KEY", st["detail"])
        self.assertFalse(_sources.noteworthy(st))  # nobody waiting: no noise for someone who does not use Checkmarx

    def test_not_configured_with_tickets_waiting_is_noteworthy_and_lists_them(self):
        _sources.waiting("checkmarx", "PAY-7", "not-configured")
        _sources.waiting("checkmarx", "PAY-8", "not-configured")
        st = finish(gap="CHECKMARX_API_KEY")
        self.assertEqual(st["state"], "not-configured")
        self.assertIn("2 vulnerability-fix tickets are waiting", st["detail"])
        self.assertEqual(st["waiting"], ["PAY-7", "PAY-8"])
        self.assertTrue(_sources.noteworthy(st))

    def test_read_counts_tickets_targets_and_the_ones_with_open_findings(self):
        _sources.looked("checkmarx", "PAY-1", ["fixed", "open", "open"])
        _sources.looked("checkmarx", "PAY-2", ["fixed", "not-found"])
        _sources.looked("checkmarx", "PAY-3", ["fixed"])
        st = finish()
        self.assertEqual(st["state"], "read")
        self.assertEqual(st["looked"], 3)
        self.assertEqual(st["counts"], {"fixed": 3, "open": 2, "not-found": 1, "unknown": 0})
        self.assertEqual(st["detail"], "Checkmarx: 3 vulnerability-fix tickets looked up (6 targets: 3 fixed · 2 open · 1 not found) — 1 with open findings")

    def test_one_ticket_is_singular_and_a_clean_read_says_so(self):
        _sources.looked("checkmarx", "PAY-1", ["fixed"])
        st = finish()
        self.assertEqual(st["detail"], "Checkmarx: 1 vulnerability-fix ticket looked up (1 target: 1 fixed) — none with open findings")

    def test_skipped_tickets_are_added_to_a_read(self):
        _sources.looked("checkmarx", "PAY-1", ["fixed"])
        _sources.skipped("checkmarx", "PAY-2", "no-plan")
        self.assertIn("1 skipped (1 without a pull request or known branch)", finish()["detail"])

    def test_a_failure_wins_and_says_the_results_were_carried_forward(self):
        _sources.looked("checkmarx", "PAY-1", ["fixed"])
        _sources.waiting("checkmarx", "PAY-2", "auth-failed", "the API key was rejected (HTTP 401)")
        _sources.waiting("checkmarx", "PAY-3", "auth-failed", "the API key was rejected (HTTP 401)")
        st = finish()
        self.assertEqual(st["state"], "auth-failed")
        self.assertEqual(st["waiting"], ["PAY-2", "PAY-3"])
        self.assertIn("1 vulnerability-fix ticket looked up", st["detail"])
        self.assertIn("2 carried forward", st["detail"])
        self.assertIn("the API key was rejected (HTTP 401)", st["detail"])

    def test_unreachable_and_budget_states(self):
        _sources.waiting("checkmarx", "PAY-2", "unreachable", "host could not be reached")
        self.assertEqual(finish()["state"], "unreachable")
        _sources.reset("checkmarx")
        _sources.waiting("checkmarx", "PAY-2", "budget-exhausted", "the 300-call budget for one fetch was used up")
        st = finish()
        self.assertEqual(st["state"], "budget-exhausted")
        self.assertIn("300-call budget", st["detail"])

    def test_an_unknown_state_is_refused_not_stored(self):
        with self.assertRaises(ValueError):
            _sources.waiting("checkmarx", "PAY-2", "banana")

    def test_the_record_is_json_with_an_iso_stamp_and_no_sets(self):
        import json
        _sources.looked("checkmarx", "PAY-1", ["open"])
        st = finish()
        json.dumps(st)
        self.assertRegex(st["at"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")

    def test_reset_forgets_one_source_only(self):
        _sources.looked("checkmarx", "PAY-1", ["open"])
        _sources.looked("jenkins", "PAY-1", ["ok"])
        _sources.reset("checkmarx")
        self.assertEqual(finish()["state"], "no-candidates")
        self.assertEqual(_sources.finish("jenkins", "Jenkins", "ticket")["state"], "read")
        _sources.reset("jenkins")

    def test_waiting_keys_are_capped(self):
        for i in range(60):
            _sources.waiting("checkmarx", f"PAY-{i}", "unreachable", "x")
        self.assertEqual(len(finish()["waiting"]), _sources.MAX_KEYS)

    def test_reporting_is_thread_safe(self):
        def work(n):
            for i in range(50):
                _sources.looked("checkmarx", f"PAY-{n}-{i}", ["fixed"])

        threads = [threading.Thread(target=work, args=(n,)) for n in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(finish()["looked"], 400)

    def test_no_secret_shaped_text_reaches_the_record(self):
        _sources.waiting("checkmarx", "PAY-2", "unreachable", "https://tenant.example/api?token=abc123abc123abc123 failed Bearer abcdefgh12345678")
        st = finish()
        self.assertNotRegex(st["detail"], r"abc123abc123|abcdefgh12345678|\?token")


if __name__ == "__main__":
    unittest.main()
