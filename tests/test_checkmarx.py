#!/usr/bin/env python3
"""Checkmarx One: what a vulnerability-fix ticket says it fixes (targets), the branch-vs-base scan
comparison that decides fixed / open / not-found / unknown, carry-forward when Checkmarx cannot be
read, how the daily fetch stores `vulnFixes`, and how the PR readiness report's security gate and
the AI worker's proof read them.

Every Checkmarx answer here is mocked JSON — nothing touches the network."""
import copy
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
import urllib.error
import urllib.parse
import urllib.request
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INTERN = os.path.join(ROOT, "jira-intern")
sys.path.insert(0, INTERN)
import checkmarx  # noqa: E402
import daily_fetch  # noqa: E402
import pr_report  # noqa: E402

BASE = "https://your-tenant.cxone.cloud"
AUTH = f"{BASE}/auth/realms/your-tenant/protocol/openid-connect/token"
BRANCH = "feature/PAY-7_log4j"
PR_URL = "https://bitbucket.example.com/projects/PAY/repos/payments-service/pull-requests/9"


def http_error(url, code):
    return urllib.error.HTTPError(url, code, "x", {}, io.BytesIO(b""))


def vticket(**extra):
    t = {
        "key": "PAY-7",
        "title": "Fix CVE-2021-44228 in payments",
        "type": "Bug",
        "status": "In Review",
        "column": "rev",
        "labels": ["security"],
        "fixVersions": ["1.0"],
        "description": (
            "<p>Upgrade <code>log4j-core 2.14.1</code> to 2.17.1. Also fixes the Checkmarx finding SQL_Injection (CWE-89) — "
            'see <a href="https://your-tenant.cxone.cloud/results/p1/s1/sast?result-id=abc123XYZ">the result</a>.</p>'
        ),
        "comments": [{"author": "QA", "body": "<p>lodash@4.17.20 is flagged too, and CVE-2020-9999 was mentioned in triage.</p>"}],
        "branch": BRANCH,
        "branches": [BRANCH],
        "prs": [{"state": "approved", "id": 9, "url": PR_URL, "repo": "payments-service", "approvals": 2, "openComments": 0,
                 "sourceBranch": BRANCH, "destinationBranch": "develop", "updatedAt": "2026-10-10T00:00:00Z"}],
    }
    t.update(extra)
    return t


def targets_of(t):
    return [(x["kind"], x["target"]) for x in checkmarx.extract_targets(t)]


# ── fake Checkmarx One ───────────────────────────────────────────────────────


def sca(cve, pkg, severity="HIGH", state="TO_VERIFY", status="RECURRENT", rid=None):
    return {"type": "sca", "id": rid or cve, "similarityId": f"sim-{cve}", "severity": severity, "state": state, "status": status,
            "data": {"packageIdentifier": pkg}, "vulnerabilityDetails": {"cveName": cve}}


def sast(query, cwe, rid, sim, severity="HIGH", state="TO_VERIFY", status="RECURRENT", file="/src/Dao.java", line=42):
    return {"type": "sast", "id": rid, "similarityId": sim, "severity": severity, "state": state, "status": status,
            "data": {"queryName": query, "nodes": [{"fileName": file, "line": line}]}, "vulnerabilityDetails": {"cweId": cwe}}


BASE_ROWS = [
    sca("CVE-2021-44228", "Maven-org.apache.logging.log4j:log4j-core-2.14.1", "CRITICAL"),
    sca("CVE-2021-23337", "Npm-lodash-4.17.20", "HIGH"),
    sast("SQL_Injection", 89, "row-sqli-base", "-111", "HIGH"),
    sast("Stored_XSS", 79, "abc123XYZ", "777", "MEDIUM", file="/web/Comment.tsx", line=12),
    {"type": "kics", "id": "k1", "severity": "LOW", "data": {"queryName": "Container Running As Root"}},
]
BRANCH_ROWS = [
    sca("CVE-2021-23337", "Npm-lodash-4.17.20", "HIGH", state="NOT_EXPLOITABLE"),
    sast("SQL_Injection", 89, "row-sqli-branch", "-111", "HIGH", file="/src/Dao.java", line=57),
]


class FakeCx:
    """URL → JSON for checkmarx._http; records every call (url, headers, body)."""

    def __init__(self, *, projects=None, scans=None, results=None, fail=None, main_branch="develop", page_cap=None, omit_total=False,
                 summary=None):
        self.page_cap = page_cap  # a server that serves fewer results per page than asked
        self.omit_total = omit_total  # a server that does not say totalCount
        self.summary = summary  # scan-id → /api/scan-summary answer
        self.projects = projects if projects is not None else [{"id": "p1", "name": "payments-service", "mainBranch": main_branch}]
        self.scans = scans if scans is not None else {
            BRANCH: [{"id": "s-branch", "branch": BRANCH, "status": "Completed", "createdAt": "2026-10-09T08:00:00.123Z"}],
            "develop": [{"id": "s-base", "branch": "develop", "status": "Completed", "createdAt": "2026-10-01T07:00:00Z"}],
        }
        self.results = results if results is not None else {"s-branch": BRANCH_ROWS, "s-base": BASE_ROWS}
        self.fail = fail or {}
        self.calls = []

    def __call__(self, url, headers, data=None, timeout=None):
        self.calls.append((url, dict(headers or {}), data))
        for prefix, exc in self.fail.items():
            if url.startswith(prefix):
                if isinstance(exc, int):
                    raise http_error(url, exc)
                raise exc
        u = urllib.parse.urlsplit(url)
        q = dict(urllib.parse.parse_qsl(u.query))
        if url.startswith(AUTH):
            assert data is not None
            return {"access_token": "tok-abc", "expires_in": 1800}
        assert headers.get("Authorization") == "Bearer tok-abc", headers
        if u.path == "/api/projects":
            return {"projects": copy.deepcopy(self.projects), "totalCount": len(self.projects)}
        if u.path == "/api/scans":
            assert q.get("project-id") == "p1" and q.get("statuses") == "Completed"
            # A scan that does not say which engines ran is a full one (SAST + SCA) here.
            rows = [{"engines": ["sast", "sca"], **r} for r in self.scans.get(q.get("branch"), [])]
            return {"scans": copy.deepcopy(rows), "totalCount": len(rows)}
        if u.path == "/api/results":
            rows = self.results.get(q["scan-id"], [])
            off, lim = int(q.get("offset") or 0), int(q.get("limit") or 100)
            lim = min(lim, self.page_cap) if self.page_cap else lim
            page = {"results": copy.deepcopy(rows[off:off + lim]), "totalCount": len(rows)}
            if self.omit_total:
                del page["totalCount"]
            return page
        if u.path == "/api/scan-summary":
            sid = q.get("scan-ids")
            if self.summary is None or sid not in self.summary:
                raise http_error(url, 404)
            return {"scansSummaries": [copy.deepcopy(self.summary[sid])]}
        raise http_error(url, 404)

    def paths(self):
        return [urllib.parse.urlsplit(u).path for u, _h, _d in self.calls]


class Base(unittest.TestCase):
    def setUp(self):
        checkmarx.reset_run()
        tmp = tempfile.mkdtemp()
        env = {"CHECKMARX_BASE_URL": BASE, "CHECKMARX_API_KEY": "cx-key-123", "JB_SECRETS_FILE": os.path.join(tmp, "none.env")}
        p = mock.patch.dict(os.environ, env)
        p.start()
        self.addCleanup(p.stop)
        for var in ("CHECKMARX_AUTH_URL", "CHECKMARX_URL"):
            os.environ.pop(var, None)
        ep = mock.patch.object(checkmarx, "_config_endpoints", lambda: {})
        ep.start()
        self.addCleanup(ep.stop)
        err = mock.patch.object(sys, "stderr", io.StringIO())
        self.stderr = err.start()
        self.addCleanup(err.stop)

    def fake(self, **kw):
        f = FakeCx(**kw)
        p = mock.patch.object(checkmarx, "_http", f)
        p.start()
        self.addCleanup(p.stop)
        return f


# ── classification + targets ─────────────────────────────────────────────────


class Classification(unittest.TestCase):
    def test_security_words_make_a_vulnerability_fix(self):
        for text in ("Fix CVE-2024-1234", "Checkmarx finding", "SCA alert", "SAST result", "CWE-79 in the form", "vulnerable", "OWASP top ten",
                     "dependency upgrade for log4j", "Spring4Shell"):
            with self.subTest(text=text):
                self.assertTrue(checkmarx.is_vuln_fix({"title": text}))

    def test_ordinary_tickets_are_not(self):
        for text in ("Add a dependency on the reporting team", "Blocked by a dependency", "Refactor the export page", ""):
            with self.subTest(text=text):
                self.assertFalse(checkmarx.is_vuln_fix({"title": text, "description": "<p>plain work</p>"}))

    def test_a_comment_alone_does_not_classify(self):
        self.assertFalse(checkmarx.is_vuln_fix({"title": "Refactor", "comments": [{"body": "not related to CVE-2021-44228"}]}))

    def test_labels_type_and_description_count(self):
        self.assertTrue(checkmarx.is_vuln_fix({"title": "x", "description": "<p>Closes a Checkmarx SAST finding</p>"}))
        self.assertTrue(checkmarx.is_vuln_fix({"title": "x", "labels": ["vulnerability"]}))


