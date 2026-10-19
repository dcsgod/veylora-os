from __future__ import annotations

import os
import shutil
import sys
import time
from pathlib import Path
from typing import Any, Literal

import psutil
from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from backend.agents.roles import ROLES
from backend.config import APP_VERSION
from backend.models.base import ChatMessage
from backend.orchestration.states import TaskStatus
from integrations.skills.catalogue import CATALOGUE_BRANCH, CATALOGUE_LICENSE, CATALOGUE_REPO, fetch_github_archive

router = APIRouter()
STARTED = time.time()


def svc(request: Request):
    return request.app.state.services


# ---------------------------------------------------------------- approvals & audit

class Decide(BaseModel):
    approve: bool


@router.get("/approvals")
async def approvals(request: Request, status: str | None = None, project_id: str | None = None):
    where, params = [], []
    if status:
        where.append("a.status = ?")
        params.append(status)
    if project_id:
        where.append("a.project_id = ?")
        params.append(project_id)
    sql = ("SELECT a.*, t.key AS task_key, t.title AS task_title, p.name AS project_name FROM approval_requests a "
           "LEFT JOIN tasks t ON t.id = a.task_id LEFT JOIN projects p ON p.id = a.project_id")
    if where:
        sql += " WHERE " + " AND ".join(where)
    return svc(request).db.all(sql + " ORDER BY a.created_at DESC LIMIT 500", params)


@router.post("/approvals/{approval_id}/decide")
async def decide(approval_id: str, body: Decide, request: Request):
    s = svc(request)
    row = s.policy.decide(approval_id, body.approve, actor="user")
    s.scheduler.on_approval(row)
    return row


@router.get("/audit")
async def audit(request: Request, project_id: str | None = None, limit: int = 300):
    limit = min(max(limit, 1), 2000)
    if project_id:
        return svc(request).db.all("SELECT * FROM audit_events WHERE project_id = ? ORDER BY id DESC LIMIT ?", (project_id, limit))
    return svc(request).db.all("SELECT * FROM audit_events ORDER BY id DESC LIMIT ?", (limit,))


@router.get("/roles")
async def roles():
    return [{"id": r.id, "title": r.title, "description": r.description, "model_class": r.model_class,
             "tools": list(r.tools), "grants": {str(k): str(v) for k, v in r.grants.items()}} for r in ROLES.values()]


# ---------------------------------------------------------------- models

class ModelPatch(BaseModel):
    enabled: bool | None = None
    role_assignments: list[str] | None = None
    max_concurrency: int | None = Field(default=None, ge=1, le=8)


class RoutePreview(BaseModel):
    task_type: str
    role: str
    title: str = ""
    description: str = ""


class ModelTest(BaseModel):
    prompt: str = Field(default="Reply with the single word: ready", max_length=2000)


@router.get("/models")
async def models(request: Request):
    return svc(request).models.list_configs()


@router.get("/models/providers")
async def providers(request: Request):
    s = svc(request)
    return {"configured": s.models.provider_configs(), "health": await s.models.health()}


@router.post("/models/sync")
async def sync_models(request: Request):
    s = svc(request)
    s.policy.audit("user", "models.sync", "providers", "requested")
    return await s.models.sync()


@router.patch("/models/{model_id}")
async def patch_model(model_id: str, body: ModelPatch, request: Request):
    s = svc(request)
    if not s.models.get_config(model_id):
        raise KeyError(model_id)
    values: dict[str, Any] = {k: v for k, v in body.model_dump(exclude_none=True).items()}
    if "enabled" in values:
        values["enabled"] = int(values["enabled"])
    if "role_assignments" in values:
        unknown = [r for r in values["role_assignments"] if r not in ROLES]
        if unknown:
            raise ValueError(f"unknown roles: {unknown}")
    s.db.update("model_configs", model_id, values)
    s.policy.audit("user", "model.update", model_id, "updated", values)
    return s.models.get_config(model_id)


@router.post("/models/route")
async def route_preview(body: RoutePreview, request: Request):
    s = svc(request)
    hosted = s.policy.hosted_authorized(None)
    return s.router.route(body.task_type, role=body.role, title=body.title, description=body.description,
                          allow_hosted=hosted, privacy="allow_hosted" if hosted else "local_only").to_dict()


