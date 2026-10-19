from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

router = APIRouter()

HEARTBEAT_S = 15


def _frame(event: dict) -> str:
    return f"id: {event['id']}\nevent: {event['type']}\ndata: {json.dumps(event, default=str)}\n\n"


@router.get("/events")
async def events(request: Request, project_id: str | None = None, after: int | None = None):
    """Server-sent events with replay. Resume with Last-Event-ID (or ?after=) to receive everything missed."""
    s = request.app.state.services
    header = request.headers.get("last-event-id")
    last = int(header) if header and header.isdigit() else (after if after is not None else s.bus.latest_id())

    async def stream():
        nonlocal last
        sub = s.bus.subscribe(project_id)
        try:
            yield "retry: 2000\n\n"
            while True:
                batch = s.bus.replay(project_id, last, 500)
                for ev in batch:
                    last = ev["id"]
                    yield _frame(ev)
                if len(batch) < 500:
                    break
            while True:
                if await request.is_disconnected():
                    return
                try:
                    ev = await asyncio.wait_for(sub.queue.get(), timeout=HEARTBEAT_S)
                except asyncio.TimeoutError:
                    yield ": heartbeat\n\n"
                    continue
                if ev["id"] <= last:
                    continue
                if sub.dropped:
                    for missed in s.bus.replay(project_id, last, 2000):
                        last = missed["id"]
                        yield _frame(missed)
                    sub.dropped = 0
                    continue
                last = ev["id"]
                yield _frame(ev)
        finally:
            s.bus.unsubscribe(sub)

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})


@router.get("/events/history")
async def history(request: Request, project_id: str | None = None, after: int = 0, limit: int = 500):
    return request.app.state.services.bus.replay(project_id, after, min(max(limit, 1), 2000))