class Targets(unittest.TestCase):
    def test_all_four_kinds_from_title_description_comments_and_links(self):
        got = targets_of(vticket())
        self.assertEqual(got, [
            ("cve", "CVE-2021-44228"),
            ("sast", "SQL_Injection"),
            ("sast", "CWE-89"),
            ("result", "result abc123XYZ"),
            ("package", "log4j-core 2.14.1 → 2.17.1"),
            # named only in a comment: ranked last
            ("cve", "CVE-2020-9999"),
            ("package", "lodash 4.17.20"),
        ])

    def test_target_details(self):
        by = {x["target"]: x for x in checkmarx.extract_targets(vticket())}
        self.assertEqual(by["CWE-89"]["cwe"], 89)
        self.assertEqual(by["SQL_Injection"]["query"], "SQL_Injection")
        self.assertEqual(by["result abc123XYZ"]["id"], "abc123XYZ")
        self.assertEqual((by["log4j-core 2.14.1 → 2.17.1"]["package"], by["log4j-core 2.14.1 → 2.17.1"]["from"], by["log4j-core 2.14.1 → 2.17.1"]["to"]),
                         ("log4j-core", "2.14.1", "2.17.1"))

    def test_cves_are_upper_cased_and_deduplicated(self):
        self.assertEqual(targets_of({"title": "cve-2024-1234 and CVE-2024-1234 again"}), [("cve", "CVE-2024-1234")])

    def test_package_forms(self):
        cases = {
            "upgrade jackson-databind to 2.15": ("jackson-databind", None, "2.15"),
            "Bump org.apache.commons:commons-text:1.9 to 1.10.0": ("org.apache.commons:commons-text", "1.9", "1.10.0"),
            "lodash@4.17.20": ("lodash", "4.17.20", None),
            "@babel/traverse@7.22.5 is vulnerable": ("@babel/traverse", "7.22.5", None),
            "the vulnerable log4j-core 2.14.1 jar": ("log4j-core", "2.14.1", None),
            "upgrade spring-web from 5.3.18 to 5.3.20": ("spring-web", "5.3.18", "5.3.20"),
        }
        for text, (pkg, frm, to) in cases.items():
            with self.subTest(text=text):
                got = [x for x in checkmarx.extract_targets({"title": text}) if x["kind"] == "package"]
                self.assertEqual(len(got), 1, got)
                self.assertEqual((got[0]["package"], got[0]["from"], got[0]["to"]), (pkg, frm, to))

    def test_a_maven_coordinate_and_its_bare_artifact_are_one_target(self):
        got = targets_of({"title": "CVE-2018-1000613: bcprov-jdk15on 1.53 (org.bouncycastle:bcprov-jdk15on:1.53) upgrade to 1.78"})
        self.assertEqual(got, [("cve", "CVE-2018-1000613"), ("package", "org.bouncycastle:bcprov-jdk15on 1.53")])

    def test_query_names_tolerant_but_only_known_looking(self):
        got = targets_of({"title": "Stored_XSS, Reflected_XSS_All_Clients and a path traversal; sql injection too"})
        self.assertEqual(got, [("sast", "Stored_XSS"), ("sast", "Reflected_XSS_All_Clients"), ("sast", "Path_Traversal"), ("sast", "SQL_Injection")])

    def test_no_false_positives_on_ordinary_text(self):
        text = ("Updated JIRA_URL and Feature_Toggle docs; version 2.3 released; mail demo.user@example.com; release 1.2 "
                "on node 18.2; Rotate_Signing_Key; DEMO-230 2.1; see https://example.com/lib-1.2.3 and sprint 2026.11; "
                "fixVersion 2026.11; the result is id 123; Sprint_Report_Page")
        self.assertEqual(checkmarx.extract_targets({"title": text, "description": text}), [])

    def test_result_links_and_explicit_ids(self):
        t = {"title": "x", "description": "<p>similarityId: -1234567 and resultId=Zm9vYmFy</p>",
             "externalLinks": [{"url": "https://your-tenant.cxone.cloud/results/p/s/sca?resultId=Q1ZFLTIwMjQ"},
                               {"url": "https://other.example.com/page?result-id=nothing-to-see"}]}
        self.assertEqual(targets_of(t), [("result", "result -1234567"), ("result", "result Zm9vYmFy"), ("result", "result Q1ZFLTIwMjQ")])

    def test_capped(self):
        text = " ".join(f"CVE-2024-{1000 + i}" for i in range(30))
        self.assertEqual(len(checkmarx.extract_targets({"title": text})), checkmarx.MAX_TARGETS)


class Plan(unittest.TestCase):
    def test_open_pr_source_and_destination(self):
        self.assertEqual(checkmarx.scan_plan(vticket()), {"repo": "payments-service", "branch": BRANCH, "base": "develop"})

    def test_merged_pr_when_none_is_open_and_declined_never(self):
        t = vticket(prs=[
            {"state": "declined", "url": PR_URL.replace("/9", "/1"), "sourceBranch": "old", "destinationBranch": "develop"},
            {"state": "merged", "merged": True, "url": PR_URL, "sourceBranch": BRANCH, "destinationBranch": "main", "mergedAt": "2026-10-05T00:00:00Z"},
        ])
        self.assertEqual(checkmarx.scan_plan(t), {"repo": "payments-service", "branch": BRANCH, "base": "main", "mergedAt": "2026-10-05T00:00:00Z"})

    def test_branch_without_pr_needs_a_known_repo(self):
        t = vticket(prs=[])
        self.assertIsNone(checkmarx.scan_plan(t))
        self.assertEqual(checkmarx.scan_plan(t, {BRANCH: "payments-service"}), {"repo": "payments-service", "branch": BRANCH, "base": None})


class Config(Base):
    def test_auth_url_is_derived_from_the_tenant(self):
        self.assertEqual(checkmarx.urls(), (BASE, AUTH))
        self.assertTrue(checkmarx.enabled())

    def test_explicit_auth_url_wins(self):
        with mock.patch.dict(os.environ, {"CHECKMARX_AUTH_URL": "https://iam.example.com/token/"}):
            self.assertEqual(checkmarx.urls(), (BASE, "https://iam.example.com/token"))

    def test_not_configured(self):
        with mock.patch.dict(os.environ, {"CHECKMARX_BASE_URL": ""}):
            self.assertEqual(checkmarx.urls(), ("", ""))
            self.assertFalse(checkmarx.enabled())
        with mock.patch.dict(os.environ, {"CHECKMARX_API_KEY": ""}):
            self.assertFalse(checkmarx.enabled())

    def test_the_secrets_file_is_read_when_the_environment_has_nothing(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "keys.env")
            with open(path, "w") as f:
                f.write(f"CHECKMARX_BASE_URL={BASE}/\nCHECKMARX_API_KEY=from-file\n")
            with mock.patch.dict(os.environ, {"JB_SECRETS_FILE": path, "CHECKMARX_BASE_URL": "", "CHECKMARX_API_KEY": ""}):
                self.assertEqual(checkmarx.urls()[0], BASE)
                self.assertTrue(checkmarx.enabled())

    def test_runner_env_exports_the_checkmarx_keys(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "keys.env")
            with open(path, "w") as f:
                f.write("CHECKMARX_API_KEY=k1\nCHECKMARX_BASE_URL=https://t.example\nCHECKMARX_AUTH_URL=https://a.example\n")
            env = {k: v for k, v in os.environ.items() if not k.startswith("CHECKMARX_")}
            env["JB_SECRETS_FILE"] = path
            script = f'. "{INTERN}/local-runner/runner-env.sh"; load_agent_secrets; printf "%s|%s|%s" "$CHECKMARX_API_KEY" "$CHECKMARX_BASE_URL" "$CHECKMARX_AUTH_URL"'
            out = subprocess.check_output(["bash", "-c", script], env=env, text=True, cwd=ROOT)
        self.assertEqual(out, "k1|https://t.example|https://a.example")


# ── the comparison ───────────────────────────────────────────────────────────


def items_by_target(vf):
    return {i["target"]: i for i in vf["items"]}


class Compare(Base):
    def test_statuses_and_evidence(self):
        f = self.fake()
        vf = checkmarx.vuln_fixes_for(vticket())
        self.assertEqual((vf["project"], vf["branch"], vf["baseBranch"]), ("payments-service", BRANCH, "develop"))
        self.assertEqual((vf["branchScanAt"], vf["baseScanAt"]), ("2026-10-09T08:00:00Z", "2026-10-01T07:00:00Z"))
        self.assertTrue(vf["scannedAt"].endswith("Z"))
        by = items_by_target(vf)
        self.assertEqual({k: v["status"] for k, v in by.items()}, {
            "CVE-2021-44228": "fixed",
            "CVE-2020-9999": "not-found",
            "SQL_Injection": "open",
            "CWE-89": "open",
            "result abc123XYZ": "unknown",  # a per-scan result id, not a similarityId (M5)
            "log4j-core 2.14.1 → 2.17.1": "fixed",
            "lodash 4.17.20": "fixed",
        })
        cve = by["CVE-2021-44228"]
        self.assertEqual(cve["kind"], "cve")
        self.assertEqual(cve["severity"], "CRITICAL")
        self.assertEqual(cve["location"], "org.apache.logging.log4j:log4j-core 2.14.1")
        self.assertIn(f"gone on {BRANCH} (scan 2026-10-09)", cve["detail"])
        self.assertIn("was CRITICAL on develop (scan 2026-10-01)", cve["detail"])
        sqli = by["SQL_Injection"]
        self.assertEqual((sqli["severity"], sqli["location"]), ("HIGH", "/src/Dao.java:57"))
        self.assertIn(f"still on {BRANCH}", sqli["detail"])
        self.assertIn("per-scan", by["result abc123XYZ"]["detail"])
        self.assertIn("Not exploitable", by["lodash 4.17.20"]["detail"])
        self.assertIn("in neither scan", by["CVE-2020-9999"]["detail"])
        self.assertNotIn("severity", by["CVE-2020-9999"])
        # Calls: token, project, 2 scans, 2 result pages — and the key travels only in the token request body.
        self.assertEqual(f.paths().count("/api/results"), 2)
        token_calls = [c for c in f.calls if c[0].startswith(AUTH)]
        self.assertEqual(len(token_calls), 1)
        self.assertIn(b"refresh_token=cx-key-123", token_calls[0][2])
        self.assertTrue(all("cx-key-123" not in u for u, _h, _d in f.calls))

    def test_the_token_and_the_base_scan_results_are_reused_across_tickets_in_a_run(self):
        f = self.fake()
        checkmarx.vuln_fixes_for(vticket())
        checkmarx.vuln_fixes_for(vticket(key="PAY-8"))
        self.assertEqual(sum(1 for c in f.calls if c[0].startswith(AUTH)), 1)
        self.assertEqual(f.paths().count("/api/results"), 2)

    def test_branch_not_scanned_yet_is_unknown(self):
        self.fake(scans={"develop": [{"id": "s-base", "branch": "develop", "createdAt": "2026-10-01T07:00:00Z"}]})
        vf = checkmarx.vuln_fixes_for(vticket())
        self.assertEqual({i["status"] for i in vf["items"]}, {"unknown"})
        self.assertIsNone(vf["branchScanAt"])
        self.assertIn("no completed Checkmarx scan", vf["items"][0]["detail"])

    def test_no_base_scan_cannot_prove_a_fix_but_still_sees_what_is_open(self):
        self.fake(scans={BRANCH: [{"id": "s-branch", "branch": BRANCH, "createdAt": "2026-10-09T08:00:00Z"}]})
        by = items_by_target(checkmarx.vuln_fixes_for(vticket()))
        self.assertEqual(by["SQL_Injection"]["status"], "open")
        self.assertEqual(by["CVE-2021-44228"]["status"], "unknown")
        self.assertIn("nothing to compare", by["CVE-2021-44228"]["detail"])

    def test_scans_of_other_branches_are_ignored(self):
        self.fake(scans={BRANCH: [{"id": "x", "branch": "feature/other", "createdAt": "2026-10-09T08:00:00Z"}],
                         "develop": [{"id": "s-base", "branch": "develop", "createdAt": "2026-10-01T07:00:00Z"}]})
        self.assertEqual({i["status"] for i in checkmarx.vuln_fixes_for(vticket())["items"]}, {"unknown"})

    def test_the_newest_completed_scan_wins(self):
        scans = {BRANCH: [{"id": "old", "branch": BRANCH, "createdAt": "2026-10-02T00:00:00Z"},
                          {"id": "s-branch", "branch": BRANCH, "createdAt": "2026-10-09T08:00:00Z"}],
                 "develop": [{"id": "s-base", "branch": "develop", "createdAt": "2026-10-01T07:00:00Z"}]}
        self.fake(scans=scans, results={"s-branch": BRANCH_ROWS, "s-base": BASE_ROWS, "old": BASE_ROWS})
        vf = checkmarx.vuln_fixes_for(vticket())
        self.assertEqual(vf["branchScanAt"], "2026-10-09T08:00:00Z")

    def test_without_a_destination_branch_the_projects_main_branch_is_the_base(self):
        self.fake(main_branch="develop")
        t = vticket(prs=[{**vticket()["prs"][0], "destinationBranch": None}])
        self.assertEqual(checkmarx.vuln_fixes_for(t)["baseBranch"], "develop")

    def test_without_any_hint_main_master_develop_are_tried(self):
        f = self.fake(main_branch=None)
        t = vticket(prs=[{**vticket()["prs"][0], "destinationBranch": None}])
        vf = checkmarx.vuln_fixes_for(t)
        self.assertEqual(vf["baseBranch"], "develop")
        branches = [dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(u).query)).get("branch") for u, _h, _d in f.calls
                    if urllib.parse.urlsplit(u).path == "/api/scans"]
        self.assertEqual(branches, [BRANCH, "main", "master", "develop"])

    def test_no_project_is_an_answer_not_a_failure(self):
        self.fake(projects=[])
        vf = checkmarx.vuln_fixes_for(vticket())
        self.assertIn("No Checkmarx project", vf["note"])
        self.assertEqual({i["status"] for i in vf["items"]}, {"unknown"})

    def test_project_match_is_exact_or_a_path_suffix(self):
        self.fake(projects=[{"id": "p9", "name": "payments-service-legacy"}, {"id": "p1", "name": "team/payments-service", "mainBranch": "develop"}])
        self.assertEqual(checkmarx.vuln_fixes_for(vticket())["project"], "team/payments-service")

    def test_paging_is_capped_and_a_truncated_scan_cannot_say_not_found(self):
        many = [sast("Some_Other_Query", 1, f"r{i}", str(i)) for i in range(50)]
        f = self.fake(results={"s-branch": many, "s-base": many})
        with mock.patch.object(checkmarx, "PAGE_SIZE", 5), mock.patch.object(checkmarx, "MAX_PAGES", 3):
            vf = checkmarx.vuln_fixes_for(vticket(title="Fix SQL_Injection", description="", comments=[]))
        self.assertEqual(f.paths().count("/api/results"), 6)
        self.assertEqual(vf["items"][0]["status"], "unknown")
        self.assertIn("results", vf["items"][0]["detail"])

    def test_paging_reads_every_page_up_to_the_total(self):
        rows = [sast("Some_Other_Query", 1, f"r{i}", str(i)) for i in range(11)] + [sast("SQL_Injection", 89, "z", "-1")]
        f = self.fake(results={"s-branch": [], "s-base": rows})
        with mock.patch.object(checkmarx, "PAGE_SIZE", 5):
            vf = checkmarx.vuln_fixes_for(vticket(title="Fix SQL_Injection", description="", comments=[]))
        self.assertEqual(f.paths().count("/api/results"), 1 + 3)
        self.assertEqual(vf["items"][0]["status"], "fixed")

    def test_fixed_status_on_the_branch_counts_as_fixed(self):
        rows = [sast("SQL_Injection", 89, "z", "-1", status="FIXED")]
        self.fake(results={"s-branch": rows, "s-base": rows})
        vf = checkmarx.vuln_fixes_for(vticket(title="Fix SQL_Injection", description="", comments=[]))
        self.assertEqual(vf["items"][0]["status"], "fixed")

    def test_a_package_upgrade_without_from_version_is_open_while_an_older_version_remains(self):
        base = [sca("CVE-2022-42003", "Maven-com.fasterxml.jackson.core:jackson-databind-2.13.4")]
        self.fake(results={"s-branch": copy.deepcopy(base), "s-base": base})
        vf = checkmarx.vuln_fixes_for(vticket(title="SCA: upgrade jackson-databind to 2.15", description="", comments=[]))
        self.assertEqual(vf["items"][0]["status"], "open")
        self.fake(results={"s-branch": [sca("CVE-2023-1", "Maven-com.fasterxml.jackson.core:jackson-databind-2.15.2")], "s-base": base})
        checkmarx.reset_run()
        vf = checkmarx.vuln_fixes_for(vticket(title="SCA: upgrade jackson-databind to 2.15", description="", comments=[]))
        self.assertEqual(vf["items"][0]["status"], "fixed")


