from __future__ import annotations

import importlib.util
import json
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


CASE = load("search_case_evidence_v3")
POLICY = load("search_pinned_policy_evidence_v3")
WEB = load("read_accepted_web_evidence_v3")

RUN = "10000000-0000-4000-8000-000000000001"
CASE_ID = "20000000-0000-4000-8000-000000000001"
DOC = "30000000-0000-4000-8000-000000000001"
POLICY_ID = "40000000-0000-4000-8000-000000000001"
WEB_ID = "50000000-0000-4000-8000-000000000001"


@pytest.mark.parametrize(
    ("module", "payload", "message"),
    [
        (CASE, {"analysis_run_id": RUN, "case_id": CASE_ID, "permitted_document_ids": [], "query": "x"}, "explicit list"),
        (POLICY, {"analysis_run_id": RUN, "permitted_policy_version_ids": [POLICY_ID], "query": ""}, "query is required"),
        (WEB, {"analysis_run_id": RUN, "permitted_web_result_ids": ["not-a-uuid"]}, "valid UUID"),
    ],
)
def test_requests_require_bounded_explicit_scope(module, payload, message):
    with pytest.raises(ValueError, match=message):
        module.__dict__[next(name for name in module.__dict__ if name.endswith("V3") and isinstance(module.__dict__[name], type))]._validate(payload)


def test_case_request_normalizes_and_bounds_query():
    component = CASE.SearchCaseEvidenceV3.__new__(CASE.SearchCaseEvidenceV3)
    request = component._validate(
        json.dumps(
            {
                "analysis_run_id": RUN,
                "case_id": CASE_ID,
                "permitted_document_ids": [DOC],
                "query": "  incorporation  ",
                "limit": 2,
            }
        )
    )
    assert request == {
        "analysis_run_id": RUN,
        "case_id": CASE_ID,
        "permitted_document_ids": [DOC],
        "query": "incorporation",
        "limit": 2,
    }


def test_all_tools_are_tool_mode_and_use_scoped_names():
    assert CASE.SearchCaseEvidenceV3.inputs[0].tool_mode is True
    assert POLICY.SearchPinnedPolicyEvidenceV3.inputs[0].tool_mode is True
    assert WEB.ReadAcceptedWebEvidenceV3.inputs[0].tool_mode is True
    assert "get_coordinator_v3_accepted_web_evidence" in Path(
        ROOT / "langflow" / "components" / "read_accepted_web_evidence_v3.py"
    ).read_text()
