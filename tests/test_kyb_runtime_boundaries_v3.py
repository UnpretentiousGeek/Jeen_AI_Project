from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]


def load(name: str):
    path = ROOT / "langflow" / "components" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SEARCH = load("kyb_tinyfish_search_v3")
FETCH = load("kyb_tinyfish_fetch_v3")
ACTION = load("kyb_approved_action_executor_v3")
FINAL = load("kyb_final_snapshot_validator_v3")


def running(route: str, **fields):
    return {
        "phase": "running",
        "state": {"status": "running", "next_action": {"route": route, **fields}},
    }


def test_search_requires_exact_running_route_and_scope():
    with pytest.raises(ValueError, match="execute_search"):
        SEARCH._assert_pending_operation(running("fetch_search_results", operation_key="op", scope_hash="a"), operation_key="op", scope_hash="a")
    with pytest.raises(ValueError, match="operation_key"):
        SEARCH._assert_pending_operation(running("execute_search", operation_key="other", scope_hash="a"), operation_key="op", scope_hash="a")
    with pytest.raises(ValueError, match="running"):
        SEARCH._assert_pending_operation({"phase": "stopped", "state": {}}, operation_key="op", scope_hash="a")


def test_fetch_requires_exact_execution_and_operation():
    fields = {"operation_key": "op", "search_execution_id": "exec"}
    assert FETCH._assert_pending_operation(running("fetch_search_results", **fields), operation_key="op", execution_id="exec") == fields | {"route": "fetch_search_results"}
    with pytest.raises(ValueError, match="execution_id"):
        FETCH._assert_pending_operation(running("fetch_search_results", **fields), operation_key="op", execution_id="other")


def test_approved_action_requires_exact_proposal_and_route():
    fields = {"operation_key": "op", "proposal_hash": "hash"}
    assert ACTION._assert_pending_operation(running("execute_action", **fields), operation_key="op", proposal_hash="hash") == fields | {"route": "execute_action"}
    with pytest.raises(ValueError, match="proposal_hash"):
        ACTION._assert_pending_operation(running("execute_action", **fields), operation_key="op", proposal_hash="other")


@pytest.mark.parametrize(
    "run",
    [
        {"phase": "stopped", "analysis_status": "failed", "case_status": "processing", "stop_reason": "bounded", "state": {"next_action": {}}},
        {"phase": "stopped", "analysis_status": "succeeded", "case_status": "processing", "stop_reason": "bounded", "state": {}},
        {"phase": "stopped", "analysis_status": "failed", "case_status": "processing", "stop_reason": "", "state": {}},
        {"phase": "finalized", "analysis_status": "succeeded", "case_status": "ready_for_review", "stop_reason": "done", "state": {"pending_checkpoint": {}}},
        {"phase": "finalized", "analysis_status": "failed", "case_status": "ready_for_review", "stop_reason": "done", "state": {}},
    ],
)
def test_final_validator_rejects_incoherent_terminal_state(run):
    with pytest.raises(ValueError):
        FINAL._validate_terminal_coherence(run)


def test_final_validator_accepts_coherent_terminal_states():
    FINAL._validate_terminal_coherence({
        "phase": "stopped", "analysis_status": "failed", "case_status": "processing",
        "stop_reason": "bounded recovery exhausted", "state": {},
    })
    FINAL._validate_terminal_coherence({
        "phase": "finalized", "analysis_status": "succeeded", "case_status": "ready_for_review",
        "stop_reason": "completed", "state": {},
    })
