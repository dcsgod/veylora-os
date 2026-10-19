from __future__ import annotations

import shutil
from dataclasses import dataclass, field

from backend.agents.runtime import AgentRuntime
from backend.artifacts.store import ArtifactStore
from backend.config import Config
from backend.execution.previews import PreviewManager
from backend.execution.runner import ProcessRunner
from backend.models.router import ModelRouter
from backend.models.service import ModelService
from backend.orchestration.events import EventBus
from backend.orchestration.projects import ProjectService
from backend.persistence.db import Database
from backend.registries.capabilities import CapabilityRegistry
from backend.registries.repositories import RepositoryRegistry
from backend.registries.skills import SkillRegistry
from backend.security.policy import PolicyEngine
from integrations.github.connector import GitHubConnector
from integrations.rea.adapter import ReaAdapter


@dataclass
class Services:
    config: Config
    db: Database
    bus: EventBus
    policy: PolicyEngine
    runner: ProcessRunner
    models: ModelService
    router: ModelRouter
    artifacts: ArtifactStore
    skills: SkillRegistry
    capabilities: CapabilityRegistry
    repositories: RepositoryRegistry
    rea: ReaAdapter
    previews: PreviewManager
    projects: ProjectService
    runtime: AgentRuntime = field(init=False)
    scheduler: "Scheduler" = field(init=False)  # noqa: F821

    @classmethod
    def build(cls, config: Config, *, register_default_providers: bool = True) -> "Services":
        from backend.orchestration.scheduler import Scheduler

        config.ensure_dirs()
        db = Database(config.db_path)
        db.migrate()
        bus = EventBus(db)
        runner = ProcessRunner(config)
        models = ModelService(db, bus.publish, config.ollama_url)
        if register_default_providers:
            models.build_from_settings()
        capabilities = CapabilityRegistry(db, lambda name: runner.resolve(name) or shutil.which(name))
        capabilities.seed_builtins()
        repositories = RepositoryRegistry(db, capabilities, GitHubConnector())
        repositories.seed()
        s = cls(
            config=config, db=db, bus=bus, policy=PolicyEngine(db, bus.publish), runner=runner, models=models,
            router=ModelRouter(models), artifacts=ArtifactStore(db, config.projects_dir, bus.publish),
            skills=SkillRegistry(db), capabilities=capabilities, repositories=repositories, rea=ReaAdapter(db, runner),
            previews=PreviewManager(db, runner, bus.publish), projects=ProjectService(db, bus.publish),
        )
        s.projects.ensure_workspace()
        s.runtime = AgentRuntime(s)
        s.scheduler = Scheduler(s)
        return s

    async def aclose(self) -> None:
        await self.scheduler.shutdown()
        self.previews.stop_all()
        await self.models.aclose()
        self.db.close()
