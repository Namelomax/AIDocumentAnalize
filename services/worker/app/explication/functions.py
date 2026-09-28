"""Telling a changed room function from a reworded name (plan 8, Task 3).

Section 9.5's "semantic dissonance": a room keeps its number and area across
the PD/RD pair, but its name changes - "Техническое помещение" becomes
"Склад ГСМ". Most of those changes are not a function change at all, only a
different way of writing the same one ("Кабинет" / "Кабинет врача"), and the
matrix's own norm for an NLP comparison is 500 ms (section 11) while one
local-model call takes seconds (see app.llm.provider docstring). So this
module does the cheap half of the job without a model - normalize_room_name
folds together the spelling variants a human inspector would never call a
different room - and only what still disagrees after that goes to the model,
all of it in one call per package (Global Constraint: hypotheses are cheap to
raise, not to compute).

A verdict here is never a violation on its own (Global Constraint: a
hypothesis is not a violation): compare_room_functions only ever returns a
same_function judgement and a reason: turning same_function=false into a
SUSPICION check is app.pipeline's job.
"""

import json
import re
from dataclasses import dataclass

from app.llm.provider import ChatProvider


@dataclass(frozen=True)
class NamePair:
    key: str          # stable id of the pair inside one request, e.g. "p1"
    pd_name: str
    rd_name: str


@dataclass(frozen=True)
class FunctionVerdict:
    key: str
    same_function: bool
    confidence: float     # 0..1, as the model stated it
    reason: str            # one Russian sentence for the inspector


# "с/у" is collapsed before generic punctuation handling below because
# splitting the slash first (as the generic pass would) leaves two unrelated
# one-letter tokens ("с", "у") that nothing downstream would ever recognise
# as the abbreviation they came from.
_SLASH_ABBREVIATION_RE = re.compile(r"с\s*/\s*у\b")

# Punctuation and other separators a real explication table mixes into a
# name - dots after an abbreviation, commas, dashes - are not part of the
# room's function and are folded to whitespace before tokens are compared.
_PUNCTUATION_RE = re.compile(r"[^\w\s]")

# Abbreviations routinely seen on the reference sheets' explication tables.
# Multi-word expansions ("лк" -> two words) are deliberately written as plain
# strings, not further abbreviations, so this table never has to recurse.
_ABBREVIATIONS = {
    "тех": "техническое",
    "пом": "помещение",
    "су": "санузел",
    "кл": "клетка",
    "лк": "лестничная клетка",
    "пуи": "помещение уборочного инвентаря",
}


def normalize_room_name(name: str) -> str:
    """Fold spelling variants of one name to the same string.

    Lower-cased, ё normalised to е, punctuation collapsed to whitespace, and
    a fixed set of explication-table abbreviations expanded - "Тех.помещение"
    and "Техническое помещение" must compare equal, or every such pair would
    burn a model call on a rewording no inspector would call a real change.
    """
    text = name.strip().lower().replace("ё", "е")
    text = _SLASH_ABBREVIATION_RE.sub("санузел", text)
    text = _PUNCTUATION_RE.sub(" ", text)
    tokens = [_ABBREVIATIONS.get(token, token) for token in text.split()]
    return " ".join(tokens)


