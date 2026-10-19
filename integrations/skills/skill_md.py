from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

_FRONTMATTER = re.compile(r"^---\s*\n(.*?)\n---\s*\n?(.*)$", re.DOTALL)
_URL = re.compile(r"https?://[^\s)\"'<>`]+")
_NAME = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
_SCRIPT_EXT = {".py", ".sh", ".js", ".mjs", ".cjs", ".ts", ".ps1", ".bat", ".cmd", ".rb", ".pl"}
_SUSPICIOUS = [
    (re.compile(r"ignore (all |any )?(previous|prior) instructions", re.I), "attempts to override prior instructions"),
    (re.compile(r"curl[^\n|]*\|\s*(ba)?sh", re.I), "pipes a download into a shell"),
    (re.compile(r"rm\s+-rf\s+[/~]", re.I), "contains destructive delete command"),
    (re.compile(r"(disable|bypass|skip)\s+(the\s+)?(sandbox|permission|approval|safety)", re.I), "asks to bypass safety controls"),
    (re.compile(r"(api[_-]?key|password|token)\s*[:=]\s*\S{8,}", re.I), "may embed a credential"),
]
_TOOL_HINTS = {
    "python": re.compile(r"\bpython3?\b|\bpip install\b", re.I),
    "node": re.compile(r"\bnode\b|\bnpm\b|\bnpx\b", re.I),
    "playwright": re.compile(r"playwright", re.I),
    "git": re.compile(r"\bgit\b", re.I),
    "mcp": re.compile(r"\bmcp\b|model context protocol", re.I),
    "ffmpeg": re.compile(r"ffmpeg", re.I),
}


@dataclass
class ParsedSkill:
    slug: str
    name: str
    description: str
    instructions: str
    frontmatter: dict[str, Any]
    license: str | None
    version: str | None
    resources: list[str] = field(default_factory=list)
    scripts: list[str] = field(default_factory=list)
    external_urls: list[str] = field(default_factory=list)
    prerequisites: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def valid(self) -> bool:
        return not self.errors

    def validation(self) -> dict[str, Any]:
        return {"valid": self.valid, "errors": self.errors, "warnings": self.warnings, "format": "SKILL.md (YAML frontmatter + markdown)"}


def parse_skill_md(text: str, dir_name: str | None = None) -> ParsedSkill:
    errors: list[str] = []
    warnings: list[str] = []
    frontmatter: dict[str, Any] = {}
    body = text
    m = _FRONTMATTER.match(text.lstrip("\ufeff"))
    if not m:
        errors.append("missing YAML frontmatter block delimited by ---")
    else:
        try:
            loaded = yaml.safe_load(m.group(1)) or {}
            if not isinstance(loaded, dict):
                errors.append("frontmatter must be a mapping")
            else:
                frontmatter = loaded
        except yaml.YAMLError as exc:
            errors.append(f"invalid YAML frontmatter: {str(exc).splitlines()[0]}")
        body = m.group(2)

    name = str(frontmatter.get("name") or "").strip()
    description = str(frontmatter.get("description") or "").strip()
    if not name:
        errors.append("frontmatter field 'name' is required")
    elif not _NAME.match(name):
        warnings.append("name should be lowercase letters, digits and hyphens")
    if not description:
        errors.append("frontmatter field 'description' is required")
    elif len(description) > 1024:
        warnings.append("description exceeds 1024 characters")
    if dir_name and name and name != dir_name:
        warnings.append(f"name {name!r} does not match directory {dir_name!r}")
    if not body.strip():
        errors.append("skill instructions body is empty")

    for pattern, msg in _SUSPICIOUS:
        if pattern.search(text):
            warnings.append(f"untrusted content: {msg}")

    urls = sorted(set(u.rstrip(".,;:") for u in _URL.findall(text)))
    prereqs = sorted(k for k, rx in _TOOL_HINTS.items() if rx.search(body))
    allowed_tools = frontmatter.get("allowed-tools") or frontmatter.get("allowed_tools")
    if allowed_tools:
        prereqs.append(f"declared-tools:{allowed_tools}")
    slug = re.sub(r"[^a-z0-9-]+", "-", (name or dir_name or "skill").lower()).strip("-") or "skill"
    meta = frontmatter.get("metadata") if isinstance(frontmatter.get("metadata"), dict) else {}
    return ParsedSkill(
        slug=slug,
        name=name or (dir_name or slug),
        description=description,
        instructions=body.strip(),
        frontmatter=frontmatter,
        license=str(frontmatter["license"]) if frontmatter.get("license") else None,
        version=str(frontmatter.get("version") or meta.get("version") or "") or None,
        external_urls=urls[:100],
        prerequisites=prereqs,
        errors=errors,
        warnings=warnings,
    )


def scan_skill_dir(skill_dir: Path) -> tuple[list[str], list[str]]:
    resources, scripts = [], []
    for p in sorted(skill_dir.rglob("*")):
        if not p.is_file() or p.name == "SKILL.md" or p.is_symlink():
            continue
        rel = p.relative_to(skill_dir).as_posix()
        (scripts if p.suffix.lower() in _SCRIPT_EXT else resources).append(rel)
    return resources[:200], scripts[:200]


if __name__ == "__main__":
    import json
    import sys

    if len(sys.argv) > 1:
        target = Path(sys.argv[1])
        if target.is_dir():
            res, scr = scan_skill_dir(target)
            skill_file = target / "SKILL.md"
            if skill_file.exists():
                parsed = parse_skill_md(skill_file.read_text(encoding="utf-8", errors="replace"), target.name)
                parsed.resources = res
                parsed.scripts = scr
                print(f"Skill: {parsed.name} ({parsed.slug})")
                print(f"Validation: {json.dumps(parsed.validation(), indent=2)}")
            else:
                print(f"Directory {target} has no SKILL.md ({len(res)} resources, {len(scr)} scripts found)")
        elif target.is_file():
            parsed = parse_skill_md(target.read_text(encoding="utf-8", errors="replace"), target.parent.name)
            print(f"Skill: {parsed.name} ({parsed.slug})")
            print(f"Validation: {json.dumps(parsed.validation(), indent=2)}")
        else:
            print(f"Target not found: {target}")
    else:
        sample = (
            "---\n"
            "name: sample-skill\n"
            "description: A demo skill for testing and validation\n"
            "license: MIT\n"
            "---\n"
            "Use python to process data and view https://example.com/docs.\n"
        )
        parsed = parse_skill_md(sample, "sample-skill")
        print("Self-test parse completed successfully:")
        print(f"  Name: {parsed.name}")
        print(f"  Slug: {parsed.slug}")
        print(f"  Valid: {parsed.valid}")
        print(f"  Prerequisites: {parsed.prerequisites}")
        print(f"  External URLs: {parsed.external_urls}")

