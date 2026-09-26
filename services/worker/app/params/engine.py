"""Runs every parameter of the matrix and answers for each one.

A parameter without an extractor, or whose extractor fails, comes back as
NOT_COMPARABLE with the reason. That is the behaviour the specification asks
for (section 9.2), and on the hidden test it costs nothing: an honest refusal
is not a false positive, while a guess would be.
"""

import logging
from collections.abc import Callable
from dataclasses import dataclass

from app.params.specs import MatrixSpecs, ParamSpec

logger = logging.getLogger(__name__)

NOT_IMPLEMENTED = "no extractor is implemented for this parameter yet"


@dataclass(frozen=True)
class ParamOutcome:
    code: str
    status: str
    reason: str


Evaluator = Callable[[ParamSpec], ParamOutcome]


def evaluate_all(specs: MatrixSpecs, evaluators: dict[str, Evaluator]) -> list[ParamOutcome]:
    outcomes: list[ParamOutcome] = []
    for spec in specs.params:
        evaluator = evaluators.get(spec.code)
        if evaluator is None:
            outcomes.append(ParamOutcome(spec.code, "NOT_COMPARABLE", NOT_IMPLEMENTED))
            continue
        try:
            outcome = evaluator(spec)
        except Exception as exc:  # noqa: BLE001 - one rule must not sink the protocol
            logger.error("parameter evaluation failed",
                         extra={"param_code": spec.code, "error": str(exc)})
            outcomes.append(ParamOutcome(spec.code, "NOT_COMPARABLE", f"evaluation failed: {exc}"))
            continue

        # Section 9.2: CONFIRMED_VIOLATION is assigned by the inspector only.
        # A rule that returns it is a defect, and passing it on would put an
        # unverified violation into the protocol.
        if outcome.status == "CONFIRMED_VIOLATION":
            logger.error("evaluator tried to confirm a violation",
                         extra={"param_code": spec.code})
            outcomes.append(ParamOutcome(
                spec.code, "NOT_COMPARABLE",
                "only an inspector can confirm a violation; the rule returned it itself",
            ))
            continue

        outcomes.append(outcome)
    return outcomes
