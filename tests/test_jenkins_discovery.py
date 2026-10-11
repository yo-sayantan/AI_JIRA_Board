#!/usr/bin/env python3
"""Jenkins discovery: find a repository's pipelines under a root folder, label their environments,
read the latest build of a branch from each (multibranch branch job, or the newest build whose
branch PARAMETER matches), merge with the explicit jenkins.jobs, cache the walk, and print it.

Every Jenkins answer is a recorded/mocked tree (names invented, host jenkins.example.com) — nothing
touches the network."""
import contextlib
import copy
import io
import json
import os
import re
import sys
import tempfile
import time
import unittest
import urllib.error
from unittest import mock

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT_DIR, "jira-intern"))
import daily_fetch  # noqa: E402
import jenkins  # noqa: E402
import jenkins_discovery as disc  # noqa: E402
import pr_report  # noqa: E402

ROOT = "https://jenkins.example.com/job/NA/job/DA/job/Atlas/"
PORTFOLIO = ROOT + "job/1542_Acme-Id/"
APP = PORTFOLIO + "job/PAYMENTS-AWS/"
MB_DEPLOY = APP + "job/EKS_EKS-A%20Deployment/"  # multibranch, build + deploy in one ("Deployment")
MB_BUILD = APP + "job/Build%20Pipeline/"  # multibranch, no env word anywhere
STAGE_DIR = APP + "job/stage/"
PARAM_STAGE = STAGE_DIR + "job/deploy-service/"  # plain job, BRANCH_NAME parameter, env from the folder
PARAM_DEV = APP + "job/Deploy%20(dev)/"  # plain job, GIT_REF parameter
SMOKE = APP + "job/smoke-tests/"  # plain job, no branch parameter
OTHER_APP = ROOT + "job/2000_Other/job/ORDERS/"
SECOND = ROOT + "job/3000_More/job/payments-service/"  # a second portfolio that also holds the repo
SECOND_MB = SECOND + "job/prod-release/"
BRANCH = "release/eks-eksa"
SEG = "release%252Feks-eksa"

MB_CLASS = "org.jenkinsci.plugins.workflow.multibranch.WorkflowMultiBranchProject"
FOLDER = "com.cloudbees.hudson.plugins.folder.Folder"
JOB = "org.jenkinsci.plugins.workflow.job.WorkflowJob"
EVIL = "https://evil.example.org/job/x/"  # a url Jenkins "returns" — it must never be followed


def entry(name, cls):
    return {"_class": cls, "name": name, "url": EVIL, "color": "blue"}


def params(*names):
    return {"property": [{"_class": "hudson.model.ParametersDefinitionProperty", "parameterDefinitions": [{"name": n, "type": "StringParameterDefinition"} for n in names]}]}


def tree():
    """URL (with a trailing slash) → the JSON that node answers to api/json."""
    return {
        ROOT: {"jobs": [entry("1542_Acme-Id", FOLDER), entry("2000_Other", FOLDER), entry("3000_More", FOLDER)]},
        PORTFOLIO: {"jobs": [entry("PAYMENTS-AWS", FOLDER), entry("BILLING", FOLDER)]},
        ROOT + "job/2000_Other/": {"jobs": [entry("ORDERS", FOLDER)]},
        ROOT + "job/3000_More/": {"jobs": [entry("payments-service", FOLDER)]},
        OTHER_APP: {"jobs": [entry("orders-build", MB_CLASS)]},
        APP: {"jobs": [entry("EKS_EKS-A Deployment", MB_CLASS), entry("Build Pipeline", MB_CLASS), entry("stage", FOLDER),
                       entry("Deploy (dev)", JOB), entry("smoke-tests", JOB)]},
        STAGE_DIR: {"jobs": [entry("deploy-service", JOB)]},
        PARAM_STAGE: params("BRANCH_NAME", "VERSION"),
        PARAM_DEV: params("GIT_REF", "ENVIRONMENT"),
        SMOKE: params("SUITE", "STAGE"),
        SECOND: {"jobs": [entry("prod-release", MB_CLASS)]},
    }


def last_build(number=412, result="SUCCESS", total=None, failed=0):
    actions = [{"_class": "hudson.model.CauseAction"}]
    if total is not None:
        actions.append({"_class": "hudson.tasks.junit.TestResultAction", "failCount": failed, "skipCount": 0, "totalCount": total, "urlName": "testReport"})
    return {"number": number, "result": result, "building": False, "timestamp": 1791712800000, "duration": 90000,
            "url": EVIL + "1/", "actions": actions}


def scan_build(number, branch, result="SUCCESS", param="BRANCH_NAME", env=None, extra=None):
    ps = [{"name": param, "value": branch}] + ([{"name": "ENVIRONMENT", "value": env}] if env else []) + (extra or [])
    return {"number": number, "result": result, "building": False, "timestamp": 1791712800000 + number, "duration": 60000,
            "url": EVIL + f"{number}/", "actions": [{"_class": "hudson.model.CauseAction"}, {"_class": "hudson.model.ParametersAction", "parameters": ps}]}


def later(seconds):
    """Patch the clock `seconds` ahead (a fixed instant, so it cannot recurse into itself)."""
    return mock.patch.object(disc.time, "time", lambda now=time.time() + seconds: now)