class Failures(Base):
    def test_token_failure_is_none(self):
        self.fake(fail={AUTH: urllib.error.URLError("down")})
        self.assertIsNone(checkmarx.vuln_fixes_for(vticket()))
        self.assertTrue(checkmarx.unreachable())

    def test_rejected_key_is_none_and_stops_asking(self):
        f = self.fake(fail={AUTH: 401})
        self.assertIsNone(checkmarx.vuln_fixes_for(vticket()))
        self.assertIsNone(checkmarx.vuln_fixes_for(vticket(key="PAY-8")))
        self.assertEqual(len(f.calls), 1)

    def test_a_results_error_is_none(self):
        self.fake(fail={f"{BASE}/api/results": 500})
        self.assertIsNone(checkmarx.vuln_fixes_for(vticket()))

    def test_the_run_budget_stops_calls(self):
        f = self.fake()
        with mock.patch.object(checkmarx, "MAX_CALLS_PER_RUN", 3):
            self.assertIsNone(checkmarx.vuln_fixes_for(vticket()))
        self.assertEqual(len(f.calls), 3)

    def test_no_targets_or_no_plan_asks_nothing(self):
        f = self.fake()
        self.assertIsNone(checkmarx.vuln_fixes_for({"key": "X-1", "title": "Checkmarx clean-up"}))
        self.assertIsNone(checkmarx.vuln_fixes_for(vticket(prs=[], branch=None)))
        self.assertEqual(f.calls, [])


# ── daily fetch ──────────────────────────────────────────────────────────────

PRIOR_VF = {"scannedAt": "2026-10-01T00:00:00Z", "project": "payments-service", "branch": BRANCH, "baseBranch": "develop",
            "items": [{"target": "CVE-2021-44228", "kind": "cve", "status": "open"}]}
FRESH_VF = {"scannedAt": "2026-10-11T00:00:00Z", "project": "payments-service", "branch": BRANCH, "baseBranch": "develop",
            "items": [{"target": "CVE-2021-44228", "kind": "cve", "status": "fixed"}]}


class DailyFetchVulnFixes(unittest.TestCase):
    def run_apply(self, t=None, *, enabled=True, result=None, prior=None, dev=None):
        t = t if t is not None else vticket()
        calls = []

        def fake_for(ticket, targets=None, repos=None):
            calls.append((ticket["key"], [x["target"] for x in targets or []], repos))
            return copy.deepcopy(result)

        with mock.patch.object(daily_fetch.checkmarx, "enabled", lambda: enabled), \
                mock.patch.object(daily_fetch.checkmarx, "vuln_fixes_for", fake_for), \
                mock.patch.object(daily_fetch, "DEV", dev if dev is not None else {"PAY-7": {"repos": {BRANCH: "payments-service"}}}):
            out = daily_fetch.apply_vuln_fixes(t, t["key"], prior)
        return out, calls

    def test_fresh_results_replace_the_old_ones(self):
        out, calls = self.run_apply(result=FRESH_VF, prior={"vulnFixes": PRIOR_VF})
        self.assertEqual(out["vulnFixes"], FRESH_VF)
        self.assertEqual(calls[0][0], "PAY-7")
        self.assertIn("CVE-2021-44228", calls[0][1])
        self.assertEqual(calls[0][2], {BRANCH: "payments-service"})

    def test_a_failed_lookup_keeps_the_prior_results(self):
        out, _ = self.run_apply(result=None, prior={"vulnFixes": PRIOR_VF})
        self.assertEqual(out["vulnFixes"], PRIOR_VF)

    def test_a_failed_lookup_on_a_carried_ticket_keeps_its_own(self):
        out, _ = self.run_apply(vticket(vulnFixes=PRIOR_VF), result=None)
        self.assertEqual(out["vulnFixes"], PRIOR_VF)

    def test_failed_with_nothing_before_writes_nothing(self):
        out, _ = self.run_apply(result=None, prior={})
        self.assertNotIn("vulnFixes", out)

    def test_checkmarx_not_configured_is_silent_and_keeps_prior(self):
        out, calls = self.run_apply(enabled=False, result=FRESH_VF, prior={"vulnFixes": PRIOR_VF})
        self.assertEqual((out["vulnFixes"], calls), (PRIOR_VF, []))

    def test_only_vulnerability_fix_tickets(self):
        plain = vticket(title="Refactor the export page", description="<p>Move code around</p>", labels=[], comments=[])
        out, calls = self.run_apply(plain, result=FRESH_VF, prior={"vulnFixes": PRIOR_VF})
        self.assertEqual(calls, [])
        self.assertNotIn("vulnFixes", out)

    def test_a_vulnerability_ticket_naming_nothing_has_no_field(self):
        t = vticket(title="Checkmarx findings clean-up", description="<p>Look at the dashboard</p>", comments=[])
        out, calls = self.run_apply(t, result=FRESH_VF, prior={"vulnFixes": PRIOR_VF})
        self.assertEqual(calls, [])
        self.assertNotIn("vulnFixes", out)

    def test_no_pull_request_or_known_branch_has_no_field(self):
        out, calls = self.run_apply(vticket(prs=[], branch=None, branches=[]), result=FRESH_VF, prior={"vulnFixes": PRIOR_VF})
        self.assertEqual(calls, [])
        self.assertNotIn("vulnFixes", out)

    def test_a_subtask_on_its_parents_branch_gets_nothing(self):
        dev = {
            "PAY-7": {"branches": [BRANCH], "prs": [], "times": {}, "repos": {BRANCH: "payments-service"}},
            "PAY-9": {"branches": [BRANCH], "prs": [], "times": {}, "repos": {BRANCH: "payments-service"}},
        }
        with mock.patch.object(daily_fetch, "DEV", dev), mock.patch.object(daily_fetch, "BB_OK", False):
            sub = daily_fetch.apply_code({"key": "PAY-9", "parentKey": "PAY-7", "title": "Fix CVE-2021-44228 (sub-task)"}, "PAY-9", {})
        self.assertEqual(sub["branches"], [])
        out, calls = self.run_apply(sub, result=FRESH_VF, dev=dev)
        self.assertEqual(calls, [])
        self.assertNotIn("vulnFixes", out)

    def test_the_fast_path_refreshes_vuln_fixes_on_an_unchanged_ticket(self):
        prior = vticket(lastUpdate="2026-03-01T10:00:00Z", vulnFixes=PRIOR_VF)
        issue = {"key": "PAY-7", "id": "1", "fields": {"status": {"name": "In Review"}, "updated": "2026-03-01T10:00:00.000+0000"}}
        state = {"status": "In Review", "last_update": "2026-03-01T10:00:00Z"}
        seen = []
        with mock.patch.object(daily_fetch, "apply_code", lambda t, k, prior=None: t), \
                mock.patch.object(daily_fetch, "apply_builds", lambda t, k, prior=None: t), \
                mock.patch.object(daily_fetch, "apply_vuln_fixes", lambda t, k, prior=None: seen.append(k) or {**t, "vulnFixes": FRESH_VF}):
            out = daily_fetch.build_ticket(issue, prior, state)
        self.assertEqual(seen, ["PAY-7"])
        self.assertEqual(out["vulnFixes"], FRESH_VF)

    def test_merge_ticket_replaces_every_copy_with_the_field(self):
        data = {"tickets": [{"key": "PAY-1", "subtasks": [{"key": "PAY-7"}]}, {"key": "PAY-7"}], "completed": []}
        daily_fetch._merge_ticket(data, {"key": "PAY-7", "vulnFixes": FRESH_VF})
        self.assertEqual(data["tickets"][1]["vulnFixes"], FRESH_VF)
        self.assertEqual(data["tickets"][0]["subtasks"][0]["vulnFixes"], FRESH_VF)


