#!/usr/bin/env python3
"""Jenkins multibranch builds: branch-job addressing, lastBuild parsing, carry-forward on failure,
how the daily fetch stores them and how the PR readiness report's CI gate reads them.

Every Jenkins answer here is recorded/mocked JSON — nothing touches the network."""
import copy
import io
import json
import os
import sys
import unittest
import urllib.error
from datetime import datetime, timedelta, timezone
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "jira-intern"))
import daily_fetch  # noqa: E402
import jenkins  # noqa: E402
import pr_report  # noqa: E402

JOB_QA = "https://jenkins.example.com/job/team/job/payments-service-qa/"
JOB_UAT = "https://jenkins.example.com/job/team/job/payments-service-uat/"
JOBS = {"payments-service": [("qa", JOB_QA), ("uat", JOB_UAT)]}
BRANCH = "feature/PAY-1_retry"
SEG = "feature%252FPAY-1_retry"


def http_error(url, code):
    return urllib.error.HTTPError(url, code, "x", {}, io.BytesIO(b""))


def last_build(number=412, result="SUCCESS", building=False, total=312, failed=0, skipped=4, params=None):
    actions = [{"_class": "hudson.model.CauseAction"}, {}]
    if total is not None:
        actions.append({"_class": "hudson.tasks.junit.TestResultAction", "failCount": failed, "skipCount": skipped,
                        "totalCount": total, "urlName": "testReport"})
    if params:
        actions.append({"_class": "hudson.model.ParametersAction", "parameters": [{"name": k, "value": v} for k, v in params.items()]})
    return {
        "_class": "org.jenkinsci.plugins.workflow.job.WorkflowRun",
        "number": number, "result": None if building else result, "building": building,
        "timestamp": 1791712800000, "duration": 0 if building else 252000,
        "url": f"{JOB_QA}job/{SEG}/{number}/", "displayName": f"#{number}", "description": None, "actions": actions,
    }


class FakeJenkins:
    """URL → JSON (or an exception) for jenkins.get_json; records every call and its headers."""

    def __init__(self, routes):
        self.routes = routes
        self.calls = []

    def __call__(self, url, headers, timeout, retries=4):
        self.calls.append((url, headers))
        for prefix, answer in self.routes.items():
            if url.startswith(prefix):
                if isinstance(answer, Exception):
                    raise answer
                if isinstance(answer, int):
                    raise http_error(url, answer)
                return copy.deepcopy(answer)
        raise http_error(url, 404)


class Base(unittest.TestCase):
    def setUp(self):
        jenkins.reset_run()
        p = mock.patch.dict(os.environ, {"JENKINS_USER": "builder", "JENKINS_API_TOKEN": "tok-123"})
        p.start()
        self.addCleanup(p.stop)
        err = mock.patch.object(sys, "stderr", io.StringIO())
        self.stderr = err.start()
        self.addCleanup(err.stop)

    def fake(self, routes):
        f = FakeJenkins(routes)
        p = mock.patch.object(jenkins, "get_json", f)
        p.start()
        self.addCleanup(p.stop)
        return f


class Addressing(unittest.TestCase):
    def test_a_slash_is_encoded_in_the_item_name_and_again_in_the_url(self):
        self.assertEqual(jenkins.item_name("feature/ABC-1"), "feature%2FABC-1")
        self.assertEqual(jenkins.branch_segment("feature/ABC-1"), "feature%252FABC-1")

    def test_a_plain_branch_is_left_alone(self):
        self.assertEqual(jenkins.branch_segment("develop"), "develop")
        self.assertEqual(jenkins.branch_segment("release-1.2_x"), "release-1.2_x")

    def test_percent_and_other_unsafe_characters(self):
        self.assertEqual(jenkins.item_name("a%b"), "a%25b")
        self.assertEqual(jenkins.branch_segment("a%b"), "a%2525b")
        self.assertEqual(jenkins.item_name("fix:x?y#z"), "fix%3Ax%3Fy%23z")
        self.assertEqual(jenkins.item_name("."), "%2E")
        self.assertEqual(jenkins.item_name(".."), "%2E%2E")

    def test_non_ascii_survives_as_utf8(self):
        self.assertEqual(jenkins.branch_segment("feature/é"), "feature%252F%C3%A9")

    def test_branch_job_url(self):
        self.assertEqual(jenkins.branch_job_url(JOB_QA, BRANCH), f"{JOB_QA}job/{SEG}/")
        self.assertEqual(jenkins.branch_job_url(JOB_QA.rstrip("/"), "develop"), f"{JOB_QA}job/develop/")


