"""Comparing a scalar_text (or doc_presence) matrix parameter across the
documents of one process.

Section 9.2 of the specification, same as app.explication.compare: the only
outcomes an evaluator itself may return are CANDIDATE and NEGATIVE_VERIFIED,
plus the data-quality statuses MISSING_EVIDENCE / NOT_COMPARABLE /
CLARIFICATION_REQUIRED - never a violation, and never a guess. Precision
matters more than recall here (ТЗ FPR <= 0.10): a CANDIDATE is only ever
returned once both sides were located with a single, high-confidence value -
app.params.locate's own module docstring covers how "single" and "high
confidence" are decided; everything short of that is an honest refusal, with
a Russian reason, exactly as app.params.engine's own NOT_IMPLEMENTED already
is for a parameter with no evaluator at all.
"""

from dataclasses import dataclass

from app.explication.compare import _within_rounding_tolerance
from app.params.engine import ParamOutcome
from app.params.locate import (
    EvidenceRef, LocatorEntry, ParamContext, StageDocument, ValueCandidate, locate_value,
)
from app.params.specs import ParamSpec

# Below this confidence a found value is not trusted enough to compare -
# app.params.locate's own module docstring calls this the precision guard
# (label match + unit consistent + single value per stage).
_HIGH_CONFIDENCE = 0.7

_NORMATIVE_OPS = {"value_lt", "value_gt"}


@dataclass(frozen=True)
class _StageResolution:
    status: str  # "found" | "absent" | "conflict"
    candidate: ValueCandidate | None = None
    candidates: tuple[ValueCandidate, ...] = ()

    @property
    def high_confidence(self) -> bool:
        return self.candidate is not None and self.candidate.confidence >= _HIGH_CONFIDENCE


def _value_key(candidate: ValueCandidate) -> str:
    if isinstance(candidate.value, float):
        # Two candidates within one rounding step (the same allowance
        # app.explication.compare gives a room's own area) are the same
        # reading of the same cell, not a real internal disagreement -
        # e.g. the label line and its table row both matching "1520,4" vs
        # "1520,40" must not manufacture a CLARIFICATION_REQUIRED.
        return f"{round(candidate.value, 1):.1f}"
    return candidate.value.strip().lower()


def _resolve_side(candidates: list[ValueCandidate]) -> _StageResolution:
    if not candidates:
        return _StageResolution(status="absent")

    groups: dict[str, list[ValueCandidate]] = {}
    for c in candidates:
        groups.setdefault(_value_key(c), []).append(c)

    if len(groups) > 1:
        return _StageResolution(status="conflict", candidates=tuple(candidates))

    best = max(candidates, key=lambda c: c.confidence)
    return _StageResolution(status="found", candidate=best, candidates=tuple(candidates))


def _fmt(value: float) -> str:
    if abs(value - round(value)) < 1e-6:
        return str(int(round(value)))
    return f"{value:.2f}".rstrip("0").rstrip(".")


def _fmt_ru(value: float) -> str:
    return _fmt(value).replace(".", ",")


def _display_value(spec: ParamSpec, candidate: ValueCandidate) -> str:
    if isinstance(candidate.value, float):
        unit = f" {spec.unit}" if spec.unit and spec.unit not in ("—", "Статус") else ""
        return f"{_fmt_ru(candidate.value)}{unit}"
    return str(candidate.value)


def _stored_value(candidate: ValueCandidate) -> str:
    if isinstance(candidate.value, float):
        return _fmt(candidate.value)
    return str(candidate.value)


def _where(candidate: ValueCandidate) -> str:
    return f"{candidate.file_name}, стр. {candidate.page_no}"


def _conflict_reason(spec: ParamSpec, side_label: str, candidates: tuple[ValueCandidate, ...]) -> str:
    values = sorted({_display_value(spec, c) for c in candidates})
    return (
        f"В {side_label} найдено несколько разных значений параметра "
        f"«{spec.parameter_name}»: {', '.join(values)}. Итоговое значение требует "
        f"уточнения инспектора, а не автоматического выбора."
    )