class Fake:
    """Stands in for jenkins.get_json: base URL (query stripped) → JSON, 404 otherwise. Records calls."""

    def __init__(self, nodes):
        self.nodes = nodes
        self.calls = []

    def __call__(self, url, headers, timeout, retries=1):
        self.calls.append((url, headers))
        base = re.split(r"api/json|wfapi/describe", url, 1)[0]
        answer = self.nodes.get(base, self.nodes.get("*"))
        if isinstance(answer, Exception):
            raise answer
        if isinstance(answer, int):
            raise urllib.error.HTTPError(url, answer, "x", {}, io.BytesIO(b""))
        if answer is None:
            raise urllib.error.HTTPError(url, 404, "x", {}, io.BytesIO(b""))
        return copy.deepcopy(answer)

    @property
    def urls(self):
        return [u for u, _h in self.calls]


class Base(unittest.TestCase):
    def setUp(self):
        jenkins.reset_run()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.cache_file = os.path.join(self.tmp.name, ".jenkins-discovery.json")
        p = mock.patch.dict(os.environ, {"JENKINS_USER": "builder", "JENKINS_API_TOKEN": "tok-123", "JENKINS_ROOT_URL": ROOT,
                                         "JB_JENKINS_DISCOVERY_FILE": self.cache_file})
        p.start()
        self.addCleanup(p.stop)
        err = mock.patch.object(sys, "stderr", io.StringIO())
        self.stderr = err.start()
        self.addCleanup(err.stop)

    def fake(self, nodes=None):
        f = Fake(tree() if nodes is None else nodes)
        p = mock.patch.object(jenkins, "get_json", f)
        p.start()
        self.addCleanup(p.stop)
        return f

    def discover(self, slug="payments", **kw):
        return disc.discover(ROOT, slug, jenkins.discovery_config(), **kw)


# ── matching, labelling ──────────────────────────────────────────────────────


class AppFolderMatch(unittest.TestCase):
    def test_default_rule_ignores_case_and_punctuation(self):
        m = disc.app_folder_matches
        self.assertTrue(m("PAYMENTS-AWS", "payments"))  # folder starts with the slug
        self.assertTrue(m("payments", "Payments"))
        self.assertTrue(m("payments-service", "payments-service"))
        self.assertTrue(m("payments_service-prod", "payments-service"))  # slug inside the folder name, at token edges
        self.assertTrue(m("team-payments", "payments"))  # contains
        self.assertTrue(m("PaymentsService", "payments-service"))  # the whole name equals the slug once punctuation is ignored

    def test_it_does_not_match_a_longer_word_or_a_shorter_folder(self):
        m = disc.app_folder_matches
        self.assertFalse(m("paymentsgateway", "payments"))
        self.assertFalse(m("payments", "payments-service"))  # the folder is only part of the slug
        self.assertFalse(m("BILLING", "payments"))

    def test_a_very_short_slug_must_match_the_whole_name(self):
        self.assertTrue(disc.app_folder_matches("id", "id"))
        self.assertFalse(disc.app_folder_matches("acme-id", "id"))

    def test_the_template_replaces_the_default(self):
        m = disc.app_folder_matches
        self.assertTrue(m("payments-eks", "payments", "^{slug}(-.*)?$"))
        self.assertTrue(m("PAYMENTS", "payments", "^{slug}(-.*)?$"))
        self.assertFalse(m("team-payments", "payments", "^{slug}(-.*)?$"))  # would match by default
        self.assertFalse(m("payments2", "payments", "^{slug}(-.*)?$"))

    def test_the_slug_is_escaped_in_the_template_and_a_bad_template_falls_back(self):
        self.assertFalse(disc.app_folder_matches("pay-ments", "pay.ments", "^{slug}$"))
        self.assertTrue(disc.app_folder_matches("PAYMENTS-AWS", "payments", "([unclosed"))  # invalid regex → default rule


class EnvInference(unittest.TestCase):
    P = jenkins.discovery_config()["envPatterns"]

    def env(self, *segments, patterns=None):
        return disc.infer_env(list(segments), patterns or self.P)

    def test_default_words(self):
        self.assertEqual(self.env("Deploy (dev)"), "dev")
        self.assertEqual(self.env("payments_qa_deploy"), "qa")
        self.assertEqual(self.env("staging-release"), "stage")
        self.assertEqual(self.env("uat-eu"), "stage")
        self.assertEqual(self.env("demo"), "demo")
        self.assertEqual(self.env("deploy-PROD"), "prod")
        self.assertEqual(self.env("pre-prod deploy"), "stage")  # not prod

    def test_a_word_inside_another_word_is_not_a_hit(self):
        self.assertIsNone(self.env("developer-guide-build"))
        self.assertIsNone(self.env("Product Catalog"))
        self.assertIsNone(self.env("EKS_EKS-A Deployment"))

    def test_the_pipeline_name_outranks_its_folders_and_the_deepest_folder_outranks_the_rest(self):
        self.assertEqual(self.env("deploy-prod", "dev"), "prod")  # segments are given pipeline first
        self.assertEqual(self.env("deploy-service", "stage", "PAYMENTS"), "stage")

    def test_overrides_replace_a_label_and_may_add_new_ones(self):
        patterns = {"sandbox": ["sbx", "sandbox"], "prod": ["live"]}
        self.assertEqual(self.env("deploy-sbx", patterns=patterns), "sandbox")
        self.assertEqual(self.env("go-live", patterns=patterns), "prod")
        self.assertIsNone(self.env("deploy-prod", patterns=patterns))  # the override replaced the default prod list

    def test_unmatched_is_none(self):
        self.assertIsNone(self.env("Build Pipeline", "PAYMENTS-AWS"))

    def test_the_config_merges_envpatterns_per_label_and_rejects_junk(self):
        cfg = {"jenkins": {"discovery": {"envPatterns": {"prod": ["live"], "perf": ["perf"], "bad": "x", "qa": [1, ""]}}}}
        merged = jenkins.discovery_config(cfg)["envPatterns"]
        self.assertEqual(merged["prod"], ["live"])
        self.assertEqual(merged["perf"], ["perf"])
        self.assertEqual(merged["dev"], jenkins.discovery_config()["envPatterns"]["dev"])  # untouched labels keep their defaults
        self.assertNotIn("bad", merged)
        self.assertEqual(merged["qa"], jenkins.discovery_config()["envPatterns"]["qa"])  # nothing usable → the default


