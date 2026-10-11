#!/usr/bin/env python3
"""Jenkins console excerpt: the last ~40 lines (at most 4 KB) of the console of the latest FAILED build of a ticket that is
about a build / pipeline failure — scrubbed, bounded, read from the configured build URL only, never the whole log.

Every Jenkins answer is mocked: `jenkins._read_tail` and `jenkins.get_json` are the network seams."""
import copy
import io
import os
import sys
import unittest
import urllib.error
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "jira-intern"))
import daily_fetch  # noqa: E402
import jenkins  # noqa: E402

JOB = "https://jenkins.example.com/job/team/job/payments-service-qa/"
BRANCH = "feature/PAY-1_retry"
BUILD_URL = f"{JOB}job/feature%252FPAY-1_retry/412/"
LOG = "\n".join([f"[Pipeline] step {i}" for i in range(60)]
                + ["Authorization: Bearer abc123def456ghi789", "git clone https://deploy:p4ssw0rd@git.example.com/org/repo.git",
                   "[ERROR] Tests run: 12, Failures: 2", "[ERROR] PaymentServiceTest.retries:88 expected:<3> but was:<1>",
                   "Finished: FAILURE", ""])


def http_error(code, url="https://x"):
    return urllib.error.HTTPError(url, code, "x", {}, io.BytesIO(b""))


def build(number=412, result="FAILURE", at="2026-10-09T10:00:00Z", **kw):
    b = {"env": "qa", "repo": "payments-service", "branch": BRANCH, "number": number, "result": result, "url": f"{BUILD_URL[:-4]}{number}/", "at": at,
         "durationMs": 252000, "deployTarget": "qa", "failedStage": "Test"}
    b.update(kw)
    return b


def ticket(**kw):
    t = {"key": "PAY-9", "title": "Jenkins pipeline failed on QA for payments-service", "type": "Bug", "labels": [], "description": "", "branch": BRANCH,
         "branches": [BRANCH], "prs": [], "pr": {"state": "none"}}
    t.update(kw)
    return t


class Classifier(unittest.TestCase):
    def test_tickets_about_a_failing_build_or_pipeline(self):
        for title in ("Jenkins pipeline failed on QA", "Build failed for payments-service", "Deployment failure to UAT", "CI is red on main",
                      "Pipeline is failing after the Java 21 bump", "Deploy job broken in stage", "Fix failing build in release/1.2", "Jenkins job aborted",
                      "Build broken since Friday", "UAT deploy failed again", "QA pipeline unstable"):
            with self.subTest(title=title):
                self.assertTrue(jenkins.is_build_failure({"title": title}), title)

    def test_tickets_that_merely_mention_builds_or_pipelines(self):
        for title in ("Add data pipeline for ledger export", "Speed up the Maven build", "Improve build time of the web app", "Release pipeline documentation",
                      "Add retry to the payment job", "Refactor the deployment guide", "Upgrade Jenkins credentials plugin docs"):
            with self.subTest(title=title):
                self.assertFalse(jenkins.is_build_failure({"title": title}), title)

    def test_labels_and_the_description_count(self):
        self.assertTrue(jenkins.is_build_failure({"title": "Payments", "labels": ["build-failure"]}))
        self.assertTrue(jenkins.is_build_failure({"title": "Payments", "description": "<p>The QA pipeline failed at the Deploy stage.</p>"}))
        self.assertTrue(jenkins.is_build_failure({"title": "Payments", "labels": ["jenkins-failure"]}))
        self.assertFalse(jenkins.is_build_failure({"title": "Payments", "labels": ["jenkins"]}))

    def test_comments_do_not_classify(self):
        self.assertFalse(jenkins.is_build_failure({"title": "Payments", "comments": [{"body": "the build failed once last week"}]}))

    def test_empty(self):
        self.assertFalse(jenkins.is_build_failure({}))
        self.assertFalse(jenkins.is_build_failure(None))


class Base(unittest.TestCase):
    def setUp(self):
        jenkins.reset_run()
        p = mock.patch.dict(os.environ, {"JENKINS_USER": "builder", "JENKINS_API_TOKEN": "tok-123"})
        p.start()
        self.addCleanup(p.stop)
        err = mock.patch.object(sys, "stderr", io.StringIO())
        err.start()
        self.addCleanup(err.stop)
        self.calls = []

    def serve(self, body=LOG, status=200, complete=True, error=None):
        def fake(url, headers, timeout, keep=jenkins.CONSOLE_KEEP_BYTES, cap=jenkins.CONSOLE_READ_CAP):
            self.calls.append((url, dict(headers)))
            if error:
                raise error
            return status, body.encode("utf-8")[-keep:], complete

        p = mock.patch.object(jenkins, "_read_tail", fake)
        p.start()
        self.addCleanup(p.stop)


