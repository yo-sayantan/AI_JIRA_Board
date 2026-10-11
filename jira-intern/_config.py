"""Shared config.json resolver for the Python fetch scripts.

Mirrors local-runner/config.mjs's resolveConfigPath() exactly, so every consumer of
configuration — Node or Python — agrees on the deep-merge contract. The tracked root
config contains safe defaults; personal identity and internal URLs are sparse overrides.

Resolution order:
  1. <repo>/config/jira-board.config.json — complete tracked defaults
  2. $AI_CONFIG_FILE or ~/.ai/config.json — optional sparse personal override

See docs/SETUP.md for how to create ~/.ai/config.json.
"""
import copy
import json
import os
from datetime import datetime, timezone
from zoneinfo import ZoneInfo


def config_path(intern_dir):
    """Optional personal override path; the project config is always loaded."""
    override = os.environ.get("AI_CONFIG_FILE")
    if override:
        return override
    personal = os.path.join(os.path.expanduser("~"), ".ai", "config.json")
    if os.path.isfile(personal):
        return personal
    return None


def project_config_path(intern_dir):
    return os.path.join(os.path.dirname(os.path.abspath(intern_dir)), "config", "jira-board.config.json")


def project_schema_path(intern_dir):
    return os.path.join(os.path.dirname(os.path.abspath(intern_dir)), "config", "jira-board.config.schema.json")


def deep_merge(base, override):
    """Recursive object merge; arrays/scalars replace. Metadata keys are ignored."""
    out = dict(base or {})
    if not isinstance(override, dict):
        return out
    for key, value in (override or {}).items():
        if str(key).startswith("_") or key == "$schema":
            continue
        prior = out.get(key)
        if isinstance(prior, dict) and isinstance(value, dict):
            out[key] = deep_merge(prior, value)
        else:
            out[key] = value
    return out


def _read_json(path, label, required=False):
    if not path or not os.path.isfile(path):
        if required:
            raise RuntimeError(f"{label} missing: {path}")
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception as exc:
        raise RuntimeError(f"{label} is invalid JSON: {exc}") from exc


def _type_matches(value, kind):
    return {
        "object": isinstance(value, dict),
        "array": isinstance(value, list),
        "integer": isinstance(value, int) and not isinstance(value, bool),
        "number": isinstance(value, (int, float)) and not isinstance(value, bool),
        "string": isinstance(value, str),
        "boolean": isinstance(value, bool),
        "null": value is None,
    }.get(kind, True)


def _schema_errors(value, schema, path="config"):
    errors = []
    kinds = schema.get("type")
    kinds = kinds if isinstance(kinds, list) else ([kinds] if kinds else [])
    if kinds and not any(_type_matches(value, kind) for kind in kinds):
        return [f"{path} has the wrong type"]
    if "const" in schema and value != schema["const"]:
        errors.append(f"{path} must equal {schema['const']!r}")
    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{path} must be one of {', '.join(map(str, schema['enum']))}")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if schema.get("minimum") is not None and value < schema["minimum"]:
            errors.append(f"{path} must be >= {schema['minimum']}")
        if schema.get("maximum") is not None and value > schema["maximum"]:
            errors.append(f"{path} must be <= {schema['maximum']}")
    if isinstance(value, str) and schema.get("minLength") is not None and len(value) < schema["minLength"]:
        errors.append(f"{path} is too short")
    if isinstance(value, list):
        if schema.get("minItems") is not None and len(value) < schema["minItems"]:
            errors.append(f"{path} has too few items")
        if schema.get("uniqueItems") and len({json.dumps(item, sort_keys=True) for item in value}) != len(value):
            errors.append(f"{path} must contain unique items")
        if schema.get("items"):
            for i, item in enumerate(value):
                errors += _schema_errors(item, schema["items"], f"{path}[{i}]")
    if isinstance(value, dict):
        for key in schema.get("required") or []:
            if key not in value:
                errors.append(f"{path}.{key} is required")
        properties = schema.get("properties") or {}
        for key, item in value.items():
            if key in properties:
                errors += _schema_errors(item, properties[key], f"{path}.{key}")
            elif schema.get("additionalProperties") is False:
                errors.append(f"{path}.{key} is not allowed")
            elif isinstance(schema.get("additionalProperties"), dict):
                errors += _schema_errors(item, schema["additionalProperties"], f"{path}.{key}")
    return errors


