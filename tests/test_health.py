#!/usr/bin/env python3
"""_health.py: the per-service health files (jira-intern/.health/<id>.json) every outside client
writes after a REAL call. No network, no real .health directory — JB_HEALTH_DIR points at a temp dir."""
import io
import json
import os
import shutil
import ssl
import subprocess
import sys
import tempfile
import unittest
import urllib.error
from datetime import datetime, timedelta, timezone
from email.message import Message
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "jira-intern"))
import _health  # noqa: E402


def http_error(code):
    return urllib.error.HTTPError("https://host.example/x", code, f"HTTP {code}", Message(), io.BytesIO(b""))


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.env = mock.patch.dict(os.environ, {"JB_HEALTH_DIR": self.dir})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.t = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
        clock = mock.patch.object(_health, "_now", side_effect=lambda: self.t)
        clock.start()
        self.addCleanup(clock.stop)
        _health._reset_cache()

    def advance(self, seconds):
        self.t += timedelta(seconds=seconds)

    def raw(self, service):
        with open(os.path.join(self.dir, f"{service}.json"), encoding="utf-8") as f:
            return f.read()

    def read(self, service):
        with open(os.path.join(self.dir, f"{service}.json"), encoding="utf-8") as f:
            return json.load(f)


class Recording(Base):
    def test_ok_record_shape(self):
        _health.record("jira", True)
        r = self.read("jira")
        self.assertEqual(r["service"], "jira")
        self.assertEqual(r["state"], "ok")
        self.assertEqual(r["checkedAt"], "2026-01-01T12:00:00Z")
        self.assertEqual(r["lastOkAt"], "2026-01-01T12:00:00Z")
        self.assertEqual(r["source"], "fetch")
        self.assertNotIn("failingSince", r)
        self.assertNotIn("status", r)

    def test_each_failure_outcome(self):
        cases = [
            (http_error(401), "auth-failed", 401),
            (http_error(403), "forbidden", 403),
            (http_error(500), "error", 500),
            (http_error(503), "error", 503),
            (http_error(429), "error", 429),
            (urllib.error.URLError(OSError("refused")), "unreachable", None),
            (TimeoutError("timed out"), "unreachable", None),
            (ConnectionResetError(), "unreachable", None),
            (urllib.error.URLError(ssl.SSLCertVerificationError("bad cert")), "tls", None),
            (ssl.SSLError("handshake"), "tls", None),
        ]
        for i, (exc, status, code) in enumerate(cases):
            with self.subTest(status=status, i=i):
                svc = f"svc{i}"
                _health.record_exception(svc, exc, source="worker")
                r = self.read(svc)
                self.assertEqual(r["state"], "attention")
                self.assertEqual(r["status"], status)
                self.assertEqual(r.get("httpStatus"), code)
                self.assertEqual(r["source"], "worker")
                self.assertTrue(r["detail"])

    def test_lookup_404_and_other_client_errors_are_not_service_failures(self):
        for code in (400, 404, 409, 422):
            with self.subTest(code=code):
                self.assertIsNone(_health.record_exception("jenkins", http_error(code)))
        self.assertFalse(os.path.exists(os.path.join(self.dir, "jenkins.json")))

    def test_404_does_not_clear_an_existing_failure(self):
        _health.record_exception("jenkins", http_error(401))
        self.advance(120)
        _health.record_exception("jenkins", http_error(404))
        self.assertEqual(self.read("jenkins")["state"], "attention")

    def test_failing_since_and_last_ok(self):
        _health.record("bitbucket", True)
        ok_at = "2026-01-01T12:00:00Z"
        self.advance(100)
        _health.record("bitbucket", False, status="auth-failed", http=401, detail="Key rejected")
        r = self.read("bitbucket")
        self.assertEqual(r["failingSince"], "2026-01-01T12:01:40Z")
        self.assertEqual(r["lastOkAt"], ok_at)
        self.advance(500)
        _health.record("bitbucket", False, status="unreachable", detail="down")
        r = self.read("bitbucket")
        self.assertEqual(r["failingSince"], "2026-01-01T12:01:40Z")  # kept until success
        self.assertEqual(r["lastOkAt"], ok_at)
        self.assertEqual(r["status"], "unreachable")
        self.advance(500)
        _health.record("bitbucket", True)
        r = self.read("bitbucket")
        self.assertEqual(r["state"], "ok")
        self.assertNotIn("failingSince", r)
        self.assertNotIn("status", r)
        self.assertEqual(r["lastOkAt"], r["checkedAt"])

    def test_first_ever_failure_has_no_last_ok(self):
        _health.record("claude", False, status="auth-failed", http=401)
        r = self.read("claude")
        self.assertNotIn("lastOkAt", r)
        self.assertEqual(r["failingSince"], r["checkedAt"])