@router.post("/models/{model_id}/test")
async def test_model(model_id: str, body: ModelTest, request: Request):
    s = svc(request)
    cfg = s.models.get_config(model_id)
    if not cfg:
        raise KeyError(model_id)
    st = s.models.providers.get(cfg["provider"])
    if st and st.provider.kind == "hosted" and not s.policy.hosted_authorized(None):
        raise ValueError("hosted inference is not authorised; enable it in Settings first")
    s.policy.audit("user", "model.test", f"{cfg['provider']}/{cfg['name']}", "requested")
    res = await s.models.generate(model_id, [ChatMessage("user", body.prompt)], max_tokens=64, timeout_s=120)
    return {"text": res.text, "latency_ms": res.latency_ms, "input_tokens": res.input_tokens, "output_tokens": res.output_tokens}


# ---------------------------------------------------------------- skills

class SkillImport(BaseModel):
    source: Literal["catalogue", "directory"] = "catalogue"
    path: str | None = None


class SkillEnable(BaseModel):
    enabled: bool
    project_id: str | None = None


class TrustBody(BaseModel):
    trust: Literal["untrusted", "reviewed", "trusted"]


class ProjectSkill(BaseModel):
    name: str = Field(min_length=2, max_length=64)
    description: str = Field(min_length=5, max_length=1024)
    instructions: str = Field(min_length=5, max_length=50000)


@router.get("/skills")
async def skills(request: Request, q: str = "", category: str | None = None, role: str | None = None,
                 enabled_only: bool = False, project_id: str | None = None, limit: int = 100):
    return svc(request).skills.search(q, category=category, role=role, enabled_only=enabled_only, project_id=project_id,
                                      limit=min(max(limit, 1), 500))


@router.get("/skills/categories")
async def skill_categories(request: Request):
    return svc(request).skills.categories()


@router.get("/skills/{skill_id}")
async def skill(skill_id: str, request: Request):
    s = svc(request)
    row = s.skills.get(skill_id)
    if not row:
        raise KeyError(skill_id)
    row["usage"] = s.skills.usage_stats(row["id"])
    return row


@router.post("/skills/import")
async def import_skills(body: SkillImport, request: Request):
    s = svc(request)
    if body.source == "directory":
        if not body.path:
            raise ValueError("path is required for directory imports")
        root = Path(body.path).expanduser().resolve()
        if not root.is_dir():
            raise ValueError("path is not a directory")
        s.policy.audit("user", "skills.import", str(root), "allowed", {"source": "directory"})
        return s.skills.import_directory(root, source_repo=None, source_commit=None, repo_license=None, origin="local")
    allow = set(s.policy.net_allowlist())
    if not {"api.github.com", "codeload.github.com"} <= allow:
        raise ValueError("api.github.com and codeload.github.com must be in the network allowlist to fetch the catalogue")
    s.policy.audit("user", "skills.import", CATALOGUE_REPO, "allowed", {"source": "github archive"})
    fetched = await fetch_github_archive(CATALOGUE_REPO, CATALOGUE_BRANCH, s.config.cache_dir / "skills-catalogue",
                                         os.environ.get("GITHUB_TOKEN"))
    result = s.skills.import_directory(fetched.root, source_repo=CATALOGUE_REPO, source_commit=fetched.commit,
                                       repo_license=fetched.license or CATALOGUE_LICENSE)
    s.bus.publish("skills.imported", payload={"repo": CATALOGUE_REPO, "commit": fetched.commit,
                                              "imported": len(result["imported"]), "updated": len(result["updated"]),
                                              "invalid": len(result["invalid"])})
    return result


@router.post("/skills/{skill_id}/enable")
async def enable_skill(skill_id: str, body: SkillEnable, request: Request):
    s = svc(request)
    s.skills.set_enabled(skill_id, body.enabled, body.project_id)
    s.policy.audit("user", "skill.enable" if body.enabled else "skill.disable", skill_id, "updated",
                   {"project_id": body.project_id}, project_id=body.project_id)
    return s.skills.get(skill_id)


@router.post("/skills/{skill_id}/trust")
async def trust_skill(skill_id: str, body: TrustBody, request: Request):
    s = svc(request)
    if not s.skills.get(skill_id):
        raise KeyError(skill_id)
    s.skills.set_trust(s.skills.get(skill_id)["id"], body.trust)
    s.policy.audit("user", "skill.trust", skill_id, body.trust)
    return s.skills.get(skill_id)


