"""app.incremental.build_merge_plan - the pure diff a дозагрузка's
incremental update (customer's ТЗ) runs between a process's previous checks
and a freshly recomputed set, before app.db.Database.apply_merge_plan ever
touches the database."""

from app.incremental import build_merge_plan


def _old_row(**overrides):
    defaults = dict(
        id="old-1", evidence_group_id="g1", parent_check_id=None,
        finding_status="CANDIDATE", engine_status="CANDIDATE",
        expected_value="10.00", actual_value="12.50", delta="+2.50",
        completeness_status="COMPLETE", rationale="Площадь изменена",
        verified_by=None, verified_at=None, split_at=None,
        fragments=[{"file_id": "f1", "sheet_page": 1, "x0": 0.1, "y0": 0.1, "x1": 0.2, "y1": 0.2}],
    )
    defaults.update(overrides)
    return defaults


def _new_check(**overrides):
    defaults = dict(
        param_code="M-003", evidence_group_id="g1", subject="room 1.1",
        expected_value="10.00", actual_value="12.50", delta="+2.50",
        completeness_status="COMPLETE", finding_status="CANDIDATE",
        review_priority="MEDIUM", rationale="Площадь изменена", matrix_version="1.1",
        fragments=[{"file_id": "f1", "sheet_page": 1, "x0": 0.1, "y0": 0.1, "x1": 0.2, "y1": 0.2}],
    )
    defaults.update(overrides)
    return defaults


def test_unchanged_group_is_kept_untouched():
    old = [_old_row(verified_by="inspector-1", finding_status="CONFIRMED_VIOLATION")]
    new = [_new_check()]  # finding_status CANDIDATE - the engine's own output, matches engine_status

    plan = build_merge_plan(old, new, {})

    assert plan.kept == 1
    assert plan.added == plan.changed == plan.removed == 0
    assert plan.insert == []
    assert plan.delete_ids == []
    assert plan.rationale_updates == []
    assert plan.decision_survived is True


def test_new_group_is_inserted():
    plan = build_merge_plan([], [_new_check(evidence_group_id="g-new")], {})

    assert plan.added == 1
    assert plan.kept == plan.changed == plan.removed == 0
    assert plan.insert == [_new_check(evidence_group_id="g-new")]


def test_undecided_group_the_engine_no_longer_produces_is_deleted():
    old = [_old_row(id="old-1", verified_by=None, split_at=None)]

    plan = build_merge_plan(old, [], {})

    assert plan.removed == 1
    assert plan.delete_ids == ["old-1"]
    assert plan.kept == 0
    assert plan.rationale_updates == []


def test_decided_group_the_engine_no_longer_produces_is_kept_with_a_note():
    old = [_old_row(id="old-1", verified_by="user-1", finding_status="CONFIRMED_VIOLATION")]

    plan = build_merge_plan(old, [], {"user-1": "Иванов И.И."})

    assert plan.removed == 0
    assert plan.kept == 1
    assert plan.decision_survived is True
    assert plan.delete_ids == []
    assert len(plan.rationale_updates) == 1
    check_id, rationale = plan.rationale_updates[0]
    assert check_id == "old-1"
    assert "больше не формирует эту находку" in rationale
    assert "Площадь изменена" in rationale  # the original rationale is kept, not overwritten


def test_changed_content_without_a_decision_is_replaced_silently():
    old = [_old_row(id="old-1", verified_by=None, actual_value="12.50")]
    new = [_new_check(actual_value="99.00")]  # the engine's own output changed

    plan = build_merge_plan(old, new, {})

    assert plan.changed == 1
    assert plan.delete_ids == ["old-1"]
    assert len(plan.insert) == 1
    assert plan.insert[0]["rationale"] == "Площадь изменена"  # no note - nothing was ever decided


def test_changed_content_with_a_decision_is_replaced_with_a_note_and_the_verdict_is_not_carried_over():
    old = [_old_row(id="old-1", verified_by="user-1", finding_status="CONFIRMED_VIOLATION", actual_value="12.50")]
    new = [_new_check(actual_value="99.00")]

    plan = build_merge_plan(old, new, {"user-1": "Иванов И.И."})

    assert plan.changed == 1
    assert plan.delete_ids == ["old-1"]
    inserted = plan.insert[0]
    # The fresh row carries no verdict fields at all (save_checks never reads
    # any - a freshly inserted check is always undecided) and its rationale
    # names the previous decision instead of silently dropping it.
    assert "CONFIRMED_VIOLATION" in inserted["rationale"]
    assert "Иванов И.И." in inserted["rationale"]
    assert "не перенесено" in inserted["rationale"]


def test_an_unsplit_composite_and_its_atoms_are_diffed_as_one_unit():
    composite = _old_row(id="composite-1", evidence_group_id="g-composite",
                          finding_status="CANDIDATE", verified_by=None)
    atom_1 = _old_row(id="atom-1", evidence_group_id="g-atom-1", parent_check_id="composite-1")
    atom_2 = _old_row(id="atom-2", evidence_group_id="g-atom-2", parent_check_id="composite-1")
    old = [composite, atom_1, atom_2]

    new_composite = _new_check(evidence_group_id="g-composite", atoms=[
        _new_check(evidence_group_id="g-atom-1"),
        _new_check(evidence_group_id="g-atom-2"),
    ])

    plan = build_merge_plan(old, [new_composite], {})

    assert plan.kept == 1
    assert plan.added == plan.changed == plan.removed == 0


def test_a_decided_atom_protects_the_whole_composite_unit_from_deletion():
    """The composite itself was never split or decided, but one atom was
    (an inspector split it, then confirmed one room) - the engine no longer
    reports this composite at all after a дозагрузка. Customer's ТЗ: a
    decision is never silently lost, so the whole unit survives."""
    composite = _old_row(id="composite-1", evidence_group_id="g-composite", split_at="2026-01-01T00:00:00")
    decided_atom = _old_row(id="atom-1", evidence_group_id="g-atom-1", parent_check_id="composite-1",
                             verified_by="user-1", finding_status="CONFIRMED_VIOLATION")
    plain_atom = _old_row(id="atom-2", evidence_group_id="g-atom-2", parent_check_id="composite-1")
    old = [composite, decided_atom, plain_atom]

    plan = build_merge_plan(old, [], {"user-1": "Иванов И.И."})

    assert plan.removed == 0
    assert plan.kept == 1
    assert plan.delete_ids == []
    updated_ids = {check_id for check_id, _ in plan.rationale_updates}
    # Every row carrying its own decision gets its own note - the composite
    # (split by an inspector) and the atom (confirmed by one) alike; the
    # plain, undecided atom is left exactly as it is.
    assert updated_ids == {"composite-1", "atom-1"}


def test_a_changed_composite_is_replaced_as_one_unit_when_any_atom_differs():
    composite = _old_row(id="composite-1", evidence_group_id="g-composite")
    atom_1 = _old_row(id="atom-1", evidence_group_id="g-atom-1", parent_check_id="composite-1", actual_value="9.00")
    old = [composite, atom_1]

    new_composite = _new_check(evidence_group_id="g-composite", atoms=[
        _new_check(evidence_group_id="g-atom-1", actual_value="99.00"),  # changed
    ])

    plan = build_merge_plan(old, [new_composite], {})

    assert plan.changed == 1
    assert set(plan.delete_ids) == {"composite-1", "atom-1"}
    assert len(plan.insert) == 1
    assert plan.insert[0]["evidence_group_id"] == "g-composite"
