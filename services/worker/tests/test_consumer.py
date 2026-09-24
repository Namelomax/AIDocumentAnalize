import pytest
from app.consumer import handle_task, UnknownTaskType


def test_routes_process_start_to_the_pipeline_handler():
    payload = {"type": "process.start", "process_id": "p1", "object_id": "o1"}
    assert handle_task(payload) == "pipeline.start"


def test_unknown_task_type_raises():
    with pytest.raises(UnknownTaskType):
        handle_task({"type": "nonsense", "process_id": "p1", "object_id": "o1"})


def test_missing_process_id_raises():
    with pytest.raises(ValueError):
        handle_task({"type": "process.start", "object_id": "o1"})
