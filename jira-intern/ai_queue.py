#!/usr/bin/env python3
"""File-based job queue for JIRA-AI-Intern.

The board (serve.mjs) and the intern worker share jira-intern/.ai-queue/*.json.
Jobs are one JSON object per file; the intern claims by renaming to .running.

  python3 ai_queue.py enqueue --type enrich-report --key PROJ-123
  python3 ai_queue.py keys
  python3 ai_queue.py status
"""
import json
import os
import re
import sys
import time
import uuid
from _config import load_config, now_iso as configured_now_iso

HERE = os.path.dirname(os.path.abspath(__file__))
QUEUE_DIR = os.path.join(HERE, ".ai-queue")
STATUS_FILE = os.path.join(HERE, ".ai-status.json")
SETTINGS_FILE = os.path.join(HERE, ".settings.json")

VALID_TYPES = ("enrich-report", "summarize-active", "pull-model")
VALID_BACKENDS = ("local", "cloud")
# "none" is the retired spelling of "AI off" — still accepted from an old job file or CLI call.
VALID_LEVELS = ("none", "low", "moderate", "high", "full")
# A job file name / model tag reaches shell-adjacent code in the worker, so both are
# validated here — the one place every enqueue path (CLI, serve.mjs) goes through.
KEY_RE = re.compile(r"^[A-Z][A-Z0-9]+-\d+$")
MODEL_RE = re.compile(r"^[a-z0-9][a-z0-9._-]*(:[a-z0-9._-]+)?$")


def now_iso():
    return configured_now_iso(HERE)


def load_settings():
    ai = (load_config(HERE).get("ai") or {})
    defaults = {
        "aiEnabled": ai.get("enabled") is not False,
        "aiLevel": ai.get("level", "moderate"),
        "aiBackend": ai.get("backend", "local"),
        "aiLocalModel": ai.get("localModel", ""),
        "aiCloudProvider": ai.get("cloudProvider", "cursor"),
        "aiCloudModel": ai.get("cloudModel", ""),
        "aiCloudEffort": ai.get("cloudEffort", "low"),
        "aiUseHostOllama": bool(ai.get("useHostOllama", False)),
    }
    try:
        with open(SETTINGS_FILE, encoding="utf-8") as f:
            return {**defaults, **(json.load(f) or {})}
    except Exception:
        return defaults


def ai_enabled(settings):
    """Settings → Features → AI. The retired level "none" means off as well."""
    return settings.get("aiEnabled") is not False and settings.get("aiLevel") != "none"


def _ensure_queue():
    os.makedirs(QUEUE_DIR, exist_ok=True)


def enqueue(job):
    _ensure_queue()
    jtype = job.get("type")
    if jtype not in VALID_TYPES:
        raise ValueError(f"bad type {jtype}")
    key = str(job.get("key") or "").strip().upper() or None
    if key and not KEY_RE.match(key):
        raise ValueError(f"bad key {key!r} — expected a Jira key like PROJ-123")
    for field in ("model", "modelTag"):
        value = str(job.get(field) or "").strip()
        if value and not MODEL_RE.match(value):
            raise ValueError(f"bad {field} {value!r} — lower-case letters, digits, . _ - and an optional :tag")
    settings = load_settings()
    if not ai_enabled(settings):
        raise ValueError("AI is switched off in Settings (Features → AI)")
    backend = job.get("backend") or settings.get("aiBackend") or "local"
    payload = {
        "id": job.get("id") or f"{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}",
        "type": jtype,
        "key": key,
        "modelTag": job.get("modelTag") or job.get("model"),
        "level": job.get("level") or settings.get("aiLevel") or "moderate",
        "backend": backend,
        "model": job.get("model") or (
            settings.get("aiCloudModel") if backend == "cloud"
            else settings.get("aiLocalModel") or ""
        ),
        "cloudProvider": job.get("cloudProvider") if job.get("cloudProvider") in ("claude", "cursor", "gemini") else (
            settings.get("aiCloudProvider") if settings.get("aiCloudProvider") in ("claude", "cursor", "gemini") else "cursor"
        ),
        "cloudEffort": job.get("cloudEffort") if job.get("cloudEffort") in ("low", "medium") else (
            settings.get("aiCloudEffort") if settings.get("aiCloudEffort") in ("low", "medium") else "low"
        ),
        "useHostOllama": bool(job.get("useHostOllama", settings.get("aiUseHostOllama"))),
        "enqueuedAt": now_iso(),
    }
    if payload["backend"] not in VALID_BACKENDS:
        payload["backend"] = "local"
    if payload["level"] not in VALID_LEVELS:
        payload["level"] = "moderate"
    # Dedup against pending AND claimed (.running) jobs — a key the intern is enriching right
    # now used to be re-queued and enriched twice.
    same = ("type", "key", "modelTag")
    for queued in list_jobs(include_running=True):
        if all(queued.get(f) == payload[f] for f in same):
            queued.pop("_path", None)
            return queued
    path = os.path.join(QUEUE_DIR, f"{payload['id']}.json")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
        f.write("\n")
    os.replace(tmp, path)
    return payload