class Tones(unittest.TestCase):
    """ONE mapping, mirrored by server/health.mjs::toneOf and src/lib/apiKeys.ts::healthTone."""

    def test_mapping(self):
        t = _health.tone_of
        self.assertEqual(t({"state": "ok"}), "ok")
        self.assertEqual(t({"state": "attention", "status": "auth-failed"}), "key")
        self.assertEqual(t({"state": "attention", "status": "forbidden"}), "key")
        for status in ("unreachable", "tls", "not-found", "error", None):
            self.assertEqual(t({"state": "attention", "status": status}), "attention")
        self.assertEqual(t(None), "none")
        self.assertEqual(t({}), "none")
        self.assertEqual(t({"state": "weird"}), "none")


class Throttle(Base):
    def test_same_outcome_within_a_minute_is_not_rewritten(self):
        _health.record("jira", True)
        path = os.path.join(self.dir, "jira.json")
        before = os.stat(path).st_mtime_ns
        self.advance(30)
        self.assertIsNone(_health.record("jira", True))
        self.assertEqual(os.stat(path).st_mtime_ns, before)
        self.assertEqual(self.read("jira")["checkedAt"], "2026-01-01T12:00:00Z")

    def test_rewritten_after_a_minute(self):
        _health.record("jira", True)
        self.advance(61)
        _health.record("jira", True)
        self.assertEqual(self.read("jira")["checkedAt"], "2026-01-01T12:01:01Z")

    def test_a_change_is_written_at_once(self):
        _health.record("jira", True)
        self.advance(1)
        _health.record("jira", False, status="forbidden", http=403)
        self.assertEqual(self.read("jira")["state"], "attention")
        self.advance(1)
        _health.record("jira", False, status="auth-failed", http=401)
        self.assertEqual(self.read("jira")["status"], "auth-failed")
        self.advance(1)
        _health.record("jira", True)
        self.assertEqual(self.read("jira")["state"], "ok")

    def test_throttle_survives_a_new_process(self):
        _health.record("jira", True)
        _health._reset_cache()  # what a second process starts with
        self.advance(10)
        self.assertIsNone(_health.record("jira", True))


