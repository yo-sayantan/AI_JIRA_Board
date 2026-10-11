#!/usr/bin/env python3
"""Jenkins discovery — find which pipelines build and deploy a repository, under one root folder.

Layout this assumes (every name is free-form; only the SHAPE matters):

    <root>/<portfolio>/<application>/<pipeline>/<branch job>      a multibranch pipeline
    <root>/<portfolio>/<application>/<env folder>/<pipeline>      env folders may hold the pipelines
    <root>/<portfolio>/<application>/<deploy job>                 a plain job taking the branch as a PARAMETER

The walk reads each folder with `<folder>/api/json?tree=jobs[name,url,_class,color]`, level by level
from the root, bounded by `maxDepth` and a call budget (`maxCalls`). A folder (or pipeline) whose name
matches the repository slug (`app_folder_matches`) is an application: all of its pipelines are
collected, recursing into plain folders. Each node is classified —
  • multibranch project → the branch is a child job (read through jenkins.py's branch addressing)
  • plain job with a branch-like parameter (branch, git ref, revision, tag) → "parameterised": the
    newest of its last builds whose parameter names the branch is the latest run of that branch
  • plain job without one → ignored (it cannot be tied to a branch)
and labelled with an environment from its names (`infer_env`) and a kind — build / deploy / both.

Child URLs are built from the configured root plus the NAMES Jenkins lists, never from a URL it
returns. The answer is cached in jira-intern/.jenkins-discovery.json (atomic write; no credentials
inside) and per run in memory; a walk that fails serves the stale entry rather than wiping it.

`python3 jira-intern/jenkins.py discover <repo-slug> [--json]` prints the walk, read-only.
Stdlib only, like the rest of jira-intern.
"""
import copy
import hashlib
import json
import os
import re
import sys
import threading
import time
import urllib.parse
from collections import deque
from functools import lru_cache

import jenkins as J
from _jira import INTERN

CACHE_VERSION = 1
CACHE_MAX_AGE = 30 * 24 * 3600  # entries nobody asked for in a month are dropped on the next save
SHORT_SLUG = 3  # a slug shorter than this must match a whole folder name
LISTING_TREE = "jobs[name,url,_class,color]"
PARAM_TREE = "property[parameterDefinitions[name,type]]"

_LOCK = threading.RLock()


# ── cache file ───────────────────────────────────────────────────────────────


def cache_path():
    """jira-intern/.jenkins-discovery.json (git- and docker-ignored runtime state); JB_JENKINS_DISCOVERY_FILE moves it."""
    return os.environ.get("JB_JENKINS_DISCOVERY_FILE") or os.path.join(INTERN, ".jenkins-discovery.json")


def _load_cache():
    try:
        with open(cache_path(), encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict) and data.get("version") == CACHE_VERSION and isinstance(data.get("entries"), dict):
            return data
    except (OSError, ValueError):
        pass
    return {"version": CACHE_VERSION, "entries": {}}


def _save_cache(cache):
    now = time.time()
    cache["entries"] = {k: v for k, v in cache["entries"].items() if isinstance(v, dict) and now - (v.get("at") or 0) < CACHE_MAX_AGE}
    path = cache_path()
    tmp = f"{path}.{os.getpid()}.tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(cache, f, indent=1)
        os.replace(tmp, path)
    except OSError as e:
        sys.stderr.write(f"WARN jenkins discovery cache not written: {e}\n")
        try:
            os.unlink(tmp)
        except OSError:
            pass


def _norm_slug(slug):
    return re.sub(r"[^a-z0-9]+", "", str(slug or "").lower())


def _key(root, slug, dcfg):
    """Root + slug + a signature of everything that shapes the answer, so editing envPatterns (or
    the folder rule, or the depth) takes effect on the next run instead of after the TTL."""
    shape = json.dumps([dcfg.get("appFolderRegex"), dcfg.get("envPatterns"), dcfg.get("kindPatterns"), dcfg.get("maxDepth")], sort_keys=True)
    return f"{root}|{_norm_slug(slug)}|{hashlib.sha1(shape.encode()).hexdigest()[:10]}"


# ── matching and labelling ───────────────────────────────────────────────────


def _tokens(name):
    return [t for t in re.split(r"[^a-z0-9]+", str(name or "").lower()) if t]


