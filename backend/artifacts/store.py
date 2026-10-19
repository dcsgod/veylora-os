from __future__ import annotations

import hashlib
import mimetypes
from pathlib import Path
from typing import Any

from backend.persistence.db import Database, new_id, now_iso
from backend.security.paths import resolve_within, safe_relative

TEXT_MIMES = ("text/", "application/json", "application/javascript", "image/svg+xml")


class ArtifactStore:
    def __init__(self, db: Database, projects_dir: Path, publish=None):
        self.db = db
        self.projects_dir = projects_dir
        self.publish = publish

    def project_root(self, project_id: str) -> Path:
        return self.projects_dir / project_id

    def save(self, project_id: str, task_id: str | None, kind: str, name: str, content: bytes | str,
             metadata: dict[str, Any] | None = None) -> dict[str, Any]:
        data = content.encode("utf-8") if isinstance(content, str) else content
        artifact_id = new_id("art")
        rel = f"artifacts/{artifact_id}/{safe_relative(name).name}"
        path = self.project_root(project_id) / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        mime = mimetypes.guess_type(name)[0] or ("text/markdown" if name.endswith(".md") else "application/octet-stream")
        row = {"id": artifact_id, "project_id": project_id, "task_id": task_id, "kind": kind, "name": name, "rel_path": rel,
               "sha256": hashlib.sha256(data).hexdigest(), "size": len(data), "mime": mime, "metadata": metadata or {},
               "created_at": now_iso()}
        self.db.insert("artifacts", row)
        if self.publish:
            self.publish("artifact.created", project_id=project_id, task_id=task_id,
                         payload={"artifact_id": artifact_id, "kind": kind, "name": name, "size": len(data)})
        return row

    def get(self, artifact_id: str) -> dict[str, Any] | None:
        return self.db.one("SELECT * FROM artifacts WHERE id = ?", (artifact_id,))

    def read(self, artifact_id: str) -> tuple[dict[str, Any], bytes]:
        row = self.get(artifact_id)
        if not row:
            raise KeyError(artifact_id)
        path = resolve_within(self.project_root(row["project_id"]), row["rel_path"])
        data = path.read_bytes()
        if hashlib.sha256(data).hexdigest() != row["sha256"]:
            raise ValueError("artifact checksum mismatch")
        return row, data

    def list(self, project_id: str, task_id: str | None = None) -> list[dict[str, Any]]:
        if task_id:
            return self.db.all("SELECT * FROM artifacts WHERE project_id = ? AND task_id = ? ORDER BY created_at", (project_id, task_id))
        return self.db.all("SELECT * FROM artifacts WHERE project_id = ? ORDER BY created_at DESC", (project_id,))

    @staticmethod
    def is_text(mime: str) -> bool:
        return mime.startswith(TEXT_MIMES)