def _missing_reason(spec: ParamSpec, side_label: str, source: str | None) -> str:
    source_note = f" (ожидаемый источник: {source})" if source else ""
    return f"значение параметра «{spec.parameter_name}» не найдено в {side_label}{source_note}"


def _not_found_anywhere_reason(spec: ParamSpec) -> str:
    return f"значение параметра «{spec.parameter_name}» не найдено в документах пакета"


def _low_confidence_reason(spec: ParamSpec) -> str:
    return (
        f"значение параметра «{spec.parameter_name}» найдено с недостаточной "
        f"уверенностью (неоднозначная метка или единица измерения) для автоматического сопоставления"
    )


def _fragments(left: ValueCandidate, right: ValueCandidate) -> tuple[EvidenceRef, ...]:
    return (
        EvidenceRef(file_id=left.file_id, page_no=left.page_no, box=left.combined_box,
                    extracted_value=left.raw_text, role="expected"),
        EvidenceRef(file_id=right.file_id, page_no=right.page_no, box=right.combined_box,
                    extracted_value=right.raw_text, role="actual"),
    )


def _compare_values(spec: ParamSpec, left: ValueCandidate, left_label: str,
                     right: ValueCandidate, right_label: str) -> ParamOutcome:
    fragments = _fragments(left, right)

    if spec.data_type == "number":
        left_v, right_v = float(left.value), float(right.value)
        delta = right_v - left_v

        if spec.compare_op == "delta_gt":
            violated = spec.compare_threshold is not None and abs(delta) > spec.compare_threshold
        elif spec.compare_op == "relative_delta_gt":
            base = abs(left_v)
            ratio = abs(delta) / base if base else (0.0 if delta == 0 else float("inf"))
            violated = spec.compare_threshold is not None and ratio > spec.compare_threshold
        else:
            # No declared comparator: equal up to one rounding step, never
            # "any float difference" - the module docstring's own reuse of
            # app.explication.compare's tolerance helper, with no relative
            # allowance of its own to add on top.
            violated = not _within_rounding_tolerance(left_v, right_v, 0.0)

        if violated:
            rationale = (
                f"Параметр «{spec.parameter_name}» изменён: в {left_label} "
                f"{_display_value(spec, left)}, в {right_label} {_display_value(spec, right)} "
                f"(дельта {_fmt_ru(delta)} {spec.unit or ''}".rstrip() + "). "
                f"{left_label}: {_where(left)}; {right_label}: {_where(right)}."
            )
            return ParamOutcome(spec.code, "CANDIDATE", rationale,
                                 expected_value=_stored_value(left), actual_value=_stored_value(right),
                                 delta=_fmt(delta), fragments=fragments)

        rationale = (
            f"Параметр «{spec.parameter_name}» совпадает: {_display_value(spec, left)} "
            f"в {left_label} и в {right_label}."
        )
        return ParamOutcome(spec.code, "NEGATIVE_VERIFIED", rationale,
                             expected_value=_stored_value(left), actual_value=_stored_value(right),
                             fragments=fragments)

    # enum / string / coordinate: normalized equality only.
    left_norm = str(left.value).strip().lower()
    right_norm = str(right.value).strip().lower()
    if left_norm == right_norm:
        rationale = f"Параметр «{spec.parameter_name}» совпадает: «{left.value}» в {left_label} и в {right_label}."
        return ParamOutcome(spec.code, "NEGATIVE_VERIFIED", rationale,
                             expected_value=_stored_value(left), actual_value=_stored_value(right),
                             fragments=fragments)

    rationale = (
        f"Параметр «{spec.parameter_name}» отличается: в {left_label} «{left.value}», "
        f"в {right_label} «{right.value}». {left_label}: {_where(left)}; {right_label}: {_where(right)}."
    )
    return ParamOutcome(spec.code, "CANDIDATE", rationale,
                         expected_value=_stored_value(left), actual_value=_stored_value(right),
                         fragments=fragments)


