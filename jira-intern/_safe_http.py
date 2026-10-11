#!/usr/bin/env python3
"""Hardened urllib plumbing for the proof sources (jenkins.py, checkmarx.py), which send credentials.

- `SameOriginRedirect` follows a redirect only to the SAME scheme + host + port, so an Authorization
  header (or a POSTed key) never travels to another host, and https is never downgraded to http.
  A refused redirect raises HTTPError with the 3xx code — callers treat it as a failed lookup.
- `verified_context` is a TLS context that is ALWAYS verified unless the caller's own opt-out
  variable is "1" (JIRA_INSECURE_TLS never applies here). A corporate proxy CA from JIRA_CA_BUNDLE /
  ~/.ai/ca-bundle.pem is ADDED to the system roots.
Stdlib only.
"""
import os
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_CA_BUNDLE = os.path.expanduser("~/.ai/ca-bundle.pem")


def _origin(url):
    p = urllib.parse.urlsplit(url)
    scheme = (p.scheme or "").lower()
    port = p.port or {"https": 443, "http": 80}.get(scheme)
    return scheme, (p.hostname or "").lower(), port


class SameOriginRedirect(urllib.request.HTTPRedirectHandler):
    """Redirects stay on the origin they started from, or they are refused."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        newurl = urllib.parse.urljoin(req.full_url, newurl)
        if _origin(newurl) != _origin(req.full_url):
            raise urllib.error.HTTPError(req.full_url, code, f"refused redirect to another origin ({msg})", headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def verified_context(insecure_env=None, who="proof"):
    if insecure_env and os.environ.get(insecure_env) == "1":
        sys.stderr.write(f"WARN {who}: TLS verification disabled ({insecure_env}=1)\n")
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        return ctx
    ctx = ssl.create_default_context()
    bundle = (os.environ.get("JIRA_CA_BUNDLE") or "").strip() or (DEFAULT_CA_BUNDLE if os.path.isfile(DEFAULT_CA_BUNDLE) else "")
    if bundle:
        try:
            ctx.load_verify_locations(cafile=bundle)
        except (OSError, ssl.SSLError) as e:
            sys.stderr.write(f"WARN {who}: CA bundle {bundle} not loaded ({e}); system roots only\n")
    return ctx


def opener(context):
    """An opener with the given TLS context whose only redirect handler is SameOriginRedirect."""
    return urllib.request.build_opener(urllib.request.HTTPSHandler(context=context), SameOriginRedirect())
