"""Run an acceptance project end to end through the real scheduler. Usage: python scripts/e2e_run.py <domain-request>"""
import asyncio
import json
import pathlib
import sys
import tempfile
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from backend.config import Config
from backend.services import Services


async def main(request: str, auto_approve: bool) -> int:
    cfg = Config(data_dir=pathlib.Path(tempfile.mkdtemp(prefix="veylora-e2e-")))
    s = Services.build(cfg, register_default_providers=False)
    p = s.projects.create(request)
    print("project", p["id"], p["domain"], "data", cfg.data_dir)
    s.scheduler.start(p["id"])
    t0 = time.time()
    while time.time() - t0 < 900:
        await asyncio.sleep(1)
        if auto_approve:
            for a in s.db.all("SELECT * FROM approval_requests WHERE status = 'pending'"):
                print("auto-approving", a["permission"], a["action"])
                s.scheduler.on_approval(s.policy.decide(a["id"], True, "e2e-script"))
        proj = s.projects.get(p["id"])
        if not s.scheduler.is_running(p["id"]) and proj["status"] != "running":
            break
    for t in s.projects.tasks(p["id"]):
        print(f"{t['key']:18} {t['status']:22} {t['verification_status']:10} {(t['last_error'] or '')[:160]}")
    proj = s.projects.get(p["id"])
    print("project status:", proj["status"], json.dumps(proj["task_counts"]))
    for r in s.db.all("SELECT kind, status, passed, failed, skipped FROM test_results WHERE project_id = ?", (p["id"],)):
        print("test_result", r)
    await s.aclose()
    return 0 if proj["status"] == "completed" else 1


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if a != "--auto-approve"]
    sys.exit(asyncio.run(main(" ".join(args), "--auto-approve" in sys.argv)))
