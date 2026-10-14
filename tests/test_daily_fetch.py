#!/usr/bin/env python3
"""daily_fetch.py pure helpers: update-log idempotence, identity matching, Bitbucket hints."""
import contextlib
import json
import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "jira-intern"))
import daily_fetch  # noqa: E402
from _jira import status_column  # noqa: E402

CREATED = "2026-01-01T09:00:00.000+0000"
RESOLVED = "2026-02-01T09:00:00.000+0000"


def done_entries(log):
    return [e for e in log if (e.get("text") or "").startswith("Marked DONE")]


class UpdateLog(unittest.TestCase):
    def test_marked_done_is_idempotent_without_resolutiondate(self):
        first = daily_fetch.build_update_log("K-1", CREATED, "Done", None, None)
        self.assertEqual(len(done_entries(first)), 1)
        second = daily_fetch.build_update_log("K-1", CREATED, "Done", None, None, prior_log=first)
        third = daily_fetch.build_update_log("K-1", CREATED, "Done", None, None, prior_log=second)
        self.assertEqual(len(done_entries(second)), 1)
        self.assertEqual(len(done_entries(third)), 1)
        self.assertEqual(third[-1]["text"], "Opened")
        self.assertEqual(third[-1]["when"], "2026-01-01")

    def test_fresh_marked_done_wins_over_prior_with_other_day(self):
        prior = [{"when": "2026-01-20", "text": "Marked DONE — 2026-01-20"}, {"when": "2026-01-01", "text": "Opened"}]
        log = daily_fetch.build_update_log("K-1", CREATED, "Done", RESOLVED, None, prior_log=prior)
        done = done_entries(log)
        self.assertEqual(len(done), 1)
        self.assertEqual(done[0]["text"], "Marked DONE — 2026-02-01")
        self.assertEqual(done[0]["when"], "2026-02-01")

    def test_prior_assigned_entry_is_kept_once(self):
        prior = [{"when": "2026-01-01", "text": "Assigned — initial brief"}]
        log = daily_fetch.build_update_log("K-1", CREATED, "In Progress", None, None, prior_log=prior)
        log = daily_fetch.build_update_log("K-1", CREATED, "In Progress", None, None, prior_log=log)
        self.assertEqual(sum(1 for e in log if e["text"].startswith("Assigned")), 1)
        self.assertEqual(done_entries(log), [])

    def test_changelog_transitions_newest_first(self):
        changelog = {"histories": [
            {"created": "2026-01-03T10:00:00.000+0000", "items": [{"field": "status", "toString": "In Progress"}]},
            {"created": "2026-01-05T10:00:00.000+0000", "items": [{"field": "status", "toString": "In Review"}]},
        ]}
        log = daily_fetch.build_update_log("K-1", CREATED, "In Review", None, changelog)
        self.assertEqual([e["text"] for e in log], ["In Review", "In Progress", "Opened"])


class IsMine(unittest.TestCase):
    def setUp(self):
        for name, value in (("MY_ACCOUNT", "ABC123"), ("MY_EMAIL", "ME@EXAMPLE.COM")):
            p = mock.patch.object(daily_fetch, name, value)
            p.start()
            self.addCleanup(p.stop)

    def test_exact_identifier_match_case_insensitive(self):
        self.assertTrue(daily_fetch.is_mine({"name": "abc123"}))
        self.assertTrue(daily_fetch.is_mine({"key": "ABC123"}))
        self.assertTrue(daily_fetch.is_mine({"accountId": "abc123"}))
        self.assertTrue(daily_fetch.is_mine({"emailAddress": "me@example.com"}))

    def test_no_substring_match(self):
        self.assertFalse(daily_fetch.is_mine({"name": "ABC1234"}))
        self.assertFalse(daily_fetch.is_mine({"name": "XABC123"}))
        self.assertFalse(daily_fetch.is_mine({"displayName": "XABC123Y"}))
        self.assertFalse(daily_fetch.is_mine({"displayName": "ABC1234"}))

    def test_display_name_whole_word(self):
        self.assertTrue(daily_fetch.is_mine({"displayName": "Some One (ABC123)"}))
        self.assertTrue(daily_fetch.is_mine({"displayName": "abc123"}))

    def test_empty(self):
        self.assertFalse(daily_fetch.is_mine(None))
        self.assertFalse(daily_fetch.is_mine({}))
        with mock.patch.object(daily_fetch, "MY_ACCOUNT", ""):
            self.assertFalse(daily_fetch.is_mine({"name": "ABC123"}))