@router.post("/projects/{project_id}/skills")
async def create_project_skill(project_id: str, body: ProjectSkill, request: Request):
    s = svc(request)
    if not s.projects.get(project_id):
        raise KeyError(project_id)
    return s.skills.create_project_skill(project_id, body.name, body.description, body.instructions)


# ---------------------------------------------------------------- capabilities

class EnableBody(BaseModel):
    enabled: bool


@router.get("/capabilities")
async def capabilities(request: Request, q: str = "", kind: str | None = None):
    return svc(request).capabilities.list(q, kind)


@router.get("/capabilities/{cap_id}")
async def capability(cap_id: str, request: Request):
    row = svc(request).capabilities.get(cap_id)
    if not row:
        raise KeyError(cap_id)
    return row


@router.post("/capabilities/{cap_id}/resolve")
async def resolve_capability(cap_id: str, request: Request):
    s = svc(request)
    row = s.capabilities.get(cap_id)
    if not row:
        raise KeyError(cap_id)
    return s.capabilities.resolve(row["slug"])


@router.post("/capabilities/{cap_id}/enable")
async def enable_capability(cap_id: str, body: EnableBody, request: Request):
    s = svc(request)
    s.capabilities.set_enabled(cap_id, body.enabled)
    s.policy.audit("user", "capability.enable" if body.enabled else "capability.disable", cap_id, "updated")
    return s.capabilities.get(cap_id)


@router.post("/capabilities/{cap_id}/trust")
async def trust_capability(cap_id: str, body: TrustBody, request: Request):
    s = svc(request)
    s.capabilities.set_trust(cap_id, body.trust)
    s.policy.audit("user", "capability.trust", cap_id, body.trust)
    return s.capabilities.get(cap_id)


# ---------------------------------------------------------------- repositories

class AddRepo(BaseModel):
    full_name: str = Field(min_length=3, max_length=200)


class LocalRepo(BaseModel):
    path: str
    name: str | None = Field(default=None, max_length=100)


@router.get("/repositories")
async def repositories(request: Request):
    return svc(request).repositories.list()


@router.post("/repositories")
async def add_repository(body: AddRepo, request: Request):
    s = svc(request)
    s.policy.audit("user", "repository.add", body.full_name, "added")
    return s.repositories.add_github(body.full_name.strip())


@router.post("/repositories/local")
async def index_local(body: LocalRepo, request: Request):
    s = svc(request)
    s.policy.audit("user", "repository.index_local", body.path, "allowed", {"note": "user-selected directory, static index only"})
    return s.repositories.index_local(body.path, body.name)


@router.get("/repositories/{repo_id}")
async def repository(repo_id: str, request: Request):
    row = svc(request).repositories.get(repo_id)
    if not row:
        raise KeyError(repo_id)
    return row


@router.post("/repositories/{repo_id}/analyze")
async def analyze_repository(repo_id: str, request: Request):
    s = svc(request)
    if "api.github.com" not in s.policy.net_allowlist():
        raise ValueError("api.github.com must be in the network allowlist")
    s.policy.audit("user", "repository.analyze", repo_id, "allowed", {"method": "GitHub metadata + tree, no clone, no execution"})
    return await s.repositories.analyze_github(repo_id)


@router.get("/repositories/{repo_id}/symbols")
async def repo_symbols(repo_id: str, request: Request, q: str = ""):
    return svc(request).repositories.symbols(repo_id, q)


@router.post("/repositories/{repo_id}/propose-capability")
async def propose_capability(repo_id: str, request: Request):
    return svc(request).repositories.propose_capability(repo_id)


@router.get("/rea/status")
async def rea_status(request: Request):
    return await svc(request).rea.status()


# ---------------------------------------------------------------- settings

class ProviderConfig(BaseModel):
    id: str = Field(pattern=r"^[a-z0-9_-]{2,32}$")
    type: Literal["ollama", "llama_cpp", "openai_compatible"]
    url: str = Field(default="", max_length=500)
    enabled: bool = False
    max_concurrency: int = Field(default=1, ge=1, le=8)
    name: str | None = Field(default=None, max_length=80)
    api_key_env: str | None = Field(default=None, pattern=r"^[A-Z][A-Z0-9_]{1,63}$")


