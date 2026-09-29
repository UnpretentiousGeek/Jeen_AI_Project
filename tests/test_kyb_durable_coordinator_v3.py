from __future__ import annotations

import contextlib
import importlib.util
import asyncio
import sys
import json
from pathlib import Path

import pytest
from pydantic import ValidationError


MODULE_PATH = (
    Path(__file__).resolve().parents[1]
    / "langflow"
    / "components"
    / "kyb_durable_coordinator_v3.py"
)
SPEC = importlib.util.spec_from_file_location("kyb_durable_coordinator_v3", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


RUN_ID = "10000000-0000-4000-8000-000000000001"
COORDINATOR_ID = "20000000-0000-4000-8000-000000000001"


def test_identity_ownership_questions_cover_each_gap_and_do_not_repeat_answers():
    run = {
        "contributions": [
            {"specialty": "entity", "payload": {"status": "partial", "reconciliations": [
                {"field": "legal_name", "address_type": None, "identifier_type": None,
                 "declared_original": "Example Ltd", "outcome": "missing"},
                {"field": "address", "address_type": "registered", "identifier_type": None,
                 "declared_original": "1 Market Street", "outcome": "conflict"},
            ]}},
            {"specialty": "ownership", "payload": {"status": "completed", "anomalies": []}},
        ],
        # No official registry is configured for the jurisdiction, so only the analyst can verify.
        "identity_verification": {"status": "unverified", "registries": []},
        "answered_question_ids": [],
    }
    questions = MODULE.remaining_identity_ownership_questions(run)
    assert {item["id"] for item in questions} == {
        "entity:legal_name:", "entity:address:registered", "entity:independent_source",
    }
    run["answered_question_ids"] = [item["id"] for item in questions]
    assert MODULE.remaining_identity_ownership_questions(run) == []


def test_a_searchable_registry_replaces_the_independent_source_question():
    run = {
        "contributions": [
            {"specialty": "entity", "payload": {"status": "completed", "reconciliations": []}},
            {"specialty": "ownership", "payload": {"status": "completed", "anomalies": []}},
        ],
        "identity_verification": {"status": "unverified",
                                  "registries": [{"host": "gleif.org", "label": "GLEIF"}]},
        "answered_question_ids": [],
    }
    assert MODULE.remaining_identity_ownership_questions(run) == []


def test_entity_conflicts_offer_the_known_values_as_choices():
    conflict = {
        "field": "address", "address_type": "registered", "identifier_type": None,
        "declared_original": "1 Market Street", "declared_normalized": "1 market st",
        "documentary_values": [
            {"original": "1 Market St.", "normalized": "1 market st"},
            {"original": "9 Dock\nRoad", "normalized": "9 dock rd"},
        ],
        "outcome": "conflict",
    }
    single_value = {**conflict, "address_type": "operating", "documentary_values": [
        {"original": "1 Market St.", "normalized": "1 market st"},
    ]}
    missing = {"field": "legal_name", "address_type": None, "identifier_type": None,
               "declared_original": "Example Ltd", "documentary_values": [], "outcome": "missing"}
    run = {
        "contributions": [
            {"specialty": "entity", "payload": {"reconciliations": [conflict, single_value, missing]}},
            {"specialty": "ownership", "payload": {"anomalies": []}},
        ],
        "answered_question_ids": [],
    }
    questions = {item["id"]: item for item in MODULE.remaining_identity_ownership_questions(run)}
    # Each choice is the value alone; where it came from travels in choice_details.
    assert questions["entity:address:registered"]["choices"] == ["1 Market Street", "9 Dock Road"]
    assert [detail.get("declared", False) for detail in questions["entity:address:registered"]["choice_details"]] == [
        True, False]
    assert questions["entity:address:registered"]["question"] == (
        "Which value is correct for the applicant's registered address?")
    # Fewer than two distinct values, or no documentary value, leaves a free-text evidence request.
    assert "choices" not in questions["entity:address:operating"]
    assert "choices" not in questions["entity:legal_name:"]


def test_values_that_print_the_same_keep_their_sources_in_the_choice():
    row = {"field": "address", "address_type": "registered", "outcome": "conflict",
           "declared_original": "1 Market Street", "declared_normalized": "1 market st",
           "documentary_values": [{"original": "1 Market Street", "normalized": "1 market street"}]}
    assert [item["choice"] for item in MODULE.reconciliation_choices(row)] == [
        "1 Market Street (case form)", "1 Market Street (in documents)"]


def test_ownership_percentage_conflicts_offer_each_sourced_value_as_a_choice():
    register, declaration = "30000000-0000-4000-8000-000000000001", "30000000-0000-4000-8000-000000000002"
    ownership = {
        "relationships": [
            {"owner": "Maya Chen", "owned": "Northbridge Market Ltd", "percentage": 60.0, "citation_id": "case-1"},
            {"owner": "Maya Chen", "owned": "Northbridge Market Ltd", "percentage": 55.0, "citation_id": "case-2"},
            {"owner": "Maya Chen", "owned": "Northbridge Market Ltd", "percentage": 60.0, "citation_id": "case-3"},
            {"owner": "Daniel Price", "owned": "Northbridge Market Ltd", "percentage": 40.0, "citation_id": "case-4"},
            {"owner": "Daniel Price", "owned": "Northbridge Market Ltd", "percentage": 40.0, "citation_id": "case-5"},
        ],
        "citations": [
            {"id": "case-1", "source_id": register, "locator": "Page 1"},
            {"id": "case-2", "source_id": declaration, "locator": "Section 3"},
            {"id": "case-3", "source_id": register, "locator": "Page 2"},
            {"id": "case-4", "source_id": register, "locator": "Page 1"},
            {"id": "case-5", "source_id": register, "locator": "Page 1"},
        ],
        "anomalies": [
            {"type": "duplicate_relationship", "subject": "Daniel Price -> Northbridge Market Ltd", "details": "Repeated."},
            {"type": "inconsistent_percentage", "subject": "Maya Chen -> Northbridge Market Ltd", "details": "Inconsistent."},
        ],
    }
    run = {
        "contributions": [
            {"specialty": "entity", "payload": {"reconciliations": []}},
            {"specialty": "ownership", "payload": ownership},
        ],
        "document_refs": [
            {"document_id": register, "document_type": "shareholder_register"},
            {"document_id": declaration, "document_type": "business_declaration"},
        ],
        "answered_question_ids": [],
    }
    questions = [item for item in MODULE.remaining_identity_ownership_questions(run) if item["specialty"] == "ownership"]
    conflict = next(item for item in questions if item["field"] == "inconsistent_percentage")
    assert conflict["choices"] == ["55%", "60%"]
    assert [source["label"] for source in conflict["choice_details"][1]["sources"]] == [
        "Shareholder Register, Page 1", "Shareholder Register, Page 2"]
    assert conflict["question"] == "What percentage of Northbridge Market Ltd does Maya Chen own?"
    # The id is derived from the anomaly, so an answered conflict is not asked again.
    run["answered_question_ids"] = [conflict["id"]]
    assert all(item["id"] != conflict["id"] for item in MODULE.remaining_identity_ownership_questions(run))
    # A repeated relationship with one percentage has nothing to choose between: free text.
    duplicate = next(item for item in questions if item["field"] == "duplicate_relationship")
    assert "choices" not in duplicate
    # Each ownership question names the anomaly it resolves, so its answer can be shown beside it.
    assert duplicate["subject"] == "Daniel Price -> Northbridge Market Ltd"
    assert conflict["subject"]


def test_choices_name_the_file_and_page_and_carry_each_source_date_and_quote():
    extract, digest = "30000000-0000-4000-8000-000000000011", "30000000-0000-4000-8000-000000000012"
    entity = {
        "reconciliations": [{
            "field": "address", "address_type": "registered", "identifier_type": None,
            "declared_original": "1209 Orange Street", "declared_normalized": "1209 orange st",
            "documentary_values": [
                {"original": "1209 Orange Street", "normalized": "1209 orange st",
                 "citation_id": "case-e1", "observed_at": None},
                {"original": "1585 Broadway", "normalized": "1585 broadway",
                 "citation_id": "case-e2", "observed_at": "2026-09-21"},
            ],
            "outcome": "conflict",
        }],
        "citations": [
            {"id": "case-e1", "source_id": extract, "chunk_id": "chunk-1", "locator": "Document chunk 2",
             "excerpt": "| Registered address | 1209 Orange Street |"},
            {"id": "case-e2", "source_id": digest, "chunk_id": "chunk-9", "locator": "Document chunk 9",
             "excerpt": "Registered address 1585 Broadway"},
        ],
    }
    ownership = {
        "relationships": [
            {"owner": "MUFG", "owned": "Morgan Stanley", "percentage": 24.0, "citation_id": "case-o1"},
            {"owner": "MUFG", "owned": "Morgan Stanley", "percentage": 23.95, "citation_id": "case-o2"},
            {"owner": "MUFG", "owned": "Morgan Stanley", "percentage": 24.12, "citation_id": "case-o3"},
        ],
        "citations": [
            {"id": f"case-o{index}", "source_id": digest, "chunk_id": f"chunk-o{index}",
             "locator": f"Document chunk {index}", "excerpt": f"MUFG row {index}"}
            for index in (1, 2, 3)
        ],
        "anomalies": [{"type": "inconsistent_percentage", "subject": "MUFG -> Morgan Stanley", "details": "x"}],
    }
    run = {
        "contributions": [
            {"specialty": "entity", "payload": entity},
            {"specialty": "ownership", "payload": ownership},
        ],
        "document_names": {extract: "extract.pdf", digest: "digest.pdf"},
        "chunk_pages": {"chunk-o3": 6},
        "ownership_as_of": {"o1": "2025-11-04", "o2": "2026-04-13", "o3": "2026-07-15"},
        "answered_question_ids": [],
    }
    questions = {item["field"]: item for item in MODULE.remaining_identity_ownership_questions(run)}
    address = questions["address"]
    # Chunk-only locators are dropped; a known page is shown.
    assert address["choices"] == ["1209 Orange Street", "1585 Broadway"]
    assert address["choice_details"][0]["declared"] is True
    assert address["choice_details"][1]["sources"] == [
        {"label": "digest.pdf", "citation_id": "case-e2", "as_of": "2026-09-21",
         "excerpt": "Registered address 1585 Broadway"}]
    # The newest document can be the stale one, so identity conflicts carry no suggestion.
    assert "suggested_choice" not in address
    percentage = questions["inconsistent_percentage"]
    assert percentage["choices"] == ["23.95%", "24%", "24.12%"]
    assert percentage["choice_details"][2]["sources"] == [
        {"label": "digest.pdf, page 6", "citation_id": "case-o3", "as_of": "2026-07-15", "excerpt": "MUFG row 3"}]
    assert percentage["suggested_choice"] == "24.12%"
    # One undated figure means no date rule can pick between them.
    run["ownership_as_of"].pop("o1")
    undated = next(item for item in MODULE.remaining_identity_ownership_questions(run)
                   if item["field"] == "inconsistent_percentage")
    assert "suggested_choice" not in undated


def test_ownership_conflict_without_two_sourced_values_stays_free_text():
    ownership = {
        "relationships": [{"owner": "A", "owned": "B", "percentage": 50.0, "citation_id": "case-1"}],
        "citations": [{"id": "case-1", "source_id": "doc", "locator": "Page 1"}],
        "anomalies": [{"type": "inconsistent_percentage", "subject": "A -> B", "details": "Inconsistent."}],
    }
    run = {
        "contributions": [
            {"specialty": "entity", "payload": {"reconciliations": []}},
            {"specialty": "ownership", "payload": ownership},
        ],
        "answered_question_ids": [],
    }
    [question] = MODULE.remaining_identity_ownership_questions(run)
    assert "choices" not in question
    assert question["question"].startswith("Provide the ownership record")


def test_finished_specialists_request_all_gaps_before_policy_then_continue_after_answers():
    run = {
        "analysis_run_id": RUN_ID, "state_version": 2, "current_iteration": 2,
        "state": {"completed_specialists": ["entity", "ownership"]},
        "contributions": [
            {"specialty": "entity", "payload": {"status": "completed", "reconciliations": []}},
            {"specialty": "ownership", "payload": {"status": "completed", "anomalies": [
                {"type": "incomplete_chain", "subject": "Holding Ltd", "details": "No person path."},
            ]}},
        ],
        "identity_verification": {"status": "unverified", "registries": []},
        "answered_question_ids": [],
    }
    checkpoint = MODULE.deterministic_supervisor_directive(run)
    assert checkpoint.next_action == "request_checkpoint"
    assert {item["specialty"] for item in checkpoint.checkpoint_payload["questions"]} == {"entity", "ownership"}
    run["answered_question_ids"] = [item["id"] for item in checkpoint.checkpoint_payload["questions"]]
    resumed = MODULE.deterministic_supervisor_directive(run)
    assert resumed.next_action == "dispatch_specialist"
    assert resumed.target_specialty == "policy"


def directive(**overrides):
    value = {
        "schema_version": "1.0",
        "analysis_run_id": RUN_ID,
        "expected_state_version": 3,
        "iteration": 1,
        "plan": [
            {
                "specialty": "entity",
                "reason": "Reconcile the declared identity.",
                "task_objective": "Verify legal identity from permitted evidence.",
                "required": True,
            }
        ],
        "next_action": "dispatch_specialist",
        "target_specialty": "entity",
        "attempt": 1,
        "parent_task_id": None,
        "checkpoint_kind": None,
        "checkpoint_request_key": None,
        "checkpoint_title": None,
        "checkpoint_explanation": None,
        "allowed_actions": None,
        "checkpoint_payload": None,
        "final_payload": None,
        "proposed_action_type": None,
        "proposed_action_summary": None,
        "rationale_summary": "Entity is the next bounded step.",
        "terminal_reason": None,
    }
    value.update(overrides)
    return value


def test_python_supervisor_contract_accepts_valid_dispatch():
    parsed = MODULE.CoordinatorDirective.model_validate(directive())
    assert parsed.target_specialty == "entity"


def test_dispatch_serialization_retains_parent_task_id_but_omits_unrelated_nulls():
    first = MODULE.CoordinatorDirective.model_validate(directive())
    serialized_first = MODULE.serialize_directive(first)
    assert serialized_first["parent_task_id"] is None
    assert "checkpoint_kind" not in serialized_first
    assert "final_payload" not in serialized_first
    assert "proposed_action_type" not in serialized_first
    assert "terminal_reason" not in serialized_first

    retry = MODULE.CoordinatorDirective.model_validate(
        directive(attempt=2, parent_task_id="coord-v3:parent-task")
    )
    serialized_retry = MODULE.serialize_directive(retry)
    assert serialized_retry["parent_task_id"] == "coord-v3:parent-task"


@pytest.mark.parametrize(
    "changes",
    [
        {"target_specialty": None},
        {"attempt": None},
        {"attempt": 2, "parent_task_id": None},
        {"attempt": 1, "parent_task_id": "old-task"},
        {"checkpoint_kind": "information_request"},
        {"terminal_reason": "contradiction"},
        {"unexpected": True},
    ],
)
def test_python_supervisor_contract_rejects_contradictory_dispatch(changes):
    with pytest.raises(ValidationError):
        MODULE.CoordinatorDirective.model_validate(directive(**changes))


def test_checkpoint_requires_all_checkpoint_fields_and_forbids_specialist_fields():
    checkpoint = directive(
        next_action="request_checkpoint",
        target_specialty=None,
        attempt=None,
        parent_task_id=None,
        checkpoint_kind="information_request",
        checkpoint_request_key="ownership-gap-1",
        checkpoint_title="Missing ownership evidence",
        checkpoint_explanation="Provide the missing ownership evidence.",
        allowed_actions=["submit_clarification", "reject", "skip_for_now"],
        checkpoint_payload={"question": "What percentage does the owner hold?", "choices": ["25%", "50%"]},
    )
    assert MODULE.CoordinatorDirective.model_validate(checkpoint).checkpoint_kind == "information_request"
    with pytest.raises(ValidationError):
        MODULE.CoordinatorDirective.model_validate({**checkpoint, "attempt": 1})


def test_final_findings_require_citations_and_forbid_other_action_fields():
    final = directive(
        next_action="save_final_findings",
        target_specialty=None,
        attempt=None,
        parent_task_id=None,
        final_payload={
            "findings": [{
                "requirement_code": "IDENTITY-1",
                "outcome": "met",
                "summary": "Identity supported.",
                "rationale": "Pinned evidence matches.",
                "confidence": 0.95,
                "citations": [{
                    "source_kind": "case_document",
                    "document_chunk_id": "30000000-0000-4000-8000-000000000001",
                    "locator": "page 1",
                    "excerpt": "Legal entity name",
                }],
            }],
            "evidence_gaps": [],
            "conflicts": [],
        },
    )
    assert MODULE.CoordinatorDirective.model_validate(final).next_action == "save_final_findings"
    with pytest.raises(ValidationError):
        MODULE.CoordinatorDirective.model_validate({**final, "terminal_reason": "also stop"})


def test_operation_keys_are_stable_and_bound_to_run_iteration_and_payload():
    first = MODULE.operation_key(COORDINATOR_ID, 4, "specialist", {"task": "entity"})
    same = MODULE.operation_key(COORDINATOR_ID, 4, "specialist", {"task": "entity"})
    changed = MODULE.operation_key(COORDINATOR_ID, 4, "specialist", {"task": "ownership"})
    assert first == same
    assert first != changed
    assert first.startswith(f"coord:{COORDINATOR_ID}:iter:4:specialist:")


class FakeTool:
    def __init__(self, name):
        self.name = name


def test_tool_catalog_requires_one_unambiguous_tool_per_runtime_role():
    catalog = MODULE.build_tool_catalog(
        [
            FakeTool("run_entity_agent"),
            FakeTool("run_ownership_agent"),
            FakeTool("run_policy_agent"),
            FakeTool("run_public_research_agent"),
        ],
        [
            FakeTool("search_case_evidence_v3"),
            FakeTool("search_pinned_policy_evidence_v3"),
            FakeTool("read_accepted_web_evidence_v3"),
            FakeTool("save_specialist_contribution_v3"),
            FakeTool("kyb_human_checkpoint_v3"),
            FakeTool("kyb_tiny_fish_search_v3"),
            FakeTool("kyb_tiny_fish_fetch_v3"),
            FakeTool("save_final_findings_v3"),
            FakeTool("kyb_approved_action_executor_v3"),
        ],
    )
    assert catalog["specialist:entity"].name == "run_entity_agent"
    assert catalog["operation:checkpoint"].name == "kyb_human_checkpoint_v3"
    assert catalog["operation:contribution"].name == "save_specialist_contribution_v3"


def test_tool_catalog_rejects_missing_or_duplicate_roles():
    specialists = [
        FakeTool("run_entity_agent"),
        FakeTool("run_ownership_agent"),
        FakeTool("run_policy_agent"),
        FakeTool("run_public_research_agent"),
    ]
    operations = [
        FakeTool("search_case_evidence_v3"),
        FakeTool("search_pinned_policy_evidence_v3"),
        FakeTool("read_accepted_web_evidence_v3"),
        FakeTool("save_specialist_contribution_v3"),
        FakeTool("kyb_human_checkpoint_v3"),
        FakeTool("kyb_tiny_fish_search_v3"),
        FakeTool("kyb_tiny_fish_fetch_v3"),
        FakeTool("save_final_findings_v3"),
        FakeTool("kyb_approved_action_executor_v3"),
    ]
    with pytest.raises(ValueError, match="missing runtime tool"):
        MODULE.build_tool_catalog(specialists[:-1], operations)
    with pytest.raises(ValueError, match="duplicate runtime tool"):
        MODULE.build_tool_catalog(specialists + [FakeTool("run_entity_agent")], operations)


def test_real_operation_components_expose_the_exact_runtime_tool_names():
    component_dir = Path(__file__).resolve().parents[1] / "langflow" / "components"
    components = [
        ("kyb_human_checkpoint_v3.py", "KybHumanCheckpointV3", "kyb_human_checkpoint_v3"),
        ("kyb_tinyfish_search_v3.py", "KybTinyFishSearchV3", "kyb_tiny_fish_search_v3"),
        ("kyb_tinyfish_fetch_v3.py", "KybTinyFishFetchV3", "kyb_tiny_fish_fetch_v3"),
        ("save_final_findings_v3.py", "SaveFinalFindingsV3", "save_final_findings_v3"),
        ("kyb_approved_action_executor_v3.py", "KybApprovedActionExecutorV3", "kyb_approved_action_executor_v3"),
    ]
    for filename, class_name, expected_name in components:
        spec = importlib.util.spec_from_file_location(f"tool_name_{class_name}", component_dir / filename)
        assert spec and spec.loader
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        tools = asyncio.run(getattr(module, class_name)().to_toolkit())
        assert [tool.name for tool in tools] == [expected_name]


def test_structured_supervisor_response_accepts_json_content_and_rejects_fences():
    class Response:
        content = json.dumps(directive())

    parsed = MODULE.parse_supervisor_response(Response())
    assert parsed.next_action == "dispatch_specialist"

    class Fenced:
        content = "```json\n" + json.dumps(directive()) + "\n```"

    with pytest.raises(ValueError, match="plain JSON object"):
        MODULE.parse_supervisor_response(Fenced())


def test_directive_must_match_fresh_persisted_run_version_and_next_iteration():
    parsed = MODULE.CoordinatorDirective.model_validate(directive())
    MODULE.validate_directive_against_run(
        parsed,
        {
            "analysis_run_id": RUN_ID,
            "state_version": 3,
            "current_iteration": 0,
            "max_iterations": 12,
            "phase": "running",
        },
    )
    with pytest.raises(ValueError, match="state_version"):
        MODULE.validate_directive_against_run(
            parsed,
            {
                "analysis_run_id": RUN_ID,
                "state_version": 2,
                "current_iteration": 0,
                "max_iterations": 12,
                "phase": "running",
            },
        )
    with pytest.raises(ValueError, match="next persisted iteration"):
        MODULE.validate_directive_against_run(
            parsed,
            {
                "analysis_run_id": RUN_ID,
                "state_version": 3,
                "current_iteration": 1,
                "max_iterations": 12,
                "phase": "running",
            },
        )


DOCUMENT_ID = "40000000-0000-4000-8000-000000000001"
CHUNK_ID = "30000000-0000-4000-8000-000000000001"
POLICY_VERSION_ID = "50000000-0000-4000-8000-000000000001"
POLICY_CHUNK_ID = "60000000-0000-4000-8000-000000000001"


def final_directive(citations):
    return MODULE.CoordinatorDirective.model_validate(directive(
        next_action="save_final_findings",
        target_specialty=None,
        attempt=None,
        parent_task_id=None,
        final_payload={
            "findings": [{
                "requirement_code": "IDENTITY-1",
                "outcome": "met",
                "summary": "Identity supported.",
                "rationale": "Pinned evidence matches.",
                "citations": citations,
            }],
            "evidence_gaps": [],
            "conflicts": [],
        },
    ))


def scoped_run():
    return {"citation_scope": {
        "document_ids": [DOCUMENT_ID],
        "document_chunk_ids": [CHUNK_ID],
        "policy_version_ids": [POLICY_VERSION_ID],
        "policy_chunk_ids": [POLICY_CHUNK_ID],
        "human_input_request_ids": [],
        "external_web": [],
    }}


def case_citation(chunk_id):
    return {"source_kind": "case_document", "document_chunk_id": chunk_id, "locator": "chunk 1", "excerpt": "Legal name"}


def test_synthesis_view_names_citation_chunks_with_final_payload_fields():
    contributions = [{"specialty": "entity", "payload": {"citations": [
        {"id": "case-abc", "source_kind": "case_document", "chunk_id": CHUNK_ID,
         "source_id": DOCUMENT_ID, "locator": "chunk 1", "excerpt": "Legal name"},
        {"id": "policy-abc", "source_kind": "policy", "chunk_id": POLICY_CHUNK_ID,
         "source_id": POLICY_VERSION_ID, "locator": "s1", "excerpt": "Rule"},
    ]}}]
    citations = MODULE.synthesis_contributions(contributions)[0]["payload"]["citations"]
    assert citations[0] == {
        "source_kind": "case_document", "document_chunk_id": CHUNK_ID, "document_id": DOCUMENT_ID,
        "contribution_citation_ref": "case-abc", "locator": "chunk 1", "excerpt": "Legal name",
    }
    assert citations[1]["policy_chunk_id"] == POLICY_CHUNK_ID
    assert citations[1]["policy_version_id"] == POLICY_VERSION_ID
    assert "chunk_id" not in citations[1] and "source_id" not in citations[1]
    assert contributions[0]["payload"]["citations"][0]["chunk_id"] == CHUNK_ID


def test_final_citation_scope_accepts_run_chunks_and_explains_document_ids():
    MODULE.validate_final_citation_scope(final_directive([case_citation(CHUNK_ID)]), scoped_run())
    with pytest.raises(ValueError, match="is a document_id, not a document_chunk_id"):
        MODULE.validate_final_citation_scope(final_directive([case_citation(DOCUMENT_ID)]), scoped_run())
    with pytest.raises(ValueError, match="not in this analysis run's evidence"):
        MODULE.validate_final_citation_scope(
            final_directive([case_citation("70000000-0000-4000-8000-000000000001")]), scoped_run()
        )


def test_final_citation_scope_ignores_non_final_directives():
    MODULE.validate_final_citation_scope(MODULE.CoordinatorDirective.model_validate(directive()), {})


def test_tool_error_text_is_reported_as_a_failure_not_invalid_json():
    with pytest.raises(ValueError, match=r"^tool save response failed: \(psycopg2"):
        MODULE.object_value("(psycopg2.errors.InsufficientPrivilege) guard message\n", "tool save response")
    with pytest.raises(ValueError, match="returned invalid JSON"):
        MODULE.object_value("{not json", "tool save response")


GAP_ID = "80000000-0000-4000-8000-000000000001"
SECOND_GAP_ID = "80000000-0000-4000-8000-000000000002"


def research_run(extra_gap=False, **state):
    gaps = [{
        "evidence_gap_id": GAP_ID, "requirement_code": "ENTITY_RECONCILIATION",
        "description": "No independent registry verification.", "requested_evidence": "Registry extract",
    }]
    if extra_gap:
        gaps.append({
            "evidence_gap_id": SECOND_GAP_ID, "requirement_code": "OWNERSHIP-DISCLOSURE",
            "description": "Owners not independently verified.", "requested_evidence": "PSC record",
        })
    return {
        "analysis_run_id": RUN_ID,
        "coordinator_run_id": COORDINATOR_ID,
        "state_version": 7,
        "current_iteration": 5,
        "state": {"completed_specialists": ["entity", "ownership", "policy"], "latest_findings": ["f"], **state},
        "evidence_gaps": gaps,
        "search_scope_hashes": [],
        "answered_question_ids": [],
        "contributions": [],
    }


def drafted(**overrides):
    return {
        "evidence_gap_id": GAP_ID,
        "query": "Northbridge Market Ltd 15846271",
        "allowed_domains": ["https://find-and-update.company-information.service.gov.uk/"],
        "disclosed_applicant_fields": ["legal_name", "registration_number"],
        "result_limit": 5,
        "rationale": "Confirm registration in the official registry.",
        **overrides,
    }


def test_analyst_research_plan_bounds_model_drafted_scopes():
    plan = MODULE.analyst_research_plan(
        json.dumps({"response_summary": "I drafted a registry search.", "research": [drafted()]}),
        research_run(), {"comment": "web search"},
    )
    scope = plan["research"][0]["approved_scope"]
    assert scope["allowed_domains"] == ["find-and-update.company-information.service.gov.uk"]
    assert scope["claim_id"] == "gap:ENTITY_RECONCILIATION"
    assert plan["research"][0]["scope_hash"] == MODULE.search_scope_hash(scope)
    assert plan["research"][0]["operation_key"].startswith(f"coord:{COORDINATOR_ID}:iter:5:analyst_research:")

    for bad, message in [
        (drafted(evidence_gap_id="90000000-0000-4000-8000-000000000009"), "evidence gaps"),
        (drafted(allowed_domains=[]), "1-8 public hostnames"),
        (drafted(allowed_domains=["10.0.0.1"]), "1-8 public hostnames"),
        (drafted(disclosed_applicant_fields=["email"]), "allowlist"),
        (drafted(result_limit=50), "between 1 and 10"),
    ]:
        with pytest.raises(ValueError, match=message):
            MODULE.analyst_research_plan(
                json.dumps({"response_summary": "x", "research": [bad]}), research_run(), {"comment": "x"}
            )


def test_planned_research_becomes_a_search_approval_before_the_handoff_returns():
    plan = MODULE.analyst_research_plan(
        json.dumps({"response_summary": "Drafted.", "research": [drafted()]}), research_run(), {"comment": "x"}
    )
    run = research_run(analyst_research=plan)
    directive = MODULE.deterministic_supervisor_directive(run)
    assert directive.next_action == "request_checkpoint"
    assert directive.checkpoint_kind == "search_execution_approval"
    assert directive.checkpoint_payload == plan["research"][0]

    run["search_scope_hashes"] = [plan["research"][0]["scope_hash"]]
    assert MODULE.deterministic_supervisor_directive(run).next_action == "propose_action"


def test_accepted_search_results_dispatch_public_research_before_more_research():
    plan = MODULE.analyst_research_plan(
        json.dumps({"response_summary": "Drafted.", "research": [drafted()]}), research_run(), {"comment": "x"}
    )
    run = research_run(analyst_research=plan, analyst_research_history=[plan])
    run["pending_research_analyses"] = [{"search_execution_id": "exec-1", "approved_plan": {"query": "q"}}]
    directive = MODULE.deterministic_supervisor_directive(run)
    assert (directive.next_action, directive.target_specialty, directive.attempt, directive.parent_task_id) == (
        "dispatch_specialist", "public_research", 1, None,
    )

    run["contributions"] = [{"specialty": "public_research", "task_id": "task-1", "attempt": 1}]
    assert MODULE.public_research_dispatch(run) == {
        "search_execution_id": "exec-1", "approved_plan": {"query": "q"}, "attempt": 2, "parent_task_id": "task-1",
    }
    run["contributions"] = [
        {"specialty": "public_research", "task_id": f"task-{n}", "attempt": n} for n in (1, 2, 3)
    ]
    assert MODULE.public_research_dispatch(run) is None


def test_analyst_research_is_capped_by_the_run_public_research_budget():
    used = {"research": [{"scope_hash": "a"}, {"scope_hash": "b"}]}
    run = research_run(analyst_research_history=[used])
    assert MODULE.remaining_research_budget(run) == 1
    with pytest.raises(ValueError, match="at most 1 more"):
        MODULE.analyst_research_plan(json.dumps({"response_summary": "x", "research": [
            drafted(), drafted(evidence_gap_id=GAP_ID, query="other"),
        ]}), run, {"comment": "x"})


def test_findings_are_resynthesized_only_after_revision_research_is_analyzed():
    revision = {"request_id": "req-1", "research": []}
    run = research_run(analyst_research=revision)
    run["public_research_since_revision"] = 1
    assert MODULE.needs_resynthesis(run)

    assert not MODULE.needs_resynthesis({**run, "public_research_since_revision": 0})
    assert not MODULE.needs_resynthesis({**run, "pending_research_analyses": [{"search_execution_id": "e"}]})
    done = research_run(analyst_research=revision, findings_superseded_for="req-1")
    done["public_research_since_revision"] = 1
    assert not MODULE.needs_resynthesis(done)


def test_synthesis_view_gives_web_citations_their_final_provenance():
    contribution = {"specialty": "public_research", "task_id": "task-9", "payload": {
        "contribution_id": "public-research-task-9",
        "citations": [{"id": "web-r1", "immutable_result_id": "r1", "canonical_url": "https://example.gov/x",
                       "excerpt": "Registered.", "title": "Registry"}],
    }}
    [view] = MODULE.synthesis_contributions([contribution])
    assert view["payload"]["citations"][0] == {
        "source_kind": "external_web", "external_web_evidence_id": "r1", "agent_task_id": "task-9",
        "agent_artifact_id": "public-research-task-9", "locator": "https://example.gov/x",
        "excerpt": "Registered.", "title": "Registry", "contribution_citation_ref": "web-r1",
    }


def test_synthesis_view_passes_agent_observations_as_advisory_text_only():
    contribution = {"specialty": "ownership", "task_id": "task-4", "payload": {
        "citations": [{"id": "case-e1", "source_kind": "case_document", "source_id": "d1",
                       "chunk_id": "c1", "locator": "Page 1", "excerpt": "Marco Ferri: 45%"}],
        "observations": [{"id": "obs-1", "kind": "percentage_conflict_explanation",
                          "about": "anomaly:inconsistent_percentage", "statement": "Dated 31 March 2026.",
                          "confidence": "high", "citations": ["case-e1"]}],
    }}
    [view] = MODULE.synthesis_contributions([contribution])
    assert "observations" not in view["payload"]
    # Synthesis can read the note but gets nothing citable from it.
    assert view["payload"]["advisory_observations"] == [{
        "kind": "percentage_conflict_explanation", "about": "anomaly:inconsistent_percentage",
        "statement": "Dated 31 March 2026.", "confidence": "high"}]
    assert view["payload"]["citations"][0]["document_chunk_id"] == "c1"


def test_structured_output_schemas_convert_to_openai_response_formats():
    from langchain_openai.chat_models.base import _convert_to_openai_response_format

    for schema in (MODULE.ANALYST_RESEARCH_SCHEMA, MODULE.SUPERVISOR_FINAL_SYNTHESIS_SCHEMA):
        assert _convert_to_openai_response_format(schema, strict=True)["type"] == "json_schema"


def test_interrupted_analyst_research_returns_to_the_handoff():
    plan = MODULE.analyst_research_plan(
        json.dumps({"response_summary": "Drafted.", "research": [drafted()]}), research_run(), {"comment": "x"}
    )
    run = research_run(analyst_research={**plan, "failed": {"reason": "search tool failed"}})
    assert MODULE.next_analyst_research(run) is None
    assert MODULE.deterministic_supervisor_directive(run).next_action == "propose_action"


def test_specialist_recovery_explains_a_recorded_failure():
    run = research_run(last_failure={
        "reason": "Langflow tool run_public_research_agent failed.",
        "failed_action": {"next_action": "dispatch_specialist", "target_specialty": "public_research"},
    })
    assert MODULE.specialist_recovery_explanation(run, "public_research").startswith(
        "The previous Public Research attempt failed: Langflow tool run_public_research_agent failed."
    )
    assert "was not saved" in MODULE.specialist_recovery_explanation(run, "policy")


def test_analyst_revisions_extend_the_iteration_budget():
    assert MODULE.iteration_budget(8, {"max_iterations": 8, "state": {}}) == 8
    assert MODULE.iteration_budget(8, {"max_iterations": 16, "state": {"analyst_iteration_allowance": 8}}) == 16
    assert MODULE.iteration_budget(8, {"max_iterations": 12, "state": {"analyst_iteration_allowance": 8}}) == 12


def test_rejecting_a_drafted_search_or_all_its_results_ends_the_remaining_research():
    plan = MODULE.analyst_research_plan(json.dumps({"response_summary": "Drafted.", "research": [
        drafted(), drafted(evidence_gap_id=SECOND_GAP_ID, query="Companies House PSC"),
    ]}), research_run(extra_gap=True), {"comment": "x"})
    first, second = (item["scope_hash"] for item in plan["research"])
    run = research_run(extra_gap=True, analyst_research=plan)
    directive = MODULE.deterministic_supervisor_directive(run)
    assert directive.checkpoint_title == "Approve Web Search 1 of 2"
    assert "skips the remaining drafted searches" in directive.checkpoint_explanation

    run["search_scope_hashes"] = [first]
    assert MODULE.next_analyst_research(run)["scope_hash"] == second
    assert MODULE.next_analyst_research({**run, "all_results_rejected_scope_hashes": [first]}) is None
    rejected = research_run(extra_gap=True, analyst_research=plan, rejected_searches=[{"scope_hash": first}])
    rejected["search_scope_hashes"] = [first]
    assert MODULE.next_analyst_research(rejected) is None
    assert MODULE.deterministic_supervisor_directive(rejected).next_action == "propose_action"


def verification_run(**overrides):
    run = {
        "coordinator_run_id": RUN_ID, "current_iteration": 5,
        "state": {"latest_findings": [{"id": "finding-1"}]},
        "case_snapshot": {
            "applicant": {"legal_name": "Example Ltd", "jurisdiction": "GB"},
            "submitted_payload": {"entity_declaration": {
                "identifiers": [{"type": "registration_number", "value": "12345678"}],
            }},
        },
        "identity_verification": {"status": "unverified", "registries": [
            {"host": "company-information.service.gov.uk", "label": "Companies House"},
            {"host": "gleif.org", "label": "GLEIF"},
        ]},
        "evidence_gaps": [{"evidence_gap_id": "11111111-2222-4333-8444-555555555555",
                           "requirement_code": MODULE.VERIFICATION_GAP_CODE}],
        "search_scope_hashes": [], "pending_research_analyses": [],
    }
    run.update(overrides)
    return run


def test_unverified_identity_keeps_a_verification_gap_in_the_findings():
    payload = {"findings": [], "evidence_gaps": [], "conflicts": []}
    unverified = MODULE.with_verification_gap(payload, verification_run())
    assert [gap["requirement_code"] for gap in unverified["evidence_gaps"]] == [MODULE.VERIFICATION_GAP_CODE]
    assert "Companies House or GLEIF" in unverified["evidence_gaps"][0]["requested_evidence"]
    assert MODULE.with_verification_gap(unverified, verification_run()) == unverified
    # A model-written gap under the server's code is replaced by the server's wording, once.
    model_gap = {"requirement_code": MODULE.VERIFICATION_GAP_CODE, "description": "Model wording.",
                 "requested_evidence": "Something."}
    other_gap = {"requirement_code": "OWNERSHIP-X", "description": "Other.", "requested_evidence": "Other."}
    replaced = MODULE.with_verification_gap({**payload, "evidence_gaps": [model_gap, other_gap]}, verification_run())
    assert replaced["evidence_gaps"][0] == other_gap
    assert replaced["evidence_gaps"][1:] == unverified["evidence_gaps"]
    verified = verification_run(identity_verification={"status": "verified", "registries": []})
    assert MODULE.with_verification_gap(payload, verified) == payload
    assert MODULE.with_verification_gap({**payload, "evidence_gaps": [model_gap]}, verified)["evidence_gaps"] == []


def test_verification_research_searches_only_official_registries_once():
    plan = MODULE.verification_research_plan(verification_run())
    scope = plan["research"][0]["approved_scope"]
    assert scope["allowed_domains"] == ["company-information.service.gov.uk", "gleif.org"]
    assert scope["claim_id"] == MODULE.VERIFICATION_CLAIM_ID
    assert scope["evidence_gap_id"] == "11111111-2222-4333-8444-555555555555"
    assert scope["query"] == '"Example Ltd" 12345678'
    assert set(scope["disclosed_applicant_fields"]) <= set(MODULE.RESEARCH_DISCLOSURES)
    planned = verification_run(state={"latest_findings": [{}], "verification_research_planned": True})
    assert MODULE.verification_research_plan(planned) is None
    verified = verification_run(identity_verification={"status": "verified", "registries": [{"host": "gleif.org"}]})
    assert MODULE.verification_research_plan(verified) is None
    assert MODULE.verification_research_plan(verification_run(state={})) is None



def test_the_handoff_reports_what_each_drafted_search_found():
    def run_with(**overrides):
        run = {
            "state": {"analyst_research": {
                "response_summary": "I will draft a Companies House search.",
                "research": [{"scope_hash": "h1", "approved_scope": {
                    "allowed_domains": ["company-information.service.gov.uk"]}}],
            }},
            "search_executions": {}, "all_results_rejected_scope_hashes": [],
            "public_research_since_revision": 0,
        }
        run.update(overrides)
        return run

    empty = run_with(search_executions={"h1": {"status": "failed", "error_code": "no_eligible_candidates"}})
    assert MODULE.research_outcome_summary(empty) == (
        "The search of company-information.service.gov.uk found no matching results.")
    declined = run_with()
    declined["state"]["rejected_searches"] = [{"scope_hash": "h1"}]
    assert "was declined" in MODULE.research_outcome_summary(declined)
    assert "was rejected in review" in MODULE.research_outcome_summary(
        run_with(all_results_rejected_scope_hashes=["h1"]))
    assert "findings were updated" in MODULE.research_outcome_summary(run_with(
        search_executions={"h1": {"status": "completed", "error_code": None}}, public_research_since_revision=1))
    assert "did not complete" in MODULE.research_outcome_summary(run_with())
    no_search = run_with()
    no_search["state"]["analyst_research"]["research"] = []
    assert MODULE.research_outcome_summary(no_search) is None


PARALLEL_PLAN = MODULE.coordinator_plan()


def parallel_directive(**overrides):
    return directive(**{
        "plan": PARALLEL_PLAN, "next_action": "dispatch_specialists", "target_specialty": None,
        "target_specialties": ["entity", "ownership"], **overrides,
    })


def test_entity_and_ownership_first_attempts_dispatch_together():
    parsed = MODULE.CoordinatorDirective.model_validate(parallel_directive())
    serialized = MODULE.serialize_directive(parsed)
    assert serialized["target_specialties"] == ["entity", "ownership"]
    assert serialized["parent_task_id"] is None
    assert "target_specialty" not in serialized


@pytest.mark.parametrize(
    "changes",
    [
        {"target_specialties": ["entity", "policy"]},
        {"target_specialties": ["entity"]},
        {"target_specialties": ["entity", "entity"]},
        {"target_specialty": "entity"},
        {"attempt": 2, "parent_task_id": "old-task"},
        {"checkpoint_kind": "information_request"},
    ],
)
def test_parallel_dispatch_rejects_other_specialists_retries_and_mixed_fields(changes):
    with pytest.raises(ValidationError):
        MODULE.CoordinatorDirective.model_validate(parallel_directive(**changes))


def test_single_dispatch_cannot_carry_a_parallel_target_list():
    with pytest.raises(ValidationError):
        MODULE.CoordinatorDirective.model_validate(directive(target_specialties=["entity", "ownership"]))


def test_model_cannot_author_a_parallel_dispatch():
    run = {"analysis_run_id": RUN_ID, "state_version": 1, "current_iteration": 0}
    with pytest.raises(ValueError, match="next_action is invalid"):
        MODULE.normalize_supervisor_response(
            {"next_action": "dispatch_specialists", "rationale_summary": "Run both."}, run)


def test_supervisor_runs_entity_and_ownership_together_unless_capped_to_one():
    run = {"analysis_run_id": RUN_ID, "state_version": 1, "current_iteration": 0, "state": {}}
    together = MODULE.deterministic_supervisor_directive(run)
    assert together.next_action == "dispatch_specialists"
    assert together.target_specialties == ["entity", "ownership"]
    serial = MODULE.deterministic_supervisor_directive(run, max_parallel=1)
    assert (serial.next_action, serial.target_specialty) == ("dispatch_specialist", "entity")
    run["state"] = {"completed_specialists": ["entity"]}
    remaining = MODULE.deterministic_supervisor_directive(run)
    assert (remaining.next_action, remaining.target_specialty) == ("dispatch_specialist", "ownership")


class RateLimitError(Exception):
    pass


def test_rate_limits_are_recognized_with_the_providers_suggested_wait():
    assert MODULE.rate_limit_wait(RateLimitError("slow down")) == 0.0
    status = Exception("limited")
    status.status_code = 429
    assert MODULE.rate_limit_wait(status) == 0.0
    assert MODULE.rate_limit_wait(ValueError(
        "Error code: 429 - Rate limit reached for gpt. Please try again in 1.5s.")) == 1.5
    assert MODULE.rate_limit_wait(ValueError("rate_limit_exceeded: try again in 800ms")) == 0.8
    # Langflow returns a failed tool's error as text; only its first line reaches the message.
    with pytest.raises(ValueError) as raised:
        MODULE.object_value("Error running flow\nError code: 429 - rate_limit_exceeded", "tool response")
    assert MODULE.rate_limit_wait(raised.value) == 0.0
    assert MODULE.rate_limit_wait(ValueError("Error code: 429 - insufficient_quota")) is None
    assert MODULE.rate_limit_wait(ValueError("specialist contribution is invalid")) is None


class ScriptedTool:
    def __init__(self, name, outcomes):
        self.name = name
        self.outcomes = list(outcomes)
        self.calls = []

    async def ainvoke(self, arguments):
        self.calls.append(json.loads(arguments["input_value"]))
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome


def test_rate_limited_specialists_wait_and_retry_then_give_up():
    waits = []

    async def sleep(seconds):
        waits.append(seconds)

    limited = ValueError("Error code: 429 - Rate limit reached. Please try again in 45s.")
    tool = ScriptedTool("run_entity_agent", [limited, limited, {"status": "completed"}])
    assert asyncio.run(MODULE.invoke_specialist(tool, {}, sleep)) == {"status": "completed"}
    assert len(tool.calls) == 3
    assert 45 <= waits[0] <= 45 * 1.25 and 30 <= waits[1] <= 45 * 1.25

    waits.clear()
    exhausted = ScriptedTool("run_entity_agent", [limited] * 4)
    with pytest.raises(ValueError, match="429"):
        asyncio.run(MODULE.invoke_specialist(exhausted, {}, sleep))
    assert len(exhausted.calls) == 4 and len(waits) == 3

    broken = ScriptedTool("run_entity_agent", [ValueError("specialist crashed")])
    with pytest.raises(ValueError, match="crashed"):
        asyncio.run(MODULE.invoke_specialist(broken, {}, sleep))
    assert len(broken.calls) == 1


def test_a_hung_specialist_times_out_instead_of_stalling_the_analysis():
    class HungTool:
        name = "run_ownership_agent"
        calls = 0

        async def ainvoke(self, arguments):
            HungTool.calls += 1
            await asyncio.sleep(3600)

    async def no_wait(seconds):
        raise AssertionError("a timeout is not a rate limit and is not retried")

    with pytest.raises(TimeoutError, match="run_ownership_agent did not answer within 0.05 seconds"):
        asyncio.run(MODULE.invoke_specialist(HungTool(), {}, no_wait, timeout=0.05))
    assert HungTool.calls == 1


class FakeEngine:
    def begin(self):
        return contextlib.nullcontext(None)


class FakeCoordinator:
    """Runs the real dispatch code with scripted reservations and tools."""

    _execute_action = MODULE.KybDurableCoordinatorV3._execute_action
    _specialist_envelope = staticmethod(MODULE.KybDurableCoordinatorV3._specialist_envelope)
    _specialist_request = staticmethod(MODULE.KybDurableCoordinatorV3._specialist_request)
    _checkpoint_request = staticmethod(MODULE.KybDurableCoordinatorV3._checkpoint_request)

    def __init__(self, claims=None):
        self.claims = claims or {}

    def _reserve_specialist(self, connection, run, envelope, op_key):
        return self.claims.get(envelope["specialty"], "run")


class OverlappingSpecialist:
    """Finishes only once every specialist has started, so serial dispatch times out."""

    def __init__(self, name, started, expected, outcome):
        self.name = name
        self.started = started
        self.expected = expected
        self.outcome = outcome

    async def ainvoke(self, arguments):
        request = json.loads(arguments["input_value"])
        self.started.add(request["specialty"])
        async with asyncio.timeout(2):
            while len(self.started) < self.expected:
                await asyncio.sleep(0.01)
        if isinstance(self.outcome, BaseException):
            raise self.outcome
        return {**self.outcome, "task_id": request["task_id"]}


def dispatch_run():
    return {
        "analysis_run_id": RUN_ID, "coordinator_run_id": COORDINATOR_ID,
        "case_id": "30000000-0000-4000-8000-000000000001", "current_iteration": 1,
        "state": {}, "document_refs": [], "policy_refs": [], "accepted_web_results": [],
        "case_snapshot": {}, "analyst_instructions": "",
    }


def run_parallel_dispatch(outcomes, gate_outcomes=None, claims=None):
    started = set()
    specialists = {
        f"specialist:{specialty}": OverlappingSpecialist(f"run_{specialty}_agent", started, len(outcomes), outcome)
        for specialty, outcome in outcomes.items()
    }
    gate = ScriptedTool("save_specialist_contribution_v3", gate_outcomes or [{"status": "accepted"}] * 2)
    checkpoint = ScriptedTool("create_human_checkpoint_v3", [{"status": "waiting_for_human"}])
    catalog = {**specialists, "operation:contribution": gate, "operation:checkpoint": checkpoint}
    action = MODULE.serialize_directive(MODULE.CoordinatorDirective.model_validate(
        {**parallel_directive(), "iteration": 2}))
    coordinator = FakeCoordinator(claims)
    outcome = asyncio.run(coordinator._execute_action(catalog, dispatch_run(), action, FakeEngine()))
    return outcome, gate, checkpoint


def test_parallel_dispatch_runs_both_specialists_at_once_and_saves_both():
    outcome, gate, checkpoint = run_parallel_dispatch({
        "entity": {"status": "completed"}, "ownership": {"status": "completed"},
    })
    assert outcome == {"status": "accepted"}
    assert [call["envelope"]["specialty"] for call in gate.calls] == ["entity", "ownership"]
    assert all(call["envelope"]["attempt"] == 1 and call["envelope"]["parent_task_id"] is None
               for call in gate.calls)
    assert checkpoint.calls == []


def test_parallel_dispatch_saves_the_sibling_before_raising_a_checkpoint():
    routed = {"status": "routed", "route": "human_input_request",
              "result": {"payload": {"question": "Which owner holds the shares?"}}}
    outcome, gate, checkpoint = run_parallel_dispatch(
        {"entity": {"status": "completed"}, "ownership": {"status": "needs_input"}},
        gate_outcomes=[{"status": "accepted"}, routed],
    )
    assert outcome == {"status": "waiting_for_human"}
    assert len(gate.calls) == 2
    request = checkpoint.calls[0]["request"]
    assert request["checkpoint_kind"] == "information_request"
    assert request["payload"] == {"question": "Which owner holds the shares?"}


def test_parallel_dispatch_saves_the_sibling_before_raising_a_failure():
    with pytest.raises(ValueError, match="ownership crashed"):
        run_parallel_dispatch({"entity": {"status": "completed"}, "ownership": ValueError("ownership crashed")})


def test_parallel_dispatch_recovers_an_interrupted_attempt():
    outcome, gate, checkpoint = run_parallel_dispatch(
        {"entity": {"status": "completed"}, "ownership": {"status": "completed"}},
        claims={"entity": "recover", "ownership": "recover"},
    )
    assert outcome == {"status": "waiting_for_human"}
    assert gate.calls == []
    assert checkpoint.calls[0]["request"]["payload"]["specialty"] == "entity"


def test_the_model_cites_sources_by_short_handle_and_the_server_restores_exact_citations():
    chunk, document = "30000000-0000-4000-8000-0000000000c1", "30000000-0000-4000-8000-0000000000d1"
    answer_id = "30000000-0000-4000-8000-0000000000a1"
    contributions = [{"specialty": "entity", "payload": {"citations": [
        {"source_kind": "case_document", "document_chunk_id": chunk, "document_id": document,
         "contribution_citation_ref": "case-x", "locator": "Page 1", "excerpt": "Company number 19604271"},
        # The same source cited twice gets one handle.
        {"source_kind": "case_document", "document_chunk_id": chunk, "locator": "Page 1", "excerpt": "Company number 19604271"},
    ]}}]
    answers = [{"human_input_request_id": answer_id, "question_id": "entity:identifier", "answer": "19604271"}]
    view, cited_answers, catalog = MODULE.citation_handles(contributions, answers)

    shown = view[0]["payload"]["citations"]
    assert shown[0] == {"cite": "S1", "source_kind": "case_document", "locator": "Page 1", "excerpt": "Company number 19604271"}
    assert shown[1]["cite"] == "S1"
    assert cited_answers == [{"question_id": "entity:identifier", "answer": "19604271", "cite": "S2"}]
    assert catalog["S2"] == {"source_kind": "human_input", "human_input_request_id": answer_id,
                             "locator": "Analyst answer", "excerpt": "19604271"}

    payload = {"findings": [{"requirement_code": "ENTITY-ID", "outcome": "met", "summary": "s", "rationale": "r",
                             "confidence": 0.9, "citations": [{"cite": "s1"}, {"cite": "S2"}, {"cite": "S1"}]}],
               "evidence_gaps": [], "conflicts": []}
    resolved = MODULE.resolve_citation_handles(payload, catalog)
    assert resolved["findings"][0]["citations"] == [
        {"source_kind": "case_document", "document_chunk_id": chunk, "locator": "Page 1", "excerpt": "Company number 19604271"},
        catalog["S2"],
    ]

    payload["findings"][0]["citations"] = [{"cite": "S9"}]
    with pytest.raises(ValueError, match=r"findings\[0\]\.citations\[0\] cites S9"):
        MODULE.resolve_citation_handles(payload, catalog)