class Classification(unittest.TestCase):
    def test_node_classes(self):
        self.assertEqual(disc.node_kind(MB_CLASS), "multibranch")
        self.assertEqual(disc.node_kind(FOLDER), "folder")
        self.assertEqual(disc.node_kind("jenkins.branch.OrganizationFolder"), "folder")
        self.assertEqual(disc.node_kind(JOB), "job")
        self.assertEqual(disc.node_kind("hudson.model.FreeStyleProject"), "job")
        self.assertEqual(disc.node_kind(None), "job")

    def test_branch_parameter_names(self):
        self.assertEqual(jenkins.branch_param(["VERSION", "BRANCH_NAME"]), "BRANCH_NAME")
        self.assertEqual(jenkins.branch_param(["GIT_REF"]), "GIT_REF")
        self.assertEqual(jenkins.branch_param(["gitRef", "x"]), "gitRef")
        self.assertEqual(jenkins.branch_param(["REVISION"]), "REVISION")
        self.assertEqual(jenkins.branch_param(["IMAGE_TAG", "BRANCH"]), "BRANCH")  # branch outranks tag
        self.assertEqual(jenkins.branch_param(["IMAGE_TAG"]), "IMAGE_TAG")
        self.assertIsNone(jenkins.branch_param(["STAGE", "SUITE", "ENV"]))  # 'stage' hides 'tag'

    def test_kind_from_the_name(self):
        k = jenkins.discovery_config()["kindPatterns"]
        self.assertEqual(disc.infer_kind("EKS_EKS-A Deployment", "branch-job", k), "deploy")
        self.assertEqual(disc.infer_kind("payments-build", "branch-job", k), "build")
        self.assertEqual(disc.infer_kind("build-and-deploy", "branch-job", k), "both")
        self.assertEqual(disc.infer_kind("Pipeline", "branch-job", k), "both")  # one pipeline doing everything
        self.assertEqual(disc.infer_kind("Pipeline", "parameter", k), "deploy")  # a branch parameter means "deploy this"


# ── the walk ─────────────────────────────────────────────────────────────────


class Walk(Base):
    def test_finds_every_application_folder_and_classifies_every_pipeline(self):
        self.fake()
        r = self.discover()
        self.assertEqual(r["status"], "ok")
        folders = {f["url"] for f in r["folders"]}
        self.assertEqual(folders, {APP, SECOND})  # two portfolios hold a "payments" application
        by_name = {p["name"]: p for p in r["pipelines"]}
        self.assertEqual(set(by_name), {"EKS_EKS-A Deployment", "Build Pipeline", "deploy-service", "Deploy (dev)", "prod-release"})
        mb = by_name["EKS_EKS-A Deployment"]
        self.assertEqual((mb["via"], mb["kind"], mb["url"], mb["env"]), ("branch-job", "deploy", MB_DEPLOY, "EKS_EKS-A Deployment"))
        self.assertEqual(by_name["Build Pipeline"]["kind"], "build")
        p = by_name["deploy-service"]
        self.assertEqual((p["via"], p["param"], p["env"], p["kind"], p["url"]), ("parameter", "BRANCH_NAME", "stage", "deploy", PARAM_STAGE))
        d = by_name["Deploy (dev)"]
        self.assertEqual((d["param"], d["env"], d["envParam"]), ("GIT_REF", "dev", "ENVIRONMENT"))
        self.assertEqual(by_name["prod-release"]["env"], "prod")
        self.assertEqual([x["name"] for x in r["ignored"]], ["smoke-tests"])
        self.assertIn("no branch parameter", r["ignored"][0]["reason"])

    def test_the_env_comes_from_the_folder_path_or_the_pipeline_name_in_that_order_of_specificity(self):
        self.fake()
        by_name = {p["name"]: p for p in self.discover()["pipelines"]}
        self.assertEqual(by_name["deploy-service"]["env"], "stage")  # from the folder "stage"
        self.assertEqual(by_name["Deploy (dev)"]["env"], "dev")  # from the pipeline name
        self.assertEqual(by_name["Build Pipeline"]["envFrom"], "pipeline")  # nothing matched: labelled by its name

    def test_pipelines_are_listed_dev_to_prod_with_unlabelled_ones_last(self):
        self.fake()
        envs = [p["env"] for p in self.discover()["pipelines"]]
        self.assertEqual(envs, ["dev", "stage", "prod", "EKS_EKS-A Deployment", "Build Pipeline"])

    def test_urls_are_built_from_names_never_from_what_jenkins_returns(self):
        f = self.fake()
        self.discover()
        self.assertTrue(f.urls)
        self.assertTrue(all(u.startswith(ROOT) for u in f.urls), f.urls)
        self.assertFalse(any("evil" in u for u in f.urls))

    def test_slug_variants(self):
        self.fake()
        self.assertEqual(len(self.discover("payments")["folders"]), 2)
        self.assertEqual({f["url"] for f in self.discover("payments-service")["folders"]}, {SECOND})
        self.assertEqual(self.discover("nothing-here")["pipelines"], [])

    def test_a_pipeline_named_after_the_repo_is_found_without_an_application_folder(self):
        nodes = tree()
        nodes[ROOT + "job/2000_Other/"]["jobs"].append(entry("billing-api-qa", MB_CLASS))
        self.fake(nodes)
        r = self.discover("billing-api")
        self.assertEqual([(p["name"], p["env"], p["via"]) for p in r["pipelines"]], [("billing-api-qa", "qa", "branch-job")])

    def test_the_depth_limit_stops_the_walk(self):
        self.fake()
        cfg = jenkins.discovery_config({"jenkins": {"discovery": {"maxDepth": 2}}})
        r = disc.discover(ROOT, "payments", cfg)
        # root (0) and the portfolios (1) are listed; the application folder (2) is found but its contents are beyond the limit
        self.assertEqual({f["url"] for f in r["folders"]}, {APP, SECOND})
        self.assertEqual(r["pipelines"], [])
        self.assertTrue(any("maxDepth" in x["reason"] for x in r["ignored"]))

    def test_the_default_depth_reaches_pipelines_in_environment_folders(self):
        self.fake()
        self.assertIn("deploy-service", {p["name"] for p in self.discover()["pipelines"]})  # root → portfolio → app → stage/ → job

    def test_the_call_budget_marks_the_walk_partial_and_it_is_not_cached(self):
        self.fake()
        cfg = jenkins.discovery_config({"jenkins": {"discovery": {"maxCalls": 3}}})
        r = disc.discover(ROOT, "payments", cfg)
        self.assertEqual(r["status"], "partial")
        self.assertFalse(os.path.exists(self.cache_file))

    def test_plain_folders_below_the_application_are_walked_for_pipelines(self):
        nodes = tree()
        nodes[APP]["jobs"].append(entry("prod", FOLDER))
        nodes[APP + "job/prod/"] = {"jobs": [entry("go", MB_CLASS)]}
        self.fake(nodes)
        by_name = {p["name"]: p for p in self.discover()["pipelines"]}
        self.assertEqual(by_name["go"]["env"], "prod")
        self.assertEqual(by_name["go"]["url"], APP + "job/prod/job/go/")

    def test_the_names_are_encoded_into_urls(self):
        f = self.fake()
        self.discover()
        self.assertIn(PARAM_DEV + "api/json", " ".join(f.urls))  # "Deploy (dev)" → Deploy%20%28dev%29

    def test_an_unreadable_root_fails_instead_of_looking_empty(self):
        self.fake({ROOT: urllib.error.URLError("down")})
        self.assertEqual(self.discover()["status"], "failed")
        self.fake({ROOT: 401})
        jenkins.reset_run()
        self.assertEqual(self.discover()["status"], "failed")


