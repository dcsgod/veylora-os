from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

import psutil

from backend.config import Config
from backend.security.paths import is_within
from backend.security.redact import redact_text

_PASSTHROUGH_ENV = ("PATH", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "LANG", "TZ",
                    "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE")


class CommandRejected(ValueError):
    pass


@dataclass
class CommandResult:
    argv: list[str]
    exit_code: int | None
    stdout: str
    stderr: str
    duration_ms: int
    timed_out: bool = False
    cancelled: bool = False
    truncated: bool = False

    @property
    def ok(self) -> bool:
        return self.exit_code == 0 and not self.timed_out and not self.cancelled

    def excerpt(self, limit: int = 4000) -> str:
        text = (self.stdout + ("\n" + self.stderr if self.stderr else "")).strip()
        return text[-limit:]


@dataclass
class _Capture:
    limit: int
    chunks: list[bytes] = field(default_factory=list)
    size: int = 0
    truncated: bool = False

    def feed(self, data: bytes) -> None:
        if self.size >= self.limit:
            self.truncated = True
            return
        room = self.limit - self.size
        if len(data) > room:
            data, self.truncated = data[:room], True
        self.chunks.append(data)
        self.size += len(data)

    def text(self) -> str:
        return redact_text(b"".join(self.chunks).decode("utf-8", errors="replace"))


def kill_tree(pid: int) -> None:
    try:
        parent = psutil.Process(pid)
    except psutil.NoSuchProcess:
        return
    procs = parent.children(recursive=True) + [parent]
    for p in procs:
        try:
            p.kill()
        except psutil.NoSuchProcess:
            pass
    psutil.wait_procs(procs, timeout=5)


class ProcessRunner:
    """Runs allowlisted executables with explicit argument lists. Never invokes a shell."""

    def __init__(self, config: Config):
        self.config = config

    def resolve(self, name: str) -> str | None:
        if name == "node":
            return self.config.node_executable or shutil.which("node")
        if name == "git":
            return shutil.which("git")
        if name == "python":
            if getattr(sys, "frozen", False):
                return shutil.which("python3") or shutil.which("python")
            return sys.executable
        return None

    def available(self) -> dict[str, str | None]:
        return {n: self.resolve(n) for n in ("node", "git", "python")}

    def build_env(self, sandbox_home: Path | None, extra: dict[str, str] | None, executable: str) -> dict[str, str]:
        env = {k: os.environ[k] for k in _PASSTHROUGH_ENV if k in os.environ}
        if sandbox_home is not None:
            sandbox_home.mkdir(parents=True, exist_ok=True)
            env["HOME"] = str(sandbox_home)
            env["USERPROFILE"] = str(sandbox_home)
        if executable == "node" and self.config.node_is_electron and not os.environ.get("VEYLORA_FORCE_SYSTEM_NODE"):
            env["ELECTRON_RUN_AS_NODE"] = "1"
        env["NO_COLOR"] = "1"
        env["GIT_TERMINAL_PROMPT"] = "0"
        for k, v in (extra or {}).items():
            if not k.replace("_", "").isalnum():
                raise CommandRejected(f"invalid environment variable name {k!r}")
            env[k] = str(v)
        return env

    def _prepare(self, executable: str, args: list[str], cwd: Path, root: Path) -> list[str]:
        exe = self.resolve(executable)
        if exe is None:
            raise CommandRejected(f"executable {executable!r} is not available on this system")
        if not isinstance(args, list) or not all(isinstance(a, str) and "\x00" not in a for a in args):
            raise CommandRejected("arguments must be a list of strings")
        if not is_within(cwd, root):
            raise CommandRejected("working directory is outside the permitted root")
        return [exe, *args]

    async def run(
        self,
        executable: str,
        args: list[str],
        cwd: Path,
        root: Path,
        timeout_s: float = 120,
        max_output: int = 256_000,
        env_extra: dict[str, str] | None = None,
        sandbox_home: Path | None = None,
    ) -> CommandResult:
        argv = self._prepare(executable, args, cwd, root)
        env = self.build_env(sandbox_home, env_extra, executable)
        cancel = threading.Event()
        try:
            return await asyncio.to_thread(self._run_sync, argv, cwd, env, timeout_s, max_output, cancel)
        except asyncio.CancelledError:
            cancel.set()
            raise

    @staticmethod
    def _popen_kwargs() -> dict:
        if sys.platform == "win32":
            return {"creationflags": subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP}
        return {"start_new_session": True}

    def _run_sync(self, argv, cwd, env, timeout_s, max_output, cancel: threading.Event) -> CommandResult:
        start = time.monotonic()
        proc = subprocess.Popen(argv, cwd=str(cwd), env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, **self._popen_kwargs())
        out, err = _Capture(max_output), _Capture(max_output // 4)

        def pump(stream, cap: _Capture) -> None:
            for chunk in iter(lambda: stream.read(8192), b""):
                cap.feed(chunk)
            stream.close()

        readers = [threading.Thread(target=pump, args=(proc.stdout, out), daemon=True),
                   threading.Thread(target=pump, args=(proc.stderr, err), daemon=True)]
        for t in readers:
            t.start()
        timed_out = cancelled = False
        while proc.poll() is None:
            if cancel.is_set():
                cancelled = True
                break
            if time.monotonic() - start > timeout_s:
                timed_out = True
                break
            time.sleep(0.05)
        if timed_out or cancelled:
            kill_tree(proc.pid)
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            kill_tree(proc.pid)
        for t in readers:
            t.join(timeout=5)
        return CommandResult(
            argv=[Path(argv[0]).name, *argv[1:]],
            exit_code=proc.returncode,
            stdout=out.text(),
            stderr=err.text(),
            duration_ms=int((time.monotonic() - start) * 1000),
            timed_out=timed_out,
            cancelled=cancelled,
            truncated=out.truncated or err.truncated,
        )

    def start_background(self, executable: str, args: list[str], cwd: Path, root: Path, log_path: Path,
                         env_extra: dict[str, str] | None = None, sandbox_home: Path | None = None) -> subprocess.Popen:
        argv = self._prepare(executable, args, cwd, root)
        env = self.build_env(sandbox_home, env_extra, executable)
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log_file = open(log_path, "ab")
        try:
            return subprocess.Popen(argv, cwd=str(cwd), env=env, stdin=subprocess.DEVNULL, stdout=log_file,
                                    stderr=subprocess.STDOUT, **self._popen_kwargs())
        finally:
            log_file.close()
