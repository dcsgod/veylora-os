from __future__ import annotations

import asyncio
import json
import logging
import re
from dataclasses import dataclass
from typing import Any, Type, TypeVar

from pydantic import BaseModel, ValidationError

from backend.models.base import ChatMessage, GenerationResult, ModelInfo, ModelOutputError, ModelProvider, ProviderUnavailable
from backend.persistence.db import Database, new_id, now_iso

log = logging.getLogger("veylora.models")
T = TypeVar("T", bound=BaseModel)

_CODE_HINTS = ("coder", "code", "starcoder", "codellama", "devstral", "codestral", "codegemma")
_EMBED_HINTS = ("embed", "bge-", "minilm", "e5-")

DEFAULT_PROVIDERS = [
    {"id": "ollama", "type": "ollama", "url": "http://127.0.0.1:11434", "enabled": True, "max_concurrency": 1},
    {"id": "llama_cpp", "type": "llama_cpp", "url": "http://127.0.0.1:8080", "enabled": False, "max_concurrency": 1},
    {"id": "hosted", "type": "openai_compatible", "url": "", "api_key_env": "VEYLORA_HOSTED_API_KEY", "enabled": False,
     "max_concurrency": 2},
]


def parse_param_billions(parameter_size: str | None) -> float | None:
    if not parameter_size:
        return None
    m = re.match(r"([\d.]+)\s*([BbMm])", parameter_size)
    if not m:
        return None
    val = float(m.group(1))
    return val / 1000 if m.group(2).lower() == "m" else val


def infer_tags(info: dict[str, Any]) -> list[str]:
    name = info["name"].lower()
    caps = set(info.get("capabilities") or [])
    tags = set(caps)
    if any(h in name for h in _EMBED_HINTS) or ("embedding" in caps and "completion" not in caps):
        tags.add("embedding")
    if any(h in name for h in _CODE_HINTS):
        tags.add("code")
    if not caps and "embedding" not in tags:
        tags.add("completion")
    return sorted(tags)


@dataclass
class _ProviderState:
    provider: ModelProvider
    semaphore: asyncio.Semaphore
    config: dict[str, Any]
    queued: int = 0
    active: int = 0
    health: dict[str, Any] | None = None


