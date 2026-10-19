from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import asdict, dataclass, field
from typing import Any, Awaitable, Callable

TokenCallback = Callable[[str], Awaitable[None] | None]


class ProviderUnavailable(RuntimeError):
    pass


class ModelOutputError(ValueError):
    pass


@dataclass
class ModelInfo:
    provider: str
    name: str
    installed: bool = True
    context_length: int | None = None
    quantization: str | None = None
    family: str | None = None
    parameter_size: str | None = None
    size_bytes: int | None = None
    capabilities: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class ChatMessage:
    role: str
    content: str


@dataclass
class GenerationResult:
    text: str
    model: str
    provider: str
    input_tokens: int | None = None
    output_tokens: int | None = None
    latency_ms: int = 0
    finish_reason: str | None = None


class ModelProvider(ABC):
    id: str
    kind: str  # "local" or "hosted"
    display_name: str

    @abstractmethod
    async def health(self) -> dict[str, Any]:
        """Return {"ok": bool, "detail": str, ...}. Must not raise for an unreachable runtime."""

    @abstractmethod
    async def list_models(self) -> list[ModelInfo]:
        ...

    @abstractmethod
    async def chat(
        self,
        model: str,
        messages: list[ChatMessage],
        *,
        json_schema: dict[str, Any] | None = None,
        max_tokens: int = 1024,
        temperature: float = 0.2,
        num_ctx: int | None = None,
        timeout_s: float = 120,
        on_token: TokenCallback | None = None,
    ) -> GenerationResult:
        ...

    async def loaded_models(self) -> list[str]:
        return []

    async def aclose(self) -> None:
        return None
