"""The parameter matrix as the worker sees it.

Specs are validated on load rather than trusted: a spec with a wrong data type
or a duplicated code would otherwise surface much later as a wrong comparison
in a signed protocol.
"""

from dataclasses import dataclass, fields
from pathlib import Path

import yaml

SPECS_DIR = Path(__file__).resolve().parents[2] / "specs" / "params"

DATA_TYPES = {"number", "string", "boolean", "coordinate", "enum"}
MODALITIES = {"scalar_text", "doc_presence", "drawing_entity", "drawing_measure"}
PRIORITIES = {"HIGH", "MEDIUM", "LOW"}


@dataclass(frozen=True)
class ParamSpec:
    code: str
    section: str
    parameter_name: str
    unit: str
    data_type: str
    modality: str
    review_priority: str
    source_pd: str | None
    source_rd: str | None
    source_id: str | None
    trigger_logic: str
    compare_op: str | None
    compare_threshold: float | None
    min_value: float | None
    max_value: float | None
    sp_reference: str | None
    gost_reference: str | None
    fz_reference: str | None
    other_normative: str | None
    regex_pattern: str | None
    implemented: bool


@dataclass(frozen=True)
class MatrixSpecs:
    version: str
    source_sha256: str
    params: tuple[ParamSpec, ...]


_FIELDS = {f.name for f in fields(ParamSpec)}


def _check(spec: dict, path: Path) -> ParamSpec:
    missing = _FIELDS - spec.keys()
    if missing:
        raise ValueError(f"{path.name}: missing keys {sorted(missing)}")
    if spec["data_type"] not in DATA_TYPES:
        raise ValueError(f"{path.name}: data_type {spec['data_type']!r} is not one of {sorted(DATA_TYPES)}")
    if spec["modality"] not in MODALITIES:
        raise ValueError(f"{path.name}: modality {spec['modality']!r} is not one of {sorted(MODALITIES)}")
    if spec["review_priority"] not in PRIORITIES:
        raise ValueError(f"{path.name}: review_priority {spec['review_priority']!r} is not one of {sorted(PRIORITIES)}")
    return ParamSpec(**{name: spec[name] for name in _FIELDS})


def load_specs(directory: Path = SPECS_DIR) -> MatrixSpecs:
    manifest = yaml.safe_load((directory / "_matrix.yaml").read_text(encoding="utf-8"))

    params: list[ParamSpec] = []
    seen: dict[str, str] = {}
    for path in sorted(directory.glob("M-*.yaml")):
        spec = _check(yaml.safe_load(path.read_text(encoding="utf-8")), path)
        if spec.code in seen:
            raise ValueError(f"{spec.code} is defined in both {seen[spec.code]} and {path.name}")
        seen[spec.code] = path.name
        params.append(spec)

    if len(params) != manifest["params_count"]:
        raise ValueError(
            f"{len(params)} spec files found, the matrix declares {manifest['params_count']}"
        )

    return MatrixSpecs(
        version=str(manifest["matrix_version"]),
        source_sha256=manifest["source_sha256"],
        params=tuple(params),
    )
