import shutil

import pytest
import yaml

from app.params.engine import ParamOutcome, evaluate_all
from app.params.specs import SPECS_DIR, load_specs


def test_the_committed_matrix_loads_whole():
    matrix = load_specs()

    assert matrix.version == "1.1"
    assert len(matrix.params) == 132
    assert len({p.code for p in matrix.params}) == 132


def test_every_parameter_gets_an_outcome_even_with_no_extractor():
    """The engine answers for all 132, from the very first day.

    A parameter nobody has implemented yet says so, with a reason, instead of
    disappearing from the protocol. Silence would read as "checked, fine".
    """
    outcomes = evaluate_all(load_specs(), evaluators={})

    assert len(outcomes) == 132
    assert {o.status for o in outcomes} == {"NOT_COMPARABLE"}
    assert all(o.reason for o in outcomes)


def test_an_implemented_parameter_uses_its_evaluator():
    outcomes = evaluate_all(
        load_specs(),
        evaluators={"M-041": lambda spec: ParamOutcome(spec.code, "NEGATIVE_VERIFIED", "checked")},
    )

    by_code = {o.code: o for o in outcomes}
    assert by_code["M-041"].status == "NEGATIVE_VERIFIED"
    assert by_code["M-040"].status == "NOT_COMPARABLE"


def test_a_failing_evaluator_does_not_sink_the_other_parameters():
    """One broken rule must not cost the protocol its other 131 results."""
    def broken(spec):
        raise RuntimeError("table layout not recognised")

    outcomes = evaluate_all(load_specs(), evaluators={"M-041": broken})

    by_code = {o.code: o for o in outcomes}
    assert len(outcomes) == 132
    assert by_code["M-041"].status == "NOT_COMPARABLE"
    assert "table layout not recognised" in by_code["M-041"].reason


def test_an_evaluator_cannot_confirm_a_violation():
    """CONFIRMED_VIOLATION is the inspector's decision alone (section 9.2).

    If a rule ever returns it, the engine refuses rather than passing it on.
    """
    outcomes = evaluate_all(
        load_specs(),
        evaluators={"M-041": lambda spec: ParamOutcome(spec.code, "CONFIRMED_VIOLATION", "sure")},
    )

    by_code = {o.code: o for o in outcomes}
    assert by_code["M-041"].status == "NOT_COMPARABLE"
    assert "inspector" in by_code["M-041"].reason


def test_a_duplicated_code_is_refused(tmp_path):
    target = tmp_path / "params"
    shutil.copytree(SPECS_DIR, target)
    duplicate = yaml.safe_load((target / "M-001.yaml").read_text(encoding="utf-8"))
    (target / "M-999.yaml").write_text(
        yaml.safe_dump(duplicate, allow_unicode=True, sort_keys=False), encoding="utf-8"
    )

    with pytest.raises(ValueError, match="M-001"):
        load_specs(target)


def test_a_count_that_disagrees_with_the_manifest_is_refused(tmp_path):
    """A lost spec file must not quietly shrink the matrix to 131 parameters."""
    target = tmp_path / "params"
    shutil.copytree(SPECS_DIR, target)
    (target / "M-132.yaml").unlink()

    with pytest.raises(ValueError, match="132"):
        load_specs(target)


def test_an_unknown_data_type_is_refused(tmp_path):
    target = tmp_path / "params"
    shutil.copytree(SPECS_DIR, target)
    spec = yaml.safe_load((target / "M-001.yaml").read_text(encoding="utf-8"))
    spec["data_type"] = "float"
    (target / "M-001.yaml").write_text(
        yaml.safe_dump(spec, allow_unicode=True, sort_keys=False), encoding="utf-8"
    )

    with pytest.raises(ValueError, match="data_type"):
        load_specs(target)
