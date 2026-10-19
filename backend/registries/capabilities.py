from __future__ import annotations

import importlib.util
import os
import re
import shutil
import sys
from typing import Any, Literal

from pydantic import BaseModel, Field

from backend.persistence.db import Database, new_id, now_iso
from backend.registries.skills import fts_query

Platform = Literal["win32", "darwin", "linux"]
ALL_PLATFORMS: list[str] = ["win32", "darwin", "linux"]


class Dependency(BaseModel):
    kind: Literal["executable", "python_module", "capability", "credential", "service"]
    name: str
    version: str | None = None
    optional: bool = False
    probe_url: str | None = None


class ToolSchema(BaseModel):
    name: str
    description: str
    input_schema: dict[str, Any] = Field(default_factory=dict)


class CapabilityManifest(BaseModel):
    slug: str = Field(pattern=r"^[a-z0-9][a-z0-9._-]{1,80}$")
    name: str
    version: str
    kind: Literal["runtime", "tool", "analyzer", "connector", "generator", "model_runtime", "repository", "mcp_server", "library"]
    description: str
    source: str
    license: str | None = None
    platforms: list[str] = Field(default_factory=lambda: list(ALL_PLATFORMS))
    dependencies: list[Dependency] = Field(default_factory=list)
    inputs: list[str] = Field(default_factory=list)
    outputs: list[str] = Field(default_factory=list)
    tool_schemas: list[ToolSchema] = Field(default_factory=list)
    permissions: list[str] = Field(default_factory=list)
    install: str = "bundled"
    isolation: Literal["in_process", "subprocess", "sandboxed_subprocess", "external_service", "none"] = "subprocess"
    compatibility: dict[str, Any] = Field(default_factory=dict)
    trust: Literal["builtin", "reviewed", "untrusted"] = "untrusted"
    tags: list[str] = Field(default_factory=list)
    evidence: list[dict[str, Any]] = Field(default_factory=list)


def _builtin(**kw) -> CapabilityManifest:
    kw.setdefault("source", "veylora-os (built in)")
    kw.setdefault("license", "Veylora OS")
    kw.setdefault("trust", "builtin")
    kw.setdefault("version", "0.1.0")
    return CapabilityManifest(**kw)


