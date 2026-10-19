from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Request
from fastapi.responses import PlainTextResponse, Response
from pydantic import BaseModel, Field

from backend.blueprints.loader import load_blueprint
from backend.intent.engine import Specification, specification_markdown
from backend.security.paths import resolve_within
from backend.security.redact import redact_text

router = APIRouter()

MAX_FILE_BYTES = 512 * 1024
SKIP_DIRS = {".git", "node_modules", ".veylora"}


def svc(request: Request):
    return request.app.state.services


class CreateProject(BaseModel):
    request: str = Field(min_length=3, max_length=20000)
    name: str | None = Field(default=None, max_length=120)
    domain: str | None = None
    autonomy: Literal["review", "auto"] = "review"
    allow_hosted: bool = False
    spec: Specification | None = None


class PreviewSpec(BaseModel):
    request: str = Field(min_length=3, max_length=20000)
    domain: str | None = None


class UpdateSpec(BaseModel):
    spec: Specification


class ProjectSettings(BaseModel):
    name: str | None = Field(default=None, max_length=120)
    autonomy: Literal["review", "auto"] | None = None
    allow_hosted: bool | None = None


def _project(s, project_id: str) -> dict[str, Any]:
    p = s.projects.get(project_id)
    if not p:
        raise KeyError(project_id)
    return p


@router.post("/projects/preview-spec")
async def preview_spec(body: PreviewSpec, request: Request):
    spec = svc(request).projects.preview_spec(body.request, body.domain)
    return {"spec": spec.model_dump(), "markdown": specification_markdown(spec)}


@router.post("/projects")
async def create_project(body: CreateProject, request: Request):
    s = svc(request)
    if body.allow_hosted and not s.policy.hosted_authorized(None):
        raise ValueError("hosted inference is not authorised globally; enable it in Settings first")
    p = s.projects.create(body.request, name=body.name, domain=body.domain, autonomy=body.autonomy,
                          allow_hosted=body.allow_hosted, spec=body.spec)
    s.policy.audit("user", "project.create", p["id"], "created", {"autonomy": body.autonomy, "allow_hosted": body.allow_hosted},
                   project_id=p["id"])
    if body.autonomy == "auto":
        s.scheduler.start(p["id"])
    return s.projects.get(p["id"])


@router.get("/projects")
async def list_projects(request: Request):
    return svc(request).projects.list()


@router.get("/projects/{project_id}")
async def get_project(project_id: str, request: Request):
    s = svc(request)
    p = _project(s, project_id)
    p["scheduler_active"] = s.scheduler.is_running(project_id)
    p["pending_approvals"] = s.db.one("SELECT COUNT(*) AS n FROM approval_requests WHERE project_id = ? AND status = 'pending'",
                                      (project_id,))["n"]
    p["preview"] = s.previews.active(project_id)
    return p


@router.patch("/projects/{project_id}")
async def update_project(project_id: str, body: ProjectSettings, request: Request):
    s = svc(request)
    _project(s, project_id)
    if body.allow_hosted and not s.policy.hosted_authorized(None):
        raise ValueError("hosted inference is not authorised globally; enable it in Settings first")
    s.policy.audit("user", "project.settings", project_id, "updated", body.model_dump(exclude_none=True), project_id=project_id)
    return s.projects.update_settings(project_id, name=body.name, autonomy=body.autonomy, allow_hosted=body.allow_hosted)


@router.delete("/projects/{project_id}")
async def delete_project(project_id: str, request: Request):
    s = svc(request)
    _project(s, project_id)
    if s.scheduler.is_running(project_id):
        await s.scheduler.cancel(project_id)
    await s.previews.stop_project(project_id)
    s.policy.audit("user", "project.delete", project_id, "deleted")
    s.projects.delete(project_id)
    return {"deleted": project_id, "note": "database records removed; workspace files are kept on disk"}


@router.get("/projects/{project_id}/spec")
async def get_spec(project_id: str, request: Request):
    s = svc(request)
    row = s.projects.current_spec(project_id)
    spec = Specification.model_validate(row["content"])
    return {**row, "markdown": specification_markdown(spec), "revisions": [
        {k: r[k] for k in ("revision", "source", "author", "created_at")} for r in s.projects.specs(project_id)]}


@router.put("/projects/{project_id}/spec")
async def put_spec(project_id: str, body: UpdateSpec, request: Request):
    s = svc(request)
    _project(s, project_id)
    s.projects.assert_replannable(project_id)
    rev = s.projects.update_spec(project_id, body.spec, author="user")
    s.projects.replan(project_id, body.spec)
    return {"revision": rev, "project": s.projects.get(project_id)}


@router.get("/projects/{project_id}/plan")
async def get_plan(project_id: str, request: Request):
    s = svc(request)
    _project(s, project_id)
    tasks = s.projects.tasks(project_id)
    edges = [{"source": d, "target": t["id"]} for t in tasks for d in t["depends_on"]]
    return {"revisions": s.projects.plans(project_id), "tasks": tasks, "edges": edges}


@router.get("/projects/{project_id}/tasks/{task_id}")
async def get_task(project_id: str, task_id: str, request: Request):
    s = svc(request)
    t = s.projects.task(task_id)
    if not t or t["project_id"] != project_id:
        raise KeyError(task_id)
    t["executions"] = s.db.all("SELECT * FROM agent_executions WHERE task_id = ? ORDER BY started_at", (task_id,))
    t["tools"] = s.db.all("SELECT * FROM tool_executions WHERE task_id = ? ORDER BY created_at", (task_id,))
    t["artifacts"] = s.artifacts.list(project_id, task_id)
    t["approvals"] = s.db.all("SELECT * FROM approval_requests WHERE task_id = ? ORDER BY created_at", (task_id,))
    return t