class Safety(Base):
    def test_no_secret_in_detail(self):
        secret = "s3cr3t-token-value-123"
        with mock.patch.dict(os.environ, {"JENKINS_API_TOKEN": secret}):
            _health.record(
                "jenkins",
                False,
                status="error",
                detail=f"GET https://j.example/api?token={secret}&x=1 failed: Authorization: Bearer {secret} Basic QWxhZGRpbjpvcGVu {secret}",
            )
        raw = self.raw("jenkins")
        self.assertNotIn(secret, raw)
        self.assertNotIn("QWxhZGRpbjpvcGVu", raw)
        self.assertNotIn("token=", raw)
        self.assertNotIn("?", self.read("jenkins")["detail"])

    def test_detail_is_short_single_line(self):
        _health.record("jira", False, status="error", detail="x\n" * 500)
        d = self.read("jira")["detail"]
        self.assertLessEqual(len(d), 160)
        self.assertNotIn("\n", d)

    def test_exception_detail_never_echoes_the_message(self):
        _health.record_exception("jira", urllib.error.URLError("secret-in-message-xyz"), host="jira.example")
        raw = self.raw("jira")
        self.assertNotIn("secret-in-message-xyz", raw)
        self.assertIn("jira.example", raw)

    def test_never_raises(self):
        with mock.patch.object(_health.os, "replace", side_effect=OSError("disk full")):
            self.assertIsNone(_health.record("jira", True))
        with mock.patch.dict(os.environ, {"JB_HEALTH_DIR": "/proc/nope/never"}):
            self.assertIsNone(_health.record("jira", True))
        self.assertIsNone(_health.record("../evil", True))
        self.assertIsNone(_health.record(None, True))
        self.assertIsNone(_health.record_exception("jira", None))

    def test_unsafe_service_id_writes_nothing(self):
        _health.record("../escape", True)
        _health.record("a/b", True)
        self.assertEqual(os.listdir(self.dir), [])

    def test_atomic_write_leaves_no_temp_files(self):
        _health.record("jira", True)
        self.advance(100)
        _health.record("jira", False, status="error")
        self.assertEqual(sorted(os.listdir(self.dir)), ["jira.json"])

    def test_a_failed_replace_keeps_the_old_record(self):
        _health.record("jira", True)
        self.advance(100)
        with mock.patch.object(_health.os, "replace", side_effect=OSError("nope")):
            _health.record("jira", False, status="error")
        self.assertEqual(self.read("jira")["state"], "ok")
        self.assertEqual(sorted(os.listdir(self.dir)), ["jira.json"])

    def test_corrupt_file_is_replaced(self):
        with open(os.path.join(self.dir, "jira.json"), "w") as f:
            f.write("{not json")
        _health.record("jira", True)
        self.assertEqual(self.read("jira")["state"], "ok")


class Isolation(Base):
    def test_one_file_per_service(self):
        _health.record("jira", True)
        _health.record("bitbucket", False, status="auth-failed", http=401)
        self.assertEqual(sorted(os.listdir(self.dir)), ["bitbucket.json", "jira.json"])
        self.assertEqual(self.read("jira")["state"], "ok")
        self.assertEqual(self.read("bitbucket")["state"], "attention")

    def test_read_all(self):
        _health.record("jira", True)
        _health.record("claude", False, status="forbidden", http=403)
        with open(os.path.join(self.dir, "junk.json"), "w") as f:
            f.write("nope")
        everything = _health.read_all()
        self.assertEqual(sorted(everything), ["claude", "jira"])


class Routing(Base):
    def test_cloud_hosts(self):
        self.assertEqual(_health.service_for_url("https://api.anthropic.com/v1/messages"), "claude")
        self.assertEqual(_health.service_for_url("https://api.cursor.com/v1/agents"), "cursor")
        self.assertEqual(_health.service_for_url("https://generativelanguage.googleapis.com/v1beta/models"), "gemini")
        self.assertEqual(_health.service_for_url("https://api.openai.com/v1/chat/completions"), "openai")
        self.assertIsNone(_health.service_for_url("http://ollama:11434/api/tags"))
        self.assertIsNone(_health.service_for_url(""))

    def test_a_dynatrace_tenant_query_host(self):
        self.assertEqual(_health.service_for_url("https://abc12345.apps.dynatrace.com/platform/storage/query/v1/query:execute"), "dynatrace")
        self.assertIsNone(_health.service_for_url("https://apps.dynatrace.com/x"))
        self.assertIsNone(_health.service_for_url("https://abc12345.apps.dynatrace.com.evil.example/x"))


