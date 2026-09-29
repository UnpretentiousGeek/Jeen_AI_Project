from __future__ import annotations

import hashlib
import hmac
import json
import re
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlparse
from uuid import UUID

from sqlalchemy import create_engine, text

from lfx.custom.custom_component.component import Component
from lfx.io import HandleInput, Output, SecretStrInput
from lfx.schema.data import Data
from lfx.schema.message import Message
from lfx.services.deps import session_scope

CONTEXT_VERSION = "public-research-extraction-v1"
STANCES = {"support", "contradict", "not_addressed"}
FACT_FIELDS = ("legal_name", "jurisdiction", "address", "official_domain")
LIST_FIELDS = ("identifiers", "other_identifiers")


class KybPublicResearchContributionValidator(Component):
    display_name = "Validate Public Research Contribution"
    description = "Checks model extractions against accepted page text, builds the claim assessment, and rejects cross-run scope, altered plans, unaccepted results, and fabricated citations."
    icon = "shield-check"
    name = "KybPublicResearchContributionValidator"

    inputs = [
        HandleInput(
            name="artifact",
            display_name="Public Research Extractions",
            input_types=["Data", "JSON", "Message"],
            required=True,
        ),
        HandleInput(
            name="research_context",
            display_name="Signed Research Context",
            input_types=["Data", "JSON", "Message"],
            required=True,
        ),
        SecretStrInput(
            name="database_url",
            display_name="Database URL",
            info="Private PostgreSQL connection used to independently verify case/run ownership, result review, and exact citations.",
            required=True,
            advanced=False,
        ),
    ]
    outputs = [Output(display_name="Validated Public Research Contribution", name="validated", method="validate")]

    @staticmethod
    def _payload(value: Any) -> dict:
        if isinstance(value, Data):
            value = value.data
        elif isinstance(value, Message):
            value = value.text
        if isinstance(value, str):
            value = value.strip()
            if value.startswith("```"):
                value = value.split("\n", 1)[1].rsplit("```", 1)[0].strip()
            value = json.loads(value)
        if isinstance(value, dict) and "extractions_json" in value:
            value = value["extractions_json"]
            value = json.loads(value) if isinstance(value, str) else value
        if not isinstance(value, dict):
            raise ValueError("Public Research input must be one JSON object")
        return value

    @staticmethod
    def _canonical(value):
        if isinstance(value, dict):
            return {key: KybPublicResearchContributionValidator._canonical(item) for key, item in value.items()}
        if isinstance(value, list):
            return [KybPublicResearchContributionValidator._canonical(item) for item in value]
        if isinstance(value, float) and value.is_integer():
            return int(value)
        return value

    async def _database_url(self) -> str:
        value = self.database_url
        if hasattr(value, "get_secret_value"):
            value = value.get_secret_value()
        database_url = str(value or "").strip()
        schemes = ("postgresql://", "postgresql+psycopg://", "postgresql+psycopg2://")
        if not database_url.startswith(schemes):
            async with session_scope() as session:
                database_url = await self.get_variable("DATABASE_URL", "value", session)
            if hasattr(database_url, "get_secret_value"):
                database_url = database_url.get_secret_value()
            database_url = str(database_url or "").strip()
        if not database_url.startswith(schemes):
            raise ValueError("Global DATABASE_URL is not a valid PostgreSQL SQLAlchemy URL")
        return database_url

    @staticmethod
    def _items(value) -> list[str]:
        if isinstance(value, list):
            return [str(item).strip() for item in value if str(item).strip()]
        return [item.strip() for item in str(value or "").split(";") if item.strip()]

    @staticmethod
    def _normal(value: str) -> str:
        return " ".join(re.sub(r"[^A-Z0-9]+", " ", str(value or "").upper()).split())

    @staticmethod
    def _domain(value: str) -> str:
        parsed = urlparse(value if "://" in value else f"https://{value}")
        return (parsed.hostname or "").lower().rstrip(".")

    @classmethod
    def _entity_match(cls, marker: dict, applicant: dict) -> dict:
        applicant_ids = {cls._normal(item) for item in cls._items(applicant.get("registration_numbers"))}
        source_ids = {cls._normal(item) for item in cls._items(marker.get("identifiers"))}
        matching_ids = sorted(applicant_ids & source_ids)
        applicant_domains = {cls._domain(item) for item in cls._items(applicant.get("official_domains"))}
        source_domain = cls._domain(marker.get("official_domain", ""))
        jurisdiction_match = cls._normal(marker.get("jurisdiction", "")) == cls._normal(applicant.get("jurisdiction", ""))
        applicant_addresses = {cls._normal(item) for item in cls._items(applicant.get("addresses"))}
        address_match = cls._normal(marker.get("address", "")) in applicant_addresses and bool(cls._normal(marker.get("address", "")))
        applicant_other = {cls._normal(item) for item in cls._items(applicant.get("other_evidence"))}
        source_other = {cls._normal(item) for item in cls._items(marker.get("other_evidence"))}
        other_matches = sorted(applicant_other & source_other)
        legal_name_match = cls._normal(marker.get("legal_name", "")) == cls._normal(applicant.get("legal_name", ""))
        signals = []
        if matching_ids:
            signals.append("registration_identifier")
        if source_domain and source_domain in applicant_domains:
            signals.append("official_domain")
        if jurisdiction_match:
            signals.append("jurisdiction")
        if address_match:
            signals.append("address")
        if other_matches:
            signals.append("other_supplied_evidence")
        if legal_name_match:
            signals.append("legal_name")
        matched = bool(matching_ids or (source_domain and source_domain in applicant_domains) or other_matches or (jurisdiction_match and address_match))
        if matching_ids:
            confidence = 0.98
        elif source_domain and source_domain in applicant_domains:
            confidence = 0.95
        elif other_matches:
            confidence = 0.9
        elif jurisdiction_match and address_match:
            confidence = 0.86
        else:
            confidence = 0.2 if legal_name_match else 0.05
        return {
            "match_status": "matched" if matched else "rejected",
            "signals": signals,
            "matching_identifiers": matching_ids,
            "matching_other_evidence": other_matches,
            "confidence": confidence,
            "reason": (
                "The source is linked by corroborating applicant identifiers or supplied evidence."
                if matched else
                "The source lacks a corroborating identifier, official domain, address-plus-jurisdiction pair, or other supplied evidence; a name match alone is insufficient."
            ),
        }

    @classmethod
    def _on_page(cls, value: str, excerpt: str) -> bool:
        needle = cls._normal(value)
        return bool(needle) and f" {needle} " in f" {cls._normal(excerpt)} "

    @staticmethod
    def _quote_on_page(quote: str, excerpt: str) -> bool:
        quote = " ".join(str(quote or "").split()).casefold()
        return 12 <= len(quote) <= 500 and quote in " ".join(str(excerpt or "").split()).casefold()

    def _verified_context(self, database_url: str) -> dict:
        signed = self._payload(self.research_context)
        context = signed.get("context")
        if not isinstance(context, dict) or context.get("context_version") != CONTEXT_VERSION:
            raise ValueError("Signed Public Research context is missing or unsupported")
        canonical = json.dumps(self._canonical(context), sort_keys=True, separators=(",", ":"), default=str).encode()
        expected = hmac.new(database_url.encode(), canonical, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(str(signed.get("context_proof") or ""), expected):
            raise ValueError("Public Research context was altered after scoping")
        return context

    def _verified_extractions(self, context: dict) -> tuple[dict, list[str]]:
        items = self._payload(self.artifact).get("extractions")
        if not isinstance(items, list):
            raise ValueError("extractions_json must contain an extractions list")
        pages = {page["immutable_result_id"]: page for page in context["results"]}
        claim_id = context["claim"]["claim_id"]
        verified, notes = {}, []
        for item in items:
            result_id = str(item.get("result_id") or "") if isinstance(item, dict) else ""
            if result_id not in pages or result_id in verified:
                raise ValueError("Extraction references an unknown or duplicate result_id")
            excerpt = pages[result_id]["excerpt"]
            # Keep only facts the accepted excerpt actually states; anything else is treated as not extracted.
            facts = {}
            for field in FACT_FIELDS:
                value = str(item.get(field) or "").strip()
                facts[field] = value if self._on_page(value, excerpt) else ""
            for field in LIST_FIELDS:
                values = item.get(field) or []
                if not isinstance(values, list):
                    raise ValueError(f"{field} must be a list")
                facts[field] = [str(value).strip() for value in values if self._on_page(str(value), excerpt)]
            claims = item.get("claims") or {}
            if not isinstance(claims, dict) or set(claims) - {claim_id}:
                raise ValueError("Extraction assesses a claim outside the approved scope")
            entry = claims.get(claim_id) or {"stance": "not_addressed", "quote": ""}
            stance = entry.get("stance") if isinstance(entry, dict) else None
            if stance not in STANCES:
                raise ValueError("Claim stance must be support, contradict, or not_addressed")
            quote = str(entry.get("quote") or "")
            if stance != "not_addressed" and not self._quote_on_page(quote, excerpt):
                notes.append(
                    f"Result {result_id}: the {stance} stance was ignored because its quote is not in the accepted excerpt."
                )
                stance, quote = "not_addressed", ""
            verified[result_id] = {**facts, "stance": stance, "quote": quote}
        if set(verified) != set(pages):
            raise ValueError("Every accepted in-scope result needs exactly one extraction")
        return verified, notes

    def _assemble(self, context: dict, verified: dict, notes: list[str]) -> dict:
        claim = context["claim"]
        included, entity_matches = [], []
        excluded = list(context["excluded_results"])
        for page in context["results"]:
            result_id = page["immutable_result_id"]
            facts = verified[result_id]
            has_facts = any(facts[field] for field in FACT_FIELDS + LIST_FIELDS)
            marker = {
                "legal_name": facts["legal_name"],
                "identifiers": facts["identifiers"],
                "jurisdiction": facts["jurisdiction"],
                "address": facts["address"],
                "official_domain": facts["official_domain"],
                "other_evidence": facts["other_identifiers"],
            }
            match = self._entity_match(marker, context["applicant"]) if has_facts else {
                "match_status": "rejected", "signals": [], "matching_identifiers": [],
                "matching_other_evidence": [], "confidence": 0.0,
                "reason": "The accepted result contains no normalized applicant-matching facts.",
            }
            entity_matches.append({"immutable_result_id": result_id, **match})
            reason = None if has_facts else "missing_normalized_public_evidence_facts"
            if reason is None and match["match_status"] != "matched":
                reason = "no_reliable_applicant_match"
            if reason:
                excluded.append({
                    "immutable_result_id": result_id,
                    "url": page["canonical_url"],
                    "acceptance_state": "accepted",
                    "reason": reason,
                })
                continue
            citation = {**page, "matching_identifiers": match["matching_identifiers"], "match_evidence": match["signals"]}
            included.append({"stance": facts["stance"], "match": match, "citation": citation})

        support = [item for item in included if item["stance"] == "support"]
        contradict = [item for item in included if item["stance"] == "contradict"]
        limited = [item for item in included if item not in support and item not in contradict]
        if support and contradict:
            outcome = "conflicting"
        elif support:
            outcome = "supported"
        elif contradict:
            outcome = "contradicted"
        else:
            outcome = "evidence_gap"
        support_ids = [item["citation"]["id"] for item in support]
        contradict_ids = [item["citation"]["id"] for item in contradict]
        limitation_ids = [item["citation"]["id"] for item in limited]
        confidence_values = [item["match"]["confidence"] for item in support + contradict]
        confidence = round(min(confidence_values), 2) if confidence_values else 0.0
        limitations = []
        if limited:
            limitations.append(f"{len(limited)} matched accepted result(s) do not address {claim['claim_id']}.")
        if excluded:
            limitations.append(f"{len(excluded)} stored result(s) were excluded before claim assessment.")
        if not support and not contradict:
            limitations.append("No matched, accepted, in-scope result supports or contradicts the investigated claim.")
        limitations.extend(notes)

        conflict_rows = []
        if outcome == "conflicting":
            conflict_rows.append({
                "claim_id": claim["claim_id"],
                "description": "Accepted, applicant-matched sources explicitly disagree on the investigated claim.",
                "supporting_citation_ids": support_ids,
                "contradicting_citation_ids": contradict_ids,
            })
        gap_rows, followups = [], []
        if outcome == "evidence_gap":
            gap_rows.append({
                "claim_id": claim["claim_id"],
                "claim": claim["claim"],
                "description": "Accepted in-scope results are insufficient to assess this claim.",
                "requested_evidence": claim.get("requested_evidence") or "An authoritative source that directly addresses the claim.",
            })
            followup = claim.get("follow_up_proposal")
            if followup:
                followups.append({
                    **followup,
                    "proposal_kind": "search_execution_approval",
                    "requires_fresh_approval": True,
                    "requires_separate_web_result_review": True,
                })
        contribution = dict(context["base"])
        contribution.update({
            "status": "partial" if outcome in {"evidence_gap", "conflicting"} else "completed",
            "documented_gap": None,
            "research_proposal": None,
            "approved_plan": context["approved_plan"],
            "entity_matches": entity_matches,
            "claim_assessments": [{
                "claim_id": claim["claim_id"],
                "claim": claim["claim"],
                "outcome": outcome,
                "supporting_citation_ids": support_ids,
                "contradicting_citation_ids": contradict_ids,
                "limitation_citation_ids": limitation_ids,
                "limitations": limitations,
                "confidence": confidence,
            }],
            "conflicts": conflict_rows,
            "evidence_gaps": gap_rows,
            "excluded_results": excluded,
            "citations": [item["citation"] for item in included],
            "limitations": limitations,
            "follow_up_proposals": followups,
        })
        return contribution

    async def validate(self) -> Data:
        database_url = await self._database_url()
        context = self._verified_context(database_url)
        if context["operation_mode"] == "propose_research":
            artifact = dict(context["contribution"])
        else:
            artifact = self._assemble(context, *self._verified_extractions(context))
        canonical = json.dumps(self._canonical(artifact), sort_keys=True, separators=(",", ":"), default=str).encode()
        artifact["scope_proof"] = hmac.new(database_url.encode(), canonical, hashlib.sha256).hexdigest()
        required = {
            "contract_version", "contribution_kind", "contribution_id", "case_id",
            "analysis_run_id", "task_id", "context_id", "specialist", "specialty",
            "operation_mode", "status", "source_scope", "documented_gap",
            "research_proposal", "approved_plan", "entity_matches", "claim_assessments",
            "conflicts", "evidence_gaps", "excluded_results", "citations", "limitations",
            "follow_up_proposals", "error", "scope_proof",
        }
        missing = sorted(required - set(artifact))
        if missing:
            raise ValueError(f"Public Research contribution is missing fields: {', '.join(missing)}")
        if artifact["contract_version"] != "3.3.0" or artifact["contribution_kind"] != "public_research_specialist_contribution":
            raise ValueError("Unsupported Public Research Specialist Contribution contract")
        if artifact["specialist"] != {"name": "kyb-public-research-agent", "version": "3.3.0"} or artifact["specialty"] != "public_research":
            raise ValueError("Unexpected Public Research specialist identity")
        if artifact["operation_mode"] not in {"propose_research", "analyze_accepted_results"}:
            raise ValueError("Unsupported Public Research operation mode")
        if artifact["contribution_id"] != f"public-research-{artifact['task_id']}":
            raise ValueError("contribution_id must equal public-research- plus task_id")
        if artifact["error"] is not None:
            raise ValueError("A successful Public Research contribution must have error null")
        if artifact["source_scope"].get("network_access") is not False or artifact["source_scope"].get("search_execution_approval_is_evidence_acceptance") is not False:
            raise ValueError("Public Research specialist must have no network authority and must preserve both approval boundaries")
        run_id = str(artifact["analysis_run_id"])
        case_id = str(artifact["case_id"])
        UUID(run_id)
        UUID(case_id)

        engine = create_engine(database_url)
        try:
            with engine.connect() as connection:
                owner = connection.execute(text("""
                    SELECT run.case_id::text AS case_id
                    FROM analysis_runs run
                    WHERE run.id = CAST(:run_id AS uuid)
                """), {"run_id": run_id}).mappings().one_or_none()
                if owner is None or owner["case_id"] != case_id:
                    raise ValueError("Public Research contribution case_id does not own analysis_run_id")

                if artifact["operation_mode"] == "propose_research":
                    proposal = artifact["research_proposal"]
                    gap = artifact["documented_gap"]
                    if not isinstance(proposal, dict) or not isinstance(gap, dict):
                        raise ValueError("Proposal mode requires one documented gap and one research proposal")
                    if proposal.get("proposal_kind") != "search_execution_approval" or not proposal.get("requires_explicit_search_execution_approval") or not proposal.get("requires_separate_web_result_review"):
                        raise ValueError("Proposal does not preserve Search Execution Approval and Web Result Review")
                    if not proposal.get("query") or not proposal.get("allowed_domains") or not proposal.get("disclosed_applicant_fields"):
                        raise ValueError("Research proposal lacks an exact query, domains, or disclosed applicant fields")
                    if not isinstance(proposal.get("result_limit"), int) or not 1 <= proposal["result_limit"] <= 10:
                        raise ValueError("Research proposal result limit is invalid")
                    stored_gap = connection.execute(text("""
                        SELECT requirement_code, description, requested_evidence
                        FROM evidence_gaps
                        WHERE id = CAST(:gap_id AS uuid) AND analysis_run_id = CAST(:run_id AS uuid)
                    """), {"gap_id": gap.get("evidence_gap_id"), "run_id": run_id}).mappings().one_or_none()
                    if stored_gap is None or dict(stored_gap) != {
                        "requirement_code": gap.get("requirement_code"),
                        "description": gap.get("description"),
                        "requested_evidence": gap.get("requested_evidence"),
                    }:
                        raise ValueError("Research proposal is not tied to the documented evidence gap")
                    if artifact["citations"] or artifact["claim_assessments"] or artifact["approved_plan"] is not None:
                        raise ValueError("Proposal mode must not present web evidence or an approved execution")
                else:
                    approved_plan = artifact["approved_plan"]
                    if not isinstance(approved_plan, dict):
                        raise ValueError("Analysis mode requires approved-plan provenance")
                    execution_id = str(approved_plan.get("search_execution_id", ""))
                    review_id = str(approved_plan.get("result_review_id", ""))
                    UUID(execution_id)
                    UUID(review_id)
                    execution = connection.execute(text("""
                        SELECT execution.analysis_run_id::text AS analysis_run_id,
                               execution.case_id::text AS case_id, execution.query,
                               execution.allowed_domains, execution.max_results,
                               execution.external_disclosure, execution.status,
                               action.status AS action_status, approval.decision,
                               review.id::text AS review_id, review.status AS review_status
                        FROM web_search_executions execution
                        JOIN proposed_actions action ON action.id = execution.proposed_action_id
                        JOIN approvals approval ON approval.id = execution.approval_id
                        JOIN web_result_reviews review ON review.search_execution_id = execution.id
                        WHERE execution.id = CAST(:execution_id AS uuid)
                    """), {"execution_id": execution_id}).mappings().one_or_none()
                    if execution is None or execution["analysis_run_id"] != run_id or execution["case_id"] != case_id:
                        raise ValueError("Approved execution is outside the contribution case or analysis run")
                    if execution["decision"] != "approved" or execution["status"] != "succeeded" or execution["action_status"] != "executed":
                        raise ValueError("Analysis does not correlate to an approved completed search execution")
                    if execution["review_id"] != review_id:
                        raise ValueError("Analysis does not correlate to the recorded Web Result Review")
                    exact_plan = {
                        "query": execution["query"],
                        "allowed_domains": list(execution["allowed_domains"] or []),
                        "disclosed_applicant_fields": list(execution["external_disclosure"] or []),
                        "result_limit": execution["max_results"],
                    }
                    if any(approved_plan.get(key) != value for key, value in exact_plan.items()):
                        raise ValueError("Contribution approved plan alters the query, domain, disclosure, or result-limit scope")

                    accepted = {}
                    for row in connection.execute(text("""
                        SELECT evidence.id::text AS result_id, evidence.url,
                               evidence.canonical_url, evidence.title, evidence.publisher,
                               evidence.published_at, evidence.retrieved_at, evidence.excerpt,
                               evidence.content_hash, evidence.retrieval_method,
                               item.review_state, item.content_hash AS review_content_hash
                        FROM external_web_evidence evidence
                        JOIN web_result_review_items item
                          ON item.external_web_evidence_id = evidence.id
                         AND item.search_execution_id = evidence.search_execution_id
                         AND item.analysis_run_id = evidence.analysis_run_id
                         AND item.case_id = evidence.case_id
                        JOIN web_result_reviews review ON review.id = item.review_id
                        WHERE evidence.search_execution_id = CAST(:execution_id AS uuid)
                          AND review.status = 'decided'
                          AND item.review_state = 'accepted'
                          AND item.content_hash = evidence.content_hash
                    """), {"execution_id": execution_id}).mappings():
                        item = dict(row)
                        accepted[item["result_id"]] = item

                    supplied = {}
                    for citation in artifact["citations"]:
                        result_id = str(citation.get("immutable_result_id", ""))
                        if result_id in supplied:
                            raise ValueError("Public-web citation result IDs must be unique")
                        row = accepted.get(result_id)
                        if row is None:
                            raise ValueError("Citation references a pending, rejected, unapproved, altered, cross-run, or unknown result")
                        expected = {
                            "id": f"web-{result_id}",
                            "source_kind": "external_web",
                            "immutable_result_id": result_id,
                            "url": row["url"],
                            "canonical_url": row["canonical_url"],
                            "title": row["title"],
                            "publisher": row["publisher"],
                            "source_date": row["published_at"].isoformat().replace("+00:00", "Z") if row["published_at"] else None,
                            "retrieved_at": row["retrieved_at"].isoformat().replace("+00:00", "Z"),
                            "excerpt": row["excerpt"],
                            "content_hash": row["content_hash"],
                            "retrieval_method": row["retrieval_method"],
                            "search_execution_id": execution_id,
                            "result_review_id": review_id,
                            "review_state": "accepted",
                            "matching_identifiers": citation.get("matching_identifiers"),
                            "match_evidence": citation.get("match_evidence"),
                        }
                        if citation != expected:
                            raise ValueError("Citation URL, immutable result ID, excerpt, dates, hash, acceptance state, or plan correlation is fabricated or altered")
                        supplied[result_id] = citation
                    referenced = set()
                    for claim in artifact["claim_assessments"]:
                        referenced.update(claim.get("supporting_citation_ids") or [])
                        referenced.update(claim.get("contradicting_citation_ids") or [])
                        referenced.update(claim.get("limitation_citation_ids") or [])
                    for conflict in artifact["conflicts"]:
                        referenced.update(conflict.get("supporting_citation_ids") or [])
                        referenced.update(conflict.get("contradicting_citation_ids") or [])
                    if referenced != {citation["id"] for citation in artifact["citations"]}:
                        raise ValueError("Citation list must equal all and only claim-specific referenced citations")
                    for proposal in artifact["follow_up_proposals"]:
                        if not proposal.get("requires_fresh_approval") or not proposal.get("requires_separate_web_result_review"):
                            raise ValueError("A follow-up may only be a fresh bounded proposal with both approval boundaries")

        finally:
            engine.dispose()

        artifact["deterministic_validation"] = {
            "validator": "public-research-contribution-v3.3.0",
            "outcome": "accepted",
            "checks": [
                "operation_mode", "case_run_relationship", "task_context_identity",
                "documented_gap", "exact_query_domain_disclosure_limit_claim",
                "search_execution_approval_boundary", "web_result_review_boundary",
                "approved_plan_correlation", "immutable_result_ids", "acceptance_state",
                "citation_urls", "citation_excerpts", "citation_source_dates",
                "citation_hashes", "entity_match", "claim_specificity",
                "conflict_visibility", "bounded_follow_up",
            ],
            "validated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        }
        self.status = f"Accepted {artifact['operation_mode']} with {len(artifact['citations'])} exact accepted-result citation(s)"
        return Data(data=artifact)