_SYSTEM_PROMPT = """\
Ты помогаешь эксперту строительного контроля сравнивать названия помещений
в проектной документации (ПД) и рабочей документации (РД). Тебе дают пары
названий одного и того же помещения: номер и площадь на обоих листах уже
совпадают, тебя интересует только смысл названия - изменилась ли реальная
функция помещения, а не просто его словесная формулировка.

Одно и то же назначение (same_function = true), если отличается только
полнота или стиль формулировки, а помещение используется так же, например:
- «Кабинет» и «Кабинет врача» в одном и том же медицинском блоке - оба кабинет;
- «Электрощитовая» и «ЭЩ» - одно и то же помещение, просто сокращение;
- «Коридор» и «Коридор №2» - тот же коридор с уточнением номера.

Разное назначение (same_function = false), если помещение стало
использоваться по-другому, например:
- «Техническое помещение» и «Склад ГСМ» - было техническое, стало складом;
- «Кладовая» и «Санузел» - была кладовая, стал санузел;
- «Актовый зал» и «Серверная» - было место собраний, стало серверной.

Если в названии есть сокращение, принятое в экспликациях, в полях
pd_expanded и rd_expanded дана его расшифровка - опирайся на неё, а не
угадывай значение сокращения.

Отвечай строго JSON-массивом и ничем больше, без пояснений вне JSON. Один
элемент массива на каждую переданную пару, с тем же key:
[{"key": "<ключ пары>", "same_function": true|false, "confidence": <число от 0 до 1>, "reason": "<одно предложение по-русски, объясняющее вывод>"}]
"""


def _build_user_prompt(pairs: list[NamePair]) -> str:
    # The model guesses at trade abbreviations and gets them wrong: live, it
    # read "ПУИ" as a control point rather than a cleaning-supplies room and
    # wrote that into the reason the inspector sees. The expansion the
    # normalizer already knows is handed over beside the original name.
    payload = []
    for p in pairs:
        item = {"key": p.key, "pd_name": p.pd_name, "rd_name": p.rd_name}
        for field, name in (("pd_expanded", p.pd_name), ("rd_expanded", p.rd_name)):
            expanded = normalize_room_name(name)
            if expanded != " ".join(name.lower().replace("ё", "е").split()):
                item[field] = expanded
        payload.append(item)
    return (
        "Сравни назначения следующих пар помещений и верни JSON-массив "
        "вердиктов, как описано в инструкции:\n"
        f"{json.dumps(payload, ensure_ascii=False)}"
    )


def _is_finite_number(value: object) -> bool:
    # bool is a subclass of int in Python; a model returning `true`/`false`
    # for confidence must not silently pass as 1/0.
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _parse_verdicts(raw: object, requested_keys: set[str]) -> list[FunctionVerdict]:
    """Keep only what actually answers a requested pair in the right shape.

    Global Constraint: the model's answer is checked, not trusted. A wrong
    key, an out-of-range confidence, a missing field, or a key repeated by
    the model past its first occurrence - every one of those drops the
    element rather than guessing at what the model meant.
    """
    if not isinstance(raw, list):
        return []

    verdicts: list[FunctionVerdict] = []
    seen_keys: set[str] = set()
    for item in raw:
        if not isinstance(item, dict):
            continue
        key = item.get("key")
        same_function = item.get("same_function")
        confidence = item.get("confidence")
        reason = item.get("reason")

        if not isinstance(key, str) or key not in requested_keys or key in seen_keys:
            continue
        if not isinstance(same_function, bool):
            continue
        if not _is_finite_number(confidence) or not (0.0 <= confidence <= 1.0):
            continue
        if not isinstance(reason, str) or not reason.strip():
            continue

        seen_keys.add(key)
        verdicts.append(FunctionVerdict(
            key=key, same_function=same_function,
            confidence=float(confidence), reason=reason,
        ))
    return verdicts


async def compare_room_functions(pairs: list[NamePair], provider: ChatProvider) -> list[FunctionVerdict]:
    """Ask the model, once, which of these room name pairs changed function.

    Pairs that already read the same after normalize_room_name never reach
    the model - that is not a hypothesis, it is one name written two ways.
    Everything else goes in a single request (Global Constraint: one call
    per package, not one per pair - the model is seconds-slow, not the
    500 ms/parameter the specification's NLP norm allows).
    """
    to_ask = [p for p in pairs if normalize_room_name(p.pd_name) != normalize_room_name(p.rd_name)]
    if not to_ask:
        return []

    raw = await provider.complete_json(_SYSTEM_PROMPT, _build_user_prompt(to_ask))
    requested_keys = {p.key for p in to_ask}
    return _parse_verdicts(raw, requested_keys)
