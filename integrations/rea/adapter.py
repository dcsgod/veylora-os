from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any

from backend.execution.runner import ProcessRunner
from backend.persistence.db import Database

REPO_URL = "https://github.com/morluto/rea"


class ReaAdapter:
    """Optional REA integration. Interfaces are discovered from the installed tool, never assumed.

    Invocation requires an explicit argument template configured by the user after reviewing `rea --help`,
    and every invocation passes through the `rea.inspect` approval gate.
    """

    def __init__(self, db: Database, runner: ProcessRunner):
        self.db = db
        self.runner = runner

    def executable(self) -> str | None:
        configured = self.db.get_setting("rea.executable")
        if configured and Path(configured).is_file():
            return configured
        return shutil.which("rea")

    async def status(self) -> dict[str, Any]:
        exe = self.executable()
        if not exe:
            return {"installed": False, "detail": "REA executable not found. Install it from the upstream repository and set its path in Settings.",
                    "repository": REPO_URL, "interfaces": []}
        version = await self._probe(exe, ["--version"])
        help_text = await self._probe(exe, ["--help"])
        interfaces = ["cli"]
        if help_text and "mcp" in help_text.lower():
            interfaces.append("mcp (mentioned in --help)")
        return {"installed": True, "path": exe, "version": (version or "").strip()[:200] or None,
                "help_excerpt": (help_text or "")[:4000], "interfaces": interfaces, "repository": REPO_URL,
                "inspect_template": self.db.get_setting("rea.inspect_args"),
                "detail": "discovered from installed executable"}

    async def _probe(self, exe: str, args: list[str]) -> str | None:
        import asyncio
        import subprocess

        env = self.runner.build_env(None, None, "rea")

        def run() -> str | None:
            try:
                p = subprocess.run([exe, *args], capture_output=True, timeout=15, stdin=subprocess.DEVNULL, env=env)
                return (p.stdout or p.stderr).decode("utf-8", errors="replace")
            except (OSError, subprocess.TimeoutExpired):
                return None

        return await asyncio.to_thread(run)

    def build_args(self, target: str) -> list[str]:
        template = self.db.get_setting("rea.inspect_args")
        if not template or not isinstance(template, list):
            raise RuntimeError("REA inspection arguments are not configured. Review `rea --help` and set rea.inspect_args in Settings.")
        return [str(a).replace("{target}", target) for a in template]

    async def inspect(self, target: str, cwd: Path, sandbox_home: Path, timeout_s: float = 600) -> dict[str, Any]:
        """Run REA with the user-configured argv template. Callers must have passed the rea.inspect approval gate."""
        import asyncio
        import subprocess
        import time

        exe = self.executable()
        if not exe:
            raise RuntimeError("REA executable not found")
        args = self.build_args(target)
        env = self.runner.build_env(sandbox_home, None, "rea")
        start = time.monotonic()

        def run() -> subprocess.CompletedProcess:
            return subprocess.run([exe, *args], cwd=str(cwd), capture_output=True, timeout=timeout_s, stdin=subprocess.DEVNULL,
                                  env=env, **self.runner._popen_kwargs())

        try:
            p = await asyncio.to_thread(run)
        except subprocess.TimeoutExpired:
            return {"argv": [Path(exe).name, *args], "exit_code": None, "timed_out": True, "output": "",
                    "duration_ms": int((time.monotonic() - start) * 1000)}
        from backend.security.redact import redact_text
        output = redact_text(((p.stdout or b"") + b"\n" + (p.stderr or b"")).decode("utf-8", errors="replace"))
        return {"argv": [Path(exe).name, *args], "exit_code": p.returncode, "timed_out": False, "output": output[-200_000:],
                "duration_ms": int((time.monotonic() - start) * 1000)}
