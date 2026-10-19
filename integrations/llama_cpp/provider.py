from __future__ import annotations

import inspect
import json
import os
import time
from typing import Any

import httpx

from backend.models.base import (
    ChatMessage, GenerationResult, ModelInfo, ModelProvider, ProviderUnavailable, TokenCallback,
)


class OpenAICompatibleProvider(ModelProvider):
    """Adapter for servers implementing the OpenAI chat-completions protocol (llama.cpp server, hosted APIs)."""

    def __init__(self, provider_id: str, base_url: str, kind: str = "local", display_name: str = "llama.cpp",
                 api_key_env: str | None = None, health_path: str | None = "/health"):
        self.id = provider_id
        self.kind = kind
        self.display_name = display_name
        self.base_url = base_url.rstrip("/")
        self.api_key_env = api_key_env
        self.health_path = health_path
        self._client = httpx.AsyncClient(base_url=self.base_url, timeout=httpx.Timeout(10.0, read=None))

    def _headers(self) -> dict[str, str]:
        if self.api_key_env and (key := os.environ.get(self.api_key_env)):
            return {"Authorization": f"Bearer {key}"}
        return {}

    async def aclose(self) -> None:
        await self._client.aclose()

    async def health(self) -> dict[str, Any]:
        if self.api_key_env and not os.environ.get(self.api_key_env):
            return {"ok": False, "detail": f"credential environment variable {self.api_key_env} is not set", "url": self.base_url}
        path = self.health_path or "/v1/models"
        try:
            r = await self._client.get(path, headers=self._headers(), timeout=3)
            r.raise_for_status()
            return {"ok": True, "detail": "reachable", "url": self.base_url}
        except httpx.HTTPError as exc:
            return {"ok": False, "detail": f"{self.display_name} not reachable at {self.base_url}: {exc.__class__.__name__}", "url": self.base_url}

    async def list_models(self) -> list[ModelInfo]:
        try:
            r = await self._client.get("/v1/models", headers=self._headers(), timeout=5)
            r.raise_for_status()
        except httpx.HTTPError as exc:
            raise ProviderUnavailable(f"{self.display_name} not reachable: {exc}") from exc
        out = []
        for m in r.json().get("data", []):
            meta = m.get("meta") or {}
            out.append(ModelInfo(
                provider=self.id, name=m["id"], installed=self.kind == "local",
                context_length=meta.get("n_ctx_train") or meta.get("n_ctx"),
                metadata={"owned_by": m.get("owned_by"), "capabilities_source": "unknown"},
            ))
        return out

    async def chat(self, model, messages, *, json_schema=None, max_tokens=1024, temperature=0.2, num_ctx=None,
                   timeout_s=120, on_token: TokenCallback | None = None) -> GenerationResult:
        body: dict[str, Any] = {
            "model": model,
            "messages": [{"role": m.role, "content": m.content} for m in messages],
            "max_tokens": max_tokens,
            "temperature": temperature,
            "stream": True,
            "stream_options": {"include_usage": True},
        }
        if json_schema is not None:
            body["response_format"] = {"type": "json_schema", "json_schema": {"name": "output", "schema": json_schema}}
        start = time.monotonic()
        parts: list[str] = []
        usage: dict[str, Any] = {}
        finish = None
        try:
            async with self._client.stream("POST", "/v1/chat/completions", json=body, headers=self._headers(),
                                           timeout=httpx.Timeout(10.0, read=timeout_s)) as resp:
                if resp.status_code >= 400:
                    detail = (await resp.aread()).decode(errors="replace")[:500]
                    raise ProviderUnavailable(f"{self.display_name} returned {resp.status_code}: {detail}")
                async for line in resp.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    chunk = json.loads(data)
                    if chunk.get("usage"):
                        usage = chunk["usage"]
                    for choice in chunk.get("choices") or []:
                        piece = (choice.get("delta") or {}).get("content") or ""
                        finish = choice.get("finish_reason") or finish
                        if piece:
                            parts.append(piece)
                            if on_token:
                                res = on_token(piece)
                                if inspect.isawaitable(res):
                                    await res
        except httpx.HTTPError as exc:
            raise ProviderUnavailable(f"{self.display_name} request failed: {exc}") from exc
        return GenerationResult(
            text="".join(parts), model=model, provider=self.id,
            input_tokens=usage.get("prompt_tokens"), output_tokens=usage.get("completion_tokens"),
            latency_ms=int((time.monotonic() - start) * 1000), finish_reason=finish,
        )


class LlamaCppProvider(OpenAICompatibleProvider):
    def __init__(self, base_url: str = "http://127.0.0.1:8080", provider_id: str = "llama_cpp"):
        super().__init__(provider_id, base_url, kind="local", display_name="llama.cpp server", health_path="/health")
