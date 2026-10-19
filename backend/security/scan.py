from __future__ import annotations

import re
from dataclasses import asdict, dataclass
from pathlib import Path

SCANNED_SUFFIXES = {".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".html", ".json", ".yaml", ".yml", ".sh", ".ps1"}
SKIP_DIRS = {"node_modules", ".git", "data", "dist", "build", "__pycache__"}


@dataclass(frozen=True)
class Rule:
    id: str
    severity: str
    pattern: re.Pattern
    message: str
    suffixes: frozenset[str] | None = None


_JS = frozenset({".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".html"})
_PY = frozenset({".py"})

RULES = [
    Rule("js-eval", "high", re.compile(r"(?<![\w.])eval\s*\("), "Dynamic code evaluation with eval()", _JS),
    Rule("js-new-function", "high", re.compile(r"\bnew\s+Function\s*\("), "Dynamic code evaluation with new Function()", _JS),
    Rule("js-child-process", "high", re.compile(r"""['"](node:)?child_process['"]"""), "Spawns OS processes from generated code", _JS),
    Rule("js-vm", "high", re.compile(r"""['"](node:)?vm['"]"""), "Uses the vm module to execute code", _JS),
    Rule("listen-all-interfaces", "high", re.compile(r"""['"]0\.0\.0\.0['"]"""), "Binds to all network interfaces"),
    Rule("py-shell-true", "high", re.compile(r"shell\s*=\s*True"), "Subprocess invoked through a shell", _PY),
    Rule("py-eval", "high", re.compile(r"(?<![\w.])(eval|exec)\s*\("), "Dynamic code evaluation", _PY),
    Rule("py-pickle", "medium", re.compile(r"\bpickle\.loads?\("), "Unpickling can execute code", _PY),
    Rule("secret-literal", "high",
         re.compile(r"(gh[pousr]_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9_-]{24,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)"),
         "Credential-like literal committed to source"),
    Rule("js-innerhtml-interp", "medium", re.compile(r"\.innerHTML\s*[+]?=\s*`[^`]*\$\{"), "Interpolated HTML assigned to innerHTML", _JS),
    Rule("js-document-write", "medium", re.compile(r"\bdocument\.write\s*\("), "document.write usage", _JS),
    Rule("js-remote-script", "medium", re.compile(r"<script[^>]+src=['\"]https?://"), "Loads a remote script", _JS),
    Rule("cors-wildcard", "medium", re.compile(r"access-control-allow-origin['\"]?\s*[:,]\s*['\"]\*['\"]", re.I), "Wildcard CORS"),
    Rule("js-insecure-random-id", "low", re.compile(r"Math\.random\(\)\.toString\(36\)"), "Non-cryptographic random identifier", _JS),
]


@dataclass
class Finding:
    rule: str
    severity: str
    path: str
    line: int
    message: str
    excerpt: str

    def to_dict(self) -> dict:
        return asdict(self)


def scan_text(rel: str, text: str) -> list[Finding]:
    suffix = Path(rel).suffix.lower()
    out: list[Finding] = []
    lines = text.splitlines()
    for rule in RULES:
        if rule.suffixes is not None and suffix not in rule.suffixes:
            continue
        for i, line in enumerate(lines, start=1):
            if len(line) > 2000:
                line = line[:2000]
            if rule.pattern.search(line):
                out.append(Finding(rule.id, rule.severity, rel, i, rule.message, line.strip()[:160]))
    return out


def scan_tree(root: Path, max_files: int = 5000) -> dict:
    findings: list[Finding] = []
    files = 0
    for path in sorted(root.rglob("*")):
        if any(part in SKIP_DIRS for part in path.relative_to(root).parts) or not path.is_file():
            continue
        if path.suffix.lower() not in SCANNED_SUFFIXES or path.stat().st_size > 1_000_000:
            continue
        files += 1
        if files > max_files:
            break
        findings += scan_text(path.relative_to(root).as_posix(), path.read_text(encoding="utf-8", errors="replace"))
    counts = {s: sum(1 for f in findings if f.severity == s) for s in ("high", "medium", "low")}
    return {"files_scanned": files, "counts": counts, "findings": [f.to_dict() for f in findings],
            "method": "pattern-based static scan (not a substitute for a full security audit)",
            "rules": [r.id for r in RULES]}
