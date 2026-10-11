#!/usr/bin/env python3
"""Parity checks for the shared project/personal configuration contract."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INTERN = ROOT / "jira-intern"
sys.path.insert(0, str(INTERN))

import _config  # noqa: E402


class ConfigParityTest(unittest.TestCase):
    def merged(self, override):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump(override, f)
            path = f.name
        env = {**os.environ, "AI_CONFIG_FILE": path}
        old = os.environ.get("AI_CONFIG_FILE")
        os.environ["AI_CONFIG_FILE"] = path
        try:
            py = _config.load_config(str(INTERN))
            raw = subprocess.check_output(
                ["node", str(INTERN / "local-runner" / "config.mjs"), "export"],
                cwd=ROOT,
                env=env,
                text=True,
            )
            return py, json.loads(raw)
        finally:
            if old is None:
                os.environ.pop("AI_CONFIG_FILE", None)
            else:
                os.environ["AI_CONFIG_FILE"] = old
            os.unlink(path)

    def test_node_python_deep_merge_match(self):
        override = {
            "user": {"name": "Example User"},
            "app": {"timeZone": "America/New_York", "branding": {"badgeText": "example"}},
            "ai": {"backend": "cloud", "cloudModel": "grok-4.5"},
        }
        py, node = self.merged(override)
        self.assertEqual(py, node)
        self.assertEqual(py["app"]["servePort"], 4321)
        self.assertEqual(py["app"]["branding"]["badgeText"], "example")
        self.assertEqual(py["app"]["branding"]["tagline"], "Built to dodge JIRA · made with ☕ + a refresh button")

    def test_configured_timezone_has_offset(self):
        py, _node = self.merged({"app": {"timeZone": "Asia/Kolkata"}})
        self.assertEqual(py["app"]["timeZone"], "Asia/Kolkata")
        old = os.environ.get("AI_CONFIG_FILE")
        try:
            with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
                json.dump({"app": {"timeZone": "Asia/Kolkata"}}, f)
                path = f.name
            os.environ["AI_CONFIG_FILE"] = path
            self.assertTrue(_config.now_iso(str(INTERN)).endswith("+05:30"))
        finally:
            if old is None:
                os.environ.pop("AI_CONFIG_FILE", None)
            else:
                os.environ["AI_CONFIG_FILE"] = old
            if "path" in locals():
                os.unlink(path)

    def test_invalid_timezone_falls_back_to_utc_for_timestamping(self):
        py, node = self.merged({"app": {"timeZone": "Not/A_Zone"}})
        self.assertEqual(py["app"]["timeZone"], "UTC")
        self.assertEqual(node["app"]["timeZone"], "UTC")
        old = os.environ.get("AI_CONFIG_FILE")
        try:
            with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
                json.dump({"app": {"timeZone": "Not/A_Zone"}}, f)
                path = f.name
            os.environ["AI_CONFIG_FILE"] = path
            self.assertEqual(_config.time_zone(str(INTERN)), "UTC")
            self.assertTrue(_config.now_iso(str(INTERN)).endswith("+00:00"))
        finally:
            if old is None:
                os.environ.pop("AI_CONFIG_FILE", None)
            else:
                os.environ["AI_CONFIG_FILE"] = old
            if "path" in locals():
                os.unlink(path)

    def test_legacy_ist_alias_is_normalized(self):
        py, node = self.merged({"app": {"timeZone": "IST"}})
        self.assertEqual(py["app"]["timeZone"], "Asia/Kolkata")
        self.assertEqual(node["app"]["timeZone"], "Asia/Kolkata")

    def test_non_object_override_keeps_defaults(self):
        py, node = self.merged(["not", "an", "object"])
        self.assertEqual(py, node)
        self.assertEqual(py["version"], 1)

    def test_jenkins_jobs_override_merges_in_both(self):
        jobs = {"payments-service": {"qa": "https://jenkins.example.com/job/pay-qa/", "uat": "https://jenkins.example.com/job/pay-uat/"}}
        py, node = self.merged({"jenkins": {"jobs": jobs}})
        self.assertEqual(py, node)
        self.assertEqual(py["jenkins"]["jobs"], jobs)
        self.assertEqual(list(py["jenkins"]["jobs"]["payments-service"]), ["qa", "uat"])  # env order kept

    def test_jenkins_root_and_discovery_merge_the_same_in_both(self):
        discovery = {"appFolderRegex": "^{slug}(-.*)?$", "envPatterns": {"stage": ["qa-eu"]}, "maxDepth": 3, "cacheMinutes": 30}
        py, node = self.merged({"jenkins": {"root": "https://jenkins.example.com/job/portfolio/", "discovery": discovery}})
        self.assertEqual(py, node)
        self.assertEqual(py["jenkins"]["root"], "https://jenkins.example.com/job/portfolio/")
        self.assertEqual(py["jenkins"]["discovery"], discovery)
        self.assertEqual(py["jenkins"]["jobs"], {})  # the tracked default survives the merge

    def test_schema_rejects_a_malformed_jenkins_section(self):
        for bad in ({"jenkins": {"root": 3}}, {"jenkins": {"discovery": {"maxDepth": 0}}}, {"jenkins": {"discovery": {"envPatterns": {"dev": "dev"}}}},
                    {"jenkins": {"discovery": {"cacheMinutes": "soon"}}}, {"jenkins": {"discovery": {"nope": 1}}}, {"jenkins": {"jobs": {"svc": "https://x"}}}, {"jenkins": {"jobs": {"svc": {"qa": 1}}}}, {"jenkins": {"servers": {}}}):
            with self.subTest(bad=bad):
                with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
                    json.dump(bad, f)
                    path = f.name
                old = os.environ.get("AI_CONFIG_FILE")
                os.environ["AI_CONFIG_FILE"] = path
                try:
                    with self.assertRaisesRegex(RuntimeError, "jenkins"):
                        _config.load_config(str(INTERN))
                    result = subprocess.run(["node", str(INTERN / "local-runner" / "config.mjs"), "validate"], cwd=ROOT,
                                            env={**os.environ}, text=True, capture_output=True)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("jenkins", result.stderr)
                finally:
                    if old is None:
                        os.environ.pop("AI_CONFIG_FILE", None)
                    else:
                        os.environ["AI_CONFIG_FILE"] = old
                    os.unlink(path)

    def test_schema_rejects_invalid_runtime_controls(self):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump({"refresh": {"intervalSec": -1}, "unexpected": True}, f)
            path = f.name
        env = {**os.environ, "AI_CONFIG_FILE": path}
        old = os.environ.get("AI_CONFIG_FILE")
        os.environ["AI_CONFIG_FILE"] = path
        try:
            with self.assertRaisesRegex(RuntimeError, "configuration invalid"):
                _config.load_config(str(INTERN))
            result = subprocess.run(
                ["node", str(INTERN / "local-runner" / "config.mjs"), "validate"],
                cwd=ROOT,
                env=env,
                text=True,
                capture_output=True,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("configuration invalid", result.stderr)
        finally:
            if old is None:
                os.environ.pop("AI_CONFIG_FILE", None)
            else:
                os.environ["AI_CONFIG_FILE"] = old
            os.unlink(path)


if __name__ == "__main__":
    unittest.main()
