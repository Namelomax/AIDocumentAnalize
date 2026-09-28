"""Client for a locally hosted language model behind an OpenAI-compatible
/chat/completions endpoint.

Architecture decision 3 (plan 8): the model is behind an interface, not a
name. This module never mentions a model family; it only knows a base URL
and a model string, both taken from configuration. In development that
configuration points at LM Studio; on the stand it points at vLLM. If the
configuration is empty the model is simply off (see provider_from_config),
and every other failure mode -- unreachable server, a response past the
timeout, a response that is not the JSON shape a caller asked for -- raises
LlmUnavailable rather than raising an arbitrary exception or hanging, so a
package can still finish processing without a model (plan Global Constraint
"Без модели система работает").
"""

import asyncio
import json
import logging
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any

from app.metrics import llm_request_duration_seconds, llm_requests_total

logger = logging.getLogger(__name__)


class LlmUnavailable(Exception):
    """The model could not be used for this call: not configured, unreachable,
    too slow, or its answer was not (or did not contain) the JSON callers
    asked for. Callers turn this into a NOT_COMPARABLE result rather than
    letting it interrupt a run."""


# Qwen-family models (the development target) sometimes narrate their
# reasoning inline before the answer, as a <think>...</think> block, or wrap
# the JSON itself in a markdown code fence. Both have to be peeled off
# before the payload underneath can be parsed.
_THINK_BLOCK = re.compile(r"<think>.*?</think>", re.DOTALL | re.IGNORECASE)
_CODE_FENCE = re.compile(r"```(?:json)?\s*(.*?)\s*```", re.DOTALL | re.IGNORECASE)
_JSON_START = re.compile(r"[{\[]")


def _extract_json_text(content: str) -> str:
    """Reduce a chat message to the substring that should hold JSON, stripping
    a reasoning block and/or a code fence if either is present."""
    text = _THINK_BLOCK.sub("", content).strip()
    fence_match = _CODE_FENCE.search(text)
    if fence_match:
        text = fence_match.group(1).strip()
    return text


def _parse_json_response(content: str) -> Any:
    text = _extract_json_text(content)
    start_match = _JSON_START.search(text)
    if not start_match:
        raise LlmUnavailable("model response did not contain a JSON object or array")
    # raw_decode stops at the end of the first well-formed value, so any
    # trailing prose after the JSON (chat models rarely stop exactly on cue)
    # does not break parsing.
    try:
        value, _ = json.JSONDecoder().raw_decode(text, start_match.start())
    except json.JSONDecodeError as exc:
        raise LlmUnavailable(f"model response was not valid JSON: {exc}") from exc
    return value


@dataclass(frozen=True)
class ChatProvider:
    """A single OpenAI-compatible chat endpoint, configured only with the
    address and model name a deployment supplies -- never a literal model
    name elsewhere in this codebase."""

    base_url: str
    model: str
    timeout_s: float

    async def complete_json(self, system: str, user: str) -> Any:
        """Ask the model for a JSON answer and return it already parsed.

        The blocking HTTP call runs in a worker thread (asyncio.to_thread)
        so a several-second local model call never blocks the event loop
        the rest of the pipeline runs on; no HTTP dependency is added, per
        the plan's "no new dependency" constraint.
        """
        started = time.monotonic()
        try:
            payload = await asyncio.to_thread(self._call, system, user)
            content = self._extract_message_content(payload)
            result = _parse_json_response(content)
        except LlmUnavailable:
            llm_requests_total.labels(result="error").inc()
            llm_request_duration_seconds.observe(time.monotonic() - started)
            raise
        elapsed_s = time.monotonic() - started

        llm_requests_total.labels(result="ok").inc()
        llm_request_duration_seconds.observe(elapsed_s)

        usage = payload.get("usage") if isinstance(payload, dict) else None
        logger.info("llm call completed", extra={
            "base_url": self.base_url,
            "model": self.model,
            "elapsed_s": round(elapsed_s, 3),
            "prompt_tokens": usage.get("prompt_tokens") if usage else None,
            "completion_tokens": usage.get("completion_tokens") if usage else None,
        })
        return result

    def _call(self, system: str, user: str) -> Any:
        url = f"{self.base_url.rstrip('/')}/chat/completions"
        body = json.dumps({
            "model": self.model,
            # A deterministic answer matters more than a varied one here:
            # callers compare the model's verdict against a JSON schema,
            # not its prose, and temperature 0 makes runs reproducible.
            "temperature": 0,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        }).encode("utf-8")
        request = urllib.request.Request(
            url,
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_s) as response:
                raw = response.read()
        except (urllib.error.URLError, OSError) as exc:
            # URLError covers HTTP-level failures (connection refused, DNS);
            # OSError also catches a socket timeout, which some urllib
            # versions raise directly rather than wrapped in URLError.
            raise LlmUnavailable(f"language model unreachable: {exc}") from exc
        try:
            return json.loads(raw)
        except json.JSONDecodeError as exc:
            raise LlmUnavailable(f"language model returned malformed JSON: {exc}") from exc

    @staticmethod
    def _extract_message_content(payload: Any) -> str:
        try:
            return payload["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as exc:
            raise LlmUnavailable(f"model response had no message content: {exc}") from exc


def provider_from_config(config) -> "ChatProvider | None":
    """None means no model is configured; callers must treat that the same
    as LlmUnavailable -- a NOT_COMPARABLE result, not an error."""
    if not config.llm_base_url:
        return None
    return ChatProvider(
        base_url=config.llm_base_url,
        model=config.llm_model,
        timeout_s=config.llm_timeout_s,
    )
