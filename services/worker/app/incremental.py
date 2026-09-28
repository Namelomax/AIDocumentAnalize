"""Merge logic for a дозагрузка's incremental update.

Customer's ТЗ "Инкрементальное обновление при дозагрузке": a дозагрузка does
not restart the whole check - it recomputes the full candidate set in memory
(app.pipeline._process_update_once) and this module decides, per group
(checks.evidence_group_id, a composite candidate and its atoms taken as one
unit - see build_merge_plan's own docstring), whether the old row survives
untouched, is replaced, is deleted, or a fresh one is inserted. The one rule
every branch below answers to: "без сброса верификации" - an inspector's
decision is never silently thrown away, even when the group it was made on
disappears or changes.

Pure and DB-free (same spirit as app.explication.compare): app.db.Database
only ever executes the MergePlan this produces, never decides what belongs
in one.
"""

from dataclasses import dataclass, field


def _round_box(fragment: dict) -> tuple:
    return (
        round(fragment["x0"], 4), round(fragment["y0"], 4),
        round(fragment["x1"], 4), round(fragment["y1"], 4),
    )


def _fragment_key(fragment: dict) -> tuple:
    """(file_id, page, box) - deliberately not role or extracted_value: the
    design's own comparison key (customer's ТЗ, "Merge by evidence_group_id"
    plan) is the evidence a group points at, not how it is labelled."""
    return (fragment["file_id"], fragment["sheet_page"], *_round_box(fragment))


def _content_key(check: dict) -> tuple:
    """A NEW (freshly computed) check dict's content, in the same shape
    _old_engine_content_key below reduces an OLD DB row to - the two must
    compare equal for a group whose engine output has not actually changed.
    """
    return (
        check.get("finding_status"),
        check.get("expected_value"), check.get("actual_value"), check.get("delta"),
        check.get("completeness_status"),
        frozenset(_fragment_key(f) for f in check.get("fragments") or []),
    )


def _old_engine_content_key(old_row: dict) -> tuple:
    """An OLD DB row's content as the engine itself produced it - engine_status
    when a verdict has since overwritten finding_status, falling back to
    finding_status for a row nothing ever decided (the same fallback
    routes/verdicts.ts uses: "engineStatus ?? findingStatus")."""
    engine_status = old_row.get("engine_status") or old_row.get("finding_status")
    return (
        engine_status,
        old_row.get("expected_value"), old_row.get("actual_value"), old_row.get("delta"),
        old_row.get("completeness_status"),
        frozenset(_fragment_key(f) for f in old_row.get("fragments") or []),
    )


def _has_decision(row: dict) -> bool:
    """An inspector's own action on this row - a verdict, or having split it
    as a composite. Never true for a row the engine alone ever touched."""
    return bool(row.get("verified_by")) or row.get("split_at") is not None


def _atoms_match(old_atoms: list[dict], new_atoms: list[dict]) -> bool:
    old_by_group = {a["evidence_group_id"]: a for a in old_atoms}
    new_by_group = {a["evidence_group_id"]: a for a in new_atoms}
    if set(old_by_group) != set(new_by_group):
        return False
    return all(
        _old_engine_content_key(old_by_group[gid]) == _content_key(new_by_group[gid])
        for gid in old_by_group
    )


def _decision_label(row: dict, user_name: str | None) -> str:
    who = user_name or row.get("verified_by") or "инспектором"
    status = row.get("finding_status")
    return f"{status}, {who}"


def _changed_note(decided_rows: list[dict], user_names: dict[str, str]) -> str:
    labels = [_decision_label(row, user_names.get(row.get("verified_by"))) for row in decided_rows]
    return (
        f"Предыдущее решение ({'; '.join(labels)}) было вынесено по прежним данным "
        "и не перенесено после дозагрузки — параметры изменились."
    )


_REMOVED_NOTE = "После дозагрузки система больше не формирует эту находку по текущим данным."


def _with_note(rationale: str | None, note: str) -> str:
    return f"{rationale}\n\n{note}" if rationale else note


