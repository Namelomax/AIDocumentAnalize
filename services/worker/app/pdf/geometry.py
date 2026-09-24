"""Page coordinates expressed in the space a reader actually sees.

Every highlight the inspector is shown, and every bbox stored as evidence, is
built from these numbers. They are normalized to [0;1] against the displayed
page box so they stay correct across sheet sizes, and they are taken relative
to that box's own origin so a non-zero CropBox does not shift them.
"""

from dataclasses import dataclass

Box = tuple[float, float, float, float]


@dataclass(frozen=True)
class NormalizedBox:
    x0: float
    y0: float
    x1: float
    y1: float


def _clamp(value: float) -> float:
    return 0.0 if value < 0.0 else 1.0 if value > 1.0 else value


def normalize_box(box: Box, page_rect: Box) -> NormalizedBox:
    page_x0, page_y0, page_x1, page_y1 = page_rect
    width = page_x1 - page_x0
    height = page_y1 - page_y0
    if width <= 0 or height <= 0:
        raise ValueError(f"page box has no area: {page_rect!r}")

    xs = sorted((_clamp((box[0] - page_x0) / width), _clamp((box[2] - page_x0) / width)))
    ys = sorted((_clamp((box[1] - page_y0) / height), _clamp((box[3] - page_y0) / height)))
    return NormalizedBox(xs[0], ys[0], xs[1], ys[1])
