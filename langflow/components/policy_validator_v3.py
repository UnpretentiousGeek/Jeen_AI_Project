from __future__ import annotations

import hashlib
import hmac
import json
from collections import defaultdict
from datetime import date, datetime, timezone
from typing import Any
from uuid import UUID

from sqlalchemy import create_engine, text

from lfx.custom.custom_component.component import Component
from lfx.io import HandleInput, Output, SecretStrInput
from lfx.schema.data import Data
from lfx.schema.message import Message
from lfx.services.deps import session_scope


class KybPolicyContributionValidator(Component):
    display_name = "Validate Policy Contribution"
    description = "Rejects cross-run scope, unpinned/superseded policy, altered matrix content, and fabricated citation identifiers, locators, excerpts, or references."
    icon = "shield-check"
    name = "KybPolicyContributionValidator"

    inputs = [
        HandleInput(
            name="artifact",
            display_name="Policy Agent Structured Review",
            input_types=["Data", "JSON", "Message"],
            required=True,
        ),
        HandleInput(
            name="source_envelope",
            display_name="Signed Policy Envelope",
            input_types=["Message", "Data", "JSON"],
            required=True,
        ),
        SecretStrInput(
            name="database_url",
            display_name="Database URL",
            info="Private PostgreSQL connection used to independently verify the pinned run snapshot.",
            required=True,
            advanced=False,
        ),
    ]
    outputs = [Output(display_name="Validated Policy Contribution", name="validated", method="validate")]

    @staticmethod
    def _payload(value: Any) -> dict:
        if isinstance(value, Message):
            value = value.text
        elif isinstance(value, Data):
            value = value.data
        if isinstance(value, str):
            value = value.strip()
            if value.startswith("```"):
                value = value.split("\n", 1)[1].rsplit("```", 1)[0].strip()
            value = json.loads(value)
        if isinstance(value, dict) and "expected_contribution" in value:
            value = value["expected_contribution"]
        if isinstance(value, dict) and "contribution_json" in value:
            value = json.loads(value["contribution_json"])
        if not isinstance(value, dict):
            raise ValueError("Policy contribution must be a JSON object")
        return value

    @staticmethod
    def _agent_review(value: Any) -> dict:
        if isinstance(value, Message):
            value = value.text
        elif isinstance(value, Data):
            value = value.data
        if isinstance(value, str):
            value = json.loads(value)
        if not isinstance(value, dict):
            raise ValueError("Policy Agent Structured Review must be an object")
        required = {
            "analysis_run_id", "task_id", "reviewed_requirement_codes",
            "checked_policy_citation_id",
        }
        if not required <= set(value):
            raise ValueError("Policy Agent Structured Review is missing required fields")
        codes = value["reviewed_requirement_codes"]
        if not isinstance(codes, list) or any(not isinstance(code, str) for code in codes):
            raise ValueError("reviewed_requirement_codes must be a list of strings")
        if not isinstance(value["checked_policy_citation_id"], str):
            raise ValueError("checked_policy_citation_id must be a string")
        return value

    @staticmethod
    def _marker(line: str, prefix: str) -> dict | None:
        if not line.startswith(prefix + "|"):
            return None
        parts = {}
        for item in line.split("|")[1:]:
            if "=" in item:
                key, value = item.split("=", 1)
                parts[key.strip()] = value.strip()
        return parts

    @staticmethod
    def _context_match(values, actual: str) -> bool:
        values = list(values or [])
        return "*" in values or actual in values

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

    async def validate(self) -> Data:
        review = self._agent_review(self.artifact)
        artifact = self._payload(self.source_envelope)
        if artifact.get("error") == {}:
            artifact["error"] = None
        required = {
            "contract_version", "contribution_kind", "contribution_id", "case_id",
            "analysis_run_id", "task_id", "context_id", "specialist", "specialty",
            "status", "applicant_context", "policy_effective_on", "source_scope",
            "pinned_policy_versions", "excluded_pinned_policy_versions",
            "excluded_inapplicable_requirements", "requirement_evidence_matrix",
            "policy_conflicts", "citations", "error", "retrieval_proof",
        }
        missing = sorted(required - set(artifact))
        if missing:
            raise ValueError(f"Policy contribution is missing fields: {', '.join(missing)}")
        if artifact["contract_version"] != "3.2.0" or artifact["contribution_kind"] != "specialist_contribution":
            raise ValueError("Unsupported Policy Specialist Contribution contract")
        if artifact["specialist"] != {"name": "kyb-policy-agent", "version": "3.2.0"} or artifact["specialty"] != "policy":
            raise ValueError("Unexpected policy specialist identity")
        if artifact["contribution_id"] != f"policy-{artifact['task_id']}":
            raise ValueError("contribution_id must equal policy- plus task_id")
        if artifact["error"] is not None:
            raise ValueError("A successful Policy Specialist Contribution must normalize error to null")
        run_id = str(artifact["analysis_run_id"])
        case_id = str(artifact["case_id"])
        UUID(run_id)
        UUID(case_id)

        database_url = await self._database_url()
        supplied_proof = str(artifact["retrieval_proof"])
        unsigned = dict(artifact)
        unsigned.pop("retrieval_proof", None)
        unsigned.pop("deterministic_validation", None)
        canonical = json.dumps(unsigned, sort_keys=True, separators=(",", ":"), default=str).encode()
        expected_proof = hmac.new(database_url.encode(), canonical, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(supplied_proof, expected_proof):
            raise ValueError("Policy contribution content differs from the deterministically retrieved matrix")

        engine = create_engine(database_url)
        try:
            with engine.connect() as connection:
                run = connection.execute(text("""
                    SELECT run.case_id::text AS case_id, run.policy_effective_on,
                           applicant.legal_name, applicant.jurisdiction,
                           applicant.business_type, applicant.product
                    FROM analysis_runs run
                    JOIN onboarding_cases c ON c.id = run.case_id
                    JOIN applicants applicant ON applicant.id = c.applicant_id
                    WHERE run.id = CAST(:run_id AS uuid)
                """), {"run_id": run_id}).mappings().one_or_none()
                if run is None:
                    raise ValueError("analysis_run_id does not exist")
                run = dict(run)
                if run["case_id"] != case_id:
                    raise ValueError("Policy contribution case_id does not own analysis_run_id")
                policy_rows = [dict(row) for row in connection.execute(text("""
                    SELECT version.id::text AS source_id, document.code AS policy_code,
                           version.version, version.effective_from, version.effective_to,
                           version.superseded, chunk.id::text AS chunk_id,
                           chunk.section_locator AS locator, chunk.content AS excerpt,
                           chunk.jurisdictions, chunk.products, chunk.business_types
                    FROM analysis_run_policy_versions snapshot
                    JOIN policy_versions version ON version.id = snapshot.policy_version_id
                    JOIN policy_documents document ON document.id = version.policy_document_id
                    JOIN policy_chunks chunk ON chunk.policy_version_id = version.id
                    WHERE snapshot.analysis_run_id = CAST(:run_id AS uuid)
                    ORDER BY version.id, chunk.chunk_index
                """), {"run_id": run_id}).mappings()]
                case_rows = [dict(row) for row in connection.execute(text("""
                    SELECT document.id::text AS source_id, chunk.id::text AS chunk_id,
                           chunk.section_locator AS locator, chunk.content AS excerpt
                    FROM analysis_run_documents snapshot
                    JOIN case_documents document ON document.id = snapshot.document_id AND document.case_id = snapshot.case_id
                    JOIN document_chunks chunk ON chunk.document_id = document.id AND chunk.case_id = snapshot.case_id
                    WHERE snapshot.analysis_run_id = CAST(:run_id AS uuid)
                    ORDER BY chunk.id
                """), {"run_id": run_id}).mappings()]
        finally:
            engine.dispose()

        effective_on = run["policy_effective_on"]
        if isinstance(effective_on, str):
            effective_on = date.fromisoformat(effective_on)
        context = {
            "legal_name": run["legal_name"],
            "jurisdiction": run["jurisdiction"],
            "product": run["product"],
            "business_activity": run["business_type"],
        }
        if artifact["applicant_context"] != context or artifact["policy_effective_on"] != effective_on.isoformat():
            raise ValueError("Applicant context or effective date differs from the owning analysis run")
        if artifact["source_scope"] != {
            "policy_requirements": "analysis_run_policy_versions",
            "documentary_case_evidence": "analysis_run_documents",
            "separation_enforced": True,
        }:
            raise ValueError("Policy requirements and documentary case evidence source scopes must remain separate")

        allowed, applicable = {}, defaultdict(list)
        expected_active, expected_excluded, expected_inapplicable = {}, {}, []
        for row in policy_rows:
            reason = None
            if row["superseded"]:
                reason = "superseded"
            elif row["effective_from"] > effective_on or (row["effective_to"] and row["effective_to"] < effective_on):
                reason = "outside_effective_date"
            if reason:
                expected_excluded[row["source_id"]] = {
                    "policy_version_id": row["source_id"], "policy_code": row["policy_code"],
                    "version": row["version"], "reason": reason,
                }
                continue
            expected_active[row["source_id"]] = {
                "policy_version_id": row["source_id"], "policy_code": row["policy_code"],
                "version": row["version"], "effective_from": row["effective_from"].isoformat(),
                "effective_to": row["effective_to"].isoformat() if row["effective_to"] else None,
            }
            marker_line = next((line.split("\\n", 1)[0].strip() for line in row["excerpt"].splitlines() if line.strip().startswith("POLICY_REQUIREMENT|")), None)
            marker = self._marker(marker_line, "POLICY_REQUIREMENT") if marker_line else None
            if not marker or not marker.get("code"):
                continue
            matches = (
                self._context_match(row["jurisdictions"], context["jurisdiction"])
                and self._context_match(row["products"], context["product"])
                and self._context_match(row["business_types"], context["business_activity"])
            )
            if not matches:
                expected_inapplicable.append({
                    "requirement_code": marker["code"], "policy_version_id": row["source_id"],
                    "locator": row["locator"], "reason": "applicant_context_not_applicable",
                })
                continue
            citation_id = f"policy-{row['chunk_id']}"
            citation = {
                "id": citation_id, "source_kind": "policy", "source_id": row["source_id"],
                "chunk_id": row["chunk_id"], "locator": row["locator"], "excerpt": marker_line,
            }
            allowed[citation_id] = citation
            applicable[marker["code"]].append(citation_id)

        case_markers = defaultdict(list)
        for row in case_rows:
            for line_number, line in enumerate(row["excerpt"].splitlines(), start=1):
                marker = self._marker(line.strip(), "CASE_EVIDENCE")
                if not marker or not marker.get("type"):
                    continue
                citation_id = f"case-{row['chunk_id']}-{line_number}"
                allowed[citation_id] = {
                    "id": citation_id, "source_kind": "case_document", "source_id": row["source_id"],
                    "chunk_id": row["chunk_id"], "locator": row["locator"], "excerpt": line.strip(),
                }
                case_markers[marker["type"]].append({
                    "evidence_type": marker["type"], "reference": marker.get("reference") or marker["type"],
                    "status": marker.get("status") or "unsupported", "value": marker.get("value") or "",
                    "citation_id": citation_id,
                })

        if artifact["pinned_policy_versions"] != sorted(expected_active.values(), key=lambda item: item["policy_version_id"]):
            raise ValueError("Pinned active policy versions do not match the run snapshot")
        if artifact["excluded_pinned_policy_versions"] != sorted(expected_excluded.values(), key=lambda item: item["policy_version_id"]):
            raise ValueError("Superseded/effective-date policy exclusions do not match the run snapshot")
        if artifact["excluded_inapplicable_requirements"] != sorted(expected_inapplicable, key=lambda item: (item["requirement_code"], item["policy_version_id"])):
            raise ValueError("Context-inapplicable requirement exclusions are incorrect")
        matrix = artifact["requirement_evidence_matrix"]
        if not isinstance(matrix, list) or sorted(row.get("requirement_code") for row in matrix) != sorted(applicable):
            raise ValueError("Matrix must contain each and only context-applicable requirement code")
        for row in matrix:
            code = row["requirement_code"]
            if sorted(row.get("policy_citation_ids") or []) != sorted(applicable[code]):
                raise ValueError(f"Policy citations for {code} do not match applicable pinned passages")
            for ref in row.get("available_evidence_references") or []:
                if ref not in case_markers.get(ref.get("evidence_type"), []):
                    raise ValueError(f"Evidence reference for {code} is fabricated or altered")
            for exception in row.get("conditional_exceptions") or []:
                for ref in exception.get("available_evidence_references") or []:
                    if ref not in case_markers.get(ref.get("evidence_type"), []):
                        raise ValueError(f"Exception evidence reference for {code} is fabricated or altered")

        supplied = {}
        if not isinstance(artifact["citations"], list):
            raise ValueError("citations must be a list")
        for citation in artifact["citations"]:
            if not isinstance(citation, dict) or not citation.get("id") or citation["id"] in supplied:
                raise ValueError("Citations require unique non-empty ids")
            canonical = allowed.get(citation["id"])
            if canonical is None:
                raise ValueError(f"Citation {citation['id']} is unknown, cross-case, or unpinned")
            # Models copy long UUIDs and excerpts unreliably. The id alone names the
            # pinned source, so persist the database copy instead of the model's.
            supplied[citation["id"]] = canonical
        artifact["citations"] = list(supplied.values())
        referenced = set()
        for row in matrix:
            referenced.update(row.get("policy_citation_ids") or [])
            referenced.update(ref.get("citation_id") for ref in row.get("available_evidence_references") or [])
            for exception in row.get("conditional_exceptions") or []:
                referenced.update(ref.get("citation_id") for ref in exception.get("available_evidence_references") or [])
        for conflict in artifact["policy_conflicts"]:
            referenced.update(conflict.get("policy_citation_ids") or [])
        if set(supplied) != referenced:
            raise ValueError("Citation list must exactly equal all and only referenced pinned citations")

        if review["analysis_run_id"] != run_id or review["task_id"] != artifact["task_id"]:
            raise ValueError("Policy Agent review does not match its analysis run and task")
        requirement_codes = [row["requirement_code"] for row in matrix]
        if sorted(review["reviewed_requirement_codes"]) != sorted(requirement_codes):
            raise ValueError("Policy Agent did not review the exact applicable requirement codes")
        first_policy_citation = next(
            (citation["id"] for citation in artifact["citations"] if citation["source_kind"] == "policy"),
            "",
        )
        if review["checked_policy_citation_id"] != first_policy_citation:
            raise ValueError("Policy Agent did not report the expected policy citation check")

        artifact["deterministic_validation"] = {
            "validator": "policy-contribution-v3.2.0",
            "outcome": "accepted",
            "checks": [
                "case_run_relationship", "source_scope_separation", "pinned_policy_versions",
                "effective_date", "superseded_exclusion", "context_applicability",
                "matrix_integrity", "exception_evidence", "policy_conflict_visibility",
                "citation_identifiers", "citation_locators", "citation_excerpts", "citation_references",
            ],
            "agent_review": {
                "reviewed_requirement_codes": review["reviewed_requirement_codes"],
                "checked_policy_citation_id": review["checked_policy_citation_id"],
            },
            "validated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        }
        self.status = f"Accepted {len(matrix)} applicable policy requirements with {len(supplied)} exact citations"
        return Data(data=artifact)
