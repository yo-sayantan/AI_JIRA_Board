#!/usr/bin/env python3
"""API keys: setup/.env is the ONLY secrets file, read the same way by Python and bash, and
every key in setup/api-keys.json is actually read by something."""
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
INTERN = ROOT / "jira-intern"
sys.path.insert(0, str(INTERN))

import _config  # noqa: E402

REGISTRY = json.loads((ROOT / "setup" / "api-keys.json").read_text())
ENV_NAMES = [k["env"] for s in REGISTRY["services"] for k in s["keys"]]


class SecretsPathTest(unittest.TestCase):
    def test_default_is_setup_env_beside_the_registry(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("JB_SECRETS_FILE", None)
            self.assertEqual(Path(_config.secrets_path(str(INTERN))), ROOT / "setup" / ".env")

    def test_the_old_global_file_is_not_read(self):
        with mock.patch.dict(os.environ, {"AGENT_SECRETS": "/somewhere/mcp-secrets.env"}):
            os.environ.pop("JB_SECRETS_FILE", None)
            self.assertEqual(Path(_config.secrets_path(str(INTERN))), ROOT / "setup" / ".env")

    def test_jb_secrets_file_moves_it(self):
        with mock.patch.dict(os.environ, {"JB_SECRETS_FILE": "/tmp/x/keys.env"}):
            self.assertEqual(_config.secrets_path(str(INTERN)), "/tmp/x/keys.env")


class SameParserTest(unittest.TestCase):
    """Python's load_secrets and bash's export_secrets_from_file must agree."""

    BODY = "# c\nJIRA_PERSONAL_TOKEN='tok-1'\nexport BITBUCKET_PAT = bb-2 \nJIRA_URL=https://j.example\nNOT_EXPORTED=x\n"

    def test_python_and_bash_read_the_same_values(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "keys.env")
            Path(path).write_text(self.BODY)
            with mock.patch.dict(os.environ, {"JB_SECRETS_FILE": path}):
                py = _config.load_secrets(str(INTERN))
            self.assertEqual(py["JIRA_PERSONAL_TOKEN"], "tok-1")
            self.assertEqual(py["BITBUCKET_PAT"], "bb-2")
            script = (
                f'. "{INTERN}/local-runner/runner-env.sh"; load_agent_secrets; '
                'printf "%s|%s|%s|%s" "$JIRA_PERSONAL_TOKEN" "$BITBUCKET_PAT" "$JIRA_URL" "${NOT_EXPORTED:-}"'
            )
            env = {k: v for k, v in os.environ.items() if k not in ENV_NAMES}
            env["JB_SECRETS_FILE"] = path
            out = subprocess.check_output(["bash", "-c", script], env=env, text=True, cwd=ROOT)
            self.assertEqual(out, "tok-1|bb-2|https://j.example|")


    def test_an_environment_variable_wins_over_the_file_in_both(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "keys.env")
            Path(path).write_text("JIRA_PERSONAL_TOKEN=from-file\n")
            script = f'. "{INTERN}/local-runner/runner-env.sh"; load_agent_secrets; printf "%s" "$JIRA_PERSONAL_TOKEN"'
            env = {k: v for k, v in os.environ.items() if k not in ENV_NAMES}
            env.update(JB_SECRETS_FILE=path, JIRA_PERSONAL_TOKEN="from-env")
            self.assertEqual(subprocess.check_output(["bash", "-c", script], env=env, text=True, cwd=ROOT), "from-env")
            sys.path.insert(0, str(INTERN))
            import _jira  # noqa: E402

            with mock.patch.dict(os.environ, {"JB_SECRETS_FILE": path, "JIRA_PERSONAL_TOKEN": "from-env"}):
                _jira.load_env()
                self.assertEqual(os.environ["JIRA_PERSONAL_TOKEN"], "from-env")


class RegistryContractTest(unittest.TestCase):
    def test_every_registry_key_is_read_somewhere(self):
        runner = (INTERN / "local-runner" / "runner-env.sh").read_text()
        exported = re.search(r"load_agent_secrets\(\) \{(.*?)\n\}", runner, re.S).group(1)
        worker = (ROOT / "ai-intern" / "worker.py").read_text()
        keycheck = (ROOT / "server" / "keycheck.mjs").read_text()
        config = json.loads((ROOT / "config" / "jira-board.config.json").read_text())
        api_key_envs = {c.get("apiKeyEnv") for c in config["connector"].values() if isinstance(c, dict)}
        planned = {k["env"] for s in REGISTRY["services"] for k in s["keys"] if k.get("planned")}
        for name in ENV_NAMES:
            if name in planned:
                continue  # listed so the user can add it now; the integration that reads it comes later
            with self.subTest(name=name):
                self.assertTrue(
                    name in exported or f'"{name}"' in worker or name in api_key_envs or f"s.{name}" in keycheck,
                    f"{name} is in setup/api-keys.json but nothing reads it",
                )

    def test_jenkins_tls_opt_out_passes_through_wherever_jira_one_does(self):
        """JENKINS_INSECURE_TLS is Jenkins' own switch (JIRA_INSECURE_TLS never applies to it), so it
        must reach every place JIRA_INSECURE_TLS reaches: both compose services, the runner, the worker."""
        compose = (ROOT / "docker-compose.yml").read_text()
        bare = lambda name: len(re.findall(rf"^\s*- {name}\s*$", compose, re.M))
        self.assertGreaterEqual(bare("JIRA_INSECURE_TLS"), 2)
        self.assertEqual(bare("JENKINS_INSECURE_TLS"), bare("JIRA_INSECURE_TLS"))
        runner = (INTERN / "local-runner" / "runner-env.sh").read_text()
        exported = re.search(r"load_agent_secrets\(\) \{(.*?)\n\}", runner, re.S).group(1)
        self.assertIn("JIRA_INSECURE_TLS", exported)
        self.assertIn("JENKINS_INSECURE_TLS", exported)
        worker = (ROOT / "ai-intern" / "worker.py").read_text()
        env_export = re.search(r"_ENV_EXPORT = \((.*?)\)", worker, re.S).group(1)
        if '"JIRA_INSECURE_TLS"' in env_export:
            self.assertIn('"JENKINS_INSECURE_TLS"', env_export)

    def test_registry_shape(self):
        ids = [s["id"] for s in REGISTRY["services"]]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(len(ENV_NAMES), len(set(ENV_NAMES)))
        self.assertTrue(any(s["required"] for s in REGISTRY["services"]))
        for s in REGISTRY["services"]:
            for field in ("name", "color", "why", "usedBy", "getIt", "keys"):
                self.assertIn(field, s, f"{s['id']} lacks {field}")
            self.assertRegex(s["color"], r"^#[0-9a-f]{6}$")
            for k in s["keys"]:
                self.assertRegex(k["env"], r"^[A-Z][A-Z0-9_]*$")
                self.assertIn(k.get("kind", "secret"), ("secret", "url", "email", "text"), k["env"])
                self.assertNotIn("secret", k, "use kind, not the old secret flag")

    def test_secrets_file_is_ignored_by_git_and_docker(self):
        self.assertRegex((ROOT / ".gitignore").read_text(), r"(?m)^\.env$")
        dockerignore = (ROOT / ".dockerignore").read_text()
        self.assertRegex(dockerignore, r"(?m)^\*\*/\.env$")
        self.assertRegex(dockerignore, r"(?m)^\*\*/\.env\.\*$")


if __name__ == "__main__":
    unittest.main()
