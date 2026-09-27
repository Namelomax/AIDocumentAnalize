"""ChatProvider against a fake OpenAI-compatible server.

http.server runs the fake in a daemon thread on an OS-assigned port, so
tests never race for a fixed one and never leave a socket behind: every
test that starts a server closes it in a finally block.
"""

import http.server
import json
import os
import threading
import time

import pytest

from app.llm.provider import ChatProvider, LlmUnavailable, provider_from_config


class _FakeConfig:
    def __init__(self, llm_base_url="", llm_model="a-model", llm_timeout_s=5.0):
        self.llm_base_url = llm_base_url
        self.llm_model = llm_model
        self.llm_timeout_s = llm_timeout_s


def _openai_response(content: str) -> bytes:
    return json.dumps({"choices": [{"message": {"content": content}}]}).encode("utf-8")


class _FakeServer:
    """A one-test /chat/completions endpoint.

    handler_fn(body: bytes) -> (status, response_bytes) decides the answer;
    every request it sees is appended to .requests for the caller to check.
    """

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


def _provider(server: _FakeServer, timeout_s: float = 5.0, model: str = "a-model") -> ChatProvider:
    return ChatProvider(base_url=server.base_url, model=model, timeout_s=timeout_s)


@pytest.mark.asyncio
async def test_complete_json_parses_plain_json_content():
    server = _FakeServer(lambda body: (200, _openai_response('{"a": 1}')))
    try:
        result = await _provider(server).complete_json(system="s", user="u")
    finally:
        server.close()
    assert result == {"a": 1}


@pytest.mark.asyncio
async def test_complete_json_survives_reasoning_and_a_markdown_fence():
    # Qwen-family models sometimes narrate their reasoning in <think> and/or
    # wrap the answer in a ```json fence; both must be peeled off.
    content = '<think>сначала сравню поэтажно</think>```json\n{"a": 1}\n```'
    server = _FakeServer(lambda body: (200, _openai_response(content)))
    try:
        result = await _provider(server).complete_json(system="s", user="u")
    finally:
        server.close()
    assert result == {"a": 1}


@pytest.mark.asyncio
async def test_complete_json_raises_when_content_has_no_json():
    server = _FakeServer(lambda body: (200, _openai_response("прошу прощения, не могу ответить")))
    try:
        with pytest.raises(LlmUnavailable):
            await _provider(server).complete_json(system="s", user="u")
    finally:
        server.close()


@pytest.mark.asyncio
async def test_complete_json_raises_on_timeout_instead_of_hanging():
    # The fake sleeps well past the client's timeout; the call must return
    # (as LlmUnavailable) within roughly that timeout, not hang.
    def slow_handler(body):
        time.sleep(2.0)
        return 200, _openai_response('{"a": 1}')

    server = _FakeServer(slow_handler)
    try:
        started = time.monotonic()
        with pytest.raises(LlmUnavailable):
            await _provider(server, timeout_s=0.5).complete_json(system="s", user="u")
        assert time.monotonic() - started < 2.0
    finally:
        server.close()


@pytest.mark.asyncio
async def test_complete_json_raises_on_connection_refused():
    # Nothing is listening on this address: urlopen must fail fast with a
    # connection error, translated to LlmUnavailable rather than propagating
    # a raw urllib/socket exception.
    provider = ChatProvider(base_url="http://127.0.0.1:1", model="a-model", timeout_s=1.0)
    with pytest.raises(LlmUnavailable):
        await provider.complete_json(system="s", user="u")


@pytest.mark.asyncio
async def test_complete_json_sends_model_temperature_and_two_messages():
    server = _FakeServer(lambda body: (200, _openai_response('{"a": 1}')))
    try:
        await _provider(server, model="qwen/qwen3.8-27b").complete_json(
            system="system text", user="user text"
        )
    finally:
        server.close()
    assert len(server.requests) == 1
    sent = server.requests[0]
    assert sent["model"] == "qwen/qwen3.8-27b"
    assert sent["temperature"] == 0
    assert sent["messages"] == [
        {"role": "system", "content": "system text"},
        {"role": "user", "content": "user text"},
    ]


def test_provider_from_config_is_none_without_a_base_url():
    assert provider_from_config(_FakeConfig(llm_base_url="")) is None


def test_provider_from_config_builds_a_provider_when_configured():
    config = _FakeConfig(llm_base_url="http://127.0.0.1:1234/v1", llm_model="a-model", llm_timeout_s=30.0)
    provider = provider_from_config(config)
    assert provider == ChatProvider(base_url="http://127.0.0.1:1234/v1", model="a-model", timeout_s=30.0)


@pytest.mark.asyncio
@pytest.mark.live_llm
async def test_live_llm_answers_a_trivial_json_request():
    """Real call against LM Studio (or whatever LLM_BASE_URL names).

    Run with:
    LLM_BASE_URL=http://127.0.0.1:1234/v1 LLM_MODEL=qwen/qwen3.8-27b \
        .venv/Scripts/python.exe -m pytest -m live_llm -v -s
    """
    base_url = os.environ.get("LLM_BASE_URL", "")
    if not base_url:
        pytest.skip("LLM_BASE_URL is not set; no live model to test against")
    model = os.environ.get("LLM_MODEL", "")
    timeout_s = float(os.environ.get("LLM_TIMEOUT_S", "60"))
    provider = ChatProvider(base_url=base_url, model=model, timeout_s=timeout_s)

    started = time.monotonic()
    result = await provider.complete_json(
        system="Ты отвечаешь только валидным JSON и ничем больше.",
        user='Ответь ровно JSON-объектом {"ok": true} и ничего не добавляй.',
    )
    elapsed_s = time.monotonic() - started
    print(f"live llm result={result!r} elapsed_s={elapsed_s:.2f}")

    assert isinstance(result, dict)
    assert result.get("ok") is True
