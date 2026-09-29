from __future__ import annotations

import asyncio
import importlib.util
import json
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "langflow" / "components" / "save_specialist_contribution_v3.py"
SPEC = importlib.util.spec_from_file_location("save_specialist_contribution_v3", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

RUN = "10000000-0000-4000-8000-000000000001"
COORDINATOR = "20000000-0000-4000-8000-000000000001"
CASE = "30000000-0000-4000-8000-000000000001"
TASK = "entity-task-a1"
CONTEXT = "entity-context-a1"
DOC = "40000000-0000-4000-8000-000000000001"
POLICY = "50000000-0000-4000-8000-000000000001"
WEB = "60000000-0000-4000-8000-000000000001"


def envelope(**changes):
    value = {
        "schema_version": "3.0",
        "analysis_run_id": RUN,
        "coordinator_run_id": COORDINATOR,
        "case_id": CASE,
        "task_id": TASK,
        "context_id": CONTEXT,
        "specialty": "entity",
        "attempt": 1,
        "parent_task_id": None,
        "evidence_scope": {
            "permitted_document_ids": [DOC],
            "permitted_policy_version_ids": [POLICY],
            "permitted_web_result_ids": [WEB],
        },
    }
    value.update(changes)
    return value


def contribution(**changes):
    value = {
        "result_type": "specialist_contribution",
        "analysis_run_id": RUN,
        "coordinator_run_id": COORDINATOR,
        "case_id": CASE,
        "task_id": TASK,
        "context_id": CONTEXT,
        "specialty": "entity",
        "attempt": 1,
        "parent_task_id": None,
        "status": "completed",
        "citations": [{"id": "citation-1", "source_kind": "case_document", "source_id": DOC}],
    }
    value.update(changes)
    return value


def test_component_exposes_named_tool_and_never_uses_graph_run_id():
    assert MODULE.SaveSpecialistContributionV3.name == "save_specialist_contribution_v3"
    assert MODULE.SaveSpecialistContributionV3.inputs[0].tool_mode is True
    assert "graph.run_id" not in MODULE_PATH.read_text()


def test_correlation_mismatch_is_rejected():
    with pytest.raises(ValueError, match="result task_id"):
        MODULE.validate_result(contribution(task_id="other-task"), MODULE.validate_envelope(envelope(), COORDINATOR))


def test_out_of_scope_document_policy_and_web_citations_are_rejected():
    checked = MODULE.validate_envelope(envelope(), COORDINATOR)
    with pytest.raises(ValueError, match="outside the permitted"):
        MODULE.validate_contribution_scope(
            contribution(citations=[{"id": "c", "source_kind": "case_document", "source_id": "outside"}]), checked
        )
    with pytest.raises(ValueError, match="outside the permitted"):
        MODULE.validate_contribution_scope(
            contribution(citations=[{"id": "c", "source_kind": "policy", "source_id": "outside"}]), checked
        )
    with pytest.raises(ValueError, match="outside the permitted"):
        MODULE.validate_contribution_scope(
            contribution(specialty="public_research", citations=[{"id": "c", "source_kind": "external_web", "web_result_id": "outside"}]),
            MODULE.validate_envelope(envelope(specialty="public_research"), COORDINATOR),
        )


class _Result:
    def scalar_one(self):
        return {"status": "stored", "task_id": TASK}


class _Connection:
    def __init__(self):
        self.calls = []

    def execute(self, statement, params):
        self.calls.append((str(statement), params))
        return _Result()


class _Begin:
    def __init__(self, connection):
        self.connection = connection

    def __enter__(self):
        return self.connection

    def __exit__(self, *_args):
        return False


class _Engine:
    def __init__(self, connection):
        self.connection = connection

    def begin(self):
        return _Begin(self.connection)

    def dispose(self):
        pass


def test_accepted_payload_calls_simple_sql_saver(monkeypatch):
    connection = _Connection()
    monkeypatch.setattr(MODULE, "create_engine", lambda _url: _Engine(connection))
    component = MODULE.SaveSpecialistContributionV3.__new__(MODULE.SaveSpecialistContributionV3)
    component.input_value = json.dumps({
        "coordinator_run_id": COORDINATOR,
        "envelope": envelope(),
        "result": contribution(),
    })
    component.database_url = "postgresql://test"
    message = asyncio.run(component.run())
    payload = json.loads(message.text)
    assert payload["status"] == "accepted"
    assert payload["persisted"] is True
    assert "save_simple_coordinator_v3_contribution" in connection.calls[0][0]
    assert connection.calls[0][1]["run"] == COORDINATOR
    assert connection.calls[0][1]["attempt"] == 1


def test_non_contribution_result_is_routed_without_database_write(monkeypatch):
    def unexpected_engine(_url):
        raise AssertionError("routing result must not open a database")

    monkeypatch.setattr(MODULE, "create_engine", unexpected_engine)
    component = MODULE.SaveSpecialistContributionV3.__new__(MODULE.SaveSpecialistContributionV3)
    component.input_value = {
        "coordinator_run_id": COORDINATOR,
        "envelope": envelope(),
        "result": contribution(
            result_type="human_input_request",
            payload={"request_id": "request-1", "prompt": "Need an answer"},
        ),
    }
    component.database_url = "not-a-database-url"
    payload = json.loads(asyncio.run(component.run()).text)
    assert payload["status"] == "routed"
    assert payload["persisted"] is False
    assert payload["route"] == "human_input_request"
