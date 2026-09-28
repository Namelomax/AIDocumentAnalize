"""Unit tests for app.ocr.client (the OpenAI-compatible OCR client) and
app.ocr.tiling (the horizontal-strip strategy that turns its plain-text
answers into lines with boxes) against a fake /chat/completions server, in
the shape of test_llm_provider.py's own fake server - the pipeline's own
degradation policy (unavailable model -> LOW_QUALITY, never an error) is
exercised the same way LlmUnavailable already is for the free-search model.
"""

import http.server
import json
import threading

import pymupdf
import pytest

from app.ocr.client import OcrProvider, ocr_provider_from_config
from app.ocr.tiling import ocr_page
from app.llm.provider import LlmUnavailable


class _FakeConfig:
    def __init__(self, ocr_base_url="", ocr_model="", ocr_timeout_s=5.0):
        self.ocr_base_url = ocr_base_url
        self.ocr_model = ocr_model
        self.ocr_timeout_s = ocr_timeout_s


class _FakeOcrServer:
    """A one-test /chat/completions endpoint. handler_fn(body: bytes) ->
    (status, response_bytes) decides the answer; every request it saw is
    appended to .requests for a test to inspect (e.g. how many strips a page
    was actually cut into)."""

    def __init__(self, handler_fn):
        self.requests = []
        outer = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args):  # keep pytest output quiet
                pass

            def do_POST(self):
                length = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(length)
                outer.requests.append(json.loads(body))
                status, response_body = handler_fn(body)
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(response_body)

        self.server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_port}/v1"

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


def _openai_response(content: str) -> bytes:
    return json.dumps({"choices": [{"message": {"content": content}}]}).encode("utf-8")


def _provider(server: _FakeOcrServer, timeout_s: float = 5.0) -> OcrProvider:
    return OcrProvider(base_url=server.base_url, model="glm-ocr", timeout_s=timeout_s)


def _one_page_pdf(width: float, height: float, rotation: int = 0) -> bytes:
    document = pymupdf.open()
    page = document.new_page(width=width, height=height)
    page.set_rotation(rotation)
    raw = document.tobytes()
    document.close()
    return raw


# ─────────────────────── app.ocr.client.OcrProvider ───────────────────────

@pytest.mark.asyncio
async def test_recognize_text_returns_the_stripped_message_content():
    server = _FakeOcrServer(lambda body: (200, _openai_response("  строка текста  \n")))
    try:
        text = await _provider(server).recognize_text(b"\x89PNG fake bytes")
    finally:
        server.close()
    assert text == "строка текста"


@pytest.mark.asyncio
async def test_recognize_text_sends_the_image_as_a_data_uri():
    server = _FakeOcrServer(lambda body: (200, _openai_response("ok")))
    try:
        await _provider(server).recognize_text(b"\x89PNGabc")
    finally:
        server.close()
    content = server.requests[0]["messages"][0]["content"]
    image_part = next(part for part in content if part["type"] == "image_url")
    assert image_part["image_url"]["url"].startswith("data:image/png;base64,")


@pytest.mark.asyncio
async def test_recognize_text_raises_llm_unavailable_on_connection_refused():
    provider = OcrProvider(base_url="http://127.0.0.1:1", model="glm-ocr", timeout_s=1.0)
    with pytest.raises(LlmUnavailable):
        await provider.recognize_text(b"\x89PNG")


def test_ocr_provider_from_config_is_none_when_model_is_empty():
    assert ocr_provider_from_config(_FakeConfig(ocr_base_url="http://x/v1", ocr_model="")) is None


def test_ocr_provider_from_config_is_none_when_base_url_is_empty():
    assert ocr_provider_from_config(_FakeConfig(ocr_base_url="", ocr_model="glm-ocr")) is None


def test_ocr_provider_from_config_builds_a_provider_when_both_are_set():
    config = _FakeConfig(ocr_base_url="http://127.0.0.1:1234/v1", ocr_model="glm-ocr", ocr_timeout_s=30.0)
    provider = ocr_provider_from_config(config)
    assert provider == OcrProvider(base_url="http://127.0.0.1:1234/v1", model="glm-ocr", timeout_s=30.0)


# ──────────────────────────── app.ocr.tiling.ocr_page ───────────────────────

@pytest.mark.asyncio
async def test_ocr_page_without_a_provider_is_low_quality_and_makes_no_request():
    raw = _one_page_pdf(200, 400)
    result = await ocr_page(raw, 1, None, dpi=72, strip_height_px=100)
    assert result.lines == []
    assert result.quality_status == "LOW_QUALITY"


