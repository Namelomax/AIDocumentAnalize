"""Per-stage completeness and the resulting load scenario.

Both are reported separately from findings: an incomplete package is a data
quality statement, never a violation.
"""

from dataclasses import dataclass

STAGES = ("PD", "RD", "ID")


@dataclass(frozen=True)
class StageCompleteness:
    stage: str
    status: str  # UPLOADED | PARTIAL | MISSING
    uploaded: int
    expected: int | None


def compute_completeness(files, expected: dict[str, int] | None) -> list[StageCompleteness]:
    result = []
    for stage in STAGES:
        uploaded = sum(1 for f in files if f.doc_stage == stage)
        want = expected.get(stage) if expected else None

        if uploaded == 0:
            status = "MISSING"
        elif want is not None and uploaded < want:
            status = "PARTIAL"
        else:
            status = "UPLOADED"

        result.append(StageCompleteness(stage, status, uploaded, want))
    return result


def determine_scenario(completeness: list[StageCompleteness]) -> str:
    by_stage = {c.stage: c for c in completeness}

    if any(c.status == "PARTIAL" for c in completeness):
        return "PARTIALLY_LOADED"

    present = {s for s in STAGES if by_stage[s].status == "UPLOADED"}

    if present == {"PD", "RD", "ID"}:
        return "FULL"
    if present == {"PD", "RD"}:
        return "PD_RD_ONLY"
    if present == {"PD", "ID"}:
        return "PD_ID_ONLY"
    if present == {"RD", "ID"}:
        return "RD_ID_ONLY"
    return "SINGLE_ONLY"