class Config(unittest.TestCase):
    def test_jobs_keep_config_order_and_drop_bad_urls(self):
        cfg = {"jenkins": {"jobs": {
            "payments-service": {"qa": JOB_QA, "uat": JOB_UAT, "bad": "ftp://x", "empty": ""},
            "web": {"qa": " https://jenkins.example.com/job/web-qa "},
            "nothing": {},
        }}}
        jobs = jenkins.jobs_config(cfg)
        self.assertEqual(list(jobs), ["payments-service", "web"])
        self.assertEqual(jobs["payments-service"], [("qa", JOB_QA), ("uat", JOB_UAT)])
        self.assertEqual(jobs["web"], [("qa", "https://jenkins.example.com/job/web-qa/")])

    def test_empty_or_missing_section(self):
        self.assertEqual(jenkins.jobs_config({}), {})
        self.assertEqual(jenkins.jobs_config({"jenkins": {"jobs": {}}}), {})

    def test_the_tracked_config_ships_empty(self):
        with open(os.path.join(ROOT, "config", "jira-board.config.json"), encoding="utf-8") as f:
            self.assertEqual(json.load(f)["jenkins"], {"jobs": {}})

    def test_enabled_needs_jobs_and_both_secrets(self):
        with mock.patch.dict(os.environ, {"JENKINS_USER": "u", "JENKINS_API_TOKEN": "t"}):
            self.assertTrue(jenkins.enabled(JOBS))
            self.assertFalse(jenkins.enabled({}))
        with mock.patch.dict(os.environ, {"JENKINS_USER": "u", "JENKINS_API_TOKEN": ""}):
            self.assertFalse(jenkins.enabled(JOBS))


class ParseBuild(unittest.TestCase):
    def test_success_with_tests(self):
        b = jenkins.parse_build(last_build(), "qa", "payments-service", BRANCH)
        self.assertEqual(b["env"], "qa")
        self.assertEqual(b["repo"], "payments-service")
        self.assertEqual(b["branch"], BRANCH)
        self.assertEqual(b["number"], 412)
        self.assertEqual(b["result"], "SUCCESS")
        self.assertEqual(b["at"], "2026-10-11T10:00:00Z")
        self.assertEqual(b["durationMs"], 252000)
        self.assertEqual(b["tests"], {"total": 312, "failed": 0, "skipped": 4})
        self.assertEqual(b["deployTarget"], "qa")
        self.assertNotIn("failedStage", b)

    def test_building_has_no_result_or_duration_yet(self):
        b = jenkins.parse_build(last_build(building=True, total=None), "qa", "payments-service", BRANCH)
        self.assertEqual(b["result"], "BUILDING")
        self.assertIsNone(b["durationMs"])
        self.assertNotIn("tests", b)

    def test_unknown_or_missing_result_is_not_built(self):
        self.assertEqual(jenkins.parse_build({**last_build(), "result": None}, "qa", "r", "b")["result"], "NOT_BUILT")
        self.assertEqual(jenkins.parse_build({**last_build(), "result": "WEIRD"}, "qa", "r", "b")["result"], "NOT_BUILT")
        self.assertEqual(jenkins.parse_build({**last_build(), "result": "aborted"}, "qa", "r", "b")["result"], "ABORTED")

    def test_deploy_target_from_a_build_parameter(self):
        b = jenkins.parse_build(last_build(params={"ENVIRONMENT": "qa-eu", "OTHER": "x"}), "qa", "r", "b")
        self.assertEqual(b["deployTarget"], "qa-eu")
        b = jenkins.parse_build(last_build(params={"deploy_env": "qa2", "ENV": "qa3"}), "qa", "r", "b")
        self.assertEqual(b["deployTarget"], "qa2")  # DEPLOY_ENV outranks ENV
        b = jenkins.parse_build(last_build(params={"TARGET": ""}), "qa", "r", "b")
        self.assertEqual(b["deployTarget"], "qa")

    def test_a_non_http_url_is_dropped(self):
        b = jenkins.parse_build({**last_build(), "url": "javascript:alert(1)"}, "qa", "r", "b")
        self.assertIsNone(b["url"])