class _Resp:
    def __init__(self, payload):
        self._body = json.dumps(payload).encode()

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class CallSites(Base):
    """Real clients record what their HTTP layer saw (the network is mocked)."""

    def test_jira_get_json_ok_then_401(self):
        import _jira

        with mock.patch.object(_jira, "ssl_context", return_value=None), mock.patch("urllib.request.urlopen", return_value=_Resp({"a": 1})):
            _jira.get_json("https://jira.example/rest", {}, timeout=5, service="jira")
        self.assertEqual(self.read("jira")["state"], "ok")
        self.advance(100)
        with mock.patch.object(_jira, "ssl_context", return_value=None), mock.patch("urllib.request.urlopen", side_effect=http_error(401)):
            with self.assertRaises(urllib.error.HTTPError):
                _jira.get_json("https://jira.example/rest?secret=abc", {}, timeout=5, service="jira")
        r = self.read("jira")
        self.assertEqual((r["state"], r["status"], r["httpStatus"]), ("attention", "auth-failed", 401))
        self.assertNotIn("abc", json.dumps(r))

    def test_jira_get_json_404_is_not_recorded(self):
        import _jira

        with mock.patch.object(_jira, "ssl_context", return_value=None), mock.patch("urllib.request.urlopen", side_effect=http_error(404)):
            with self.assertRaises(urllib.error.HTTPError):
                _jira.get_json("https://jira.example/rest/api/2/issue/X-1", {}, timeout=5, service="jira")
        self.assertEqual(os.listdir(self.dir), [])

    def test_jira_get_json_final_5xx_is_recorded_once_retries_are_spent(self):
        import _jira

        with mock.patch.object(_jira, "ssl_context", return_value=None), mock.patch.object(_jira.time, "sleep"), mock.patch("urllib.request.urlopen", side_effect=http_error(503)):
            with self.assertRaises(urllib.error.HTTPError):
                _jira.get_json("https://bb.example/rest", {}, timeout=5, retries=1, service="bitbucket")
        self.assertEqual(self.read("bitbucket")["status"], "error")

    def test_jira_get_json_without_service_records_nothing(self):
        import _jira

        with mock.patch.object(_jira, "ssl_context", return_value=None), mock.patch("urllib.request.urlopen", return_value=_Resp({})):
            _jira.get_json("https://x.example/", {}, timeout=5)
        self.assertEqual(os.listdir(self.dir), [])

    def test_jenkins_get(self):
        import jenkins

        creds = mock.patch.object(jenkins, "credentials", return_value=("u", "t"))
        with creds:
            jenkins.reset_run()
            with mock.patch.object(jenkins, "get_json", return_value={"ok": 1}):
                self.assertEqual(jenkins._get("https://ci.example/job/x/api/json", "t")[1], 200)
            self.assertEqual(self.read("jenkins")["state"], "ok")
            self.advance(100)
            jenkins.reset_run()
            with mock.patch.object(jenkins, "get_json", side_effect=http_error(404)):
                self.assertEqual(jenkins._get("https://ci.example/job/x/api/json", "t")[1], 404)
            self.assertEqual(self.read("jenkins")["state"], "ok")  # "no build for this branch" changes nothing
            jenkins.reset_run()
            with mock.patch.object(jenkins, "get_json", side_effect=http_error(401)):
                jenkins._get("https://ci.example/job/x/api/json", "t")
            self.assertEqual(self.read("jenkins")["status"], "auth-failed")
            jenkins.reset_run()
            self.advance(100)
            with mock.patch.object(jenkins, "get_json", side_effect=urllib.error.URLError(OSError("refused"))):
                jenkins._get("https://ci.example/job/x/api/json", "t")
            self.assertEqual(self.read("jenkins")["status"], "unreachable")
            jenkins.reset_run()

    def test_checkmarx_call(self):
        import checkmarx

        checkmarx.reset_run()
        with mock.patch.object(checkmarx, "_http", return_value={"x": 1}):
            checkmarx._call("https://eu.cx.example/api/projects", {}, None, "projects")
        self.assertEqual(self.read("checkmarx")["state"], "ok")
        self.advance(100)
        with mock.patch.object(checkmarx, "_http", side_effect=http_error(404)):
            self.assertIsNone(checkmarx._call("https://eu.cx.example/api/projects", {}, None, "projects"))
        self.assertEqual(self.read("checkmarx")["state"], "ok")  # no project is not a failure
        with mock.patch.object(checkmarx, "_http", side_effect=http_error(400)):
            with self.assertRaises(checkmarx.LookupFailed):
                checkmarx._call("https://eu.cx.example/auth/token", {}, b"x", "token")
        r = self.read("checkmarx")
        self.assertEqual((r["state"], r["status"]), ("attention", "auth-failed"))
        checkmarx.reset_run()
        self.advance(100)
        with mock.patch.object(checkmarx, "_http", side_effect=http_error(500)):
            with self.assertRaises(checkmarx.LookupFailed):
                checkmarx._call("https://eu.cx.example/api/projects", {}, None, "projects")
        self.assertEqual(self.read("checkmarx")["status"], "error")
        checkmarx.reset_run()