class ModelService:
    """Owns provider adapters, persisted model configs, concurrency limits and outcome tracking."""

    def __init__(self, db: Database, publish=None, ollama_url: str | None = None):
        self.db = db
        self.publish = publish
        self.ollama_url = ollama_url
        self.providers: dict[str, _ProviderState] = {}

    def provider_configs(self) -> list[dict[str, Any]]:
        saved = self.db.get_setting("models.providers")
        if saved is not None:
            return saved
        return [{**p, "url": self.ollama_url} if p["id"] == "ollama" and self.ollama_url else dict(p) for p in DEFAULT_PROVIDERS]

    def register(self, provider: ModelProvider, max_concurrency: int = 1, config: dict[str, Any] | None = None) -> None:
        self.providers[provider.id] = _ProviderState(provider, asyncio.Semaphore(max(1, max_concurrency)),
                                                     config or {"id": provider.id, "enabled": True})

    def build_from_settings(self) -> None:
        from integrations.llama_cpp.provider import LlamaCppProvider, OpenAICompatibleProvider
        from integrations.ollama.provider import OllamaProvider

        for cfg in self.provider_configs():
            if not cfg.get("enabled"):
                continue
            ptype = cfg.get("type")
            if ptype == "ollama":
                p: ModelProvider = OllamaProvider(cfg.get("url") or "http://127.0.0.1:11434", cfg["id"])
            elif ptype == "llama_cpp":
                p = LlamaCppProvider(cfg.get("url") or "http://127.0.0.1:8080", cfg["id"])
            elif ptype == "openai_compatible" and cfg.get("url"):
                p = OpenAICompatibleProvider(cfg["id"], cfg["url"], kind="hosted", display_name=cfg.get("name") or "Hosted provider",
                                             api_key_env=cfg.get("api_key_env"), health_path=None)
            else:
                continue
            self.register(p, int(cfg.get("max_concurrency", 1)), cfg)

    async def aclose(self) -> None:
        for st in self.providers.values():
            await st.provider.aclose()

    async def health(self) -> list[dict[str, Any]]:
        out = []
        for pid, st in self.providers.items():
            h = await st.provider.health()
            st.health = h
            loaded = await st.provider.loaded_models() if h.get("ok") else []
            out.append({"provider": pid, "kind": st.provider.kind, "name": st.provider.display_name, **h,
                        "loaded_models": loaded, "queued": st.queued, "active": st.active,
                        "max_concurrency": st.semaphore._value + st.active})
        return out

    async def sync(self) -> dict[str, Any]:
        """Discover models from every enabled provider. Only runtime-confirmed models are marked installed."""
        report: dict[str, Any] = {}
        for pid, st in self.providers.items():
            try:
                models = await st.provider.list_models()
            except ProviderUnavailable as exc:
                report[pid] = {"ok": False, "error": str(exc)}
                st.health = {"ok": False, "detail": str(exc)}
                self.db.execute("UPDATE model_configs SET installed = 0, updated_at = ? WHERE provider = ?", (now_iso(), pid))
                continue
            st.health = {**(st.health or {}), "ok": True}
            seen = set()
            for info in models:
                seen.add(info.name)
                self._upsert(info, st.provider.kind)
            names = list(seen)
            placeholders = ",".join("?" for _ in names) or "''"
            self.db.execute(f"UPDATE model_configs SET installed = 0 WHERE provider = ? AND name NOT IN ({placeholders})",
                            [pid, *names])
            report[pid] = {"ok": True, "models": names}
        if self.publish:
            self.publish("models.synced", payload=report)
        return report

    def _upsert(self, info: ModelInfo, kind: str) -> None:
        existing = self.db.one("SELECT id, metadata FROM model_configs WHERE provider = ? AND name = ?", (info.provider, info.name))
        meta = {**info.metadata, "kind": kind}
        values = {
            "installed": 1 if info.installed else 0,
            "context_length": info.context_length,
            "quantization": info.quantization,
            "family": info.family,
            "parameter_size": info.parameter_size,
            "size_bytes": info.size_bytes,
            "capabilities": infer_tags(info.to_dict()),
            "metadata": meta,
            "last_seen_at": now_iso(),
            "updated_at": now_iso(),
        }
        if existing:
            self.db.update("model_configs", existing["id"], values)
        else:
            self.db.insert("model_configs", {"id": new_id("mdl"), "provider": info.provider, "name": info.name,
                                             "enabled": 1, "role_assignments": [], "max_concurrency": 1, **values})

    def list_configs(self) -> list[dict[str, Any]]:
        rows = self.db.all("SELECT * FROM model_configs ORDER BY provider, name")
        outcomes = self.db.all("SELECT * FROM model_outcomes")
        by_model: dict[str, list[dict]] = {}
        for o in outcomes:
            by_model.setdefault(o["model_id"], []).append(o)
        for r in rows:
            r["outcomes"] = by_model.get(r["id"], [])
            st = self.providers.get(r["provider"])
            r["provider_kind"] = st.provider.kind if st else (r["metadata"] or {}).get("kind", "local")
            r["provider_connected"] = bool(st and st.health and st.health.get("ok"))
        return rows

    def get_config(self, model_id: str) -> dict[str, Any] | None:
        return self.db.one("SELECT * FROM model_configs WHERE id = ?", (model_id,))

    def queue_depth(self, provider_id: str) -> int:
        st = self.providers.get(provider_id)
        return (st.queued + st.active) if st else 0

    def record_outcome(self, model_id: str, task_class: str, success: bool, latency_ms: int = 0) -> None:
        self.db.execute(
            "INSERT INTO model_outcomes(model_id, task_class, successes, failures, total_latency_ms) VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT(model_id, task_class) DO UPDATE SET successes = successes + excluded.successes, "
            "failures = failures + excluded.failures, total_latency_ms = total_latency_ms + excluded.total_latency_ms",
            (model_id, task_class, 1 if success else 0, 0 if success else 1, latency_ms),
        )

    async def generate(self, model_id: str, messages: list[ChatMessage], *, json_schema: dict | None = None,
                       max_tokens: int = 1024, temperature: float = 0.2, num_ctx: int | None = None,
                       timeout_s: float = 120, on_token=None) -> GenerationResult:
        cfg = self.get_config(model_id)
        if not cfg:
            raise ProviderUnavailable(f"unknown model {model_id}")
        st = self.providers.get(cfg["provider"])
        if not st:
            raise ProviderUnavailable(f"provider {cfg['provider']} is not enabled")
        st.queued += 1
        try:
            await st.semaphore.acquire()
        finally:
            st.queued -= 1
        st.active += 1
        try:
            return await asyncio.wait_for(
                st.provider.chat(cfg["name"], messages, json_schema=json_schema, max_tokens=max_tokens,
                                 temperature=temperature, num_ctx=num_ctx, timeout_s=timeout_s, on_token=on_token),
                timeout=timeout_s,
            )
        except asyncio.TimeoutError as exc:
            raise ProviderUnavailable(f"model {cfg['name']} timed out after {timeout_s}s") from exc
        finally:
            st.active -= 1
            st.semaphore.release()

    async def generate_structured(self, model_id: str, messages: list[ChatMessage], schema: Type[T], *,
                                  max_tokens: int = 1024, timeout_s: float = 120, attempts: int = 2,
                                  on_token=None) -> tuple[T, GenerationResult]:
        """Generate JSON constrained to a Pydantic schema and validate it. Invalid output is never accepted."""
        json_schema = schema.model_json_schema()
        convo = list(messages)
        last_error = ""
        for _ in range(max(1, attempts)):
            result = await self.generate(model_id, convo, json_schema=json_schema, max_tokens=max_tokens,
                                         timeout_s=timeout_s, on_token=on_token)
            try:
                return schema.model_validate_json(_extract_json(result.text)), result
            except (ValidationError, ValueError) as exc:
                last_error = str(exc)[:800]
                convo = convo + [ChatMessage("assistant", result.text[:4000]),
                                 ChatMessage("user", f"The output was invalid: {last_error}\nReturn only valid JSON matching the schema.")]
        raise ModelOutputError(f"model output failed schema validation: {last_error}")


def _extract_json(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\n?", "", text)
        text = re.sub(r"\n?```$", "", text)
    start = min([i for i in (text.find("{"), text.find("[")) if i >= 0], default=-1)
    if start > 0:
        text = text[start:]
    json.loads(text)
    return text
