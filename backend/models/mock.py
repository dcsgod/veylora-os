from __future__ import annotations

import asyncio
import json
from typing import Any, Callable

from backend.models.base import ChatMessage, GenerationResult, ModelInfo, ModelProvider, ProviderUnavailable

Responder = Callable[[str, list[ChatMessage], dict[str, Any] | None], str]


class MockProvider(ModelProvider):
    """Deterministic provider for tests and offline demos. Never presented as a real model runtime."""

    kind = "local"
    display_name = "Mock (deterministic test runtime)"

    def __init__(self, provider_id: str = "mock", models: list[str] | None = None, responder: Responder | None = None,
                 available: bool = True, delay_s: float = 0.0):
        self.id = provider_id
        self.models = models or ["mock-instruct", "mock-coder"]
        self.responder = responder or self._default
        self.available = available
        self.delay_s = delay_s
        self.calls: list[dict[str, Any]] = []

    @staticmethod
    def _default(model: str, messages: list[ChatMessage], schema: dict[str, Any] | None) -> str:
        if schema is not None:
            props = schema.get("properties", {})
            return json.dumps({k: _placeholder(v) for k, v in props.items()})
        return f"[mock:{model}] " + messages[-1].content[:200]

    async def health(self) -> dict[str, Any]:
        return {"ok": self.available, "detail": "mock runtime" if self.available else "mock runtime offline"}

    async def list_models(self) -> list[ModelInfo]:
        if not self.available:
            raise ProviderUnavailable("mock runtime offline")
        return [ModelInfo(provider=self.id, name=m, context_length=8192, family="mock",
                          capabilities=["completion"] + (["code"] if "coder" in m else []),
                          metadata={"capabilities_source": "runtime"}) for m in self.models]

    async def chat(self, model, messages, *, json_schema=None, max_tokens=1024, temperature=0.2, num_ctx=None,
                   timeout_s=120, on_token=None) -> GenerationResult:
        if not self.available:
            raise ProviderUnavailable("mock runtime offline")
        self.calls.append({"model": model, "messages": messages, "schema": json_schema})
        if self.delay_s:
            await asyncio.sleep(self.delay_s)
        text = self.responder(model, messages, json_schema)
        if on_token:
            res = on_token(text)
            if asyncio.iscoroutine(res):
                await res
        return GenerationResult(text=text, model=model, provider=self.id, input_tokens=None, output_tokens=None, latency_ms=1)


def _placeholder(prop: dict[str, Any]) -> Any:
    t = prop.get("type")
    if t == "array":
        return []
    if t == "object":
        return {}
    if t in ("integer", "number"):
        return 0
    if t == "boolean":
        return False
    return "mock"