# ── the cache ────────────────────────────────────────────────────────────────


class Cache(Base):
    def test_a_walk_is_written_and_reused_without_a_call_inside_the_ttl(self):
        f = self.fake()
        first = self.discover()
        self.assertTrue(os.path.isfile(self.cache_file))
        n = len(f.calls)
        jenkins.reset_run()  # a new run
        again = self.discover()
        self.assertEqual(len(f.calls), n)
        self.assertEqual(again["pipelines"], first["pipelines"])
        self.assertEqual(again["fromCache"], "fresh")

    def test_the_cache_file_is_json_without_credentials(self):
        self.fake()
        self.discover()
        text = open(self.cache_file, encoding="utf-8").read()
        self.assertNotIn("tok-123", text)
        self.assertNotIn("builder", text)
        self.assertEqual(json.loads(text)["version"], 1)

    def test_an_expired_entry_is_walked_again(self):
        f = self.fake()
        self.discover()
        n = len(f.calls)
        jenkins.reset_run()
        with later(61 * 60):
            self.discover()
        self.assertGreater(len(f.calls), n)

    def test_use_cache_false_walks_again_and_cache_minutes_is_configurable(self):
        f = self.fake()
        self.discover()
        n = len(f.calls)
        jenkins.reset_run()
        self.discover(use_cache=False)
        self.assertGreater(len(f.calls), n)

    def test_a_failed_walk_serves_the_stale_entry_instead_of_wiping_it(self):
        self.fake()
        first = self.discover()
        jenkins.reset_run()
        self.fake({ROOT: urllib.error.URLError("down")})
        with later(3 * 3600):
            r = self.discover()
        self.assertEqual(r["status"], "ok")
        self.assertEqual(r["fromCache"], "stale")
        self.assertEqual(r["pipelines"], first["pipelines"])
        self.assertEqual(len(json.load(open(self.cache_file))["entries"]), 1)  # still there

    def test_a_genuinely_empty_answer_is_cached_too(self):
        f = self.fake()
        self.discover("nothing-here")
        n = len(f.calls)
        jenkins.reset_run()
        self.assertEqual(self.discover("nothing-here")["pipelines"], [])
        self.assertEqual(len(f.calls), n)

    def test_changing_the_discovery_config_invalidates_the_entry(self):
        f = self.fake()
        self.discover()
        n = len(f.calls)
        jenkins.reset_run()
        disc.discover(ROOT, "payments", jenkins.discovery_config({"jenkins": {"discovery": {"envPatterns": {"dev": ["dev", "deploy"]}}}}))
        self.assertGreater(len(f.calls), n)

    def test_one_walk_per_slug_per_run_even_with_the_cache_off_for_other_runs(self):
        f = self.fake()
        self.discover()
        n = len(f.calls)
        self.discover(use_cache=False)  # same run: the in-memory answer is used
        self.assertEqual(len(f.calls), n)

    def test_a_corrupt_cache_file_is_ignored(self):
        open(self.cache_file, "w").write("{nope")
        self.fake()
        self.assertEqual(self.discover()["status"], "ok")