class LatestBuild(Base):
    def test_success(self):
        f = self.fake({f"{JOB_QA}job/{SEG}/lastBuild/api/json": last_build()})
        status, b = jenkins.latest_build(JOB_QA, "qa", "payments-service", BRANCH)
        self.assertEqual(status, jenkins.OK)
        self.assertEqual(b["number"], 412)
        self.assertEqual(len(f.calls), 1)  # no test report, no stage view for a green build

    def test_basic_auth_header_and_never_the_token_in_the_url(self):
        f = self.fake({f"{JOB_QA}job/{SEG}/lastBuild/api/json": last_build()})
        jenkins.latest_build(JOB_QA, "qa", "payments-service", BRANCH)
        url, headers = f.calls[0]
        self.assertEqual(headers["Authorization"], "Basic YnVpbGRlcjp0b2stMTIz")
        self.assertNotIn("tok-123", url)
        self.assertIn("tree=", url)

    def test_a_missing_branch_job_is_no_build_not_an_error(self):
        self.fake({})
        self.assertEqual(jenkins.latest_build(JOB_QA, "qa", "payments-service", BRANCH), (jenkins.NONE, None))

    def test_network_failure_is_a_failed_lookup(self):
        self.fake({JOB_QA: urllib.error.URLError("down")})
        self.assertEqual(jenkins.latest_build(JOB_QA, "qa", "payments-service", BRANCH), (jenkins.FAILED, None))
        self.assertNotIn("tok-123", self.stderr.getvalue())

    def test_auth_failure_is_a_failed_lookup_and_stops_asking_that_host(self):
        f = self.fake({JOB_QA: 401})
        self.assertEqual(jenkins.latest_build(JOB_QA, "qa", "payments-service", BRANCH)[0], jenkins.FAILED)
        self.assertEqual(jenkins.latest_build(JOB_UAT, "uat", "payments-service", BRANCH)[0], jenkins.FAILED)
        self.assertEqual(len(f.calls), 1)

    def test_failed_pipeline_reads_failing_tests_capped_and_the_failed_stage(self):
        base = f"{JOB_QA}job/{SEG}/"
        cases = [{"className": "pay.RetryTest", "name": f"case{i}", "status": "FAILED"} for i in range(7)]
        cases.insert(0, {"className": "pay.OkTest", "name": "fine", "status": "PASSED"})
        cases.insert(1, {"className": "pay.NewTest", "name": "broke", "status": "REGRESSION"})
        f = self.fake({
            base + "lastBuild/api/json": last_build(number=413, result="FAILURE", total=320, failed=8),
            base + "413/testReport/api/json": {"suites": [{"cases": cases}]},
            base + "413/wfapi/describe": {"stages": [
                {"name": "Build", "status": "SUCCESS"}, {"name": "Test", "status": "FAILED"}, {"name": "Deploy", "status": "NOT_EXECUTED"}]},
        })
        status, b = jenkins.latest_build(JOB_QA, "qa", "payments-service", BRANCH)
        self.assertEqual(status, jenkins.OK)
        self.assertEqual(b["result"], "FAILURE")
        self.assertEqual(b["tests"]["failed"], 8)
        self.assertEqual(b["tests"]["failing"], ["pay.NewTest.broke"] + [f"pay.RetryTest.case{i}" for i in range(4)])
        self.assertEqual(b["failedStage"], "Test")
        # Authenticated follow-ups go to the CONFIGURED host, never to the URL Jenkins handed back.
        self.assertTrue(all(url.startswith(JOB_QA) for url, _h in f.calls))

    def test_unstable_reads_the_unstable_stage(self):
        base = f"{JOB_QA}job/{SEG}/"
        self.fake({
            base + "lastBuild/api/json": last_build(result="UNSTABLE", failed=0),
            base + "412/wfapi/describe": {"stages": [{"name": "Build", "status": "SUCCESS"}, {"name": "Sonar", "status": "UNSTABLE"}]},
        })
        self.assertEqual(jenkins.latest_build(JOB_QA, "qa", "payments-service", BRANCH)[1]["failedStage"], "Sonar")

    def test_extras_that_fail_do_not_fail_the_build(self):
        base = f"{JOB_QA}job/{SEG}/"
        self.fake({base + "lastBuild/api/json": last_build(result="FAILURE", failed=2), base + "412/": 500})
        status, b = jenkins.latest_build(JOB_QA, "qa", "payments-service", BRANCH)
        self.assertEqual(status, jenkins.OK)
        self.assertNotIn("failedStage", b)
        self.assertNotIn("failing", b["tests"])


