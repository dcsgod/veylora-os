from __future__ import annotations

import asyncio
import socket
import subprocess
import time
from pathlib import Path
from typing import Any, Callable

import httpx

from backend.execution.runner import ProcessRunner, kill_tree
from backend.persistence.db import Database, new_id, now_iso
from backend.security.redact import redact_text


class PreviewError(RuntimeError):
    pass


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class PreviewManager:
    """Runs generated apps as local child processes bound to 127.0.0.1. One preview per project."""

    def __init__(self, db: Database, runner: ProcessRunner, publish: Callable[..., Any]):
        self.db = db
        self.runner = runner
        self.publish = publish
        self._procs: dict[str, subprocess.Popen] = {}
        self._logs: dict[str, Path] = {}

    def recover(self) -> None:
        self.db.execute("UPDATE previews SET status = 'stopped', stopped_at = ? WHERE status IN ('starting', 'running')", (now_iso(),))

    async def start(self, project_id: str, project_root: Path, repo: Path, start_args: list[str],
                    sandbox_home: Path | None = None, ready_timeout_s: float = 25) -> dict[str, Any]:
        await self.stop_project(project_id)
        port = free_port()
        preview_id = new_id("prv")
        log_path = project_root / "logs" / f"preview-{preview_id}.log"
        url = f"http://127.0.0.1:{port}"
        self.db.insert("previews", {"id": preview_id, "project_id": project_id, "url": url, "port": port, "status": "starting",
                                    "started_at": now_iso()})
        proc = self.runner.start_background("node", start_args, cwd=repo, root=project_root, log_path=log_path,
                                            env_extra={"PORT": str(port)}, sandbox_home=sandbox_home)
        self._procs[preview_id] = proc
        self._logs[preview_id] = log_path
        self.db.update("previews", preview_id, {"pid": proc.pid})
        deadline = time.monotonic() + ready_timeout_s
        async with httpx.AsyncClient(timeout=2.0, trust_env=False) as client:
            while time.monotonic() < deadline:
                if proc.poll() is not None:
                    tail = self.log_tail(preview_id)
                    self._finish(preview_id, "crashed")
                    raise PreviewError(f"preview process exited with code {proc.returncode}: {tail[-1500:]}")
                try:
                    r = await client.get(url + "/api/health")
                    if r.status_code < 500:
                        break
                except httpx.HTTPError:
                    pass
                await asyncio.sleep(0.3)
            else:
                await self.stop(preview_id)
                raise PreviewError(f"preview did not become ready within {ready_timeout_s}s")
        self.db.update("previews", preview_id, {"status": "running"})
        self.publish("preview.started", project_id=project_id, payload={"preview_id": preview_id, "url": url})
        return self.get(preview_id)  # type: ignore[return-value]

    def _finish(self, preview_id: str, status: str) -> None:
        self.db.update("previews", preview_id, {"status": status, "stopped_at": now_iso(), "log_tail": self.log_tail(preview_id)[-4000:]})
        self._procs.pop(preview_id, None)

    async def stop(self, preview_id: str) -> None:
        proc = self._procs.get(preview_id)
        if proc and proc.poll() is None:
            await asyncio.to_thread(kill_tree, proc.pid)
        row = self.get(preview_id)
        if row and row["status"] in ("starting", "running"):
            self._finish(preview_id, "stopped")
            self.publish("preview.stopped", project_id=row["project_id"], payload={"preview_id": preview_id})

    async def stop_project(self, project_id: str) -> None:
        for row in self.db.all("SELECT id FROM previews WHERE project_id = ? AND status IN ('starting', 'running')", (project_id,)):
            await self.stop(row["id"])

    def stop_all(self) -> None:
        for preview_id, proc in list(self._procs.items()):
            if proc.poll() is None:
                kill_tree(proc.pid)
            self._finish(preview_id, "stopped")

    def get(self, preview_id: str) -> dict[str, Any] | None:
        row = self.db.one("SELECT * FROM previews WHERE id = ?", (preview_id,))
        if row and row["status"] == "running":
            proc = self._procs.get(preview_id)
            if proc is None or proc.poll() is not None:
                self._finish(preview_id, "exited")
                row = self.db.one("SELECT * FROM previews WHERE id = ?", (preview_id,))
        return row

    def list(self, project_id: str) -> list[dict[str, Any]]:
        ids = [r["id"] for r in self.db.all("SELECT id FROM previews WHERE project_id = ? ORDER BY started_at DESC LIMIT 20", (project_id,))]
        return [r for r in (self.get(i) for i in ids) if r]

    def active(self, project_id: str) -> dict[str, Any] | None:
        return next((r for r in self.list(project_id) if r["status"] == "running"), None)

    def log_tail(self, preview_id: str, limit: int = 8000) -> str:
        path = self._logs.get(preview_id)
        if path and path.is_file():
            data = path.read_bytes()[-limit:]
            return redact_text(data.decode("utf-8", errors="replace"))
        row = self.db.one("SELECT log_tail FROM previews WHERE id = ?", (preview_id,))
        return row["log_tail"] if row else ""
