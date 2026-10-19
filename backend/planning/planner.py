from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

from backend.agents.roles import Permission as P
from backend.blueprints.loader import load_blueprint
from backend.intent.engine import Specification
from backend.orchestration.dag import layered_layout, validate_graph

TASK_PERMISSIONS: dict[str, list[str]] = {
    "specification": [P.FS_READ, P.MODEL_LOCAL],
    "discovery": [P.FS_READ, P.MODEL_LOCAL],
    "architecture": [P.FS_READ, P.FS_WRITE, P.MODEL_LOCAL],
    "scaffold": [P.FS_READ, P.FS_WRITE, P.GIT],
    "implement": [P.FS_READ, P.FS_WRITE, P.GIT],
    "generate_feature": [P.FS_READ, P.FS_WRITE, P.GIT, P.MODEL_LOCAL],
    "repair": [P.FS_READ, P.FS_WRITE, P.GIT, P.MODEL_LOCAL],
    "integrate": [P.FS_READ, P.FS_WRITE, P.GIT, P.PROCESS_EXEC],
    "test": [P.FS_READ, P.PROCESS_EXEC],
    "browser_test": [P.FS_READ, P.PROCESS_EXEC, P.PREVIEW, P.NET_EGRESS],
    "review_code": [P.FS_READ, P.MODEL_LOCAL],
    "review_security": [P.FS_READ],
    "docs": [P.FS_READ, P.FS_WRITE, P.GIT, P.MODEL_LOCAL],
    "verify": [P.FS_READ],
    "repo_analysis": [P.FS_READ, P.NET_EGRESS, P.MODEL_LOCAL],
    "rea_inspect": [P.FS_READ, P.REA_INSPECT],
}
MODEL_TASK_TYPES = {"specification", "architecture", "generate_feature", "repair", "review_code", "docs", "repo_analysis"}

COMPONENT_ROLES = {
    "ui": "frontend_engineer", "model": "frontend_engineer", "history": "frontend_engineer", "export": "frontend_engineer",
    "data": "data_engineer", "serialize": "backend_engineer", "api": "backend_engineer", "tests": "test_engineer",
    "domain": "domain_specialist", "algorithms": "domain_specialist", "scenarios": "domain_specialist",
}
TASK_ROLES = {
    "specification": "planner", "discovery": "skill_discovery", "architecture": "architect", "scaffold": "backend_engineer",
    "generate_feature": "backend_engineer", "repair": "backend_engineer", "integrate": "integration_engineer",
    "test": "test_engineer", "browser_test": "test_engineer", "review_code": "code_reviewer",
    "review_security": "security_reviewer", "docs": "documentation", "verify": "verifier",
    "repo_analysis": "repo_discovery", "rea_inspect": "repo_discovery",
}
TIMEOUTS = {"generate_feature": 900, "repair": 900, "test": 300, "browser_test": 300, "repo_analysis": 300,
            "review_code": 600, "docs": 600, "architecture": 600, "specification": 300, "rea_inspect": 900}


@dataclass
class TaskSpec:
    key: str
    title: str
    description: str
    task_type: str
    phase: str
    role: str
    depends_on: list[str] = field(default_factory=list)
    permissions: list[str] = field(default_factory=list)
    inputs: list[str] = field(default_factory=list)
    outputs: list[str] = field(default_factory=list)
    acceptance: list[str] = field(default_factory=list)
    params: dict[str, Any] = field(default_factory=dict)
    rationale: list[str] = field(default_factory=list)
    required_capabilities: list[str] = field(default_factory=list)
    timeout_s: int = 300
    max_retries: int = 1

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def make_task(key: str, task_type: str, title: str, description: str, phase: str, depends_on: list[str],
              allow_hosted: bool, role: str | None = None, **kw: Any) -> TaskSpec:
    perms = [str(p) for p in TASK_PERMISSIONS[task_type]]
    if allow_hosted and task_type in MODEL_TASK_TYPES:
        perms.append(str(P.MODEL_HOSTED))
    role = role or TASK_ROLES.get(task_type, "backend_engineer")
    rationale = kw.pop("rationale", [])
    rationale = [*rationale, f"assigned to {role} by task type '{task_type}'"]
    if depends_on:
        rationale.append("depends on " + ", ".join(depends_on))
    return TaskSpec(key=key, title=title, description=description, task_type=task_type, phase=phase, role=role,
                    depends_on=depends_on, permissions=perms, rationale=rationale,
                    timeout_s=kw.pop("timeout_s", TIMEOUTS.get(task_type, 300)),
                    max_retries=kw.pop("max_retries", 0 if task_type in ("test", "verify", "rea_inspect") else 1), **kw)


