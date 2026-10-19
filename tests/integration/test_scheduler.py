from __future__ import annotations

import asyncio

from backend.agents.roles import Permission
from backend.agents.runtime import Outcome
from backend.orchestration.states import TaskStatus
from backend.security.policy import ActionRequest
from tests.conftest import attach_mock, by_key, feature_files, make_responder, wait_for_project

GENERIC = "Build a small notes app where people can write and list short notes"


async def test_generic_project_with_generated_features_completes(services):
    s = services
    await attach_mock(s, make_responder([feature_files()]))
    p = s.projects.create(GENERIC, domain="generic")
    s.scheduler.start(p["id"])
    done = await wait_for_project(s, p["id"])
    tasks = by_key(s, p["id"])
    assert done["status"] == "completed", {k: (t["status"], t["last_error"]) for k, t in tasks.items()}
    unit = s.db.one("SELECT * FROM test_results WHERE project_id = ? AND kind = 'unit'", (p["id"],))
    assert unit["status"] == "passed" and unit["passed"] == 5 and unit["failed"] == 0
    gen = s.db.one("SELECT * FROM agent_executions WHERE task_id = ?", (tasks["generate-feature"]["id"],))
    assert gen["model"] == "mock/mock-coder" or gen["model"].startswith("mock/")
    assert gen["input_tokens"] is None, "mock provider reports no token counts, so none may be recorded"


async def test_failing_generated_tests_trigger_bounded_repair(services):
    s = services
    responder = make_responder([feature_files(expected_count=99), feature_files()])
    await attach_mock(s, responder)
    p = s.projects.create(GENERIC, domain="generic")
    s.scheduler.start(p["id"])
    done = await wait_for_project(s, p["id"])
    tasks = by_key(s, p["id"])
    assert "repair-1" in tasks and "test-2" in tasks
    assert tasks["test"]["status"] == TaskStatus.FAILED and tasks["test"]["superseded_by"] == tasks["test-2"]["id"]
    assert tasks["test-2"]["status"] == TaskStatus.COMPLETED
    assert tasks["test-2"]["id"] in tasks["verify"]["depends_on"]
    assert done["status"] == "completed", {k: (t["status"], t["last_error"]) for k, t in tasks.items()}


async def test_repair_is_bounded(services):
    s = services
    await attach_mock(s, make_responder([feature_files(expected_count=99)]))
    p = s.projects.create(GENERIC, domain="generic")
    s.scheduler.start(p["id"])
    done = await wait_for_project(s, p["id"])
    tasks = by_key(s, p["id"])
    assert done["status"] == "failed"
    assert {"repair-1", "repair-2", "test-3"} <= set(tasks) and "repair-3" not in tasks
    assert tasks["test-3"]["status"] == TaskStatus.FAILED
    assert tasks["verify"]["status"] == TaskStatus.BLOCKED


async def test_no_model_fails_honestly_and_blocks_downstream(services):
    s = services
    p = s.projects.create(GENERIC, domain="generic")
    s.scheduler.start(p["id"])
    done = await wait_for_project(s, p["id"])
    tasks = by_key(s, p["id"])
    assert done["status"] == "failed"
    assert tasks["generate-feature"]["status"] == TaskStatus.FAILED
    assert "no model available" in tasks["generate-feature"]["last_error"]
    assert tasks["integrate"]["status"] == TaskStatus.BLOCKED
    assert s.db.one("SELECT COUNT(*) AS n FROM test_results WHERE project_id = ?", (p["id"],))["n"] == 0


def _approval_executor(calls):
    async def ex(ctx):
        calls.append(ctx.attempt)
        ctx.s.policy.authorize(ActionRequest(role="repo_discovery", permission=Permission.FS_READ_EXTERNAL,
                                             action="read external folder", targets=["D:/external"], reason="test",
                                             project_id=ctx.project["id"], task_id=ctx.task["id"]))
        return Outcome("read", "passed")
    return ex


async def _single_task_project(s, executor):
    p = s.projects.create("Build a supply chain planner with inventory and replenishment")
    first = by_key(s, p["id"])["spec"]
    s.runtime.executors["specification"] = executor
    return p, first


async def test_approval_gate_blocks_until_approved(services):
    s = services
    calls: list[int] = []
    p, spec_task = await _single_task_project(s, _approval_executor(calls))
    s.scheduler.start(p["id"])
    await wait_for_project(s, p["id"], 30)
    t = s.projects.task(spec_task["id"])
    assert t["status"] == TaskStatus.WAITING_FOR_APPROVAL
    approval = s.db.one("SELECT * FROM approval_requests WHERE task_id = ?", (t["id"],))
    assert approval["status"] == "pending" and approval["permission"] == "fs.read.external"
    assert by_key(s, p["id"])["discover"]["status"] == TaskStatus.PENDING
    s.runtime.executors["discovery"] = lambda ctx: _done()
    s.scheduler.on_approval(s.policy.decide(approval["id"], True))
    for _ in range(100):
        await asyncio.sleep(0.05)
        if s.projects.task(t["id"])["status"] == TaskStatus.COMPLETED:
            break
    assert s.projects.task(t["id"])["status"] == TaskStatus.COMPLETED
    assert s.db.one("SELECT consumed FROM approval_requests WHERE id = ?", (approval["id"],))["consumed"] == 1
    await s.scheduler.cancel(p["id"])