def ticket(branches=(BRANCH,), prs=(), branch=None):
    return {"key": "PAY-1", "branch": branch or (branches[0] if branches else None), "branches": list(branches), "prs": list(prs)}


def pr(branch, state="comments", repo="payments-service", pid=7, slug=None):
    url = f"https://code.example.com/projects/PAY/repos/{slug or repo}/pull-requests/{pid}"
    return {"state": state, "id": pid, "repo": repo, "sourceBranch": branch, "url": url, "merged": state == "merged"}


class Targets(unittest.TestCase):
    def test_a_branch_in_a_configured_repo_is_looked_up_per_env_in_config_order(self):
        got = jenkins.targets_for(ticket(), {BRANCH: "payments-service"}, JOBS)
        self.assertEqual(got, [("payments-service", "qa", JOB_QA, BRANCH), ("payments-service", "uat", JOB_UAT, BRANCH)])

    def test_repos_not_in_the_config_are_skipped(self):
        self.assertEqual(jenkins.targets_for(ticket(), {BRANCH: "other-repo"}, JOBS), [])

    def test_the_repo_comes_from_the_pr_url_slug(self):
        t = ticket(branches=(), prs=[pr("feature/PAY-1_b", repo="Payments Service", slug="payments-service")])
        self.assertEqual([x[3] for x in jenkins.targets_for(t, {}, JOBS)], ["feature/PAY-1_b", "feature/PAY-1_b"])

    def test_repo_match_is_case_insensitive(self):
        self.assertEqual(len(jenkins.targets_for(ticket(), {BRANCH: "Payments-Service"}, JOBS)), 2)

    def test_an_unknown_repo_is_tried_against_every_configured_repo(self):
        jobs = {**JOBS, "web": [("qa", "https://jenkins.example.com/job/web-qa/")]}
        got = jenkins.targets_for(ticket(), {}, jobs)
        self.assertEqual([(r, e) for r, e, _u, _b in got], [("payments-service", "qa"), ("payments-service", "uat"), ("web", "qa")])

    def test_open_pr_branches_come_before_history_and_the_total_is_capped(self):
        prs = [pr("old/merged", state="merged", pid=1), pr("feature/open", pid=2)]
        many = tuple(f"feature/PAY-1_{i}" for i in range(20))
        t = ticket(branches=("main-work",) + many, prs=prs, branch="main-work")
        got = jenkins.targets_for(t, {}, JOBS)
        self.assertEqual(len(got), jenkins.MAX_TARGETS_PER_TICKET)
        order = list(dict.fromkeys(b for _r, _e, _u, b in got))
        self.assertEqual(order[:2], ["main-work", "feature/open"])
        self.assertNotIn("old/merged", order)

    def test_nothing_without_branches_or_jobs(self):
        self.assertEqual(jenkins.targets_for(ticket(branches=()), {}, JOBS), [])
        self.assertEqual(jenkins.targets_for(ticket(), {}, {}), [])