# ── reading builds ───────────────────────────────────────────────────────────


class Refs(unittest.TestCase):
    def test_norm_ref(self):
        n = jenkins.norm_ref
        self.assertEqual(n("origin/release/x"), "release/x")
        self.assertEqual(n("refs/heads/release/x"), "release/x")
        self.assertEqual(n("refs/remotes/origin/release/x"), "release/x")
        self.assertEqual(n(" release/x "), "release/x")
        self.assertEqual(n("origin/origin-fix"), "origin-fix")
        self.assertEqual(n("feature/origin/x"), "feature/origin/x")
        self.assertEqual(n(None), "")


def pipeline(name, url, via="branch-job", kind="deploy", env="qa", param=None, env_param=None, env_from="pattern"):
    return {"name": name, "url": url, "via": via, "kind": kind, "env": env, "param": param, "envParam": env_param, "envFrom": env_from}


class ParameterScan(Base):
    def test_the_newest_build_whose_branch_parameter_matches_is_the_latest_deployment(self):
        builds = [scan_build(9, "develop"), scan_build(8, "origin/" + BRANCH, "FAILURE"), scan_build(7, BRANCH), scan_build(6, "refs/heads/" + BRANCH)]
        f = self.fake({PARAM_STAGE: {"builds": builds}})
        status, got = jenkins.parameter_builds(PARAM_STAGE, "BRANCH_NAME", "stage", "payments", BRANCH, "deploy-service", "deploy", None, 25)
        self.assertEqual(status, jenkins.OK)
        self.assertEqual([(b["number"], b["result"], b["env"]) for b in got], [(8, "FAILURE", "stage")])
        self.assertEqual(got[0]["url"], f"{PARAM_STAGE}8/")  # built from the configured job, not Jenkins' url
        self.assertEqual(len([u for u in f.urls if "builds" in u]), 1)  # one scan call
        self.assertIn("0,25", f.urls[0].replace("%2C", ","))

    def test_no_matching_build_is_none_not_failed(self):
        self.fake({PARAM_STAGE: {"builds": [scan_build(3, "develop")]}})
        self.assertEqual(jenkins.parameter_builds(PARAM_STAGE, "BRANCH_NAME", "stage", "p", BRANCH, "x", "deploy", None, 25), (jenkins.NONE, []))

    def test_the_parameter_name_is_case_insensitive_and_the_branch_match_is_exact(self):
        self.fake({PARAM_STAGE: {"builds": [scan_build(3, BRANCH + "-2", param="branch_name"), scan_build(2, BRANCH, param="branch_name")]}})
        _s, got = jenkins.parameter_builds(PARAM_STAGE, "BRANCH_NAME", "stage", "p", BRANCH, "x", "deploy", None, 25)
        self.assertEqual([b["number"] for b in got], [2])

    def test_a_failed_scan_is_a_failed_lookup(self):
        self.fake({PARAM_STAGE: urllib.error.URLError("down")})
        self.assertEqual(jenkins.parameter_builds(PARAM_STAGE, "BRANCH_NAME", "stage", "p", BRANCH, "x", "deploy", None, 25), (jenkins.FAILED, []))

    def test_a_job_that_vanished_is_no_build(self):
        self.fake({})
        self.assertEqual(jenkins.parameter_builds(PARAM_STAGE, "BRANCH_NAME", "stage", "p", BRANCH, "x", "deploy", None, 25)[0], jenkins.NONE)

    def test_one_job_serving_several_environments_gives_one_build_per_environment_value(self):
        builds = [scan_build(9, BRANCH, env="qa"), scan_build(8, BRANCH, env="uat", result="FAILURE"), scan_build(7, BRANCH, env="qa"), scan_build(6, "develop", env="prod")]
        self.fake({PARAM_DEV: {"builds": builds}})
        _s, got = jenkins.parameter_builds(PARAM_DEV, "BRANCH_NAME", "Deploy", "p", BRANCH, "Deploy", "deploy", "ENVIRONMENT", 25)
        self.assertEqual([(b["env"], b["number"], b["result"]) for b in got], [("qa", 9, "SUCCESS"), ("stage", 8, "FAILURE")])  # uat is a stage word

    def test_deploy_pipelines_skip_the_test_report_but_a_failure_still_names_its_stage(self):
        f = self.fake({PARAM_STAGE: {"builds": [scan_build(5, BRANCH, "FAILURE")]},
                       PARAM_STAGE + "5/": {"stages": [{"name": "Apply", "status": "FAILED"}]}})
        _s, got = jenkins.parameter_builds(PARAM_STAGE, "BRANCH_NAME", "stage", "p", BRANCH, "x", "deploy", None, 25)
        self.assertEqual(got[0]["failedStage"], "Apply")
        self.assertFalse(any("testReport" in u or "lastBuild" in u for u in f.urls))
        self.assertNotIn("tok-123", " ".join(f.urls))

    def test_a_build_pipeline_reads_the_test_totals_of_the_matched_build(self):
        nodes = {PARAM_STAGE: {"builds": [scan_build(5, BRANCH)]}, PARAM_STAGE + "5/": last_build(5, total=120, failed=0)}
        self.fake(nodes)
        _s, got = jenkins.parameter_builds(PARAM_STAGE, "BRANCH_NAME", "stage", "p", BRANCH, "x", "build", None, 25)
        self.assertEqual(got[0]["tests"], {"total": 120, "failed": 0, "skipped": 0})

    def test_the_scan_size_is_configurable(self):
        f = self.fake({PARAM_STAGE: {"builds": []}})
        jenkins.parameter_builds(PARAM_STAGE, "BRANCH_NAME", "stage", "p", BRANCH, "x", "deploy", None, 7)
        self.assertIn("0,7", f.urls[0].replace("%2C", ","))