def _common_head(spec: Specification, hosted: bool) -> list[TaskSpec]:
    return [
        make_task("spec", "specification", "Record specification", "Persist the structured specification and acceptance criteria.",
                  "specify", [], hosted, outputs=["specification.md"], acceptance=["Specification artifact saved"],
                  rationale=["every plan starts from a versioned specification"]),
        make_task("discover", "discovery", "Select skills and capabilities",
                  "Search enabled skills and registered capabilities relevant to this project and resolve their dependencies.",
                  "discover", ["spec"], hosted, outputs=["discovery.json"],
                  acceptance=["Selected skills and capabilities recorded with reasons"],
                  rationale=["skills and capabilities are chosen from registries, not assumed"]),
    ]


def _build_tail(hosted: bool, impl_keys: list[str], blueprint: str, browser_checks: str | None,
                test_files: list[str]) -> list[TaskSpec]:
    tasks = [
        make_task("integrate", "integrate", "Integrate task branches",
                  "Merge each implementation branch into main and confirm the tree is consistent.", "integrate", impl_keys, hosted,
                  outputs=["main branch"], acceptance=["All implementation branches merged without conflicts"],
                  rationale=["implementation runs in isolated worktrees, so a merge step is required"]),
        make_task("test", "test", "Run automated tests", "Run the node:test suite against the integrated tree.", "verify",
                  ["integrate"], hosted, outputs=["test report"], params={"test_files": test_files},
                  acceptance=["All tests pass"], rationale=["acceptance requires real test evidence"]),
        make_task("review-code", "review_code", "Review code", "Static quality checks plus an optional local-model review.",
                  "verify", ["integrate"], hosted, outputs=["code-review.md"], acceptance=["Review recorded"]),
        make_task("review-security", "review_security", "Review security",
                  "Pattern-based static security scan of the generated tree.", "verify", ["integrate"], hosted,
                  outputs=["security-review.md"], acceptance=["No high-severity findings"]),
        make_task("docs", "docs", "Write documentation", "Finalise README with setup, capabilities and limitations.",
                  "deliver", ["integrate"], hosted, outputs=["README.md"], acceptance=["README present"]),
        make_task("browser-test", "browser_test", "Run browser checks",
                  "Start a local preview and drive it with Playwright to check the primary workflow.", "verify", ["test"], hosted,
                  params={"check": browser_checks}, outputs=["browser report", "screenshot"],
                  acceptance=["Primary workflow passes in a real browser"]),
        make_task("verify", "verify", "Verify acceptance criteria",
                  "Evaluate every acceptance criterion against recorded evidence and produce the delivery report.", "deliver",
                  ["discover", "test", "browser-test", "review-code", "review-security", "docs"], hosted,
                  outputs=["verification-report.md"], acceptance=["Every criterion has a verdict backed by evidence"]),
    ]
    tasks[0].params["blueprint"] = blueprint
    return tasks