BUILTIN_CAPABILITIES: list[CapabilityManifest] = [
    _builtin(slug="node-runtime", name="Node.js runtime", kind="runtime", version="detected",
             description="Executes generated JavaScript applications, servers and node:test suites.",
             dependencies=[Dependency(kind="executable", name="node", version=">=20")],
             permissions=["process.exec"], isolation="sandboxed_subprocess",
             tags=["javascript", "node", "server", "test", "frontend", "web"], install="system or bundled Electron runtime"),
    _builtin(slug="git-cli", name="Git", kind="tool", version="detected",
             description="Source control, isolated task worktrees, branch integration and diffs.",
             dependencies=[Dependency(kind="executable", name="git")], permissions=["git"],
             tags=["git", "worktree", "diff", "merge", "integration"], install="system"),
    _builtin(slug="python-runtime", name="Python runtime", kind="runtime", version=sys.version.split()[0],
             description="Runs Python tooling such as analyzers and pytest.",
             dependencies=[Dependency(kind="executable", name="python")], permissions=["process.exec"],
             tags=["python", "pytest", "backend"]),
    _builtin(slug="python-ast-indexer", name="Python AST symbol indexer", kind="analyzer",
             description="Indexes Python classes and functions using the standard-library ast module.",
             isolation="in_process", tags=["analysis", "python", "symbols", "repository", "codebase"], outputs=["symbols"]),
    _builtin(slug="js-symbol-indexer", name="JavaScript/TypeScript symbol indexer", kind="analyzer",
             description="Indexes exported functions, classes and constants with a conservative pattern-based scanner.",
             isolation="in_process", tags=["analysis", "javascript", "typescript", "symbols", "repository", "codebase"]),
    _builtin(slug="tree-sitter-indexer", name="Tree-sitter indexer", kind="analyzer", source="tree-sitter/tree-sitter",
             license="MIT", description="Language-aware parsing through tree-sitter Python bindings when installed.",
             dependencies=[Dependency(kind="python_module", name="tree_sitter_language_pack")], install="pip install tree-sitter-language-pack",
             isolation="in_process", trust="reviewed", tags=["analysis", "parser", "symbols", "repository"]),
    _builtin(slug="playwright-browser", name="Playwright browser automation", kind="tool", source="microsoft/playwright-python",
             license="Apache-2.0", description="Drives a Chromium-family browser to test generated applications, capture console errors and screenshots.",
             dependencies=[Dependency(kind="python_module", name="playwright")], permissions=["preview.run"],
             tags=["browser", "test", "e2e", "playwright", "webapp", "screenshot"], trust="reviewed",
             install="bundled Python package; uses installed Chromium, Microsoft Edge or Google Chrome"),
    _builtin(slug="static-security-scan", name="Static security scanner", kind="analyzer",
             description="Pattern-based scan for dangerous calls, embedded secrets and unsafe HTML sinks.",
             isolation="in_process", tags=["security", "review", "secrets"]),
    _builtin(slug="ollama-runtime", name="Ollama", kind="model_runtime", source="ollama/ollama", license="MIT",
             description="Local open-weight model inference over the Ollama HTTP API.",
             dependencies=[Dependency(kind="service", name="ollama", probe_url="http://127.0.0.1:11434/api/version")],
             isolation="external_service", tags=["llm", "inference", "local", "model"], trust="reviewed", install="https://ollama.com"),
    _builtin(slug="llama-cpp-server", name="llama.cpp server", kind="model_runtime", source="ggml-org/llama.cpp", license="MIT",
             description="OpenAI-compatible local inference through llama-server.",
             dependencies=[Dependency(kind="service", name="llama-server", probe_url="http://127.0.0.1:8080/health")],
             isolation="external_service", tags=["llm", "inference", "local", "model"], trust="reviewed"),
    _builtin(slug="github-connector", name="GitHub metadata connector", kind="connector",
             description="Reads public repository metadata, README, manifests and license via the GitHub REST API.",
             dependencies=[Dependency(kind="credential", name="GITHUB_TOKEN", optional=True)], permissions=["net.egress"],
             tags=["github", "repository", "discovery", "metadata"]),
    _builtin(slug="rea", name="REA reverse-engineering provider", kind="tool", source="morluto/rea", license=None,
             description="Optional specialist analysis of applications the user is authorised to inspect. Interface discovered from the installed tool.",
             dependencies=[Dependency(kind="executable", name="rea")], permissions=["rea.inspect"], trust="untrusted",
             install="see https://github.com/morluto/rea", tags=["reverse-engineering", "inspect", "electron", "website", "binary", "analysis"]),
    _builtin(slug="blueprint-supply-chain", name="Supply-chain planning blueprint", kind="generator",
             description="Generates a dependency-free Node.js supply-chain planning app with baseline forecasting and replenishment.",
             dependencies=[Dependency(kind="capability", name="node-runtime")],
             tags=["supply", "chain", "inventory", "forecast", "replenishment", "warehouse", "supplier", "scenario", "planning"]),
    _builtin(slug="blueprint-design-editor", name="Design editor blueprint", kind="generator",
             description="Generates a dependency-free browser design editor with canvas, layers, undo/redo, save and export.",
             dependencies=[Dependency(kind="capability", name="node-runtime")],
             tags=["design", "editor", "canvas", "shapes", "text", "layers", "export", "template", "image"]),
    _builtin(slug="blueprint-web-app", name="Generic web application scaffold", kind="generator",
             description="Scaffolds a dependency-free Node.js web app with an API server, static UI and node:test suite; features are model-generated.",
             dependencies=[Dependency(kind="capability", name="node-runtime")],
             tags=["web", "app", "scaffold", "dashboard", "api", "crud"]),
]


