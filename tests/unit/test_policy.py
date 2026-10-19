import pytest

from backend.agents.roles import Permission as P
from backend.persistence.db import Database
from backend.security.policy import ActionRequest, ApprovalRequired, Decision, PermissionDenied, PolicyEngine


@pytest.fixture
def policy(tmp_path):
    db = Database(tmp_path / "v.db")
    db.migrate()
    events = []
    engine = PolicyEngine(db, lambda type, **kw: events.append(type))
    engine.events = events
    yield engine
    db.close()


def req(role, perm, targets=("x",), **kw):
    return ActionRequest(role=role, permission=perm, action=kw.pop("action", "act"), targets=list(targets), reason="test", **kw)


def test_grants_and_declared_permissions(policy):
    assert policy.evaluate(req("backend_engineer", P.FS_WRITE))[0] == Decision.ALLOW
    assert policy.evaluate(req("security_reviewer", P.FS_WRITE))[0] == Decision.DENY
    assert policy.evaluate(req("unknown", P.FS_READ))[2] == "unknown role"
    decision, _, rule = policy.evaluate(req("backend_engineer", P.FS_WRITE, declared_permissions=["fs.read"]))
    assert decision == Decision.DENY and "not declared" in rule


def test_executable_allowlist(policy):
    ok = req("test_engineer", P.PROCESS_EXEC, details={"executable": "node"})
    bad = req("test_engineer", P.PROCESS_EXEC, details={"executable": "powershell"})
    assert policy.evaluate(ok)[0] == Decision.ALLOW
    with pytest.raises(PermissionDenied):
        policy.authorize(bad)
    row = policy.db.one("SELECT * FROM audit_events WHERE decision = 'denied'")
    assert row and "allowlisted" in row["details"]["rule"]


def test_network_allowlist(policy):
    assert policy.evaluate(req("test_engineer", P.NET_EGRESS, ["http://127.0.0.1:5000/api"]))[0] == Decision.ALLOW
    assert policy.evaluate(req("test_engineer", P.NET_EGRESS, ["https://evil.example"]))[0] == Decision.REQUIRE_APPROVAL


def test_hosted_inference_requires_global_and_project_authorization(policy):
    r = req("architect", P.MODEL_HOSTED)
    assert policy.evaluate(r)[0] == Decision.DENY
    policy.db.set_setting("inference.hosted_authorized", True)
    assert policy.evaluate(r)[0] == Decision.ALLOW
    assert policy.evaluate(req("architect", P.MODEL_HOSTED, project_id="prj_missing"))[0] == Decision.DENY


def test_approval_is_requested_then_consumed_once(policy):
    r = req("repo_discovery", P.FS_READ_EXTERNAL, ["D:/data"])
    with pytest.raises(ApprovalRequired) as first:
        policy.authorize(r)
    with pytest.raises(ApprovalRequired) as again:
        policy.authorize(r)
    assert first.value.approval_id == again.value.approval_id
    assert "approval.requested" in policy.events
    policy.decide(first.value.approval_id, True)
    assert policy.authorize(r).startswith("approved:")
    with pytest.raises(ApprovalRequired) as third:
        policy.authorize(r)
    assert third.value.approval_id != first.value.approval_id
    with pytest.raises(ValueError):
        policy.decide(first.value.approval_id, False)


def test_denied_approval_raises(policy):
    r = req("repo_discovery", P.REA_INSPECT, ["./my-binary"])
    with pytest.raises(ApprovalRequired) as exc:
        policy.authorize(r)
    policy.decide(exc.value.approval_id, False)
    with pytest.raises(PermissionDenied):
        policy.authorize(r)
