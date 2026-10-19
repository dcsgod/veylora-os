from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel, Field

DOMAIN_KEYWORDS: dict[str, tuple[str, ...]] = {
    "supply_chain": ("supply chain", "supply-chain", "inventory", "warehouse", "replenish", "reorder", "supplier", "forecast",
                     "demand", "stock", "logistics", "procurement", "safety stock", "sku", "lead time"),
    "design_editor": ("canva", "design editor", "graphic", "layer", "canvas", "poster", "template", "drag", "resize",
                      "shapes", "image editor", "svg", "png", "flyer", "banner", "social post"),
    "bi": ("dashboard", "analytics", "kpi", "report", "chart", "metrics", "business intelligence", "visuali"),
    "repo_analysis": ("analy", "audit", "reverse engineer", "inspect", "repository", "codebase", "binary", "explain this repo"),
}

_REPO_REF = re.compile(r"\b([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)\b")
_GITHUB_URL = re.compile(r"github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+?)(?:\.git)?(?:[/?#\s]|$)")


class AcceptanceCriterion(BaseModel):
    id: str
    text: str
    evidence: str = Field(description="unit_test | browser | review | artifact")


class Specification(BaseModel):
    title: str
    summary: str
    domain: str
    blueprint: str | None
    features: list[str]
    entities: list[str] = []
    constraints: list[str] = []
    acceptance_criteria: list[AcceptanceCriterion]
    assumptions: list[str] = []
    open_questions: list[str] = []
    out_of_scope: list[str] = []
    targets: list[str] = []
    detection: dict[str, Any] = {}
    source: str = "deterministic"


class SpecRefinement(BaseModel):
    """What a model is allowed to contribute: clarifications, never acceptance evidence or scope expansion."""
    assumptions: list[str] = []
    open_questions: list[str] = []
    extra_features: list[str] = []


_COMMON_CONSTRAINTS = [
    "Runs locally on Windows and macOS with Node.js 20 or newer and no third-party runtime dependencies",
    "Binds only to 127.0.0.1; no authentication, so it is not suitable for exposure on a network as generated",
    "All persisted data stays in the project's data/ directory",
]

