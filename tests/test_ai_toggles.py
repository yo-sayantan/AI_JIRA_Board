#!/usr/bin/env python3
"""The AI and Background-jobs master switches, and the level → price / effort rules (Settings → AI, Features).

AI off must stop every enqueue path and every queued job; each level may run only the cloud models its price cap
covers (Low ≤ $1, Medium ≤ $5, High < $10, Max all); the level — not a separate control — sets the effort."""
import os
import sys
import tempfile
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INTERN = os.path.join(ROOT, "jira-intern")
sys.path.insert(0, INTERN)
os.environ.setdefault("INTERN_DIR", INTERN)
sys.path.insert(0, os.path.join(ROOT, "ai-intern"))
import ai_queue  # noqa: E402
import worker  # noqa: E402


def row(output, costly=False):
    return {"id": "m", "label": "M", "price": {"output": output}, "costly": costly}


class LevelPriceCaps(unittest.TestCase):
    def test_caps_by_level(self):
        self.assertEqual([worker.level_allows("low", row(o)) for o in (0.5, 1, 1.2)], [True, True, False])
        self.assertEqual([worker.level_allows("moderate", row(o)) for o in (4.5, 5, 6)], [True, True, False])
        self.assertEqual([worker.level_allows("high", row(o)) for o in (6, 9.99, 10, 12)], [True, True, False, False])

    def test_max_runs_everything(self):
        self.assertTrue(worker.level_allows("full", row(12, costly=True)))
        self.assertTrue(worker.level_allows("full", row(None)))

    def test_costly_and_unpriced_never_below_max(self):
        self.assertFalse(worker.level_allows("high", row(3, costly=True)))
        self.assertFalse(worker.level_allows("moderate", row(None)))
        self.assertFalse(worker.level_allows("low", None))

    def test_infer_refuses_a_model_outside_the_level(self):
        job = {"backend": "cloud", "model": "m", "cloudProvider": "cursor", "level": "low"}
        with mock.patch.object(worker, "_cloud_row", return_value=row(6)), mock.patch.object(worker, "_cloud_allowed", return_value=True):
            with self.assertRaises(RuntimeError) as ctx:
                worker.infer(job, "s", "u")
        self.assertIn("Low", str(ctx.exception))


class LevelSetsEffort(unittest.TestCase):
    def test_mapping(self):
        self.assertEqual([worker.EFFORT_FOR_LEVEL[l] for l in ("low", "moderate", "high", "full")], ["low", "medium", "high", "high"])

    def test_saved_level_overrides_the_queued_effort(self):
        saved = {"aiBackend": "cloud", "aiCloudModel": "m", "aiCloudProvider": "cursor", "aiLevel": "high", "aiCloudEffort": "low"}
        with mock.patch.object(ai_queue, "load_settings", return_value=saved):
            out = worker.apply_saved_model({"backend": "cloud", "cloudEffort": "low"})
        self.assertEqual((out["level"], out["cloudEffort"]), ("high", "high"))

    def test_high_timeout_sits_between_medium_and_max(self):
        with mock.patch.object(worker, "load_config", return_value={"timeouts": {"reportSec": 600}}):
            t = {l: worker.timeout_for(l) for l in ("low", "moderate", "high", "full")}
        self.assertEqual(t, {"low": 300, "moderate": 600, "high": 900, "full": 1200})


class AiSwitch(unittest.TestCase):
    def test_enabled_unless_switched_off_or_legacy_none(self):
        self.assertTrue(ai_queue.ai_enabled({}))
        self.assertTrue(ai_queue.ai_enabled({"aiEnabled": True, "aiLevel": "high"}))
        self.assertFalse(ai_queue.ai_enabled({"aiEnabled": False}))
        self.assertFalse(ai_queue.ai_enabled({"aiLevel": "none"}))

    def test_enqueue_refuses_every_job_type_while_off(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.object(ai_queue, "QUEUE_DIR", d), \
                mock.patch.object(ai_queue, "load_settings", return_value={"aiEnabled": False}):
            for job in ({"type": "enrich-report", "key": "ABC-1"}, {"type": "summarize-active"}, {"type": "pull-model", "model": "qwen2.5:7b"}):
                with self.assertRaises(ValueError):
                    ai_queue.enqueue(job)
            self.assertEqual(os.listdir(d), [])

    def test_enqueue_works_with_high_while_on(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.object(ai_queue, "QUEUE_DIR", d), \
                mock.patch.object(ai_queue, "load_settings", return_value={"aiEnabled": True}):
            self.assertEqual(ai_queue.enqueue({"type": "enrich-report", "key": "ABC-1", "level": "high"})["level"], "high")

    def test_a_queued_job_is_skipped_when_ai_is_switched_off_afterwards(self):
        with mock.patch.object(ai_queue, "load_settings", return_value={"aiEnabled": False}), \
                mock.patch.object(worker, "enrich_report") as enrich, mock.patch.object(worker, "summarize_active") as summ, \
                mock.patch.object(worker, "pull_model") as pull:
            for job in ({"type": "enrich-report", "key": "ABC-1"}, {"type": "summarize-active"}, {"type": "pull-model", "model": "x"}):
                worker.process_job(job)
        for fn in (enrich, summ, pull):
            fn.assert_not_called()


if __name__ == "__main__":
    unittest.main()