def ticket(branches=(BRANCH,), prs=(), branch=None):
    return {"key": "PAY-1", "branch": branch or (branches[0] if branches else None), "branches": list(branches), "prs": list(prs)}


class TargetsAndBuilds(Base):
    DISCOVERED = {"payments": [
        pipeline("EKS_EKS-A Deployment", MB_DEPLOY, env="dev"),
        pipeline("Build Pipeline", MB_BUILD, kind="build", env="dev"),
        pipeline("deploy-service", PARAM_STAGE, via="parameter", param="BRANCH_NAME", env="stage"),
    ]}

    def test_discovered_pipelines_become_targets_per_branch(self):
        got = jenkins.targets_for(ticket(), {BRANCH: "payments"}, {}, self.DISCOVERED)
        self.assertEqual([(t["env"], t["pipeline"], t["via"], t["kind"]) for t in got],
                         [("dev", "EKS_EKS-A Deployment", "branch-job", "deploy"), ("dev", "Build Pipeline", "branch-job", "build"), ("stage", "deploy-service", "parameter", "deploy")])
        self.assertEqual({t["repo"] for t in got}, {"payments"})
        self.assertEqual({t["branch"] for t in got}, {BRANCH})

    def test_explicit_jobs_override_discovery_for_that_repo_and_env_only(self):
        explicit = {"payments": [("dev", "https://jenkins.example.com/job/mine-dev/")]}
        got = jenkins.targets_for(ticket(), {BRANCH: "payments"}, explicit, self.DISCOVERED)
        self.assertEqual(got[0], ("payments", "dev", "https://jenkins.example.com/job/mine-dev/", BRANCH))  # explicit stays a plain tuple
        discovered_envs = [(t["env"], t["pipeline"]) for t in got[1:]]
        self.assertEqual(discovered_envs, [("stage", "deploy-service")])  # both dev pipelines dropped: the config named dev

    def test_discovery_is_only_asked_about_a_repo_the_ticket_names(self):
        self.assertEqual(jenkins.candidate_repos(ticket(), {BRANCH: "Payments"}), ["Payments"])
        t = ticket(branches=(), prs=[{"sourceBranch": "f/x", "url": "https://code.example.com/projects/P/repos/billing/pull-requests/3", "state": "open"}])
        self.assertEqual(jenkins.candidate_repos(t, {}), ["billing"])
        self.assertEqual(jenkins.candidate_repos(ticket(), {}), [])  # an unknown repo is never guessed against a whole tree

    def test_multibranch_reads_the_branch_job_and_tags_the_build_with_its_pipeline(self):
        self.fake({MB_DEPLOY + f"job/{SEG}/lastBuild/": last_build(7), PARAM_STAGE: {"builds": [scan_build(3, BRANCH)]}})
        targets = jenkins.targets_for(ticket(), {BRANCH: "payments"}, {}, self.DISCOVERED)
        got = jenkins.builds_for(targets)
        self.assertEqual([(b["env"], b["pipeline"], b["kind"], b["via"], b["number"]) for b in got],
                         [("dev", "EKS_EKS-A Deployment", "deploy", "branch-job", 7), ("stage", "deploy-service", "deploy", "parameter", 3)])

    def test_a_branch_with_no_build_in_any_pipeline_is_an_empty_list_and_a_partial_failure_keeps_prior(self):
        self.fake({})
        targets = jenkins.targets_for(ticket(), {BRANCH: "payments"}, {}, self.DISCOVERED)
        self.assertEqual(jenkins.builds_for(targets), [])
        prior = [{"env": "stage", "repo": "payments", "branch": BRANCH, "pipeline": "deploy-service", "number": 2, "result": "SUCCESS"},
                 {"env": "stage", "repo": "payments", "branch": BRANCH, "pipeline": "another", "number": 9, "result": "SUCCESS"}]
        jenkins.reset_run()
        self.fake({MB_DEPLOY + f"job/{SEG}/lastBuild/": last_build(7), PARAM_STAGE: urllib.error.URLError("down")})
        # the host is marked down by the first failure: the failed lookups carry only their own prior builds forward
        got = jenkins.builds_for(targets, prior=prior)
        self.assertIn(("deploy-service", 2, True), [(b.get("pipeline"), b["number"], b.get("stale", False)) for b in got])
        self.assertNotIn("another", [b.get("pipeline") for b in got])

    def test_every_lookup_failing_is_none(self):
        self.fake({"*": urllib.error.URLError("down")})
        targets = jenkins.targets_for(ticket(), {BRANCH: "payments"}, {}, self.DISCOVERED)
        self.assertIsNone(jenkins.builds_for(targets))

    def test_an_unlabelled_job_serving_many_environments_is_labelled_by_its_parameter(self):
        d = {"payments": [pipeline("Deploy", PARAM_DEV, via="parameter", param="GIT_REF", env="Deploy", env_param="ENVIRONMENT", env_from="pipeline")]}
        self.fake({PARAM_DEV: {"builds": [scan_build(4, BRANCH, param="GIT_REF", env="Stage-EU"), scan_build(3, BRANCH, param="GIT_REF", env="qa")]}})
        got = jenkins.builds_for(jenkins.targets_for(ticket(), {BRANCH: "payments"}, {}, d))
        self.assertEqual(sorted(b["env"] for b in got), ["qa", "stage"])  # envPatterns turn "Stage-EU" into stage


