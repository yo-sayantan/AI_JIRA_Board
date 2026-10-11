#!/usr/bin/env python3
"""ai-intern/worker.py::bitbucket_ci — a network failure must say what to do, not print a socket error.

The AI-Intern container once reported "PR #79: <urlopen error [Errno -3] Temporary failure in name resolution>"
in the CI row of a report: Docker's DNS had flapped. The message now names the host and points at
docs/DEPLOYMENT.md → DNS. Nothing here touches the network."""
import os
import socket
import ssl
import sys
import unittest
import urllib.error
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INTERN = os.path.join(ROOT, "jira-intern")
sys.path.insert(0, INTERN)
os.environ.setdefault("INTERN_DIR", INTERN)
sys.path.insert(0, os.path.join(ROOT, "ai-intern"))
import worker  # noqa: E402

BB = "https://bitbucket.example.com"
TICKET = {"key": "PAY-7", "title": "x", "prs": [{"state": "open", "id": 9, "url": f"{BB}/projects/PAY/repos/payments-service/pull-requests/9"}]}
DNS = urllib.error.URLError(socket.gaierror(-3, "Temporary failure in name resolution"))


def run(exc):
    with mock.patch.object(worker, "endpoints", lambda _d: ("https://jira.example.com", "", BB)), \
            mock.patch.dict(os.environ, {"BITBUCKET_PAT": "x"}), \
            mock.patch.object(worker, "mcp_get", side_effect=exc):
        return worker.bitbucket_ci(TICKET)


class CiNetworkErrors(unittest.TestCase):
    def test_a_dns_failure_names_the_host_and_the_fix(self):
        out = run(DNS)
        self.assertEqual((out["state"], out["error"]), ("Not verified", True))
        d = out["detail"]
        self.assertIn("PR #9", d)
        self.assertIn("bitbucket.example.com could not be resolved from the AI-Intern container", d)
        self.assertIn("Docker DNS", d)
        self.assertIn("docs/DEPLOYMENT.md", d)
        self.assertNotIn("Errno", d)
        self.assertNotIn("urlopen", d)

    def test_the_text_fits_the_report_cell(self):
        self.assertLessEqual(len(run(DNS)["detail"]), 180)

    def test_dns_failures_in_their_other_shapes(self):
        for exc in (socket.gaierror(-2, "Name or service not known"), OSError(-3, "Temporary failure in name resolution"),
                    urllib.error.URLError("[Errno -2] Name or service not known")):
            with self.subTest(exc=repr(exc)):
                self.assertIn("could not be resolved", run(exc)["detail"])

    def test_other_failures_keep_their_own_words(self):
        self.assertIn("HTTP Error 500", run(urllib.error.HTTPError(BB, 500, "HTTP Error 500: Server Error", {}, None))["detail"])
        out = run(RuntimeError("something odd"))
        self.assertIn("something odd", out["detail"])
        self.assertNotIn("could not be resolved", out["detail"])

    def test_a_refused_or_timed_out_connection_is_not_blamed_on_dns(self):
        for exc, word in ((urllib.error.URLError(ConnectionRefusedError(111, "Connection refused")), "reach"),
                          (urllib.error.URLError(socket.timeout("timed out")), "timed out")):
            with self.subTest(exc=repr(exc)):
                d = run(exc)["detail"]
                self.assertNotIn("could not be resolved", d)
                self.assertIn(word, d)
                self.assertIn("bitbucket.example.com", d)

    def test_a_certificate_error_points_at_the_ca_bundle(self):
        d = run(urllib.error.URLError(ssl.SSLCertVerificationError("certificate verify failed")))["detail"]
        self.assertIn("certificate", d.lower())
        self.assertIn("ca-bundle", d)

    def test_the_text_helper_is_pure_and_secret_free(self):
        text = worker.net_error_text(DNS, "https://bitbucket.example.com/rest/api/1.0/projects/PAY?access_token=abc123abc123abc123")
        self.assertIn("bitbucket.example.com", text)
        self.assertNotIn("abc123", text)
        self.assertNotIn("/rest/", text)
        self.assertIsNone(worker.net_error_text(RuntimeError("plain"), BB))


if __name__ == "__main__":
    unittest.main()