class StatusColumns(unittest.TestCase):
    def test_aliases(self):
        self.assertEqual(status_column("Won't Fix"), "done")
        self.assertEqual(status_column("Cancelled"), "done")
        self.assertEqual(status_column("canceled"), "done")
        self.assertEqual(status_column("Rejected"), "done")
        self.assertEqual(status_column("Blocked"), "blocked")
        self.assertEqual(status_column("On Hold"), "hold")
        self.assertEqual(status_column(None), "prog")


class BitbucketHints(unittest.TestCase):
    def test_no_hints_means_no_scan(self):
        def explode(*a, **k):
            raise AssertionError("Bitbucket must not be called without hints")

        with mock.patch.object(daily_fetch, "REPO_HINTS", {}), mock.patch.object(daily_fetch, "BB_PROJECT", {}), \
                mock.patch.object(daily_fetch, "bb_get", explode):
            self.assertEqual(daily_fetch.bb_search_all_prs("PROJ-1"), [])
        with mock.patch.object(daily_fetch, "REPO_HINTS", {"PROJ": ["r"]}), mock.patch.object(daily_fetch, "BB_PROJECT", {}), \
                mock.patch.object(daily_fetch, "bb_get", explode):
            self.assertEqual(daily_fetch.bb_search_all_prs("PROJ-1"), [])

    def test_pr_to_obj_without_project_has_no_url_but_has_updated_at(self):
        obj = daily_fetch.pr_to_obj({
            "id": 5, "state": "MERGED", "title": "t",
            "fromRef": {"displayId": "feature/PROJ-1_x", "repository": {"slug": "repo"}},
            "toRef": {"displayId": "develop"},
            "updatedDate": 1700000000000, "closedDate": 1700000000000,
        })
        self.assertEqual(obj["state"], "merged")
        self.assertIsNone(obj["url"])
        self.assertEqual(obj["updatedAt"], "2023-11-14T22:13:20Z")
        self.assertEqual(obj["mergedAt"], "2023-11-14T22:13:20Z")


def _issue(key, title, **extra):
    fields = {
        "summary": title, "status": {"name": "In Progress"}, "issuetype": {"name": "Task"},
        "created": CREATED, "updated": "2026-03-01T10:00:00.000+0000", "assignee": None,
    }
    fields.update(extra)
    return {"key": key, "id": key.split("-")[1], "fields": fields, "changelog": {"histories": []}}