def build_plan(spec: Specification, allow_hosted: bool = False, request: str = "") -> list[TaskSpec]:
    hosted = allow_hosted
    tasks = _common_head(spec, hosted)
    if spec.blueprint is None:
        return tasks + _repo_analysis_plan(spec, hosted, request)
    bp = load_blueprint(spec.blueprint)
    tasks.append(make_task("architecture", "architecture", "Define architecture",
                           f"Document module boundaries and contracts for the {bp.title} blueprint.", "design", ["spec"], hosted,
                           params={"blueprint": bp.name}, outputs=["architecture.md"], acceptance=["Architecture document saved"],
                           rationale=[f"blueprint {bp.name} selected by domain '{spec.domain}'"]))
    tasks.append(make_task("scaffold", "scaffold", "Scaffold project", "Create the project skeleton on the main branch.", "build",
                           ["architecture"], hosted, params={"blueprint": bp.name, "component": "scaffold"},
                           outputs=list(bp.components["scaffold"]), acceptance=["Scaffold committed to main"],
                           required_capabilities=["node-runtime", "git-cli", f"blueprint-{bp.name}"]))
    impl_keys: list[str] = []
    if spec.blueprint == "web-app":
        impl_keys.append("generate-feature")
        tasks.append(make_task("generate-feature", "generate_feature", "Generate application features",
                               "Generate src/features.mjs, its UI module and tests from the specification using a local model.",
                               "build", ["scaffold"], hosted,
                               params={"features": spec.features, "entities": spec.entities},
                               outputs=["src/features.mjs", "public/features.js", "test/features.test.mjs"],
                               acceptance=["Generated files satisfy the feature contract", "Generated tests pass"],
                               rationale=["no deterministic blueprint covers this request, so a model generates the feature module"]))
    for comp, files in bp.components.items():
        if comp in ("scaffold", "docs"):
            continue
        key = f"impl-{comp}"
        impl_keys.append(key)
        role = COMPONENT_ROLES.get(comp, "backend_engineer")
        if role == "test_engineer":
            role = "backend_engineer"
        tasks.append(make_task(key, "implement", f"Implement {comp}", f"Write the {comp} component in an isolated worktree.",
                               "build", ["scaffold"], hosted, role=role, params={"blueprint": bp.name, "component": comp},
                               outputs=list(files), acceptance=[f"{len(files)} file(s) committed on branch task/{key}"],
                               rationale=[f"component '{comp}' of blueprint {bp.name}"]))
    test_files = bp.test_files()
    if spec.blueprint == "web-app":
        test_files = [*test_files, "test/features.test.mjs"]
    tasks += _build_tail(hosted, impl_keys, bp.name, bp.browser_checks, test_files)
    for t in tasks:
        if t.key == "docs":
            t.params.update({"blueprint": bp.name, "component": "docs"})
    return tasks


def _repo_analysis_plan(spec: Specification, hosted: bool, request: str) -> list[TaskSpec]:
    tasks: list[TaskSpec] = []
    keys: list[str] = []
    targets = spec.targets or [""]
    wants_rea = any(w in request.lower() for w in ("rea", "reverse engineer", "reverse-engineer", "binary"))
    for i, target in enumerate(targets, start=1):
        key = f"analyze-{i}"
        keys.append(key)
        tasks.append(make_task(key, "repo_analysis", f"Analyse {target or 'repository'}",
                               "Collect repository metadata through the GitHub connector and summarise structure with evidence levels.",
                               "discover", ["discover"], hosted, params={"target": target}, outputs=["analysis.json"],
                               acceptance=["Each claim carries an evidence level"]))
        if wants_rea:
            rkey = f"rea-{i}"
            keys.append(rkey)
            tasks.append(make_task(rkey, "rea_inspect", f"REA inspection of {target or 'target'}",
                                   "Run the optional REA adapter. Requires explicit approval and an authorised target.",
                                   "discover", [key], hosted, params={"target": target}, outputs=["rea-output.txt"],
                                   acceptance=["Inspection ran only after approval"],
                                   required_capabilities=["rea"]))
    tasks.append(make_task("docs", "docs", "Write analysis report", "Combine analyses into a report with cited evidence.",
                           "deliver", keys, hosted, params={"report": "repo_analysis"}, outputs=["analysis-report.md"],
                           acceptance=["Report saved"]))
    tasks.append(make_task("verify", "verify", "Verify acceptance criteria", "Check report evidence and approvals.", "deliver",
                           ["docs"], hosted, outputs=["verification-report.md"], acceptance=["Criteria evaluated"]))
    return tasks


def validate_plan(tasks: list[TaskSpec]) -> tuple[list[str], dict[str, tuple[float, float]]]:
    edges = {t.key: t.depends_on for t in tasks}
    order = validate_graph([t.key for t in tasks], edges)
    return order, layered_layout(order, edges)


def plan_summary(tasks: list[TaskSpec]) -> dict[str, Any]:
    phases: dict[str, int] = {}
    roles: dict[str, int] = {}
    for t in tasks:
        phases[t.phase] = phases.get(t.phase, 0) + 1
        roles[t.role] = roles.get(t.role, 0) + 1
    return {"task_count": len(tasks), "phases": phases, "roles": roles}