_CACHE = {}


def _mtime(path):
    try:
        return os.path.getmtime(path) if path else None
    except OSError:
        return None


def load_config(intern_dir):
    """Deep-merge the optional personal override over the tracked project defaults.

    Cached per process and re-read whenever one of the three files changes, so long-lived
    workers still pick up edits without re-validating the schema on every call.
    """
    paths = (project_config_path(intern_dir), config_path(intern_dir), project_schema_path(intern_dir))
    stamp = (paths, tuple(_mtime(p) for p in paths))
    hit = _CACHE.get(paths[0])
    if hit and hit[0] == stamp:
        return copy.deepcopy(hit[1])
    merged = _load_config(intern_dir)
    _CACHE[paths[0]] = (stamp, merged)
    return copy.deepcopy(merged)


def _load_config(intern_dir):
    project = _read_json(project_config_path(intern_dir), "project config", required=True)
    override_path = config_path(intern_dir)
    if os.environ.get("AI_CONFIG_FILE") and not os.path.isfile(override_path or ""):
        raise RuntimeError(f"AI_CONFIG_FILE does not exist: {override_path}")
    merged = deep_merge(project, _read_json(override_path, "personal config"))
    if str((merged.get("app") or {}).get("timeZone") or "").upper() == "IST":
        merged.setdefault("app", {})["timeZone"] = "Asia/Kolkata"
    try:
        ZoneInfo(str((merged.get("app") or {}).get("timeZone") or ""))
    except Exception:
        merged.setdefault("app", {})["timeZone"] = "UTC"
    schema = _read_json(project_schema_path(intern_dir), "project config schema", required=True)
    errors = _schema_errors(merged, schema)
    if errors:
        raise RuntimeError("configuration invalid:\n- " + "\n- ".join(errors))
    return merged


def secrets_path(intern_dir):
    """The board's own secrets file: setup/.env at the repo root, beside setup/api-keys.json.

    It is the ONLY secrets file — written by the board's API keys dialog (server/secrets.mjs),
    git- and docker-ignored. JB_SECRETS_FILE moves it (tests, unusual layouts)."""
    explicit = os.environ.get("JB_SECRETS_FILE")
    if explicit:
        return os.path.expanduser(explicit)
    return os.path.join(os.path.dirname(os.path.abspath(intern_dir)), "setup", ".env")


def load_secrets(intern_dir):
    """Parse KEY=VALUE secrets without putting them in the tracked config."""
    out = {}
    path = secrets_path(intern_dir)
    if not os.path.isfile(path):
        return out
    with open(path, encoding="utf-8-sig") as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            if key.startswith("export "):
                key = key[7:].strip()
            out[key] = value.strip().strip('"').strip("'")
    return out


def _strip(url):
    """Normalise a base URL: strip whitespace and any trailing slash."""
    return str(url or "").strip().rstrip("/")


def endpoints(intern_dir):
    """(jira_base, confluence_base, bitbucket_base) from config — no hardcoded company hosts.

    Env vars win so a container or a one-off run can override without touching config:
    JIRA_URL / CONFLUENCE_URL / BITBUCKET_URL (JIRA_URL is already the name used by the
    MCP servers and the secrets file, so this keeps one vocabulary).
    """
    ep = load_config(intern_dir).get("endpoints") or {}
    return (
        _strip(os.environ.get("JIRA_URL") or ep.get("jiraBase")),
        _strip(os.environ.get("CONFLUENCE_URL") or ep.get("confluenceBase")),
        _strip(os.environ.get("BITBUCKET_URL") or ep.get("bitbucketBase")),
    )


def identity(intern_dir):
    """{name, accountId, email} from config — who "assigned to me" means."""
    user = load_config(intern_dir).get("user") or {}
    return {
        "name": str(user.get("name") or "").strip(),
        "accountId": str(user.get("accountId") or "").strip(),
        "email": str(user.get("email") or "").strip(),
    }


def time_zone(intern_dir):
    """Configured IANA timezone name (app.timeZone, e.g. Asia/Kolkata).

    load_config() has already normalised the legacy "IST" alias to Asia/Kolkata and replaced an
    unknown zone with UTC, so this only falls back to $TZ, then Asia/Kolkata, when the key is
    empty — and returns "UTC" if even that is not a zone this host knows."""
    name = str(
        (load_config(intern_dir).get("app") or {}).get("timeZone")
        or os.environ.get("TZ")
        or "Asia/Kolkata"
    ).strip()
    try:
        ZoneInfo(name)
        return name
    except Exception:
        return "UTC"


