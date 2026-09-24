from app.domain.completeness import compute_completeness, determine_scenario
from tests.test_revisions import mk


def test_all_three_stages_present_is_full():
    files = [mk("a", stage="PD"), mk("b", stage="RD"), mk("c", stage="ID")]
    scenario = determine_scenario(compute_completeness(files, None))
    assert scenario == "FULL"


def test_pd_and_rd_only():
    files = [mk("a", stage="PD"), mk("b", stage="RD")]
    assert determine_scenario(compute_completeness(files, None)) == "PD_RD_ONLY"


def test_pd_and_id_only():
    files = [mk("a", stage="PD"), mk("c", stage="ID")]
    assert determine_scenario(compute_completeness(files, None)) == "PD_ID_ONLY"


def test_rd_and_id_only():
    files = [mk("b", stage="RD"), mk("c", stage="ID")]
    assert determine_scenario(compute_completeness(files, None)) == "RD_ID_ONLY"


def test_single_stage_only():
    files = [mk("a", stage="PD")]
    assert determine_scenario(compute_completeness(files, None)) == "SINGLE_ONLY"


def test_partial_upload_beats_other_scenarios():
    # ожидалось 15 файлов РД, загружено 2
    files = [mk("a", stage="PD"), mk("b", stage="RD"), mk("b2", stage="RD"),
             mk("c", stage="ID")]
    expected = {"PD": 1, "RD": 15, "ID": 1}
    assert determine_scenario(compute_completeness(files, expected)) == "PARTIALLY_LOADED"


def test_stage_statuses_are_reported_per_stage():
    files = [mk("a", stage="PD"), mk("b", stage="RD")]
    expected = {"PD": 1, "RD": 15, "ID": 3}
    result = {c.stage: c.status for c in compute_completeness(files, expected)}
    assert result == {"PD": "UPLOADED", "RD": "PARTIAL", "ID": "MISSING"}
