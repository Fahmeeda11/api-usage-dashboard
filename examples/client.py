"""
Minimal Python ingest client.

Same two rules as the TypeScript version, for the same reasons:

  1. BUFFER. One HTTP request per LLM call doubles your request count and adds
     the tracker's latency to every call. Buffer and flush on a timer.
  2. NEVER RAISE. Telemetry that can break the thing it measures is worse than
     no telemetry. Every failure path here swallows and moves on.

Dependencies: requests (or swap in httpx - the shape does not change).

Drop this next to your RAG pipeline or eval harness and wrap the model call.
"""

from __future__ import annotations

import atexit
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Iterable, TypeVar

import requests

T = TypeVar("T")


@dataclass
class UsageClient:
    api_key: str
    project: str
    base_url: str = "http://localhost:4001"
    flush_interval_s: float = 5.0
    max_batch_size: int = 100
    on_error: Callable[[Exception], None] | None = None

    _queue: list[dict[str, Any]] = field(default_factory=list, init=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, init=False)
    _stop: threading.Event = field(default_factory=threading.Event, init=False)
    _thread: threading.Thread | None = field(default=None, init=False)

    def __post_init__(self) -> None:
        # daemon=True so a forgotten close() cannot hang interpreter shutdown;
        # the atexit hook below still gets a chance to flush first.
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        atexit.register(self.close)

    # ------------------------------------------------------------------ #

    def track(
        self,
        *,
        provider: str,
        model: str,
        prompt_tokens: int = 0,
        completion_tokens: int = 0,
        cost_usd: float = 0.0,
        latency_ms: int = 0,
        status: str = "ok",
        project: str | None = None,
        metadata: dict[str, Any] | None = None,
        occurred_at: datetime | None = None,
    ) -> None:
        """Record an event. Returns immediately; the send happens on flush."""
        event: dict[str, Any] = {
            "project": project or self.project,
            "provider": provider,
            "model": model,
            "promptTokens": prompt_tokens,
            "completionTokens": completion_tokens,
            "costUsd": cost_usd,
            "latencyMs": latency_ms,
            "status": status,
            "occurredAt": (occurred_at or datetime.now(timezone.utc)).isoformat(),
        }
        if metadata:
            event["metadata"] = metadata

        with self._lock:
            self._queue.append(event)
            should_flush = len(self._queue) >= self.max_batch_size

        if should_flush:
            self.flush()

    def wrap(
        self,
        fn: Callable[[], T],
        *,
        provider: str,
        model: str,
        project: str | None = None,
        **extra: Any,
    ) -> T:
        """
        Time a call and record it either way.

        Recording failures matters: a call that raised still cost latency and
        often tokens, and leaving failures out makes the error rate look perfect
        exactly when it is not.
        """
        started = time.monotonic()
        try:
            result = fn()
        except Exception:
            self.track(
                provider=provider,
                model=model,
                project=project,
                latency_ms=int((time.monotonic() - started) * 1000),
                status="error",
                **extra,
            )
            raise
        else:
            self.track(
                provider=provider,
                model=model,
                project=project,
                latency_ms=int((time.monotonic() - started) * 1000),
                status="ok",
                **extra,
            )
            return result

    # ------------------------------------------------------------------ #

    def flush(self) -> None:
        with self._lock:
            if not self._queue:
                return
            # Take the batch out first, so events recorded during the request
            # are not lost when the queue is cleared afterwards.
            batch = self._queue[: self.max_batch_size]
            del self._queue[: self.max_batch_size]

        try:
            response = requests.post(
                f"{self.base_url}/v1/events",
                json={"events": batch},
                headers={"Authorization": f"Bearer {self.api_key}"},
                timeout=10,
            )

            if response.status_code == 429:
                # Rate limited - put the batch back and let the next flush retry.
                with self._lock:
                    self._queue[0:0] = batch
                return

            if response.status_code >= 400 and self.on_error:
                self.on_error(RuntimeError(f"Ingest failed: {response.status_code}"))

        except Exception as exc:  # noqa: BLE001 - telemetry must never raise
            # Drop the batch rather than growing an unbounded queue. Telemetry
            # must never become the reason a process runs out of memory.
            if self.on_error:
                self.on_error(exc)

    def _run(self) -> None:
        while not self._stop.wait(self.flush_interval_s):
            self.flush()

    def close(self) -> None:
        """Flush and stop. Idempotent, so the atexit hook is safe."""
        if self._stop.is_set():
            return
        self._stop.set()
        self.flush()


# ---------------------------------------------------------------------- #
# Usage
# ---------------------------------------------------------------------- #

# import os
# from anthropic import Anthropic
#
# usage = UsageClient(
#     api_key=os.environ["USAGE_API_KEY"],
#     project="production-rag-system",
# )
# client = Anthropic()
#
# response = client.messages.create(
#     model="claude-opus-5",
#     max_tokens=1024,
#     messages=[{"role": "user", "content": "..."}],
# )
#
# usage.track(
#     provider="anthropic",
#     model="claude-opus-5",
#     prompt_tokens=response.usage.input_tokens,
#     completion_tokens=response.usage.output_tokens,
#     cost_usd=estimate_cost(response.usage),
#     metadata={"stage": "answer-synthesis"},
# )
#
# usage.close()
