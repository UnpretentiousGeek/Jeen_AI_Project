from __future__ import annotations

import importlib.util
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parents[1] / "langflow" / "components" / "public_research_scope_v3.py"
SPEC = importlib.util.spec_from_file_location("public_research_scope_v3", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
Scope = MODULE.KybPublicResearchScope

RUN = {
    "analysis_run_id": "10000000-0000-4000-8000-000000000001",
    "submitted_payload": {"entity_declaration": {
        "identifiers": [{"type": "registration_number", "value": "15846271"}],
        "addresses": {"registered": "42 Harbor Lane, Bristol"},
    }},
}


class _Rows:
    def __init__(self, row):
        self.row = row

    def mappings(self):
        return self

    def one_or_none(self):
        return self.row


class _Connection:
    def __init__(self, row):
        self.row, self.params = row, None

    def execute(self, _statement, params):
        self.params = params
        return _Rows(self.row)


def operation(claim_id="gap:ENTITY_RECONCILIATION", claim="No registry verification."):
    return {"action_payload": {"claim_id": claim_id, "claim": claim}}


def test_gap_claim_is_admitted_only_for_a_persisted_gap_of_the_run():
    gap = {"requirement_code": "ENTITY_RECONCILIATION", "description": "No registry verification.",
           "requested_evidence": "Registry extract"}
    connection = _Connection(gap)
    profile = Scope._with_gap_claim(connection, RUN, operation(), {})
    assert connection.params == {"run_id": RUN["analysis_run_id"], "code": "ENTITY_RECONCILIATION",
                                 "claim": "No registry verification."}
    assert profile["claims"] == [{"claim_id": "gap:ENTITY_RECONCILIATION", "claim": "No registry verification.",
                                  "requested_evidence": "Registry extract", "follow_up_proposal": None}]
    assert profile["applicant_match"]["registration_numbers"] == ["15846271"]

    assert Scope._with_gap_claim(_Connection(None), RUN, operation(), {}) == {}
    declared = {"claims": [{"claim_id": "LIC-1"}]}
    assert Scope._with_gap_claim(_Connection(gap), RUN, operation(claim_id="LIC-1"), declared) is declared


def test_registry_verification_claim_is_admitted_only_in_the_wording_derived_from_the_run():
    run = {**RUN, "legal_name": "Morgan Stanley", "jurisdiction": "US-DE"}
    claim = "Morgan Stanley is registered in US-DE under registration number 15846271."
    gap = {"requirement_code": "VERIFY-REGISTERED-IDENTITY", "description": "Only applicant-supplied documents.",
           "requested_evidence": "A record from GLEIF confirming the legal name, registration number, and jurisdiction."}
    connection = _Connection(gap)
    profile = Scope._with_gap_claim(connection, run, operation("verify:registered_identity", claim), {})
    # The run's open verification gap is required; its wording is not the claim.
    assert connection.params == {"run_id": RUN["analysis_run_id"], "code": "VERIFY-REGISTERED-IDENTITY", "claim": None}
    assert profile["claims"] == [{"claim_id": "verify:registered_identity", "claim": claim,
                                  "requested_evidence": gap["requested_evidence"], "follow_up_proposal": None}]
    # Any other wording, or no open gap, is not admitted.
    altered = operation("verify:registered_identity", "Morgan Stanley & Co. LLC is registered in US-DE.")
    assert Scope._with_gap_claim(_Connection(gap), run, altered, {}) == {}
    assert Scope._with_gap_claim(_Connection(None), run, operation("verify:registered_identity", claim), {}) == {}


def test_durable_search_correlates_to_the_exact_approved_scope():
    import hashlib
    import json

    scope = {"query": "Northbridge 15846271", "allowed_domains": ["gov.uk"],
             "disclosed_applicant_fields": ["legal_name"], "result_limit": 5, "claim_id": "gap:X",
             "claim": "c", "evidence_gap_id": "g", "rationale": "r"}
    digest = hashlib.sha256(json.dumps(scope, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    operation = {"durable_approved_scope": scope, "scope_hash": digest, "query": scope["query"],
                 "allowed_domains": ["gov.uk"], "external_disclosure": ["legal_name"], "max_results": 5}
    assert Scope._durable_scope_matches(operation)
    assert not Scope._durable_scope_matches({**operation, "max_results": 10})
    assert not Scope._durable_scope_matches({**operation, "scope_hash": "0" * 64})
    assert not Scope._durable_scope_matches({**operation, "durable_approved_scope": None})
