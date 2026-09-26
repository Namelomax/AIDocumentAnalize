from pathlib import Path

import pytest
import yaml

from tools.matrix2specs import build_specs, write_specs

MATRIX = Path(__file__).resolve().parents[3] / "Задание" / "Матрица_параметров_редакция1.1.xlsx"

pytestmark = pytest.mark.skipif(not MATRIX.exists(), reason="customer matrix is not in the checkout")


@pytest.fixture(scope="module")
def built():
    manifest, specs = build_specs(MATRIX)
    return manifest, {s["code"]: s for s in specs}


def test_every_parameter_of_the_matrix_becomes_a_spec(built):
    manifest, by_code = built
    assert len(by_code) == 132
    assert sorted(by_code) == [f"M-{i:03d}" for i in range(1, 133)]
    assert manifest["params_count"] == 132
    assert manifest["matrix_version"] == "1.1"
    assert len(manifest["source_sha256"]) == 64


def test_section_is_the_short_code_the_specification_uses(built):
    _, by_code = built
    assert by_code["M-002"]["section"] == "ПЗ"
    assert by_code["M-068"]["section"] == "ИОС1"
    assert by_code["M-132"]["section"] == "СМ"


def test_relative_delta_threshold_is_read_from_a_percentage(built):
    _, by_code = built
    spec = by_code["M-002"]  # "Дельта общей площади между ПД и РД (или ИД) > 1%."
    assert spec["compare_op"] == "relative_delta_gt"
    assert spec["compare_threshold"] == pytest.approx(0.01)
    # An inter-stage tolerance is not an absolute bound on the value.
    assert spec["min_value"] is None and spec["max_value"] is None


def test_a_lower_bound_becomes_min_value(built):
    _, by_code = built
    spec = by_code["M-041"]  # "... < 0.9 м."
    assert spec["compare_op"] == "value_lt"
    assert spec["min_value"] == pytest.approx(0.9)
    assert spec["max_value"] is None


def test_an_upper_bound_becomes_max_value(built):
    _, by_code = built
    spec = by_code["M-118"]  # "Высота порога > 0.014 м"
    assert spec["compare_op"] == "value_gt"
    assert spec["max_value"] == pytest.approx(0.014)


def test_a_displacement_is_a_delta_not_a_bound(built):
    _, by_code = built
    spec = by_code["M-034"]  # "Смещение точки подключения ... > 0.5 м."
    assert spec["compare_op"] == "delta_gt"
    assert spec["compare_threshold"] == pytest.approx(0.5)
    assert spec["data_type"] == "coordinate"


@pytest.mark.parametrize("code", ["M-031", "M-042", "M-038"])
def test_ambiguous_triggers_get_no_threshold(built, code):
    """A guessed threshold manufactures violations, which is worse than none.

    M-031 gives a range ("< 10-12 м"), M-042 two thresholds in one sentence,
    M-038 a share of a total. None of them names one number to compare with.
    """
    _, by_code = built
    spec = by_code[code]
    assert spec["compare_op"] is None
    assert spec["compare_threshold"] is None
    assert spec["min_value"] is None and spec["max_value"] is None


def test_an_absolute_bound_is_not_applied_to_a_compound_parameter(built):
    """M-121 counts parking spaces and bounds their width in one parameter.

    The "< 3.5 m" names the width only; applied to the count it would call two
    spaces a violation. A relative tolerance, by contrast, holds for either
    quantity, so M-067 ("м³ / т", "> 2%") keeps its threshold.
    """
    _, by_code = built
    assert by_code["M-121"]["compare_op"] is None
    assert by_code["M-121"]["min_value"] is None
    # Same shape: "м² / м" carries the area and the inner dimensions of an
    # accessible toilet, and "< 1.5 м" bounds only the dimensions.
    assert by_code["M-119"]["compare_op"] is None
    assert by_code["M-067"]["compare_op"] == "relative_delta_gt"


def test_normative_references_are_lifted_from_the_text(built):
    _, by_code = built
    assert by_code["M-040"]["sp_reference"] == "СП 1.13130"
    assert by_code["M-041"]["gost_reference"] == "ГОСТ 21.101"


def test_data_type_and_modality_follow_the_unit_and_sources(built):
    _, by_code = built
    assert by_code["M-055"]["data_type"] == "enum"          # Марка (B)
    assert by_code["M-098"]["modality"] == "doc_presence"   # Статус
    assert by_code["M-041"]["modality"] == "scalar_text"    # ведомость проёмов
    assert by_code["M-040"]["modality"] == "drawing_measure"  # планы, линейные размеры
    assert by_code["M-043"]["modality"] == "drawing_entity"   # направление открывания


def test_every_value_fits_the_column_widths_of_section_8_1(built):
    _, by_code = built
    for spec in by_code.values():
        assert len(spec["code"]) <= 20
        assert len(spec["section"]) <= 50
        assert len(spec["parameter_name"]) <= 255
        assert len(spec["unit"]) <= 20, (spec["code"], spec["unit"])
        assert spec["data_type"] in {"number", "string", "boolean", "coordinate", "enum"}
        assert spec["review_priority"] in {"HIGH", "MEDIUM", "LOW"}
        assert spec["implemented"] is False


def test_hand_edited_specs_are_not_overwritten(tmp_path):
    """Generated specs are a starting point the team refines by hand.

    A second run that silently regenerated them would throw that work away.
    """
    assert write_specs(MATRIX, tmp_path) == 133  # 132 specs and the manifest
    edited = tmp_path / "M-041.yaml"
    spec = yaml.safe_load(edited.read_text(encoding="utf-8"))
    spec["implemented"] = True
    edited.write_text(yaml.safe_dump(spec, allow_unicode=True, sort_keys=False), encoding="utf-8")

    assert write_specs(MATRIX, tmp_path) == 0
    assert yaml.safe_load(edited.read_text(encoding="utf-8"))["implemented"] is True

    assert write_specs(MATRIX, tmp_path, force=True) == 133
    assert yaml.safe_load(edited.read_text(encoding="utf-8"))["implemented"] is False
