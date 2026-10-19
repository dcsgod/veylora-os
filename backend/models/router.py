from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from typing import Any

import psutil

from backend.models.service import ModelService, parse_param_billions

TASK_CLASS_BY_TYPE = {
    "specification": "planning",
    "architecture": "planning",
    "discovery": "extraction",
    "repo_analysis": "extraction",
    "rea_inspect": "extraction",
    "scaffold": "code",
    "implement": "code",
    "generate_feature": "code",
    "repair": "code",
    "integrate": "code",
    "test": "code",
    "browser_test": "code",
    "review_code": "review",
    "review_security": "review",
    "docs": "docs",
    "verify": "review",
    "llm_task": "extraction",
}

_COMPLEX_HINTS = re.compile(r"\b(architecture|refactor|optimi[sz]|concurren|multi-?file|integrat|repair|complex|algorithm)\b", re.I)


def classify_task(task_type: str, title: str = "", description: str = "") -> tuple[str, str]:
    """Deterministic classification: (task_class, complexity). No model call is needed for routing."""
    task_class = TASK_CLASS_BY_TYPE.get(task_type, "extraction")
    text = f"{title} {description}"
    complexity = "complex" if (len(text) > 600 or _COMPLEX_HINTS.search(text) or task_type in ("generate_feature", "repair")) else "simple"
    return task_class, complexity


@dataclass
class RouteDecision:
    model_id: str | None
    model_name: str | None
    provider: str | None
    task_class: str
    complexity: str
    reason: str
    considered: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class ModelRouter:
    def __init__(self, models: ModelService):
        self.models = models

    def route(self, task_type: str, *, role: str, title: str = "", description: str = "", context_tokens: int = 2048,
              allow_hosted: bool = False, privacy: str = "local_only", preferred: str | None = None) -> RouteDecision:
        task_class, complexity = classify_task(task_type, title, description)
        available_mb = psutil.virtual_memory().available / (1024 * 1024)
        considered: list[dict[str, Any]] = []
        best: tuple[float, dict[str, Any], list[str]] | None = None
        for cfg in self.models.list_configs():
            name = f"{cfg['provider']}/{cfg['name']}"
            tags = set(cfg.get("capabilities") or [])
            entry: dict[str, Any] = {"model_id": cfg["id"], "model": name}
            excluded = None
            if not cfg["enabled"]:
                excluded = "disabled"
            elif not cfg["installed"]:
                excluded = "not confirmed installed by runtime"
            elif not cfg.get("provider_connected"):
                excluded = "runtime not connected"
            elif "embedding" in tags and "completion" not in tags:
                excluded = "embedding-only model"
            elif cfg["provider_kind"] == "hosted" and (not allow_hosted or privacy == "local_only"):
                excluded = "hosted inference not authorized"
            elif cfg.get("context_length") and cfg["context_length"] < context_tokens:
                excluded = f"context {cfg['context_length']} < required {context_tokens}"
            if excluded:
                entry["excluded"] = excluded
                considered.append(entry)
                continue
            score, notes = 1.0, []
            if preferred and cfg["id"] == preferred:
                score += 5
                notes.append("explicitly preferred")
            if role in (cfg.get("role_assignments") or []):
                score += 3
                notes.append(f"assigned to role {role}")
            if task_class == "code" and "code" in tags:
                score += 1.0
                notes.append("code-specialised")
            if "tools" in tags:
                score += 0.1
            size = parse_param_billions(cfg.get("parameter_size"))
            if size is not None:
                if complexity == "simple":
                    score -= 0.04 * size
                else:
                    score += 0.04 * min(size, 34)
            outcomes = [o for o in cfg.get("outcomes", []) if o["task_class"] == task_class]
            if outcomes:
                s, f = outcomes[0]["successes"], outcomes[0]["failures"]
                rate = (s + 1) / (s + f + 2)
                score += 1.5 * (rate - 0.5)
                notes.append(f"observed success {s}/{s + f} on {task_class}")
            depth = self.models.queue_depth(cfg["provider"])
            if depth:
                score -= 0.3 * depth
                notes.append(f"queue depth {depth}")
            if cfg.get("size_bytes") and cfg["provider_kind"] == "local":
                need_mb = cfg["size_bytes"] / (1024 * 1024)
                if need_mb > available_mb * 1.1:
                    score -= 2
                    notes.append(f"may not fit in available memory ({int(available_mb)} MB free)")
            if cfg["provider_kind"] == "hosted":
                score -= 0.5
                notes.append("hosted fallback")
            entry.update({"score": round(score, 3), "notes": notes})
            considered.append(entry)
            if best is None or score > best[0]:
                best = (score, cfg, notes)
        if best is None:
            return RouteDecision(None, None, None, task_class, complexity,
                                 "no installed, connected and permitted model is available", considered)
        _, cfg, notes = best
        reason = f"{task_class}/{complexity} task; " + (", ".join(notes) if notes else "best available general model")
        return RouteDecision(cfg["id"], cfg["name"], cfg["provider"], task_class, complexity, reason, considered)