class ArchiveKeepsVulnFixes(unittest.TestCase):
    def test_completed_rows_keep_the_field(self):
        import completed_archive

        self.assertIn("vulnFixes", completed_archive.COMPLETED_KEYS)
        row = completed_archive.completed_entry({"key": "PAY-7", "title": "x", "vulnFixes": FRESH_VF})
        self.assertEqual(row["vulnFixes"], FRESH_VF)

    def test_carry_prefers_the_cached_row_then_the_board_copy(self):
        import completed_archive

        known = completed_archive.known_vuln_fixes({"tickets": [{"key": "PAY-7", "vulnFixes": PRIOR_VF, "subtasks": [{"key": "PAY-9", "vulnFixes": FRESH_VF}]}],
                                                    "completed": [{"key": "PAY-1", "vulnFixes": FRESH_VF}]})
        self.assertEqual(set(known), {"PAY-7", "PAY-9", "PAY-1"})
        t = {"key": "PAY-7"}
        completed_archive.carry_vuln_fixes(t, {"vulnFixes": FRESH_VF}, known)
        self.assertEqual(t["vulnFixes"], FRESH_VF)
        t = {"key": "PAY-7"}
        completed_archive.carry_vuln_fixes(t, None, known)
        self.assertEqual(t["vulnFixes"], PRIOR_VF)
        t = {"key": "PAY-2"}
        completed_archive.carry_vuln_fixes(t, None, known)
        self.assertNotIn("vulnFixes", t)


class DemoData(unittest.TestCase):
    """The demo board's vulnFixes must be what checkmarx.py would store for those tickets."""

    def test_demo_targets_are_what_the_extractor_finds(self):
        with open(os.path.join(INTERN, "demo", "data.json"), encoding="utf-8") as f:
            demo = json.load(f)
        seen = 0
        for t in demo["tickets"]:
            if not t.get("vulnFixes"):
                continue
            seen += 1
            with self.subTest(key=t["key"]):
                self.assertTrue(checkmarx.is_vuln_fix(t))
                self.assertIsNotNone(checkmarx.scan_plan(t))
                self.assertEqual([(i["kind"], i["target"]) for i in t["vulnFixes"]["items"]], targets_of(t))
                self.assertEqual(t["vulnFixes"]["branch"], t["branch"])
                rep = pr_report.build_base(t, "active", {"app": {"requiredApprovals": 2}})
                self.assertEqual(pr_report.validate_report(rep, t), [])
        self.assertGreaterEqual(seen, 3)


# ── PR readiness report ──────────────────────────────────────────────────────

GATE = "Security scan (Checkmarx) clean"


def item(target, kind, status, severity=None, detail=None, location=None):
    out = {"target": target, "kind": kind, "status": status}
    if severity:
        out["severity"] = severity
    if location:
        out["location"] = location
    if detail:
        out["detail"] = detail
    return out


def vf(*items, note=None):
    out = {"scannedAt": "2026-10-11T06:00:00Z", "project": "payments-service", "branch": BRANCH, "baseBranch": "develop",
           "branchScanAt": "2026-10-09T08:00:00Z", "baseScanAt": "2026-10-01T07:00:00Z", "items": list(items)}
    if note:
        out["note"] = note
    return out


FIXED_CVE = item("CVE-2021-44228", "cve", "fixed", "CRITICAL", f"Fixed — gone on {BRANCH} (scan 2026-10-09) · was CRITICAL on develop (scan 2026-10-01)",
                 "org.apache.logging.log4j:log4j-core 2.14.1")
FIXED_PKG = item("log4j-core 2.14.1 → 2.17.1", "package", "fixed", "CRITICAL", "Fixed — gone", "org.apache.logging.log4j:log4j-core 2.14.1")
OPEN_SAST = item("SQL_Injection", "sast", "open", "HIGH", f"Open — still on {BRANCH} (scan 2026-10-09)", "/src/Dao.java:57")
NOT_FOUND = item("CVE-2020-9999", "cve", "not-found", detail="Not found — in neither scan")
UNKNOWN = item("result abc", "result", "unknown", detail="Unknown — feature not scanned")


def gate_row(rep, name=GATE):
    for tab in rep["tabs"]:
        for b in tab.get("blocks") or []:
            if b.get("title") == "Gate checklist":
                for row in b["rows"]:
                    if row["cells"][0] == name:
                        return row
    raise AssertionError(name)


def evidence_rows(rep):
    tab = next(t for t in rep["tabs"] if t["id"] == "evidence")
    return tab["blocks"][0]["rows"]


class ReportSecurityGate(unittest.TestCase):
    CFG = {"app": {"requiredApprovals": 2}}

    def base(self, t):
        rep = pr_report.build_base(t, "active", self.CFG)
        self.assertEqual(pr_report.validate_report(rep, t), [])
        return rep

    def test_every_target_fixed_passes(self):
        rep = self.base(vticket(vulnFixes=vf(FIXED_CVE, FIXED_PKG)))
        row = gate_row(rep)
        self.assertEqual((row["cells"][1], row["tone"]), ("Pass", "success"))
        self.assertIn("2 of 2 fixed", row["cells"][2])
        rows = [r for r in evidence_rows(rep) if r["cells"][0].startswith("Checkmarx")]
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["tone"], "success")
        self.assertIn("CVE-2021-44228", rows[0]["cells"][1])
        self.assertIn("CRITICAL", rows[0]["cells"][1])
        self.assertIn("log4j-core 2.14.1", rows[0]["cells"][1])
        self.assertIn("was CRITICAL on develop", rows[0]["cells"][2])

    def test_any_open_fails_and_names_it(self):
        rep = self.base(vticket(vulnFixes=vf(FIXED_CVE, OPEN_SAST, NOT_FOUND)))
        row = gate_row(rep)
        self.assertEqual(row["cells"][1], "Fail")
        self.assertIn("1 of 3 fixed", row["cells"][2])
        self.assertIn("SQL_Injection still open", row["cells"][2])
        opened = next(r for r in evidence_rows(rep) if "SQL_Injection" in r["cells"][1])
        self.assertEqual(opened["tone"], "danger")
        self.assertIn("/src/Dao.java:57", opened["cells"][1])

    def test_not_found_or_unknown_is_not_verified_and_says_why(self):
        row = gate_row(self.base(vticket(vulnFixes=vf(FIXED_CVE, NOT_FOUND, UNKNOWN))))
        self.assertEqual((row["cells"][1], row["tone"]), ("Not verified", "neutral"))
        self.assertIn("1 not found in either scan", row["cells"][2])
        self.assertIn("1 unknown", row["cells"][2])

    def test_a_note_explains_an_all_unknown_result(self):
        row = gate_row(self.base(vticket(vulnFixes=vf(UNKNOWN, note="No Checkmarx project named payments-service"))))
        self.assertEqual(row["cells"][1], "Not verified")
        self.assertIn("No Checkmarx project", row["cells"][2])

    def test_security_ticket_without_results_yet(self):
        row = gate_row(self.base(vticket()))
        self.assertEqual(row["cells"][1], "Not verified")
        self.assertIn("not read", row["cells"][2].lower())

    def test_security_ticket_naming_nothing(self):
        row = gate_row(self.base(vticket(title="Checkmarx clean-up", description="<p>see dashboard</p>", comments=[])))
        self.assertEqual(row["cells"][1], "Not verified")
        self.assertIn("names no CVE", row["cells"][2])

    def test_not_a_vulnerability_fix(self):
        # Nothing to scan is "Not required" (grey, left out of the gate count) — not an amber "Not verified" gap.
        row = gate_row(self.base(vticket(title="Refactor", description="<p>x</p>", labels=[], comments=[])))
        self.assertEqual((row["cells"][1], row["tone"]), ("Not required", "neutral"))
        self.assertEqual(row["cells"][3], "No")
        self.assertIn("Not a vulnerability-fix ticket", row["cells"][2])
        self.assertEqual(pr_report.NOT_REQUIRED, "Not required")

    def test_the_verdict_and_score_do_not_move(self):
        a = self.base(vticket(vulnFixes=vf(FIXED_CVE)))["verdict"]
        b = self.base(vticket(vulnFixes=vf(OPEN_SAST)))["verdict"]
        self.assertEqual((a["id"], a["score"]), (b["id"], b["score"]))

    def test_sources_and_warnings_mention_checkmarx_only_when_it_is_there(self):
        rep = self.base(vticket(vulnFixes=vf(FIXED_CVE)))
        self.assertIn("Checkmarx (last fetch)", rep["sources"])
        self.assertNotIn("Checkmarx", " ".join(rep["warnings"]))
        rep = self.base(vticket())
        self.assertIn("Checkmarx", " ".join(rep["warnings"]))

    def test_fingerprint_moves_with_results_but_tickets_without_keep_theirs(self):
        t = vticket(vulnFixes=vf(OPEN_SAST))
        t2 = vticket(vulnFixes=vf({**OPEN_SAST, "status": "fixed"}))
        self.assertNotEqual(pr_report.fingerprint(t), pr_report.fingerprint(t2))
        bare = vticket()
        self.assertEqual(pr_report.fingerprint(bare), pr_report.fingerprint({**bare, "vulnFixes": None}))
        sig = {"status": bare["status"], "fix": ["1.0"],
               "prs": sorted([["9", "approved", 2, 0, False, None, "2026-10-10T00:00:00Z", "develop"]], key=str), "subtasks": []}
        import hashlib
        self.assertEqual(pr_report.fingerprint(bare), hashlib.sha1(json.dumps(sig, sort_keys=True).encode()).hexdigest()[:16])

    def test_proof_rows_for_the_worker(self):
        rows = pr_report.vuln_proof_rows(vticket(vulnFixes=vf(FIXED_CVE, OPEN_SAST, NOT_FOUND, UNKNOWN)))
        self.assertEqual([(r["check"], r["result"], r["tone"]) for r in rows], [
            ("CVE-2021-44228", "Fixed", "success"), ("SQL_Injection", "Still open", "danger"),
            ("CVE-2020-9999", "Not found", "warning"), ("result abc", "Unknown", "neutral"),
        ])
        self.assertTrue(all("still open (SCA)" not in r["detail"] for r in rows))
        self.assertEqual(pr_report.vuln_proof_rows(vticket(title="Refactor", description="", labels=[], comments=[])), [])

    def test_gate_evidence_fits_the_worker_cell(self):
        many = vf(*[item(f"CVE-2024-{1000 + i}", "cve", "open", "HIGH", "Open") for i in range(12)])
        state, evidence, _tone = pr_report.vuln_gate(vticket(vulnFixes=many))
        self.assertEqual(state, "Fail")
        self.assertLessEqual(len(evidence), 180)


