from __future__ import annotations

import json
import re
import uuid
from urllib.parse import urlsplit

from sqlalchemy import create_engine, text

from lfx.custom import Component
from lfx.io import HandleInput, Output, SecretStrInput
from lfx.schema import Data, Message
from lfx.services.deps import session_scope


def _canonical(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


def _object(value: object) -> dict:
    if isinstance(value, Message):
        value = value.text
    if isinstance(value, Data):
        value = value.data
    if isinstance(value, dict):
        parsed = value
    else:
        raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", str(value or "").strip(), flags=re.I)
        parsed = json.loads(raw or "{}")
    if isinstance(parsed, dict) and isinstance(parsed.get("data"), dict):
        parsed = parsed["data"]
    if not isinstance(parsed, dict):
        raise ValueError("Coordinator token must be one JSON object")
    return parsed


def _validate_terminal_coherence(run: dict) -> None:
    """Reject terminal snapshots that still advertise resumable work."""
    state = run.get("state") or {}
    if run.get("phase") in {"stopped", "finalized"}:
        if state.get("pending_checkpoint") is not None or state.get("next_action") is not None:
            raise ValueError("Terminal coordinator state cannot contain pending checkpoint or action")
    if run.get("phase") == "stopped":
        if run.get("analysis_status") != "failed":
            raise ValueError("Stopped coordinator state requires a failed analysis run")
        if not str(run.get("stop_reason") or "").strip():
            raise ValueError("Stopped coordinator state requires a nonempty stop reason")
    if run.get("phase") == "finalized":
        if run.get("analysis_status") != "succeeded" or run.get("case_status") != "ready_for_review":
            raise ValueError("Finalized coordinator state disagrees with persisted terminal statuses")


class KybFinalSnapshotValidatorV3(Component):
    display_name = "4 · Final Snapshot Validator V3"
    description = "Returns a database-authoritative snapshot and rejects terminal state drift or unaccepted evidence."
    icon = "badge-check"
    name = "KybFinalSnapshotValidatorV3"
    inputs = [
        HandleInput(name="input_value", display_name="Coordinator Token", input_types=["Data", "JSON", "Message"], required=True),
        SecretStrInput(name="database_url", display_name="Database URL", value="DATABASE_URL", required=True, advanced=True),
    ]
    outputs = [Output(display_name="Validated Final Snapshot", name="validated_snapshot", method="validate")]

    async def _database_url(self) -> str:
        value = self.database_url
        if hasattr(value, "get_secret_value"):
            value = value.get_secret_value()
        value = str(value or "").strip().strip("\"'")
        if not value.startswith(("postgresql://", "postgresql+psycopg://", "postgresql+psycopg2://")):
            async with session_scope() as session:
                value = await self.get_variable("DATABASE_URL", "value", session)
            if hasattr(value, "get_secret_value"):
                value = value.get_secret_value()
            value = str(value or "").strip().strip("\"'")
        if value.startswith("postgres://"):
            value = "postgresql://" + value[len("postgres://"):]
        if value.startswith("postgresql+asyncpg://"):
            value = "postgresql+psycopg2://" + value[len("postgresql+asyncpg://"):]
        if value.startswith("postgresql+psycopg://"):
            value = "postgresql+psycopg2://" + value[len("postgresql+psycopg://"):]
        if not value.startswith(("postgresql://", "postgresql+psycopg2://")):
            scheme = urlsplit(value).scheme or "missing"
            raise ValueError(f"Server-side DATABASE_URL has unsupported scheme: {scheme}")
        return value

    async def validate(self) -> Message:
        token = _object(self.input_value)
        if token.get("review_decision") not in (None, ""):
            raise ValueError("Coordinator output must not invent a review decision")
        analysis_run_id = str(uuid.UUID(str(token.get("analysis_run_id") or "")))
        engine = create_engine(await self._database_url())
        try:
            with engine.begin() as connection:
                row = connection.execute(text("""
                    SELECT coordinator.id::text AS coordinator_run_id,
                           coordinator.analysis_run_id::text,
                           coordinator.case_id::text,
                           coordinator.phase,coordinator.current_iteration,
                           coordinator.max_iterations,coordinator.state_version,
                           coordinator.stop_reason,coordinator.state,
                           analysis.status AS analysis_status,analysis.session_id,
                           onboarding_case.status AS case_status
                    FROM coordinator_v3_runs coordinator
                    JOIN analysis_runs analysis ON analysis.id=coordinator.analysis_run_id
                    JOIN onboarding_cases onboarding_case ON onboarding_case.id=coordinator.case_id
                    WHERE coordinator.analysis_run_id=CAST(:run AS uuid)
                      AND coordinator.engine_version='durable-loop-v1'
                    ORDER BY coordinator.created_at DESC LIMIT 1
                """), {"run":analysis_run_id}).mappings().one_or_none()
                if row is None:
                    raise ValueError("Persisted durable coordinator run is unavailable")
                run = dict(row)
                state = dict(run["state"])
                _validate_terminal_coherence(run)
                findings = [dict(item) for item in connection.execute(text("""
                    SELECT finding.id::text, finding.requirement_code, finding.outcome,
                           finding.summary, finding.rationale, finding.confidence,
                           COALESCE(jsonb_agg(jsonb_build_object(
                             'id',citation.id::text,
                             'source_kind',citation.source_kind,
                             'document_chunk_id',citation.document_chunk_id::text,
                             'policy_chunk_id',citation.policy_chunk_id::text,
                             'human_input_request_id',citation.human_input_request_id::text,
                             'external_web_evidence_id',citation.external_web_evidence_id::text,
                             'agent_task_id',citation.agent_task_id,
                             'agent_artifact_id',citation.agent_artifact_id,
                             'locator',citation.locator,'excerpt',citation.excerpt
                           ) ORDER BY citation.id) FILTER (WHERE citation.id IS NOT NULL),'[]'::jsonb) AS citations
                    FROM findings finding
                    LEFT JOIN citations citation ON citation.finding_id=finding.id
                    WHERE finding.analysis_run_id=CAST(:run AS uuid)
                    GROUP BY finding.id ORDER BY finding.requirement_code,finding.id
                """), {"run":analysis_run_id}).mappings()]
                evidence_gaps = [dict(item) for item in connection.execute(text("""
                    SELECT id::text,requirement_code,description,requested_evidence
                    FROM evidence_gaps WHERE analysis_run_id=CAST(:run AS uuid) ORDER BY id
                """), {"run":analysis_run_id}).mappings()]
                conflicts = [dict(item) for item in connection.execute(text("""
                    SELECT id::text,subject,description
                    FROM conflicts WHERE analysis_run_id=CAST(:run AS uuid) ORDER BY id
                """), {"run":analysis_run_id}).mappings()]
                contributions = [dict(item) for item in connection.execute(text("""
                    SELECT specialty,task_id,context_id,status,attempt,payload_hash
                    FROM coordinator_v3_contributions
                    WHERE analysis_run_id=CAST(:run AS uuid)
                    ORDER BY specialty,attempt
                """), {"run":analysis_run_id}).mappings()]
                accepted_web = [dict(item) for item in connection.execute(text("""
                    SELECT evidence.id::text AS result_id,evidence.url,evidence.title,
                           evidence.publisher,evidence.content_hash
                    FROM external_web_evidence evidence
                    JOIN web_result_review_items review_item
                      ON review_item.external_web_evidence_id=evidence.id
                     AND review_item.analysis_run_id=CAST(:run AS uuid)
                     AND review_item.case_id=evidence.case_id
                     AND review_item.review_state='accepted'
                    WHERE evidence.analysis_run_id=CAST(:run AS uuid)
                    ORDER BY evidence.id
                """), {"run":analysis_run_id}).mappings()]

                invalid_citation_count = connection.execute(text("""
                    SELECT count(*)
                    FROM citations citation
                    WHERE citation.analysis_run_id=CAST(:run AS uuid)
                      AND (
                        (citation.source_kind='case_document' AND NOT EXISTS (
                          SELECT 1 FROM analysis_run_documents snapshot
                          JOIN document_chunks chunk ON chunk.document_id=snapshot.document_id
                          WHERE snapshot.analysis_run_id=CAST(:run AS uuid)
                            AND snapshot.case_id=CAST(:case AS uuid)
                            AND chunk.id=citation.document_chunk_id
                        ))
                        OR (citation.source_kind='policy' AND NOT EXISTS (
                          SELECT 1 FROM analysis_run_policy_versions snapshot
                          JOIN analysis_runs run ON run.id=snapshot.analysis_run_id
                          JOIN policy_chunks chunk ON chunk.policy_version_id=snapshot.policy_version_id
                          WHERE snapshot.analysis_run_id=CAST(:run AS uuid)
                            AND chunk.id=citation.policy_chunk_id
                            AND ('*' = ANY(chunk.jurisdictions)
                                OR run.case_snapshot #>> '{applicant,jurisdiction}' = ANY(chunk.jurisdictions))
                            AND ('*' = ANY(chunk.products)
                                OR run.case_snapshot #>> '{applicant,product}' = ANY(chunk.products))
                            AND ('*' = ANY(chunk.business_types)
                                OR run.case_snapshot #>> '{applicant,business_type}' = ANY(chunk.business_types))
                        ))
                        OR (citation.source_kind='human_input' AND NOT EXISTS (
                          SELECT 1 FROM human_input_requests request
                          WHERE request.analysis_run_id=CAST(:run AS uuid)
                            AND request.id=citation.human_input_request_id
                            AND request.status='answered'
                        ))
                        OR (citation.source_kind='external_web' AND NOT coordinator_v3_web_citation_permitted(
                          CAST(:run AS uuid), CAST(:case AS uuid), citation.external_web_evidence_id,
                          citation.agent_task_id, citation.agent_artifact_id
                        ))
                        OR citation.source_kind NOT IN ('case_document','policy','human_input','external_web')
                      )
                """), {"run":analysis_run_id,"case":run["case_id"]}).scalar_one()
                if invalid_citation_count:
                    raise ValueError("Persisted findings contain citations outside the run's accepted evidence scope")

                persisted_finding_ids = sorted(item["id"] for item in findings)
                state_finding_ids = sorted(str(item) for item in state.get("latest_findings") or [])
                if state_finding_ids and state_finding_ids != persisted_finding_ids:
                    raise ValueError("Persisted final finding index drifted from normalized findings")
                if run["phase"] == "ready_for_review":
                    if run["analysis_status"] != "succeeded" or run["case_status"] != "ready_for_review":
                        raise ValueError("Terminal coordinator state disagrees with the persisted case or analysis run")
                    if not findings or state.get("pending_checkpoint") is not None or state.get("next_action") is not None:
                        raise ValueError("Ready-for-review state requires findings and no pending work")
                if run["phase"] == "waiting_for_human":
                    if run["analysis_status"] != "suspended" or not isinstance(state.get("pending_checkpoint"), dict):
                        raise ValueError("Waiting coordinator state disagrees with the persisted checkpoint")

                snapshot = {
                    "schema_version":"3.0",
                    "analysis_run_id":analysis_run_id,
                    "case_id":run["case_id"],
                    "coordinator_run_id":run["coordinator_run_id"],
                    "status":run["phase"],
                    "analysis_status":run["analysis_status"],
                    "case_status":run["case_status"],
                    "iteration":run["current_iteration"],
                    "max_iterations":run["max_iterations"],
                    "state_version":run["state_version"],
                    "completed_specialists":state.get("completed_specialists") or [],
                    "pending_checkpoint":state.get("pending_checkpoint"),
                    "accepted_evidence_ids":[item["result_id"] for item in accepted_web],
                    "findings":findings,
                    "evidence_gaps":evidence_gaps,
                    "conflicts":conflicts,
                    "specialist_contributions":contributions,
                    "accepted_web_evidence":accepted_web,
                    "stop_reason":run["stop_reason"],
                    "review_decision":None,
                }
        finally:
            engine.dispose()
        self.status = f"Validated persisted {snapshot['status']} snapshot"
        return Message(text=_canonical(snapshot), session_id=run["session_id"])
