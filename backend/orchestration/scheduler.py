from __future__ import annotations

import asyncio
import logging
import traceback
from typing import TYPE_CHECKING, Any

from backend.agents.runtime import AgentContext, TaskFailure
from backend.orchestration.dag import descendants
from backend.orchestration.states import ProjectStatus, TaskStatus, assert_transition
from backend.persistence.db import new_id, now_iso
from backend.security.policy import ApprovalRequired, PermissionDenied

if TYPE_CHECKING:
    from backend.services import Services

log = logging.getLogger("veylora.scheduler")
S = TaskStatus


class SchedulerError(RuntimeError):
    pass


class Scheduler:
    """Durable DAG scheduler. All state lives in SQLite; in-memory structures only track live asyncio tasks."""

    def __init__(self, services: "Services"):
        self.s = services
        self.max_parallel = int(services.db.get_setting("scheduler.max_parallel", 3))
        self._sem = asyncio.Semaphore(self.max_parallel)
        self._loops: dict[str, asyncio.Task] = {}
        self._running: dict[str, asyncio.Task] = {}
        self._task_project: dict[str, str] = {}
        self._wake: dict[str, asyncio.Event] = {}
        self._pausing: set[str] = set()
        self._cancelling: set[str] = set()
        self._shutting_down = False

    # ------------------------------------------------------------ state helpers

    def _set(self, task: dict[str, Any], target: TaskStatus, **values: Any) -> dict[str, Any]:
        assert_transition(task["status"], target)
        self.s.db.update("tasks", task["id"], {"status": target, "updated_at": now_iso(), **values})
        self.s.bus.publish("task.status", project_id=task["project_id"], task_id=task["id"], payload={
            "key": task["key"], "title": task["title"], "status": str(target), "previous": task["status"],
            "error": values.get("last_error"), "attempts": values.get("attempts", task["attempts"])})
        task = {**task, **values, "status": target}
        return task

    def _active_tasks(self, project_id: str) -> list[dict[str, Any]]:
        return [t for t in self.s.projects.tasks(project_id) if not t["superseded_by"]]

    def _wake_project(self, project_id: str) -> None:
        if ev := self._wake.get(project_id):
            ev.set()

    def is_running(self, project_id: str) -> bool:
        loop = self._loops.get(project_id)
        return bool(loop and not loop.done())

    # ------------------------------------------------------------ lifecycle

    def recover(self) -> dict[str, int]:
        """Called at startup: anything that was mid-flight when the process died is re-queued, never assumed done."""
        db = self.s.db
        requeued = 0
        for t in db.all("SELECT * FROM tasks WHERE status IN (?, ?)", (S.RUNNING, S.VERIFYING)):
            db.update("tasks", t["id"], {"status": S.READY, "last_error": "interrupted by shutdown; re-queued",
                                         "updated_at": now_iso()})
            requeued += 1
        db.execute("UPDATE agent_executions SET status = 'interrupted', finished_at = ? WHERE status = 'running'", (now_iso(),))
        paused = 0
        for p in db.all("SELECT id FROM projects WHERE status = ?", (ProjectStatus.RUNNING,)):
            self.s.projects.set_status(p["id"], ProjectStatus.PAUSED)
            paused += 1
        self.s.previews.recover()
        return {"requeued_tasks": requeued, "paused_projects": paused}

    def start(self, project_id: str) -> dict[str, Any]:
        project = self.s.projects.get(project_id)
        if not project:
            raise KeyError(project_id)
        if project["status"] in (ProjectStatus.COMPLETED, ProjectStatus.CANCELLED):
            raise SchedulerError(f"project is {project['status']}")
        self._pausing.discard(project_id)
        if project["status"] != ProjectStatus.RUNNING:
            self.s.projects.set_status(project_id, ProjectStatus.RUNNING)
        if not self.is_running(project_id):
            self._wake[project_id] = asyncio.Event()
            self._loops[project_id] = asyncio.create_task(self._project_loop(project_id), name=f"project:{project_id}")
        else:
            self._wake_project(project_id)
        return self.s.projects.get(project_id)  # type: ignore[return-value]

    def pause(self, project_id: str) -> dict[str, Any]:
        """Stops dispatching new tasks. Tasks already running finish and are recorded normally."""
        project = self.s.projects.get(project_id)
        if not project:
            raise KeyError(project_id)
        if self.is_running(project_id):
            self._pausing.add(project_id)
            self._wake_project(project_id)
        elif project["status"] == ProjectStatus.RUNNING:
            self.s.projects.set_status(project_id, ProjectStatus.PAUSED)
        return self.s.projects.get(project_id)  # type: ignore[return-value]

    async def cancel(self, project_id: str) -> dict[str, Any]:
        if not self.s.projects.get(project_id):
            raise KeyError(project_id)
        self._cancelling.add(project_id)
        try:
            live = [t for tid, t in self._running.items() if self._task_project.get(tid) == project_id]
            for t in live:
                t.cancel()
            if live:
                await asyncio.gather(*live, return_exceptions=True)
            loop = self._loops.get(project_id)
            if loop and not loop.done():
                loop.cancel()
                await asyncio.gather(loop, return_exceptions=True)
            for t in self._active_tasks(project_id):
                if t["status"] in (S.PENDING, S.READY, S.BLOCKED, S.WAITING_FOR_APPROVAL):
                    self._set(t, S.CANCELLED, finished_at=now_iso())
            await self.s.previews.stop_project(project_id)
            self.s.projects.set_status(project_id, ProjectStatus.CANCELLED)
        finally:
            self._cancelling.discard(project_id)
        return self.s.projects.get(project_id)  # type: ignore[return-value]

    def retry_task(self, task_id: str) -> dict[str, Any]:
        task = self.s.projects.task(task_id)
        if not task:
            raise KeyError(task_id)
        if task["superseded_by"]:
            raise SchedulerError("task was superseded by a later plan revision")
        if task["status"] not in (S.FAILED, S.CANCELLED, S.BLOCKED):
            raise SchedulerError(f"only failed, cancelled or blocked tasks can be retried (task is {task['status']})")
        project_id = task["project_id"]
        tasks = self._active_tasks(project_id)
        dependents: dict[str, list[str]] = {}
        for t in tasks:
            for d in t["depends_on"]:
                dependents.setdefault(d, []).append(t["id"])
        by_id = {t["id"]: t for t in tasks}
        target = S.PENDING if task["status"] == S.BLOCKED else S.READY
        self._set(task, target, attempts=0, last_error=None, finished_at=None)
        for d in descendants(task_id, dependents):
            dt = by_id.get(d)
            if dt and dt["status"] in (S.BLOCKED, S.CANCELLED):
                self._set(dt, S.PENDING, last_error=None)
        self.s.policy.audit("user", "task.retry", task["key"], "requested", project_id=project_id)
        project = self.s.projects.get(project_id)
        if project and project["status"] != ProjectStatus.CANCELLED:
            if project["status"] in (ProjectStatus.FAILED, ProjectStatus.COMPLETED):
                self.s.projects.set_status(project_id, ProjectStatus.PAUSED)
            self.start(project_id)
        return self.s.projects.task(task_id)  # type: ignore[return-value]

    def on_approval(self, approval: dict[str, Any]) -> None:
        task_id = approval.get("task_id")
        if not task_id:
            return
        task = self.s.projects.task(task_id)
        if not task or task["status"] != S.WAITING_FOR_APPROVAL:
            return
        if approval["status"] == "approved":
            self._set(task, S.READY, last_error=None)
        else:
            self._set(task, S.FAILED, last_error=f"approval {approval['id']} denied by user", finished_at=now_iso())
        project = self.s.projects.get(task["project_id"])
        if project and project["status"] == ProjectStatus.RUNNING:
            self.start(task["project_id"])

    async def shutdown(self) -> None:
        self._shutting_down = True
        live = [*self._running.values(), *self._loops.values()]
        for t in live:
            t.cancel()
        if live:
            await asyncio.gather(*live, return_exceptions=True)

    # ------------------------------------------------------------ loop

    def _promote(self, project_id: str) -> None:
        tasks = self._active_tasks(project_id)
        by_id = {t["id"]: t for t in tasks}
        all_rows = {t["id"]: t for t in self.s.projects.tasks(project_id)}
        for t in tasks:
            if t["status"] != S.PENDING:
                continue
            deps = [by_id.get(d) or all_rows.get(d) for d in t["depends_on"]]
            bad = [d for d in deps if d and d["status"] in (S.FAILED, S.CANCELLED, S.BLOCKED)]
            if bad:
                self._set(t, S.BLOCKED, last_error=f"dependency {bad[0]['key']} is {bad[0]['status']}")
            elif all(d and d["status"] == S.COMPLETED for d in deps):
                self._set(t, S.READY)

    async def _project_loop(self, project_id: str) -> None:
        wake = self._wake[project_id]
        try:
            while True:
                wake.clear()
                pausing = project_id in self._pausing
                if not pausing:
                    self._promote(project_id)
                tasks = self._active_tasks(project_id)
                live = {tid for tid, pid in self._task_project.items() if pid == project_id and tid in self._running}
                if not pausing:
                    ready = sorted((t for t in tasks if t["status"] == S.READY and t["id"] not in live),
                                   key=lambda t: (t["position_x"] or 0, t["position_y"] or 0))
                    for t in ready:
                        self._task_project[t["id"]] = project_id
                        self._running[t["id"]] = asyncio.create_task(self._run_task(t["id"]), name=f"task:{t['key']}")
                        live.add(t["id"])
                if not live:
                    self._finish(project_id, tasks, pausing)
                    return
                await wake.wait()
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("project loop crashed for %s", project_id)
            self.s.bus.publish("scheduler.error", project_id=project_id, payload={"error": traceback.format_exc()[-2000:]})
            self.s.projects.set_status(project_id, ProjectStatus.PAUSED)
        finally:
            self._pausing.discard(project_id)

    def _finish(self, project_id: str, tasks: list[dict[str, Any]], pausing: bool) -> None:
        statuses = [t["status"] for t in tasks]
        if pausing:
            self.s.projects.set_status(project_id, ProjectStatus.PAUSED)
        elif all(st == S.COMPLETED for st in statuses):
            self.s.projects.set_status(project_id, ProjectStatus.COMPLETED)
        elif any(st == S.WAITING_FOR_APPROVAL for st in statuses) and not any(st == S.FAILED for st in statuses):
            self.s.bus.publish("project.waiting", project_id=project_id,
                               payload={"waiting": [t["key"] for t in tasks if t["status"] == S.WAITING_FOR_APPROVAL]})
        else:
            self.s.projects.set_status(project_id, ProjectStatus.FAILED)

    # ------------------------------------------------------------ task execution

    async def _run_task(self, task_id: str) -> None:
        project_id = self._task_project.get(task_id, "")
        try:
            async with self._sem:
                await self._execute(task_id)
        except asyncio.CancelledError:
            pass
        finally:
            self._running.pop(task_id, None)
            self._task_project.pop(task_id, None)
            self._wake_project(project_id)

    async def _execute(self, task_id: str) -> None:
        task = self.s.projects.task(task_id)
        if not task or task["status"] != S.READY or task["project_id"] in self._pausing:
            return
        project = self.s.projects.get(task["project_id"])
        attempt = int(task["attempts"]) + 1
        task = self._set(task, S.RUNNING, attempts=attempt, started_at=now_iso(), last_error=None)
        exec_id = new_id("exe")
        correlation_id = new_id("cor")
        self.s.db.insert("agent_executions", {
            "id": exec_id, "project_id": task["project_id"], "task_id": task_id, "role": task["role"], "attempt": attempt,
            "status": "running", "permissions": task["permissions"], "correlation_id": correlation_id, "started_at": now_iso()})
        self.s.bus.publish("agent.started", project_id=task["project_id"], task_id=task_id, correlation_id=correlation_id,
                           payload={"execution_id": exec_id, "role": task["role"], "attempt": attempt, "key": task["key"]})
        ctx = AgentContext(self.s.runtime, project, task, exec_id, attempt, correlation_id)  # type: ignore[arg-type]
        try:
            outcome = await asyncio.wait_for(self.s.runtime.execute(ctx), timeout=task["timeout_s"])
        except asyncio.CancelledError:
            interrupted = self._shutting_down
            self._end_exec(exec_id, "interrupted" if interrupted else "cancelled", None)
            current = self.s.projects.task(task_id)
            if current and current["status"] in (S.RUNNING, S.VERIFYING):
                if interrupted:
                    self._set(current, S.READY, attempts=attempt - 1, last_error="interrupted by shutdown; re-queued")
                else:
                    self._set(current, S.CANCELLED, last_error="cancelled by user", finished_at=now_iso())
            raise
        except ApprovalRequired as exc:
            self._end_exec(exec_id, "waiting_for_approval", str(exc))
            self._set(task, S.WAITING_FOR_APPROVAL, attempts=attempt - 1, last_error=str(exc),
                      result={"approval_id": exc.approval_id})
            return
        except asyncio.TimeoutError:
            self._fail(task, exec_id, f"timed out after {task['timeout_s']}s", {}, retryable=True)
            return
        except PermissionDenied as exc:
            self._fail(task, exec_id, str(exc), {}, retryable=False)
            return
        except TaskFailure as exc:
            self._fail(task, exec_id, str(exc), exc.result, retryable=True)
            return
        except Exception as exc:  # executor bug or unexpected environment failure: record it, never hide it
            log.exception("task %s crashed", task["key"])
            self._fail(task, exec_id, f"{type(exc).__name__}: {exc}", {"traceback": traceback.format_exc()[-4000:]},
                       retryable=True)
            return
        task = self._set(task, S.VERIFYING, verification_status=outcome.verification)
        self._set(task, S.COMPLETED, result={"summary": outcome.summary, **outcome.result}, finished_at=now_iso())
        self._end_exec(exec_id, "completed", None)
        self._record_skills(task, "success")
        self.s.bus.publish("agent.finished", project_id=task["project_id"], task_id=task_id, correlation_id=correlation_id,
                           payload={"execution_id": exec_id, "summary": outcome.summary, "verification": outcome.verification})

    def _end_exec(self, exec_id: str, status: str, error: str | None) -> None:
        self.s.db.update("agent_executions", exec_id, {"status": status, "error": error, "finished_at": now_iso()})

    def _record_skills(self, task: dict[str, Any], outcome: str) -> None:
        for sk in self.s.projects.task(task["id"]).get("skills") or []:  # type: ignore[union-attr]
            if isinstance(sk, dict) and sk.get("id"):
                self.s.skills.record_usage(sk["id"], task["id"], outcome)

    def _fail(self, task: dict[str, Any], exec_id: str, message: str, result: dict[str, Any], *, retryable: bool) -> None:
        self._end_exec(exec_id, "failed", message[:2000])
        self.s.bus.publish("agent.failed", project_id=task["project_id"], task_id=task["id"],
                           payload={"execution_id": exec_id, "error": message[:2000]})
        if retryable and task["attempts"] <= task["max_retries"] and task["project_id"] not in self._cancelling:
            self._set(task, S.READY, last_error=message[:4000], result=result)
            return
        task = self._set(task, S.FAILED, last_error=message[:4000], result=result, finished_at=now_iso())
        self._record_skills(task, "failure")
        self._maybe_repair(task)

    def _maybe_repair(self, failed: dict[str, Any]) -> None:
        project = self.s.projects.get(failed["project_id"])
        fresh = self.s.projects.task(failed["id"])
        if not project or not fresh:
            return
        specs = self.s.runtime.plan_repair(project, fresh)
        if not specs:
            return
        max_y = max((t["position_y"] or 0) for t in self.s.projects.tasks(project["id"]))
        ids = self.s.projects.add_tasks(project["id"], specs, reason=f"bounded repair after {failed['key']} failed",
                                        parent={s.key: failed["id"] for s in specs},
                                        offset=((fresh["position_x"] or 0) - 280, max_y + 120))
        new_test = ids[specs[-1].key]
        with self.s.db.transaction():
            self.s.db.execute("UPDATE task_dependencies SET depends_on_id = ? WHERE depends_on_id = ? AND task_id NOT IN (?, ?)",
                              (new_test, failed["id"], ids[specs[0].key], new_test))
            self.s.db.update("tasks", failed["id"], {"superseded_by": new_test, "updated_at": now_iso()})
        self.s.bus.publish("task.superseded", project_id=project["id"], task_id=failed["id"],
                           payload={"key": failed["key"], "superseded_by": new_test})
