from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from backend.persistence.db import Database, new_id, now_iso
from backend.registries.capabilities import CapabilityManifest, CapabilityRegistry
from backend.registries.indexer import index_repository
from integrations.github.connector import GitHubConnector

SEED_REPOSITORIES = [
    ("morluto/rea", "seed", "Optional reverse-engineering capability provider"),
    ("Prat011/awesome-llm-skills", "seed", "Skill catalogue source"),
    ("All-Hands-AI/OpenHands", "candidate", "Candidate: autonomous coding agent platform"),
    ("browser-use/browser-use", "candidate", "Candidate: LLM-driven browser automation"),
    ("microsoft/playwright", "candidate", "Candidate: browser automation and testing"),
    ("tree-sitter/tree-sitter", "candidate", "Candidate: incremental parsing for source analysis"),
    ("ollama/ollama", "candidate", "Candidate: local model runtime"),
]


class RepositoryRegistry:
    def __init__(self, db: Database, capabilities: CapabilityRegistry, github: GitHubConnector | None = None):
        self.db = db
        self.capabilities = capabilities
        self.github = github or GitHubConnector()

    def seed(self) -> None:
        for full_name, kind, role in SEED_REPOSITORIES:
            if self.db.one("SELECT id FROM repository_sources WHERE full_name = ?", (full_name,)):
                continue
            self.db.insert("repository_sources", {
                "id": new_id("repo"), "provider": "github", "full_name": full_name, "url": f"https://github.com/{full_name}",
                "status": "not_fetched", "seeded": 1 if kind == "seed" else 0, "role": role, "created_at": now_iso(),
            })

    def list(self) -> list[dict[str, Any]]:
        return self.db.all("SELECT * FROM repository_sources ORDER BY seeded DESC, full_name")

    def get(self, repo_id: str) -> dict[str, Any] | None:
        return self.db.one("SELECT * FROM repository_sources WHERE id = ? OR full_name = ?", (repo_id, repo_id))

    def add_github(self, full_name: str) -> dict[str, Any]:
        if not re.match(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", full_name):
            raise ValueError("repository must be in owner/name form")
        if existing := self.get(full_name):
            return existing
        self.db.insert("repository_sources", {"id": new_id("repo"), "provider": "github", "full_name": full_name,
                                              "url": f"https://github.com/{full_name}", "status": "not_fetched",
                                              "role": "user-added", "created_at": now_iso()})
        return self.get(full_name)  # type: ignore[return-value]

    async def analyze_github(self, repo_id: str) -> dict[str, Any]:
        row = self.get(repo_id)
        if not row or row["provider"] != "github":
            raise KeyError(repo_id)
        try:
            result = await self.github.analyze(row["full_name"])
        except Exception as exc:
            self.db.update("repository_sources", row["id"], {"status": "error", "analysis": {"error": str(exc)}})
            raise
        meta = result["metadata"]
        self.db.update("repository_sources", row["id"], {
            "description": meta["description"], "license": meta["license"], "default_branch": meta["default_branch"],
            "head_commit": meta["head_commit"], "archived": int(bool(meta["archived"])), "stars": meta["stars"],
            "pushed_at": meta["pushed_at"], "topics": meta["topics"], "analysis": result["analysis"],
            "status": "analyzed", "indexed_at": now_iso(),
        })
        self.propose_capability(row["id"])
        return self.get(row["id"])  # type: ignore[return-value]

    def index_local(self, path: str, name: str | None = None) -> dict[str, Any]:
        root = Path(path).expanduser().resolve()
        if not root.is_dir():
            raise ValueError("path is not a directory")
        full_name = f"local/{name or root.name}"
        row = self.get(full_name)
        repo_id = row["id"] if row else new_id("repo")
        if not row:
            self.db.insert("repository_sources", {"id": repo_id, "provider": "local", "full_name": full_name,
                                                  "local_path": str(root), "status": "indexing", "role": "local repository",
                                                  "created_at": now_iso()})
        result = index_repository(root)
        with self.db.transaction():
            self.db.execute("DELETE FROM repo_symbols WHERE repository_id = ?", (repo_id,))
            for s in result["symbols"]:
                self.db.insert("repo_symbols", {"repository_id": repo_id, **s})
        analysis = {k: v for k, v in result.items() if k != "symbols"}
        analysis["symbol_count"] = len(result["symbols"])
        analysis["verification_note"] = "Static index only. No repository code was executed."
        lic = next((p.name for p in root.iterdir() if p.name.upper().startswith(("LICENSE", "COPYING"))), None)
        self.db.update("repository_sources", repo_id, {"local_path": str(root), "analysis": analysis, "status": "indexed",
                                                       "license": f"see {lic}" if lic else None, "indexed_at": now_iso()})
        return self.get(repo_id)  # type: ignore[return-value]

    def symbols(self, repo_id: str, query: str = "", limit: int = 200) -> list[dict[str, Any]]:
        if query:
            return self.db.all("SELECT * FROM repo_symbols WHERE repository_id = ? AND symbol LIKE ? ORDER BY symbol LIMIT ?",
                               (repo_id, f"%{query}%", limit))
        return self.db.all("SELECT * FROM repo_symbols WHERE repository_id = ? ORDER BY path, line LIMIT ?", (repo_id, limit))

    def propose_capability(self, repo_id: str) -> dict[str, Any]:
        row = self.get(repo_id)
        if not row:
            raise KeyError(repo_id)
        analysis = row["analysis"] or {}
        slug = "repo-" + re.sub(r"[^a-z0-9]+", "-", row["full_name"].lower()).strip("-")
        if row["full_name"].lower() == "morluto/rea":
            existing = self.capabilities.get("rea")
            if existing:
                manifest = dict(existing["manifest"])
                manifest["license"] = row["license"]
                manifest["evidence"] = analysis.get("evidence", [])
                self.capabilities.register(CapabilityManifest.model_validate(manifest), enabled=bool(existing["enabled"]),
                                           repository_id=row["id"])
                return self.capabilities.get("rea")  # type: ignore[return-value]
        manifest = CapabilityManifest(
            slug=slug[:80], name=row["full_name"], version=(row["head_commit"] or "unversioned")[:12], kind="repository",
            description=(row["description"] or "Repository-derived capability proposal")[:500], source=row["url"] or row["full_name"],
            license=row["license"], dependencies=[], inputs=[], outputs=[],
            install="not installed; requires review and approval", isolation="sandboxed_subprocess", trust="untrusted",
            tags=[t for t in (row["topics"] or [])][:20] + [l["ext"].lstrip(".") for l in analysis.get("languages", [])][:5],
            evidence=analysis.get("evidence", []),
            compatibility={"entry_points": analysis.get("entry_points", []), "dependencies": analysis.get("dependencies", {})},
        )
        return self.capabilities.register(manifest, enabled=False, repository_id=row["id"])