def _compare_pair(spec: ParamSpec, left: _StageResolution, left_label: str, left_source: str | None,
                   right: _StageResolution, right_label: str, right_source: str | None) -> ParamOutcome:
    if left.status == "conflict":
        return ParamOutcome(spec.code, "CLARIFICATION_REQUIRED",
                             _conflict_reason(spec, left_label, left.candidates))
    if right.status == "conflict":
        return ParamOutcome(spec.code, "CLARIFICATION_REQUIRED",
                             _conflict_reason(spec, right_label, right.candidates))

    if left.status != "found" and right.status != "found":
        return ParamOutcome(spec.code, "NOT_COMPARABLE", _not_found_anywhere_reason(spec))
    if left.status != "found":
        return ParamOutcome(spec.code, "MISSING_EVIDENCE", _missing_reason(spec, left_label, left_source))
    if right.status != "found":
        return ParamOutcome(spec.code, "MISSING_EVIDENCE", _missing_reason(spec, right_label, right_source))

    if not (left.high_confidence and right.high_confidence):
        return ParamOutcome(spec.code, "NOT_COMPARABLE", _low_confidence_reason(spec))

    return _compare_values(spec, left.candidate, left_label, right.candidate, right_label)


def _evaluate_normative(spec: ParamSpec, context: ParamContext, locator: LocatorEntry | None) -> ParamOutcome:
    """value_lt / value_gt: a normative limit on a single current value, not
    a PD-vs-RD delta. The current value is RD's own when RD has one - RD is
    what is actually being built - falling back to PD only when RD carries
    no usable value at all (module docstring: "the current RD (or PD if no
    RD)").
    """
    rd = _resolve_side(locate_value(spec, context.rd_docs, spec.source_rd, locator))
    chosen, chosen_label = rd, "РД"
    if rd.status != "found":
        pd = _resolve_side(locate_value(spec, context.pd_docs, spec.source_pd, locator))
        if pd.status in ("found", "conflict"):
            chosen, chosen_label = pd, "ПД"

    if chosen.status == "conflict":
        return ParamOutcome(spec.code, "CLARIFICATION_REQUIRED",
                             _conflict_reason(spec, chosen_label, chosen.candidates))
    if chosen.status != "found":
        return ParamOutcome(spec.code, "NOT_COMPARABLE", _not_found_anywhere_reason(spec))
    if not chosen.high_confidence:
        return ParamOutcome(spec.code, "NOT_COMPARABLE", _low_confidence_reason(spec))

    candidate = chosen.candidate
    value = float(candidate.value)
    limit = spec.min_value if spec.compare_op == "value_lt" else spec.max_value
    if limit is None:
        return ParamOutcome(spec.code, "NOT_COMPARABLE",
                             f"для параметра «{spec.parameter_name}» не задан нормативный предел в матрице")

    violated = value < limit if spec.compare_op == "value_lt" else value > limit
    refs = ", ".join(r for r in (spec.sp_reference, spec.gost_reference, spec.fz_reference, spec.other_normative) if r)
    refs_note = f" ({refs})" if refs else ""
    fragment = (EvidenceRef(file_id=candidate.file_id, page_no=candidate.page_no,
                             box=candidate.combined_box, extracted_value=candidate.raw_text,
                             role="actual"),)

    if violated:
        comparator = "менее" if spec.compare_op == "value_lt" else "более"
        rationale = (
            f"Параметр «{spec.parameter_name}» в {chosen_label} ({_where(candidate)}): "
            f"{_display_value(spec, candidate)} — {comparator} нормативного предела "
            f"{_fmt_ru(limit)} {spec.unit or ''}".rstrip() + f"{refs_note}. {spec.trigger_logic}"
        )
        return ParamOutcome(spec.code, "CANDIDATE", rationale,
                             actual_value=_stored_value(candidate), fragments=fragment)

    rationale = (
        f"Параметр «{spec.parameter_name}» в {chosen_label} ({_where(candidate)}): "
        f"{_display_value(spec, candidate)} — в пределах нормы{refs_note}."
    )
    return ParamOutcome(spec.code, "NEGATIVE_VERIFIED", rationale,
                         actual_value=_stored_value(candidate), fragments=fragment)