class SettingsPatch(BaseModel):
    network_allowlist: list[str] | None = None
    hosted_authorized: bool | None = None
    providers: list[ProviderConfig] | None = None
    rea_executable: str | None = None
    rea_inspect_args: list[str] | None = None
    max_parallel: int | None = Field(default=None, ge=1, le=8)
    theme: Literal["light", "dark", "system"] | None = None


def _settings(s) -> dict[str, Any]:
    return {
        "network_allowlist": s.policy.net_allowlist(),
        "hosted_authorized": bool(s.db.get_setting("inference.hosted_authorized", False)),
        "providers": s.models.provider_configs(),
        "rea_executable": s.db.get_setting("rea.executable"),
        "rea_inspect_args": s.db.get_setting("rea.inspect_args"),
        "max_parallel": s.scheduler.max_parallel,
        "theme": s.db.get_setting("ui.theme", "system"),
        "data_dir": str(s.config.data_dir),
    }


@router.get("/settings")
async def get_settings(request: Request):
    return _settings(svc(request))


@router.patch("/settings")
async def patch_settings(body: SettingsPatch, request: Request):
    s = svc(request)
    changes = body.model_dump(exclude_none=True)
    if body.network_allowlist is not None:
        hosts = [h.strip().lower() for h in body.network_allowlist if h.strip()]
        if any("/" in h or " " in h or h == "*" for h in hosts):
            raise ValueError("allowlist entries must be bare hostnames")
        s.db.set_setting("network.allowlist", hosts)
    if body.hosted_authorized is not None:
        s.db.set_setting("inference.hosted_authorized", body.hosted_authorized)
    if body.providers is not None:
        ids = [p.id for p in body.providers]
        if len(set(ids)) != len(ids):
            raise ValueError("provider ids must be unique")
        s.db.set_setting("models.providers", [p.model_dump() for p in body.providers])
        await s.models.aclose()
        s.models.providers.clear()
        s.models.build_from_settings()
    if body.rea_executable is not None:
        if body.rea_executable and not Path(body.rea_executable).is_file():
            raise ValueError("REA executable path does not exist")
        s.db.set_setting("rea.executable", body.rea_executable or None)
    if body.rea_inspect_args is not None:
        if not any("{target}" in a for a in body.rea_inspect_args):
            raise ValueError("REA argument template must contain {target}")
        s.db.set_setting("rea.inspect_args", body.rea_inspect_args)
    if body.max_parallel is not None:
        s.db.set_setting("scheduler.max_parallel", body.max_parallel)
    if body.theme is not None:
        s.db.set_setting("ui.theme", body.theme)
    s.policy.audit("user", "settings.update", ",".join(changes), "updated", changes)
    result = _settings(s)
    if body.max_parallel is not None:
        result["note"] = "parallelism change applies after restart"
    return result


# ---------------------------------------------------------------- system & resources

@router.get("/system")
async def system(request: Request):
    s = svc(request)
    try:
        import playwright  # noqa: F401
        playwright_ok = True
    except ImportError:
        playwright_ok = False
    return {
        "version": APP_VERSION, "platform": sys.platform, "python": sys.version.split()[0],
        "data_dir": str(s.config.data_dir), "executables": s.runner.available(),
        "playwright_module": playwright_ok, "git": shutil.which("git"),
        "recovery": getattr(request.app.state, "recovery", None), "uptime_s": int(time.time() - STARTED),
    }


@router.get("/resources")
async def resources(request: Request):
    s = svc(request)
    proc = psutil.Process()
    children = proc.children(recursive=True)
    vm = psutil.virtual_memory()
    running = s.db.one("SELECT COUNT(*) AS n FROM tasks WHERE status = ?", (TaskStatus.RUNNING,))["n"]
    return {
        "system": {"cpu_percent": psutil.cpu_percent(interval=None), "cpu_count": psutil.cpu_count(),
                   "memory_total_mb": round(vm.total / 2**20), "memory_used_percent": vm.percent},
        "backend": {"rss_mb": round(proc.memory_info().rss / 2**20, 1), "child_processes": len(children)},
        "scheduler": {"running_tasks": running, "max_parallel": s.scheduler.max_parallel},
        "models": [{"provider": pid, "queued": st.queued, "active": st.active} for pid, st in s.models.providers.items()],
    }