def app_folder_matches(name, slug, template=None):
    """Does the folder / pipeline `name` belong to repository `slug`?

    With a `template` (config jenkins.discovery.appFolderRegex, e.g. "^{slug}(-.*)?$"): {slug} is
    replaced by the escaped slug and the regex must match the NAME, case-insensitively. An invalid
    template falls back to the default rule.
    Default: case and punctuation are ignored; the slug must equal the whole name, or a run of
    whole words of it (words split on anything that is not a letter or digit) — so `payments` matches
    `PAYMENTS-AWS` and `team-payments` but not `paymentsgateway`; a slug shorter than three
    characters must equal the name."""
    name, slug = str(name or ""), str(slug or "")
    if not slug.strip():
        return False
    if template:
        try:
            return re.search(template.replace("{slug}", re.escape(slug)), name, re.I) is not None
        except re.error:
            sys.stderr.write("WARN jenkins discovery: appFolderRegex is not a valid regex — using the default rule\n")
    want = _norm_slug(slug)
    if not want:
        return False
    if len(want) < SHORT_SLUG:
        return _norm_slug(name) == want
    words = _tokens(name)
    return any("".join(words[i:j]) == want for i in range(len(words)) for j in range(i + 1, len(words) + 1))


@lru_cache(maxsize=512)
def _word_re(word):
    try:
        return re.compile(r"(?<![a-z0-9])(?:" + word + r")(?![a-z0-9])", re.I)
    except re.error:
        return re.compile(r"(?<![a-z0-9])" + re.escape(word) + r"(?![a-z0-9])", re.I)


def infer_env_detail(segments, patterns):
    """(label, segment, word) for the first segment — pipeline name first, then folders from the
    deepest up — that holds one of a label's words (between non-alphanumerics), labels tried in the
    patterns' order; (None, None, None) when nothing matches."""
    for seg in segments:
        for label, words in patterns.items():
            for word in words:
                if _word_re(word).search(str(seg)):
                    return label, seg, word
    return None, None, None


def infer_env(segments, patterns):
    return infer_env_detail(segments, patterns)[0]


def infer_kind(name, via, patterns):
    """build / deploy / both from the pipeline's name; with no hint, a job that takes the branch as a
    parameter is a deploy ("deploy THIS branch") and a multibranch pipeline does everything (both)."""
    hit = {k: any(_word_re(w).search(name) for w in patterns.get(k, [])) for k in ("build", "deploy")}
    if hit["build"] and hit["deploy"]:
        return "both"
    if hit["deploy"]:
        return "deploy"
    if hit["build"]:
        return "build"
    return "deploy" if via == "parameter" else "both"


def node_kind(cls):
    """multibranch | folder | job from a Jenkins `_class`."""
    c = str(cls or "")
    if "MultiBranchProject" in c:
        return "multibranch"
    if "Folder" in c:
        return "folder"
    return "job"


# ── the walk ─────────────────────────────────────────────────────────────────


def child_url(parent, name):
    return f"{parent}job/{urllib.parse.quote(name, safe='()')}/"


