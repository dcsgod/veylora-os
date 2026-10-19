from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any, Callable
from urllib.parse import urlparse

from backend.agents.roles import ALWAYS_APPROVE, Grant, Permission, get_role
from backend.persistence.db import Database, new_id, now_iso
from backend.security.redact import redact_value

DEFAULT_NET_ALLOWLIST = ["api.github.com", "codeload.github.com", "raw.githubusercontent.com", "127.0.0.1", "localhost"]
EXECUTABLE_ALLOWLIST = frozenset({"node", "git", "python"})

RISK = {
    Permission.FS_READ: "low",
    Permission.FS_WRITE: "low",
    Permission.GIT: "low",
    Permission.MODEL_LOCAL: "low",
    Permission.PREVIEW: "medium",
    Permission.PROCESS_EXEC: "medium",
    Permission.NET_EGRESS: "medium",
    Permission.MODEL_HOSTED: "high",
    Permission.FS_READ_EXTERNAL: "high",
    Permission.DEPENDENCY_INSTALL: "high",
    Permission.REA_INSPECT: "high",
    Permission.PUBLISH: "critical",
}


class Decision(StrEnum):
    ALLOW = "allow"
    REQUIRE_APPROVAL = "require_approval"
    DENY = "deny"


class PermissionDenied(PermissionError):
    pass


class ApprovalRequired(Exception):
    def __init__(self, approval_id: str, message: str):
        self.approval_id = approval_id
        super().__init__(message)


@dataclass
class ActionRequest:
    role: str
    permission: Permission
    action: str
    targets: list[str]
    reason: str
    project_id: str | None = None
    task_id: str | None = None
    declared_permissions: list[str] | None = None
    details: dict[str, Any] = field(default_factory=dict)

    @property
    def action_key(self) -> str:
        raw = json.dumps([self.permission, self.action, sorted(self.targets)], sort_keys=True)
        return hashlib.sha256(raw.encode()).hexdigest()[:32]