class WorkerSecurityProof(unittest.TestCase):
    """The AI worker reuses checkmarx.py + pr_report.vuln_gate: no second Checkmarx client, no divergence."""

    @classmethod
    def setUpClass(cls):
        os.environ.setdefault("INTERN_DIR", INTERN)
        sys.path.insert(0, os.path.join(ROOT, "ai-intern"))
        import worker  # noqa: E402

        cls.w = worker

    def no_ci(self):
        return mock.patch.object(self.w, "bitbucket_ci", return_value={"state": "Not verified", "detail": "No Bitbucket token", "error": True})

    def test_the_worker_has_no_checkmarx_client_of_its_own(self):
        for name in ("checkmarx_urls", "_checkmarx_token", "_cx_get", "checkmarx_proof", "_sev_count"):
            self.assertFalse(hasattr(self.w, name), name)

    def test_classification_is_checkmarx_py(self):
        self.assertIn("security", self.w.classify_ticket(vticket()))
        self.assertNotIn("security", self.w.classify_ticket({"title": "Blocked by a dependency"}))

    def test_stored_results_are_used_without_a_live_call_and_the_gate_matches_the_base(self):
        t = vticket(vulnFixes=vf(FIXED_CVE, OPEN_SAST))
        base = pr_report.build_base(t, "active", {"app": {"requiredApprovals": 2}})
        with self.no_ci(), mock.patch.object(checkmarx, "vuln_fixes_for", side_effect=AssertionError("no live call")):
            proof = self.w.collect_class_proof(t)
        self.assertEqual(proof["title"], "Proof · vulnerability fix")
        checks = [r["check"] for r in proof["rows"]]
        self.assertEqual(checks[1:], ["CVE-2021-44228", "SQL_Injection"])
        self.assertNotIn("Checkmarx", checks)
        merged = copy.deepcopy(base)
        self.w.apply_class_proof(merged, proof)
        self.assertEqual(gate_row(merged), gate_row(base))
        self.assertEqual(pr_report.validate_report(merged, t, base), [])

    def test_without_stored_results_the_worker_looks_up_live_with_the_same_module(self):
        t = vticket()
        with self.no_ci(), mock.patch.object(checkmarx, "enabled", return_value=True), \
                mock.patch.object(checkmarx, "vuln_fixes_for", return_value=vf(FIXED_CVE)) as live:
            proof = self.w.collect_class_proof(t)
        live.assert_called_once()
        base = pr_report.build_base(t, "active", {"app": {"requiredApprovals": 2}})
        merged = copy.deepcopy(base)
        self.w.apply_class_proof(merged, proof)
        self.assertEqual(gate_row(merged)["cells"][1], "Pass")
        self.assertEqual(pr_report.validate_report(merged, t, base), [])

    def test_a_failed_live_lookup_is_a_warning_not_a_verdict(self):
        with self.no_ci(), mock.patch.object(checkmarx, "enabled", return_value=True), \
                mock.patch.object(checkmarx, "vuln_fixes_for", return_value=None):
            proof = self.w.collect_class_proof(vticket())
        self.assertIn("Checkmarx was not read.", proof["warnings"])
        self.assertEqual(proof["securityGate"][0], "Not verified")

    def test_non_security_tickets_get_the_base_gate_text(self):
        t = vticket(title="Refactor", description="<p>x</p>", labels=[], comments=[])
        base = pr_report.build_base(t, "active", {"app": {"requiredApprovals": 2}})
        with self.no_ci():
            proof = self.w.collect_class_proof(t)
        merged = copy.deepcopy(base)
        self.w.apply_class_proof(merged, proof)
        self.assertEqual(gate_row(merged), gate_row(base))


if __name__ == "__main__":
    unittest.main()


# ── security review fixes ────────────────────────────────────────────────────


def scan(sid, branch, created, engines=("sast", "sca")):
    return {"id": sid, "branch": branch, "status": "Completed", "createdAt": created, "engines": list(engines)}


class EngineAwareScans(Base):
    """H1: a target is judged only by a scan that ran its engine (sca for cve/package, sast for sast/result)."""

    def test_the_newest_scan_with_the_targets_engine_is_used(self):
        scans = {BRANCH: [scan("s-sast", BRANCH, "2026-10-10T00:00:00Z", ("sast",)), scan("s-branch", BRANCH, "2026-10-09T08:00:00Z")],
                 "develop": [scan("s-base", "develop", "2026-10-01T07:00:00Z")]}
        self.fake(scans=scans, results={"s-sast": [], "s-branch": [sca("CVE-2021-44228", "Maven-org.apache.logging.log4j:log4j-core-2.14.1")],
                                        "s-base": BASE_ROWS})
        by = items_by_target(checkmarx.vuln_fixes_for(vticket(title="Fix CVE-2021-44228 and SQL_Injection", description="", comments=[])))
        self.assertEqual(by["CVE-2021-44228"]["status"], "open")  # from the older SCA scan, not the SAST-only one
        self.assertEqual(by["SQL_Injection"]["status"], "fixed")  # from the newest (SAST) scan

    def test_a_branch_without_an_sca_scan_is_unknown_for_a_cve(self):
        scans = {BRANCH: [scan("s-branch", BRANCH, "2026-10-09T08:00:00Z", ("sast",))],
                 "develop": [scan("s-base", "develop", "2026-10-01T07:00:00Z")]}
        self.fake(scans=scans, results={"s-branch": [], "s-base": BASE_ROWS})
        item = checkmarx.vuln_fixes_for(vticket(title="Fix CVE-2021-44228", description="", comments=[]))["items"][0]
        self.assertEqual(item["status"], "unknown")
        self.assertIn("did not run SCA", item["detail"])

    def test_a_base_without_an_sca_scan_cannot_prove_a_cve_fix(self):
        scans = {BRANCH: [scan("s-branch", BRANCH, "2026-10-09T08:00:00Z")],
                 "develop": [scan("s-base", "develop", "2026-10-01T07:00:00Z", ("sast",))]}
        self.fake(scans=scans, results={"s-branch": [], "s-base": BASE_ROWS})
        item = checkmarx.vuln_fixes_for(vticket(title="Fix CVE-2021-44228", description="", comments=[]))["items"][0]
        self.assertEqual(item["status"], "unknown")
        self.assertIn("SCA", item["detail"])


class SecurityReviewDecisions(Base):
    def test_h2_a_from_only_package_is_open_while_any_version_has_an_open_finding(self):
        base = [sca("CVE-2021-23337", "Npm-lodash-4.17.20")]
        self.fake(results={"s-branch": [sca("CVE-2099-1", "Npm-lodash-4.17.21")], "s-base": base})
        item = checkmarx.vuln_fixes_for(vticket(title="SCA: lodash@4.17.20", description="", comments=[]))["items"][0]
        self.assertEqual(item["status"], "open")

    def test_h2_a_from_only_package_upgraded_with_no_open_finding_is_fixed(self):
        base = [sca("CVE-2021-23337", "Npm-lodash-4.17.20")]
        self.fake(results={"s-branch": [], "s-base": base})
        item = checkmarx.vuln_fixes_for(vticket(title="SCA: lodash@4.17.20", description="", comments=[]))["items"][0]
        self.assertEqual(item["status"], "fixed")

    def test_m3_a_branch_scan_older_than_the_base_scan_cannot_prove_a_fix(self):
        scans = {BRANCH: [scan("s-branch", BRANCH, "2026-09-01T00:00:00Z")], "develop": [scan("s-base", "develop", "2026-10-01T07:00:00Z")]}
        self.fake(scans=scans)
        item = checkmarx.vuln_fixes_for(vticket(title="Fix CVE-2021-44228", description="", comments=[]))["items"][0]
        self.assertEqual(item["status"], "unknown")
        self.assertIn("branch scan older than base", item["detail"])

    def test_m4_a_lone_search_hit_with_another_name_is_no_project(self):
        self.fake(projects=[{"id": "p9", "name": "payments-service-legacy"}])
        vf = checkmarx.vuln_fixes_for(vticket())
        self.assertIn("No Checkmarx project", vf["note"])
        self.assertEqual({i["status"] for i in vf["items"]}, {"unknown"})

    def test_m5_a_result_target_matches_on_similarity_id(self):
        self.fake()
        item = checkmarx.vuln_fixes_for(vticket(title="Fix similarityId: 7777", description="", comments=[]))["items"][0]
        self.assertEqual(item["status"], "not-found")
        self.fake(results={"s-branch": [], "s-base": [sast("Stored_XSS", 79, "r1", "7777")]})
        checkmarx.reset_run()
        item = checkmarx.vuln_fixes_for(vticket(title="Fix similarityId: 7777", description="", comments=[]))["items"][0]
        self.assertEqual(item["status"], "fixed")

    def test_m5_only_a_per_scan_id_in_the_base_is_unknown(self):
        self.fake()
        item = checkmarx.vuln_fixes_for(vticket(title="Fix resultId=abc123XYZ", description="", comments=[]))["items"][0]
        self.assertEqual(item["status"], "unknown")
        self.assertIn("per-scan", item["detail"])

    def test_l1_any_token_endpoint_failure_marks_checkmarx_down(self):
        f = self.fake(fail={AUTH: 500})
        self.assertIsNone(checkmarx.vuln_fixes_for(vticket()))
        self.assertTrue(checkmarx.unreachable())
        self.assertIsNone(checkmarx.vuln_fixes_for(vticket(key="PAY-8")))
        self.assertEqual(len(f.calls), 1)

    def test_l2_an_isolated_lookup_holds_the_run_lock(self):
        self.fake()
        held = []
        real = checkmarx.vuln_fixes_for

        def spy(*a, **kw):
            held.append(checkmarx.RUN_LOCK.locked())
            return real(*a, **kw)

        with mock.patch.object(checkmarx, "vuln_fixes_for", spy):
            self.assertIsNotNone(checkmarx.isolated_lookup(vticket()))
        self.assertEqual(held, [True])
        with open(os.path.join(ROOT, "ai-intern", "worker.py"), encoding="utf-8") as fh:
            src = fh.read()
        self.assertIn("checkmarx.isolated_lookup(", src)
        self.assertNotIn("checkmarx.reset_run()", src)


class SafeRedirects(unittest.TestCase):
    """M1: never follow a redirect to another host or from https to http (credentials must not travel)."""

    def setUp(self):
        import _safe_http
        self.h = _safe_http.SameOriginRedirect()
        self.mod = _safe_http

    def req(self):
        return urllib.request.Request("https://cx.example.com/api/x", headers={"Authorization": "Bearer t"})

    def test_cross_host_is_refused(self):
        with self.assertRaises(urllib.error.HTTPError) as cm:
            self.h.redirect_request(self.req(), None, 302, "Found", {}, "https://evil.example.net/steal")
        self.assertEqual(cm.exception.code, 302)

    def test_https_to_http_is_refused(self):
        with self.assertRaises(urllib.error.HTTPError):
            self.h.redirect_request(self.req(), None, 301, "Moved", {}, "http://cx.example.com/api/x")

    def test_same_origin_is_followed_with_the_header(self):
        new = self.h.redirect_request(self.req(), None, 302, "Found", {}, "/api/y")
        self.assertEqual(new.full_url, "https://cx.example.com/api/y")
        self.assertEqual(new.get_header("Authorization"), "Bearer t")

    def test_checkmarx_uses_the_safe_opener(self):
        handlers = checkmarx._opener().handlers
        self.assertTrue(any(isinstance(h, self.mod.SameOriginRedirect) for h in handlers))
        self.assertFalse(any(type(h) is urllib.request.HTTPRedirectHandler for h in handlers))


