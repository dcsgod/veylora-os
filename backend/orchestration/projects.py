from __future__ import annotations

from typing import Any, Callable

from backend.intent.engine import Specification, build_specification
from backend.orchestration.dag import layered_layout, validate_graph
from backend.orchestration.states import ProjectStatus, TaskStatus
from backend.persistence.db import Database, new_id, now_iso
from backend.planning.planner import TaskSpec, build_plan, plan_summary

DEFAULT_WORKSPACE = "ws_default"


class ProjectService:
    def __init__(self, db: Database, publish: Callable[..., Any]):
        self.db = db
        self.publish = publish

    def ensure_workspace(self) -> str:
        if not self.db.one("SELECT id FROM workspaces WHERE id = ?", (DEFAULT_WORKSPACE,)):
            self.db.insert("workspaces", {"id": DEFAULT_WORKSPACE, "name": "Default workspace", "created_at": now_iso()})
        return DEFAULT_WORKSPACE

    def preview_spec(self, request: str, domain: str | None = None) -> Specification:
        return build_specification(request, domain)

    def create(self, request: str, *, name: str | None = None, domain: str | None = None, autonomy: str = "review",
               allow_hosted: bool = False, spec: Specification | None = None) -> dict[str, Any]:
        if autonomy not in ("review", "auto"):
            raise ValueError("autonomy must be 'review' or 'auto'")
        spec = spec or build_specification(request, domain)
        tasks = build_plan(spec, allow_hosted=allow_hosted, request=request)
        project_id = new_id("prj")
        ts = now_iso()
        with self.db.transaction():
            self.db.insert("projects", {"id": project_id, "workspace_id": self.ensure_workspace(), "name": (name or spec.title)[:120],
                                        "request": request, "domain": spec.domain, "status": ProjectStatus.PLANNED,
                                        "autonomy": autonomy, "allow_hosted_inference": int(allow_hosted),
                                        "created_at": ts, "updated_at": ts})
            self._insert_spec(project_id, 1, spec, "intent-engine", "planner")
            self._insert_plan(project_id, 1, 1, "initial plan", tasks)
        self.publish("project.created", project_id=project_id, payload={"name": name or spec.title, "domain": spec.domain})
        self.publish("plan.created", project_id=project_id, payload={"revision": 1, **plan_summary(tasks)})
        return self.get(project_id)  # type: ignore[return-value]

    def _insert_spec(self, project_id: str, revision: int, spec: Specification, source: str, author: str) -> None:
        self.db.insert("specifications", {"id": new_id("spec"), "project_id": project_id, "revision": revision,
                                          "content": spec.model_dump(), "source": source, "author": author, "created_at": now_iso()})

    def _insert_plan(self, project_id: str, revision: int, spec_revision: int, reason: str, tasks: list[TaskSpec],
                     parent: dict[str, str] | None = None, offset: tuple[float, float] = (0.0, 0.0)) -> dict[str, str]:
        existing_keys = {r["key"]: r["id"] for r in self.db.all("SELECT id, key FROM tasks WHERE project_id = ?", (project_id,))}
        all_edges = {t.key: t.depends_on for t in tasks}
        for t in tasks:
            for d in t.depends_on:
                if d not in all_edges and d not in existing_keys:
                    raise ValueError(f"task {t.key} depends on unknown task {d}")
        new_keys = [t.key for t in tasks]
        if existing_keys:
            known = {k: [] for k in existing_keys}
            order = validate_graph([*known, *new_keys], {**known, **all_edges})
        else:
            order = validate_graph(new_keys, all_edges)
        positions = layered_layout([k for k in order if k in all_edges], {k: [d for d in v if d in all_edges] for k, v in all_edges.items()})
        positions = {k: (x + offset[0], y + offset[1]) for k, (x, y) in positions.items()}
        self.db.insert("plan_revisions", {"id": new_id("plan"), "project_id": project_id, "revision": revision,
                                          "spec_revision": spec_revision, "reason": reason,
                                          "summary": plan_summary(tasks), "created_at": now_iso()})
        ids = dict(existing_keys)
        ts = now_iso()
        for t in tasks:
            tid = new_id("tsk")
            ids[t.key] = tid
            x, y = positions.get(t.key, (0.0, 0.0))
            self.db.insert("tasks", {
                "id": tid, "project_id": project_id, "plan_revision": revision, "parent_task_id": (parent or {}).get(t.key),
                "key": t.key, "title": t.title, "description": t.description, "task_type": t.task_type, "phase": t.phase,
                "role": t.role, "required_capabilities": t.required_capabilities, "skills": [], "permissions": t.permissions,
                "inputs": t.inputs, "outputs": t.outputs, "acceptance": t.acceptance, "params": t.params,
                "rationale": t.rationale, "timeout_s": t.timeout_s, "max_retries": t.max_retries,
                "status": TaskStatus.PENDING, "position_x": x, "position_y": y, "created_at": ts, "updated_at": ts,
            })
        for t in tasks:
            for d in t.depends_on:
                self.db.insert("task_dependencies", {"task_id": ids[t.key], "depends_on_id": ids[d]})
        return ids

    def add_tasks(self, project_id: str, tasks: list[TaskSpec], reason: str, parent: dict[str, str] | None = None,
                  offset: tuple[float, float] = (0.0, 0.0)) -> dict[str, str]:
        with self.db.transaction():
            rev = self.current_plan_revision(project_id) + 1
            spec_rev = self.current_spec(project_id)["revision"]
            ids = self._insert_plan(project_id, rev, spec_rev, reason, tasks, parent, offset)
        self.publish("plan.revised", project_id=project_id, payload={"revision": rev, "reason": reason,
                                                                     "added": [t.key for t in tasks]})
        return ids

    def update_spec(self, project_id: str, spec: Specification, author: str = "user") -> int:
        with self.db.transaction():
            rev = self.current_spec(project_id)["revision"] + 1
            self._insert_spec(project_id, rev, spec, "edit", author)
        self.publish("spec.revised", project_id=project_id, payload={"revision": rev, "author": author})
        return rev

    def assert_replannable(self, project_id: str) -> None:
        project = self.get(project_id)
        if not project:
            raise KeyError(project_id)
        tasks = self.tasks(project_id)
        if project["status"] not in (ProjectStatus.PLANNED, ProjectStatus.DRAFT) or any(t["status"] != TaskStatus.PENDING for t in tasks):
            raise ValueError("the plan has already started; edit tasks individually or create a new project")

    def replan(self, project_id: str, spec: Specification) -> None:
        """Replace an unstarted plan after a specification edit. Started plans are never rewritten."""
        self.assert_replannable(project_id)
        project = self.get(project_id)
        assert project is not None
        new_tasks = build_plan(spec, allow_hosted=bool(project["allow_hosted_inference"]), request=project["request"])
        with self.db.transaction():
            self.db.execute("DELETE FROM tasks WHERE project_id = ?", (project_id,))
            rev = self.current_plan_revision(project_id) + 1
            self._insert_plan(project_id, rev, self.current_spec(project_id)["revision"], "specification edited", new_tasks)
            self.db.update("projects", project_id, {"domain": spec.domain, "updated_at": now_iso()})
        self.publish("plan.revised", project_id=project_id, payload={"revision": rev, "reason": "specification edited",
                                                                     **plan_summary(new_tasks)})

    def current_plan_revision(self, project_id: str) -> int:
        row = self.db.one("SELECT MAX(revision) AS r FROM plan_revisions WHERE project_id = ?", (project_id,))
        return int(row["r"] or 0) if row else 0

    def current_spec(self, project_id: str) -> dict[str, Any]:
        row = self.db.one("SELECT * FROM specifications WHERE project_id = ? ORDER BY revision DESC LIMIT 1", (project_id,))
        if not row:
            raise KeyError(project_id)
        return row

    def specs(self, project_id: str) -> list[dict[str, Any]]:
        return self.db.all("SELECT * FROM specifications WHERE project_id = ? ORDER BY revision", (project_id,))

    def plans(self, project_id: str) -> list[dict[str, Any]]:
        return self.db.all("SELECT * FROM plan_revisions WHERE project_id = ? ORDER BY revision", (project_id,))

    def get(self, project_id: str) -> dict[str, Any] | None:
        row = self.db.one("SELECT * FROM projects WHERE id = ?", (project_id,))
        if row:
            row["task_counts"] = {r["status"]: r["n"] for r in self.db.all(
                "SELECT status, COUNT(*) AS n FROM tasks WHERE project_id = ? AND superseded_by IS NULL GROUP BY status", (project_id,))}
        return row

    def list(self) -> list[dict[str, Any]]:
        rows = self.db.all("SELECT * FROM projects ORDER BY updated_at DESC")
        counts = self.db.all("SELECT project_id, status, COUNT(*) AS n FROM tasks WHERE superseded_by IS NULL GROUP BY project_id, status")
        by: dict[str, dict[str, int]] = {}
        for c in counts:
            by.setdefault(c["project_id"], {})[c["status"]] = c["n"]
        for r in rows:
            r["task_counts"] = by.get(r["id"], {})
        return rows

    def tasks(self, project_id: str) -> list[dict[str, Any]]:
        rows = self.db.all("SELECT * FROM tasks WHERE project_id = ? ORDER BY plan_revision, position_x, position_y", (project_id,))
        deps = self.db.all("SELECT d.task_id, d.depends_on_id FROM task_dependencies d JOIN tasks t ON t.id = d.task_id "
                           "WHERE t.project_id = ?", (project_id,))
        by: dict[str, list[str]] = {}
        for d in deps:
            by.setdefault(d["task_id"], []).append(d["depends_on_id"])
        for r in rows:
            r["depends_on"] = by.get(r["id"], [])
        return rows

    def task(self, task_id: str) -> dict[str, Any] | None:
        row = self.db.one("SELECT * FROM tasks WHERE id = ?", (task_id,))
        if row:
            row["depends_on"] = [d["depends_on_id"] for d in self.db.all(
                "SELECT depends_on_id FROM task_dependencies WHERE task_id = ?", (task_id,))]
        return row

    def set_status(self, project_id: str, status: ProjectStatus) -> None:
        self.db.update("projects", project_id, {"status": status, "updated_at": now_iso()})
        self.publish("project.status", project_id=project_id, payload={"status": str(status)})

    def update_settings(self, project_id: str, *, name: str | None = None, autonomy: str | None = None,
                        allow_hosted: bool | None = None) -> dict[str, Any]:
        values: dict[str, Any] = {"updated_at": now_iso()}
        if name is not None:
            values["name"] = name[:120]
        if autonomy is not None:
            if autonomy not in ("review", "auto"):
                raise ValueError("autonomy must be 'review' or 'auto'")
            values["autonomy"] = autonomy
        if allow_hosted is not None:
            values["allow_hosted_inference"] = int(allow_hosted)
        self.db.update("projects", project_id, values)
        return self.get(project_id)  # type: ignore[return-value]

    def delete(self, project_id: str) -> None:
        self.db.execute("DELETE FROM projects WHERE id = ?", (project_id,))