class BuildsFor(Base):
    TARGETS = [("payments-service", "qa", JOB_QA, BRANCH), ("payments-service", "uat", JOB_UAT, BRANCH)]

    def test_both_envs(self):
        self.fake({f"{JOB_QA}job/{SEG}/lastBuild": last_build(), f"{JOB_UAT}job/{SEG}/lastBuild": last_build(number=9, building=True)})
        got = jenkins.builds_for(self.TARGETS)
        self.assertEqual([(b["env"], b["number"], b["result"]) for b in got], [("qa", 412, "SUCCESS"), ("uat", 9, "BUILDING")])

    def test_no_build_anywhere_is_an_empty_list(self):
        self.fake({})
        self.assertEqual(jenkins.builds_for(self.TARGETS), [])

    def test_every_lookup_failing_is_none_so_the_caller_keeps_what_it_had(self):
        self.fake({"https://jenkins.example.com/": urllib.error.URLError("down")})
        self.assertIsNone(jenkins.builds_for(self.TARGETS, prior=[{"env": "qa", "repo": "payments-service", "branch": BRANCH, "number": 1, "result": "SUCCESS"}]))

    def test_a_partly_failed_lookup_carries_the_prior_build_for_the_failed_env(self):
        self.fake({f"{JOB_QA}job/{SEG}/lastBuild": last_build(number=500), JOB_UAT: 503})
        prior = [{"env": "uat", "repo": "payments-service", "branch": BRANCH, "number": 8, "result": "SUCCESS"}]
        got = jenkins.builds_for(self.TARGETS, prior=prior)
        self.assertEqual([(b["env"], b["number"]) for b in got], [("qa", 500), ("uat", 8)])

    def test_the_run_budget_stops_calls(self):
        f = self.fake({})
        with mock.patch.object(jenkins, "MAX_CALLS_PER_RUN", 1):
            jenkins.reset_run()
            self.assertEqual(jenkins.latest_build(JOB_QA, "qa", "r", BRANCH)[0], jenkins.NONE)
            self.assertEqual(jenkins.latest_build(JOB_UAT, "uat", "r", BRANCH)[0], jenkins.FAILED)
        self.assertEqual(len(f.calls), 1)


class DailyFetchBuilds(Base):
    """daily_fetch.apply_builds: refresh when Jenkins answers, carry forward when it cannot."""

    PRIOR = [{"env": "qa", "repo": "payments-service", "branch": BRANCH, "number": 400, "result": "FAILURE"}]
    FRESH = [{"env": "qa", "repo": "payments-service", "branch": BRANCH, "number": 412, "result": "SUCCESS"}]

    def run_apply(self, *, enabled=True, result=None, prior=None, ticket_obj=None, dev=None):
        t = ticket_obj if ticket_obj is not None else ticket()
        calls = []

        def fake_builds_for(targets, prior=None, workers=4):
            calls.append(targets)
            return copy.deepcopy(result)

        with mock.patch.object(daily_fetch.jenkins, "jobs_config", lambda cfg=None: JOBS), \
                mock.patch.object(daily_fetch.jenkins, "enabled", lambda jobs=None: enabled), \
                mock.patch.object(daily_fetch.jenkins, "builds_for", fake_builds_for), \
                mock.patch.object(daily_fetch, "DEV", dev if dev is not None else {"PAY-1": {"repos": {BRANCH: "payments-service"}}}):
            out = daily_fetch.apply_builds(t, "PAY-1", prior)
        return out, calls

    def test_fresh_builds_replace_the_old_ones(self):
        out, calls = self.run_apply(result=self.FRESH, prior={"builds": self.PRIOR})
        self.assertEqual(out["builds"], self.FRESH)
        self.assertEqual(calls[0][0][:2], ("payments-service", "qa"))

    def test_a_failed_lookup_keeps_the_prior_builds(self):
        out, _ = self.run_apply(result=None, prior={"builds": self.PRIOR})
        self.assertEqual(out["builds"], [{**b, "stale": True} for b in self.PRIOR])

    def test_a_failed_lookup_on_a_carried_ticket_keeps_its_own(self):
        t = {**ticket(), "builds": self.PRIOR}
        out, _ = self.run_apply(result=None, ticket_obj=t)
        self.assertEqual(out["builds"], [{**b, "stale": True} for b in self.PRIOR])

    def test_no_build_found_drops_the_field(self):
        out, _ = self.run_apply(result=[], prior={"builds": self.PRIOR})
        self.assertNotIn("builds", out)

    def test_jenkins_not_configured_is_silent_and_keeps_prior(self):
        out, calls = self.run_apply(enabled=False, result=self.FRESH, prior={"builds": self.PRIOR})
        self.assertEqual(out["builds"], self.PRIOR)
        self.assertEqual(calls, [])
        out, _ = self.run_apply(enabled=False, prior={})
        self.assertNotIn("builds", out)

    def test_a_ticket_with_no_branch_in_a_configured_repo_has_no_builds(self):
        out, calls = self.run_apply(result=self.FRESH, prior={"builds": self.PRIOR}, ticket_obj=ticket(branches=()))
        self.assertEqual(calls, [])
        self.assertNotIn("builds", out)

    def test_a_subtask_on_its_parents_branch_gets_no_builds(self):
        # code_for strips the parent's branch from the sub-task (devinfo.scope_to_subtask), so no
        # Jenkins lookup is made for it: those builds are the parent's.
        dev = {
            "PAY-1": {"branches": [BRANCH], "prs": [], "times": {}, "repos": {BRANCH: "payments-service"}},
            "PAY-2": {"branches": [BRANCH], "prs": [], "times": {}, "repos": {BRANCH: "payments-service"}},
        }
        with mock.patch.object(daily_fetch, "DEV", dev), mock.patch.object(daily_fetch, "BB_OK", False):
            sub = daily_fetch.apply_code({"key": "PAY-2", "parentKey": "PAY-1"}, "PAY-2", {})
        self.assertEqual(sub["branches"], [])
        out, calls = self.run_apply(result=self.FRESH, ticket_obj=sub, dev=dev)
        self.assertEqual(calls, [])
        self.assertNotIn("builds", out)

    def test_the_fast_path_refreshes_builds_on_an_unchanged_ticket(self):
        prior = {**ticket(), "title": "t", "status": "In Progress", "lastUpdate": "2026-03-01T10:00:00Z", "builds": self.PRIOR}
        issue = {"key": "PAY-1", "id": "1", "fields": {"status": {"name": "In Progress"}, "updated": "2026-03-01T10:00:00.000+0000"}}
        state = {"status": "In Progress", "last_update": "2026-03-01T10:00:00Z"}
        seen = []
        with mock.patch.object(daily_fetch, "apply_code", lambda t, k, prior=None: t), \
                mock.patch.object(daily_fetch, "apply_builds", lambda t, k, prior=None: seen.append(k) or {**t, "builds": self.FRESH}):
            out = daily_fetch.build_ticket(issue, prior, state)
        self.assertEqual(seen, ["PAY-1"])
        self.assertEqual(out["builds"], self.FRESH)


