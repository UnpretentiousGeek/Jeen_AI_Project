from __future__ import annotations

import hashlib
import json
import re
import uuid
from urllib.parse import urlsplit

from sqlalchemy import create_engine, text

from lfx.custom import Component
from lfx.io import HandleInput, Output, SecretStrInput
from lfx.schema import Message
from lfx.services.deps import session_scope


def _canonical(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


def _parse_message(value: object) -> dict:
    if isinstance(value, Message):
        value = value.text
    if isinstance(value, dict):
        parsed = value
    else:
        raw = str(value or "").strip()
        raw = re.sub(r"^```(?:json)?\s*", "", raw, flags=re.IGNORECASE)
        raw = re.sub(r"\s*```$", "", raw)
        parsed = json.loads(raw)
    if not isinstance(parsed, dict):
        raise ValueError("Coordinator request must be one JSON object")
    return parsed


def _uuid_text(value: object, field: str) -> str:
    try:
        return str(uuid.UUID(str(value)))
    except (ValueError, TypeError, AttributeError) as exc:
        raise ValueError(f"{field} must be a valid UUID") from exc


class KybRunContextV3(Component):
    display_name = "1 · Persisted Run Context V3"
    description = (
        "Validates an active analysis run, loads its immutable evidence and policy "
        "references, and persists Langflow job correlation before coordination begins."
    )
    icon = "database-zap"
    name = "KybRunContextV3"

    inputs = [
        HandleInput(
            name="request",
            display_name="Coordinator Request",
            input_types=["Message"],
            required=True,
        ),
        SecretStrInput(
            name="database_url",
            display_name="Database URL",
            value="DATABASE_URL",
            required=True,
            advanced=True,
            info="Server-side Langflow global variable name or private PostgreSQL URL.",
        ),
    ]

    outputs = [
        Output(
            display_name="Persisted Run State",
            name="run_state",
            method="load_and_persist",
        )
    ]

    async def _database_url(self) -> str:
        value = self.database_url
        if hasattr(value, "get_secret_value"):
            value = value.get_secret_value()
        value = str(value or "").strip().strip("\"'")
        if value.startswith("postgres://"):
            value = "postgresql://" + value[len("postgres://") :]
        if value.startswith("postgresql+asyncpg://"):
            value = "postgresql+psycopg2://" + value[len("postgresql+asyncpg://") :]
        if value.startswith("postgresql+psycopg://"):
            value = "postgresql+psycopg2://" + value[len("postgresql+psycopg://") :]
        if value.startswith(
            ("postgresql://", "postgresql+psycopg://", "postgresql+psycopg2://")
        ):
            return value

        # Langflow may hydrate a SecretStrInput with an internal secret-reference ID.
        # Only accept an actual URL from the field; otherwise resolve the stable,
        # server-side variable name without trusting or exposing that reference.
        async with session_scope() as session:
            value = await self.get_variable("DATABASE_URL", "value", session)
        if hasattr(value, "get_secret_value"):
            value = value.get_secret_value()
        value = str(value or "").strip().strip("\"'")
        if value.startswith("postgres://"):
            value = "postgresql://" + value[len("postgres://") :]
        if value.startswith("postgresql+asyncpg://"):
            value = "postgresql+psycopg2://" + value[len("postgresql+asyncpg://") :]
        if value.startswith("postgresql+psycopg://"):
            value = "postgresql+psycopg2://" + value[len("postgresql+psycopg://") :]
        if not value.startswith(
            ("postgresql://", "postgresql+psycopg://", "postgresql+psycopg2://")
        ):
            scheme = urlsplit(value).scheme or "missing"
            raise ValueError(f"Server-side DATABASE_URL has unsupported scheme: {scheme}")
        return value

    def _job_id(self) -> str:
        job_id = str(getattr(self.graph, "run_id", "") or "").strip()
        if not job_id:
            raise ValueError("Langflow job identity is unavailable")
        return job_id

    def _flow_id(self) -> str:
        flow_id = str(getattr(self.graph, "flow_id", "") or "").strip()
        if not flow_id:
            raise ValueError("Langflow flow identity is unavailable")
        return flow_id

    def _session_id(self) -> str:
        session_id = ""
        if isinstance(self.request, Message):
            session_id = str(getattr(self.request, "session_id", "") or "").strip()
        if not session_id:
            session_id = str(getattr(self.graph, "session_id", "") or "").strip()
        if not session_id:
            raise ValueError("Langflow session identity is unavailable")
        return session_id

    async def load_and_persist(self) -> Message:
        request = _parse_message(self.request)
        required = {"analysis_run_id", "case_id", "session_id", "task_objective"}
        missing = sorted(required.difference(request))
        if missing:
            raise ValueError(f"Coordinator request missing: {', '.join(missing)}")

        analysis_run_id = _uuid_text(request["analysis_run_id"], "analysis_run_id")
        case_id = _uuid_text(request["case_id"], "case_id")
        supplied_session_id = str(request["session_id"]).strip()
        task_objective = str(request["task_objective"]).strip()
        if not supplied_session_id:
            raise ValueError("session_id must not be empty")
        if not task_objective:
            raise ValueError("task_objective must not be empty")

        graph_session_id = self._session_id()
        if supplied_session_id != graph_session_id:
            raise ValueError("request session_id does not match the Langflow session")

        normalized_request = {
            **request,
            "schema_version": str(request.get("schema_version") or "1.0"),
            "analysis_run_id": analysis_run_id,
            "case_id": case_id,
            "session_id": supplied_session_id,
            "task_objective": task_objective,
        }
        request_hash = hashlib.sha256(_canonical(normalized_request).encode()).hexdigest()
        job_id = ""
        flow_id = ""
        database_url = await self._database_url()
        engine = create_engine(database_url)

        try:
            with engine.begin() as connection:
                run = connection.execute(
                    text(
                        """
                        SELECT
                          r.id::text AS analysis_run_id,
                          r.case_id::text AS case_id,
                          r.session_id,
                          r.status,
                          r.output_schema_version,
                          r.analyst_instructions,
                          r.policy_effective_on::text AS policy_effective_on,
                          r.case_snapshot,
                          c.active_analysis_run_id::text AS active_analysis_run_id
                        FROM analysis_runs r
                        JOIN onboarding_cases c ON c.id = r.case_id
                        WHERE r.id = CAST(:run AS uuid)
                          AND r.case_id = CAST(:case AS uuid)
                        FOR UPDATE
                        """
                    ),
                    {"run": analysis_run_id, "case": case_id},
                ).mappings().one_or_none()

                if run is None:
                    raise ValueError("analysis_run_id does not belong to the requested case")
                if run["session_id"] != supplied_session_id:
                    raise ValueError("analysis run session does not match the request")
                if run["status"] not in {"succeeded", "failed"} and run["active_analysis_run_id"] != analysis_run_id:
                    raise ValueError("analysis run is not the case's active run")
                if run["status"] not in {"queued", "running", "suspended", "succeeded", "failed"}:
                    raise ValueError(f"analysis run is terminal: {run['status']}")

                document_refs = [
                    dict(row)
                    for row in connection.execute(
                        text(
                            """
                            SELECT
                              d.id::text AS document_id,
                              d.evidence_submission_id::text AS evidence_submission_id,
                              d.document_type,
                              d.checksum_sha256,
                              d.ingestion_status
                            FROM analysis_run_documents snapshot
                            JOIN case_documents d
                              ON d.id = snapshot.document_id
                             AND d.case_id = snapshot.case_id
                            WHERE snapshot.analysis_run_id = CAST(:run AS uuid)
                              AND snapshot.case_id = CAST(:case AS uuid)
                            ORDER BY d.id
                            """
                        ),
                        {"run": analysis_run_id, "case": case_id},
                    ).mappings()
                ]
                policy_refs = [
                    dict(row)
                    for row in connection.execute(
                        text(
                            """
                            SELECT
                              v.id::text AS policy_version_id,
                              p.code AS policy_code,
                              v.version,
                              v.effective_from::text AS effective_from,
                              v.effective_to::text AS effective_to,
                              v.checksum_sha256
                            FROM analysis_run_policy_versions snapshot
                            JOIN policy_versions v ON v.id = snapshot.policy_version_id
                            JOIN policy_documents p ON p.id = v.policy_document_id
                            WHERE snapshot.analysis_run_id = CAST(:run AS uuid)
                            ORDER BY p.code, v.version
                            """
                        ),
                        {"run": analysis_run_id},
                    ).mappings()
                ]

                if not document_refs:
                    raise ValueError("analysis run has no pinned evidence documents")
                if not policy_refs:
                    raise ValueError("analysis run has no pinned policy versions")
                if any(ref["ingestion_status"] != "ready" for ref in document_refs):
                    raise ValueError("analysis run contains evidence that is not ready")

                immutable_context = {
                    "case_snapshot": run["case_snapshot"],
                    "policy_effective_on": run["policy_effective_on"],
                    "output_schema_version": run["output_schema_version"],
                    "analyst_instructions": run["analyst_instructions"],
                    "evidence_scope": {
                        "case_id": case_id,
                        "analysis_run_id": analysis_run_id,
                        "document_refs": document_refs,
                        "policy_refs": policy_refs,
                        "network_access": False,
                        "source_records_mutable_by_agents": False,
                    },
                }
                if run["status"] in {"succeeded", "failed"}:
                    persisted_coordinator = connection.execute(
                        text(
                            """
                            SELECT id::text AS coordinator_run_id,
                                   analysis_run_id::text,
                                   case_id::text,
                                   state_version,
                                   current_iteration AS iteration,
                                   max_iterations,
                                   phase,
                                   state
                            FROM coordinator_v3_runs
                            WHERE analysis_run_id = CAST(:run AS uuid)
                              AND engine_version = 'durable-loop-v1'
                            ORDER BY created_at DESC
                            LIMIT 1
                            """
                        ),
                        {"run": analysis_run_id},
                    ).mappings().one_or_none()
                    if persisted_coordinator is None:
                        raise ValueError("Terminal analysis run has no persisted coordinator state")
                    coordinator = dict(persisted_coordinator)
                else:
                    job_id = self._job_id()
                    flow_id = self._flow_id()
                    coordinator = connection.execute(
                        text(
                            """
                            SELECT start_or_resume_simple_coordinator_v3(
                              CAST(:run AS uuid), CAST(:case AS uuid), :session,
                              :flow, :job, :objective, :max_iterations
                            )
                            """
                        ),
                        {
                            "run": analysis_run_id,
                            "case": case_id,
                            "session": supplied_session_id,
                            "flow": flow_id,
                            "job": job_id,
                            "objective": task_objective,
                            "max_iterations": 8,
                        },
                    ).scalar_one()
        finally:
            engine.dispose()

        persisted_state = dict(coordinator["state"])
        persisted_state.update(
            {
                "coordinator_run_id": coordinator["coordinator_run_id"],
                "state_version": coordinator["state_version"],
                "iteration": coordinator["iteration"],
                "max_iterations": coordinator["max_iterations"],
                "phase": coordinator["phase"],
                "session_id": supplied_session_id,
                "request_hash": request_hash,
                "immutable_context": immutable_context,
                "checkpoint_response": normalized_request.get("checkpoint_response"),
            }
        )
        self.status = (
            f"Loaded logical run {analysis_run_id}: "
            f"{len(document_refs)} document(s), {len(policy_refs)} policy version(s)"
        )
        return Message(
            text=_canonical(persisted_state),
            session_id=supplied_session_id,
        )
