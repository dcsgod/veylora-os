from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from backend.agents.roles import ROLES
from backend.persistence.db import Database, new_id, now_iso
from integrations.skills.catalogue import categorize, find_skill_dirs
from integrations.skills.skill_md import ParsedSkill, parse_skill_md, scan_skill_dir


def fts_query(text: str) -> str:
    words = [w for w in re.findall(r"[A-Za-z0-9]+", text.lower()) if len(w) > 2]
    return " OR ".join(f'"{w}"*' for w in dict.fromkeys(words)) if words else ""


def map_roles(slug: str, description: str) -> list[str]:
    text = f"{slug} {description}".lower()
    return sorted(r.id for r in ROLES.values() if any(k in text for k in r.skill_keywords))


class SkillRegistry:
    def __init__(self, db: Database):
        self.db = db

    def import_directory(self, root: Path, *, source_repo: str | None, source_commit: str | None,
                         repo_license: str | None, origin: str = "imported", project_id: str | None = None) -> dict[str, Any]:
        imported, invalid, updated = [], [], []
        for skill_dir in find_skill_dirs(root):
            text = (skill_dir / "SKILL.md").read_text(encoding="utf-8", errors="replace")
            parsed = parse_skill_md(text, skill_dir.name)
            parsed.resources, parsed.scripts = scan_skill_dir(skill_dir)
            if parsed.scripts:
                parsed.warnings.append(f"contains {len(parsed.scripts)} script(s); they are never executed during discovery")
            license_file = next((p for p in skill_dir.iterdir() if p.name.upper().startswith("LICENSE")), None)
            license_id = parsed.license or (f"see {license_file.name}" if license_file else repo_license)
            rel_path = skill_dir.relative_to(root).as_posix()
            status = self.upsert(parsed, category=categorize(parsed.slug, parsed.description), source_repo=source_repo,
                                 source_path=rel_path, source_commit=source_commit, license_id=license_id,
                                 origin=origin, project_id=project_id)
            (updated if status == "updated" else imported).append(parsed.slug)
            if not parsed.valid:
                invalid.append({"slug": parsed.slug, "errors": parsed.errors})
        return {"imported": imported, "updated": updated, "invalid": invalid, "source_repo": source_repo, "commit": source_commit}

    def upsert(self, parsed: ParsedSkill, *, category: str, source_repo: str | None, source_path: str | None,
               source_commit: str | None, license_id: str | None, origin: str, project_id: str | None = None) -> str:
        slug = parsed.slug if origin != "project" else f"{project_id}:{parsed.slug}"
        values = {
            "name": parsed.name, "description": parsed.description, "category": category,
            "tags": sorted({*parsed.slug.split("-"), category.split(" ")[0].lower()}),
            "source_repo": source_repo, "source_path": source_path, "source_commit": source_commit,
            "license": license_id, "version": parsed.version or (source_commit[:12] if source_commit else None),
            "instructions": parsed.instructions, "frontmatter": parsed.frontmatter, "resources": parsed.resources,
            "scripts": parsed.scripts, "external_urls": parsed.external_urls,
            "roles": map_roles(parsed.slug, parsed.description), "prerequisites": parsed.prerequisites,
            "validation": parsed.validation(), "origin": origin, "project_id": project_id, "imported_at": now_iso(),
        }
        with self.db.transaction():
            existing = self.db.one("SELECT id, trust, enabled FROM skills WHERE slug = ?", (slug,))
            if existing:
                skill_id = existing["id"]
                content_changed = self.db.one("SELECT instructions FROM skills WHERE id = ?", (skill_id,))["instructions"] != parsed.instructions
                if content_changed:
                    values["trust"] = "untrusted"
                self.db.update("skills", skill_id, values)
                self.db.execute("DELETE FROM skills_fts WHERE skill_id = ?", (skill_id,))
                status = "updated"
            else:
                skill_id = new_id("skl")
                trust = "reviewed" if origin == "project" else "untrusted"
                self.db.insert("skills", {"id": skill_id, "slug": slug, "trust": trust, "enabled": 0, **values})
                status = "imported"
            self.db.execute(
                "INSERT INTO skills_fts(skill_id, name, description, category, tags, instructions) VALUES (?, ?, ?, ?, ?, ?)",
                (skill_id, parsed.name, parsed.description, category, " ".join(values["tags"]), parsed.instructions[:20000]),
            )
        return status

    def search(self, query: str = "", category: str | None = None, role: str | None = None, enabled_only: bool = False,
               project_id: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
        params: list[Any] = []
        where = ["(s.project_id IS NULL OR s.project_id = ?)"]
        params.append(project_id)
        if category:
            where.append("s.category = ?")
            params.append(category)
        if enabled_only:
            where.append("s.enabled = 1")
        q = fts_query(query)
        if q:
            sql = (f"SELECT s.*, bm25(skills_fts, 0, 5.0, 3.0, 1.0, 2.0, 0.5) AS score FROM skills_fts "
                   f"JOIN skills s ON s.id = skills_fts.skill_id WHERE skills_fts MATCH ? AND {' AND '.join(where)} "
                   f"ORDER BY score LIMIT ?")
            rows = self.db.all(sql, [q, *params, limit])
        else:
            rows = self.db.all(f"SELECT s.*, 0 AS score FROM skills s WHERE {' AND '.join(where)} ORDER BY s.category, s.name LIMIT ?",
                               [*params, limit])
        if role:
            rows = [r for r in rows if role in (r["roles"] or [])]
        if project_id:
            overrides = {r["skill_id"]: r["enabled"] for r in
                         self.db.all("SELECT skill_id, enabled FROM project_skills WHERE project_id = ?", (project_id,))}
            for r in rows:
                r["project_enabled"] = bool(overrides.get(r["id"], r["enabled"]))
        for r in rows:
            r["usage"] = self.usage_stats(r["id"])
        return rows

    def get(self, skill_id: str) -> dict[str, Any] | None:
        row = self.db.one("SELECT * FROM skills WHERE id = ? OR slug = ?", (skill_id, skill_id))
        if row:
            row["usage"] = self.usage_stats(row["id"])
        return row

    def categories(self) -> list[dict[str, Any]]:
        return self.db.all("SELECT category, COUNT(*) AS count FROM skills GROUP BY category ORDER BY category")

    def set_enabled(self, skill_id: str, enabled: bool, project_id: str | None = None) -> None:
        row = self.get(skill_id)
        if not row:
            raise KeyError(skill_id)
        if enabled and not row["validation"].get("valid", False):
            raise ValueError("invalid skills cannot be enabled")
        if project_id:
            self.db.execute("INSERT INTO project_skills(project_id, skill_id, enabled) VALUES (?, ?, ?) "
                            "ON CONFLICT(project_id, skill_id) DO UPDATE SET enabled = excluded.enabled",
                            (project_id, row["id"], int(enabled)))
        else:
            self.db.update("skills", row["id"], {"enabled": int(enabled)})

    def set_trust(self, skill_id: str, trust: str) -> None:
        if trust not in ("untrusted", "reviewed", "trusted"):
            raise ValueError("invalid trust level")
        self.db.update("skills", skill_id, {"trust": trust})

    def create_project_skill(self, project_id: str, name: str, description: str, instructions: str) -> dict[str, Any]:
        text = f"---\nname: {name}\ndescription: {description}\n---\n\n{instructions}\n"
        parsed = parse_skill_md(text)
        if not parsed.valid:
            raise ValueError("; ".join(parsed.errors))
        self.upsert(parsed, category=categorize(parsed.slug, description), source_repo=None, source_path=None,
                    source_commit=None, license_id="project-local", origin="project", project_id=project_id)
        return self.get(f"{project_id}:{parsed.slug}")  # type: ignore[return-value]

    def select_for_task(self, text: str, role: str, project_id: str | None, limit: int = 2) -> list[dict[str, Any]]:
        """Return enabled, valid skills relevant to a task. Only names/descriptions are loaded into agent context."""
        rows = self.search(text, project_id=project_id, limit=25)
        out = []
        for r in rows:
            enabled = r.get("project_enabled", bool(r["enabled"]))
            if not enabled or not r["validation"].get("valid"):
                continue
            role_match = role in (r["roles"] or [])
            out.append({"id": r["id"], "slug": r["slug"], "name": r["name"], "trust": r["trust"],
                        "why": f"matched task text (bm25 {r['score']:.2f})" + ("; mapped to role " + role if role_match else ""),
                        "role_match": role_match})
        out.sort(key=lambda s: not s["role_match"])
        return out[:limit]

    def record_usage(self, skill_id: str, task_id: str, outcome: str) -> None:
        self.db.insert("skill_usage", {"id": new_id("sku"), "skill_id": skill_id, "task_id": task_id, "outcome": outcome,
                                       "created_at": now_iso()})

    def usage_stats(self, skill_id: str) -> dict[str, int]:
        rows = self.db.all("SELECT outcome, COUNT(*) AS n FROM skill_usage WHERE skill_id = ? GROUP BY outcome", (skill_id,))
        return {r["outcome"]: r["n"] for r in rows}
