#!/usr/bin/env python3
"""scripts/seed-runtime-data.sh: a deploy from a NEW checkout (a git worktree, a fresh clone) must not come up empty — and
must never copy credentials or overwrite anything. Runs the real script against throwaway folders."""
import os
import shutil
import subprocess
import tempfile
import unittest

SCRIPT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts", "seed-runtime-data.sh")


def put(root, rel, text="x"):
    path = os.path.join(root, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def has(root, rel):
    return os.path.exists(os.path.join(root, rel))


class SeedRuntimeData(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="seed-test-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.src = os.path.join(self.tmp, "main")
        self.dst = os.path.join(self.tmp, "worktree")
        os.makedirs(self.dst)
        os.makedirs(os.path.join(self.dst, "jira-intern"))
        # What a real deployed checkout holds
        for rel in ("data.json", "data.js", ".state.json", ".settings.json", ".schedule.json", ".pr_overrides.json", "_STATUS.md", "cache/A-1.json", "reports/index.js", ".health/jira.json"):
            put(self.src, f"jira-intern/{rel}", f"real {rel}")
        # …and what must NEVER travel: locks, a half-finished run, logs, backups, the model store, the API keys
        for rel in (".data.lock", ".intern.lock", ".progress.json", ".data.prev.json", "data.json.bak", "logs/run.log", "models/blob"):
            put(self.src, f"jira-intern/{rel}", "do not copy")
        put(self.src, "setup/.env", "JIRA_PERSONAL_TOKEN=secret-token-value\n")

    def run_script(self, src=None, dst=None):
        return subprocess.run(["bash", SCRIPT, src or self.src, dst or self.dst], capture_output=True, text=True, timeout=30)

    def test_an_empty_checkout_gets_the_board_data(self):
        r = self.run_script()
        self.assertEqual(r.returncode, 0, r.stderr)
        for rel in ("data.json", "data.js", ".state.json", ".settings.json", ".schedule.json", ".pr_overrides.json", "_STATUS.md", "cache/A-1.json", "reports/index.js", ".health/jira.json"):
            self.assertTrue(has(self.dst, f"jira-intern/{rel}"), rel)
        with open(os.path.join(self.dst, "jira-intern", "data.json"), encoding="utf-8") as f:
            self.assertEqual(f.read(), "real data.json")
        self.assertIn("Carried your board data over", r.stdout)

    def test_locks_logs_backups_and_models_never_travel(self):
        self.run_script()
        for rel in (".data.lock", ".intern.lock", ".progress.json", ".data.prev.json", "data.json.bak", "logs/run.log", "models/blob"):
            self.assertFalse(has(self.dst, f"jira-intern/{rel}"), rel)

    def test_api_keys_are_never_copied_the_script_says_how_instead(self):
        r = self.run_script()
        self.assertFalse(has(self.dst, "setup/.env"))
        self.assertNotIn("secret-token-value", r.stdout + r.stderr)  # names and commands only, never contents
        self.assertIn("NOT copied automatically", r.stdout)
        self.assertIn("chmod 600", r.stdout)

    def test_a_checkout_with_its_own_data_is_left_alone(self):
        put(self.dst, "jira-intern/data.json", "my own")
        r = self.run_script()
        self.assertEqual(r.returncode, 0)
        with open(os.path.join(self.dst, "jira-intern", "data.json"), encoding="utf-8") as f:
            self.assertEqual(f.read(), "my own")
        self.assertFalse(has(self.dst, "jira-intern/cache"))
        self.assertEqual(r.stdout, "")

    def test_it_never_overwrites_a_file_that_is_already_there(self):
        put(self.dst, "jira-intern/.settings.json", "local settings")
        put(self.dst, "jira-intern/cache/A-1.json", "local cache")
        self.run_script()
        for rel, want in ((".settings.json", "local settings"), ("cache/A-1.json", "local cache")):
            with open(os.path.join(self.dst, "jira-intern", rel), encoding="utf-8") as f:
                self.assertEqual(f.read(), want, rel)
        self.assertTrue(has(self.dst, "jira-intern/data.json"))  # the rest still arrived

    def test_nothing_to_carry_or_the_same_folder_is_a_quiet_no_op(self):
        shutil.rmtree(os.path.join(self.src, "jira-intern"))
        self.assertEqual(self.run_script().returncode, 0)
        self.assertFalse(has(self.dst, "jira-intern/data.json"))
        self.assertEqual(self.run_script(src=self.dst).returncode, 0)  # same folder
        self.assertEqual(self.run_script(src=os.path.join(self.tmp, "missing")).returncode, 0)  # not there

    def test_without_both_arguments_it_says_how_to_use_it(self):
        r = subprocess.run(["bash", SCRIPT], capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 2)
        self.assertIn("usage", r.stderr)


if __name__ == "__main__":
    unittest.main()