class MainFlow(unittest.TestCase):
    """_main with Jira mocked: one bad payload must not kill the run; the prior card is kept."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="daily-test-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.data_path = os.path.join(self.tmp, "data.json")
        self.state_path = os.path.join(self.tmp, ".state.json")
        with open(self.data_path, "w", encoding="utf-8") as f:
            json.dump({"tickets": [
                {"key": "T-2", "title": "old T-2", "status": "In Progress", "column": "prog", "updateLog": [], "prs": [], "branches": []},
            ], "completed": [{"key": "C-1", "title": "archived"}]}, f)
        self.written, self.state = [], {}

        def fake_search(jql, **k):
            return [] if "parent in" in jql else list(self.issues)

        def bb_down(path, **k):
            raise OSError("bitbucket down")

        patches = [
            mock.patch.object(daily_fetch, "search_jira", fake_search),
            mock.patch.object(daily_fetch, "comments_for", lambda key, f: ([], 0, None)),
            mock.patch.object(daily_fetch, "_bb_get", bb_down),
            mock.patch.object(daily_fetch.devinfo, "fetch_many", lambda *a, **k: {}),
            mock.patch.object(daily_fetch, "write_outputs", lambda data, intern_dir=None: self.written.append(data)),
            mock.patch.object(daily_fetch, "atomic_dump", lambda path, obj: self.state.update(obj)),
            mock.patch.object(daily_fetch, "prepend_status", lambda *a, **k: None),
            mock.patch.object(daily_fetch, "set_progress", lambda *a, **k: None),
            mock.patch.object(daily_fetch, "data_lock", lambda *a, **k: contextlib.nullcontext()),
            mock.patch.dict(os.environ, {"JIRA_PERSONAL_TOKEN": "x"}),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def test_bad_ticket_is_carried_forward_and_run_completes(self):
        # components: [None] makes build_ticket raise for T-2 only.
        self.issues = [_issue("T-1", "new T-1"), _issue("T-2", "new T-2", components=[None])]
        err = mock.MagicMock()
        with mock.patch.object(sys, "stderr", err):
            out, changes, notes = daily_fetch._main(self.data_path, self.state_path)
        by = {t["key"]: t for t in out["tickets"]}
        self.assertEqual(set(by), {"T-1", "T-2"})
        self.assertEqual(by["T-1"]["title"], "new T-1")
        self.assertEqual(by["T-2"]["title"], "old T-2")
        self.assertEqual(out["completed"], [{"key": "C-1", "title": "archived"}])
        self.assertTrue(any("Build failed" in n and "T-2" in n for n in notes))
        self.assertEqual(changes["new"], ["T-1: new T-1"])
        self.assertEqual(set(self.state), {"T-1", "T-2"})
        self.assertEqual(len(self.written), 1)
        warned = "".join(str(c.args[0]) for c in err.write.call_args_list)
        self.assertIn("WARN build T-2", warned)

    def test_every_ticket_failing_exits_nonzero_without_writing(self):
        self.issues = [_issue("T-1", "x", components=[None]), _issue("T-2", "y", components=[None])]
        with mock.patch.object(sys, "stderr", mock.MagicMock()), mock.patch.object(sys, "stdout", mock.MagicMock()):
            with self.assertRaises(SystemExit) as cm:
                daily_fetch._main(self.data_path, self.state_path)
        self.assertEqual(cm.exception.code, 1)
        self.assertEqual(self.written, [])

    def test_no_token_exits_2_after_restamping(self):
        with mock.patch.dict(os.environ, {"JIRA_PERSONAL_TOKEN": ""}), mock.patch.object(sys, "stdout", mock.MagicMock()):
            with self.assertRaises(SystemExit) as cm:
                daily_fetch._main(self.data_path, self.state_path)
        self.assertEqual(cm.exception.code, 2)
        self.assertEqual(len(self.written), 1)
        self.assertEqual([t["key"] for t in self.written[0]["tickets"]], ["T-2"])
        self.assertIn("no token", self.written[0]["notes"][0])


class RefreshOneKey(unittest.TestCase):
    def test_bad_key_is_refused(self):
        with mock.patch.object(daily_fetch, "load_env", lambda: None):
            with self.assertRaisesRegex(SystemExit, "bad key"):
                daily_fetch.refresh_one("PROJ-1; rm -rf /")
            with self.assertRaisesRegex(SystemExit, "bad key"):
                daily_fetch.refresh_one("../../etc/passwd")
            with self.assertRaisesRegex(SystemExit, "missing key"):
                daily_fetch.refresh_one("  ")


REPO = "https://code.example/projects/PROJ/repos/svc"
PARENT_BRANCH = "feature/PROJ-1_do_the_thing_1"


def _dev_pr(pid, branch, title):
    return {"id": pid, "state": "approved", "title": title, "url": f"{REPO}/pull-requests/{pid}",
            "sourceBranch": branch, "merged": False}


class SubtaskCodeScope(unittest.TestCase):
    """A sub-task committed on its parent's branch must not inherit the parent's PR or branch."""

    DEV = {
        "PROJ-1": {"branches": [PARENT_BRANCH], "prs": [_dev_pr(61, PARENT_BRANCH, "PROJ-1: the feature")], "times": {}},
        "PROJ-2": {"branches": [PARENT_BRANCH], "prs": [_dev_pr(61, PARENT_BRANCH, "PROJ-1: the feature")], "times": {}},
    }

    def _code_for(self, key, parent_key):
        with mock.patch.object(daily_fetch, "DEV", self.DEV), mock.patch.object(daily_fetch, "BB_OK", False):
            return daily_fetch.code_for(key, None, parent_key)

    def test_the_subtask_has_no_code_of_its_own(self):
        info = self._code_for("PROJ-2", "PROJ-1")
        self.assertEqual((info["prs"], info["branches"], info["branch"]), ([], [], None))
        self.assertEqual(info["pr"], {"state": "none"})

    def test_the_parent_keeps_its_pr(self):
        info = self._code_for("PROJ-1", None)
        self.assertEqual([p["id"] for p in info["prs"]], [61])
        self.assertEqual(info["branch"], PARENT_BRANCH)

    def test_apply_code_reads_the_parent_from_the_ticket(self):
        sub = {"key": "PROJ-2", "parentKey": "PROJ-1", "prs": [], "pr": {"state": "none"}}
        with mock.patch.object(daily_fetch, "DEV", self.DEV), mock.patch.object(daily_fetch, "BB_OK", False):
            out = daily_fetch.apply_code(sub, "PROJ-2", {})
        self.assertEqual(out["prs"], [])


class ForeignPrsDropped(unittest.TestCase):
    """A PR that names only another ticket is that ticket's, on every ticket (not just sub-tasks)."""

    def test_code_for_drops_a_pr_for_another_ticket(self):
        dev = {"ABC-9": {"branches": ["feature/ABC-9", "feature/XYZ-4-merge-dev"], "times": {},
                         "prs": [_dev_pr(1, "feature/ABC-9", "ABC-9: the fix"), _dev_pr(2, "feature/XYZ-4-merge-dev", "Feature/XYZ-4 merge dev")]}}
        with mock.patch.object(daily_fetch, "DEV", dev), mock.patch.object(daily_fetch, "BB_OK", False):
            info = daily_fetch.code_for("ABC-9", None)
        self.assertEqual([p["id"] for p in info["prs"]], [1])
        self.assertEqual(info["branches"], ["feature/ABC-9"])