async def _done():
    return Outcome("ok", "passed")


async def test_denied_approval_fails_task_and_blocks_dependents(services):
    s = services
    p, spec_task = await _single_task_project(s, _approval_executor([]))
    s.scheduler.start(p["id"])
    await wait_for_project(s, p["id"], 30)
    approval = s.db.one("SELECT * FROM approval_requests WHERE task_id = ?", (spec_task["id"],))
    s.scheduler.on_approval(s.policy.decide(approval["id"], False))
    done = await wait_for_project(s, p["id"], 30)
    tasks = by_key(s, p["id"])
    assert tasks["spec"]["status"] == TaskStatus.FAILED and "denied" in tasks["spec"]["last_error"]
    assert tasks["discover"]["status"] == TaskStatus.BLOCKED
    assert done["status"] == "failed"


async def test_cancel_and_retry(services):
    s = services
    started = asyncio.Event()

    async def slow(ctx):
        started.set()
        await asyncio.sleep(30)
        return Outcome("never", "passed")

    p, spec_task = await _single_task_project(s, slow)
    s.scheduler.start(p["id"])
    await asyncio.wait_for(started.wait(), 10)
    await s.scheduler.cancel(p["id"])
    assert s.projects.task(spec_task["id"])["status"] == TaskStatus.CANCELLED
    assert s.projects.get(p["id"])["status"] == "cancelled"
    assert all(t["status"] == TaskStatus.CANCELLED for t in s.projects.tasks(p["id"]))


async def test_retry_failed_task_resets_downstream(services):
    s = services
    attempts = {"n": 0}

    async def flaky(ctx):
        from backend.agents.runtime import TaskFailure
        attempts["n"] += 1
        raise TaskFailure("deliberate failure")

    p, spec_task = await _single_task_project(s, flaky)
    s.db.update("tasks", spec_task["id"], {"max_retries": 0})
    s.scheduler.start(p["id"])
    done = await wait_for_project(s, p["id"], 30)
    assert done["status"] == "failed" and attempts["n"] == 1
    assert by_key(s, p["id"])["discover"]["status"] == TaskStatus.BLOCKED
    s.runtime.executors["specification"] = lambda ctx: _done()
    s.runtime.executors["discovery"] = lambda ctx: _sleep_forever()
    s.scheduler.retry_task(spec_task["id"])
    for _ in range(100):
        await asyncio.sleep(0.05)
        if by_key(s, p["id"])["discover"]["status"] == TaskStatus.RUNNING:
            break
    assert s.projects.task(spec_task["id"])["status"] == TaskStatus.COMPLETED
    assert by_key(s, p["id"])["discover"]["status"] == TaskStatus.RUNNING
    await s.scheduler.cancel(p["id"])


async def _sleep_forever():
    await asyncio.sleep(60)
    return Outcome("never", "passed")


async def test_recover_requeues_interrupted_work(services):
    s = services
    p = s.projects.create("Build a supply chain planner with inventory and replenishment")
    t = by_key(s, p["id"])["spec"]
    s.db.update("tasks", t["id"], {"status": TaskStatus.RUNNING})
    s.db.update("projects", p["id"], {"status": "running"})
    report = s.scheduler.recover()
    assert report == {"requeued_tasks": 1, "paused_projects": 1}
    assert s.projects.task(t["id"])["status"] == TaskStatus.READY
    assert s.projects.get(p["id"])["status"] == "paused"


async def test_undeclared_permission_is_denied(services):
    s = services

    async def sneaky(ctx):
        ctx.authorize(Permission.NET_EGRESS, "exfiltrate", ["https://example.com"], "not declared")
        return Outcome("should not happen")

    p, spec_task = await _single_task_project(s, sneaky)
    s.db.update("tasks", spec_task["id"], {"max_retries": 0})
    s.scheduler.start(p["id"])
    await wait_for_project(s, p["id"], 30)
    t = s.projects.task(spec_task["id"])
    assert t["status"] == TaskStatus.FAILED and "not declared" in t["last_error"]
    audit = s.db.one("SELECT * FROM audit_events WHERE decision = 'denied' AND project_id = ?", (p["id"],))
    assert audit is not None
