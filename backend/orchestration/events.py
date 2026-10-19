from __future__ import annotations

import asyncio
import logging
import threading
from dataclasses import dataclass, field
from typing import Any

from backend.persistence.db import Database, now_iso
from backend.security.redact import redact_value

log = logging.getLogger("veylora.events")


@dataclass
class Subscription:
    project_id: str | None
    queue: asyncio.Queue
    loop: asyncio.AbstractEventLoop
    dropped: int = 0


class EventBus:
    """Persist-then-publish event bus. Every event gets a monotonically increasing id usable for replay."""

    def __init__(self, db: Database, queue_size: int = 1000):
        self.db = db
        self.queue_size = queue_size
        self._subs: list[Subscription] = []
        self._lock = threading.Lock()

    def publish(
        self,
        type: str,
        project_id: str | None = None,
        task_id: str | None = None,
        payload: dict[str, Any] | None = None,
        correlation_id: str | None = None,
    ) -> dict[str, Any]:
        safe_payload = redact_value(payload or {})
        ts = now_iso()
        cur = self.db.execute(
            "INSERT INTO events(ts, project_id, task_id, type, correlation_id, payload) VALUES (?, ?, ?, ?, ?, ?)",
            (ts, project_id, task_id, type, correlation_id, safe_payload),
        )
        event = {
            "id": cur.lastrowid,
            "ts": ts,
            "project_id": project_id,
            "task_id": task_id,
            "type": type,
            "correlation_id": correlation_id,
            "payload": safe_payload,
        }
        log.info("event %s project=%s task=%s", type, project_id, task_id)
        with self._lock:
            subs = list(self._subs)
        for sub in subs:
            if sub.project_id is not None and sub.project_id != project_id:
                continue
            sub.loop.call_soon_threadsafe(self._offer, sub, event)
        return event

    @staticmethod
    def _offer(sub: Subscription, event: dict[str, Any]) -> None:
        try:
            sub.queue.put_nowait(event)
        except asyncio.QueueFull:
            sub.dropped += 1

    def subscribe(self, project_id: str | None) -> Subscription:
        sub = Subscription(project_id, asyncio.Queue(self.queue_size), asyncio.get_running_loop())
        with self._lock:
            self._subs.append(sub)
        return sub

    def unsubscribe(self, sub: Subscription) -> None:
        with self._lock:
            if sub in self._subs:
                self._subs.remove(sub)

    def replay(self, project_id: str | None, after_id: int, limit: int = 2000) -> list[dict[str, Any]]:
        if project_id:
            return self.db.all(
                "SELECT * FROM events WHERE project_id = ? AND id > ? ORDER BY id LIMIT ?",
                (project_id, after_id, limit),
            )
        return self.db.all("SELECT * FROM events WHERE id > ? ORDER BY id LIMIT ?", (after_id, limit))

    def latest_id(self) -> int:
        row = self.db.one("SELECT MAX(id) AS m FROM events")
        return int(row["m"] or 0) if row else 0