@dataclass
class MergePlan:
    # Fresh check dicts (in app.db.Database.save_checks's own shape, atoms
    # nested under "atoms") to insert - covers both genuinely new groups and
    # groups whose content changed (the old row is deleted, this replaces it).
    insert: list[dict] = field(default_factory=list)
    # Old check ids (composite and atom ids alike) to delete outright - a
    # group the engine no longer produces, and that no inspector ever decided.
    delete_ids: list[str] = field(default_factory=list)
    # (check_id, new_rationale) pairs for rows kept exactly as they are
    # except for a note appended to their rationale (a decided group the
    # engine no longer produces).
    rationale_updates: list[tuple[str, str]] = field(default_factory=list)
    added: int = 0
    changed: int = 0
    removed: int = 0
    # Unchanged rows, plus rows kept only because they carried a decision
    # (customer's ТЗ: a decision is never silently lost) - both "stayed".
    kept: int = 0
    # Whether any surviving row still carries an inspector's decision - the
    # new protocol version opens VERIFYING rather than READY when it does
    # (app.pipeline._process_update_once).
    decision_survived: bool = False


def build_merge_plan(
    old_rows: list[dict],
    new_checks: list[dict],
    user_names: dict[str, str],
) -> MergePlan:
    """Diff a process's previous checks against a freshly recomputed set.

    old_rows: every row app.db.Database.get_checks_for_merge fetched for the
    process (composites and atoms alike, each with its own "fragments" list),
    snake_case exactly as the checks/evidence_fragments columns are named.

    new_checks: what app.pipeline._process_update_once just computed in
    memory, in the same shape app.pipeline._process_start_once always built
    for app.db.Database.save_checks - a composite's own atoms live nested
    under its own "atoms" key, never as separate top-level entries.

    A composite and its atoms are diffed as ONE unit, keyed by the
    composite's own evidence_group_id: an atom's identity only ever means
    anything next to the run it was split out of, so treating "the composite
    changed" and "one of its atoms changed" as two independent facts would
    only manufacture inconsistent state (an atom kept under a deleted
    composite, for instance) for a case rare enough - a run of >= 2 changed
    rooms - that this is not a bargain worth the added complexity here.
    """
    old_top = [row for row in old_rows if row.get("parent_check_id") is None]
    old_children_by_parent: dict[str, list[dict]] = {}
    for row in old_rows:
        parent_id = row.get("parent_check_id")
        if parent_id:
            old_children_by_parent.setdefault(parent_id, []).append(row)

    old_units = {
        row["evidence_group_id"]: {"row": row, "atoms": old_children_by_parent.get(row["id"], [])}
        for row in old_top
    }
    new_units = {check["evidence_group_id"]: check for check in new_checks}

    plan = MergePlan()
    group_ids = set(old_units) | set(new_units)

    for gid in group_ids:
        old_unit = old_units.get(gid)
        new_unit = new_units.get(gid)

        if old_unit and new_unit:
            new_atoms = new_unit.get("atoms") or []
            same_content = (
                _old_engine_content_key(old_unit["row"]) == _content_key(new_unit)
                and _atoms_match(old_unit["atoms"], new_atoms)
            )
            decided_rows = [r for r in [old_unit["row"], *old_unit["atoms"]] if _has_decision(r)]
            if same_content:
                plan.kept += 1
                if decided_rows:
                    plan.decision_survived = True
            else:
                plan.changed += 1
                plan.delete_ids.append(old_unit["row"]["id"])
                plan.delete_ids.extend(a["id"] for a in old_unit["atoms"])
                fresh = dict(new_unit)
                if decided_rows:
                    fresh["rationale"] = _with_note(fresh.get("rationale"), _changed_note(decided_rows, user_names))
                plan.insert.append(fresh)
        elif old_unit and not new_unit:
            decided_rows = [r for r in [old_unit["row"], *old_unit["atoms"]] if _has_decision(r)]
            if decided_rows:
                plan.kept += 1
                plan.decision_survived = True
                for row in decided_rows:
                    plan.rationale_updates.append((row["id"], _with_note(row.get("rationale"), _REMOVED_NOTE)))
            else:
                plan.removed += 1
                plan.delete_ids.append(old_unit["row"]["id"])
                plan.delete_ids.extend(a["id"] for a in old_unit["atoms"])
        elif new_unit and not old_unit:
            plan.added += 1
            plan.insert.append(new_unit)

    return plan