def walk(root, slug, dcfg):
    """One live walk: {pipelines, folders, ignored, calls, partial, root_failed}. `partial` is set
    when a listing could not be read or the budget ran out — the caller must not treat the answer as
    complete (and so must not cache it as one)."""
    st = {"calls": 0, "partial": False, "root_failed": False}
    pipelines, folders, ignored = [], [], []
    max_depth, max_calls, template = dcfg["maxDepth"], dcfg["maxCalls"], dcfg.get("appFolderRegex") or None
    env_patterns, kind_patterns = dcfg["envPatterns"], dcfg["kindPatterns"]

    def read(url, tree, what):
        """(data, status), counting against this walk's budget; (None, None) once it is spent."""
        if st["calls"] >= max_calls:
            st["partial"] = True
            return None, None
        st["calls"] += 1
        return J._get(url + "api/json?" + J._tree(tree), what)

    def listing(url):
        with J._LOCK:
            memo = J._STATE["listings"].get(url)
        if memo is not None:
            return memo
        data, status = read(url, LISTING_TREE, "discovery listing")
        if status == 200 and isinstance(data, dict):
            jobs = [j for j in data.get("jobs") or [] if isinstance(j, dict) and isinstance(j.get("name"), str) and j["name"]]
        elif status == 404:
            jobs = []
        else:
            st["partial"] = True
            if url == root:
                st["root_failed"] = True
            return None
        with J._LOCK:
            J._STATE["listings"][url] = jobs
        return jobs

    def add_pipeline(kind, name, url, path, app_idx, app_url):
        if kind == "multibranch":
            via, param, env_param = "branch-job", None, None
        else:
            data, status = read(url, PARAM_TREE, "discovery job parameters")
            if status == 404:
                return
            if not isinstance(data, dict):
                st["partial"] = True
                return
            names = [d.get("name") for prop in data.get("property") or [] if isinstance(prop, dict)
                     for d in prop.get("parameterDefinitions") or [] if isinstance(d, dict) and d.get("name")]
            param = J.branch_param(names)
            if not param:
                ignored.append({"name": name, "url": url, "path": path, "reason": "plain job with no branch parameter (it cannot be tied to a branch)"})
                return
            via = "parameter"
            env_param = next((n for n in names if str(n).upper() in J.DEPLOY_PARAMS), None)
        if app_idx is None:  # the pipeline itself is named after the repository
            segments = [name] + list(reversed(path[:-1]))
        else:
            segments = list(reversed(path[app_idx + 1:])) + [path[app_idx]] + list(reversed(path[:app_idx]))
        env, seg, word = infer_env_detail(segments, env_patterns)
        pipelines.append({
            "name": name, "path": path, "url": url, "app": app_url, "via": via, "param": param, "envParam": env_param,
            "env": env or name, "envFrom": "pattern" if env else "pipeline",
            "envMatched": f"'{word}' in '{seg}'" if env else None,
            "kind": infer_kind(name, via, kind_patterns),
        })

    def enumerate_app(url, depth, path, app_idx, app_url):
        if depth >= max_depth:
            ignored.append({"name": path[-1], "url": url, "path": path, "reason": f"folder beyond maxDepth ({max_depth}) — its contents were not read"})
            return
        jobs = listing(url)
        if jobs is None:
            return
        for j in jobs:
            kind, name = node_kind(j.get("_class")), j["name"]
            cu, npath = child_url(url, name), path + [name]
            if kind == "folder":
                enumerate_app(cu, depth + 1, npath, app_idx, app_url)
            else:
                add_pipeline(kind, name, cu, npath, app_idx, app_url)

    queue = deque([(root, 0, [])])
    while queue:
        url, depth, path = queue.popleft()
        if depth >= max_depth:
            continue
        jobs = listing(url)
        if jobs is None:
            continue
        for j in jobs:
            kind, name = node_kind(j.get("_class")), j["name"]
            cu, npath = child_url(url, name), path + [name]
            matched = app_folder_matches(name, slug, template)
            if kind == "folder":
                if matched:
                    folders.append({"name": name, "url": cu, "path": npath})
                    enumerate_app(cu, depth + 1, npath, len(npath) - 1, cu)
                else:
                    queue.append((cu, depth + 1, npath))
            elif matched:
                add_pipeline(kind, name, cu, npath, None, None)

    order = {label: i for i, label in enumerate(env_patterns)}
    pipelines.sort(key=lambda p: (p["envFrom"] == "pipeline", order.get(p["env"], len(order))))
    return {"pipelines": pipelines, "folders": folders, "ignored": ignored, "calls": st["calls"], "partial": st["partial"], "root_failed": st["root_failed"]}


# ── discover: cache + walk ───────────────────────────────────────────────────


def _result(status, w, from_cache=None):
    return {"status": status, "fromCache": from_cache, "pipelines": w.get("pipelines", []), "folders": w.get("folders", []),
            "ignored": w.get("ignored", []), "calls": w.get("calls", 0)}


def discover(root, slug, dcfg, use_cache=True):
    """{status, fromCache, pipelines, folders, ignored, calls} for one repository slug.

    status "ok" — a complete walk, or a cache entry (fresh, or STALE when the walk failed);
    "partial" — the walk ran out of budget / could not read some folder: what it found is used but
    not cached; "failed" — nothing usable (the caller carries the previous builds forward).
    A genuinely empty answer (no application folder) is "ok" and cached too."""
    key = _key(root, slug, dcfg)
    with _LOCK:
        with J._LOCK:
            memo = J._STATE["walks"].get(key)
        if memo is not None:
            return copy.deepcopy(memo)
        cache = _load_cache()
        entry = cache["entries"].get(key) if isinstance(cache["entries"].get(key), dict) else None
        ttl = dcfg["cacheMinutes"] * 60
        age = time.time() - float(entry.get("at") or 0) if entry else None
        if use_cache and entry and ttl > 0 and 0 <= age < ttl:
            result = _result("ok", entry, "fresh")
        else:
            w = walk(root, slug, dcfg)
            if not w["partial"]:
                cache["entries"][key] = {"at": time.time(), "slug": str(slug), "pipelines": w["pipelines"], "folders": w["folders"]}
                _save_cache(cache)
                result = _result("ok", w)
            elif entry and use_cache:
                result = _result("ok", entry, "stale")  # could not re-walk: keep what we knew
            elif w["pipelines"] and not w["root_failed"]:
                result = _result("partial", w)
            else:
                result = _result("failed", w)
        with J._LOCK:
            J._STATE["walks"][key] = result
        return copy.deepcopy(result)


