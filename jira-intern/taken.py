"""Was this ticket taken from me — and why? Pure: no network, no clock; same input → same answer.

The archive (completed_archive.py) asks this for every ticket that was ever assigned to me. The answer goes on the row
as `takenFromMe` (src/types.ts::TakenFromMe) and drives the Completed view's "Taken from you" banner and filter.

Reasons, in the order they weigh (the first that applies is the headline; every one that applies is listed):
  cancelled    closed with a cancel-type resolution or status (Cancelled, Won't Do, Rejected, Duplicate…)
  pr-declined  my pull requests on it were declined and none merged
  backlog      someone else un-assigned it — back to the backlog / for another team
  taken-over   someone else gave it to another person after it was In Progress / In Review on my name
  reassigned   someone else gave it to another person while it was still To Do on my name
  released     I un-assigned myself (or passed it on) before it reached QA

NOT taken (None): a ticket still on my name that was delivered, and the normal hand-off — it left me once it had
reached QA or Done (I passed it to the tester, or QA picked it up).

The changelog names people by their user KEY (on Data Center an opaque "JIRAUSER123"), comments by display name, so
`me` carries both: {"key", "name", "displayName"} — see completed_archive.my_identity.
"""
import html
import re

from _jira import status_column

REASONS = ("cancelled", "pr-declined", "backlog", "taken-over", "reassigned", "released")

# Resolution / status words that mean "called off", not "delivered". Compared lower-case and whole.
_CANCEL = {
    "cancelled", "canceled", "won't do", "wont do", "won’t do", "won't fix", "wont fix", "won’t fix", "rejected",
    "duplicate", "obsolete", "abandoned", "descoped", "de-scoped", "out of scope", "not needed", "withdrawn",
    "invalid", "declined", "removed",
}

# A tag is at most 1,000 characters between < and > — bounded, so hostile comment HTML cannot make this slow.
_TAG = re.compile(r"<[^<>]{0,1000}>")
_SPACE = re.compile(r"\s+")
MAX_BODY = 20_000
WHY_CHARS = 320
# The explaining comment is usually written when the ticket is moved; later ones are about someone else's work.
WHY_DAYS = 21


def _lower(v):
    return str(v or "").strip().lower()


def _is_me(me, key=None, name=None, display=None):
    me = me or {}
    k, n, d = _lower(me.get("key")), _lower(me.get("name")), _lower(me.get("displayName"))
    return bool((k and _lower(key) == k) or (n and _lower(name) == n) or (d and _lower(display) == d))


def is_cancelled(resolution, status):
    return _lower(resolution) in _CANCEL or _lower(status) in _CANCEL


def plain_text(body):
    """Comment HTML → one line of text (tags dropped, entities decoded, whitespace collapsed)."""
    text = _TAG.sub(" ", str(body or "")[:MAX_BODY])
    return _SPACE.sub(" ", html.unescape(text)).strip()


def _excerpt(text, limit=WHY_CHARS):
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _col(status):
    """The board column of a status; an unknown starting status (no transition in the history yet) is To Do, not the
    status_column fallback's In Progress — nothing had started."""
    return status_column(status) if status else "todo"


def _day(iso):
    return str(iso or "")[:10]


def _days_between(a, b):
    """Whole days from ISO date `a` to `b` (b - a); None when either is missing or unparsable."""
    try:
        from datetime import date

        da, db = date.fromisoformat(_day(a)), date.fromisoformat(_day(b))
        return (db - da).days
    except (TypeError, ValueError):
        return None


def last_departure(changelog, me):
    """The LAST time the ticket left me: {when, by, byMe, to, statusThen, reachedWork} or None.

    `statusThen` is the status right after that change (a transition and a re-assignment saved together count as one
    edit, so "Ready for QA → assign the tester" reads as a QA hand-off). `reachedWork` — while it was on my name, did it
    reach In Progress / In Review? That separates "taken over mid-work" from "reassigned before I started"."""
    histories = sorted((changelog or {}).get("histories") or [], key=lambda h: h.get("created") or "")
    status, mine, reached, out = None, False, False, None
    # A ticket created on my name has no "assigned to me" entry: if the first assignee change is FROM me, it was mine
    # from the start.
    first = next((it for h in histories for it in h.get("items") or [] if it.get("field") == "assignee"), None)
    if first and _is_me(me, key=first.get("from"), display=first.get("fromString")):
        mine = True
    for h in histories:
        items = h.get("items") or []
        for it in items:
            if it.get("field") == "status":
                status = it.get("toString") or status
        if mine and _col(status) in ("prog", "rev"):
            reached = True
        for it in items:
            if it.get("field") != "assignee":
                continue
            was_me = _is_me(me, key=it.get("from"), display=it.get("fromString"))
            now_me = _is_me(me, key=it.get("to"), display=it.get("toString"))
            if now_me and not was_me:
                mine, reached = True, _col(status) in ("prog", "rev")
            elif was_me and not now_me:
                author = h.get("author") or {}
                out = {
                    "when": h.get("created"),
                    "by": author.get("displayName"),
                    "byMe": _is_me(me, key=author.get("key"), name=author.get("name"), display=author.get("displayName")),
                    "to": it.get("toString") or None,
                    "statusThen": status,
                    "reachedWork": reached,
                }
                mine = False
    return out