def report_ticket(builds, prs=None, branch=BRANCH):
    return {
        "key": "PAY-1", "title": "Retry payments", "status": "In Review", "column": "rev", "branch": branch,
        "branches": [branch], "fixVersions": ["1.0"],
        "prs": prs if prs is not None else [{"state": "approved", "id": 7, "approvals": 2, "openComments": 0, "sourceBranch": branch,
                                              "destinationBranch": "release/1.0", "repo": "payments-service", "updatedAt": "2026-10-10T00:00:00Z"}],
        "builds": builds,
    }


def build(env="qa", number=412, result="SUCCESS", branch=BRANCH, **extra):
    at = (datetime.now(timezone.utc) - timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {"env": env, "repo": "payments-service", "branch": branch, "number": number, "result": result,
            "url": f"{JOB_QA}job/{SEG}/{number}/", "at": at, "durationMs": 252000, **extra}


def gate(rep, name="CI green"):
    for tab in rep["tabs"]:
        for b in tab.get("blocks") or []:
            if b.get("title") == "Gate checklist":
                for row in b["rows"]:
                    if row["cells"][0] == name:
                        return row
    raise AssertionError(name)


def evidence(rep):
    tab = next(t for t in rep["tabs"] if t["id"] == "evidence")
    return tab["blocks"][0]["rows"]


class ReportCiGate(unittest.TestCase):
    CFG = {"app": {"requiredApprovals": 2}}

    def base(self, t):
        rep = pr_report.build_base(t, "active", self.CFG)
        self.assertEqual(pr_report.validate_report(rep, t), [])
        return rep

    def test_every_env_green_passes(self):
        rep = self.base(report_ticket([build(tests={"total": 312, "failed": 0, "skipped": 0}), build("uat", 77)]))
        row = gate(rep)
        self.assertEqual(row["cells"][1], "Pass")
        self.assertEqual(row["tone"], "success")
        self.assertIn("qa #412 SUCCESS", row["cells"][2])
        rows = [r for r in evidence(rep) if r["cells"][0].startswith("Jenkins")]
        self.assertEqual(len(rows), 2)
        self.assertIn("#412", rows[0]["cells"][1])
        self.assertIn("SUCCESS", rows[0]["cells"][1])
        self.assertIn("2h ago", rows[0]["cells"][1])
        self.assertIn("312 tests, 0 failed", rows[0]["cells"][1])

    def test_a_failed_env_fails_and_names_the_stage(self):
        rep = self.base(report_ticket([build(), build("uat", 78, "FAILURE", failedStage="Deploy",
                                                     tests={"total": 10, "failed": 2, "skipped": 0, "failing": ["a.B.c"]})]))
        row = gate(rep)
        self.assertEqual(row["cells"][1], "Fail")
        self.assertIn("Deploy", row["cells"][2])
        failed = next(r for r in evidence(rep) if "uat" in r["cells"][0])
        self.assertEqual(failed["tone"], "danger")
        self.assertIn("failed at stage 'Deploy'", failed["cells"][2])
        self.assertIn("a.B.c", failed["cells"][2])
        self.assertIn('href="https://jenkins.example.com/', failed["cells"][1])

    def test_unstable_fails(self):
        self.assertEqual(gate(self.base(report_ticket([build(result="UNSTABLE")])))["cells"][1], "Fail")

    def test_building_is_in_progress(self):
        row = gate(self.base(report_ticket([build(), build("uat", 79, "BUILDING")])))
        self.assertEqual(row["cells"][1], "In progress")
        self.assertEqual(row["tone"], "info")

    def test_aborted_is_not_verified(self):
        self.assertEqual(gate(self.base(report_ticket([build(result="ABORTED")])))["cells"][1], "Not verified")

    def test_only_the_open_prs_branch_counts_when_it_has_builds(self):
        old = build("qa", 3, "FAILURE", branch="feature/PAY-1_old")
        self.assertEqual(gate(self.base(report_ticket([build(), old])))["cells"][1], "Pass")

    def test_without_builds_bitbucket_stays_the_source(self):
        t = report_ticket(None)
        t.pop("builds")
        row = gate(self.base(t))
        self.assertEqual(row["cells"][1], "Not verified")
        self.assertIn("Bitbucket", row["cells"][2])

    def test_the_verdict_and_score_do_not_move(self):
        green = self.base(report_ticket([build()]))["verdict"]
        red = self.base(report_ticket([build(result="FAILURE")]))["verdict"]
        self.assertEqual((green["id"], green["score"]), (red["id"], red["score"]))

    def test_a_new_build_makes_the_report_stale_but_no_builds_keeps_old_fingerprints(self):
        t = report_ticket([build()])
        t2 = report_ticket([build(number=413)])
        self.assertNotEqual(pr_report.fingerprint(t), pr_report.fingerprint(t2))
        bare = report_ticket(None)
        bare.pop("builds")
        self.assertEqual(pr_report.fingerprint(bare), pr_report.fingerprint({**bare, "builds": []}))
        # The fingerprint of a ticket without builds is the one written before builds existed.
        sig = {"status": bare["status"], "fix": ["1.0"],
               "prs": sorted([["7", "approved", 2, 0, False, None, "2026-10-10T00:00:00Z", "release/1.0"]], key=str), "subtasks": []}
        import hashlib
        self.assertEqual(pr_report.fingerprint(bare), hashlib.sha1(json.dumps(sig, sort_keys=True).encode()).hexdigest()[:16])

    def test_jenkins_ci_summary_for_the_worker(self):
        ci = pr_report.jenkins_ci(report_ticket([build(), build("uat", 2, "FAILURE", failedStage="Deploy")]))
        self.assertEqual(ci["state"], "Fail")
        self.assertIn("Deploy", ci["detail"])
        self.assertIsNone(pr_report.jenkins_ci({"key": "X-1"}))


class WorkerCiSource(unittest.TestCase):
    """The AI worker's proof step reuses pr_report.jenkins_ci; Bitbucket is only the fallback."""

    @classmethod
    def setUpClass(cls):
        os.environ.setdefault("INTERN_DIR", os.path.join(ROOT, "jira-intern"))
        sys.path.insert(0, os.path.join(ROOT, "ai-intern"))
        import worker  # noqa: E402

        cls.worker = worker

    def test_jenkins_builds_lead(self):
        w = self.worker
        with mock.patch.object(w, "bitbucket_ci", side_effect=AssertionError("Bitbucket must not be asked")):
            proof = w.collect_class_proof(report_ticket([build()]))
        self.assertEqual(proof["ci"]["state"], "Pass")
        self.assertIn("Jenkins builds", proof["sources"])

    def test_the_enriched_gate_row_matches_the_base_report(self):
        w = self.worker
        t = report_ticket([build(), build("uat", 2, "FAILURE", failedStage="Deploy")])
        base = pr_report.build_base(t, "active", {"app": {"requiredApprovals": 2}})
        merged = copy.deepcopy(base)
        w.apply_class_proof(merged, w.collect_class_proof(t))
        self.assertEqual(gate(merged), gate(base))
        self.assertEqual(pr_report.validate_report(merged, t, base), [])

    def test_bitbucket_without_builds(self):
        w = self.worker
        with mock.patch.object(w, "bitbucket_ci", return_value={"state": "Not verified", "detail": "No Bitbucket token", "error": True}):
            proof = w.collect_class_proof({"key": "PAY-1", "title": "x"})
        self.assertIn("Bitbucket builds", proof["sources"])


if __name__ == "__main__":
    unittest.main()


# ── security review fixes ────────────────────────────────────────────────────


class HttpsOnlyAndTls(unittest.TestCase):
    """M2: job URLs must be https, and TLS is verified regardless of JIRA_INSECURE_TLS."""

    def test_an_http_job_url_is_skipped_with_a_note(self):
        err = io.StringIO()
        with mock.patch.object(sys, "stderr", err):
            jobs = jenkins.jobs_config({"jenkins": {"jobs": {"svc": {"qa": "http://jenkins.example.com/job/svc/", "uat": JOB_UAT}}}})
        self.assertEqual(jobs, {"svc": [("uat", JOB_UAT)]})
        self.assertIn("https", err.getvalue())
        self.assertIn("svc", err.getvalue())

    def test_jira_insecure_tls_does_not_apply_to_jenkins(self):
        import ssl
        with mock.patch.dict(os.environ, {"JIRA_INSECURE_TLS": "1", "JENKINS_INSECURE_TLS": ""}):
            self.assertEqual(jenkins.make_ssl_context().verify_mode, ssl.CERT_REQUIRED)

    def test_jenkins_insecure_tls_is_an_explicit_opt_out(self):
        import ssl
        with mock.patch.dict(os.environ, {"JENKINS_INSECURE_TLS": "1"}), mock.patch.object(sys, "stderr", io.StringIO()):
            self.assertEqual(jenkins.make_ssl_context().verify_mode, ssl.CERT_NONE)

    def test_jenkins_uses_the_same_origin_redirect_opener(self):
        import _safe_http
        import urllib.request
        handlers = jenkins._opener().handlers
        self.assertTrue(any(isinstance(h, _safe_http.SameOriginRedirect) for h in handlers))
        self.assertFalse(any(type(h) is urllib.request.HTTPRedirectHandler for h in handlers))


class StaleBuilds(Base):
    """L3: a build carried forward after a failed lookup says so, and the CI gate does not trust it."""

    TARGETS = [("payments-service", "qa", JOB_QA, BRANCH), ("payments-service", "uat", JOB_UAT, BRANCH)]

    def test_a_carried_build_is_marked_stale(self):
        self.fake({f"{JOB_QA}job/{SEG}/lastBuild": last_build(number=500), JOB_UAT: 503})
        prior = [{"env": "uat", "repo": "payments-service", "branch": BRANCH, "number": 8, "result": "SUCCESS"}]
        got = {b["env"]: b for b in jenkins.builds_for(self.TARGETS, prior=prior)}
        self.assertTrue(got["uat"]["stale"])
        self.assertNotIn("stale", got["qa"])

    def test_a_fresh_build_drops_an_old_stale_mark(self):
        self.fake({f"{JOB_QA}job/{SEG}/lastBuild": last_build(number=500)})
        got = jenkins.builds_for(self.TARGETS[:1], prior=[{"env": "qa", "repo": "payments-service", "branch": BRANCH, "number": 1,
                                                           "result": "SUCCESS", "stale": True}])
        self.assertNotIn("stale", got[0])

    def test_a_stale_green_build_is_not_verified_with_its_age(self):
        ci = pr_report.jenkins_ci(report_ticket([build(), build("uat", 77, stale=True)]))
        self.assertEqual(ci["state"], "Not verified")
        self.assertIn("stale", ci["detail"])
        self.assertIn("2h ago", ci["detail"])

    def test_a_fresh_failure_still_fails_next_to_a_stale_build(self):
        ci = pr_report.jenkins_ci(report_ticket([build(result="FAILURE"), build("uat", 77, stale=True)]))
        self.assertEqual(ci["state"], "Fail")
