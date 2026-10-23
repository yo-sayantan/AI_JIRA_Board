#!/usr/bin/env python3
"""taken.py: which of my tickets were taken from me, and why. Pure — built from hand-made changelogs, no network.
Every scenario here is one seen on a real board (anonymised)."""
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "jira-intern"))
import taken  # noqa: E402

ME = {"key": "JIRAUSER100", "name": "dev01", "displayName": "Doe, Alex"}
LEAD = {"key": "JIRAUSER200", "name": "lead1", "displayName": "Roe, Sam"}
QA = {"key": "JIRAUSER300", "name": "qa01", "displayName": "Tester, Tess"}


def h(when, author, *items):
    return {"created": f"2026-{when}T10:00:00.000+0000", "author": author, "items": list(items)}


def status(to):
    return {"field": "status", "toString": to}


def assign(frm, to):
    return {"field": "assignee", "from": (frm or {}).get("key"), "fromString": (frm or {}).get("displayName"),
            "to": (to or {}).get("key"), "toString": (to or {}).get("displayName")}


def issue(histories, status_now="To Do", assignee=None, resolution=None, resolved=None):
    fields = {"status": {"name": status_now}, "assignee": assignee, "resolution": {"name": resolution} if resolution else None,
              "resolutiondate": resolved}
    return {"key": "T-1", "fields": fields, "changelog": {"histories": histories}}


def comment(author, when, body):
    return {"author": author["displayName"], "when": f"2026-{when}T11:00:00Z", "body": body}


WORKED = [h("09-01", LEAD, assign(None, ME)), h("09-02", ME, status("In Progress"))]


class Reasons(unittest.TestCase):
    def test_unassigned_by_the_lead_after_i_worked_on_it_goes_back_to_the_backlog(self):
        t = issue(WORKED + [h("10-22", LEAD, status("To Do"), assign(ME, None))])
        why = [comment(LEAD, "10-22", "<p>Great job, but we will need to stop the conversion at this time.</p>")]
        got = taken.analyse(t, ME, prs=[{"id": 61, "state": "comments"}], comments=why)
        self.assertEqual(got["reason"], "backlog")
        self.assertEqual((got["by"], got["to"], got["byMe"], got["stillMine"]), ("Roe, Sam", None, False, False))
        self.assertTrue(got["worked"])
        self.assertIn("In Progress on your name", got["workedOn"])
        self.assertTrue(got["workedOn"][0].startswith("PR #61"))
        self.assertEqual(got["why"]["text"], "Great job, but we will need to stop the conversion at this time.")

    def test_given_to_someone_else_mid_work_is_taken_over(self):
        t = issue(WORKED + [h("09-26", LEAD, assign(ME, QA))], status_now="Work in Progress", assignee=QA)
        self.assertEqual(taken.analyse(t, ME)["reason"], "taken-over")

    def test_given_to_someone_else_before_i_started_is_reassigned(self):
        t = issue([h("06-01", LEAD, assign(None, ME)), h("06-06", LEAD, assign(ME, QA))], status_now="Done", assignee=QA)
        got = taken.analyse(t, ME)
        self.assertEqual(got["reason"], "reassigned")
        self.assertFalse(got["worked"])

    def test_cancelled_after_being_unassigned_is_called_off_first(self):
        t = issue([h("01-10", LEAD, assign(None, ME)), h("02-03", LEAD, assign(ME, None))], status_now="Done", resolution="Cancelled")
        got = taken.analyse(t, ME, comments=[comment(LEAD, "02-03", "Archiving this story due to lack of prioritization")])
        self.assertEqual(got["reason"], "cancelled")
        self.assertEqual(got["reasons"], ["cancelled", "backlog"])
        self.assertEqual(got["resolution"], "Cancelled")

    def test_still_on_my_name_but_called_off_or_pr_declined(self):
        mine = issue([h("03-01", LEAD, assign(None, ME))], status_now="Done", assignee=ME, resolution="Won't Do", resolved="2026-03-09")
        got = taken.analyse(mine, ME, comments=[comment(LEAD, "03-09", "Not needed any more")])
        self.assertEqual((got["reason"], got["stillMine"], got["when"]), ("cancelled", True, "2026-03-09"))
        self.assertEqual(got["why"]["text"], "Not needed any more")
        declined = issue([h("03-01", LEAD, assign(None, ME))], status_now="Done", assignee=ME)
        got = taken.analyse(declined, ME, prs=[{"id": 7, "state": "declined"}])
        self.assertEqual(got["reason"], "pr-declined")
        self.assertEqual(got["declinedPrs"], ["PR #7"])

    def test_a_declined_pr_with_a_merged_retry_is_not_taken(self):
        t = issue([h("03-01", LEAD, assign(None, ME))], status_now="Done", assignee=ME)
        self.assertIsNone(taken.analyse(t, ME, prs=[{"id": 7, "state": "declined"}, {"id": 8, "state": "merged"}]))

    def test_i_unassigned_myself_before_qa_is_released(self):
        t = issue([h("09-01", ME, assign(None, ME)), h("09-17", ME, assign(ME, None))])
        self.assertEqual(taken.analyse(t, ME)["reason"], "released")


