from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum


class Permission(StrEnum):
    FS_READ = "fs.read"
    FS_WRITE = "fs.write"
    FS_READ_EXTERNAL = "fs.read.external"
    PROCESS_EXEC = "process.exec"
    GIT = "git"
    NET_EGRESS = "net.egress"
    DEPENDENCY_INSTALL = "dependency.install"
    MODEL_LOCAL = "model.local"
    MODEL_HOSTED = "model.hosted"
    REA_INSPECT = "rea.inspect"
    PREVIEW = "preview.run"
    PUBLISH = "publish"


class Grant(StrEnum):
    ALLOW = "allow"
    APPROVE = "approve"
    ALLOWLIST = "allowlist"


@dataclass(frozen=True)
class RoleProfile:
    id: str
    title: str
    description: str
    grants: dict[Permission, Grant]
    tools: tuple[str, ...]
    model_class: str
    context_budget_tokens: int = 4096
    max_output_tokens: int = 1024
    skill_keywords: tuple[str, ...] = field(default_factory=tuple)


P, G = Permission, Grant
_ENGINEER = {P.FS_READ: G.ALLOW, P.FS_WRITE: G.ALLOW, P.GIT: G.ALLOW, P.MODEL_LOCAL: G.ALLOW, P.MODEL_HOSTED: G.ALLOW}

ROLES: dict[str, RoleProfile] = {
    r.id: r
    for r in [
        RoleProfile("planner", "Planner", "Turns intent into specifications and dependency-aware plans.",
                    {P.FS_READ: G.ALLOW, P.MODEL_LOCAL: G.ALLOW, P.MODEL_HOSTED: G.ALLOW},
                    ("read_artifact", "write_artifact"), "planning", skill_keywords=("spec", "plan", "requirements")),
        RoleProfile("architect", "Software architect", "Defines architecture, module boundaries and contracts.",
                    {P.FS_READ: G.ALLOW, P.FS_WRITE: G.ALLOW, P.MODEL_LOCAL: G.ALLOW, P.MODEL_HOSTED: G.ALLOW},
                    ("read_artifact", "write_artifact"), "planning", skill_keywords=("architecture", "design", "mcp")),
        RoleProfile("repo_discovery", "Repository discovery agent", "Finds and analyses repositories as capability evidence.",
                    {P.FS_READ: G.ALLOW, P.NET_EGRESS: G.ALLOWLIST, P.FS_READ_EXTERNAL: G.APPROVE, P.REA_INSPECT: G.APPROVE,
                     P.MODEL_LOCAL: G.ALLOW},
                    ("github_metadata", "index_repository", "rea_inspect"), "extraction", skill_keywords=("repository", "code", "analysis")),
        RoleProfile("skill_discovery", "Skill discovery agent", "Selects relevant skills and capabilities from the registries.",
                    {P.FS_READ: G.ALLOW, P.MODEL_LOCAL: G.ALLOW},
                    ("search_skills", "search_capabilities"), "extraction", skill_keywords=("skill",)),
        RoleProfile("frontend_engineer", "Frontend engineer", "Implements user interfaces.",
                    dict(_ENGINEER), ("read_file", "write_file", "commit"), "code", skill_keywords=("frontend", "ui", "canvas", "design", "theme", "artifacts")),
        RoleProfile("backend_engineer", "Backend engineer", "Implements services and APIs.",
                    dict(_ENGINEER), ("read_file", "write_file", "commit"), "code", skill_keywords=("backend", "api", "server", "mcp")),
        RoleProfile("data_engineer", "Data and database engineer", "Implements schemas, ingestion and data validation.",
                    dict(_ENGINEER), ("read_file", "write_file", "commit"), "code", skill_keywords=("data", "csv", "schema", "spreadsheet", "xlsx")),
        RoleProfile("domain_specialist", "Domain specialist", "Implements transparent domain algorithms.",
                    dict(_ENGINEER), ("read_file", "write_file", "commit"), "code", skill_keywords=("forecast", "analysis", "domain", "optimization")),
        RoleProfile("integration_engineer", "Integration engineer", "Merges task branches and resolves integration issues.",
                    {**_ENGINEER, P.PROCESS_EXEC: G.ALLOW, P.DEPENDENCY_INSTALL: G.APPROVE},
                    ("merge_branches", "run_command", "read_file", "write_file"), "code", skill_keywords=("integration", "changelog")),
        RoleProfile("test_engineer", "Testing and browser automation agent", "Runs unit, integration and browser tests.",
                    {P.FS_READ: G.ALLOW, P.FS_WRITE: G.ALLOW, P.PROCESS_EXEC: G.ALLOW, P.PREVIEW: G.ALLOW, P.NET_EGRESS: G.ALLOWLIST,
                     P.DEPENDENCY_INSTALL: G.APPROVE, P.MODEL_LOCAL: G.ALLOW},
                    ("run_tests", "start_preview", "browser_check"), "code", skill_keywords=("test", "webapp-testing", "playwright", "browser")),
        RoleProfile("code_reviewer", "Code reviewer", "Reviews changes for correctness and regressions.",
                    {P.FS_READ: G.ALLOW, P.MODEL_LOCAL: G.ALLOW, P.MODEL_HOSTED: G.ALLOW},
                    ("read_file", "write_artifact"), "review", skill_keywords=("review", "code")),
        RoleProfile("security_reviewer", "Security reviewer", "Reviews changes for security issues and unsafe patterns.",
                    {P.FS_READ: G.ALLOW, P.MODEL_LOCAL: G.ALLOW},
                    ("read_file", "static_scan", "write_artifact"), "review", skill_keywords=("security",)),
        RoleProfile("documentation", "Documentation agent", "Writes setup guides and documentation.",
                    {P.FS_READ: G.ALLOW, P.FS_WRITE: G.ALLOW, P.GIT: G.ALLOW, P.MODEL_LOCAL: G.ALLOW, P.MODEL_HOSTED: G.ALLOW},
                    ("read_file", "write_file", "commit"), "docs", skill_keywords=("documentation", "writer", "content", "changelog")),
        RoleProfile("verifier", "Final verification agent", "Evaluates acceptance criteria against recorded evidence.",
                    {P.FS_READ: G.ALLOW, P.PROCESS_EXEC: G.ALLOW},
                    ("read_test_results", "write_artifact"), "review", skill_keywords=("verification", "test")),
    ]
}

# Actions in these categories always need a human decision regardless of role grants.
ALWAYS_APPROVE = frozenset({P.DEPENDENCY_INSTALL, P.REA_INSPECT, P.PUBLISH, P.FS_READ_EXTERNAL})


def get_role(role_id: str) -> RoleProfile:
    if role_id not in ROLES:
        raise KeyError(f"unknown agent role {role_id}")
    return ROLES[role_id]