class Fetch(Base):
    def test_the_tail_is_the_last_lines_and_is_scrubbed(self):
        self.serve()
        tail = jenkins.console_tail(BUILD_URL)
        lines = tail.splitlines()
        self.assertLessEqual(len(lines), jenkins.CONSOLE_LINES)
        self.assertLessEqual(len(tail), jenkins.CONSOLE_BYTES)
        self.assertEqual(lines[-1], "Finished: FAILURE")
        self.assertIn("[ERROR] PaymentServiceTest.retries:88 expected:<3> but was:<1>", tail)
        for secret in ("abc123def456ghi789", "p4ssw0rd", "tok-123"):
            self.assertNotIn(secret, tail)
        self.assertIn("Authorization: •••", tail)
        self.assertIn("https://•••@git.example.com", tail)

    def test_only_the_configured_build_url_is_asked_with_a_range_and_basic_auth(self):
        self.serve()
        jenkins.console_tail(BUILD_URL)
        url, headers = self.calls[0]
        self.assertEqual(url, BUILD_URL + "consoleText")
        self.assertTrue(headers["Range"].startswith("bytes=-"))
        self.assertTrue(headers["Authorization"].startswith("Basic "))
        self.assertNotIn("tok-123", url)

    def test_http_build_urls_are_refused(self):
        self.serve()
        self.assertIsNone(jenkins.console_tail(BUILD_URL.replace("https://", "http://")))
        self.assertEqual(self.calls, [])

    def test_a_log_too_long_to_reach_the_end_of_is_final_not_retried(self):
        self.serve(complete=False)
        self.assertEqual(jenkins.console_tail(BUILD_URL), "")

    def test_a_ranged_answer_is_used_as_it_is(self):
        self.serve(body="tail of a long log\nFinished: FAILURE\n", status=206, complete=True)
        self.assertEqual(jenkins.console_tail(BUILD_URL), "tail of a long log\nFinished: FAILURE")

    def test_404_is_no_log_and_not_a_failure(self):
        self.serve(error=http_error(404))
        self.assertEqual(jenkins.console_tail(BUILD_URL), "")
        self.assertEqual(jenkins.hosts_down(), [])

    def test_401_and_a_network_failure_stop_further_calls_this_run(self):
        self.serve(error=http_error(401))
        self.assertIsNone(jenkins.console_tail(BUILD_URL))
        self.assertEqual(jenkins.hosts_down(), ["jenkins.example.com"])
        n = len(self.calls)
        self.assertIsNone(jenkins.console_tail(BUILD_URL))
        self.assertEqual(len(self.calls), n)

    def test_not_configured_asks_nothing(self):
        self.serve()
        with mock.patch.dict(os.environ, {"JENKINS_API_TOKEN": ""}):
            self.assertIsNone(jenkins.console_tail(BUILD_URL))
        self.assertEqual(self.calls, [])

    def test_the_per_run_cap(self):
        self.serve()
        with mock.patch.object(jenkins, "MAX_TAILS_PER_RUN", 2):
            got = [jenkins.console_tail(BUILD_URL.replace("412", str(n))) for n in (1, 2, 3)]
        self.assertEqual([bool(g) for g in got], [True, True, False])

    def test_the_call_budget_is_shared_with_the_other_jenkins_calls(self):
        self.serve()
        with mock.patch.object(jenkins, "MAX_CALLS_PER_RUN", 0):
            self.assertIsNone(jenkins.console_tail(BUILD_URL))