class NotTaken(unittest.TestCase):
    def test_the_normal_qa_hand_off_is_not_taken(self):
        # A transition and the re-assignment saved together: "Ready for QA → the tester" is a hand-off, not a loss.
        mine = issue(WORKED + [h("09-23", ME, status("Ready for QA"), assign(ME, QA))], status_now="Done", assignee=QA)
        self.assertIsNone(taken.analyse(mine, ME))
        by_lead = issue(WORKED + [h("10-01", LEAD, status("In validation")), h("10-01", LEAD, assign(ME, QA))], status_now="Done", assignee=QA)
        self.assertIsNone(taken.analyse(by_lead, ME))

    def test_still_mine_and_delivered_is_not_taken(self):
        self.assertIsNone(taken.analyse(issue(WORKED, status_now="Done", assignee=ME, resolution="Done"), ME))

    def test_without_knowing_who_i_am_nothing_is_judged(self):
        t = issue(WORKED + [h("10-22", LEAD, assign(ME, None))])
        self.assertIsNone(taken.analyse(t, None))
        self.assertIsNone(taken.analyse(t, {}))


class Details(unittest.TestCase):
    def test_a_ticket_created_on_my_name_still_tracks_my_work(self):
        t = issue([h("09-02", ME, status("In Progress")), h("09-20", LEAD, assign(ME, QA))], status_now="In Progress", assignee=QA)
        self.assertEqual(taken.analyse(t, ME)["reason"], "taken-over")

    def test_reassigned_back_to_me_counts_only_the_last_departure(self):
        t = issue([h("01-01", LEAD, assign(None, ME)), h("01-05", LEAD, assign(ME, QA)), h("01-09", LEAD, assign(QA, ME))], assignee=ME)
        self.assertIsNone(taken.analyse(t, ME))

    def test_people_match_by_key_or_display_name_case_insensitively(self):
        t = issue(WORKED + [h("10-22", {"displayName": "ROE, SAM"}, {"field": "assignee", "fromString": "doe, alex", "to": None})])
        self.assertEqual(taken.analyse(t, ME)["reason"], "backlog")

    def test_why_prefers_the_mover_and_skips_my_own_and_stale_comments(self):
        comments = [
            comment(ME, "10-22", "my own note"),
            comment(QA, "10-23", "someone else"),
            comment(LEAD, "10-24", "<b>Priority changed</b> &amp; another team picks it up"),
            comment(LEAD, "12-30", "much later"),
        ]
        why = taken.why_comment(comments, ME, since="2026-10-22T10:00:00Z", prefer="Roe, Sam")
        self.assertEqual(why["text"], "Priority changed & another team picks it up")
        self.assertEqual(why["author"], "Roe, Sam")
        self.assertIsNone(taken.why_comment([comment(LEAD, "12-30", "much later")], ME, since="2026-10-22"))

    def test_a_cancellation_note_written_weeks_later_is_still_found(self):
        t = issue([h("01-10", LEAD, assign(None, ME)), h("02-03", LEAD, assign(ME, None))], status_now="Done", resolution="Cancelled")
        got = taken.analyse(t, ME, comments=[comment(QA, "04-20", "Archiving this story due to age")])
        self.assertEqual(got["why"]["text"], "Archiving this story due to age")
        self.assertFalse(got["why"]["byMover"])

    def test_the_movers_own_comment_is_marked_as_such(self):
        t = issue(WORKED + [h("10-22", LEAD, assign(ME, None))])
        got = taken.analyse(t, ME, comments=[comment(LEAD, "10-22", "Pausing this work")])
        self.assertTrue(got["why"]["byMover"])

    def test_the_why_is_one_capped_line(self):
        why = taken.why_comment([comment(LEAD, "10-22", "<p>" + "word " * 400 + "</p>")], ME, since="2026-10-22")
        self.assertLessEqual(len(why["text"]), taken.WHY_CHARS)
        self.assertTrue(why["text"].endswith("…"))

    def test_hostile_comment_html_is_fast(self):
        start = time.monotonic()
        taken.plain_text("<" * 50_000 + "a" * 50_000 + ">" * 50_000)
        taken.plain_text("<a " + "x" * 5_000 + ">" * 10 + "</a>" * 10_000)
        self.assertLess(time.monotonic() - start, 0.5)

    def test_cancel_words(self):
        for word in ("Cancelled", "Won't Do", "won’t fix", "Rejected", "Duplicate", "Descoped"):
            self.assertTrue(taken.is_cancelled(word, "Done"), word)
        for word in ("Done", "Fixed", "Complete", "Resolved", None):
            self.assertFalse(taken.is_cancelled(word, "Done"), word)
        self.assertTrue(taken.is_cancelled(None, "Cancelled"))


if __name__ == "__main__":
    unittest.main()
