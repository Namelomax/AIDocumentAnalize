"""Tests for app.explication.functions: normalization and the model call it
guards with it.

The fake provider stands in for app.llm.provider.ChatProvider - it only has
to expose the one method compare_room_functions calls, complete_json - and
records every call it receives, so a test can assert that a pair equal after
normalization never reaches it at all.
"""

import os
import time

import pytest

from app.explication.functions import (
    FunctionVerdict,
    NamePair,
    compare_room_functions,
    normalize_room_name,
)
from app.llm.provider import ChatProvider


class FakeProvider:
    def __init__(self, response):
        self.response = response
        self.calls: list[tuple[str, str]] = []

    async def complete_json(self, system: str, user: str):
        self.calls.append((system, user))
        return self.response


def test_normalize_expands_tech_abbreviation():
    assert normalize_room_name("Тех.помещение") == normalize_room_name("Техническое помещение")


def test_normalize_expands_su_abbreviation():
    assert normalize_room_name("С/у") == normalize_room_name("Санузел")


def test_normalize_expands_lk_abbreviation():
    assert normalize_room_name("ЛК") == normalize_room_name("Лестничная клетка")


def test_normalize_is_case_and_yo_insensitive():
    assert normalize_room_name("Электрощитовая") == normalize_room_name("электрощитовая")
    assert normalize_room_name("Ёмкостная") == normalize_room_name("Емкостная")


@pytest.mark.asyncio
async def test_empty_pairs_never_call_the_model():
    provider = FakeProvider(response=[])
    result = await compare_room_functions([], provider)
    assert result == []
    assert provider.calls == []


@pytest.mark.asyncio
async def test_pairs_equal_after_normalization_never_reach_the_model():
    provider = FakeProvider(response=[])
    pairs = [NamePair(key="p1", pd_name="Тех.помещение", rd_name="Техническое помещение")]

    result = await compare_room_functions(pairs, provider)

    assert result == []
    assert provider.calls == []


@pytest.mark.asyncio
async def test_three_differing_pairs_cost_one_call():
    provider = FakeProvider(response=[
        {"key": "p1", "same_function": False, "confidence": 0.9, "reason": "было тех., стало складом"},
        {"key": "p2", "same_function": True, "confidence": 0.8, "reason": "тот же кабинет"},
        {"key": "p3", "same_function": False, "confidence": 0.7, "reason": "была кладовая, стал санузел"},
    ])
    pairs = [
        NamePair(key="p1", pd_name="Техническое помещение", rd_name="Склад ГСМ"),
        NamePair(key="p2", pd_name="Кабинет", rd_name="Кабинет врача"),
        NamePair(key="p3", pd_name="Кладовая", rd_name="Санузел"),
    ]

    result = await compare_room_functions(pairs, provider)

    assert len(provider.calls) == 1
    assert {v.key for v in result} == {"p1", "p2", "p3"}
    assert next(v for v in result if v.key == "p1").same_function is False


@pytest.mark.asyncio
async def test_malformed_answer_elements_are_dropped():
    provider = FakeProvider(response=[
        {"key": "not-requested", "same_function": False, "confidence": 0.5, "reason": "чужой ключ"},
        {"key": "p1", "same_function": False, "confidence": 1.7, "reason": "уверенность вне диапазона"},
        {"key": "p1", "same_function": False, "reason": "отсутствует confidence"},
        {"key": "p1", "same_function": False, "confidence": 0.6, "reason": "единственный валидный элемент"},
    ])
    pairs = [NamePair(key="p1", pd_name="Техническое помещение", rd_name="Склад ГСМ")]

    result = await compare_room_functions(pairs, provider)

    assert result == [FunctionVerdict(
        key="p1", same_function=False, confidence=0.6, reason="единственный валидный элемент",
    )]


@pytest.mark.asyncio
async def test_model_answering_fewer_pairs_than_asked_returns_fewer_verdicts():
    provider = FakeProvider(response=[
        {"key": "p1", "same_function": False, "confidence": 0.9, "reason": "было тех., стало складом"},
    ])
    pairs = [
        NamePair(key="p1", pd_name="Техническое помещение", rd_name="Склад ГСМ"),
        NamePair(key="p2", pd_name="Кладовая", rd_name="Санузел"),
    ]

    result = await compare_room_functions(pairs, provider)

    assert len(provider.calls) == 1
    assert len(result) == 1
    assert result[0].key == "p1"


@pytest.mark.asyncio
@pytest.mark.live_llm
async def test_live_llm_tells_a_changed_function_from_a_reworded_name():
    """Real call against LM Studio (or whatever LLM_BASE_URL names).

    Run with:
    LLM_BASE_URL=http://127.0.0.1:1234/v1 LLM_MODEL=qwen/qwen3.8-27b \
        .venv/Scripts/python.exe -m pytest -m live_llm -v -s

    Only the unambiguous pairs are asserted on (Task 3, step 1): a changed
    function ("Техническое помещение" / "Склад ГСМ", "Кладовая" / "Санузел")
    and a pair identical after normalization that must never reach the model
    at all. "Тамбур" / "Тамбур-шлюз" is printed, not asserted on - a real
    model could reasonably call it either way.
    """
    base_url = os.environ.get("LLM_BASE_URL", "")
    if not base_url:
        pytest.skip("LLM_BASE_URL is not set; no live model to test against")
    model = os.environ.get("LLM_MODEL", "")
    timeout_s = float(os.environ.get("LLM_TIMEOUT_S", "60"))
    provider = ChatProvider(base_url=base_url, model=model, timeout_s=timeout_s)

    pairs = [
        NamePair(key="changed-1", pd_name="Техническое помещение", rd_name="Склад ГСМ"),
        NamePair(key="same-case", pd_name="Кабинет", rd_name="кабинет"),
        NamePair(key="disputed", pd_name="Тамбур", rd_name="Тамбур-шлюз"),
        NamePair(key="changed-2", pd_name="Кладовая", rd_name="Санузел"),
    ]

    started = time.monotonic()
    result = await compare_room_functions(pairs, provider)
    elapsed_s = time.monotonic() - started

    print(f"live llm room function verdicts elapsed_s={elapsed_s:.2f}")
    for verdict in result:
        print(f"  {verdict.key}: same_function={verdict.same_function} "
              f"confidence={verdict.confidence:.2f} reason={verdict.reason!r}")

    by_key = {v.key: v for v in result}
    # "same-case" normalizes equal on both sides and must never have reached
    # the model - so it never appears among the returned verdicts either.
    assert "same-case" not in by_key
    assert by_key["changed-1"].same_function is False
    assert by_key["changed-2"].same_function is False


def test_the_model_is_given_the_expansion_of_a_trade_abbreviation():
    """Live, the model read "ПУИ" as a control point instead of a room for
    cleaning supplies and wrote that into the inspector's reason."""
    from app.explication.functions import _build_user_prompt

    prompt = _build_user_prompt([NamePair(key="p1", pd_name="Санузел", rd_name="ПУИ")])

    assert "помещение уборочного инвентаря" in prompt
    assert "rd_expanded" in prompt
    assert "pd_expanded" not in prompt