PROFILES: dict[str, dict[str, Any]] = {
    "supply_chain": {
        "blueprint": "supply-chain",
        "title": "Supply-chain planner",
        "features": [
            "Product catalogue and inventory positions per warehouse with CSV ingestion and row-level validation",
            "Demand forecasting with moving average, exponential smoothing and Holt linear trend, plus rolling backtests",
            "Replenishment recommendations: safety stock, reorder point and EOQ at a configurable service level",
            "Warehouse capacity utilisation and overflow warnings",
            "Supplier management with lead times and reliability",
            "What-if scenarios for demand shocks, lead-time changes and supplier disruption",
        ],
        "entities": ["Product", "Warehouse", "InventoryPosition", "Supplier", "DemandHistory", "Scenario"],
        "acceptance": [
            ("CSV ingestion accepts valid rows and reports invalid rows with row numbers", "unit_test"),
            ("Forecasts are produced for each method and backtest error (MAE/MAPE) is reported", "unit_test"),
            ("Reorder point, safety stock and EOQ are computed from documented formulas", "unit_test"),
            ("Scenario runs report changed recommendations and capacity impact", "unit_test"),
            ("HTTP API validates input and rejects path traversal", "unit_test"),
            ("The UI loads, shows inventory and renders a forecast chart", "browser"),
            ("No high-severity findings in the static security review", "review"),
            ("README documents setup, capabilities and limitations", "artifact"),
        ],
        "assumptions": [
            "Synthetic fixture data is used until the user ingests real CSV files; it is labelled as synthetic in the UI",
            "Forecasting uses transparent textbook baselines, not tuned production models",
        ],
        "out_of_scope": ["Multi-user authentication", "ERP integrations", "Optimisation solvers"],
    },
    "design_editor": {
        "blueprint": "design-editor",
        "title": "Layered design editor",
        "features": [
            "Canvas with rectangles, ellipses, lines, text and uploaded images",
            "Selection, multi-select, move and resize with snapping guides",
            "Layers panel with ordering, visibility and locking",
            "Alignment tools and a properties panel",
            "Undo and redo with coalesced edits",
            "Templates, save and load, and JSON/SVG/PNG export",
        ],
        "entities": ["Document", "Layer", "Template", "History"],
        "acceptance": [
            ("Layer operations (add, update, reorder, duplicate, align) behave as specified", "unit_test"),
            ("Undo/redo restores previous document states", "unit_test"),
            ("Saved documents are validated; remote image URLs and SVG payloads are rejected", "unit_test"),
            ("SVG export escapes text and reproduces every layer", "unit_test"),
            ("The editor loads in a browser, creates layers and exports a design", "browser"),
            ("No high-severity findings in the static security review", "review"),
            ("README documents features, security model and limitations", "artifact"),
        ],
        "assumptions": ["Original UI and templates; no proprietary Canva assets, branding or internals are reproduced"],
        "out_of_scope": ["Real-time collaboration", "Cloud storage", "Stock asset libraries"],
    },
    "bi": {
        "blueprint": "web-app",
        "title": "Analytics dashboard",
        "features": ["Data collections with a JSON API", "Dashboard view summarising the stored data"],
        "entities": [],
        "acceptance": [
            ("Generated feature module passes its tests", "unit_test"),
            ("Base server tests pass", "unit_test"),
            ("The app loads in a browser", "browser"),
            ("No high-severity findings in the static security review", "review"),
        ],
        "assumptions": ["Feature code is generated by a local model and must pass tests before it is accepted"],
        "out_of_scope": ["External data warehouse connections"],
    },
    "generic": {
        "blueprint": "web-app",
        "title": "Web application",
        "features": [],
        "entities": [],
        "acceptance": [
            ("Generated feature module passes its tests", "unit_test"),
            ("Base server tests pass", "unit_test"),
            ("The app loads in a browser", "browser"),
            ("No high-severity findings in the static security review", "review"),
        ],
        "assumptions": ["Feature code is generated by a local model and must pass tests before it is accepted"],
        "out_of_scope": [],
    },
    "repo_analysis": {
        "blueprint": None,
        "title": "Repository analysis",
        "features": ["Repository metadata and static structure analysis", "Symbol index and detected test commands",
                     "Capability proposal with evidence levels"],
        "entities": ["Repository", "Symbol", "CapabilityProposal"],
        "acceptance": [
            ("Analysis report cites evidence for each claim and labels its confidence", "artifact"),
            ("Invasive inspection only runs after explicit approval", "review"),
        ],
        "assumptions": ["Only repositories the user owns or is authorised to analyse are inspected"],
        "out_of_scope": ["Exploitation, credential extraction or bypassing security controls"],
    },
}


@dataclass
class Detection:
    domain: str
    scores: dict[str, int]
    matched: dict[str, list[str]]


def detect_domain(request: str) -> Detection:
    text = request.lower()
    scores: dict[str, int] = {}
    matched: dict[str, list[str]] = {}
    for domain, words in DOMAIN_KEYWORDS.items():
        hits = [w for w in words if w in text]
        scores[domain] = len(hits)
        matched[domain] = hits
    if _GITHUB_URL.search(request) and scores["repo_analysis"]:
        scores["repo_analysis"] += 2
    best = max(scores, key=lambda d: scores[d])
    if scores[best] == 0:
        best = "generic"
    elif best == "repo_analysis" and scores["repo_analysis"] <= max(v for k, v in scores.items() if k != "repo_analysis"):
        best = max((k for k in scores if k != "repo_analysis"), key=lambda d: scores[d])
    return Detection(best, scores, matched)


def extract_targets(request: str) -> list[str]:
    found = [m.group(1) for m in _GITHUB_URL.finditer(request)]
    if not found:
        found = [m.group(1) for m in _REPO_REF.finditer(request) if not m.group(1).startswith(("http", "www"))
                 and "." not in m.group(1).split("/")[0]]
    return list(dict.fromkeys(found))[:5]


