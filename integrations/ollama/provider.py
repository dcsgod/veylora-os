from __future__ import annotations

import inspect
import json
import time
from typing import Any

import httpx

from backend.models.base import (
    ChatMessage, GenerationResult, ModelInfo, ModelProvider, ProviderUnavailable, TokenCallback,
)


class OllamaProvider(ModelProvider):
    kind = "local"
    display_name = "Ollama"

    def __init__(self, base_url: str = "http://127.0.0.1:11434", provider_id: str = "ollama"):
        self.id = provider_id
        self.base_url = base_url.rstrip("/")
        self._client = httpx.AsyncClient(base_url=self.base_url, timeout=httpx.Timeout(10.0, read=None))

    async def aclose(self) -> None:
        await self._client.aclose()

    async def health(self) -> dict[str, Any]:
        try:
            r = await self._client.get("/api/version", timeout=3)
            r.raise_for_status()
            return {"ok": True, "detail": "reachable", "version": r.json().get("version"), "url": self.base_url}
        except (httpx.HTTPError, ValueError) as exc:
            return {"ok": False, "detail": f"Ollama not reachable at {self.base_url}: {exc.__class__.__name__}", "url": self.base_url}

    async def list_models(self) -> list[ModelInfo]:
        try:
            r = await self._client.get("/api/tags", timeout=5)
            r.raise_for_status()
        except httpx.HTTPError as exc:
            raise ProviderUnavailable(f"Ollama not reachable: {exc}") from exc
        models: list[ModelInfo] = []
        for m in r.json().get("models", []):
            details = m.get("details") or {}
            info = ModelInfo(
                provider=self.id,
                name=m["name"],
                installed=True,
                family=details.get("family"),
                parameter_size=details.get("parameter_size"),
                quantization=details.get("quantization_level"),
                size_bytes=m.get("size"),
                metadata={"digest": m.get("digest"), "modified_at": m.get("modified_at"), "format": details.get("format")},
            )
            await self._enrich(info)
            models.append(info)
        return models

    async def _enrich(self, info: ModelInfo) -> None:
        try:
            r = await self._client.post("/api/show", json={"model": info.name}, timeout=10)
            r.raise_for_status()
            data = r.json()
        except (httpx.HTTPError, ValueError):
            return
        model_info = data.get("model_info") or {}
        for key, val in model_info.items():
            if key.endswith(".context_length") and isinstance(val, int):
                info.context_length = val
                break
        caps = data.get("capabilities")
        if isinstance(caps, list):
            info.capabilities = [str(c) for c in caps]
            info.metadata["capabilities_source"] = "runtime"
        else:
            info.metadata["capabilities_source"] = "unknown"

    async def loaded_models(self) -> list[str]:
        try:
            r = await self._client.get("/api/ps", timeout=3)
            r.raise_for_status()
            return [m["name"] for m in r.json().get("models", [])]
        except (httpx.HTTPError, ValueError, KeyError):
            return []

    async def chat(self, model, messages, *, json_schema=None, max_tokens=1024, temperature=0.2, num_ctx=None,
                   timeout_s=120, on_token: TokenCallback | None = None) -> GenerationResult:
        body: dict[str, Any] = {
            "model": model,
            "messages": [{"role": m.role, "content": m.content} for m in messages],
            "stream": True,
            "options": {"num_predict": max_tokens, "temperature": temperature},
        }
        if num_ctx:
            body["options"]["num_ctx"] = num_ctx
        if json_schema is not None:
            body["format"] = json_schema
        start = time.monotonic()
        parts: list[str] = []
        final: dict[str, Any] = {}
        try:
            async with self._client.stream("POST", "/api/chat", json=body, timeout=httpx.Timeout(10.0, read=timeout_s)) as resp:
                if resp.status_code >= 400:
                    detail = (await resp.aread()).decode(errors="replace")[:500]
                    raise ProviderUnavailable(f"Ollama returned {resp.status_code}: {detail}")
                async for line in resp.aiter_lines():
                    if not line.strip():
                        continue
                    chunk = json.loads(line)
                    if err := chunk.get("error"):
                        raise ProviderUnavailable(f"Ollama error: {err}")
                    piece = (chunk.get("message") or {}).get("content") or ""
                    if piece:
                        parts.append(piece)
                        if on_token:
                            res = on_token(piece)
                            if inspect.isawaitable(res):
                                await res
                    if chunk.get("done"):
                        final = chunk
                        break
        except httpx.HTTPError as exc:
            raise ProviderUnavailable(f"Ollama request failed: {exc.__class__.__name__}: {exc}") from exc
        return GenerationResult(
            text="".join(parts),
            model=model,
            provider=self.id,
            input_tokens=final.get("prompt_eval_count"),
            output_tokens=final.get("eval_count"),
            latency_ms=int((time.monotonic() - start) * 1000),
            finish_reason=final.get("done_reason"),
        )