@pytest.mark.asyncio
async def test_ocr_page_splits_a_plain_text_answer_into_lines_with_boxes():
    """glm-ocr answers with plain text, one recognized line per output line
    (probed manually - see app.ocr.tiling's own docstring); each strip's
    lines get an equal share of the strip's own box, spanning the full page
    width (never a column the model did not actually report)."""
    server = _FakeOcrServer(lambda body: (200, _openai_response("первая строка\nвторая строка\n")))
    raw = _one_page_pdf(200, 100)  # a single strip covers the whole page at these settings
    try:
        result = await ocr_page(
            raw, 1, _provider(server), dpi=72, strip_height_px=100,
        )
    finally:
        server.close()

    assert result.quality_status is None
    assert [line.text for line in result.lines] == ["первая строка", "вторая строка"]
    first, second = result.lines
    # Both lines came from the one strip covering the whole page: an equal
    # split of [0;1] into two bands, in the order the model printed them.
    assert first.tile_no == 0 and second.tile_no == 0
    assert first.line_no == 0 and second.line_no == 1
    assert first.box.x0 == 0.0 and first.box.x1 == 1.0
    assert first.box.y0 == pytest.approx(0.0)
    assert first.box.y1 == pytest.approx(0.5)
    assert second.box.y0 == pytest.approx(0.5)
    assert second.box.y1 == pytest.approx(1.0)
    for line in result.lines:
        assert 0.0 <= line.box.y0 <= line.box.y1 <= 1.0


@pytest.mark.asyncio
async def test_ocr_page_empty_model_answer_is_low_quality():
    server = _FakeOcrServer(lambda body: (200, _openai_response("   \n  \n")))
    raw = _one_page_pdf(200, 100)
    try:
        result = await ocr_page(raw, 1, _provider(server), dpi=72, strip_height_px=100)
    finally:
        server.close()
    assert result.lines == []
    assert result.quality_status == "LOW_QUALITY"


@pytest.mark.asyncio
async def test_ocr_page_degrades_to_low_quality_when_the_model_is_unreachable():
    """The server refuses every connection outright - every strip's own call
    raises LlmUnavailable, exactly like a page with no model configured; the
    page still finishes as LOW_QUALITY rather than failing the file."""
    provider = OcrProvider(base_url="http://127.0.0.1:1", model="glm-ocr", timeout_s=1.0)
    raw = _one_page_pdf(200, 100)

    result = await ocr_page(raw, 1, provider, dpi=72, strip_height_px=100)

    assert result.lines == []
    assert result.quality_status == "LOW_QUALITY"


@pytest.mark.asyncio
async def test_ocr_page_keeps_the_lines_of_strips_that_did_answer():
    """One strip failing (a transient error) must not cost the whole page
    its other, successfully-read strips."""
    calls = {"n": 0}

    def handler(body):
        calls["n"] += 1
        if calls["n"] == 1:
            return 500, b"{}"
        return 200, _openai_response("строка со второй полосы")

    server = _FakeOcrServer(handler)
    # Two strips: a 200pt-tall page cut into 100pt strips.
    raw = _one_page_pdf(200, 200)
    try:
        result = await ocr_page(raw, 1, _provider(server), dpi=72, strip_height_px=100)
    finally:
        server.close()

    assert result.quality_status is None
    assert [line.text for line in result.lines] == ["строка со второй полосы"]
    # The surviving line came from the second strip (tile_no=1), the lower
    # half of the page - it must not be reported as if it were the first.
    assert result.lines[0].tile_no == 1
    assert result.lines[0].box.y0 == pytest.approx(0.5)


@pytest.mark.asyncio
async def test_ocr_page_strip_count_honours_rotation():
    """page.rect (and therefore the strip count) must reflect the *displayed*
    page - the same rotated space app.pdf.extract and render_page_png work
    in - not the PDF's own unrotated page size.

    A 200x800 page rotated 90 degrees displays as 800 wide by 200 tall,
    which a 100pt strip height covers in 2 strips; read unrotated (800 tall)
    it would take 8.
    """
    server = _FakeOcrServer(lambda body: (200, _openai_response("строка")))
    raw = _one_page_pdf(200, 800, rotation=90)
    try:
        await ocr_page(raw, 1, _provider(server), dpi=72, strip_height_px=100)
    finally:
        server.close()
    assert len(server.requests) == 2
