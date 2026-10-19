from __future__ import annotations

from enum import StrEnum


class TaskStatus(StrEnum):
    PENDING = "pending"
    READY = "ready"
    RUNNING = "running"
    VERIFYING = "verifying"
    COMPLETED = "completed"
    BLOCKED = "blocked"
    FAILED = "failed"
    CANCELLED = "cancelled"
    WAITING_FOR_APPROVAL = "waiting_for_approval"


S = TaskStatus

TRANSITIONS: dict[TaskStatus, frozenset[TaskStatus]] = {
    S.PENDING: frozenset({S.READY, S.BLOCKED, S.CANCELLED}),
    S.READY: frozenset({S.RUNNING, S.PENDING, S.BLOCKED, S.CANCELLED}),
    S.RUNNING: frozenset({S.VERIFYING, S.READY, S.FAILED, S.CANCELLED, S.WAITING_FOR_APPROVAL}),
    S.WAITING_FOR_APPROVAL: frozenset({S.READY, S.FAILED, S.CANCELLED}),
    S.VERIFYING: frozenset({S.COMPLETED, S.FAILED, S.READY, S.CANCELLED}),
    S.FAILED: frozenset({S.READY, S.PENDING}),
    S.BLOCKED: frozenset({S.PENDING, S.READY, S.CANCELLED}),
    S.CANCELLED: frozenset({S.READY, S.PENDING}),
    S.COMPLETED: frozenset(),
}

TERMINAL = frozenset({S.COMPLETED, S.FAILED, S.CANCELLED})
ACTIVE = frozenset({S.RUNNING, S.VERIFYING})


class InvalidTransition(ValueError):
    pass


def can_transition(current: TaskStatus | str, target: TaskStatus | str) -> bool:
    return TaskStatus(target) in TRANSITIONS[TaskStatus(current)]


def assert_transition(current: TaskStatus | str, target: TaskStatus | str) -> None:
    if not can_transition(current, target):
        raise InvalidTransition(f"invalid task transition {current} -> {target}")


class ProjectStatus(StrEnum):
    DRAFT = "draft"
    PLANNED = "planned"
    RUNNING = "running"
    PAUSED = "paused"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