class DiscoveryFor(Base):
    def test_returns_pipelines_per_slug_and_names_the_slugs_it_could_not_read(self):
        self.fake()
        found, failed = jenkins.discovery_for(["payments"])
        self.assertEqual(len(found["payments"]), 5)
        self.assertEqual(failed, set())
        jenkins.reset_run()
        os.unlink(self.cache_file)
        self.fake({ROOT: urllib.error.URLError("down")})
        found, failed = jenkins.discovery_for(["payments"])
        self.assertEqual((found, failed), ({}, {"payments"}))

    def test_without_a_root_nothing_is_asked(self):
        f = self.fake()
        with mock.patch.dict(os.environ, {"JENKINS_ROOT_URL": ""}):
            self.assertEqual(jenkins.discovery_for(["payments"], cfg={}), ({}, set()))
        self.assertEqual(f.calls, [])

    def test_root_comes_from_env_then_config_and_must_be_https(self):
        self.assertEqual(jenkins.root_url({}), ROOT)
        with mock.patch.dict(os.environ, {"JENKINS_ROOT_URL": ""}):
            self.assertEqual(jenkins.root_url({"jenkins": {"root": " https://jenkins.example.com/job/x "}}), "https://jenkins.example.com/job/x/")
            self.assertEqual(jenkins.root_url({}), "")
            self.assertEqual(jenkins.root_url({"jenkins": {"root": "http://jenkins.example.com/job/x/"}}), "")
            self.assertIn("not https", self.stderr.getvalue())

    def test_enabled_with_only_a_root(self):
        self.assertTrue(jenkins.enabled({}))
        with mock.patch.dict(os.environ, {"JENKINS_ROOT_URL": ""}):
            self.assertFalse(jenkins.enabled({}))


class DailyFetch(Base):
    def run_apply(self, prior=None, t=None):
        t = t if t is not None else ticket()
        with mock.patch.object(daily_fetch, "DEV", {"PAY-1": {"repos": {BRANCH: "payments"}}}), \
                mock.patch.object(jenkins, "jobs_config", lambda cfg=None: {}):
            return daily_fetch.apply_builds(t, "PAY-1", prior)

    def test_discovered_builds_are_stored_and_refreshed(self):
        self.fake({**tree(), MB_DEPLOY + f"job/{SEG}/lastBuild/": last_build(7)})
        out = self.run_apply()
        self.assertEqual([b["pipeline"] for b in out["builds"]], ["EKS_EKS-A Deployment"])

    def test_a_failed_discovery_carries_the_prior_builds_forward_marked_stale(self):
        self.fake({ROOT: urllib.error.URLError("down")})
        prior = {"builds": [{"env": "dev", "repo": "payments", "branch": BRANCH, "pipeline": "Deploy", "number": 5, "result": "SUCCESS"}]}
        out = self.run_apply(prior)
        self.assertEqual([(b["number"], b.get("stale")) for b in out["builds"]], [(5, True)])

    def test_a_stale_cache_still_discovers_when_the_walk_fails(self):
        self.fake({**tree(), MB_DEPLOY + f"job/{SEG}/lastBuild/": last_build(7)})
        self.run_apply()
        jenkins.reset_run()
        self.fake({ROOT: urllib.error.URLError("down")})
        with later(5 * 3600):
            out = self.run_apply({"builds": []})
        self.assertIsNone(out.get("builds"))  # discovery was served (stale) but every build lookup then failed → nothing new, nothing wiped
        # (the host is marked down, so the lookups failed: with no prior builds there is nothing to carry)

    def test_a_ticket_with_no_repo_asks_nothing(self):
        f = self.fake()
        with mock.patch.object(daily_fetch, "DEV", {}):
            out = daily_fetch.apply_builds(ticket(), "PAY-1", {})
        self.assertNotIn("builds", out)
        self.assertEqual(f.calls, [])


# ── the gate and the card ────────────────────────────────────────────────────


class Gate(unittest.TestCase):
    def build(self, env, pipeline, kind, result, number=1):
        return {"env": env, "repo": "payments", "branch": BRANCH, "pipeline": pipeline, "kind": kind, "number": number, "result": result, "at": "2026-10-11T08:00:00Z"}

    def test_a_green_build_next_to_a_failed_deploy_fails_the_gate(self):
        t = {"branch": BRANCH, "builds": [self.build("dev", "build", "build", "SUCCESS"), self.build("dev", "deploy", "deploy", "FAILURE", 2)]}
        gate = pr_report.jenkins_ci(t)
        self.assertEqual(gate["state"], "Fail")
        self.assertIn("deploy", gate["detail"])

    def test_every_pipeline_green_passes_and_a_stale_one_never_does(self):
        builds = [self.build("dev", "build", "build", "SUCCESS"), self.build("dev", "deploy", "deploy", "SUCCESS", 2)]
        self.assertEqual(pr_report.jenkins_ci({"branch": BRANCH, "builds": builds})["state"], "Pass")
        builds[1]["stale"] = True
        self.assertEqual(pr_report.jenkins_ci({"branch": BRANCH, "builds": builds})["state"], "Not verified")

    def test_the_fingerprint_moves_with_a_pipeline_and_ignores_an_empty_one(self):
        plain = {"env": "qa", "repo": "r", "branch": "b", "number": 1, "result": "SUCCESS"}
        t1 = {"key": "A-1", "builds": [plain]}
        t2 = {"key": "A-1", "builds": [{**plain, "pipeline": "deploy"}]}
        self.assertNotEqual(pr_report.fingerprint(t1), pr_report.fingerprint(t2))
        self.assertEqual(pr_report.fingerprint(t1), pr_report.fingerprint({"key": "A-1", "builds": [dict(plain)]}))
        self.assertEqual(pr_report.fingerprint({"key": "A-1", "builds": [{**plain, "pipeline": None}]}), pr_report.fingerprint(t1))