class CommentTargets(unittest.TestCase):
    """L5: targets named only in comments rank last; negated mentions are ignored."""

    def test_comment_targets_rank_last(self):
        t = {"title": "Fix CVE-2021-1111", "description": "<p>Also SQL_Injection.</p>",
             "comments": [{"body": "<p>CVE-2021-2222 too</p>"}]}
        self.assertEqual(targets_of(t), [("cve", "CVE-2021-1111"), ("sast", "SQL_Injection"), ("cve", "CVE-2021-2222")])

    def test_negated_mentions_are_ignored(self):
        t = {"title": "Fix CVE-2021-1111", "description": "<p>This is not CVE-2020-0001; unrelated to CVE-2020-0002. CVE-2020-0003 is unrelated.</p>",
             "comments": [{"body": "<p>Not lodash@4.17.20.</p>"}]}
        self.assertEqual(targets_of(t), [("cve", "CVE-2021-1111")])


# ── why "not found" must be believable ───────────────────────────────────────
# A real run reported "in neither scan" for every target of a vulnerability-fix ticket. These pin the
# behaviours that make that answer honest: paging that survives a server which caps the page size,
# every severity matched, and a detail that says WHAT was read.

LIB = "Maven-org.acme.web:acme-web-core-"


def noise(n, severity="LOW"):
    return [sca(f"CVE-2023-{1000 + i}", "Npm-lodash-4.17.20", severity) for i in range(n)]


def only(title, **extra):
    return vticket(title=title, description="", comments=[], **extra)


class Paging(Base):
    def test_a_server_that_caps_the_page_size_is_read_to_the_end(self):
        rows = noise(50) + [sca("CVE-2024-5555", LIB + "1.2.3", "CRITICAL")] + noise(4)
        f = self.fake(page_cap=20, results={"s-branch": [], "s-base": rows})
        vf = checkmarx.vuln_fixes_for(only("Fix CVE-2024-5555"))
        self.assertEqual(vf["items"][0]["status"], "fixed")
        self.assertEqual(f.paths().count("/api/results"), 1 + 3)  # branch: one empty page; base: 20 + 20 + 15
        self.assertEqual(vf["read"]["base"]["total"], 55)
        self.assertFalse(vf["read"]["base"]["truncated"])

    def test_a_server_that_omits_totalcount_is_read_until_an_empty_page(self):
        rows = noise(50) + [sca("CVE-2024-5555", LIB + "1.2.3", "CRITICAL")] + noise(4)
        f = self.fake(page_cap=20, omit_total=True, results={"s-branch": [], "s-base": rows})
        vf = checkmarx.vuln_fixes_for(only("Fix CVE-2024-5555"))
        self.assertEqual(vf["items"][0]["status"], "fixed")
        self.assertEqual(f.paths().count("/api/results"), 1 + 4)  # …and the empty page that proves the end
        self.assertFalse(vf["read"]["base"]["truncated"])

    def test_a_capped_server_and_the_page_limit_is_truncated_not_not_found(self):
        f = self.fake(page_cap=2, results={"s-branch": noise(11), "s-base": noise(11)})
        with mock.patch.object(checkmarx, "PAGE_SIZE", 5), mock.patch.object(checkmarx, "MAX_PAGES", 2):
            vf = checkmarx.vuln_fixes_for(only("Fix CVE-2024-5555"))
        self.assertEqual(f.paths().count("/api/results"), 4)
        self.assertEqual(vf["items"][0]["status"], "unknown")
        self.assertIn("more results than the board reads", vf["items"][0]["detail"])
        self.assertEqual(vf["read"]["branch"], {"total": 4, "sca": 4, "sast": 0, "other": 0, "truncated": True, "reported": 11})

    def test_an_empty_page_before_the_reported_total_is_truncated_too(self):
        class Lying(FakeCx):
            def __call__(self, url, headers, data=None, timeout=None):
                out = super().__call__(url, headers, data, timeout)
                if urllib.parse.urlsplit(url).path == "/api/results":
                    out["totalCount"] = 500  # says there is more, then serves nothing
                return out

        f = Lying(results={"s-branch": noise(3), "s-base": noise(3)})
        p = mock.patch.object(checkmarx, "_http", f)
        p.start()
        self.addCleanup(p.stop)
        vf = checkmarx.vuln_fixes_for(only("Fix CVE-2024-5555"))
        self.assertEqual(vf["items"][0]["status"], "unknown")
        self.assertTrue(vf["read"]["branch"]["truncated"])

    def test_low_and_info_severity_results_are_read_and_matched(self):
        rows = [sca("CVE-2024-1001", LIB + "1.2.3", "LOW"), sca("CVE-2024-1002", LIB + "1.2.3", "INFO")]
        f = self.fake(results={"s-branch": [], "s-base": rows})
        by = items_by_target(checkmarx.vuln_fixes_for(only("Fix CVE-2024-1001 and CVE-2024-1002")))
        self.assertEqual({k: (v["status"], v["severity"]) for k, v in by.items()},
                         {"CVE-2024-1001": ("fixed", "LOW"), "CVE-2024-1002": ("fixed", "INFO")})
        results_urls = [u for u, _h, _d in f.calls if urllib.parse.urlsplit(u).path == "/api/results"]
        self.assertTrue(results_urls)
        self.assertTrue(all("severity" not in u and "state" not in u for u in results_urls), results_urls)

    def test_a_cve_name_is_matched_whatever_its_case_spacing_or_place(self):
        rows = [{**sca("x", LIB + "1.2.3"), "vulnerabilityDetails": {"cveName": " cve-2024-1001 "}},
                {**sca("x", LIB + "1.2.3"), "vulnerabilityDetails": {"cveId": "CVE-2024-1002"}},
                {"type": "sca", "id": "CVE-2024-1003", "similarityId": "s3", "severity": "LOW", "data": {"packageIdentifier": LIB + "1.2.3"}}]
        self.fake(results={"s-branch": [], "s-base": rows})
        by = items_by_target(checkmarx.vuln_fixes_for(only("Fix CVE-2024-1001, CVE-2024-1002 and CVE-2024-1003")))
        self.assertEqual({k: v["status"] for k, v in by.items()}, {"CVE-2024-1001": "fixed", "CVE-2024-1002": "fixed", "CVE-2024-1003": "fixed"})

    def test_scan_results_keeps_its_old_shape(self):
        self.fake(results={"s-base": noise(3)})
        rows, truncated = checkmarx.scan_results("s-base")
        self.assertEqual((len(rows), truncated), (3, False))


class SelfExplaining(Base):
    def test_not_found_says_what_was_read(self):
        self.fake()
        vf = checkmarx.vuln_fixes_for(vticket())
        d = items_by_target(vf)["CVE-2020-9999"]["detail"]
        self.assertIn("in neither scan", d)
        self.assertIn(f"Read 2 results on {BRANCH} (SCA 1 · SAST 1)", d)
        self.assertIn("5 results on develop (SCA 2 · SAST 2 · other 1)", d)
        self.assertEqual(vf["read"], {
            "branch": {"total": 2, "sca": 1, "sast": 1, "other": 0, "truncated": False, "reported": 2},
            "base": {"total": 5, "sca": 2, "sast": 2, "other": 1, "truncated": False, "reported": 5},
        })

    def test_zero_results_are_called_out(self):
        self.fake(results={"s-branch": [], "s-base": []})
        vf = checkmarx.vuln_fixes_for(only("Fix CVE-2024-5555"))
        item = vf["items"][0]
        self.assertEqual(item["status"], "not-found")
        self.assertIn("0 results on", item["detail"])
        self.assertIn("the results API returned nothing for this scan", item["detail"])
        self.assertIn("returned 0 results", vf["note"])  # the gate shows the note

    def test_one_side_empty_is_in_the_note(self):
        self.fake(results={"s-branch": noise(3), "s-base": []})
        vf = checkmarx.vuln_fixes_for(only("Fix CVE-2024-5555"))
        self.assertIn("0 results for the base scan", vf["note"])

    def test_a_package_item_lists_the_versions_seen_on_each_side(self):
        base = [sca("CVE-2024-1001", LIB + "6.5.7")]
        branch = [sca("CVE-2024-9001", LIB + "6.5.9")]  # another finding, on the new version
        self.fake(results={"s-branch": branch, "s-base": base})
        item = checkmarx.vuln_fixes_for(only("SCA: upgrade acme-web-core to 6.5.9"))["items"][0]
        self.assertEqual(item["status"], "fixed")
        self.assertEqual((item["foundOnBase"], item["foundOnBranch"]), (["6.5.7"], ["6.5.9"]))

    def test_a_base_that_already_runs_the_target_version_predates_the_fix(self):
        rows = [sca("CVE-2024-9001", LIB + "6.5.9")]
        self.fake(results={"s-branch": copy.deepcopy(rows), "s-base": rows})
        item = checkmarx.vuln_fixes_for(only("SCA: upgrade acme-web-core to 6.5.9"))["items"][0]
        self.assertEqual(item["status"], "not-found")  # a finding on the new version is not what the ticket fixes
        self.assertIn("already at 6.5.9 on develop", item["detail"])
        self.assertIn("predates the base scan", item["detail"])
        self.assertEqual((item["foundOnBase"], item["foundOnBranch"]), (["6.5.9"], ["6.5.9"]))

    def test_a_cve_not_found_names_the_package_that_is_already_upgraded(self):
        rows = [sca("CVE-2024-9001", LIB + "6.5.9")]
        self.fake(results={"s-branch": copy.deepcopy(rows), "s-base": rows})
        by = items_by_target(checkmarx.vuln_fixes_for(only("Fix CVE-2024-1001: upgrade acme-web-core to 6.5.9")))
        self.assertEqual(by["CVE-2024-1001"]["status"], "not-found")
        self.assertIn("acme-web-core is already at 6.5.9 on develop", by["CVE-2024-1001"]["detail"])
        self.assertIn("may predate", by["CVE-2024-1001"]["detail"])

    def test_a_package_with_no_findings_anywhere_says_so(self):
        self.fake(results={"s-branch": noise(2), "s-base": noise(2)})
        item = checkmarx.vuln_fixes_for(only("SCA: upgrade acme-web-core to 6.5.9"))["items"][0]
        self.assertEqual(item["status"], "not-found")
        self.assertIn("no finding against acme-web-core", item["detail"])
        self.assertEqual((item["foundOnBase"], item["foundOnBranch"]), ([], []))

    def test_the_gate_text_carries_the_note(self):
        self.fake(results={"s-branch": [], "s-base": []})
        t = only("Fix CVE-2024-5555")
        t["vulnFixes"] = checkmarx.vuln_fixes_for(t)
        state, evidence, _tone = pr_report.vuln_gate(t)
        self.assertEqual(state, "Not verified")
        self.assertIn("returned 0 results", evidence)


