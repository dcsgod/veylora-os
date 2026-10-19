from __future__ import annotations

import shutil
from dataclasses import dataclass
from pathlib import Path

from backend.execution.runner import CommandResult, ProcessRunner
from backend.security.paths import resolve_within

GIT_IDENTITY = ["-c", "user.name=Veylora Agent", "-c", "user.email=agent@veylora.local", "-c", "core.autocrlf=false",
                "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", "-c", "core.longpaths=true"]


class GitError(RuntimeError):
    def __init__(self, message: str, result: CommandResult | None = None):
        super().__init__(message)
        self.result = result


@dataclass
class ProjectWorkspace:
    """Per-project source workspace: a main repository plus isolated git worktrees per implementation task."""

    root: Path
    runner: ProcessRunner

    @property
    def repo(self) -> Path:
        return self.root / "repo"

    @property
    def worktrees(self) -> Path:
        return self.root / "worktrees"

    @property
    def sandbox_home(self) -> Path:
        return self.root / "sandbox-home"

    async def git(self, cwd: Path, *args: str, check: bool = True, timeout_s: float = 60) -> CommandResult:
        result = await self.runner.run("git", [*GIT_IDENTITY, *args], cwd=cwd, root=self.root, timeout_s=timeout_s,
                                       sandbox_home=self.sandbox_home)
        if check and not result.ok:
            raise GitError(f"git {' '.join(args[:3])} failed: {result.excerpt(1500)}", result)
        return result

    @property
    def git_available(self) -> bool:
        return self.runner.resolve("git") is not None

    async def init(self) -> None:
        self.repo.mkdir(parents=True, exist_ok=True)
        self.worktrees.mkdir(parents=True, exist_ok=True)
        if not self.git_available:
            return
        if not (self.repo / ".git").exists():
            await self.git(self.repo, "init", "-q", "-b", "main")
            (self.repo / ".gitignore").write_text("node_modules/\ndata/runtime/\n*.log\n", encoding="utf-8")
            await self.git(self.repo, "add", "-A")
            await self.git(self.repo, "commit", "-q", "-m", "chore: initialise project repository")

    async def create_worktree(self, key: str) -> Path:
        path = self.worktrees / key
        if path.exists():
            return path
        if not self.git_available:
            shutil.copytree(self.repo, path, ignore=shutil.ignore_patterns(".git", "node_modules"))
            return path
        branch = f"task/{key}"
        exists = await self.git(self.repo, "rev-parse", "--verify", "--quiet", branch, check=False)
        if exists.ok:
            await self.git(self.repo, "worktree", "add", "-q", str(path), branch)
        else:
            await self.git(self.repo, "worktree", "add", "-q", "-b", branch, str(path), "main")
        return path

    def write_file(self, base: Path, rel: str, content: str) -> Path:
        target = resolve_within(base, rel)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8", newline="\n")
        return target

    async def commit(self, cwd: Path, message: str) -> str | None:
        if not self.git_available:
            return None
        await self.git(cwd, "add", "-A")
        status = await self.git(cwd, "status", "--porcelain")
        if not status.stdout.strip():
            head = await self.git(cwd, "rev-parse", "HEAD")
            return head.stdout.strip()
        await self.git(cwd, "commit", "-q", "-m", message)
        head = await self.git(cwd, "rev-parse", "HEAD")
        return head.stdout.strip()

    async def merge(self, key: str, message: str) -> dict:
        path = self.worktrees / key
        if not self.git_available:
            shutil.copytree(path, self.repo, dirs_exist_ok=True)
            return {"merged": key, "method": "copy (git unavailable)"}
        branch = f"task/{key}"
        result = await self.git(self.repo, "merge", "--no-ff", "-m", message, branch, check=False)
        if not result.ok:
            await self.git(self.repo, "merge", "--abort", check=False)
            raise GitError(f"merge of {branch} failed: {result.excerpt(1500)}", result)
        head = await self.git(self.repo, "rev-parse", "HEAD")
        return {"merged": branch, "commit": head.stdout.strip()}

    async def remove_worktree(self, key: str) -> None:
        path = self.worktrees / key
        if not path.exists():
            return
        if self.git_available:
            await self.git(self.repo, "worktree", "remove", "--force", str(path), check=False)
        if path.exists():
            shutil.rmtree(path, ignore_errors=True)

    async def show(self, commit: str) -> str:
        if not self.git_available:
            return ""
        result = await self.git(self.repo, "show", "--stat", "--patch", "--no-color", commit, check=False, timeout_s=30)
        return result.stdout

    async def log(self, limit: int = 50) -> list[dict[str, str]]:
        if not self.git_available or not (self.repo / ".git").exists():
            return []
        result = await self.git(self.repo, "log", f"-{limit}", "--all", "--pretty=format:%H%x1f%an%x1f%aI%x1f%D%x1f%s", check=False)
        out = []
        for line in result.stdout.splitlines():
            parts = line.split("\x1f")
            if len(parts) == 5:
                out.append({"commit": parts[0], "author": parts[1], "date": parts[2], "refs": parts[3], "subject": parts[4]})
        return out