@router.post("/projects/{project_id}/start")
async def start(project_id: str, request: Request):
    s = svc(request)
    s.policy.audit("user", "project.start", project_id, "requested", project_id=project_id)
    return s.scheduler.start(project_id)


@router.post("/projects/{project_id}/pause")
async def pause(project_id: str, request: Request):
    return svc(request).scheduler.pause(project_id)


@router.post("/projects/{project_id}/resume")
async def resume(project_id: str, request: Request):
    return svc(request).scheduler.start(project_id)


@router.post("/projects/{project_id}/cancel")
async def cancel(project_id: str, request: Request):
    s = svc(request)
    s.policy.audit("user", "project.cancel", project_id, "requested", project_id=project_id)
    return await s.scheduler.cancel(project_id)


@router.post("/projects/{project_id}/tasks/{task_id}/retry")
async def retry(project_id: str, task_id: str, request: Request):
    s = svc(request)
    t = s.projects.task(task_id)
    if not t or t["project_id"] != project_id:
        raise KeyError(task_id)
    return s.scheduler.retry_task(task_id)


@router.get("/projects/{project_id}/executions")
async def executions(project_id: str, request: Request):
    return svc(request).db.all("SELECT e.*, t.key AS task_key, t.title AS task_title FROM agent_executions e "
                               "JOIN tasks t ON t.id = e.task_id WHERE e.project_id = ? ORDER BY e.started_at DESC", (project_id,))


@router.get("/projects/{project_id}/tests")
async def tests(project_id: str, request: Request):
    return svc(request).db.all("SELECT * FROM test_results WHERE project_id = ? ORDER BY created_at DESC", (project_id,))


# ---------------------------------------------------------------- artifacts

@router.get("/projects/{project_id}/artifacts")
async def artifacts(project_id: str, request: Request, task_id: str | None = None):
    return svc(request).artifacts.list(project_id, task_id)


@router.get("/artifacts/{artifact_id}")
async def artifact_meta(artifact_id: str, request: Request):
    row = svc(request).artifacts.get(artifact_id)
    if not row:
        raise KeyError(artifact_id)
    return row


@router.get("/artifacts/{artifact_id}/content")
async def artifact_content(artifact_id: str, request: Request):
    s = svc(request)
    row, data = s.artifacts.read(artifact_id)
    if s.artifacts.is_text(row["mime"]):
        return PlainTextResponse(data.decode("utf-8", errors="replace"))
    if row["mime"] in ("image/png", "image/jpeg"):
        return Response(data, media_type=row["mime"], headers={"Content-Security-Policy": "default-src 'none'"})
    return Response(data, media_type="application/octet-stream",
                    headers={"Content-Disposition": f'attachment; filename="{Path(row["name"]).name}"'})


# ---------------------------------------------------------------- code explorer

def _repo(s, project_id: str) -> Path:
    _project(s, project_id)
    repo = s.runtime.workspace(project_id).repo
    if not repo.is_dir():
        raise KeyError("repository not created yet")
    return repo


@router.get("/projects/{project_id}/files")
async def file_tree(project_id: str, request: Request):
    repo = _repo(svc(request), project_id)
    out = []
    for dirpath, dirnames, filenames in os.walk(repo):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
        for f in sorted(filenames):
            p = Path(dirpath) / f
            out.append({"path": p.relative_to(repo).as_posix(), "size": p.stat().st_size})
        if len(out) > 5000:
            break
    return out


@router.get("/projects/{project_id}/file")
async def file_content(project_id: str, path: str, request: Request):
    repo = _repo(svc(request), project_id)
    p = resolve_within(repo, path)
    if not p.is_file():
        raise KeyError(path)
    if p.stat().st_size > MAX_FILE_BYTES:
        raise ValueError("file too large to display")
    data = p.read_bytes()
    if b"\x00" in data[:4096]:
        return {"path": path, "binary": True, "size": len(data)}
    return {"path": path, "binary": False, "size": len(data), "content": data.decode("utf-8", errors="replace")}


@router.get("/projects/{project_id}/git/log")
async def git_log(project_id: str, request: Request):
    s = svc(request)
    _repo(s, project_id)
    return await s.runtime.workspace(project_id).log(100)


@router.get("/projects/{project_id}/git/show/{commit}")
async def git_show(project_id: str, commit: str, request: Request):
    s = svc(request)
    _repo(s, project_id)
    if not commit.isalnum() or len(commit) > 64:
        raise ValueError("invalid commit id")
    return PlainTextResponse(redact_text(await s.runtime.workspace(project_id).show(commit)))


# ---------------------------------------------------------------- previews

@router.post("/projects/{project_id}/preview")
async def start_preview(project_id: str, request: Request):
    s = svc(request)
    repo = _repo(s, project_id)
    spec = Specification.model_validate(s.projects.current_spec(project_id)["content"])
    if not spec.blueprint:
        raise ValueError("this project has no runnable application")
    bp = load_blueprint(spec.blueprint)
    ws = s.runtime.workspace(project_id)
    s.policy.audit("user", "preview.start", project_id, "allowed", {"argv": ["node", *bp.start]}, project_id=project_id)
    return await s.previews.start(project_id, ws.root, repo, list(bp.start), ws.sandbox_home)


@router.get("/projects/{project_id}/previews")
async def previews(project_id: str, request: Request):
    return svc(request).previews.list(project_id)


@router.post("/previews/{preview_id}/stop")
async def stop_preview(preview_id: str, request: Request):
    s = svc(request)
    await s.previews.stop(preview_id)
    return s.previews.get(preview_id)


@router.get("/previews/{preview_id}/log")
async def preview_log(preview_id: str, request: Request):
    return PlainTextResponse(svc(request).previews.log_tail(preview_id))
