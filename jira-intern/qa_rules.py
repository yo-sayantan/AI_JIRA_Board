"""What makes a ticket a QA ticket — shared by the fetch (daily_fetch.py pulls QA tickets that are not
assigned to me onto the board) and the drag-and-drop rules (transition.py). Mirror of `isQaTicket` in
src/lib/moveRules.ts: change one, change the other."""
import re

_QA_TYPE = re.compile(r"(^|[^a-z0-9])qa([^a-z0-9]|$)", re.I)
# A label that marks the ticket ITSELF as QA — not one about a dev ticket's QA ("qa-failed", "needs-qa").
QA_LABEL = re.compile(r"^(qa|qa[-_ ]?(ticket|task|test|testing)|test(ing)?([-_ ]?(ticket|task))?)$", re.I)
_QA_TITLE_LEAD = re.compile(r"^\s*\[?\s*qa\b", re.I)
_QA_TITLE_PREFIX = re.compile(r"\bqa\s*[:\-–—]", re.I)


def is_qa_ticket(type_name, title, labels=()):
    """A QA ticket: its TYPE says QA / Test, a label marks it (QA_LABEL), or its TITLE leads with a QA prefix
    ("QA: …", "[QA] …"). Stricter than transition.is_qa (a dev ticket that merely says "verify" is not one)
    because it locks the ticket into the QA lane."""
    type_name, title = type_name or "", title or ""
    return bool(
        _QA_TYPE.search(type_name)
        or re.search("test", type_name, re.I)
        or any(QA_LABEL.match((l or "").strip()) for l in labels or ())
        or _QA_TITLE_LEAD.search(title)
        or _QA_TITLE_PREFIX.search(title)
    )


def qa_column(column, type_name, title, labels=()):
    """The board column of a ticket whose status mapped to `column`. A QA ticket (is_qa_ticket) never sits among the
    dev stages: one the QA team is working under its own status ("In validation", "In Progress", "In Review") is QA
    In Progress, so those columns become `qa`. To Do / Blocked / On Hold / Done keep their meaning. Mirror of
    `qaColumn` in src/lib/moveRules.ts: change one, change the other."""
    if column in ("prog", "rev") and is_qa_ticket(type_name, title, labels):
        return "qa"
    return column
