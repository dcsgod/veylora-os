from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from .migrations import MIGRATIONS

JSON_COLUMNS = {
    "required_capabilities", "skills", "permissions", "inputs", "outputs", "acceptance", "params",
    "rationale", "result", "capabilities", "role_assignments", "metadata", "tags", "frontmatter",
    "resources", "scripts", "external_urls", "roles", "prerequisites", "validation", "manifest",
    "verification", "topics", "analysis", "targets", "report", "details", "payload", "content",
    "summary", "args", "value",
}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


def _decode_row(row: sqlite3.Row) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key in row.keys():
        val = row[key]
        if key in JSON_COLUMNS and isinstance(val, str):
            try:
                val = json.loads(val)
            except json.JSONDecodeError:
                pass
        out[key] = val
    return out


def encode(value: Any) -> Any:
    if isinstance(value, (dict, list, tuple)):
        return json.dumps(value, default=str)
    if isinstance(value, bool):
        return int(value)
    return value


class Database:
    """Thread-safe SQLite access. All writes go through one connection guarded by a re-entrant lock."""

    def __init__(self, path: Path | str):
        self.path = str(path)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(self.path, check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA foreign_keys = ON")
        if self.path != ":memory:":
            self._conn.execute("PRAGMA journal_mode = WAL")
        self._conn.execute("PRAGMA busy_timeout = 5000")
        self._tx_depth = 0

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    def migrate(self) -> list[int]:
        applied: list[int] = []
        with self._lock:
            self._conn.execute(
                "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)"
            )
            done = {r[0] for r in self._conn.execute("SELECT version FROM schema_migrations")}
            for version, name, sql in MIGRATIONS:
                if version in done:
                    continue
                self._conn.execute("BEGIN")
                try:
                    for statement in _split_sql(sql):
                        self._conn.execute(statement)
                    self._conn.execute(
                        "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)",
                        (version, name, now_iso()),
                    )
                    self._conn.execute("COMMIT")
                except Exception:
                    self._conn.execute("ROLLBACK")
                    raise
                applied.append(version)
        return applied

    def schema_version(self) -> int:
        row = self.one("SELECT MAX(version) AS v FROM schema_migrations")
        return int(row["v"] or 0) if row else 0

    @contextmanager
    def transaction(self) -> Iterator["Database"]:
        with self._lock:
            if self._tx_depth == 0:
                self._conn.execute("BEGIN IMMEDIATE")
            self._tx_depth += 1
            try:
                yield self
            except BaseException:
                self._tx_depth -= 1
                if self._tx_depth == 0:
                    self._conn.execute("ROLLBACK")
                raise
            else:
                self._tx_depth -= 1
                if self._tx_depth == 0:
                    self._conn.execute("COMMIT")

    def execute(self, sql: str, params: tuple | list = ()) -> sqlite3.Cursor:
        with self._lock:
            return self._conn.execute(sql, tuple(encode(p) for p in params))

    def all(self, sql: str, params: tuple | list = ()) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(sql, tuple(encode(p) for p in params)).fetchall()
        return [_decode_row(r) for r in rows]

    def one(self, sql: str, params: tuple | list = ()) -> dict[str, Any] | None:
        with self._lock:
            row = self._conn.execute(sql, tuple(encode(p) for p in params)).fetchone()
        return _decode_row(row) if row else None

    def insert(self, table: str, values: dict[str, Any]) -> None:
        cols = ", ".join(values.keys())
        marks = ", ".join("?" for _ in values)
        self.execute(f"INSERT INTO {table} ({cols}) VALUES ({marks})", list(values.values()))

    def update(self, table: str, row_id: str, values: dict[str, Any], id_col: str = "id") -> None:
        if not values:
            return
        sets = ", ".join(f"{k} = ?" for k in values)
        self.execute(f"UPDATE {table} SET {sets} WHERE {id_col} = ?", [*values.values(), row_id])

    # settings
    def get_setting(self, key: str, default: Any = None) -> Any:
        row = self.one("SELECT value FROM settings WHERE key = ?", (key,))
        return row["value"] if row else default

    def set_setting(self, key: str, value: Any) -> None:
        self.execute(
            "INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            (key, json.dumps(value), now_iso()),
        )


def _split_sql(sql: str) -> list[str]:
    statements, buf = [], []
    for line in sql.splitlines():
        buf.append(line)
        if line.rstrip().endswith(";"):
            stmt = "\n".join(buf).strip()
            if stmt:
                statements.append(stmt)
            buf = []
    tail = "\n".join(buf).strip()
    if tail:
        statements.append(tail)
    return statements