def list_jobs(include_running=False):
    """Pending jobs (oldest first); with include_running, jobs the intern has claimed too."""
    _ensure_queue()
    out = []
    for name in sorted(os.listdir(QUEUE_DIR)):
        if name.startswith("."):
            continue
        if not (name.endswith(".json") or (include_running and name.endswith(".json.running"))):
            continue
        path = os.path.join(QUEUE_DIR, name)
        try:
            with open(path, encoding="utf-8") as f:
                job = json.load(f)
            job["_path"] = path
            out.append(job)
        except Exception:
            continue
    return out


def queued_keys():
    keys = []
    for job in list_jobs():
        if job.get("type") == "enrich-report" and job.get("key"):
            keys.append(job["key"])
        if job.get("type") == "pull-model" and job.get("model"):
            keys.append(f"pull:{job['model']}")
    st = read_status()
    cur = (st or {}).get("current") or {}
    if cur.get("type") == "enrich-report" and cur.get("key"):
        keys.append(cur["key"])
    return list(dict.fromkeys(keys))


def claim_next():
    """Atomically take the oldest job. Returns (job, running_path) or (None, None)."""
    _ensure_queue()
    for job in list_jobs():
        src = job.get("_path")
        if not src:
            continue
        dst = src + ".running"
        try:
            os.rename(src, dst)
        except OSError:
            continue
        job["_path"] = dst
        return job, dst
    return None, None


def finish(running_path):
    if running_path and os.path.isfile(running_path):
        try:
            os.remove(running_path)
        except OSError:
            pass


def read_status():
    try:
        with open(STATUS_FILE, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def write_status(patch):
    os.makedirs(os.path.dirname(STATUS_FILE) or ".", exist_ok=True)
    cur = read_status() or {}
    cur.update(patch)
    cur["updatedAt"] = now_iso()
    cur["queued"] = len(list_jobs())
    tmp = STATUS_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cur, f, indent=2)
        f.write("\n")
    try:
        os.replace(tmp, STATUS_FILE)
    except FileNotFoundError:
        with open(STATUS_FILE, "w", encoding="utf-8") as f:
            json.dump(cur, f, indent=2)
            f.write("\n")
    return cur


def main(argv):
    if len(argv) < 2:
        print("usage: ai_queue.py enqueue|keys|status|list …", file=sys.stderr)
        return 2
    cmd = argv[1]
    if cmd == "enqueue":
        job = {}
        args = argv[2:]
        i = 0
        while i < len(args):
            a = args[i]
            if a in ("--type", "--key", "--level", "--backend", "--model", "--modelTag") and i + 1 < len(args):
                job[a[2:]] = args[i + 1]
                i += 2
                continue
            if a == "--host-ollama":
                job["useHostOllama"] = True
                i += 1
                continue
            i += 1
        try:
            payload = enqueue(job)
        except ValueError as e:
            print(f"ai_queue: {e}", file=sys.stderr)
            return 2
        print(payload["id"])
        return 0
    if cmd == "keys":
        for k in queued_keys():
            print(k)
        return 0
    if cmd == "list":
        json.dump(list_jobs(), sys.stdout, indent=2)
        sys.stdout.write("\n")
        return 0
    if cmd == "status":
        json.dump(read_status() or {"ok": False, "state": "down"}, sys.stdout, indent=2)
        sys.stdout.write("\n")
        return 0
    print(f"unknown command {cmd}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