def _title_from(request: str, fallback: str) -> str:
    first = re.split(r"[.\n]", request.strip(), maxsplit=1)[0]
    first = re.sub(r"^(please\s+)?(build|create|make|generate|design|write)\s+(me\s+)?(an?\s+|the\s+)?", "", first, flags=re.I)
    first = first.strip(" :,-")
    return (first[:1].upper() + first[1:])[:80] if 3 <= len(first) <= 80 else fallback


def _requested_features(request: str) -> list[str]:
    parts = re.split(r"\n\s*[-*\d.]+\s+|;|\bwith\b|\band\b", request)
    out = []
    for p in parts[1:]:
        p = p.strip(" .,:")
        if 4 <= len(p) <= 160:
            out.append(p[:1].upper() + p[1:])
    return out[:8]


def build_specification(request: str, domain: str | None = None) -> Specification:
    if not request or not request.strip():
        raise ValueError("request must not be empty")
    detection = detect_domain(request)
    chosen = domain or detection.domain
    if chosen not in PROFILES:
        raise ValueError(f"unknown domain {chosen!r}")
    profile = PROFILES[chosen]
    features = list(profile["features"])
    if chosen in ("generic", "bi"):
        features += [f for f in _requested_features(request) if f not in features]
        if not features:
            features = [request.strip()[:160]]
    acceptance = [AcceptanceCriterion(id=f"AC{i + 1}", text=t, evidence=e) for i, (t, e) in enumerate(profile["acceptance"])]
    questions: list[str] = []
    if chosen in ("generic", "bi"):
        questions.append("Which records and fields should the application manage? The generated model infers them from the request.")
    targets = extract_targets(request) if chosen == "repo_analysis" else []
    if chosen == "repo_analysis" and not targets:
        questions.append("Which repository should be analysed? Provide owner/name or a GitHub URL.")
    return Specification(
        title=_title_from(request, profile["title"]),
        summary=request.strip()[:1200],
        domain=chosen,
        blueprint=profile["blueprint"],
        features=features,
        entities=list(profile["entities"]),
        constraints=list(_COMMON_CONSTRAINTS) if profile["blueprint"] else [],
        acceptance_criteria=acceptance,
        assumptions=list(profile["assumptions"]),
        open_questions=questions,
        out_of_scope=list(profile["out_of_scope"]),
        targets=targets,
        detection={"domain": detection.domain, "scores": detection.scores, "matched": detection.matched,
                   "overridden": domain is not None and domain != detection.domain},
    )


def apply_refinement(spec: Specification, refinement: SpecRefinement, model_name: str) -> Specification:
    data = spec.model_dump()
    data["assumptions"] = list(dict.fromkeys(spec.assumptions + [a[:300] for a in refinement.assumptions[:5]]))
    data["open_questions"] = list(dict.fromkeys(spec.open_questions + [q[:300] for q in refinement.open_questions[:5]]))
    if spec.domain in ("generic", "bi"):
        data["features"] = list(dict.fromkeys(spec.features + [f[:200] for f in refinement.extra_features[:5]]))
    data["source"] = f"deterministic+model:{model_name}"
    return Specification.model_validate(data)


def specification_markdown(spec: Specification) -> str:
    lines = [f"# {spec.title}", "", f"**Domain:** {spec.domain}  ", f"**Blueprint:** {spec.blueprint or 'none'}  ",
             f"**Source:** {spec.source}", "", "## Request", "", spec.summary, "", "## Features", ""]
    lines += [f"- {f}" for f in spec.features]
    for heading, items in (("Entities", spec.entities), ("Constraints", spec.constraints), ("Assumptions", spec.assumptions),
                           ("Open questions", spec.open_questions), ("Out of scope", spec.out_of_scope),
                           ("Targets", spec.targets)):
        if items:
            lines += ["", f"## {heading}", ""] + [f"- {i}" for i in items]
    lines += ["", "## Acceptance criteria", "", "| ID | Criterion | Evidence |", "|---|---|---|"]
    lines += [f"| {c.id} | {c.text} | {c.evidence} |" for c in spec.acceptance_criteria]
    return "\n".join(lines) + "\n"
