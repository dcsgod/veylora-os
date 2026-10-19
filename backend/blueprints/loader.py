from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import yaml

from backend.security.paths import resolve_within

BLUEPRINTS_DIR = Path(__file__).resolve().parent


class BlueprintError(ValueError):
    pass


@dataclass(frozen=True)
class Blueprint:
    name: str
    title: str
    description: str
    runtime: str
    start: tuple[str, ...]
    components: dict[str, tuple[str, ...]]
    browser_checks: str | None
    root: Path
    substitutions: dict[str, str] = field(default_factory=dict)

    @property
    def files_root(self) -> Path:
        return self.root / "files"

    def all_files(self) -> list[str]:
        return [f for files in self.components.values() for f in files]

    def test_files(self) -> list[str]:
        return [f for f in self.all_files() if f.startswith("test/") and f.endswith(".test.mjs")]

    def read(self, rel: str, substitutions: dict[str, str] | None = None) -> str:
        path = resolve_within(self.files_root, rel)
        if not path.is_file():
            raise BlueprintError(f"blueprint {self.name} is missing file {rel}")
        text = path.read_text(encoding="utf-8")
        for key, value in (substitutions or {}).items():
            text = text.replace("{{" + key + "}}", value)
        return text


def load_blueprint(name: str, base: Path = BLUEPRINTS_DIR) -> Blueprint:
    if not name.replace("-", "").isalnum():
        raise BlueprintError(f"invalid blueprint name {name!r}")
    root = base / name
    manifest = root / "blueprint.yaml"
    if not manifest.is_file():
        raise BlueprintError(f"unknown blueprint {name!r}")
    data = yaml.safe_load(manifest.read_text(encoding="utf-8")) or {}
    components = {k: tuple(v.get("files", [])) for k, v in (data.get("components") or {}).items()}
    if "scaffold" not in components:
        raise BlueprintError(f"blueprint {name} has no scaffold component")
    bp = Blueprint(name=data.get("name", name), title=data.get("title", name), description=data.get("description", ""),
                   runtime=data.get("runtime", "node"), start=tuple(data.get("start", [])), components=components,
                   browser_checks=data.get("browser_checks"), root=root)
    missing = [f for f in bp.all_files() if not (bp.files_root / f).is_file()]
    if missing:
        raise BlueprintError(f"blueprint {name} references missing files: {missing}")
    return bp


def list_blueprints(base: Path = BLUEPRINTS_DIR) -> list[dict]:
    out = []
    for d in sorted(base.iterdir()):
        if (d / "blueprint.yaml").is_file():
            bp = load_blueprint(d.name, base)
            out.append({"name": bp.name, "title": bp.title, "description": bp.description,
                        "components": {k: list(v) for k, v in bp.components.items()}})
    return out
