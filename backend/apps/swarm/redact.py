"""Strip secrets before anything enters a .swarm. Two layers: closure scrubs
every payload + text body, and ziputil.pack refuses to write if anything denied
slipped through. Over-redacting a bundle is fine; shipping a stranger your API
key is not."""
from __future__ import annotations

import re
from typing import Any

# Substrings that mark a field name as secret (matched case-insensitively).
_DENY_SUBSTRINGS = (
    "api_key", "apikey", "secret", "password", "passwd", "credential", "oauth",
    "bearer", "subscription_token", "access_token", "refresh_token",
    "session_token", "auth_token", "private_key",
)

# Exact field names that are sensitive or per-install identity (the substring
# pass alone would miss these).
_DENY_EXACT = {
    "token", "installation_id", "user_id", "free_trial_token",
    "free_trial_remaining", "free_trial_runs_limit", "openswarm_bearer_token",
    "openswarm_usage_cached", "connected_account_email", "oauth_tokens",
    "credentials", "sdk_session_id",
}

REDACTED = "[redacted]"

# Literal-secret shapes someone might paste into a file or skill body.
_CONTENT_PATTERNS = (
    re.compile(r"sk-ant-[A-Za-z0-9_\-]{16,}"),
    re.compile(r"sk-[A-Za-z0-9_\-]{16,}"),
    re.compile(r"AIza[A-Za-z0-9_\-]{20,}"),          # Google API key shape
    re.compile(r"gh[pousr]_[A-Za-z0-9]{20,}"),       # GitHub tokens
    re.compile(r"Bearer\s+[A-Za-z0-9._\-]{16,}"),
)


def is_denied_key(key: str) -> bool:
    k = key.lower()
    if k in _DENY_EXACT:
        return True
    return any(sub in k for sub in _DENY_SUBSTRINGS)


def scrub_text(text: str) -> str:
    for pat in _CONTENT_PATTERNS:
        text = pat.sub(REDACTED, text)
    return text


def scrub_payload(value: Any) -> Any:
    """Recursively drop denied keys and redact secret-shaped strings in a
    JSON-able structure. Returns a new structure; never mutates the input."""
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for k, v in value.items():
            if isinstance(k, str) and is_denied_key(k):
                continue
            out[k] = scrub_payload(v)
        return out
    if isinstance(value, list):
        return [scrub_payload(v) for v in value]
    if isinstance(value, str):
        return scrub_text(value)
    return value


def find_denied_keys(value: Any, _path: str = "") -> list[str]:
    """Audit used by ziputil.pack as the last line of defense: the paths of any
    denied key still present. Empty list means clean."""
    found: list[str] = []
    if isinstance(value, dict):
        for k, v in value.items():
            here = f"{_path}.{k}" if _path else str(k)
            if isinstance(k, str) and is_denied_key(k):
                found.append(here)
            found.extend(find_denied_keys(v, here))
    elif isinstance(value, list):
        for i, v in enumerate(value):
            found.extend(find_denied_keys(v, f"{_path}[{i}]"))
    return found


def _looks_secret(text: str) -> bool:
    return any(pat.search(text) for pat in _CONTENT_PATTERNS)


def find_secrets_in_files(files: dict[str, bytes]) -> list[str]:
    """Paths of any file whose text body holds a secret-shaped literal. Payloads
    get scrubbed key-and-content, but raw workspace files (an app's source) were
    only key-scanned, so a key hardcoded in a .js would slip. Binary files are
    skipped (a null byte means it isn't text someone pasted a token into)."""
    hits: list[str] = []
    for path, data in files.items():
        if b"\x00" in data[:4096]:
            continue
        if _looks_secret(data.decode("utf-8", errors="ignore")):
            hits.append(path)
    return hits