def why_comment(comments, me, since=None, prefer=None):
    """The comment that most likely says why: written by someone other than me, from `since` (the day it left me)
    and within WHY_DAYS of it — by `prefer` (whoever moved it) when they wrote one. With no `since` (a ticket still on
    my name that was called off) it is the newest comment that is not mine."""
    rows = [c for c in comments or [] if isinstance(c, dict) and not _is_me(me, display=c.get("author"))]
    rows.sort(key=lambda c: c.get("when") or "")
    if since:
        rows = [c for c in rows if _day(c.get("when")) >= _day(since)]
        rows = [c for c in rows if (_days_between(since, c.get("when")) or 0) <= WHY_DAYS]
    else:
        rows = rows[::-1]
    preferred = [c for c in rows if prefer and _lower(c.get("author")) == _lower(prefer)]
    for c in preferred + rows:
        text = plain_text(c.get("body"))
        if text:
            # `byMover`: written by whoever moved it — the likeliest explanation. Otherwise it is only the next comment,
            # and the board labels it that way rather than as a reason.
            by_mover = bool(prefer) and _lower(c.get("author")) == _lower(prefer)
            return {"author": c.get("author"), "when": c.get("when"), "text": _excerpt(text), "byMover": by_mover}
    return None


def _pr_label(p):
    return f"PR #{p.get('id')}" if p.get("id") is not None else "a PR"


def evidence_of_work(departure, prs, comments, me, raised_subtasks=0):
    """What shows I worked on it — shown on the row, and `worked` is true when there is any."""
    out = []
    if prs:
        states = sorted({str(p.get("state") or "none") for p in prs})
        out.append(", ".join(_pr_label(p) for p in prs[:3]) + (f" (+{len(prs) - 3})" if len(prs) > 3 else "") + f" — {'/'.join(states)}")
    if departure and departure.get("reachedWork"):
        out.append("In Progress on your name")
    mine_comments = sum(1 for c in comments or [] if isinstance(c, dict) and _is_me(me, display=c.get("author")))
    if mine_comments:
        out.append(f"{mine_comments} comment{'' if mine_comments == 1 else 's'} by you")
    if raised_subtasks:
        out.append(f"{raised_subtasks} sub-ticket{'' if raised_subtasks == 1 else 's'} you raised")
    return out


def analyse(issue, me, prs=(), comments=(), raised_subtasks=0):
    """`takenFromMe` for one ticket ever assigned to me, or None when nothing was taken.

    `issue` is the search payload (fields + changelog), `prs` the ticket's own PRs (after scope_to_ticket), `comments`
    the formatted comments ({author, when, body}). `me` None → None: without knowing who I am nothing can be judged."""
    if not me or not (me.get("key") or me.get("name") or me.get("displayName")):
        return None
    f = issue.get("fields") or {}
    status = (f.get("status") or {}).get("name")
    resolution = (f.get("resolution") or {}).get("name")
    assignee = f.get("assignee") or {}
    still_mine = bool(assignee) and _is_me(me, key=assignee.get("key"), name=assignee.get("name"), display=assignee.get("displayName"))
    prs = [p for p in prs or [] if isinstance(p, dict)]

    reasons = []
    if is_cancelled(resolution, status):
        reasons.append("cancelled")
    declined = [p for p in prs if p.get("state") == "declined"]
    if declined and not any(p.get("state") == "merged" or p.get("merged") for p in prs):
        reasons.append("pr-declined")

    dep = None if still_mine else last_departure(issue.get("changelog"), me)
    if dep:
        handoff = _col(dep.get("statusThen")) in ("qa", "done")
        if not handoff:
            if dep["byMe"]:
                reasons.append("released")
            elif not dep.get("to"):
                reasons.append("backlog")
            elif dep.get("reachedWork"):
                reasons.append("taken-over")
            else:
                reasons.append("reassigned")
        elif not reasons:
            return None  # the normal hand-off to QA: delivered, not taken

    if not reasons:
        return None
    reasons = [r for r in REASONS if r in reasons]
    work = evidence_of_work(dep, prs, comments, me, raised_subtasks)
    return {
        "reason": reasons[0],
        "reasons": reasons,
        "when": dep.get("when") if dep else (f.get("resolutiondate") or None),
        "by": dep.get("by") if dep else None,
        "byMe": bool(dep and dep.get("byMe")),
        "to": dep.get("to") if dep else None,
        "statusThen": dep.get("statusThen") if dep else None,
        "stillMine": still_mine,
        "resolution": resolution or None,
        "worked": bool(work),
        "workedOn": work,
        "declinedPrs": [_pr_label(p) for p in declined],
        "why": _why(comments, me, dep, reasons),
    }


def _why(comments, me, dep, reasons):
    """The comment written when it left me; for a ticket that was called off later, the newest comment by someone else
    (the cancellation note can come weeks after the re-assignment)."""
    found = why_comment(comments, me, since=dep.get("when"), prefer=dep.get("by")) if dep else None
    if not found and (not dep or "cancelled" in reasons):
        found = why_comment(comments, me)
    return found
