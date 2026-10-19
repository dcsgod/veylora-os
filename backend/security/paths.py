from __future__ import annotations

import os
import re
from pathlib import Path, PurePosixPath

_WINDOWS_RESERVED = re.compile(r"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$", re.IGNORECASE)
_FORBIDDEN_CHARS = re.compile(r'[\x00-\x1f<>:"|?*]')


class PathViolation(ValueError):
    pass


def safe_relative(rel: str) -> PurePosixPath:
    """Normalise an untrusted relative path. Rejects absolute paths, traversal, drive letters, and reserved names."""
    if not rel or not isinstance(rel, str):
        raise PathViolation("empty path")
    rel = rel.replace("\\", "/")
    if rel.startswith("/") or re.match(r"^[A-Za-z]:", rel) or rel.startswith("//"):
        raise PathViolation(f"absolute path not allowed: {rel}")
    parts = PurePosixPath(rel).parts
    clean: list[str] = []
    for part in parts:
        if part in ("", "."):
            continue
        if part == "..":
            raise PathViolation(f"path traversal not allowed: {rel}")
        if _FORBIDDEN_CHARS.search(part):
            raise PathViolation(f"invalid character in path: {rel}")
        if _WINDOWS_RESERVED.match(part) or part.endswith((" ", ".")):
            raise PathViolation(f"reserved path segment: {part}")
        clean.append(part)
    if not clean:
        raise PathViolation("empty path")
    if clean[0] == ".git":
        raise PathViolation("access to .git is not allowed")
    return PurePosixPath(*clean)


def resolve_within(root: Path, rel: str) -> Path:
    """Resolve an untrusted relative path under root, following symlinks, and ensure it stays inside root."""
    root_resolved = Path(os.path.realpath(root))
    candidate = Path(os.path.realpath(root_resolved / safe_relative(rel)))
    if not is_within(candidate, root_resolved):
        raise PathViolation(f"path escapes workspace: {rel}")
    return candidate


def is_within(path: Path, root: Path) -> bool:
    try:
        Path(os.path.realpath(path)).relative_to(Path(os.path.realpath(root)))
        return True
    except ValueError:
        return False
