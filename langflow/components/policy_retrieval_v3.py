from __future__ import annotations

import json
import hashlib
import hmac
from collections import defaultdict
from datetime import date
from uuid import UUID

from sqlalchemy import create_engine, text

from lfx.custom.custom_component.component import Component
from lfx.io import MessageTextInput, Output, SecretStrInput
from lfx.schema.message import Message
from lfx.services.deps import session_scope


class KybPolicyRetrieval(Component):
    display_name = "Retrieve Applicable Policy"
    description = "Loads only run-pinned policy versions, applies context/effective-date filters, and builds a deterministic requirement-to-evidence matrix."
    icon = "book-open-check"
    name = "KybPolicyRetrieval"

    inputs = [
        MessageTextInput(
            name="input_value",
            display_name="Policy Task Reference",
            info="JSON with analysis_run_id, task_id, context_id, and optional case_id.",
            required=True,
        ),
        SecretStrInput(
            name="database_url",
            display_name="Database URL",
            info="Private PostgreSQL connection used for pinned policy and case-evidence retrieval.",
            required=True,
            advanced=False,
        ),
    ]
    outputs = [Output(display_name="Applicable Policy Envelope", name="policy_context", method="retrieve")]

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
    def _items(value: str | None) -> list[str]:
        return [item.strip() for item in str(value or "").split(";") if item.strip()]

    @staticmethod
    def _context_match(values, actual: str) -> bool:
        values = list(values or [])
        return "*" in values or actual in values

    @staticmethod
    def _positive(status: str) -> bool:
        return status.lower() in {"supported", "present", "valid", "current"}

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

    @classmethod
    def _compute(cls, run: dict, policy_rows: list[dict], case_rows: list[dict], task_id: str, context_id: str) -> dict:
        effective_on = run["policy_effective_on"]
        if isinstance(effective_on, str):
            effective_on = date.fromisoformat(effective_on)
        applicant = {
            "legal_name": run["legal_name"],
            "jurisdiction": run["jurisdiction"],
            "product": run["product"],
            "business_activity": run["business_type"],
        }

        case_citations, evidence = {}, []
        for row in case_rows:
            for line_number, line in enumerate(row["excerpt"].splitlines(), start=1):
                marker = cls._marker(line.strip(), "CASE_EVIDENCE")
                if not marker or not marker.get("type"):
                    continue
                citation_id = f"case-{row['chunk_id']}-{line_number}"
                case_citations[citation_id] = {
                    "id": citation_id,
                    "source_kind": "case_document",
                    "source_id": row["source_id"],
                    "chunk_id": row["chunk_id"],
                    "locator": row["locator"],
                    "excerpt": line.strip(),
                }
                evidence.append({
                    "evidence_type": marker["type"],
                    "reference": marker.get("reference") or marker["type"],
                    "status": marker.get("status") or "unsupported",
                    "value": marker.get("value") or "",
                    "citation_id": citation_id,
                })

        requirements = defaultdict(list)
        excluded_versions, excluded_requirements, active_versions = {}, [], {}
        for row in policy_rows:
            version_id = row["source_id"]
            version_reason = None
            if row["superseded"]:
                version_reason = "superseded"
            elif row["effective_from"] > effective_on or (row["effective_to"] and row["effective_to"] < effective_on):
                version_reason = "outside_effective_date"
            if version_reason:
                excluded_versions[version_id] = {
                    "policy_version_id": version_id,
                    "policy_code": row["policy_code"],
                    "version": row["version"],
                    "reason": version_reason,
                }
                continue
            active_versions[version_id] = {
                "policy_version_id": version_id,
                "policy_code": row["policy_code"],
                "version": row["version"],
                "effective_from": row["effective_from"].isoformat(),
                "effective_to": row["effective_to"].isoformat() if row["effective_to"] else None,
            }
            marker = None
            marker_line = None
            for line in row["excerpt"].splitlines():
                marker_line = line.split("\\n", 1)[0].strip()
                marker = cls._marker(marker_line, "POLICY_REQUIREMENT")
                if marker:
                    break
            if not marker or not marker.get("code") or not marker.get("description"):
                continue
            matches = (
                cls._context_match(row["jurisdictions"], applicant["jurisdiction"])
                and cls._context_match(row["products"], applicant["product"])
                and cls._context_match(row["business_types"], applicant["business_activity"])
            )
            if not matches:
                excluded_requirements.append({
                    "requirement_code": marker["code"],
                    "policy_version_id": version_id,
                    "locator": row["locator"],
                    "reason": "applicant_context_not_applicable",
                })
                continue
            citation_id = f"policy-{row['chunk_id']}"
            citation = {
                "id": citation_id,
                "source_kind": "policy",
                "source_id": version_id,
                "chunk_id": row["chunk_id"],
                "locator": row["locator"],
                "excerpt": marker_line,
            }
            requirements[marker["code"]].append({**marker, "citation": citation})

        matrix, conflicts, referenced_citations = [], [], {}

        def evidence_refs(types: list[str]) -> list[dict]:
            refs = []
            for item in evidence:
                if item["evidence_type"] in types:
                    refs.append(dict(item))
                    referenced_citations[item["citation_id"]] = case_citations[item["citation_id"]]
            return sorted(refs, key=lambda item: (item["evidence_type"], item["reference"], item["citation_id"]))

        for code in sorted(requirements):
            entries = requirements[code]
            signatures = {(entry["description"], tuple(cls._items(entry.get("required_evidence")))) for entry in entries}
            precedence_entries = [entry for entry in entries if entry.get("precedence")]
            if len(signatures) > 1 and len(precedence_entries) != 1:
                policy_ids = []
                required = sorted({item for entry in entries for item in cls._items(entry.get("required_evidence"))})
                for entry in entries:
                    policy_ids.append(entry["citation"]["id"])
                    referenced_citations[entry["citation"]["id"]] = entry["citation"]
                available = evidence_refs(required)
                conflict = {
                    "requirement_code": code,
                    "reason": "Multiple applicable pinned policy passages conflict and no documented precedence exists.",
                    "policy_citation_ids": sorted(policy_ids),
                    "descriptions": sorted(entry["description"] for entry in entries),
                }
                conflicts.append(conflict)
                matrix.append({
                    "requirement_code": code,
                    "description": "Conflicting applicable policy passages require analyst review.",
                    "applicability_rationale": f"All conflicting passages match jurisdiction {applicant['jurisdiction']}, product {applicant['product']}, business activity {applicant['business_activity']}, and effective date {effective_on.isoformat()}.",
                    "required_evidence": required,
                    "available_evidence_references": available,
                    "status": "conflicting",
                    "policy_citation_ids": sorted(policy_ids),
                    "conditional_exceptions": [],
                    "escalation_conditions": [{"condition": "Unresolved policy conflict requires analyst review.", "triggered": True}],
                    "unresolved_gaps": ["Documented policy precedence is absent."],
                })
                continue

            entry = precedence_entries[0] if len(precedence_entries) == 1 else entries[0]
            policy_id = entry["citation"]["id"]
            referenced_citations[policy_id] = entry["citation"]
            required = cls._items(entry.get("required_evidence"))
            available = evidence_refs(required)
            missing = []
            contradictory = False
            for evidence_type in required:
                matches = [item for item in available if item["evidence_type"] == evidence_type]
                if not any(cls._positive(item["status"]) for item in matches):
                    missing.append(evidence_type)
                states = {(item["status"].lower(), item["value"].strip().lower()) for item in matches}
                if len(states) > 1:
                    contradictory = True
            status = "conflicting" if contradictory else ("supported" if not missing else "unsupported")

            exceptions = []
            exception_code = entry.get("exception_code") or ""
            if exception_code:
                exception_required = cls._items(entry.get("exception_required_evidence"))
                exception_available = evidence_refs(exception_required)
                exception_missing = [
                    evidence_type for evidence_type in exception_required
                    if not any(cls._positive(item["status"]) for item in exception_available if item["evidence_type"] == evidence_type)
                ]
                exception_states = defaultdict(set)
                for item in exception_available:
                    exception_states[item["evidence_type"]].add((item["status"].lower(), item["value"].strip().lower()))
                exception_conflict = any(len(states) > 1 for states in exception_states.values())
                exception_status = "satisfied" if not exception_missing and not exception_conflict else ("conflicting" if exception_conflict else "unresolved")
                exceptions.append({
                    "code": exception_code,
                    "conditions": entry.get("exception_conditions") or "",
                    "required_evidence": exception_required,
                    "available_evidence_references": exception_available,
                    "status": exception_status,
                    "unresolved_gaps": [f"Missing exception evidence: {item}" for item in exception_missing],
                })
                if exception_status == "satisfied":
                    status = "supported"
                    missing = []

            unresolved = [f"Missing required evidence: {item}" for item in missing]
            for exception in exceptions:
                if exception["status"] != "satisfied":
                    unresolved.extend(exception["unresolved_gaps"])
            escalation = [
                {"condition": condition, "triggered": status in {"unsupported", "conflicting"}}
                for condition in cls._items(entry.get("escalation_conditions"))
            ]
            matrix.append({
                "requirement_code": code,
                "description": entry["description"],
                "applicability_rationale": f"Pinned passage matches jurisdiction {applicant['jurisdiction']}, product {applicant['product']}, business activity {applicant['business_activity']}, and effective date {effective_on.isoformat()}.",
                "required_evidence": required,
                "available_evidence_references": available,
                "status": status,
                "policy_citation_ids": [policy_id],
                "conditional_exceptions": exceptions,
                "escalation_conditions": escalation,
                "unresolved_gaps": unresolved,
            })

        status = "completed" if matrix and all(row["status"] == "supported" for row in matrix) and not conflicts else "partial"
        return {
            "contract_version": "3.2.0",
            "contribution_kind": "specialist_contribution",
            "contribution_id": f"policy-{task_id}",
            "case_id": run["case_id"],
            "analysis_run_id": run["analysis_run_id"],
            "task_id": task_id,
            "context_id": context_id,
            "specialist": {"name": "kyb-policy-agent", "version": "3.2.0"},
            "specialty": "policy",
            "status": status,
            "applicant_context": applicant,
            "policy_effective_on": effective_on.isoformat(),
            "source_scope": {
                "policy_requirements": "analysis_run_policy_versions",
                "documentary_case_evidence": "analysis_run_documents",
                "separation_enforced": True,
            },
            "pinned_policy_versions": sorted(active_versions.values(), key=lambda item: item["policy_version_id"]),
            "excluded_pinned_policy_versions": sorted(excluded_versions.values(), key=lambda item: item["policy_version_id"]),
            "excluded_inapplicable_requirements": sorted(excluded_requirements, key=lambda item: (item["requirement_code"], item["policy_version_id"])),
            "requirement_evidence_matrix": matrix,
            "policy_conflicts": conflicts,
            "citations": [referenced_citations[key] for key in sorted(referenced_citations)],
            "error": None,
        }

    async def retrieve(self) -> Message:
        raw = self.input_value.text if isinstance(self.input_value, Message) else self.input_value
        try:
            payload = json.loads(raw)
        except (TypeError, json.JSONDecodeError) as exc:
            raise ValueError("Policy task reference must be valid JSON") from exc
        if not isinstance(payload, dict):
            raise ValueError("Policy task reference must be a JSON object")
        run_id = str(payload.get("analysis_run_id", "")).strip()
        task_id = str(payload.get("task_id", "")).strip()
        context_id = str(payload.get("context_id", "")).strip()
        if not run_id or not task_id or not context_id:
            raise ValueError("analysis_run_id, task_id, and context_id are required")
        UUID(run_id)
        supplied_case_id = str(payload.get("case_id", "")).strip()
        if supplied_case_id:
            UUID(supplied_case_id)

        database_url = await self._database_url()
        engine = create_engine(database_url)
        try:
            with engine.connect() as connection:
                run = connection.execute(text("""
                    SELECT run.id::text AS analysis_run_id, run.case_id::text AS case_id,
                           run.policy_effective_on, applicant.legal_name, applicant.jurisdiction,
                           applicant.business_type, applicant.product
                    FROM analysis_runs run
                    JOIN onboarding_cases c ON c.id = run.case_id
                    JOIN applicants applicant ON applicant.id = c.applicant_id
                    WHERE run.id = CAST(:run_id AS uuid)
                """), {"run_id": run_id}).mappings().one_or_none()
                if run is None:
                    raise ValueError("analysis_run_id does not exist")
                run = dict(run)
                if supplied_case_id and supplied_case_id != run["case_id"]:
                    raise ValueError("case_id does not own the supplied analysis_run_id")
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

        expected = self._compute(run, policy_rows, case_rows, task_id, context_id)
        canonical = json.dumps(expected, sort_keys=True, separators=(",", ":"), default=str).encode()
        expected["retrieval_proof"] = hmac.new(database_url.encode(), canonical, hashlib.sha256).hexdigest()
        envelope = {
            "expected_contribution": expected,
            "instructions": "Return exactly one Policy Specialist Contribution. Copy expected_contribution exactly. Policy requirements and documentary case evidence must remain separate.",
        }
        self.status = f"Prepared {len(expected['requirement_evidence_matrix'])} applicable requirements from {len(expected['pinned_policy_versions'])} active pinned versions"
        return Message(text=json.dumps(envelope, separators=(",", ":"), default=str))
