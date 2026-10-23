#!/usr/bin/env python3
"""completed_archive.py: a failed build keeps the previous row and the run exits non-zero;
scoped runs derive `mine` from the cache or an explicit membership search. No network."""
import json
import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "jira-intern"))
import completed_archive as ca  # noqa: E402


def issue(key, summary, resolved="2026-03-01T10:00:00.000+0000", parent=None):
    fields = {
        "summary": summary,
        "status": {"name": "Done", "statusCategory": {"key": "done"}},
        "issuetype": {"name": "Task"},
        "created": "2026-02-01T10:00:00.000+0000",
        "resolutiondate": resolved,
    }
    if parent:
        fields["parent"] = {"key": parent}
    return {"key": key, "id": key.split("-")[1], "fields": fields}


class FullRebuildKeepsPriorRows(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="archive-test-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.cache = os.path.join(self.tmp, "cache")
        os.makedirs(self.cache)
        self.data_json = os.path.join(self.tmp, "data.json")
        # T-2 has a cache file from an earlier run; T-3 only exists as a completed[] row.
        with open(os.path.join(self.cache, "T-2.json"), "w", encoding="utf-8") as f:
            json.dump({"key": "T-2", "title": "old T-2", "resolved": "2026-01-15T00:00:00Z", "mine": True, "url": "u"}, f)
        with open(self.data_json, "w", encoding="utf-8") as f:
            json.dump({"tickets": [], "completed": [
                {"key": "T-3", "title": "old T-3", "resolved": "2026-01-10T00:00:00Z", "mine": True, "url": "u"},
            ]}, f)

        self.writes = []

        def fake_write_outputs(data, intern_dir=None):
            self.writes.append(json.loads(json.dumps(data)))
            with open(self.data_json, "w", encoding="utf-8") as f:
                json.dump(data, f)

        real_build = ca.build_completed

        def flaky_build(issue_, prior, dev_map, children, pr_overrides, mine, inherit_details=True, **kw):
            if issue_["key"] in ("T-2", "T-3"):
                raise RuntimeError("boom " + issue_["key"])
            return real_build(issue_, prior, dev_map, children, pr_overrides, mine, inherit_details, **kw)

        self.issues = [issue("T-1", "new T-1"), issue("T-2", "new T-2"), issue("T-3", "new T-3")]
        patches = [
            mock.patch.object(ca, "CACHE", self.cache),
            mock.patch.object(ca, "DATA_JSON", self.data_json),
            mock.patch.object(ca, "INTERN", self.tmp),
            mock.patch.object(ca, "search_jira", lambda jql, **k: list(self.issues)),
            mock.patch.object(ca, "search_keys", lambda keys, **k: []),
            mock.patch.object(ca.devinfo, "fetch_many", lambda *a, **k: {}),
            mock.patch.object(ca, "my_identity", lambda: None),  # offline: who "me" is is never read here
            mock.patch.object(ca, "_refresh_raised", lambda: (False, 0)),  # offline: it would ask Jira for raised[]
            mock.patch.object(ca, "set_progress", lambda *a, **k: None),
            mock.patch.object(ca, "clear_progress", lambda *a, **k: None),
            mock.patch.object(ca, "prepend_status", lambda *a, **k: None),
            mock.patch.object(ca, "write_outputs", fake_write_outputs),
            mock.patch.object(ca, "build_completed", flaky_build),
            mock.patch.dict(os.environ, {"JIRA_PERSONAL_TOKEN": "x", "ARCHIVE_SCOPE": "all"}),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def test_failed_builds_keep_prior_rows_and_exit_nonzero(self):
        err = mock.MagicMock()
        with mock.patch.object(sys, "stdout", mock.MagicMock()), mock.patch.object(sys, "stderr", err):
            code = ca._main("2026-03-02T00:00:00Z")
        self.assertEqual(code, 4)  # partial: rows merged, previous rows kept, no agent fallback
        with open(self.data_json, encoding="utf-8") as f:
            completed = {row["key"]: row for row in json.load(f)["completed"]}
        self.assertEqual(set(completed), {"T-1", "T-2", "T-3"})
        self.assertEqual(completed["T-1"]["title"], "new T-1")
        self.assertEqual(completed["T-2"]["title"], "old T-2")  # cache file untouched, not pre-deleted
        self.assertEqual(completed["T-3"]["title"], "old T-3")  # no cache: previous completed[] row kept
        self.assertTrue(os.path.isfile(os.path.join(self.cache, "T-1.json")))
        self.assertTrue(os.path.isfile(os.path.join(self.cache, "T-2.json")))
        self.assertFalse(os.path.isfile(os.path.join(self.cache, "T-3.json")))
        warned = "".join(str(c.args[0]) for c in err.write.call_args_list)
        self.assertIn("WARN build T-2", warned)

    def test_all_good_exits_zero_and_rebuilds_every_row(self):
        with mock.patch.object(ca, "build_completed", _ORIGINAL_BUILD):
            with mock.patch.object(sys, "stdout", mock.MagicMock()):
                code = ca._main("2026-03-02T00:00:00Z")
        self.assertEqual(code, 0)
        with open(self.data_json, encoding="utf-8") as f:
            completed = {row["key"]: row for row in json.load(f)["completed"]}
        self.assertEqual({k: r["title"] for k, r in completed.items()}, {"T-1": "new T-1", "T-2": "new T-2", "T-3": "new T-3"})
        self.assertTrue(all(completed[k]["mine"] for k in completed))


# Captured before any test patches the module attribute.
_ORIGINAL_BUILD = ca.build_completed


def sub_issue(key, parent, summary, itype="Sub-task", labels=(), who="Tess Tester"):
    """A sub-task as Jira's search returns it (type / labels / owner are what the QA test reads)."""
    fields = {
        "summary": summary,
        "status": {"name": "Done", "statusCategory": {"key": "done"}},
        "issuetype": {"name": itype},
        "labels": list(labels),
        "parent": {"key": parent},
        "assignee": {"displayName": who, "name": who.split()[0].lower()},
        "created": "2026-02-01T10:00:00.000+0000",
        "resolutiondate": "2026-03-01T10:00:00.000+0000",
    }
    return {"key": key, "id": key.split("-")[1], "fields": fields}


class QaSubtasksAreNested(unittest.TestCase):
    """A closed ticket's QA sub-task belongs to a tester, not to me — it must still reach subtasks[],
    or the closure report says "no QA sub-task on the ticket" for every closed ticket."""

    def build(self, children=(), qa_children=(), prior=None):
        return ca.build_completed(issue("T-1", "Parent"), prior, {}, list(children), {}, True, qa_children=qa_children)

    def test_qa_subtask_of_someone_else_is_nested_as_not_mine(self):
        mine = sub_issue("T-2", "T-1", "Implement the export", who="Me Myself")
        qa = sub_issue("T-3", "T-1", "QA: verify the export", labels=["qa"])
        subs = {s["key"]: s for s in self.build(children=[mine], qa_children=[qa])["subtasks"]}
        self.assertEqual(sorted(subs), ["T-2", "T-3"])
        self.assertTrue(subs["T-2"]["mine"])
        self.assertFalse(subs["T-3"]["mine"])
        self.assertEqual(subs["T-3"]["assignee"], "Tess Tester (TESS)")
        self.assertEqual(self.build(children=[mine], qa_children=[qa])["subtaskCount"], 2)

    def test_a_qa_subtask_that_is_also_mine_is_not_duplicated(self):
        qa = sub_issue("T-3", "T-1", "QA: verify the export")
        subs = self.build(children=[qa], qa_children=[qa])["subtasks"]
        self.assertEqual([(s["key"], s["mine"]) for s in subs], [("T-3", True)])

    def test_a_failed_qa_lookup_keeps_the_cached_qa_subtasks(self):
        prior = {"subtasks": [
            {"key": "T-3", "title": "QA: verify", "mine": False},
            {"key": "T-9", "title": "an old mine row", "mine": True},  # mine rows come from this run's search, not the cache
        ]}
        kept = self.build(qa_children=None, prior=prior)["subtasks"]
        self.assertEqual([s["key"] for s in kept], ["T-3"])

    def test_a_successful_empty_lookup_drops_stale_qa_subtasks(self):
        prior = {"subtasks": [{"key": "T-3", "title": "QA: verify", "mine": False}]}
        self.assertEqual(self.build(qa_children=[], prior=prior)["subtasks"], [])


class FetchQaChildren(unittest.TestCase):
    def fetch(self, parents, issues=None, fail=False):
        def fake_search(jql, **k):
            if fail:
                raise RuntimeError("jira down")
            return issues or []
        with mock.patch.object(ca, "search_jira", fake_search):
            return ca.fetch_qa_children(parents)

    def test_keeps_only_qa_subtasks_grouped_by_parent(self):
        found = self.fetch(["T-1", "T-5", "T-7"], [
            sub_issue("T-2", "T-1", "Implement the export"),                      # plain sibling: not fetched
            sub_issue("T-3", "T-1", "QA: verify the export"),                     # title prefix
            sub_issue("T-6", "T-5", "Check it on staging", labels=["qa"]),        # label
            sub_issue("T-8", "T-5", "Anything", itype="QA Task"),                 # type
        ])
        self.assertEqual({k: [i["key"] for i in v] for k, v in found.items()},
                         {"T-1": ["T-3"], "T-5": ["T-6", "T-8"], "T-7": []})

    def test_a_failed_search_leaves_the_parents_out_instead_of_mapping_them_to_none_found(self):
        found = self.fetch(["T-1", "T-5"], fail=True)
        self.assertEqual(found, {})
        self.assertIsNone(found.get("T-1"))   # → build_completed carries the cached QA sub-tasks forward

    def test_asks_in_chunks_of_100(self):
        calls = []
        with mock.patch.object(ca, "search_jira", lambda jql, **k: calls.append(jql) or []):
            found = ca.fetch_qa_children(f"T-{n}" for n in range(1, 251))
        self.assertEqual(len(calls), 3)
        self.assertEqual(len(found), 250)


ME = {"key": "JIRAUSER100", "name": "dev01", "displayName": "Doe, Alex"}
LEAD = {"key": "JIRAUSER200", "name": "lead1", "displayName": "Roe, Sam"}


def taken_issue(key, status, assignee, histories, resolution=None, resolved=None, reporter=None):
    fields = {
        "summary": f"{key} work", "status": {"name": status, "statusCategory": {"key": "done" if status == "Done" else "new"}},
        "issuetype": {"name": "Story"}, "created": "2026-09-01T10:00:00.000+0000", "updated": "2026-10-22T10:00:00.000+0000",
        "resolutiondate": resolved, "assignee": assignee, "resolution": {"name": resolution} if resolution else None,
        "reporter": reporter,
    }
    return {"key": key, "id": key.split("-")[1], "fields": fields, "changelog": {"histories": histories}}


def hist(day, author, *items):
    return {"created": f"2026-{day}T10:00:00.000+0000", "author": author, "items": list(items)}


def moved(frm, to):
    return {"field": "assignee", "from": (frm or {}).get("key"), "fromString": (frm or {}).get("displayName"),
            "to": (to or {}).get("key"), "toString": (to or {}).get("displayName")}


class TakenFromMe(unittest.TestCase):
    """A ticket taken from me while still OPEN is kept in the archive — otherwise it vanishes from the board and the
    archive the day it leaves me — with its real column and the reason."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="archive-taken-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.cache = os.path.join(self.tmp, "cache")
        os.makedirs(self.cache)
        self.data_json = os.path.join(self.tmp, "data.json")
        with open(self.data_json, "w", encoding="utf-8") as f:
            json.dump({"tickets": [], "completed": []}, f)
        worked = [hist("09-01", LEAD, moved(None, ME)), hist("09-02", ME, {"field": "status", "toString": "In Progress"})]
        self.issues = [
            # un-assigned by the lead after I worked on it: still open, To Do, nobody on it
            taken_issue("T-1", "To Do", None, worked + [hist("10-22", LEAD, {"field": "status", "toString": "To Do"}, moved(ME, None))]),
            # open and still mine: it is on the board, not in the archive
            taken_issue("T-2", "In Progress", ME, worked),
            # passed to QA, who closed it: delivered, a normal archive row
            taken_issue("T-3", "Done", LEAD, worked + [hist("10-01", ME, {"field": "status", "toString": "Ready for QA"}, moved(ME, LEAD))], resolved="2026-10-05T10:00:00.000+0000"),
        ]
        self.writes = []

        def fake_write_outputs(data, intern_dir=None):
            self.writes.append(json.loads(json.dumps(data)))
            with open(self.data_json, "w", encoding="utf-8") as f:
                json.dump(data, f)

        for p in [
            mock.patch.object(ca, "CACHE", self.cache),
            mock.patch.object(ca, "DATA_JSON", self.data_json),
            mock.patch.object(ca, "INTERN", self.tmp),
            mock.patch.object(ca, "search_jira", lambda jql, **k: [] if jql.startswith("parent in") else list(self.issues)),
            mock.patch.object(ca, "search_keys", lambda keys, **k: []),
            mock.patch.object(ca, "jira_get", lambda path, **k: dict(ME) if path.endswith("/myself") else {}),
            mock.patch.object(ca.devinfo, "fetch_many", lambda *a, **k: {}),
            mock.patch.object(ca, "set_progress", lambda *a, **k: None),
            mock.patch.object(ca, "clear_progress", lambda *a, **k: None),
            mock.patch.object(ca, "prepend_status", lambda *a, **k: None),
            mock.patch.object(ca, "_refresh_raised", lambda: (False, 0)),
            mock.patch.object(ca, "write_outputs", fake_write_outputs),
            mock.patch.dict(os.environ, {"JIRA_PERSONAL_TOKEN": "x", "ARCHIVE_SCOPE": "all"}),
        ]:
            p.start()
            self.addCleanup(p.stop)

    def rows(self):
        self.assertEqual(ca._main("t"), 0)
        return {r["key"]: r for r in self.writes[-1]["completed"]}

    def test_an_open_ticket_taken_from_me_is_kept_with_its_real_column_and_reason(self):
        rows = self.rows()
        self.assertIn("T-1", rows)
        self.assertEqual((rows["T-1"]["column"], rows["T-1"]["done"]), ("todo", False))
        self.assertEqual(rows["T-1"]["takenFromMe"]["reason"], "backlog")
        self.assertEqual(rows["T-1"]["takenFromMe"]["by"], "Roe, Sam")

    def test_open_and_still_mine_stays_on_the_board_and_a_qa_hand_off_is_a_normal_row(self):
        rows = self.rows()
        self.assertNotIn("T-2", rows)
        self.assertEqual((rows["T-3"]["column"], rows["T-3"]["done"]), ("done", True))
        self.assertIsNone(rows["T-3"].get("takenFromMe"))

    def test_rows_taken_while_open_sit_on_the_timeline_at_the_day_they_left_me(self):
        self.assertEqual(ca._row_date({"resolved": None, "takenFromMe": {"when": "2026-10-22"}}), "2026-10-22")
        self.assertEqual(ca._row_date({"resolved": "2026-10-05", "takenFromMe": {"when": "2026-10-22"}}), "2026-10-05")

    def test_without_an_identity_the_earlier_verdict_is_kept(self):
        prior = {"takenFromMe": {"reason": "backlog"}}
        got = ca.build_completed(self.issues[2], prior, {}, [], {}, True, me=None)
        self.assertEqual(got["takenFromMe"], {"reason": "backlog"})

    def test_sub_tickets_i_raised_are_nested_too(self):
        mine_raised = taken_issue("T-9", "In Progress", LEAD, [], reporter=ME)
        mine_raised["fields"]["parent"] = {"key": "T-1"}
        with mock.patch.object(ca, "search_jira", lambda jql, **k: [mine_raised]):
            found = ca.fetch_qa_children(["T-1"], me=ME)
        self.assertEqual([i["key"] for i in found["T-1"]], ["T-9"])
        with mock.patch.object(ca, "search_jira", lambda jql, **k: [mine_raised]):
            self.assertEqual(ca.fetch_qa_children(["T-1"])["T-1"], [])  # without `me`: QA ones only, as before


class MineFlags(unittest.TestCase):
    def test_full_run_uses_search_membership(self):
        flags = ca.mine_flags(["A-1", "A-2"], {}, {"A-1"}, scoped=False)
        self.assertEqual(flags, {"A-1": True, "A-2": False})

    def test_scoped_run_prefers_cache_then_asks_jira(self):
        asked = []

        def fake_search(jql, fields=None, expand=None):
            asked.append(jql)
            return [{"key": "A-3"}]

        priors = {"A-1": {"mine": False}, "A-2": None}
        with mock.patch.object(ca, "search_jira", fake_search):
            flags = ca.mine_flags(["A-1", "A-2", "A-3"], priors, {"A-1", "A-2", "A-3"}, scoped=True)
        self.assertEqual(flags, {"A-1": False, "A-2": False, "A-3": True})
        self.assertEqual(len(asked), 1)
        self.assertIn("key in (A-2,A-3)", asked[0])
        self.assertIn("assignee was currentUser()", asked[0])


class Scope(unittest.TestCase):
    def test_bad_key_falls_back_to_all(self):
        with mock.patch.dict(os.environ, {"ARCHIVE_SCOPE": "key", "ARCHIVE_KEY": "proj-1; rm"}):
            self.assertEqual(ca._scope()[0], "all")
        with mock.patch.dict(os.environ, {"ARCHIVE_SCOPE": "key", "ARCHIVE_KEY": "proj-12"}):
            scope, _y, _s, key = ca._scope()
            self.assertEqual((scope, key), ("key", "PROJ-12"))


if __name__ == "__main__":
    unittest.main()