class PolicyEngine:
    """Backend-enforced permission decisions. The UI only displays and decides approval requests."""

    def __init__(self, db: Database, publish: Callable[..., Any] | None = None):
        self.db = db
        self.publish = publish

    def net_allowlist(self) -> list[str]:
        return list(self.db.get_setting("network.allowlist", DEFAULT_NET_ALLOWLIST))

    def hosted_authorized(self, project_id: str | None) -> bool:
        if not self.db.get_setting("inference.hosted_authorized", False):
            return False
        if project_id is None:
            return True
        row = self.db.one("SELECT allow_hosted_inference FROM projects WHERE id = ?", (project_id,))
        return bool(row and row["allow_hosted_inference"])

    def evaluate(self, req: ActionRequest) -> tuple[Decision, str, str]:
        risk = RISK.get(req.permission, "high")
        try:
            role = get_role(req.role)
        except KeyError:
            return Decision.DENY, "critical", "unknown role"
        if req.declared_permissions is not None and req.permission not in req.declared_permissions:
            return Decision.DENY, risk, f"permission {req.permission} not declared for this task"
        grant = role.grants.get(req.permission)
        if grant is None:
            return Decision.DENY, risk, f"role {req.role} has no grant for {req.permission}"
        if req.permission == Permission.PROCESS_EXEC:
            exe = req.details.get("executable")
            if exe not in EXECUTABLE_ALLOWLIST:
                return Decision.DENY, "high", f"executable {exe!r} is not allowlisted"
        if req.permission == Permission.MODEL_HOSTED and not self.hosted_authorized(req.project_id):
            return Decision.DENY, risk, "hosted inference not authorized for this project"
        if req.permission == Permission.NET_EGRESS:
            hosts = {urlparse(t).hostname or t for t in req.targets}
            allow = set(self.net_allowlist())
            if grant == Grant.ALLOWLIST and hosts <= allow:
                return Decision.ALLOW, risk, "host allowlisted"
            return Decision.REQUIRE_APPROVAL, "high", "host not in network allowlist"
        if req.permission in ALWAYS_APPROVE or grant == Grant.APPROVE:
            return Decision.REQUIRE_APPROVAL, risk, "action requires human approval"
        return Decision.ALLOW, risk, f"granted to role {req.role}"

    def authorize(self, req: ActionRequest) -> str:
        """Return the decision rule when allowed. Raise PermissionDenied or ApprovalRequired otherwise."""
        decision, risk, rule = self.evaluate(req)
        if decision == Decision.DENY:
            self._audit(req, "denied", rule)
            raise PermissionDenied(f"{req.permission} denied: {rule}")
        if decision == Decision.REQUIRE_APPROVAL:
            existing = self.db.all(
                "SELECT * FROM approval_requests WHERE action_key = ? AND COALESCE(task_id,'') = COALESCE(?,'') "
                "ORDER BY created_at DESC",
                (req.action_key, req.task_id),
            )
            for row in existing:
                if row["status"] == "approved" and not row["consumed"]:
                    self.db.update("approval_requests", row["id"], {"consumed": 1})
                    self._audit(req, "allowed", f"approval {row['id']} consumed")
                    return f"approved:{row['id']}"
                if row["status"] == "pending":
                    raise ApprovalRequired(row["id"], f"waiting for approval {row['id']}")
                if row["status"] == "denied":
                    self._audit(req, "denied", f"approval {row['id']} was denied")
                    raise PermissionDenied(f"{req.permission} denied by user (approval {row['id']})")
            approval_id = self.request_approval(req, risk)
            raise ApprovalRequired(approval_id, f"approval required: {req.action}")
        self._audit(req, "allowed", rule)
        return rule

    def request_approval(self, req: ActionRequest, risk: str) -> str:
        approval_id = new_id("apr")
        self.db.insert("approval_requests", {
            "id": approval_id,
            "project_id": req.project_id,
            "task_id": req.task_id,
            "agent_role": req.role,
            "permission": str(req.permission),
            "action": req.action,
            "action_key": req.action_key,
            "targets": redact_value(req.targets),
            "reason": req.reason,
            "risk": risk,
            "status": "pending",
            "created_at": now_iso(),
        })
        self._audit(req, "approval_requested", approval_id)
        if self.publish:
            self.publish("approval.requested", project_id=req.project_id, task_id=req.task_id,
                         payload={"approval_id": approval_id, "permission": str(req.permission), "action": req.action, "risk": risk})
        return approval_id

    def decide(self, approval_id: str, approve: bool, actor: str = "user") -> dict[str, Any]:
        row = self.db.one("SELECT * FROM approval_requests WHERE id = ?", (approval_id,))
        if not row:
            raise KeyError(approval_id)
        if row["status"] != "pending":
            raise ValueError(f"approval {approval_id} is already {row['status']}")
        status = "approved" if approve else "denied"
        self.db.update("approval_requests", approval_id, {"status": status, "decided_by": actor, "decided_at": now_iso()})
        self.audit(actor, f"approval.{status}", approval_id, status, {"permission": row["permission"], "action": row["action"]},
                   project_id=row["project_id"])
        if self.publish:
            self.publish("approval.decided", project_id=row["project_id"], task_id=row["task_id"],
                         payload={"approval_id": approval_id, "status": status})
        return {**row, "status": status}

    def _audit(self, req: ActionRequest, decision: str, rule: str) -> None:
        self.audit(f"agent:{req.role}", str(req.permission), req.action, decision,
                   {"targets": req.targets, "rule": rule, "task_id": req.task_id}, project_id=req.project_id)

    def audit(self, actor: str, action: str, target: str, decision: str, details: dict[str, Any] | None = None,
              project_id: str | None = None) -> None:
        self.db.insert("audit_events", {
            "ts": now_iso(), "project_id": project_id, "actor": actor, "action": action,
            "target": target[:500], "decision": decision, "details": redact_value(details or {}),
        })