def merged_ticket(merged_at="2026-10-05T00:00:00Z", **extra):
    pr = {"state": "merged", "merged": True, "mergedAt": merged_at, "id": 9, "url": PR_URL, "repo": "payments-service",
          "sourceBranch": BRANCH, "destinationBranch": "develop"}
    return vticket(title="Fix CVE-2021-44228", description="", comments=[], prs=[pr], **extra)


class MergedPullRequest(Base):
    """After the merge the base branch already holds the fix: only a base scan from BEFORE it is a baseline."""

    def test_the_last_base_scan_before_the_merge_is_the_baseline(self):
        scans = {BRANCH: [scan("s-branch", BRANCH, "2026-10-04T08:00:00Z")],
                 "develop": [scan("s-after", "develop", "2026-10-08T07:00:00Z"), scan("s-before", "develop", "2026-10-01T07:00:00Z")]}
        f = self.fake(scans=scans, results={"s-branch": [], "s-before": BASE_ROWS, "s-after": []})
        vf = checkmarx.vuln_fixes_for(merged_ticket())
        item = vf["items"][0]
        self.assertEqual(item["status"], "fixed")
        self.assertEqual(vf["baseScanAt"], "2026-10-01T07:00:00Z")
        self.assertIn("was CRITICAL on develop (scan 2026-10-01)", item["detail"])
        asked = [dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(u).query)).get("scan-id") for u, _h, _d in f.calls if urllib.parse.urlsplit(u).path == "/api/results"]
        self.assertNotIn("s-after", asked)

    def test_a_base_scanned_only_after_the_merge_proves_nothing(self):
        scans = {BRANCH: [scan("s-branch", BRANCH, "2026-10-04T08:00:00Z")], "develop": [scan("s-after", "develop", "2026-10-08T07:00:00Z")]}
        self.fake(scans=scans, results={"s-branch": [], "s-after": []})
        item = checkmarx.vuln_fixes_for(merged_ticket())["items"][0]
        self.assertEqual(item["status"], "unknown")
        self.assertIn("no develop scan from before the PR merged (2026-10-05)", item["detail"])
        self.assertIn("already contains the fix", item["detail"])

    def test_an_open_pr_still_uses_the_newest_base_scan(self):
        scans = {BRANCH: [scan("s-branch", BRANCH, "2026-10-09T08:00:00Z")],
                 "develop": [scan("s-new", "develop", "2026-10-08T07:00:00Z"), scan("s-old", "develop", "2026-10-01T07:00:00Z")]}
        self.fake(scans=scans, results={"s-branch": [], "s-new": BASE_ROWS, "s-old": []})
        vf = checkmarx.vuln_fixes_for(only("Fix CVE-2021-44228"))
        self.assertEqual(vf["baseScanAt"], "2026-10-08T07:00:00Z")
        self.assertEqual(vf["items"][0]["status"], "fixed")


# ── diagnose ─────────────────────────────────────────────────────────────────


class Diagnose(Base):
    def run_cli(self, *argv, ticket=None):
        out = io.StringIO()
        with mock.patch.object(sys, "stdout", out), mock.patch.object(checkmarx, "_ticket_from_dump", lambda key: ticket):
            code = checkmarx.main(["diagnose", *argv])
        return code, out.getvalue()

    def test_a_ticket_key_prints_the_project_scans_counts_and_every_target(self):
        summary = {"s-branch": {"scaCounters": {"totalCounter": 1, "severityCounters": [{"severity": "HIGH", "counter": 1}]}},
                   "s-base": {"scaCounters": {"totalCounter": 9, "severityCounters": [{"severity": "CRITICAL", "counter": 9}]}}}
        self.fake(summary=summary)
        code, text = self.run_cli("PAY-7", ticket=vticket())
        self.assertEqual(code, 0)
        for want in ("payments-service", BRANCH, "develop", "s-branch", "s-base", "2026-10-09", "SCA 1", "SAST 1", "SCA 2", "other 1",
                     "CVE-2021-44228", "fixed", "CVE-2020-9999", "not-found"):
            self.assertIn(want, text)
        self.assertIn("scan-summary", text)
        self.assertIn("9", text)
        # base: the summary counts 9 SCA findings but the results API gave 2 — that mismatch is the finding
        self.assertIn("incomplete", text.lower())

    def test_it_says_which_scans_were_used_and_why_a_newer_base_scan_was_not(self):
        scans = {BRANCH: [scan("s-branch", BRANCH, "2026-10-04T08:00:00Z")],
                 "develop": [scan("s-after", "develop", "2026-10-08T07:00:00Z")]}
        self.fake(scans=scans, results={"s-branch": [], "s-after": []})
        _code, text = self.run_cli("PAY-7", ticket=merged_ticket())
        self.assertIn("PR merged 2026-10-05", text)
        self.assertIn("used for SCA: branch s-branch · base none", text)
        self.assertIn("is after the PR merged (2026-10-05)", text)
        self.fake()
        checkmarx.reset_run()
        _code, text = self.run_cli("PAY-7", ticket=vticket())
        self.assertIn("used for SCA: branch s-branch · base s-base", text)

    def test_nothing_secret_is_printed(self):
        f = self.fake()
        code, text = self.run_cli("PAY-7", ticket=vticket())
        self.assertEqual(code, 0)
        for secret in ("cx-key-123", "tok-abc", "refresh_token", "Bearer"):
            self.assertNotIn(secret, text)
        self.assertNotIn(AUTH, text)
        self.assertTrue(f.calls)

    def test_a_repo_slug_needs_a_branch_and_takes_targets(self):
        self.fake()
        code, text = self.run_cli("payments-service", "--branch", BRANCH, "--base", "develop", "--target", "CVE-2021-44228", "--target", "lodash@4.17.20")
        self.assertEqual(code, 0)
        self.assertIn("CVE-2021-44228", text)
        self.assertIn("lodash", text)
        code, text = self.run_cli("payments-service")
        self.assertEqual(code, 2)
        self.assertIn("--branch", text)

    def test_the_response_shape_shows_field_names_not_values(self):
        self.fake()
        _code, text = self.run_cli("PAY-7", ticket=vticket())
        self.assertIn("vulnerabilityDetails", text)
        self.assertIn("packageIdentifier", text)
        self.assertNotIn("Maven-org.apache.logging.log4j:log4j-core-2.14.1", text)  # a value: not printed in the shape lines

    def test_a_package_target_lists_the_versions_seen(self):
        self.fake(results={"s-branch": [sca("CVE-2024-9001", LIB + "6.5.9")], "s-base": [sca("CVE-2024-1001", LIB + "6.5.7")]})
        _code, text = self.run_cli("PAY-7", ticket=only("SCA: upgrade acme-web-core to 6.5.9"))
        self.assertIn("6.5.7", text)
        self.assertIn("6.5.9", text)

    def test_not_configured_exits_2_and_names_what_is_missing(self):
        with mock.patch.dict(os.environ, {"CHECKMARX_API_KEY": ""}):
            code, text = self.run_cli("PAY-7", ticket=vticket())
        self.assertEqual(code, 2)
        self.assertIn("CHECKMARX_API_KEY", text)

    def test_an_unknown_ticket_exits_2(self):
        self.fake()
        code, text = self.run_cli("PAY-404", ticket=None)
        self.assertEqual(code, 2)
        self.assertIn("PAY-404", text)

    def test_a_rejected_key_exits_1_without_a_traceback(self):
        self.fake(fail={AUTH: 401})
        code, text = self.run_cli("PAY-7", ticket=vticket())
        self.assertEqual(code, 1)
        self.assertNotIn("Traceback", text)
        self.assertIn("key", text.lower())

    def test_the_command_line_entry_point_exists(self):
        out = subprocess.run([sys.executable, os.path.join(INTERN, "checkmarx.py"), "diagnose", "PAY-7"], capture_output=True, text=True,
                             env={**{k: v for k, v in os.environ.items() if not k.startswith("CHECKMARX_")}, "JB_SECRETS_FILE": os.devnull}, cwd=ROOT)
        self.assertEqual(out.returncode, 2, out.stdout + out.stderr)
        self.assertIn("not configured", (out.stdout + out.stderr).lower())


# ── visible status instead of silent skips ───────────────────────────────────

NOT_CONFIGURED_TEXT = "Checkmarx not configured — add the URL and key in API keys"


def apply_status(t=None, *, enabled=True, result=None, prior=None, failure=None, plan=True):
    """daily_fetch.apply_vuln_fixes with Checkmarx mocked; returns the ticket. `failure` is checkmarx.failure()'s answer."""
    import _sources
    _sources.reset("checkmarx")
    t = t if t is not None else vticket()

    def fake_for(ticket, targets=None, repos=None):
        return copy.deepcopy(result)

    with mock.patch.object(daily_fetch.checkmarx, "enabled", lambda: enabled), \
            mock.patch.object(daily_fetch.checkmarx, "vuln_fixes_for", fake_for), \
            mock.patch.object(daily_fetch.checkmarx, "failure", lambda: failure), \
            mock.patch.object(daily_fetch, "DEV", {"PAY-7": {"repos": {BRANCH: "payments-service"}}}):
        return daily_fetch.apply_vuln_fixes(t, t["key"], prior)


