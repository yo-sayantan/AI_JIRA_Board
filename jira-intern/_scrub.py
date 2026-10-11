"""Clean text taken from OUTSIDE systems before it is stored, shown or sent to an AI model.

Dynatrace error messages and log lines (dynatrace.py) and the tail of a Jenkins console (jenkins.py) are written by
other people's software: they can carry the token a service logged by mistake, a password in a command line, a URL with
credentials, a customer's e-mail address. Whatever the board keeps of them goes through here first:

  text(raw)      multi-line; control characters and ANSI colours dropped, secrets / tokens / credentials / e-mail
                 addresses / IP addresses replaced ("•••", "[email]", "[ip]")
  line(raw, n)   the same, on ONE line of at most n characters (ends in "…" when it was cut)
  tail(raw, …)   the last N lines (at most M characters) of a log, after text()

What is removed: Authorization headers and Bearer strings, Cookie / Set-Cookie headers, `password=` / `secret:` /
`"token": "…"` / `api_key=` values (any spelling that contains one of those words, quoted or not), the value after a
credential flag (`-p`, `--password`, `-u user:pass`), a bare hex key after the word that names it, credentials inside URLs
and token-like URL query parameters, JWTs, Dynatrace / AWS / Google / GitHub / GitLab / Slack / npm tokens, private-key blocks, long opaque base64-looking blobs (paths and commit ids
stay), and the VALUE of any environment variable whose name looks like a secret. Deliberately aggressive: a redacted
word is a nuisance, a leaked key is not. Stdlib only; never raises.
"""
import os
import re

MASK = "•••"

_ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]")
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_PRIVATE_KEY = re.compile(r"-----BEGIN [A-Z ]{0,30}PRIVATE KEY(?: BLOCK)?-----.*?(?:-----END [A-Z ]{0,30}PRIVATE KEY(?: BLOCK)?-----|\Z)", re.S)
_COOKIE = re.compile(r"(?i)\b(set-cookie|cookie)\b([ \t]{0,8}[:=][ \t]{0,8})[^\r\n]{1,2000}")
# `-u bob -p S3cr3t!`, `--password hunter2`, `--token=abc`, `curl -u admin:hunter2`: the value after a credential flag.
_CLI_FLAG = re.compile(r"(?i)(?<![\w-])(--?(?:p|pw|pass|password|passwd|passphrase|token|api-?key|secret|u|user)(?:=|[ \t]+))(?!•••)[^\s'\"]{1,200}")
# `token 11a1b2c3…` (a bare hex key after the word that says what it is).
_HEX_AFTER_WORD = re.compile(r"(?i)\b(token|key|secret|password|passwd|credential)s?\b([ \t:=-]{1,6})[0-9a-f]{32,128}\b")
_AUTH_HEADER = re.compile(r"(?i)\b(authorization|proxy-authorization)\b([ \t]{0,8}[:=][ \t]{0,8})(?:(?:bearer|basic|token|digest|negotiate)[ \t]+)?[^\s,;'\"]{1,2000}")
_BEARER = re.compile(r"(?i)\b(bearer)\s+[A-Za-z0-9._~+/=-]{6,2000}")
_BASIC = re.compile(r"(?i)\b(basic)\s+(?-i:(?=[A-Za-z0-9+/]{0,2000}[0-9A-Z=]))[A-Za-z0-9+/]{8,2000}={0,2}(?![\w])")
_URL_CREDENTIALS = re.compile(r"(?i)(?<![\w+.-])([a-z][a-z0-9+.-]{0,15})://[^/\s@:'\"<>]{1,200}(?::[^/\s@'\"<>]{0,200})?@")
_QUERY_PARAM = re.compile(
    r"(?i)(?<=[?&])([^=&\s#]{0,60}?(?:sig|signature|key|secret|token|pass|auth|credential|session|code)[^=&\s#]{0,60})=([^&\s#'\"]{1,2000})"
)
_KEY_VALUE = re.compile(
    r"""(?ix)
    (?<![\w.-])(?P<key>[\w.-]{0,60}?(?:password|passwd|passphrase|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?|authorization)[\w.-]{0,60})
    (?P<sep>["']?[ \t]{0,8}[:=][ \t]{0,8})
    (?P<val>"[^"\n]{0,500}"|'[^'\n]{0,500}'|(?!•••)[^\s'"&]{1,500})
    """
)
_TOKEN_SHAPES = (
    re.compile(r"\beyJ[A-Za-z0-9_-]{8,2000}\.[A-Za-z0-9_-]{8,2000}\.[A-Za-z0-9_-]{0,2000}"),  # JWT
    re.compile(r"\bdt0[a-z]\d{2}\.[A-Za-z0-9]{8,64}\.[A-Za-z0-9]{20,200}"),  # Dynatrace token
    re.compile(r"\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}\b"),  # AWS access key id
    re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b"),  # Google API key
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,200}\b|\bgithub_pat_[A-Za-z0-9_]{20,200}|\bglpat-[A-Za-z0-9_-]{20,200}"),  # GitHub, GitLab
    re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,200}|hooks\.slack\.com/services/[A-Za-z0-9/]{20,200}"),  # Slack
    re.compile(r"\bnpm_[A-Za-z0-9]{36}\b|\bsk-[A-Za-z0-9_-]{20,200}"),  # npm, an API secret key
)
_EMAIL = re.compile(r"(?<![\w.+-])[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,8}")
_IPV4 = re.compile(r"(?<![\w.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\w]|\.\d)")
_IPV6 = (
    re.compile(r"(?<![\w:])(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}(?![\w:])"),
    re.compile(r"(?<![\w:])(?:[0-9A-Fa-f]{1,4}:){1,6}:(?:[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{1,4}){0,5})?(?![\w:])"),
)
_BLOB = re.compile(r"(?<![\w/.+=-])[A-Za-z0-9+/=_-]{32,4096}(?![\w/+=-])")
_SECRET_ENV_NAME = re.compile(r"(?i)(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|(?:^|_)KEY$|(?:^|_)PAT$)")