# ── command line ─────────────────────────────────────────────────────────────


def _kind_text(p):
    return f"parameterised [{p['param']}]" if p["via"] == "parameter" else "multibranch"


def format_report(root, slug, r, dcfg):
    """The human-readable walk. Never holds a credential — only names, urls and the reasons."""
    out = [f'Jenkins discovery for "{slug}"', f"  root:    {root}",
           f"  result:  {r['status']} · {r['calls']} calls · maxDepth {dcfg['maxDepth']}" + (f" · from cache ({r['fromCache']})" if r.get("fromCache") else ""), ""]
    folders = r["folders"]
    out.append(f"Application folders found: {len(folders)}")
    for f in folders:
        out.append(f"  {' / '.join(f['path'])}")
        out.append(f"      {f['url']}")
        for p in [p for p in r["pipelines"] if p.get("app") == f["url"]]:
            out += _pipeline_lines(p)
    direct = [p for p in r["pipelines"] if not p.get("app")]
    if direct:
        out += ["", "Pipelines named after the repository:"]
        for p in direct:
            out += _pipeline_lines(p)
    if r["ignored"]:
        out += ["", "Ignored:"]
        out += [f"  {' / '.join(i['path'])} — {i['reason']}\n      {i['url']}" for i in r["ignored"]]
    unlabelled = [p for p in r["pipelines"] if p["envFrom"] == "pipeline"]
    if unlabelled:
        out += ["", f"{len(unlabelled)} pipeline(s) have no environment word in their names, so the pipeline name is the label.",
                "Add words under jenkins.discovery.envPatterns (config/personal override) to label them, e.g. {\"stage\": [\"qa-eu\"]}."]
    if not folders and not direct:
        out += ["", "Nothing matched this slug. Check the slug (the repository name as Bitbucket spells it) and jenkins.discovery.appFolderRegex."]
    return "\n".join(out) + "\n"


def _pipeline_lines(p):
    why = f"matched {p['envMatched']}" if p["envFrom"] == "pattern" else "no environment word found — labelled by its name"
    return [f"    {_kind_text(p):<24} {p['name']}", f"        env={p['env']} ({why})  kind={p['kind']}" + (f"  env parameter={p['envParam']}" if p.get("envParam") else ""), f"        {p['url']}"]


def main(argv):
    """`discover <slug> [--json]`. Exit 0 ok, 1 the walk failed, 2 not configured."""
    args = list(argv)
    if not args or args[0] != "discover":
        sys.stderr.write("usage: jenkins.py discover <repo-slug> [--json]\n")
        return 2
    as_json = "--json" in args
    slugs = [a for a in args[1:] if not a.startswith("--")]
    if len(slugs) != 1:
        sys.stderr.write("usage: jenkins.py discover <repo-slug> [--json]  (the repository name as Bitbucket spells it)\n")
        return 2
    import _jira

    _jira.load_env()
    root = J.root_url()
    missing = [name for name, ok in (("JENKINS_ROOT_URL (https; or config jenkins.root)", bool(root)), ("JENKINS_USER", bool(os.environ.get("JENKINS_USER", "").strip())),
                                     ("JENKINS_API_TOKEN", bool(os.environ.get("JENKINS_API_TOKEN", "").strip()))) if not ok]
    if missing:
        sys.stderr.write("jenkins discover: not configured — set in setup/.env (API keys dialog): " + ", ".join(missing) + "\n")
        return 2
    dcfg = J.discovery_config()
    J.reset_run()
    r = discover(root, slugs[0], dcfg, use_cache=False)  # always the live tree; the cache is refreshed by a complete walk
    if as_json:
        print(json.dumps({"root": root, "slug": slugs[0], **r}, indent=1))
    else:
        print(format_report(root, slugs[0], r, dcfg), end="")
    if r["status"] == "failed":
        down = J.hosts_down()
        sys.stderr.write("jenkins discover: the walk failed" + (f" — {', '.join(down)} unreachable or rejected the credentials" if down else "") + "\n")
        return 1
    return 0
