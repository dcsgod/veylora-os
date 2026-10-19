from __future__ import annotations

import base64
import json
import os
import re
import tomllib
from typing import Any

import httpx

MANIFEST_FILES = ("package.json", "pyproject.toml", "setup.py", "setup.cfg", "Cargo.toml", "go.mod", "requirements.txt",
                  "Dockerfile", "mcp.json", "server.json", "SKILL.md")


class GitHubError(RuntimeError):
    pass


class GitHubConnector:
    """Read-only GitHub REST connector. A token is optional and only read from the environment."""

    def __init__(self, token_env: str = "GITHUB_TOKEN", base_url: str = "https://api.github.com"):
        self.token_env = token_env
        self.base_url = base_url

    def _client(self) -> httpx.AsyncClient:
        headers = {"Accept": "application/vnd.github+json", "User-Agent": "veylora-os", "X-GitHub-Api-Version": "2022-11-28"}
        if token := os.environ.get(self.token_env):
            headers["Authorization"] = f"Bearer {token}"
        return httpx.AsyncClient(base_url=self.base_url, headers=headers, timeout=20, follow_redirects=True)

    async def _get(self, client: httpx.AsyncClient, path: str, **params) -> Any:
        r = await client.get(path, params=params or None)
        if r.status_code == 404:
            return None
        if r.status_code == 403 and r.headers.get("x-ratelimit-remaining") == "0":
            raise GitHubError("GitHub API rate limit exceeded; set GITHUB_TOKEN to raise the limit")
        if r.status_code >= 400:
            raise GitHubError(f"GitHub API {path} returned {r.status_code}")
        return r.json()

    async def analyze(self, full_name: str) -> dict[str, Any]:
        if not re.match(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", full_name):
            raise GitHubError("repository must be owner/name")
        async with self._client() as client:
            meta = await self._get(client, f"/repos/{full_name}")
            if meta is None:
                raise GitHubError(f"repository {full_name} not found")
            branch = meta.get("default_branch") or "main"
            commit = await self._get(client, f"/repos/{full_name}/commits/{branch}")
            tree = await self._get(client, f"/repos/{full_name}/git/trees/{branch}", recursive="1")
            readme = await self._get(client, f"/repos/{full_name}/readme")
            paths = [t["path"] for t in (tree or {}).get("tree", []) if t.get("type") == "blob"]
            manifests: dict[str, str] = {}
            for name in MANIFEST_FILES:
                if name in paths:
                    data = await self._get(client, f"/repos/{full_name}/contents/{name}", ref=branch)
                    if data and data.get("encoding") == "base64":
                        manifests[name] = base64.b64decode(data["content"]).decode("utf-8", errors="replace")[:60000]
        readme_text = ""
        if readme and readme.get("encoding") == "base64":
            readme_text = base64.b64decode(readme["content"]).decode("utf-8", errors="replace")
        return {
            "metadata": {
                "full_name": meta["full_name"], "url": meta.get("html_url"), "description": meta.get("description"),
                "license": (meta.get("license") or {}).get("spdx_id"), "default_branch": branch,
                "archived": meta.get("archived"), "stars": meta.get("stargazers_count"), "pushed_at": meta.get("pushed_at"),
                "topics": meta.get("topics") or [], "language": meta.get("language"),
                "head_commit": (commit or {}).get("sha"), "tree_truncated": bool((tree or {}).get("truncated")),
            },
            "analysis": static_analysis(paths, manifests, readme_text),
        }


def static_analysis(paths: list[str], manifests: dict[str, str], readme: str) -> dict[str, Any]:
    """Derive capability evidence from file structure and manifests. Nothing here is execution-verified."""
    evidence: list[dict[str, Any]] = []
    entry_points: list[dict[str, str]] = []
    dependencies: dict[str, list[str]] = {}

    def add(claim: str, level: str, source: str) -> None:
        evidence.append({"claim": claim, "level": level, "source": source})

    exts: dict[str, int] = {}
    for p in paths:
        ext = os.path.splitext(p)[1].lower()
        if ext:
            exts[ext] = exts.get(ext, 0) + 1
    languages = sorted(exts.items(), key=lambda kv: -kv[1])[:8]

    if pkg := manifests.get("package.json"):
        try:
            data = json.loads(pkg)
            deps = sorted({*data.get("dependencies", {}), *data.get("devDependencies", {})})
            dependencies["npm"] = deps[:200]
            bins = data.get("bin")
            if isinstance(bins, str):
                entry_points.append({"type": "cli", "name": data.get("name", "bin"), "target": bins})
            elif isinstance(bins, dict):
                entry_points += [{"type": "cli", "name": k, "target": v} for k, v in bins.items()]
            if data.get("main"):
                entry_points.append({"type": "module", "name": "main", "target": data["main"]})
            for script in ("start", "dev", "test", "build"):
                if script in data.get("scripts", {}):
                    entry_points.append({"type": "npm-script", "name": script, "target": data["scripts"][script]})
            if any("modelcontextprotocol" in d for d in deps):
                add("depends on the Model Context Protocol SDK (likely exposes or consumes MCP tools)", "static", "package.json")
            if "electron" in deps:
                add("is an Electron application", "static", "package.json")
            if "playwright" in deps or "@playwright/test" in deps:
                add("uses Playwright", "static", "package.json")
        except json.JSONDecodeError:
            add("package.json is not valid JSON", "static", "package.json")
    if py := manifests.get("pyproject.toml"):
        try:
            data = tomllib.loads(py)
            project = data.get("project", {})
            dependencies["python"] = [str(d) for d in project.get("dependencies", [])][:200]
            for name, target in (project.get("scripts") or {}).items():
                entry_points.append({"type": "cli", "name": name, "target": target})
            if any(str(d).lower().startswith(("mcp", "fastmcp")) for d in project.get("dependencies", [])):
                add("depends on an MCP server library", "static", "pyproject.toml")
        except tomllib.TOMLDecodeError:
            add("pyproject.toml could not be parsed", "static", "pyproject.toml")
    if "requirements.txt" in manifests:
        dependencies["python"] = [l.strip() for l in manifests["requirements.txt"].splitlines() if l.strip() and not l.startswith("#")][:200]
    if "Dockerfile" in manifests:
        add("provides a Dockerfile", "static", "Dockerfile")
    skill_files = [p for p in paths if p.endswith("SKILL.md")]
    if skill_files:
        add(f"contains {len(skill_files)} SKILL.md skill definitions", "static", "tree")
    if any(p.startswith(("test/", "tests/")) or "/test" in p for p in paths):
        add("contains a test directory", "static", "tree")
    for line in readme.splitlines():
        line_s = line.strip()
        if re.match(r"^(npm|npx|pip|pipx|uv|cargo|go|brew)\s+(install|i|run|add)\b", line_s):
            add(f"README documents install command: {line_s[:160]}", "declared", "README")
    if readme:
        first_para = next((l.strip() for l in readme.splitlines() if l.strip() and not l.startswith(("#", "!", "[", "<"))), "")
        if first_para:
            add(f"README describes: {first_para[:240]}", "declared", "README")
    return {
        "file_count": len(paths),
        "languages": [{"ext": e, "files": n} for e, n in languages],
        "manifests": sorted(manifests),
        "entry_points": entry_points[:50],
        "dependencies": dependencies,
        "evidence": evidence,
        "skill_files": skill_files[:200],
        "readme_excerpt": readme[:3000],
        "verification_note": "Findings are static or declared. No repository code was executed.",
    }
