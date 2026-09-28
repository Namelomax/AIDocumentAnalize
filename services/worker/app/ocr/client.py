"""Client for a locally hosted OCR model behind an OpenAI-compatible
/chat/completions endpoint (multimodal: a text prompt plus one image).

Same architecture decision as app.llm.provider (plan 8, decision 3): the
model is behind an interface, not a name. This module never mentions
"glm-ocr" - it only knows a base URL and a model string, both taken from
configuration. Probed manually against LM Studio serving glm-ocr (see
app.ocr.tiling's own docstring for the raw response shape): the model
answers in plain text, one recognized line per line of the answer, no boxes
and no structured markup - so this client hands callers that raw text back
unparsed, unlike app.llm.provider's complete_json. Every failure mode -
not configured, unreachable, past the timeout, a response with no message
content - raises LlmUnavailable, the same exception app.llm.provider raises,
so a caller already used to degrading a missing/unreachable model (Global
Constraint "Без модели система работает") treats a missing/unreachable OCR
model exactly the same way.
"""

import asyncio
import base64
import json
import logging
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any

from app.llm.provider import LlmUnavailable
from app.metrics import ocr_request_duration_seconds

logger = logging.getLogger(__name__)

# Russian, since it is talking to a model that will otherwise happily
# "help" by translating, correcting spelling, or summarizing the page -
# every one of which would invent text the ТЗ's OCR metric (Character
# Accuracy against the real text layer) must never see credited to OCR.
_PROMPT = (
    "Распознай весь видимый текст на изображении. Выведи каждую распознанную "
    "строку текста на отдельной строке вывода, в порядке сверху вниз. Не "
    "переводи, не исправляй и не дополняй текст, не добавляй комментарии. "
    "Если текст неразборчив, пропусти его, не придумывай."
)


@dataclass(frozen=True)
class OcrProvider:
    """A single OpenAI-compatible chat endpoint that accepts an image, the
    same base_url/model/timeout_s shape as app.llm.provider.ChatProvider."""

    base_url: str
    model: str
    timeout_s: float

    async def recognize_text(self, png: bytes) -> str:
        """One image's raw OCR answer (usually one strip of a page, see
        app.ocr.tiling), stripped of leading/trailing whitespace. Runs the
        blocking HTTP call in a worker thread, same reason as
        ChatProvider.complete_json: a slow local model call must never block
        the event loop the rest of the pipeline runs on.
        """
        started = time.monotonic()
        try:
            payload = await asyncio.to_thread(self._call, png)
            content = self._extract_message_content(payload)
        finally:
            ocr_request_duration_seconds.observe(time.monotonic() - started)
        return content.strip()

    def _call(self, png: bytes) -> Any:
        url = f"{self.base_url.rstrip('/')}/chat/completions"
        data_uri = "data:image/png;base64," + base64.b64encode(png).decode("ascii")
        body = json.dumps({
            "model": self.model,
            # Deterministic reads matter more than varied ones here, same
            # reasoning as ChatProvider - and it keeps repeated calls over
            # the same strip (a retried page) reproducible.
            "temperature": 0,
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "text", "text": _PROMPT},
                    {"type": "image_url", "image_url": {"url": data_uri}},
                ],
            }],
        }).encode("utf-8")
        request = urllib.request.Request(
            url, data=body, headers={"Content-Type": "application/json"}, method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_s) as response:
                raw = response.read()
        except (urllib.error.URLError, OSError) as exc:
            raise LlmUnavailable(f"OCR model unreachable: {exc}") from exc
        try:
            return json.loads(raw)
        except json.JSONDecodeError as exc:
            raise LlmUnavailable(f"OCR model returned malformed JSON: {exc}") from exc

    @staticmethod
    def _extract_message_content(payload: Any) -> str:
        try:
            return payload["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as exc:
            raise LlmUnavailable(f"OCR model response had no message content: {exc}") from exc


def ocr_provider_from_config(config) -> "OcrProvider | None":
    """None means OCR is off - config.ocr_model is empty (see Config's own
    comment) or, defensively, no base URL ended up configured either way.
    Callers must treat that the same as LlmUnavailable: the page stays
    needs_ocr with a LOW_QUALITY status (app.pipeline), not an error.
    """
    if not config.ocr_model or not config.ocr_base_url:
        return None
    return OcrProvider(
        base_url=config.ocr_base_url, model=config.ocr_model, timeout_s=config.ocr_timeout_s,
    )