def _evaluate_pd_rd(spec: ParamSpec, context: ParamContext, locator: LocatorEntry | None) -> ParamOutcome:
    pd = _resolve_side(locate_value(spec, context.pd_docs, spec.source_pd, locator))
    rd = _resolve_side(locate_value(spec, context.rd_docs, spec.source_rd, locator))
    outcome = _compare_pair(spec, pd, "ПД", spec.source_pd, rd, "РД", spec.source_rd)

    # RD<->ID as the second pair, only when PD<->RD itself had nothing to
    # say (module docstring: "PD<->RD first, RD<->ID second pair") - a
    # conflict on either side is left as-is rather than papered over by a
    # second pair that might disagree with it too.
    if outcome.status in ("MISSING_EVIDENCE", "NOT_COMPARABLE") and spec.source_id and context.id_docs:
        id_res = _resolve_side(locate_value(spec, context.id_docs, spec.source_id, locator))
        id_outcome = _compare_pair(spec, rd, "РД", spec.source_rd, id_res, "ИД", spec.source_id)
        if id_outcome.status not in ("MISSING_EVIDENCE", "NOT_COMPARABLE"):
            return id_outcome

    return outcome


def evaluate_scalar_param(spec: ParamSpec, context: ParamContext) -> ParamOutcome:
    locator = context.locators.get(spec.code)
    if spec.compare_op in _NORMATIVE_OPS:
        return _evaluate_normative(spec, context, locator)
    return _evaluate_pd_rd(spec, context, locator)


# --- doc_presence -------------------------------------------------------

def _presence_keywords(text: str | None) -> list[str]:
    if not text:
        return []
    keywords = []
    for part in text.split(";"):
        part = part.strip()
        if part:
            keywords.append(part.lower())
    return keywords


def _find_presence(documents: list[StageDocument], keywords: list[str]) -> StageDocument | None:
    for doc in documents:
        haystack = " ".join(filter(None, [doc.file_name.lower(), (doc.document_code or "").lower()]))
        if any(keyword in haystack for keyword in keywords):
            return doc
    return None


def evaluate_doc_presence_param(spec: ParamSpec, context: ParamContext) -> ParamOutcome:
    """Presence-only parameters: is there a document/registry entry the
    matrix names as this parameter's own source, anywhere in the package.

    The four doc_presence parameters the real matrix carries (M-098..M-101)
    name external systems (АИС "ОСИГ", ГЛОНАСС telemetry, ГРОО) that a
    design/working documentation package never itself contains - this still
    checks honestly (file name / document code against the source text) and
    reports MISSING_EVIDENCE rather than guessing a status the package
    genuinely has no evidence for; see this task's own final report for the
    reasoning.
    """
    all_docs = context.pd_docs + context.rd_docs + context.id_docs
    keywords = (_presence_keywords(spec.source_pd) + _presence_keywords(spec.source_rd)
                + _presence_keywords(spec.source_id))
    if not keywords:
        return ParamOutcome(spec.code, "NOT_COMPARABLE",
                             f"для параметра «{spec.parameter_name}» не указан ожидаемый источник в матрице")

    found = _find_presence(all_docs, keywords)
    if found is not None:
        return ParamOutcome(
            spec.code, "NEGATIVE_VERIFIED",
            f"в пакете есть документ, отвечающий источнику параметра «{spec.parameter_name}»: {found.file_name}",
        )

    sources = ", ".join(s for s in (spec.source_pd, spec.source_rd, spec.source_id) if s)
    return ParamOutcome(
        spec.code, "MISSING_EVIDENCE",
        f"в пакете нет документа для параметра «{spec.parameter_name}» (ожидаемый источник: {sources})",
    )