class Attach(Base):
    def targets(self):
        return [("payments-service", "qa", JOB, BRANCH)]

    def test_only_the_latest_failed_build_of_a_build_failure_ticket_gets_one(self):
        self.serve()
        builds = [build(412, "FAILURE", "2026-10-09T10:00:00Z"), build(411, "FAILURE", "2026-10-08T10:00:00Z", env="uat"),
                  build(400, "SUCCESS", "2026-10-09T11:00:00Z", env="stage")]
        out = jenkins.add_console_tails(ticket(), builds, [("payments-service", "qa", JOB, BRANCH), ("payments-service", "uat", JOB, BRANCH), ("payments-service", "stage", JOB, BRANCH)], [])
        self.assertIn("Finished: FAILURE", out[0]["consoleTail"])
        self.assertNotIn("consoleTail", out[1])
        self.assertNotIn("consoleTail", out[2])
        self.assertEqual(len(self.calls), 1)

    def test_an_unstable_build_counts_and_a_building_or_stale_one_does_not(self):
        self.serve()
        out = jenkins.add_console_tails(ticket(), [build(5, "UNSTABLE")], self.targets(), [])
        self.assertIn("consoleTail", out[0])
        self.calls.clear()
        out = jenkins.add_console_tails(ticket(), [build(6, "BUILDING"), build(7, "FAILURE", stale=True)], self.targets(), [])
        self.assertEqual(self.calls, [])
        self.assertNotIn("consoleTail", out[0])

    def test_a_ticket_not_about_a_build_failure_gets_none_and_loses_an_old_one(self):
        self.serve()
        plain = ticket(title="Add retry to the payment job")
        out = jenkins.add_console_tails(plain, [build(412, consoleTail="old")], self.targets(), [])
        self.assertNotIn("consoleTail", out[0])
        self.assertEqual(self.calls, [])

    def test_the_same_failed_build_keeps_its_tail_without_asking_again(self):
        self.serve()
        prior = [build(412, consoleTail="kept tail")]
        out = jenkins.add_console_tails(ticket(), [build(412)], self.targets(), prior)
        self.assertEqual(out[0]["consoleTail"], "kept tail")
        self.assertEqual(self.calls, [])

    def test_a_kept_tail_goes_through_the_current_scrubber_again(self):
        self.serve()
        prior = [build(412, consoleTail="ok line\nAuthorization: Bearer abc123def456ghi789\npassword=hunter2hunter2")]
        out = jenkins.add_console_tails(ticket(), [build(412)], self.targets(), prior)
        self.assertNotIn("abc123def456ghi789", out[0]["consoleTail"])
        self.assertNotIn("hunter2hunter2", out[0]["consoleTail"])
        self.assertIn("ok line", out[0]["consoleTail"])
        self.assertEqual(self.calls, [])

    def test_a_newer_failed_build_replaces_it(self):
        self.serve()
        prior = [build(412, consoleTail="kept tail")]
        out = jenkins.add_console_tails(ticket(), [build(413)], self.targets(), prior)
        self.assertIn("Finished: FAILURE", out[0]["consoleTail"])
        self.assertEqual(self.calls[0][0], BUILD_URL.replace("412", "413") + "consoleText")

    def test_a_build_carried_forward_stale_keeps_what_it_had(self):
        self.serve()
        out = jenkins.add_console_tails(ticket(), [build(412, stale=True, consoleTail="kept tail")], self.targets(), [])
        self.assertEqual(out[0]["consoleTail"], "kept tail")
        self.assertEqual(self.calls, [])

    def test_a_failed_read_leaves_the_build_without_a_tail_so_the_next_run_tries_again(self):
        self.serve(error=http_error(500))
        out = jenkins.add_console_tails(ticket(), [build(412)], self.targets(), [])
        self.assertNotIn("consoleTail", out[0])

    def test_a_log_that_cannot_be_excerpted_is_recorded_and_not_asked_again(self):
        self.serve(complete=False)
        out = jenkins.add_console_tails(ticket(), [build(412)], self.targets(), [])
        self.assertEqual(out[0]["consoleTail"], "")
        n = len(self.calls)
        again = jenkins.add_console_tails(ticket(), [build(412)], self.targets(), out)
        self.assertEqual(again[0]["consoleTail"], "")
        self.assertEqual(len(self.calls), n)

    def test_a_transient_failure_is_not_recorded(self):
        self.serve(error=urllib.error.URLError(OSError("down")))
        out = jenkins.add_console_tails(ticket(), [build(412)], self.targets(), [])
        self.assertNotIn("consoleTail", out[0])

    def test_the_url_comes_from_the_configured_job_never_from_the_build_record(self):
        self.serve()
        evil = build(412, url="https://evil.example.net/steal/412/")
        jenkins.add_console_tails(ticket(), [evil], self.targets(), [])
        self.assertTrue(self.calls[0][0].startswith(JOB))

    def test_a_parameterised_pipeline_reads_the_job_url_with_the_number(self):
        self.serve()
        t = {"repo": "payments-service", "env": "qa", "url": JOB, "branch": BRANCH, "pipeline": "qa-deploy", "kind": "deploy", "via": "parameter",
             "param": "BRANCH", "envParam": None, "envFrom": None}
        jenkins.add_console_tails(ticket(), [build(77, pipeline="qa-deploy", via="parameter")], [t], [])
        self.assertEqual(self.calls[0][0], f"{JOB}77/consoleText")


class DailyFetch(Base):
    def test_apply_builds_stores_the_tail_and_the_fast_path_keeps_it_without_a_call(self):
        self.serve()
        raw = {"number": 412, "result": "FAILURE", "building": False, "timestamp": 1791712800000, "duration": 252000,
               "url": f"{BUILD_URL}", "actions": []}

        def get_json(url, headers, timeout, retries=1):
            if "lastBuild/api/json" in url:
                return copy.deepcopy(raw)
            raise http_error(404, url)

        with mock.patch.object(jenkins, "get_json", get_json), mock.patch.object(jenkins, "jobs_config", lambda cfg=None: {"payments-service": [("qa", JOB)]}), \
                mock.patch.object(jenkins, "discovery_for", lambda slugs, cfg=None, use_cache=True: ({}, set())), \
                mock.patch.dict(daily_fetch.DEV, {"PAY-9": {"repos": {BRANCH: "payments-service"}}}, clear=False):
            t = ticket()
            daily_fetch.apply_builds(t, "PAY-9", {})
            self.assertEqual(t["builds"][0]["result"], "FAILURE")
            self.assertIn("Finished: FAILURE", t["builds"][0]["consoleTail"])
            calls = len(self.calls)
            jenkins.reset_run()
            again = copy.deepcopy(t)
            daily_fetch.apply_builds(again, "PAY-9")
            self.assertEqual(again["builds"][0]["consoleTail"], t["builds"][0]["consoleTail"])
            self.assertEqual(len(self.calls), calls)


if __name__ == "__main__":
    unittest.main()
