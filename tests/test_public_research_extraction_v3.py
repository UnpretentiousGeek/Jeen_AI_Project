from __future__ import annotations

import hashlib
import hmac
import importlib.util
import json
import sys
from pathlib import Path

import pytest

from lfx.schema.data import Data


MODULE_PATH = Path(__file__).resolve().parents[1] / "langflow/components/public_research_validator_v3.py"
SPEC = importlib.util.spec_from_file_location("public_research_validator_v3_extraction", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)
Validator = MODULE.KybPublicResearchContributionValidator

DATABASE_URL = "postgresql://test"
SUPPORT_TEXT = "Licence register. Example 44 Ltd (company number GB-PR-0044) holds money transmitter license MT-44, status active."
REVOKED_TEXT = "Notice. Example 44 Ltd (company number GB-PR-0044): money transmitter license MT-44 was revoked on 1 September 2026."
NAME_ONLY_TEXT = "Example 44 Ltd, 999 Other Street New York, holds money transmitter license MT-44."


def page(result_id: str, excerpt: str) -> dict:
    return {
        "id": f"web-{result_id}",
        "source_kind": "external_web",
        "immutable_result_id": result_id,
        "url": f"https://regulator.example.gov/{result_id}",
        "canonical_url": f"https://regulator.example.gov/{result_id}",
        "title": "Register entry",
        "publisher": "Example Regulator",
        "source_date": None,
        "retrieved_at": "2026-09-01T00:00:00Z",
        "excerpt": excerpt,
        "content_hash": "sha256:test",
        "retrieval_method": "tinyfish_fetch",
        "search_execution_id": "exec",
        "result_review_id": "review",
        "review_state": "accepted",
    }


def context(*pages: dict) -> dict:
    return {
        "context_version": MODULE.CONTEXT_VERSION,
        "operation_mode": "analyze_accepted_results",
        "base": {"contract_version": "3.3.0", "operation_mode": "analyze_accepted_results"},
        "approved_plan": {"query": "q", "claim_id": "licensing"},
        "claim": {
            "claim_id": "licensing",
            "claim": "Example 44 Ltd holds money transmitter license MT-44.",
            "requested_evidence": None,
            "follow_up_proposal": None,
        },
        "applicant": {
            "legal_name": "Example 44 Ltd",
            "jurisdiction": "GB",
            "registration_numbers": ["GB-PR-0044"],
        },
        "results": list(pages),
        "excluded_results": [],
    }


def signed(value: dict) -> Data:
    canonical = json.dumps(Validator._canonical(value), sort_keys=True, separators=(",", ":"), default=str).encode()
    return Data(data={"context": value, "context_proof": hmac.new(DATABASE_URL.encode(), canonical, hashlib.sha256).hexdigest()})


def extraction(result_id: str, stance: str = "not_addressed", quote: str = "", **facts) -> dict:
    return {
        "result_id": result_id,
        "legal_name": facts.get("legal_name", ""),
        "identifiers": facts.get("identifiers", []),
        "other_identifiers": facts.get("other_identifiers", []),
        "jurisdiction": facts.get("jurisdiction", ""),
        "address": facts.get("address", ""),
        "official_domain": facts.get("official_domain", ""),
        "claims": {"licensing": {"stance": stance, "quote": quote}},
    }


def assess(ctx: dict, *items: dict) -> dict:
    validator = Validator()
    validator.research_context = signed(ctx)
    validator.artifact = Data(data={"extractions_json": json.dumps({"extractions": list(items)})})
    verified_context = validator._verified_context(DATABASE_URL)
    return validator._assemble(verified_context, *validator._verified_extractions(verified_context))


def test_matched_supporting_page_is_supported() -> None:
    result = assess(
        context(page("r1", SUPPORT_TEXT)),
        extraction("r1", "support", "holds money transmitter license MT-44", identifiers=["GB-PR-0044"]),
    )
    assessment = result["claim_assessments"][0]
    assert assessment["outcome"] == "supported"
    assert assessment["supporting_citation_ids"] == ["web-r1"]
    assert result["citations"][0]["matching_identifiers"] == ["GB PR 0044"]


def test_supporting_and_contradicting_pages_conflict() -> None:
    result = assess(
        context(page("r1", SUPPORT_TEXT), page("r2", REVOKED_TEXT)),
        extraction("r1", "support", "holds money transmitter license MT-44", identifiers=["GB-PR-0044"]),
        extraction("r2", "contradict", "license MT-44 was revoked", identifiers=["GB-PR-0044"]),
    )
    assert result["claim_assessments"][0]["outcome"] == "conflicting"
    assert len(result["conflicts"]) == 1


def test_name_only_match_is_excluded() -> None:
    result = assess(
        context(page("r1", NAME_ONLY_TEXT)),
        extraction("r1", "support", "holds money transmitter license MT-44", legal_name="Example 44 Ltd"),
    )
    assert result["excluded_results"][0]["reason"] == "no_reliable_applicant_match"
    assert result["claim_assessments"][0]["outcome"] == "evidence_gap"


def test_identifier_not_on_page_is_dropped() -> None:
    result = assess(
        context(page("r1", NAME_ONLY_TEXT)),
        extraction("r1", "support", "holds money transmitter license MT-44", identifiers=["GB-PR-0044"], legal_name="Example 44 Ltd"),
    )
    assert result["entity_matches"][0]["matching_identifiers"] == []
    assert result["excluded_results"][0]["reason"] == "no_reliable_applicant_match"


def test_quote_not_on_page_downgrades_stance() -> None:
    result = assess(
        context(page("r1", SUPPORT_TEXT)),
        extraction("r1", "support", "the licence was renewed for five years", identifiers=["GB-PR-0044"]),
    )
    assessment = result["claim_assessments"][0]
    assert assessment["outcome"] == "evidence_gap"
    assert assessment["limitation_citation_ids"] == ["web-r1"]
    assert any("quote is not in the accepted excerpt" in item for item in result["limitations"])


def test_page_without_extracted_facts_is_excluded() -> None:
    result = assess(context(page("r1", SUPPORT_TEXT)), extraction("r1"))
    assert result["excluded_results"][0]["reason"] == "missing_normalized_public_evidence_facts"


@pytest.mark.parametrize(
    "items",
    [
        [extraction("unknown")],
        [extraction("r1"), extraction("r1")],
        [],
        [{**extraction("r1"), "claims": {"registration": {"stance": "support", "quote": ""}}}],
        [extraction("r1", "maybe")],
    ],
)
def test_malformed_extractions_are_rejected(items: list[dict]) -> None:
    with pytest.raises(ValueError):
        assess(context(page("r1", SUPPORT_TEXT)), *items)


def test_context_changed_after_signing_is_rejected() -> None:
    ctx = context(page("r1", SUPPORT_TEXT))
    signed_context = signed(ctx)
    signed_context.data["context"]["results"][0]["excerpt"] += " ALTERED"
    validator = Validator()
    validator.research_context = signed_context
    with pytest.raises(ValueError, match="altered after scoping"):
        validator._verified_context(DATABASE_URL)
