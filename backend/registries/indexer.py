from __future__ import annotations

import ast
import importlib.util
import os
import re
from pathlib import Path
from typing import Any

SKIP_DIRS = {".git", "node_modules", "dist", "build", ".venv", "venv", "__pycache__", ".next", "out", "coverage", "target"}
MAX_FILE_BYTES = 512 * 1024
_JS_PATTERNS = [
    (re.compile(r"^\s*export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)"), "function"),
    (re.compile(r"^\s*export\s+(?:default\s+)?class\s+([A-Za-z_$][\w$]*)"), "class"),
    (re.compile(r"^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)"), "const"),
    (re.compile(r"^\s*export\s+(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)"), "type"),
    (re.compile(r"^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\("), "function"),
    (re.compile(r"^\s*class\s+([A-Za-z_$][\w$]*)"), "class"),
]


def iter_source_files(root: Path, limit: int = 20000):
    count = 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS and not d.startswith("."))
        for f in sorted(filenames):
            p = Path(dirpath) / f
            if p.is_symlink():
                continue
            yield p
            count += 1
            if count >= limit:
                return


def index_python(text: str) -> list[tuple[str, str, int]]:
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return []
    out = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            out.append((node.name, "function", node.lineno))
        elif isinstance(node, ast.ClassDef):
            out.append((node.name, "class", node.lineno))
    return out


def index_js(text: str) -> list[tuple[str, str, int]]:
    out = []
    for i, line in enumerate(text.splitlines(), 1):
        for rx, kind in _JS_PATTERNS:
            if m := rx.match(line):
                out.append((m.group(1), kind, i))
                break
    return out


def index_repository(root: Path) -> dict[str, Any]:
    """Incrementally-safe static index of a local repository. Returns symbols and detected tooling."""
    symbols: list[dict[str, Any]] = []
    langs: dict[str, int] = {}
    files = 0
    for p in iter_source_files(root):
        files += 1
        ext = p.suffix.lower()
        langs[ext] = langs.get(ext, 0) + 1
        if ext not in (".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"):
            continue
        try:
            if p.stat().st_size > MAX_FILE_BYTES:
                continue
            text = p.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        rel = p.relative_to(root).as_posix()
        found = index_python(text) if ext == ".py" else index_js(text)
        symbols += [{"path": rel, "symbol": s, "kind": k, "line": ln} for s, k, ln in found]
    test_commands = detect_test_commands(root)
    return {
        "files": files,
        "languages": sorted(({"ext": k, "files": v} for k, v in langs.items() if k), key=lambda d: -d["files"])[:10],
        "symbols": symbols[:50000],
        "test_commands": test_commands,
        "tree_sitter_available": importlib.util.find_spec("tree_sitter_language_pack") is not None,
        "indexer": "python-ast + js pattern scanner",
    }


def detect_test_commands(root: Path) -> list[dict[str, Any]]:
    import json

    cmds = []
    pkg = root / "package.json"
    if pkg.exists():
        try:
            scripts = json.loads(pkg.read_text(encoding="utf-8")).get("scripts", {})
            if "test" in scripts:
                cmds.append({"executable": "node", "args": ["--test"], "declared": f"npm test -> {scripts['test']}",
                             "note": "npm scripts are not executed directly; node --test is used when compatible"})
        except (OSError, ValueError):
            pass
    if (root / "pyproject.toml").exists() or (root / "pytest.ini").exists() or (root / "tests").is_dir():
        cmds.append({"executable": "python", "args": ["-m", "pytest", "-q"], "declared": "pytest"})
    return cmds
