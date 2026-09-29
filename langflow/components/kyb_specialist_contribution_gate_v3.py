from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from urllib.parse import urlsplit

from sqlalchemy import create_engine, text

from lfx.custom import Component
from lfx.io import MessageTextInput, Output, SecretStrInput
from lfx.schema import Message
from lfx.services.deps import session_scope


AGENTS = {
    "entity": {"name": "kyb-entity-agent", "version": "3.1.0"},
    "ownership": {"name": "kyb-ownership-agent", "version": "3.1.0"},
    "policy": {"name": "kyb-policy-agent", "version": "3.2.0"},
    "public_research": {"name": "kyb-public-research-agent", "version": "3.3.0"},
}


def _canonical(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


def _object(value: object, label: str) -> dict:
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
        raise ValueError(f"{label} must be one JSON object")
    return parsed


class KybSpecialistContributionGateV3(Component):
    display_name = "3b · Specialist Contribution Gate V3"
    description = (
        "Validates specialist identity, task lineage, immutable source scope, and exact "
        "citation locators before persisting a contribution."
    )
    icon = "shield-check"
    name = "KybSpecialistContributionGateV3"

    inputs = [
        MessageTextInput(
            name="input_value",
            display_name="Contribution Validation Request",
            info="JSON with envelope and the raw specialist contribution.",
            required=True,
            tool_mode=True,
        ),
        SecretStrInput(
            name="database_url",
            display_name="Database URL",
            value="DATABASE_URL",
            required=True,
            advanced=True,
        ),
    ]
    outputs = [Output(display_name="Validated Contribution", name="result", method="validate")]

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
        schemes = ("postgresql://", "postgresql+psycopg://", "postgresql+psycopg2://")
        if value.startswith(schemes):
            return value
        # Secret inputs can arrive as opaque Langflow reference IDs at runtime.
        # Resolve the stable server-side variable whenever the field is not a URL.
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
        if not value.startswith(schemes):
            scheme = urlsplit(value).scheme or "missing"
            raise ValueError(f"Server-side DATABASE_URL has unsupported scheme: {scheme}")
        return value

    def _job_id(self) -> str:
        job_id = str(getattr(self.graph, "run_id", "") or "").strip()
        if not job_id:
            raise ValueError("Langflow job identity is unavailable")
        return job_id

    @staticmethod
    def _citation_catalog(connection, analysis_run_id: str) -> dict:
        rows = connection.execute(
            text(
                """
                SELECT 'case_document' AS source_kind, document.id::text AS source_id,
                       chunk.id::text AS chunk_id, chunk.section_locator AS locator,
                       chunk.content AS excerpt
                FROM analysis_run_documents snapshot
                JOIN case_documents document
                  ON document.id = snapshot.document_id AND document.case_id = snapshot.case_id
                JOIN document_chunks chunk
                  ON chunk.document_id = document.id AND chunk.case_id = snapshot.case_id
                WHERE snapshot.analysis_run_id = CAST(:run AS uuid)
                UNION ALL
                SELECT 'policy' AS source_kind, version.id::text AS source_id,
                       chunk.id::text AS chunk_id, chunk.section_locator AS locator,
                       chunk.content AS excerpt
                FROM analysis_run_policy_versions snapshot
                JOIN policy_versions version ON version.id = snapshot.policy_version_id
                JOIN policy_chunks chunk ON chunk.policy_version_id = version.id
                WHERE snapshot.analysis_run_id = CAST(:run AS uuid)
                """
            ),
            {"run": analysis_run_id},
        ).mappings()
        return {
            (row["source_kind"], row["source_id"], row["chunk_id"]): dict(row)
            for row in rows
        }

    @staticmethod
    def _validate_citations(contribution: dict, catalog: dict) -> None:
        citations = contribution.get("citations")
        if not isinstance(citations, list):
            raise ValueError("citations must be a list")
        seen = set()
        for citation in citations:
            if not isinstance(citation, dict):
                raise ValueError("each citation must be an object")
            citation_id = str(citation.get("id") or "")
            if not citation_id or citation_id in seen:
                raise ValueError("citation ids must be unique and non-empty")
            seen.add(citation_id)
            key = (
                str(citation.get("source_kind") or ""),
                str(citation.get("source_id") or ""),
                str(citation.get("chunk_id") or ""),
            )
            expected = catalog.get(key)
            if expected is None:
                raise ValueError(f"citation {citation_id} is outside the pinned run scope")
            if citation.get("locator") != expected["locator"]:
                raise ValueError(f"citation {citation_id} locator was altered")
            if citation.get("excerpt") != expected["excerpt"]:
                raise ValueError(f"citation {citation_id} excerpt was altered")

    @staticmethod
    def _validate_public_citations(
        connection,
        contribution: dict,
        analysis_run_id: str,
        permitted_result_ids: set[str],
    ) -> None:
        citations = contribution.get("citations")
        if not isinstance(citations, list):
            raise ValueError("citations must be a list")
        for citation in citations:
            if citation.get("source_kind") != "external_web":
                raise ValueError("Public Research may cite only accepted external web evidence")
            result_id = str(
                citation.get("immutable_result_id") or citation.get("web_result_id") or ""
            )
            if result_id not in permitted_result_ids:
                raise ValueError("Public Research citation is outside the dispatched accepted-result scope")
            row = connection.execute(
                text(
                    """
                    SELECT evidence.id::text AS immutable_result_id, evidence.url,
                           evidence.canonical_url, evidence.title, evidence.publisher,
                           evidence.retrieved_at, evidence.excerpt, evidence.content_hash,
                           evidence.retrieval_method, evidence.search_execution_id::text,
                           review.id::text AS result_review_id, item.review_state
                    FROM external_web_evidence evidence
                    JOIN web_result_review_items item
                      ON item.external_web_evidence_id = evidence.id
                     AND item.search_execution_id = evidence.search_execution_id
                     AND item.content_hash = evidence.content_hash
                    JOIN web_result_reviews review ON review.id = item.review_id
                    WHERE evidence.id = CAST(:evidence AS uuid)
                      AND evidence.analysis_run_id = CAST(:run AS uuid)
                      AND review.status = 'decided'
                      AND item.review_state = 'accepted'
                    """
                ),
                {"evidence": result_id, "run": analysis_run_id},
            ).mappings().one_or_none()
            if row is None:
                raise ValueError("Public Research citation is not an accepted immutable result")
            for field in (
                "immutable_result_id", "url", "canonical_url", "title", "publisher",
                "retrieved_at", "excerpt", "content_hash", "retrieval_method", "search_execution_id",
                "result_review_id", "review_state",
            ):
                expected = row[field]
                if field == "retrieved_at":
                    expected = expected.isoformat().replace("+00:00", "Z")
                if citation.get(field) != expected:
                    raise ValueError(f"Public Research citation {field} was altered")

    async def validate(self) -> Message:
        request = _object(self.input_value, "validation request")
        supplied_envelope = _object(request.get("envelope"), "task envelope")
        contribution = _object(request.get("contribution"), "specialist contribution")
        specialty = str(supplied_envelope.get("specialty") or "")
        if specialty not in AGENTS:
            raise ValueError("task envelope specialty is unsupported")

        required = {
            "contract_version",
            "contribution_kind",
            "contribution_id",
            "analysis_run_id",
            "task_id",
            "context_id",
            "specialist",
            "specialty",
            "status",
            "citations",
            "deterministic_validation",
        }
        missing = sorted(required.difference(contribution))
        if missing:
            raise ValueError(f"specialist contribution missing: {', '.join(missing)}")
        expected_kind = (
            "public_research_specialist_contribution"
            if specialty == "public_research"
            else "specialist_contribution"
        )
        if contribution["contribution_kind"] != expected_kind:
            raise ValueError("unsupported contribution kind")
        for field in ("analysis_run_id", "task_id", "context_id", "specialty"):
            if contribution.get(field) != supplied_envelope.get(field):
                raise ValueError(f"specialist {field} does not match its task envelope")
        if contribution["specialist"] != AGENTS[specialty]:
            raise ValueError("specialist identity or version mismatch")
        expected_id = (
            f"public-research-{supplied_envelope['task_id']}"
            if specialty == "public_research"
            else f"{specialty}-{supplied_envelope['task_id']}"
        )
        if contribution["contribution_id"] != expected_id:
            raise ValueError("contribution_id is not task-derived")
        allowed_statuses = {"completed", "partial", "failed"}
        if specialty == "public_research":
            allowed_statuses.add("proposal_ready")
        if contribution["status"] not in allowed_statuses:
            raise ValueError("specialist contribution status is invalid")
        validation = contribution["deterministic_validation"]
        if not isinstance(validation, dict) or validation.get("outcome") != "accepted":
            raise ValueError("specialist deterministic validation is absent or rejected")

        job_id = self._job_id()
        engine = create_engine(await self._database_url())
        now = datetime.now(timezone.utc)
        try:
            with engine.begin() as connection:
                run = connection.execute(
                    text(
                        """
                        SELECT analysis_run_id::text, case_id::text, session_id, state
                        FROM coordinator_v3_runs
                        WHERE langflow_job_id = :job
                        FOR UPDATE
                        """
                    ),
                    {"job": job_id},
                ).mappings().one_or_none()
                if run is None:
                    raise ValueError("Persisted coordinator run context is unavailable")
                run = dict(run)
                if supplied_envelope.get("analysis_run_id") != run["analysis_run_id"]:
                    raise ValueError("cross-run specialist contribution rejected")
                if supplied_envelope.get("case_id") != run["case_id"]:
                    raise ValueError("cross-case specialist contribution rejected")
                attempt = int(supplied_envelope.get("attempt", 0))
                dispatched = connection.execute(
                    text(
                        """
                        SELECT occurred_at, details
                        FROM coordinator_v3_task_events
                        WHERE langflow_job_id = :job
                          AND specialty = :specialty
                          AND task_id = :task
                          AND context_id = :context
                          AND attempt = :attempt
                          AND event_type = 'dispatched'
                        """
                    ),
                    {
                        "job": job_id,
                        "specialty": specialty,
                        "task": supplied_envelope["task_id"],
                        "context": supplied_envelope["context_id"],
                        "attempt": attempt,
                    },
                ).mappings().one_or_none()
                if dispatched is None:
                    raise ValueError("specialist task lineage was not dispatched")
                envelope = dict(dispatched["details"])
                for field in (
                    "analysis_run_id",
                    "case_id",
                    "task_id",
                    "context_id",
                    "specialty",
                    "attempt",
                    "parent_task_id",
                    "requesting_specialty",
                ):
                    if supplied_envelope.get(field) != envelope.get(field):
                        raise ValueError(f"specialist task lineage field was altered: {field}")
                for field in ("analysis_run_id", "task_id", "context_id", "specialty"):
                    if contribution.get(field) != envelope.get(field):
                        raise ValueError(f"specialist {field} does not match persisted task lineage")

                if specialty == "public_research":
                    permitted_result_ids = {
                        str(value)
                        for value in (envelope.get("evidence_scope") or {}).get(
                            "permitted_web_result_ids", []
                        )
                    }
                    if not permitted_result_ids:
                        raise ValueError("Public Research task has no accepted web-result authorization")
                    self._validate_public_citations(
                        connection,
                        contribution,
                        run["analysis_run_id"],
                        permitted_result_ids,
                    )
                else:
                    self._validate_citations(
                        contribution,
                        self._citation_catalog(connection, run["analysis_run_id"]),
                    )
                persisted_status = "partial" if contribution["status"] == "proposal_ready" else contribution["status"]
                payload_hash = hashlib.sha256(_canonical(contribution).encode()).hexdigest()
                existing = connection.execute(
                    text(
                        """
                        SELECT payload_hash, payload
                        FROM coordinator_v3_contributions
                        WHERE task_id = :task
                        """
                    ),
                    {"task": envelope["task_id"]},
                ).mappings().one_or_none()
                if existing is not None:
                    if existing["payload_hash"] != payload_hash:
                        raise ValueError("same specialist task returned different immutable payload")
                    result = {
                        "status": "duplicate_suppressed",
                        "validated_contribution": existing["payload"],
                        "coordinator_state": run["state"],
                    }
                    return Message(text=_canonical(result), session_id=run["session_id"])

                connection.execute(
                    text(
                        """
                        INSERT INTO coordinator_v3_contributions(
                          analysis_run_id, case_id, langflow_job_id, specialty,
                          task_id, context_id, agent_name, agent_version, status,
                          source_scope, citations, payload, payload_hash,
                          started_at, completed_at, attempt
                        ) VALUES(
                          CAST(:run AS uuid), CAST(:case AS uuid), :job, :specialty,
                          :task, :context, :agent, :version, :status,
                          CAST(:scope AS jsonb), CAST(:citations AS jsonb),
                          CAST(:payload AS jsonb), :hash, :started, :completed, :attempt
                        )
                        """
                    ),
                    {
                        "run": run["analysis_run_id"],
                        "case": run["case_id"],
                        "job": job_id,
                        "specialty": specialty,
                        "task": envelope["task_id"],
                        "context": envelope["context_id"],
                        "agent": contribution["specialist"]["name"],
                        "version": contribution["specialist"]["version"],
                        "status": persisted_status,
                        "scope": _canonical(envelope["evidence_scope"]),
                        "citations": _canonical(contribution["citations"]),
                        "payload": _canonical(contribution),
                        "hash": payload_hash,
                        "started": dispatched["occurred_at"],
                        "completed": now,
                        "attempt": attempt,
                    },
                )
                for event_type in ("completed", "validated"):
                    connection.execute(
                        text(
                            """
                            INSERT INTO coordinator_v3_task_events(
                              analysis_run_id, langflow_job_id, specialty, task_id,
                              context_id, attempt, event_type, details
                            ) VALUES(
                              CAST(:run AS uuid), :job, :specialty, :task,
                              :context, :attempt, :event, CAST(:details AS jsonb)
                            )
                            ON CONFLICT (langflow_job_id, task_id, event_type) DO NOTHING
                            """
                        ),
                        {
                            "run": run["analysis_run_id"],
                            "job": job_id,
                            "specialty": specialty,
                            "task": envelope["task_id"],
                            "context": envelope["context_id"],
                            "attempt": attempt,
                            "event": event_type,
                            "details": _canonical(
                                {"contribution_id": contribution["contribution_id"], "payload_hash": payload_hash}
                            ),
                        },
                    )

                state = dict(run["state"])
                iteration = int(state.get("iteration", 0)) + 1
                if iteration > int(state.get("max_iterations", 12)):
                    raise ValueError("coordinator iteration budget exhausted")
                state["iteration"] = iteration
                state.setdefault("specialist_contributions", {})[specialty] = {
                    "contribution_id": contribution["contribution_id"],
                    "task_id": envelope["task_id"],
                    "context_id": envelope["context_id"],
                    "status": persisted_status,
                    "attempt": attempt,
                    "payload_hash": payload_hash,
                    "citation_ids": [citation["id"] for citation in contribution["citations"]],
                    "validated_at": now.isoformat(),
                }
                for item in state["coordinator_plan"]["selected_specialists"]:
                    if item["specialty"] == specialty:
                        item["status"] = "completed" if persisted_status == "completed" else persisted_status
                state.setdefault("activity", []).append(
                    {
                        "type": "agent.artifact.available",
                        "specialty": specialty,
                        "status": "validated",
                        "task_id": envelope["task_id"],
                        "context_id": envelope["context_id"],
                        "attempt": attempt,
                        "contribution_id": contribution["contribution_id"],
                    }
                )
                connection.execute(
                    text(
                        """
                        UPDATE coordinator_v3_runs
                        SET state = CAST(:state AS jsonb), updated_at = clock_timestamp()
                        WHERE langflow_job_id = :job
                        """
                    ),
                    {"state": _canonical(state), "job": job_id},
                )
                event_payload = {
                    "specialty": specialty,
                    "task_id": envelope["task_id"],
                    "context_id": envelope["context_id"],
                    "attempt": attempt,
                    "payload_hash": payload_hash,
                    "status": persisted_status,
                }
                event_hash = hashlib.sha256(_canonical(event_payload).encode()).hexdigest()
                connection.execute(
                    text(
                        """
                        INSERT INTO coordinator_v3_reconciliation_events(
                          analysis_run_id, case_id, langflow_job_id, iteration,
                          event_type, requesting_specialty, task_id, payload, payload_hash
                        ) VALUES(
                          CAST(:run AS uuid), CAST(:case AS uuid), :job, :iteration,
                          'specialist_contribution_validated', :requesting, :task,
                          CAST(:payload AS jsonb), :hash
                        )
                        ON CONFLICT (langflow_job_id, event_type, payload_hash) DO NOTHING
                        """
                    ),
                    {
                        "run": run["analysis_run_id"],
                        "case": run["case_id"],
                        "job": job_id,
                        "iteration": iteration,
                        "requesting": envelope.get("requesting_specialty")
                        if envelope.get("requesting_specialty") != "coordinator"
                        else None,
                        "task": envelope["task_id"],
                        "payload": _canonical(event_payload),
                        "hash": event_hash,
                    },
                )
        finally:
            engine.dispose()

        result = {
            "status": "accepted",
            "validated_contribution": contribution,
            "coordinator_state": state,
            "instruction": "Return control to the Coordinator Supervisor and reevaluate the persisted plan.",
        }
        self.status = f"Accepted and persisted {specialty} contribution {contribution['contribution_id']}"
        return Message(text=_canonical(result), session_id=run["session_id"])