# ── the CLI ──────────────────────────────────────────────────────────────────


class Cli(Base):
    def run_cli(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), mock.patch.object(sys, "stderr", err):
            code = jenkins.cli(list(argv))
        return code, out.getvalue(), err.getvalue()

    def test_prints_the_walked_tree_with_classification_env_and_urls(self):
        self.fake()
        code, out, _err = self.run_cli("discover", "payments")
        self.assertEqual(code, 0)
        for needle in ("PAYMENTS-AWS", APP, MB_DEPLOY, "multibranch", "parameterised [BRANCH_NAME]", "parameterised [GIT_REF]", "env=stage", "env=dev",
                       "kind=deploy", "smoke-tests", "Ignored", PARAM_STAGE):
            self.assertIn(needle, out)
        self.assertIn("matched", out)  # says WHY an env was chosen, so envPatterns can be tuned

    def test_no_token_or_user_in_the_output_or_the_log(self):
        self.fake()
        _code, out, err = self.run_cli("discover", "payments")
        for text in (out, err, self.stderr.getvalue()):
            self.assertNotIn("tok-123", text)
            self.assertNotIn("YnVpbGRlcjp0b2stMTIz", text)  # the base64 of user:token

    def test_exit_2_without_a_root_or_without_credentials(self):
        self.fake()
        with mock.patch.dict(os.environ, {"JENKINS_ROOT_URL": ""}):
            code, _out, err = self.run_cli("discover", "payments")
        self.assertEqual(code, 2)
        self.assertIn("JENKINS_ROOT_URL", err)
        with mock.patch.dict(os.environ, {"JENKINS_API_TOKEN": ""}):
            self.assertEqual(self.run_cli("discover", "payments")[0], 2)

    def test_exit_2_for_a_missing_slug_and_1_when_the_walk_fails(self):
        self.fake({ROOT: urllib.error.URLError("down")})
        self.assertEqual(self.run_cli("discover")[0], 2)
        code, _out, err = self.run_cli("discover", "payments")
        self.assertEqual(code, 1)
        self.assertNotIn("tok-123", err)

    def test_it_ignores_the_cache_so_the_tree_printed_is_the_live_one(self):
        f = self.fake()
        self.run_cli("discover", "payments")
        n = len(f.calls)
        jenkins.reset_run()
        self.run_cli("discover", "payments")
        self.assertGreater(len(f.calls), n)

    def test_json_output(self):
        self.fake()
        _code, out, _err = self.run_cli("discover", "payments", "--json")
        data = json.loads(out)
        self.assertEqual({p["name"] for p in data["pipelines"]}, {"EKS_EKS-A Deployment", "Build Pipeline", "deploy-service", "Deploy (dev)", "prod-release"})


# ── transport rules still hold ───────────────────────────────────────────────


class Transport(Base):
    def test_an_http_root_is_never_walked(self):
        f = self.fake()
        with mock.patch.dict(os.environ, {"JENKINS_ROOT_URL": "http://jenkins.example.com/job/x/"}):
            self.assertEqual(jenkins.discovery_for(["payments"], cfg={}), ({}, set()))
        self.assertEqual(f.calls, [])

    def test_discovery_uses_the_same_origin_redirect_opener(self):
        with mock.patch.object(jenkins._safe_http, "opener", return_value=mock.Mock()) as op:
            jenkins._OPENER = None
            jenkins._opener()
        op.assert_called_once()
        jenkins._OPENER = None

    def test_a_redirect_to_another_host_is_a_failed_lookup(self):
        err = urllib.error.HTTPError(ROOT, 302, "refused redirect to another origin", {}, io.BytesIO(b""))
        self.fake({ROOT: err})
        self.assertEqual(self.discover()["status"], "failed")

    def test_the_basic_auth_header_is_the_only_place_the_token_travels(self):
        f = self.fake()
        self.discover()
        for url, headers in f.calls:
            self.assertNotIn("tok-123", url)
            self.assertTrue(headers["Authorization"].startswith("Basic "))

    def test_an_auth_failure_stops_the_walk_after_one_call(self):
        f = self.fake({ROOT: 401})
        self.assertEqual(self.discover()["status"], "failed")
        self.assertEqual(len(f.calls), 1)


class Config(unittest.TestCase):
    def test_defaults(self):
        d = jenkins.discovery_config()
        self.assertEqual((d["maxDepth"], d["cacheMinutes"], d["buildScan"]), (4, 60, 25))
        self.assertEqual(list(d["envPatterns"])[:5], ["dev", "qa", "stage", "demo", "prod"])
        self.assertEqual(d["appFolderRegex"], "")

    def test_values_are_clamped_and_junk_is_ignored(self):
        d = jenkins.discovery_config({"jenkins": {"discovery": {"maxDepth": 99, "cacheMinutes": -5, "buildScan": "x", "appFolderRegex": 3}}})
        self.assertEqual((d["maxDepth"], d["cacheMinutes"], d["buildScan"], d["appFolderRegex"]), (8, 0, 25, ""))

    def test_the_tracked_config_ships_generic_and_empty(self):
        with open(os.path.join(ROOT_DIR, "config", "jira-board.config.json"), encoding="utf-8") as f:
            cfg = json.load(f)["jenkins"]
        self.assertEqual(cfg.get("root", ""), "")
        self.assertEqual(cfg["jobs"], {})
        self.assertEqual(cfg.get("discovery", {}), {})


if __name__ == "__main__":
    unittest.main()