def _zone(intern_dir):
    name = time_zone(intern_dir)
    return ZoneInfo(name) if name != "UTC" else timezone.utc


def now_iso(intern_dir):
    """ISO-8601 now in the configured timezone, including its UTC offset."""
    return datetime.now(_zone(intern_dir)).isoformat(timespec="seconds")


def today_str(intern_dir):
    """YYYY-MM-DD in the configured timezone — the day stamp for notes and updateLog entries.
    (A UTC date flips at 05:30 in Kolkata, so a late-evening fetch used to log tomorrow's date.)"""
    return datetime.now(_zone(intern_dir)).strftime("%Y-%m-%d")


def bitbucket_hints(intern_dir):
    """Bitbucket key-scan hints from config → bitbucket, keyed by UPPER-CASED Jira project key:
      {"projectMap": {JIRA_PROJECT: BITBUCKET_PROJECT}, "repoHints": {JIRA_PROJECT: [repo slug, ...]}}
    Both default to {} — the daily fetch only scans Bitbucket for a ticket whose project appears
    in BOTH maps; there is no built-in project or repository name anywhere in the code."""
    bb = load_config(intern_dir).get("bitbucket") or {}
    project_map = {}
    for key, value in (bb.get("projectMap") or {}).items():
        k, v = str(key).strip().upper(), str(value or "").strip()
        if k and v:
            project_map[k] = v
    repo_hints = {}
    for key, repos in (bb.get("repoHints") or {}).items():
        k = str(key).strip().upper()
        slugs = [str(r).strip() for r in (repos or []) if str(r or "").strip()]
        if k and slugs:
            repo_hints[k] = list(dict.fromkeys(slugs))
    return {"projectMap": project_map, "repoHints": repo_hints}


def _parse_tenants(raw):
    """Dynatrace tenants from config ({env: id}) or from the DYNATRACE_TENANTS env var, which
    may be a JSON object or the shorthand "prod=abc12345,uat=def67890". Empty ids are dropped."""
    if isinstance(raw, str):
        text = raw.strip()
        if not text:
            return {}
        if text.startswith("{"):
            try:
                raw = json.loads(text)
            except ValueError:
                return {}
        else:
            raw = dict(
                (part.split("=", 1) + [""])[:2] for part in text.split(",") if part.strip()
            )
    tenants = {}
    for env_name, tenant in (raw or {}).items():
        k, v = str(env_name).strip(), str(tenant or "").strip()
        if k and v:
            tenants[k] = v
    return tenants


def proof_endpoints(intern_dir):
    """Optional evidence sources the AI worker may consult — each disabled when empty.
      checkmarxBase     Checkmarx One tenant base URL — endpoints.checkmarxBase; env
                        CHECKMARX_BASE_URL (canonical) or CHECKMARX_URL wins
      checkmarxAuthUrl  full token endpoint when the IAM host differs from the API host —
                        endpoints.checkmarxAuthUrl; env CHECKMARX_AUTH_URL wins; "" = derive
      dynatraceTenants  {env name: tenant id} — endpoints.dynatraceTenants; env
                        DYNATRACE_TENANTS (JSON object or "prod=id,uat=id") wins"""
    ep = load_config(intern_dir).get("endpoints") or {}
    env_tenants = os.environ.get("DYNATRACE_TENANTS")
    return {
        "checkmarxBase": _strip(
            os.environ.get("CHECKMARX_BASE_URL") or os.environ.get("CHECKMARX_URL") or ep.get("checkmarxBase")
        ),
        "checkmarxAuthUrl": _strip(os.environ.get("CHECKMARX_AUTH_URL") or ep.get("checkmarxAuthUrl")),
        "dynatraceTenants": _parse_tenants(env_tenants if env_tenants is not None else ep.get("dynatraceTenants")),
    }


def checkmarx_base(intern_dir):
    """Checkmarx One tenant base URL, or "" when the lookup is disabled."""
    return proof_endpoints(intern_dir)["checkmarxBase"]


def dynatrace_tenants(intern_dir):
    """{env name: Dynatrace tenant id}; {} when the lookup is disabled."""
    return proof_endpoints(intern_dir)["dynatraceTenants"]
