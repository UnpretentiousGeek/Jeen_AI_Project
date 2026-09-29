from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest


MODULE_PATH = (
    Path(__file__).resolve().parents[1]
    / "langflow"
    / "components"
    / "kyb_human_checkpoint_v3.py"
)
SPEC = importlib.util.spec_from_file_location("kyb_human_checkpoint_v3", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def test_information_submission_resumes_coordinator_without_replaying_specialist():
    routed = MODULE.route_human_decision(
        "information_request",
        "submit_clarification",
        {"clarification": "Owner B holds 25%."},
        {"specialty": "ownership", "task_id": "task-ownership-a1", "attempt": 1},
    )
    assert routed == {
        "route": "resume_coordinator",
        "response_values": {"clarification": "Owner B holds 25%."},
    }


@pytest.mark.parametrize(
    ("kind", "action", "expected"),
    [
        ("conflict_review", "escalate", "escalated"),
        ("conflict_review", "reject", "stopped"),
        ("specialist_recovery", "abort", "failed"),
        ("analyst_approval", "reject", "stopped"),
    ],
)
def test_terminal_human_decisions_are_deterministic(kind, action, expected):
    assert MODULE.route_human_decision(kind, action, {}, {})["route"] == expected


def test_an_empty_registry_search_can_be_continued_past():
    routed = MODULE.route_human_decision(
        "conflict_review", "continue_without_evidence",
        {"comment": "No registry record found; keep the gap open."},
        {"search_execution_id": "execution-1"},
    )
    assert routed == {"route": "continue_without_evidence"}


def test_rejected_search_continues_with_its_documented_gap():
    routed = MODULE.route_human_decision(
        "search_execution_approval",
        "reject",
        {"comment": "Use the submitted documents instead."},
        {"approved_scope": {
            "evidence_gap_id": "gap-1", "claim_id": "claim-1", "claim": "The applicant holds the license."
        }},
    )
    assert routed == {
        "route": "continue_without_search",
        "evidence_gap_id": "gap-1",
        "claim_id": "claim-1",
        "claim": "The applicant holds the license.",
    }


def test_specialist_retry_is_bounded_and_preserves_lineage():
    routed = MODULE.route_human_decision(
        "specialist_recovery",
        "retry",
        {},
        {"specialty": "policy", "task_id": "task-policy-a2", "attempt": 2},
    )
    assert routed["attempt"] == 3
    assert routed["parent_task_id"] == "task-policy-a2"
    with pytest.raises(ValueError, match="retry budget"):
        MODULE.route_human_decision(
            "specialist_recovery",
            "retry",
            {},
            {"specialty": "policy", "task_id": "task-policy-a3", "attempt": 3},
        )


def test_web_review_requires_exactly_one_decision_for_every_pending_result():
    context = {"pending_web_result_ids": ["result-1", "result-2"]}
    routed = MODULE.route_human_decision(
        "web_result_review",
        "accept",
        {
            "result_decisions": [
                {"result_id": "result-1", "decision": "accept", "rationale": "Official registry."},
                {"web_result_id": "result-2", "decision": "reject", "rationale": "Unrelated entity."},
            ]
        },
        context,
    )
    assert routed["route"] == "release_web_results"
    assert routed["accepted_web_result_ids"] == ["result-1"]
    assert routed["rejected_web_result_ids"] == ["result-2"]

    with pytest.raises(ValueError, match="exactly one decision"):
        MODULE.route_human_decision(
            "web_result_review",
            "accept",
            {"result_decisions": [{"web_result_id": "result-1", "decision": "accept", "rationale": "OK"}]},
            context,
        )
    with pytest.raises(ValueError, match="identifiers disagree"):
        MODULE.route_human_decision(
            "web_result_review",
            "accept",
            {
                "result_decisions": [
                    {
                        "result_id": "result-1",
                        "web_result_id": "other-result",
                        "decision": "accept",
                        "rationale": "Conflicting identifiers.",
                    },
                    {"result_id": "result-2", "decision": "reject", "rationale": "Unrelated entity."},
                ]
            },
            context,
        )


def test_search_and_action_approval_never_accept_altered_payloads():
    search = MODULE.route_human_decision(
        "search_execution_approval",
        "approve",
        {"operation_key": "search-op", "scope_hash": "abc"},
        {"scope_hash": "abc", "operation_key": "search-op"},
    )
    assert search == {"route": "execute_search", "operation_key": "search-op", "scope_hash": "abc"}
    with pytest.raises(ValueError, match="altered"):
        MODULE.route_human_decision(
            "search_execution_approval",
            "approve",
            {"operation_key": "search-op", "scope_hash": "different"},
            {"scope_hash": "abc", "operation_key": "search-op"},
        )
    with pytest.raises(ValueError, match="altered"):
        MODULE.route_human_decision(
            "search_execution_approval",
            "approve",
            {"operation_key": "other-op", "scope_hash": "abc"},
            {"scope_hash": "abc", "operation_key": "search-op"},
        )

    action = MODULE.route_human_decision(
        "analyst_approval",
        "approve",
        {"operation_key": "action-op", "proposal_hash": "proposal-1"},
        {"proposal_hash": "proposal-1", "operation_key": "action-op"},
    )
    assert action["route"] == "execute_action"
    with pytest.raises(ValueError, match="altered"):
        MODULE.route_human_decision(
            "analyst_approval",
            "approve",
            {"operation_key": "action-op", "proposal_hash": "proposal-2"},
            {"proposal_hash": "proposal-1", "operation_key": "action-op"},
        )
    with pytest.raises(ValueError, match="altered"):
        MODULE.route_human_decision(
            "analyst_approval",
            "approve",
            {"operation_key": "other-op", "proposal_hash": "proposal-1"},
            {"proposal_hash": "proposal-1", "operation_key": "action-op"},
        )


def test_search_changes_requested_requires_a_new_proposal():
    routed = MODULE.route_human_decision(
        "search_execution_approval",
        "changes_requested",
        {"requested_changes": {"summary": "Narrow the scope."}},
        {
            "checkpoint_id": "30000000-0000-4000-8000-000000000001",
            "request_id": "request-v1",
            "checkpoint_version": 1,
            "approved_scope": {"evidence_gap_id": "gap-1"},
            "scope_hash": "a" * 64,
        },
    )
    assert routed == {
        "route": "request_revised_search",
        "evidence_gap_id": "gap-1",
        "original_scope_hash": "a" * 64,
        "requested_changes": {"summary": "Narrow the scope."},
    }


def test_analyst_changes_requested_resumes_the_coordinator_with_the_request():
    routed = MODULE.route_human_decision(
        "analyst_approval",
        "changes_requested",
        {"requested_changes": {"comment": "Run a web search."}},
        {"checkpoint_id": "30000000-0000-4000-8000-000000000001", "request_id": "request-v1"},
    )
    assert routed == {"route": "analyst_revision", "requested_changes": {"comment": "Run a web search."}}
    with pytest.raises(ValueError, match="structured requested_changes"):
        MODULE.route_human_decision("analyst_approval", "changes_requested", {"requested_changes": {}}, {})


@pytest.mark.parametrize("kind", MODULE.CHECKPOINT_ACTIONS)
def test_skip_for_now_leaves_every_checkpoint_pending(kind):
    assert MODULE.route_human_decision(kind, "skip_for_now", {}, {}) == {
        "route": "pending",
        "transition": False,
    }