def _qa_issue(key, type_name="Task", title="Build it", labels=(), links=()):
    return {"key": key, "id": key[-1], "fields": {"issuetype": {"name": type_name}, "summary": title, "labels": list(labels), "issuelinks": list(links)}}


class QaTicketsOnTheBoard(unittest.TestCase):
    """QA tickets are not assigned to me, so the assignee search never finds them: ones I raised and ones
    linked to my tickets are pulled in separately."""

    def run_extras(self, mine, reported, by_key, fail=False):
        calls = []

        def fake_search(jql, fields=None, expand=None):
            calls.append(jql)
            if fail:
                raise RuntimeError("boom")
            if jql.startswith("reporter"):
                return reported
            wanted = jql.split("(", 1)[1].split(")", 1)[0].split(",")
            return [by_key[k] for k in wanted if k in by_key]

        with mock.patch.object(daily_fetch, "search_jira", side_effect=fake_search):
            issues, ok = daily_fetch.fetch_qa_extras({i["key"]: i for i in mine})
        return [i["key"] for i in issues], ok, calls

    def test_a_qa_ticket_i_raised_comes_in_and_a_raised_dev_ticket_does_not(self):
        qa, dev = _qa_issue("Q-1", "QA Task", "QA: check export"), _qa_issue("D-9", "Story", "Verify the fix")
        keys, ok, _ = self.run_extras([_qa_issue("M-1")], [qa, dev], {"Q-1": qa})
        self.assertEqual((keys, ok), (["Q-1"], True))

    def test_a_qa_ticket_linked_to_one_of_mine_comes_in(self):
        link = {"outwardIssue": {"key": "Q-2", "fields": {"issuetype": {"name": "Task"}, "summary": "QA: smoke test"}}}
        linked_dev = {"outwardIssue": {"key": "D-2", "fields": {"issuetype": {"name": "Story"}, "summary": "Verify"}}}
        qa = _qa_issue("Q-2", "Task", "QA: smoke test")
        keys, ok, _ = self.run_extras([_qa_issue("M-1", links=[link, linked_dev])], [], {"Q-2": qa})
        self.assertEqual((keys, ok), (["Q-2"], True))

    def test_my_own_tickets_are_not_pulled_in_twice(self):
        mine = _qa_issue("Q-3", "QA Task", "QA: mine")
        keys, _, _ = self.run_extras([mine], [mine], {})
        self.assertEqual(keys, [])

    def test_a_failed_lookup_is_not_reported_as_none(self):
        self.assertEqual(self.run_extras([_qa_issue("M-1")], [], {}, fail=True)[:2], ([], False))

    def test_a_label_marks_a_qa_ticket(self):
        qa = _qa_issue("Q-4", "Task", "Smoke test", labels=["qa"])
        self.assertEqual(self.run_extras([], [qa], {"Q-4": qa})[0], ["Q-4"])


if __name__ == "__main__":
    unittest.main()


class QaTicketLane(unittest.TestCase):
    """A QA ticket the QA team is working under a status the board has no alias for ("In validation") is shown
    as QA In Progress — not as an In Progress dev ticket. Mirror of `qaColumn` in src/lib/moveRules.ts."""

    def sub(self, title, itype="Sub-task", status="In validation", labels=()):
        si = {"key": "PROJ-9", "fields": {
            "summary": title, "status": {"name": status}, "issuetype": {"name": itype}, "labels": list(labels),
            "created": CREATED, "updated": CREATED, "assignee": {"displayName": "Tess Tester", "name": "tess"},
            "parent": {"key": "PROJ-1"},
        }}
        with mock.patch.object(daily_fetch, "DEV", {}), mock.patch.object(daily_fetch, "BB_OK", False):
            return daily_fetch.build_basic_subtask(si, "PROJ-1")

    def test_a_qa_subtask_in_an_unknown_status_goes_to_the_qa_column(self):
        self.assertEqual(status_column("In validation"), "prog")  # the fallback the rule corrects
        self.assertEqual(self.sub("QA: verify the flow")["column"], "qa")
        self.assertEqual(self.sub("Check it on staging", labels=["qa"])["column"], "qa")

    def test_a_dev_subtask_with_the_same_status_stays_in_progress(self):
        self.assertEqual(self.sub("Implement the flow")["column"], "prog")

    def test_a_qa_subtask_not_started_or_finished_keeps_its_column(self):
        self.assertEqual(self.sub("QA: verify the flow", status="To Do")["column"], "todo")
        self.assertEqual(self.sub("QA: verify the flow", status="Done")["column"], "done")
