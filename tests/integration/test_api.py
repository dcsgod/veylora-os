import socket
import threading
import time

import httpx
import uvicorn

import pytest
from fastapi.testclient import TestClient

from backend.api.app import create_app
from backend.config import API_PREFIX

AUTH = {"Authorization": "Bearer test-token"}


@pytest.fixture
def client(config):
    with TestClient(create_app(config), base_url="http://127.0.0.1:47821") as c:
        yield c


def api(path: str) -> str:
    return API_PREFIX + path


def test_guard(client):
    assert client.get(api("/health")).json()["status"] == "ok"
    assert client.get(api("/projects")).status_code == 401
    assert client.get(api("/projects"), headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert client.get(api("/projects"), headers={**AUTH, "Host": "evil.example:47821"}).status_code == 421
    r = client.get(api("/projects"), headers=AUTH)
    assert r.status_code == 200 and r.headers["x-content-type-options"] == "nosniff"


def test_cors_only_for_allowed_origins(client):
    pre = {"Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization"}
    ok = client.options(api("/projects"), headers={**pre, "Origin": "veylora://app"})
    assert ok.headers.get("access-control-allow-origin") == "veylora://app"
    bad = client.options(api("/projects"), headers={**pre, "Origin": "https://evil.example"})
    assert "access-control-allow-origin" not in bad.headers


def test_project_lifecycle_spec_plan_and_files(client):
    preview = client.post(api("/projects/preview-spec"), json={"request": "Build a supply chain planner with inventory"},
                          headers=AUTH).json()
    assert preview["spec"]["domain"] == "supply_chain" and "Acceptance" in preview["markdown"]
    p = client.post(api("/projects"), json={"request": "Build a supply chain planner with inventory"}, headers=AUTH).json()
    assert p["status"] == "planned"
    detail = client.get(api(f"/projects/{p['id']}"), headers=AUTH).json()
    assert detail["scheduler_active"] is False and detail["pending_approvals"] == 0
    plan = client.get(api(f"/projects/{p['id']}/plan"), headers=AUTH).json()
    ids = {t["id"] for t in plan["tasks"]}
    assert len(plan["tasks"]) > 5 and all(e["source"] in ids and e["target"] in ids for e in plan["edges"])

    spec = client.get(api(f"/projects/{p['id']}/spec"), headers=AUTH).json()["content"]
    spec["features"] = spec["features"][:2]
    revised = client.put(api(f"/projects/{p['id']}/spec"), json={"spec": spec}, headers=AUTH)
    assert revised.status_code == 200 and revised.json()["revision"] == 2
    assert len(client.get(api(f"/projects/{p['id']}/plan"), headers=AUTH).json()["revisions"]) == 2

    assert client.get(api(f"/projects/{p['id']}/files"), headers=AUTH).status_code == 404
    repo = client.app.state.services.runtime.workspace(p["id"]).repo
    repo.mkdir(parents=True, exist_ok=True)
    (repo / "readme.md").write_text("hello", encoding="utf-8")
    assert client.get(api(f"/projects/{p['id']}/file"), params={"path": "readme.md"}, headers=AUTH).json()["content"] == "hello"
    for bad in ("../../etc/passwd", ".git/config", "C:/Windows/win.ini"):
        assert client.get(api(f"/projects/{p['id']}/file"), params={"path": bad}, headers=AUTH).status_code == 400
    assert client.get(api(f"/projects/{p['id']}/git/show/not;valid"), headers=AUTH).status_code in (400, 404)
    assert client.get(api("/projects/prj_missing"), headers=AUTH).status_code == 404

    history = client.get(api("/events/history"), params={"project_id": p["id"]}, headers=AUTH).json()
    assert any(e["type"] == "plan.revised" for e in history)
    assert client.delete(api(f"/projects/{p['id']}"), headers=AUTH).status_code == 200


def test_hosted_requires_global_authorization(client):
    r = client.post(api("/projects"), json={"request": "Build a habit tracker", "allow_hosted": True}, headers=AUTH)
    assert r.status_code == 400 and "hosted" in r.json()["detail"]


def test_settings_validation_and_audit(client):
    assert client.patch(api("/settings"), json={"network_allowlist": ["https://evil.example/path"]}, headers=AUTH).status_code in (400, 422)
    assert client.patch(api("/settings"), json={"rea_inspect_args": ["--json"]}, headers=AUTH).status_code in (400, 422)
    assert client.patch(api("/settings"), json={"max_parallel": 99}, headers=AUTH).status_code == 422
    bad_provider = {"id": "x", "type": "ollama", "url": "http://127.0.0.1:1", "enabled": True, "max_concurrency": 1,
                    "api_key_env": "sk-literal-secret-value"}
    assert client.patch(api("/settings"), json={"providers": [bad_provider]}, headers=AUTH).status_code in (400, 422)
    ok = client.patch(api("/settings"), json={"theme": "dark", "network_allowlist": ["api.github.com", "localhost"]}, headers=AUTH)
    assert ok.status_code == 200 and ok.json()["theme"] == "dark"
    audit = client.get(api("/audit"), headers=AUTH).json()
    assert any(a["action"].startswith("settings") for a in audit)


def test_platform_listings(client):
    roles = client.get(api("/roles"), headers=AUTH).json()
    assert any(r["id"] == "security_reviewer" for r in roles)
    caps = client.get(api("/capabilities"), headers=AUTH).json()
    assert any(c["slug"] == "node-runtime" for c in caps)
    repos = client.get(api("/repositories"), headers=AUTH).json()
    assert {"morluto/rea", "Prat011/awesome-llm-skills"} <= {r["full_name"] for r in repos}
    assert client.get(api("/approvals"), headers=AUTH).json() == []
    system = client.get(api("/system"), headers=AUTH).json()
    assert "executables" in system and system["version"]
    route = client.post(api("/models/route"), json={"task_type": "generate_feature", "role": "backend_engineer"}, headers=AUTH)
    assert route.status_code == 200 and route.json()["model_id"] is None


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def test_event_stream_replays_then_streams_live(config):
    config.port = _free_port()
    server = uvicorn.Server(uvicorn.Config(create_app(config), host="127.0.0.1", port=config.port, log_level="warning"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{config.port}{API_PREFIX}"
    try:
        for _ in range(100):
            if server.started:
                break
            time.sleep(0.05)
        with httpx.Client(base_url=base, headers=AUTH, timeout=10) as c:
            p = c.post("/projects", json={"request": "Build a habit tracker"}).json()
            history = c.get("/events/history", params={"project_id": p["id"]}).json()
            assert history
            cutoff = history[0]["id"]
            seen: list[tuple[int, str]] = []
            with c.stream("GET", "/events", params={"project_id": p["id"]}, headers={"Last-Event-ID": str(cutoff)}) as r:
                assert r.headers["content-type"].startswith("text/event-stream")
                lines = r.iter_lines()
                event_type = None
                for line in lines:
                    if line.startswith("event:"):
                        event_type = line[6:].strip()
                    elif line.startswith("id:"):
                        seen.append((int(line[3:].strip()), ""))
                    elif line.startswith("data:") and seen:
                        seen[-1] = (seen[-1][0], event_type or "")
                        if len(seen) == len(history) - 1:
                            break
                replayed = [i for i, _ in seen]
                assert replayed == [e["id"] for e in history[1:]]
                assert c.post(f"/projects/{p['id']}/start").status_code == 200
                for line in lines:
                    if line.startswith("id:"):
                        assert int(line[3:].strip()) > replayed[-1]
                        break
    finally:
        server.should_exit = True
        thread.join(timeout=10)
