from __future__ import annotations

import hashlib
import hmac
import json
import re
from datetime import datetime
from urllib.parse import urlparse
from uuid import UUID

from sqlalchemy import create_engine, text

from lfx.custom.custom_component.component import Component
from lfx.io import MessageTextInput, Output, SecretStrInput
from lfx.schema.data import Data
from lfx.schema.message import Message
from lfx.services.deps import session_scope

CONTEXT_VERSION = "public-research-extraction-v1"


# Must match the coordinator's registered-identity verification requirement.
VERIFICATION_CLAIM_ID = "verify:registered_identity"
VERIFICATION_GAP_CODE = "VERIFY-REGISTERED-IDENTITY"

class KybPublicResearchScope(Component):
    display_name = "Scope Public Research Operation"
    description = "Validates task scope and prepares either one bounded research proposal or a signed extraction task for separately accepted immutable results."
    icon = "search-check"
    name = "KybPublicResearchScope"

    inputs = [
        MessageTextInput(
            name="input_value",
            display_name="Public Research Task",
            info="JSON with operation_mode, analysis_run_id, task_id, context_id, case_id, and the mode-specific reference.",
            required=True,
        ),
        SecretStrInput(
            name="database_url",
            display_name="Database URL",
            info="Private PostgreSQL connection used for gap, approval, immutable result, and review-state validation.",
            required=True,
            advanced=False,
        ),
    ]
    outputs = [
        # group_outputs shows both handles at once; both must be connected (Agent and Validator).
        Output(display_name="Extraction Request", name="extraction_request", method="extraction_request", group_outputs=True),
        Output(display_name="Signed Research Context", name="research_context", method="research_context", group_outputs=True),
    ]

    @staticmethod
    def _domain(value: str) -> str:
        parsed = urlparse(value if "://" in value else f"https://{value}")
        return (parsed.hostname or "").lower().rstrip(".")

    @staticmethod
    def _domain_allowed(host: str, allowed: list[str]) -> bool:
        return any(host == domain or host.endswith("." + domain) for domain in allowed)

    @staticmethod
    def _valid_task_identity(value: str, label: str) -> str:
        value = str(value or "").strip()
        if not re.fullmatch(r"[A-Za-z0-9._:-]{1,160}", value):
            raise ValueError(f"{label} is required and must be a bounded protocol identifier")
        return value

    @staticmethod
    def _canonical(value):
        if isinstance(value, dict):
            return {key: KybPublicResearchScope._canonical(item) for key, item in value.items()}
        if isinstance(value, list):
            return [KybPublicResearchScope._canonical(item) for item in value]
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
    def _base(run: dict, task_id: str, context_id: str, mode: str) -> dict:
        return {
            "contract_version": "3.3.0",
            "contribution_kind": "public_research_specialist_contribution",
            "contribution_id": f"public-research-{task_id}",
            "case_id": run["case_id"],
            "analysis_run_id": run["analysis_run_id"],
            "task_id": task_id,
            "context_id": context_id,
            "specialist": {"name": "kyb-public-research-agent", "version": "3.3.0"},
            "specialty": "public_research",
            "operation_mode": mode,
            "source_scope": {
                "network_access": False,
                "search_execution_approval_is_evidence_acceptance": False,
                "analysis_source": "immutable_analyst_reviewed_web_results" if mode == "analyze_accepted_results" else "documented_evidence_gap",
            },
            "error": None,
            # The durable coordinator's contribution gate correlates these with its dispatch.
            **run.get("correlation", {}),
        }

    @classmethod
    def _proposal(cls, run: dict, task_id: str, context_id: str, gap: dict, profile: dict) -> dict:
        claims = profile.get("claims") or []
        claim = next((item for item in claims if item.get("requirement_code") == gap["requirement_code"]), None)
        if not isinstance(claim, dict):
            raise ValueError("Documented evidence gap has no bounded public-research profile")
        required = ["claim_id", "claim", "query", "allowed_domains", "disclosed_applicant_fields", "result_limit", "rationale"]
        if any(not claim.get(field) for field in required):
            raise ValueError("Bounded research profile is incomplete")
        domains = [cls._domain(item) for item in claim["allowed_domains"]]
        disclosure = list(claim["disclosed_applicant_fields"])
        allowed_disclosure = {"legal_name", "claimed_license_type", "jurisdiction", "product", "registration_number", "official_domain"}
        if not domains or any(not item for item in domains) or len(domains) > 8:
            raise ValueError("Research proposal requires 1-8 valid allowed domains")
        if not disclosure or not set(disclosure).issubset(allowed_disclosure):
            raise ValueError("Research proposal disclosure is empty or outside the public-data allowlist")
        limit = int(claim["result_limit"])
        if limit < 1 or limit > 10:
            raise ValueError("Research proposal result limit must be between 1 and 10")
        contribution = cls._base(run, task_id, context_id, "propose_research")
        contribution.update({
            "status": "proposal_ready",
            "documented_gap": gap,
            "research_proposal": {
                "proposal_kind": "search_execution_approval",
                "evidence_gap_id": gap["evidence_gap_id"],
                "claim_id": claim["claim_id"],
                "claim": claim["claim"],
                "query": claim["query"],
                "allowed_domains": domains,
                "disclosed_applicant_fields": disclosure,
                "result_limit": limit,
                "rationale": claim["rationale"],
                "requires_explicit_search_execution_approval": True,
                "requires_separate_web_result_review": True,
            },
            "approved_plan": None,
            "entity_matches": [],
            "claim_assessments": [],
            "conflicts": [],
            "evidence_gaps": [gap],
            "excluded_results": [],
            "citations": [],
            "limitations": ["No search was executed and no web result was accepted as evidence by this operation."],
            "follow_up_proposals": [],
        })
        return contribution

    @staticmethod
    def _durable_scope_matches(operation: dict) -> bool:
        """Correlate a durable-coordinator search to the exact scope the analyst approved."""
        scope = operation.get("durable_approved_scope")
        if not isinstance(scope, dict):
            return False
        digest = hashlib.sha256(
            json.dumps(scope, sort_keys=True, separators=(",", ":"), default=str).encode()
        ).hexdigest()
        return (
            digest == operation["scope_hash"]
            and scope.get("query") == operation["query"]
            and scope.get("allowed_domains") == list(operation["allowed_domains"] or [])
            and scope.get("disclosed_applicant_fields") == list(operation["external_disclosure"] or [])
            and scope.get("result_limit") == operation["max_results"]
        )

    @staticmethod
    def _verification_claim(run: dict) -> str:
        """The registered-identity claim exactly as the coordinator drafts it from this run's applicant."""
        declaration = (run["submitted_payload"] or {}).get("entity_declaration") or {}
        legal_name = str(declaration.get("legal_name") or run["legal_name"] or "").strip()
        jurisdiction = str(declaration.get("jurisdiction") or run["jurisdiction"] or "").strip()
        number = next((str(item.get("value")).strip() for item in declaration.get("identifiers") or []
                       if isinstance(item, dict) and item.get("value")), "")
        return f"{legal_name} is registered in {jurisdiction}" + (f" under registration number {number}." if number else ".")

    @classmethod
    def _with_gap_claim(cls, connection, run: dict, operation: dict, profile: dict) -> dict:
        """Admit a claim drafted by the coordinator for one of this run's documented evidence gaps.

        Coordinator-drafted research has no pre-declared profile claim. Analyst-requested research
        claims exactly a persisted gap (claim_id "gap:<requirement_code>", claim = gap description).
        The registry verification search claims the applicant's registered identity
        (claim_id "verify:registered_identity"); it is admitted only while the run's verification gap
        is open and only in the exact wording derived from the run's own applicant data.
        """
        claim_id = str(operation["action_payload"].get("claim_id") or "")
        claim = operation["action_payload"].get("claim")
        if any(item.get("claim_id") == claim_id for item in profile.get("claims") or []):
            return profile
        if claim_id == VERIFICATION_CLAIM_ID:
            if claim != cls._verification_claim(run):
                return profile
            code, description = VERIFICATION_GAP_CODE, None
        elif claim_id.startswith("gap:"):
            code, description = claim_id[len("gap:"):], claim
        else:
            return profile
        gap = connection.execute(text("""
            SELECT requirement_code, description, requested_evidence
            FROM evidence_gaps
            WHERE analysis_run_id = CAST(:run_id AS uuid)
              AND requirement_code = :code AND (CAST(:claim AS text) IS NULL OR description = :claim)
            LIMIT 1
        """), {"run_id": run["analysis_run_id"], "code": code, "claim": description}).mappings().one_or_none()
        if gap is None:
            return profile
        declaration = (run["submitted_payload"] or {}).get("entity_declaration") or {}
        addresses = declaration.get("addresses") or {}
        applicant_match = profile.get("applicant_match") or {
            "registration_numbers": [item.get("value") for item in declaration.get("identifiers") or [] if item.get("value")],
            "official_domains": [declaration["website"]] if declaration.get("website") else [],
            "addresses": [value for value in addresses.values() if value] if isinstance(addresses, dict) else [],
        }
        return {
            **profile,
            "applicant_match": applicant_match,
            "claims": [*(profile.get("claims") or []), {
                "claim_id": claim_id,
                "claim": claim if claim_id == VERIFICATION_CLAIM_ID else gap["description"],
                "requested_evidence": gap["requested_evidence"],
                "follow_up_proposal": None,
            }],
        }

    @classmethod
    def _extraction_context(cls, run: dict, task_id: str, context_id: str, operation: dict, evidence_rows: list[dict], profile: dict) -> dict:
        expected_plan = {
            "query": operation["query"],
            "allowed_domains": list(operation["allowed_domains"] or []),
            "disclosed_applicant_fields": list(operation["external_disclosure"] or []),
            "result_limit": operation["max_results"],
            "claim_id": operation["action_payload"].get("claim_id"),
            "claim": operation["action_payload"].get("claim"),
            "rationale": operation["action_payload"].get("reason"),
        }
        if operation["approved_plan"] != expected_plan:
            raise ValueError("Supplied approved_plan differs from the exact approved query, domain, disclosure, result-limit, or claim scope")
        payload = operation["action_payload"]
        if operation["approval_decision"] != "approved" or operation["action_status"] != "executed" or operation["execution_status"] != "succeeded":
            raise ValueError("Search execution is not an approved and completed exact-scope execution")
        if operation["computed_scope_hash"] != operation["scope_hash"] and not cls._durable_scope_matches(operation):
            raise ValueError("Approved search scope hash does not correlate to the stored action and execution")
        if payload.get("query") != operation["query"] or payload.get("allowed_domains") != list(operation["allowed_domains"] or []):
            raise ValueError("Approved action and search execution query/domain scope differ")
        if payload.get("external_disclosure") != list(operation["external_disclosure"] or []) or payload.get("max_results") != operation["max_results"]:
            raise ValueError("Approved action and search execution disclosure/result scope differ")
        if len(evidence_rows) > operation["max_results"]:
            raise ValueError("Stored result batch exceeds the approved result limit")

        claims = profile.get("claims") or []
        claim = next((item for item in claims if item.get("claim_id") == expected_plan["claim_id"]), None)
        if not isinstance(claim, dict) or claim.get("claim") != expected_plan["claim"]:
            raise ValueError("Approved claim is not a documented applicant research claim")
        applicant = profile.get("applicant_match") or {}
        applicant = {**applicant, "legal_name": run["legal_name"], "jurisdiction": run["jurisdiction"]}
        allowed_domains = [cls._domain(item) for item in expected_plan["allowed_domains"]]
        results, excluded = [], []

        for row in evidence_rows:
            result_id = row["result_id"]
            host = cls._domain(row["canonical_url"])
            reason = None
            if operation["review_status"] != "decided":
                reason = "result_review_not_completed"
            elif row.get("review_state") != "accepted":
                reason = f"acceptance_state_{row.get('review_state') or 'unapproved'}"
            elif row.get("review_content_hash") != row["content_hash"]:
                reason = "altered_content_hash"
            elif not cls._domain_allowed(host, allowed_domains):
                reason = "outside_approved_domain"
            if reason:
                excluded.append({
                    "immutable_result_id": result_id,
                    "url": row["canonical_url"],
                    "acceptance_state": row.get("review_state") or "unapproved",
                    "reason": reason,
                })
                continue
            # The validator adds matching_identifiers and match_evidence after checking the model's extraction.
            results.append({
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
                "search_execution_id": operation["search_execution_id"],
                "result_review_id": operation["result_review_id"],
                "review_state": "accepted",
            })

        return {
            "context_version": CONTEXT_VERSION,
            "operation_mode": "analyze_accepted_results",
            "base": cls._base(run, task_id, context_id, "analyze_accepted_results"),
            "approved_plan": {
                **expected_plan,
                "search_execution_id": operation["search_execution_id"],
                "result_review_id": operation["result_review_id"],
            },
            "claim": {
                "claim_id": claim["claim_id"],
                "claim": claim["claim"],
                "requested_evidence": claim.get("requested_evidence"),
                "follow_up_proposal": claim.get("follow_up_proposal"),
            },
            "applicant": applicant,
            "results": results,
            "excluded_results": excluded,
        }

    async def _prepare_once(self) -> dict:
        # Both outputs come from one scoping pass so the model and the validator see the same signed context.
        if getattr(self, "_prepared", None) is not None:
            return self._prepared
        raw = self.input_value.text if isinstance(self.input_value, Message) else self.input_value
        try:
            payload = json.loads(raw)
        except (TypeError, json.JSONDecodeError) as exc:
            raise ValueError("Public Research task must be valid JSON") from exc
        if not isinstance(payload, dict):
            raise ValueError("Public Research task must be a JSON object")
        mode = str(payload.get("operation_mode", "")).strip()
        if mode not in {"propose_research", "analyze_accepted_results"}:
            raise ValueError("operation_mode must be propose_research or analyze_accepted_results")
        run_id = str(payload.get("analysis_run_id", "")).strip()
        supplied_case_id = str(payload.get("case_id", "")).strip()
        UUID(run_id)
        UUID(supplied_case_id)
        task_id = self._valid_task_identity(payload.get("task_id"), "task_id")
        context_id = self._valid_task_identity(payload.get("context_id"), "context_id")
        if task_id == context_id:
            raise ValueError("task_id and context_id must identify distinct protocol scopes")

        database_url = await self._database_url()
        engine = create_engine(database_url)
        try:
            with engine.connect() as connection:
                run_row = connection.execute(text("""
                    SELECT run.id::text AS analysis_run_id, run.case_id::text AS case_id,
                           applicant.legal_name, applicant.jurisdiction,
                           application.submitted_payload
                    FROM analysis_runs run
                    JOIN onboarding_cases c ON c.id = run.case_id
                    JOIN applicants applicant ON applicant.id = c.applicant_id
                    JOIN applications application ON application.id = c.application_id
                    WHERE run.id = CAST(:run_id AS uuid)
                """), {"run_id": run_id}).mappings().one_or_none()
                if run_row is None:
                    raise ValueError("analysis_run_id does not exist")
                run = dict(run_row)
                if supplied_case_id != run["case_id"]:
                    raise ValueError("case_id does not own the supplied analysis_run_id")
                profile = (run["submitted_payload"] or {}).get("public_research") or {}
                run["correlation"] = {
                    key: payload[key] for key in ("coordinator_run_id", "attempt", "parent_task_id") if key in payload
                }

                if mode == "propose_research":
                    gap_id = str(payload.get("evidence_gap_id", "")).strip()
                    UUID(gap_id)
                    gap_row = connection.execute(text("""
                        SELECT id::text AS evidence_gap_id, requirement_code, description, requested_evidence
                        FROM evidence_gaps
                        WHERE id = CAST(:gap_id AS uuid) AND analysis_run_id = CAST(:run_id AS uuid)
                    """), {"gap_id": gap_id, "run_id": run_id}).mappings().one_or_none()
                    if gap_row is None:
                        raise ValueError("evidence_gap_id is not documented in the supplied analysis run")
                    context = {
                        "context_version": CONTEXT_VERSION,
                        "operation_mode": "propose_research",
                        "contribution": self._proposal(run, task_id, context_id, dict(gap_row), profile),
                    }
                else:
                    execution_id = str(payload.get("search_execution_id", "")).strip()
                    UUID(execution_id)
                    approved_plan = payload.get("approved_plan")
                    if not isinstance(approved_plan, dict):
                        raise ValueError("analyze_accepted_results requires the exact approved_plan")
                    operation_row = connection.execute(text("""
                        SELECT execution.id::text AS search_execution_id,
                               execution.analysis_run_id::text AS analysis_run_id,
                               execution.case_id::text AS case_id,
                               execution.query, execution.allowed_domains, execution.max_results,
                               execution.intended_use, execution.external_disclosure,
                               execution.scope_hash, execution.status AS execution_status,
                               action.status AS action_status, action.payload AS action_payload,
                               approval.decision AS approval_decision,
                               review.id::text AS result_review_id, review.status AS review_status,
                               encode(digest(jsonb_build_object(
                                   'action_id', action.id,
                                   'case_id', execution.case_id,
                                   'analysis_run_id', execution.analysis_run_id,
                                   'query', action.payload ->> 'query',
                                   'allowed_domains', action.payload -> 'allowed_domains',
                                   'max_results', action.payload -> 'max_results',
                                   'intended_use', action.payload ->> 'intended_use',
                                   'external_disclosure', action.payload -> 'external_disclosure'
                               )::text, 'sha256'), 'hex') AS computed_scope_hash
                        FROM web_search_executions execution
                        JOIN proposed_actions action ON action.id = execution.proposed_action_id
                        JOIN approvals approval ON approval.id = execution.approval_id
                        LEFT JOIN web_result_reviews review ON review.search_execution_id = execution.id
                        WHERE execution.id = CAST(:execution_id AS uuid)
                    """), {"execution_id": execution_id}).mappings().one_or_none()
                    if operation_row is None:
                        raise ValueError("search_execution_id does not exist")
                    operation = dict(operation_row)
                    if operation["analysis_run_id"] != run_id or operation["case_id"] != run["case_id"]:
                        raise ValueError("search execution is outside the supplied case or analysis run")
                    if operation["result_review_id"] is None:
                        raise ValueError("Search approval exists but no separate Web Result Review exists")
                    operation["approved_plan"] = approved_plan
                    # The durable coordinator stores the hash of the scope the analyst approved.
                    operation["durable_approved_scope"] = connection.execute(text("""
                        SELECT request_payload->'payload'->'approved_scope'
                        FROM coordinator_v3_checkpoints
                        WHERE analysis_run_id = CAST(:run_id AS uuid)
                          AND checkpoint_kind = 'search_execution_approval'
                          AND status = 'approved' AND decision = 'approve'
                          AND request_payload->'payload'->>'scope_hash' = :scope_hash
                        LIMIT 1
                    """), {"run_id": run_id, "scope_hash": operation["scope_hash"]}).scalar_one_or_none()
                    evidence_rows = [dict(row) for row in connection.execute(text("""
                        SELECT evidence.id::text AS result_id, evidence.url, evidence.canonical_url,
                               evidence.title, evidence.publisher, evidence.published_at,
                               evidence.retrieved_at, evidence.excerpt, evidence.content_hash,
                               evidence.retrieval_method, item.content_hash AS review_content_hash,
                               item.review_state
                        FROM external_web_evidence evidence
                        LEFT JOIN web_result_review_items item
                          ON item.external_web_evidence_id = evidence.id
                         AND item.search_execution_id = evidence.search_execution_id
                         AND item.analysis_run_id = evidence.analysis_run_id
                         AND item.case_id = evidence.case_id
                        WHERE evidence.search_execution_id = CAST(:execution_id AS uuid)
                        ORDER BY evidence.id
                    """), {"execution_id": execution_id}).mappings()]
                    profile = self._with_gap_claim(connection, run, operation, profile)
                    context = self._extraction_context(run, task_id, context_id, operation, evidence_rows, profile)
        finally:
            engine.dispose()

        canonical = json.dumps(self._canonical(context), sort_keys=True, separators=(",", ":"), default=str).encode()
        self._prepared = {
            "context": context,
            "context_proof": hmac.new(database_url.encode(), canonical, hashlib.sha256).hexdigest(),
        }
        if mode == "propose_research":
            self.status = "Prepared one exact bounded research proposal from a documented evidence gap"
        else:
            self.status = (
                f"Prepared {len(context['results'])} accepted result(s) for extraction; "
                f"excluded {len(context['excluded_results'])}"
            )
        return self._prepared

    async def research_context(self) -> Data:
        return Data(data=await self._prepare_once())

    async def extraction_request(self) -> Message:
        # The model gets page text and the claim only; applicant identifiers stay with the validator.
        context = (await self._prepare_once())["context"]
        if context["operation_mode"] == "propose_research":
            request = {"operation_mode": "propose_research", "claim": None, "results": []}
        else:
            request = {
                "operation_mode": "analyze_accepted_results",
                "claim": {"claim_id": context["claim"]["claim_id"], "claim": context["claim"]["claim"]},
                "results": [
                    {
                        "result_id": page["immutable_result_id"],
                        "title": page["title"],
                        "publisher": page["publisher"],
                        "url": page["canonical_url"],
                        "excerpt": page["excerpt"],
                    }
                    for page in context["results"]
                ],
            }
        return Message(text=json.dumps(request, separators=(",", ":"), default=str))