class CapabilityRegistry:
    def __init__(self, db: Database, resolve_executable):
        self.db = db
        self.resolve_executable = resolve_executable

    def seed_builtins(self) -> None:
        for m in BUILTIN_CAPABILITIES:
            existing = self.db.one("SELECT id, enabled FROM capabilities WHERE slug = ?", (m.slug,))
            self.register(m, enabled=bool(existing["enabled"]) if existing else True)

    def register(self, manifest: CapabilityManifest, enabled: bool = True, repository_id: str | None = None) -> dict[str, Any]:
        with self.db.transaction():
            existing = self.db.one("SELECT id FROM capabilities WHERE slug = ?", (manifest.slug,))
            values = {"name": manifest.name, "version": manifest.version, "kind": manifest.kind,
                      "description": manifest.description, "manifest": manifest.model_dump(), "trust": manifest.trust,
                      "enabled": int(enabled), "repository_id": repository_id, "updated_at": now_iso()}
            if existing:
                cap_id = existing["id"]
                self.db.update("capabilities", cap_id, values)
                self.db.execute("DELETE FROM capabilities_fts WHERE capability_id = ?", (cap_id,))
            else:
                cap_id = new_id("cap")
                self.db.insert("capabilities", {"id": cap_id, "slug": manifest.slug, **values})
            self.db.execute("INSERT INTO capabilities_fts(capability_id, name, description, tags) VALUES (?, ?, ?, ?)",
                            (cap_id, manifest.name, manifest.description, " ".join(manifest.tags + [manifest.kind])))
        return self.get(cap_id)  # type: ignore[return-value]

    def get(self, cap_id: str) -> dict[str, Any] | None:
        return self.db.one("SELECT * FROM capabilities WHERE id = ? OR slug = ?", (cap_id, cap_id))

    def list(self, query: str = "", kind: str | None = None) -> list[dict[str, Any]]:
        q = fts_query(query)
        if q:
            rows = self.db.all("SELECT c.*, bm25(capabilities_fts) AS score FROM capabilities_fts JOIN capabilities c "
                               "ON c.id = capabilities_fts.capability_id WHERE capabilities_fts MATCH ? ORDER BY score", (q,))
        else:
            rows = self.db.all("SELECT c.*, 0 AS score FROM capabilities c ORDER BY c.kind, c.name")
        if kind:
            rows = [r for r in rows if r["kind"] == kind]
        return rows

    def set_enabled(self, cap_id: str, enabled: bool) -> None:
        row = self.get(cap_id)
        if not row:
            raise KeyError(cap_id)
        if enabled and row["trust"] == "untrusted" and row["kind"] == "repository":
            raise ValueError("repository-derived capabilities must be reviewed before they can be enabled")
        self.db.update("capabilities", row["id"], {"enabled": int(enabled)})

    def set_trust(self, cap_id: str, trust: str) -> None:
        row = self.get(cap_id)
        if not row:
            raise KeyError(cap_id)
        manifest = dict(row["manifest"])
        manifest["trust"] = trust
        self.db.update("capabilities", row["id"], {"trust": trust, "manifest": manifest})

    def resolve(self, slug: str, _seen: set[str] | None = None) -> dict[str, Any]:
        """Check a capability's dependency tree against this machine without executing untrusted code."""
        seen = _seen or set()
        row = self.get(slug)
        if not row:
            return {"slug": slug, "status": "missing", "problems": [f"capability {slug} is not registered"], "dependencies": []}
        manifest = CapabilityManifest.model_validate(row["manifest"])
        problems: list[str] = []
        warnings: list[str] = []
        deps_report = []
        if sys.platform not in manifest.platforms:
            problems.append(f"unsupported platform {sys.platform}")
        for dep in manifest.dependencies:
            ok, detail = self._check_dependency(dep, seen | {manifest.slug})
            deps_report.append({"kind": dep.kind, "name": dep.name, "version": dep.version, "optional": dep.optional,
                                "ok": ok, "detail": detail})
            if not ok:
                (warnings if dep.optional else problems).append(f"{dep.kind} {dep.name}: {detail}")
        if not row["enabled"]:
            warnings.append("capability is disabled")
        status = "available" if not problems else ("unsupported" if any("platform" in p for p in problems) else "missing_dependency")
        report = {"slug": manifest.slug, "status": status, "problems": problems, "warnings": warnings,
                  "dependencies": deps_report, "checked_at": now_iso(), "method": "static dependency resolution"}
        self.db.update("capabilities", row["id"], {"verification": report,
                                                   "install_status": "installed" if status == "available" else status})
        return report

    def _check_dependency(self, dep: Dependency, seen: set[str]) -> tuple[bool, str]:
        if dep.kind == "executable":
            path = self.resolve_executable(dep.name)
            return (bool(path), path or "not found on PATH")
        if dep.kind == "python_module":
            found = importlib.util.find_spec(dep.name) is not None
            return found, "importable" if found else "module not installed"
        if dep.kind == "credential":
            present = bool(os.environ.get(dep.name))
            return present, "set" if present else "environment variable not set"
        if dep.kind == "capability":
            if dep.name in seen:
                return False, "circular capability dependency"
            sub = self.resolve(dep.name, seen)
            return sub["status"] == "available", sub["status"]
        if dep.kind == "service":
            return True, f"probed at runtime ({dep.probe_url})"
        return False, "unknown dependency kind"

    def select_for_text(self, text: str, limit: int = 4) -> list[dict[str, Any]]:
        rows = [r for r in self.list(text) if r["enabled"]]
        words = set(re.findall(r"[a-z]+", text.lower()))
        out = []
        for r in rows[: limit * 3]:
            tags = set(r["manifest"].get("tags", []))
            overlap = sorted(tags & words)
            if not overlap and r["kind"] != "generator":
                continue
            out.append({"id": r["id"], "slug": r["slug"], "name": r["name"], "kind": r["kind"],
                        "why": "matched " + (", ".join(overlap) if overlap else "description")})
        return out[:limit]


def find_executable(name: str) -> str | None:
    return shutil.which(name)