class ProofNotes(unittest.TestCase):
    """`Ticket.proofNotes.checkmarx` says why a vulnerability-fix ticket has no (fresh) result."""

    def test_not_configured_is_visible_on_the_ticket_and_keeps_the_prior_result(self):
        out = apply_status(enabled=False, prior={"vulnFixes": PRIOR_VF})
        note = out["proofNotes"]["checkmarx"]
        self.assertEqual((note["state"], note["detail"]), ("not-configured", NOT_CONFIGURED_TEXT))
        self.assertRegex(note["at"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
        self.assertEqual(out["vulnFixes"], PRIOR_VF)

    def test_not_configured_with_nothing_before_still_says_so(self):
        out = apply_status(enabled=False, prior={})
        self.assertNotIn("vulnFixes", out)
        self.assertEqual(out["proofNotes"]["checkmarx"]["state"], "not-configured")

    def test_a_failed_lookup_says_why_and_keeps_the_prior_result(self):
        out = apply_status(result=None, prior={"vulnFixes": PRIOR_VF}, failure=("auth-failed", "the API key was rejected (HTTP 401)"))
        note = out["proofNotes"]["checkmarx"]
        self.assertEqual(note["state"], "auth-failed")
        self.assertIn("rejected", note["detail"])
        self.assertEqual(out["vulnFixes"], PRIOR_VF)

    def test_each_failure_state_has_its_own_wording(self):
        for state, text, word in (("unreachable", "x could not be reached", "could not be reached"),
                                  ("budget-exhausted", "the 300-call budget", "budget"),
                                  ("auth-failed", "the API key was rejected (HTTP 403)", "rejected")):
            with self.subTest(state=state):
                note = apply_status(result=None, prior={}, failure=(state, text))["proofNotes"]["checkmarx"]
                self.assertEqual(note["state"], state)
                self.assertIn(word, note["detail"])

    def test_a_lookup_that_failed_without_a_known_reason_is_unreachable(self):
        self.assertEqual(apply_status(result=None, prior={}, failure=None)["proofNotes"]["checkmarx"]["state"], "unreachable")

    def test_an_unchanged_state_keeps_its_since_stamp(self):
        out = apply_status(enabled=False, prior={})
        first = out["proofNotes"]["checkmarx"]["at"]
        out["proofNotes"]["checkmarx"]["at"] = "2026-10-01T00:00:00Z"
        again = apply_status(out, enabled=False, prior=None)
        self.assertEqual(again["proofNotes"]["checkmarx"]["at"], "2026-10-01T00:00:00Z")
        changed = apply_status(again, result=None, prior=None, failure=("unreachable", "x"))
        self.assertEqual(changed["proofNotes"]["checkmarx"]["state"], "unreachable")
        self.assertNotEqual(changed["proofNotes"]["checkmarx"]["at"], "2026-10-01T00:00:00Z")
        self.assertRegex(first, r"^\d{4}-\d\d-\d\dT")

    def test_a_fresh_result_clears_the_note_and_keeps_other_sources_notes(self):
        stale = vticket(proofNotes={"checkmarx": {"state": "not-configured", "detail": NOT_CONFIGURED_TEXT, "at": "2026-10-01T00:00:00Z"},
                                    "jenkins": {"state": "unreachable", "detail": "Jenkins x", "at": "2026-10-01T00:00:00Z"}})
        out = apply_status(stale, result=FRESH_VF, prior={})
        self.assertEqual(out["vulnFixes"], FRESH_VF)
        self.assertEqual(list(out["proofNotes"]), ["jenkins"])

    def test_the_last_note_removed_removes_the_field(self):
        stale = vticket(proofNotes={"checkmarx": {"state": "not-configured", "detail": "x", "at": "2026-10-01T00:00:00Z"}})
        self.assertNotIn("proofNotes", apply_status(stale, result=FRESH_VF, prior={}))

    def test_a_ticket_that_is_no_longer_a_candidate_loses_its_note(self):
        stale = vticket(title="Refactor", description="<p>x</p>", labels=[], comments=[],
                        proofNotes={"checkmarx": {"state": "not-configured", "detail": "x", "at": "2026-10-01T00:00:00Z"}})
        self.assertNotIn("proofNotes", apply_status(stale, result=FRESH_VF, prior={}))

    def test_a_candidate_is_reported_to_the_run_account(self):
        import _sources
        apply_status(result=FRESH_VF, prior={})
        st = _sources.finish("checkmarx", "Checkmarx", "vulnerability-fix ticket")
        self.assertEqual((st["state"], st["looked"], st["counts"]["fixed"]), ("read", 1, 1))
        apply_status(enabled=False, prior={})
        st = _sources.finish("checkmarx", "Checkmarx", "vulnerability-fix ticket", gap="CHECKMARX_API_KEY")
        self.assertEqual((st["state"], st["waiting"]), ("not-configured", ["PAY-7"]))
        apply_status(result=None, prior={}, failure=("unreachable", "x"))
        self.assertEqual(_sources.finish("checkmarx", "Checkmarx", "vulnerability-fix ticket")["state"], "unreachable")

    def test_skips_are_reported_with_their_reason(self):
        import _sources
        apply_status(vticket(prs=[], branch=None, branches=[]), result=FRESH_VF, prior={})
        st = _sources.finish("checkmarx", "Checkmarx", "vulnerability-fix ticket")
        self.assertEqual(st["state"], "no-candidates")
        self.assertIn("without a pull request or known branch", st["detail"])
        apply_status(vticket(title="Checkmarx clean-up", description="<p>see dashboard</p>", comments=[]), result=FRESH_VF, prior={})
        self.assertIn("naming no CVE", _sources.finish("checkmarx", "Checkmarx", "vulnerability-fix ticket")["detail"])

    def test_the_gate_names_the_reason_when_there_is_no_result(self):
        t = apply_status(enabled=False, prior={})
        state, evidence, _tone = pr_report.vuln_gate(t)
        self.assertEqual(state, "Not verified")
        self.assertIn(NOT_CONFIGURED_TEXT, evidence)
        t = apply_status(result=None, prior={}, failure=("unreachable", "x could not be reached"))
        self.assertIn("could not be reached", pr_report.vuln_gate(t)[1])

    def test_the_gate_with_a_stored_result_does_not_change_for_a_note(self):
        t = vticket(vulnFixes=vf(FIXED_CVE), proofNotes={"checkmarx": {"state": "unreachable", "detail": "x could not be reached", "at": "2026-10-11T00:00:00Z"}})
        self.assertEqual(pr_report.vuln_gate(t), pr_report.vuln_gate(vticket(vulnFixes=vf(FIXED_CVE))))

    def test_the_fingerprint_ignores_the_note(self):
        t = vticket()
        noted = {**t, "proofNotes": {"checkmarx": {"state": "not-configured", "detail": "x", "at": "2026-10-11T00:00:00Z"}}}
        self.assertEqual(pr_report.fingerprint(t), pr_report.fingerprint(noted))


class RunStatusInTheDump(unittest.TestCase):
    """_main writes proofSources.checkmarx and a run note — configured or not."""

    def setUp(self):
        import contextlib
        import shutil
        import _sources
        _sources.reset()
        checkmarx.reset_run()
        self.tmp = tempfile.mkdtemp(prefix="cx-status-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.data_path = os.path.join(self.tmp, "data.json")
        self.state_path = os.path.join(self.tmp, ".state.json")
        self.prior_sources = {"jenkins": {"state": "read", "detail": "Jenkins: 1 ticket", "at": "2026-10-10T00:00:00Z"}}
        with open(self.data_path, "w", encoding="utf-8") as f:
            json.dump({"tickets": [], "completed": [], "proofSources": self.prior_sources}, f)
        self.written = []
        self.issues = []
        info = {"prs": vticket()["prs"], "branches": [BRANCH], "pr": vticket()["prs"][0], "branch": BRANCH}
        patches = [
            mock.patch.object(daily_fetch, "search_jira", lambda jql, **k: [] if "parent in" in jql else list(self.issues)),
            mock.patch.object(daily_fetch, "comments_for", lambda key, f: ([], 0, None)),
            mock.patch.object(daily_fetch, "_bb_get", mock.Mock(side_effect=OSError("down"))),
            mock.patch.object(daily_fetch, "code_for", lambda key, prior, parent=None: info),
            mock.patch.object(daily_fetch.devinfo, "fetch_many", lambda *a, **k: {}),
            mock.patch.object(daily_fetch, "apply_builds", lambda t, k, prior=None: t),
            mock.patch.object(daily_fetch, "fetch_raised", lambda preserved: (preserved, True)),
            mock.patch.object(daily_fetch, "write_outputs", lambda data, intern_dir=None: self.written.append(data)),
            mock.patch.object(daily_fetch, "atomic_dump", lambda path, obj: None),
            mock.patch.object(daily_fetch, "prepend_status", lambda *a, **k: None),
            mock.patch.object(daily_fetch, "set_progress", lambda *a, **k: None),
            mock.patch.object(daily_fetch, "data_lock", lambda *a, **k: contextlib.nullcontext()),
            mock.patch.object(daily_fetch.jenkins, "reset_run", lambda: None),
            mock.patch.dict(os.environ, {"JIRA_PERSONAL_TOKEN": "x", "CHECKMARX_BASE_URL": "", "CHECKMARX_API_KEY": "",
                                         "JB_SECRETS_FILE": os.path.join(self.tmp, "none.env")}),
            mock.patch.object(checkmarx, "_config_endpoints", lambda: {}),
            mock.patch.object(sys, "stderr", io.StringIO()),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def issue(self, title):
        return {"key": "PAY-7", "id": "7", "fields": {"summary": title, "status": {"name": "In Review"}, "issuetype": {"name": "Bug"},
                                                      "created": "2026-03-01T10:00:00.000+0000", "updated": "2026-03-01T10:00:00.000+0000", "assignee": None},
                "changelog": {"histories": []}}

    def run_main(self):
        out, _changes, notes = daily_fetch._main(self.data_path, self.state_path)
        return out, notes

    def test_not_configured_with_a_ticket_waiting_is_in_the_dump_and_the_notes(self):
        self.issues = [self.issue("Fix CVE-2021-44228 in payments")]
        out, notes = self.run_main()
        st = out["proofSources"]["checkmarx"]
        self.assertEqual(st["state"], "not-configured")
        self.assertIn("CHECKMARX_BASE_URL", st["detail"])
        self.assertIn("CHECKMARX_API_KEY", st["detail"])
        self.assertEqual(st["waiting"], ["PAY-7"])
        self.assertTrue(any(n.startswith("Checkmarx not configured") for n in notes), notes)
        self.assertEqual(out["tickets"][0]["proofNotes"]["checkmarx"]["detail"], NOT_CONFIGURED_TEXT)
        self.assertEqual(out["proofSources"]["jenkins"], self.prior_sources["jenkins"])  # another source's record is kept

    def test_not_configured_and_nobody_waiting_is_stored_but_silent(self):
        self.issues = [self.issue("Refactor the export page")]
        out, notes = self.run_main()
        self.assertEqual(out["proofSources"]["checkmarx"]["state"], "not-configured")
        self.assertFalse(any("Checkmarx" in n for n in notes), notes)

    def test_a_read_says_how_many_tickets_and_targets(self):
        self.issues = [self.issue("Fix CVE-2021-44228 in payments")]
        env = {"CHECKMARX_BASE_URL": BASE, "CHECKMARX_API_KEY": "cx-key-123"}
        with mock.patch.dict(os.environ, env), mock.patch.object(checkmarx, "_http", FakeCx()):
            out, notes = self.run_main()
        st = out["proofSources"]["checkmarx"]
        self.assertEqual((st["state"], st["looked"]), ("read", 1))
        self.assertIn("Checkmarx: 1 vulnerability-fix ticket looked up", st["detail"])
        self.assertIn(st["detail"], notes)
        self.assertNotIn("proofNotes", out["tickets"][0])

    def test_configured_with_nothing_to_look_up_says_so(self):
        self.issues = [self.issue("Refactor the export page")]
        env = {"CHECKMARX_BASE_URL": BASE, "CHECKMARX_API_KEY": "cx-key-123"}
        with mock.patch.dict(os.environ, env):
            out, notes = self.run_main()
        self.assertEqual(out["proofSources"]["checkmarx"]["state"], "no-candidates")
        self.assertIn("Checkmarx: no vulnerability-fix ticket to look up", " ".join(notes))

    def test_a_rejected_key_is_carried_forward_and_named(self):
        self.issues = [self.issue("Fix CVE-2021-44228 in payments")]
        env = {"CHECKMARX_BASE_URL": BASE, "CHECKMARX_API_KEY": "cx-key-123"}
        with mock.patch.dict(os.environ, env), mock.patch.object(checkmarx, "_http", FakeCx(fail={AUTH: 401})):
            out, notes = self.run_main()
        st = out["proofSources"]["checkmarx"]
        self.assertEqual(st["state"], "auth-failed")
        self.assertIn("carried forward", st["detail"])
        self.assertTrue(any("rejected" in n for n in notes), notes)
        self.assertEqual(out["tickets"][0]["proofNotes"]["checkmarx"]["state"], "auth-failed")
