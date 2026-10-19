from __future__ import annotations

import re
from typing import Any

_PATTERNS = [
    re.compile(r"gh[pousr]_[A-Za-z0-9]{20,}"),
    re.compile(r"github_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"sk-[A-Za-z0-9_\-]{16,}"),
    re.compile(r"xox[baprs]-[A-Za-z0-9\-]{10,}"),
    re.compile(r"AKIA[0-9A-Z]{16}"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._\-]{16,}"),
    re.compile(r"(?i)((?:api[_-]?key|token|secret|password|passwd)\s*[:=]\s*[\"']?)[^\s\"',;]{6,}"),
]
_SENSITIVE_KEYS = re.compile(r"(?i)(api[_-]?key|token|secret|password|authorization|cookie)")
MASK = "[REDACTED]"


def redact_text(text: str) -> str:
    if not text:
        return text
    for pattern in _PATTERNS:
        if pattern.groups:
            text = pattern.sub(lambda m: m.group(1) + MASK, text)
        else:
            text = pattern.sub(MASK, text)
    return text


def redact_value(value: Any) -> Any:
    if isinstance(value, str):
        return redact_text(value)
    if isinstance(value, dict):
        return {
            k: (MASK if isinstance(k, str) and _SENSITIVE_KEYS.search(k) and isinstance(v, str) and v else redact_value(v))
            for k, v in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [redact_value(v) for v in value]
    return value
