from __future__ import annotations

import os
import secrets
import sys
from dataclasses import dataclass, field
from pathlib import Path

APP_VERSION = "0.1.0"
API_PREFIX = "/api/v1"


def _default_data_dir() -> Path:
    if sys.platform == "win32":
        base = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming"))
        return base / "Veylora OS" / "runtime"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Veylora OS" / "runtime"
    return Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "veylora-os" / "runtime"


@dataclass
class Config:
    data_dir: Path
    host: str = "127.0.0.1"
    port: int = 47821
    session_token: str = field(default_factory=lambda: secrets.token_urlsafe(32))
    allowed_origins: tuple[str, ...] = ("veylora://app", "http://localhost:5173", "http://127.0.0.1:5173")
    ollama_url: str = "http://127.0.0.1:11434"
    node_executable: str | None = None
    node_is_electron: bool = False
    start_scheduler_recovery: bool = True

    @property
    def db_path(self) -> Path:
        return self.data_dir / "veylora.db"

    @property
    def projects_dir(self) -> Path:
        return self.data_dir / "projects"

    @property
    def cache_dir(self) -> Path:
        return self.data_dir / "cache"

    @classmethod
    def from_env(cls) -> "Config":
        data_dir = Path(os.environ.get("VEYLORA_DATA_DIR") or _default_data_dir())
        cfg = cls(data_dir=data_dir)
        cfg.port = int(os.environ.get("VEYLORA_PORT", cfg.port))
        if token := os.environ.get("VEYLORA_SESSION_TOKEN"):
            cfg.session_token = token
        if origins := os.environ.get("VEYLORA_ALLOWED_ORIGINS"):
            cfg.allowed_origins = tuple(o.strip() for o in origins.split(",") if o.strip())
        cfg.ollama_url = os.environ.get("VEYLORA_OLLAMA_URL", cfg.ollama_url)
        cfg.node_executable = os.environ.get("VEYLORA_NODE") or None
        cfg.node_is_electron = os.environ.get("VEYLORA_NODE_IS_ELECTRON") == "1"
        return cfg

    def ensure_dirs(self) -> None:
        for d in (self.data_dir, self.projects_dir, self.cache_dir):
            d.mkdir(parents=True, exist_ok=True)