def _blob(m):
    s = m.group(0)
    if s.startswith(("/", "./", "../")) or s.count("/") > 3:
        return s  # a path
    if re.search(r"[A-Z]", s) and re.search(r"[a-z]", s) and re.search(r"\d", s):
        return MASK
    return s  # a commit id / hex digest / identifier: not a secret


def _env_values():
    out = []
    for name, value in os.environ.items():
        if _SECRET_ENV_NAME.search(name) and isinstance(value, str) and len(value.strip()) >= 6:
            out.append(value.strip())
    return sorted(set(out), key=len, reverse=True)  # longest first: a value that contains another goes whole


def _normalise(raw):
    s = str(raw if raw is not None else "")
    s = s.replace("\r\n", "\n")
    s = _ANSI.sub("", s)
    s = _CONTROL.sub("", s)
    lines = []
    for ln in s.split("\n"):
        if "\r" in ln:  # a progress bar redraws one line: keep its final state
            parts = [p for p in ln.split("\r") if p.strip()]
            ln = parts[-1] if parts else ""
        lines.append(ln.replace("\t", "  ").rstrip())
    return "\n".join(lines)


MAX_INPUT = 65536  # characters looked at: the patterns below are bounded, but text from another system has no business being longer


def text(raw, max_chars=None, ips=True, max_input=MAX_INPUT):
    """`raw` cleaned of secrets and control characters, newlines kept; the head is kept when it is cut to `max_chars`.
    Only the first `max_input` characters are looked at."""
    try:
        s = _normalise(str(raw if raw is not None else "")[:max_input])
        for value in _env_values():
            s = s.replace(value, MASK)
        s = _PRIVATE_KEY.sub("[private key removed]", s)
        s = _COOKIE.sub(lambda m: f"{m.group(1)}{m.group(2)}{MASK}", s)
        s = _AUTH_HEADER.sub(lambda m: f"{m.group(1)}{m.group(2)}{MASK}", s)
        s = _BEARER.sub(lambda m: f"{m.group(1)} {MASK}", s)
        s = _BASIC.sub(lambda m: f"{m.group(1)} {MASK}", s)
        for rx in _TOKEN_SHAPES:
            s = rx.sub(MASK, s)
        s = _URL_CREDENTIALS.sub(lambda m: f"{m.group(1)}://{MASK}@", s)
        s = _QUERY_PARAM.sub(lambda m: f"{m.group(1)}={MASK}", s)
        s = _CLI_FLAG.sub(lambda m: f"{m.group(1)}{MASK}", s)
        s = _HEX_AFTER_WORD.sub(lambda m: f"{m.group(1)}{m.group(2)}{MASK}", s)
        s = _KEY_VALUE.sub(lambda m: f"{m.group('key')}{m.group('sep')}{MASK}" if MASK not in m.group("val") else m.group(0), s)
        s = _EMAIL.sub("[email]", s)
        if ips:
            s = _IPV4.sub("[ip]", s)
            for rx in _IPV6:
                s = rx.sub("[ip]", s)
        s = _BLOB.sub(_blob, s)
        s = re.sub(r"\n{3,}", "\n\n", s).strip("\n")
        if max_chars is not None and len(s) > max_chars:
            s = s[: max(0, max_chars - 1)].rstrip() + "…"
        return s
    except Exception:  # noqa: BLE001 — a scrub must never break a fetch; on failure keep nothing rather than the raw text
        return ""


def line(raw, max_chars=200, ips=True):
    """One line of at most `max_chars` characters (the last one is "…" when the text was cut)."""
    s = re.sub(r"\s+", " ", text(raw, ips=ips, max_input=max(1024, max_chars * 8))).strip()
    if len(s) > max_chars:
        s = s[: max(0, max_chars - 1)].rstrip() + "…"
    return s


def tail(raw, lines=40, max_chars=4096, ips=True):
    """The last `lines` non-trailing-blank lines of a log, scrubbed, and at most `max_chars` characters (the START is
    cut — the end of a log is what matters — and a partly cut first line is dropped)."""
    body = text(str(raw if raw is not None else "")[-MAX_INPUT:], ips=ips)  # the END of a log is what matters
    if not body:
        return ""
    rows = body.split("\n")
    while rows and not rows[-1].strip():
        rows.pop()
    out = "\n".join(rows[-max(1, lines):])
    if len(out) > max_chars:
        out = out[-max_chars:]
        if "\n" in out:
            out = out.split("\n", 1)[1]
    return out