class WorkerCalls(Base):
    def setUp(self):
        super().setUp()
        sys.path.insert(0, os.path.join(ROOT, "ai-intern"))
        import worker

        self.worker = worker

    def test_cloud_chat_records_by_host_and_ollama_does_not(self):
        w = self.worker
        with mock.patch("urllib.request.urlopen", return_value=_Resp({"ok": 1})):
            w.http_json("https://api.anthropic.com/v1/messages", {"a": 1})
            w.http_json("http://ollama:11434/api/tags")
        self.assertEqual(os.listdir(self.dir), ["claude.json"])
        self.assertEqual(self.read("claude")["source"], "worker")
        self.advance(100)
        with mock.patch("urllib.request.urlopen", side_effect=http_error(401)):
            with self.assertRaises(urllib.error.HTTPError):
                w.http_json("https://api.cursor.com/v1/models")
        self.assertEqual(self.read("cursor")["status"], "auth-failed")

    def test_gemini_cloud_json_failure(self):
        w = self.worker
        with mock.patch("urllib.request.urlopen", side_effect=http_error(403)):
            with self.assertRaises(RuntimeError):
                w._cloud_json("https://generativelanguage.googleapis.com/v1beta/models")
        self.assertEqual(self.read("gemini")["status"], "forbidden")

    def test_mcp_get_routes_bitbucket_and_jira(self):
        w = self.worker
        with mock.patch("urllib.request.urlopen", return_value=_Resp({})):
            w.mcp_get("https://git.example/rest/api/1.0/projects/P/repos/r/pull-requests/1", "t")
            w.mcp_get("https://jira.example/rest/api/2/issue/X-1", "t")
        self.assertEqual(sorted(os.listdir(self.dir)), ["bitbucket.json", "jira.json"])


class Interop(Base):
    """The Node side (server/health.mjs) reads what Python wrote, and the other way round."""

    def node(self, script):
        node = shutil.which("node")
        if not node:
            self.skipTest("node not available")
        return subprocess.run([node, "--input-type=module", "-e", script], capture_output=True, text=True, cwd=ROOT, env={**os.environ, "JB_HEALTH_DIR": self.dir}, timeout=60)

    def test_node_reads_python_written(self):
        _health.record("jira", True)
        self.advance(5)
        _health.record("bitbucket", False, status="auth-failed", http=401, detail="Key rejected")
        out = self.node("import {readAllHealth} from './server/health.mjs'; console.log(JSON.stringify(await readAllHealth(process.env.JB_HEALTH_DIR)))")
        self.assertEqual(out.returncode, 0, out.stderr)
        got = json.loads(out.stdout)
        self.assertEqual(got["jira"]["state"], "ok")
        self.assertEqual(got["bitbucket"]["status"], "auth-failed")
        self.assertEqual(got["bitbucket"]["httpStatus"], 401)

    def test_python_reads_node_written(self):
        out = self.node(
            "import {writeHealth} from './server/health.mjs';"
            "await writeHealth(process.env.JB_HEALTH_DIR,'checkmarx',{ok:false,status:'forbidden',httpStatus:403,detail:'No access',source:'test'})"
        )
        self.assertEqual(out.returncode, 0, out.stderr)
        r = _health.read("checkmarx")
        self.assertEqual((r["state"], r["status"], r["httpStatus"], r["source"]), ("attention", "forbidden", 403, "test"))
        self.assertIn("failingSince", r)
        # …and Python carries failingSince forward from a Node-written record.
        self.advance(100)
        _health.record("checkmarx", False, status="forbidden", http=403)
        self.assertEqual(_health.read("checkmarx")["failingSince"], r["failingSince"])


if __name__ == "__main__":
    unittest.main()
