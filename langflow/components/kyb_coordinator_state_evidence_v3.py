from __future__ import annotations

import hashlib
import json
import re
from urllib.parse import urlsplit

from sqlalchemy import create_engine, text

from lfx.custom import Component
from lfx.io import MessageTextInput, Output, SecretStrInput
from lfx.schema import Message
from lfx.services.deps import session_scope


SPECIALTIES = {"entity", "ownership", "policy", "public_research"}


def _canonical(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


def _payload(value: object) -> dict:
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
        raise ValueError("Coordinator state tool input must be one JSON object")
    return parsed


class KybCoordinatorStateEvidenceV3(Component):
    display_name = "3a · Coordinator State & Evidence Tools V3"
    description = (
        "Persists dynamic plans and task lineage, and provides read-only access to "
        "the analysis run's pinned evidence references."
    )
    icon = "database"
    name = "KybCoordinatorStateEvidenceV3"

    inputs = [
        MessageTextInput(
            name="input_value",
            display_name="State Operation",
            info=(
                "JSON operation: get_state, save_plan, prepare_specialist_task, "
                "list_evidence, or retrieve_evidence."
            ),
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
    outputs = [Output(display_name="State Result", name="result", method="run")]

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
    def _load_run(connection, job_id: str, *, lock: bool = False) -> dict:
        suffix = " FOR UPDATE" if lock else ""
        row = connection.execute(
            text(
                """
                SELECT id::text AS coordinator_run_id,
                       analysis_run_id::text, case_id::text, session_id, state,
                       engine_version, state_version, current_iteration, max_iterations
                FROM coordinator_v3_runs
                WHERE langflow_job_id = :job
                """ + suffix
            ),
            {"job": job_id},
        ).mappings().one_or_none()
        if row is None:
            raise ValueError("Persisted coordinator run context is unavailable")
        return dict(row)

    @staticmethod
    def _record_event(connection, run: dict, job_id: str, event_type: str, payload: dict) -> None:
        iteration = int(run["state"].get("iteration", 0))
        payload_hash = hashlib.sha256(_canonical(payload).encode()).hexdigest()
        requesting = payload.get("requesting_specialty")
        if requesting not in SPECIALTIES:
            requesting = None
        connection.execute(
            text(
                """
                INSERT INTO coordinator_v3_reconciliation_events(
                  analysis_run_id, case_id, langflow_job_id, iteration,
                  event_type, requesting_specialty, task_id, payload, payload_hash
                ) VALUES(
                  CAST(:run AS uuid), CAST(:case AS uuid), :job, :iteration,
                  :event, :requesting, :task, CAST(:payload AS jsonb), :hash
                )
                ON CONFLICT (langflow_job_id, event_type, payload_hash) DO NOTHING
                """
            ),
            {
                "run": run["analysis_run_id"],
                "case": run["case_id"],
                "job": job_id,
                "iteration": iteration,
                "event": event_type,
                "requesting": requesting,
                "task": payload.get("task_id"),
                "payload": _canonical(payload),
                "hash": payload_hash,
            },
        )

    @staticmethod
    def _validate_plan(plan: object) -> dict:
        if not isinstance(plan, dict):
            raise ValueError("plan must be an object")
        objective = str(plan.get("objective") or "").strip()
        selected = plan.get("selected_specialists")
        if not objective or not isinstance(selected, list):
            raise ValueError("plan requires objective and selected_specialists")
        normalized = []
        seen = set()
        for item in selected:
            if not isinstance(item, dict):
                raise ValueError("each selected specialist must be an object")
            specialty = str(item.get("specialty") or "").strip()
            reason = str(item.get("reason") or "").strip()
            task_objective = str(item.get("task_objective") or "").strip()
            if specialty not in SPECIALTIES or specialty in seen:
                raise ValueError("selected specialists must be unique supported specialties")
            if not reason or not task_objective:
                raise ValueError("each selected specialist requires reason and task_objective")
            seen.add(specialty)
            normalized.append(
                {
                    "specialty": specialty,
                    "reason": reason,
                    "task_objective": task_objective,
                    "required": bool(item.get("required", True)),
                    "status": "planned",
                }
            )
        if not normalized:
            raise ValueError("plan must select at least one specialist")
        return {
            "plan_version": str(plan.get("plan_version") or "1.0"),
            "objective": objective,
            "reasoning_summary": str(plan.get("reasoning_summary") or "").strip(),
            "status": "active",
            "selected_specialists": normalized,
        }

    def _save_plan(self, connection, run: dict, job_id: str, request: dict) -> dict:
        plan = self._validate_plan(request.get("plan"))
        state = dict(run["state"])
        if state.get("terminal"):
            raise ValueError("terminal coordinator state cannot accept a new plan")
        if run.get("engine_version") == "durable-loop-v1":
            raise ValueError("durable Coordinator Plans are committed only with a versioned Supervisor directive")
        existing = state.get("coordinator_plan") or {}
        existing_hash = hashlib.sha256(_canonical(existing).encode()).hexdigest()
        plan_hash = hashlib.sha256(_canonical(plan).encode()).hexdigest()
        if existing and existing.get("status") != "unplanned":
            if existing_hash == plan_hash:
                return {"status": "duplicate_suppressed", "coordinator_plan": existing}
            if any(
                item.get("status") not in {None, "planned"}
                for item in existing.get("selected_specialists", [])
                if isinstance(item, dict)
            ):
                raise ValueError("Coordinator Plan with started work cannot be overwritten")
        state["coordinator_plan"] = plan
        state.setdefault("activity", []).append(
            {
                "type": "coordinator.plan.updated",
                "status": "completed",
                "iteration": int(state.get("iteration", 0)),
                "selected_specialists": [item["specialty"] for item in plan["selected_specialists"]],
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
        run["state"] = state
        self._record_event(connection, run, job_id, "coordinator_plan_updated", plan)
        return {"status": "plan_persisted", "coordinator_plan": plan}

    def _prepare_task(self, connection, run: dict, job_id: str, request: dict) -> dict:
        specialty = str(request.get("specialty") or "").strip()
        if specialty not in SPECIALTIES:
            raise ValueError("specialty is unsupported")
        plan = run["state"].get("coordinator_plan") or {}
        planned = {
            item["specialty"]: item
            for item in plan.get("selected_specialists", [])
            if isinstance(item, dict) and item.get("specialty") in SPECIALTIES
        }
        if specialty not in planned:
            raise ValueError("specialist was not selected by the persisted Coordinator Plan")
        attempt = int(request.get("attempt", 1))
        if attempt < 1 or attempt > 3:
            raise ValueError("attempt must be between 1 and 3")
        parent_task_id = request.get("parent_task_id")
        if parent_task_id is not None:
            parent_task_id = str(parent_task_id).strip() or None
        requesting = str(request.get("requesting_specialty") or "coordinator").strip()
        if requesting in {"supervisor", "kyb_coordinator", "coordinator_supervisor"}:
            requesting = "coordinator"
        if requesting != "coordinator" and requesting not in SPECIALTIES:
            raise ValueError("requesting_specialty is invalid")

        task_hash = hashlib.sha256(
            _canonical(
                {
                    "coordinator_run_id": run["coordinator_run_id"],
                    "specialty": specialty,
                    "attempt": attempt,
                    "parent_task_id": parent_task_id,
                    "task_objective": planned[specialty]["task_objective"],
                }
            ).encode()
        ).hexdigest()[:20]
        task_id = f"coord:{run['coordinator_run_id']}:specialist:{specialty}:a{attempt}:{task_hash}"
        context_id = f"ctx:{run['coordinator_run_id']}:{specialty}"
        immutable_scope = dict(run["state"]["immutable_context"]["evidence_scope"])
        permitted_document_ids = sorted(
            str(item.get("document_id"))
            for item in immutable_scope.get("document_refs", [])
            if isinstance(item, dict) and item.get("document_id")
        )
        permitted_policy_version_ids = sorted(
            str(item.get("policy_version_id"))
            for item in immutable_scope.get("policy_refs", [])
            if isinstance(item, dict) and item.get("policy_version_id")
        )
        permitted_web_result_ids = []
        if specialty == "public_research":
            permitted_web_result_ids = sorted(
                str(value)
                for value in run["state"].get("accepted_web_result_ids", [])
                if value
            )
        evidence_scope = {
            "permitted_document_ids": permitted_document_ids,
            "permitted_policy_version_ids": permitted_policy_version_ids,
            "permitted_web_result_ids": permitted_web_result_ids,
        }
        envelope = {
            "schema_version": "3.0",
            "analysis_run_id": run["analysis_run_id"],
            "case_id": run["case_id"],
            "coordinator_run_id": run["coordinator_run_id"],
            "task_id": task_id,
            "context_id": context_id,
            "specialty": specialty,
            "requesting_specialty": requesting,
            "task_objective": planned[specialty]["task_objective"],
            "evidence_scope": evidence_scope,
            "allow_network": False,
            "attempt": attempt,
            "parent_task_id": parent_task_id,
        }
        existing_contribution = connection.execute(
            text(
                """
                SELECT payload
                FROM coordinator_v3_contributions
                WHERE task_id = :task
                """
            ),
            {"task": task_id},
        ).mappings().one_or_none()
        if existing_contribution is not None:
            return {
                "status": "duplicate_suppressed",
                "task": envelope,
                "validated_contribution": existing_contribution["payload"],
            }
        existing_event = connection.execute(
            text(
                """
                SELECT details
                FROM coordinator_v3_task_events
                WHERE langflow_job_id = :job AND task_id = :task AND event_type = 'dispatched'
                """
            ),
            {"job": job_id, "task": task_id},
        ).mappings().one_or_none()
        if existing_event is not None:
            if dict(existing_event["details"]) != envelope:
                raise ValueError("specialist task identity conflicts with persisted dispatch")
            return {"status": "duplicate_suppressed", "task": envelope}
        connection.execute(
            text(
                """
                INSERT INTO coordinator_v3_task_events(
                  analysis_run_id, langflow_job_id, specialty, task_id,
                  context_id, attempt, event_type, details
                ) VALUES(
                  CAST(:run AS uuid), :job, :specialty, :task,
                  :context, :attempt, 'dispatched', CAST(:details AS jsonb)
                )
                ON CONFLICT (langflow_job_id, task_id, event_type) DO NOTHING
                """
            ),
            {
                "run": run["analysis_run_id"],
                "job": job_id,
                "specialty": specialty,
                "task": task_id,
                "context": context_id,
                "attempt": attempt,
                "details": _canonical(envelope),
            },
        )
        state = dict(run["state"])
        for item in state["coordinator_plan"]["selected_specialists"]:
            if item["specialty"] == specialty:
                item["status"] = "running"
                item["task_id"] = task_id
                item["context_id"] = context_id
                item["attempt"] = attempt
        state.setdefault("activity", []).append(
            {
                "type": "agent.task.updated",
                "specialty": specialty,
                "status": "running",
                "task_id": task_id,
                "context_id": context_id,
                "attempt": attempt,
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
        run["state"] = state
        self._record_event(connection, run, job_id, "specialist_task_dispatched", envelope)
        return envelope

    @staticmethod
    def _evidence_refs(run: dict) -> dict:
        scope = run["state"]["immutable_context"]["evidence_scope"]
        return {
            "analysis_run_id": run["analysis_run_id"],
            "case_id": run["case_id"],
            "document_refs": scope.get("document_refs", []),
            "policy_refs": scope.get("policy_refs", []),
            "network_access": False,
            "source_records_mutable_by_agents": False,
        }

    @staticmethod
    def _retrieve_evidence(connection, run: dict, request: dict) -> dict:
        reference_ids = request.get("reference_ids")
        if not isinstance(reference_ids, list) or not reference_ids:
            raise ValueError("retrieve_evidence requires non-empty reference_ids")
        reference_ids = [str(value) for value in reference_ids]
        if len(reference_ids) > 10:
            raise ValueError("retrieve_evidence permits at most 10 references")
        rows = connection.execute(
            text(
                """
                SELECT 'case_document' AS source_kind, d.id::text AS source_id,
                       chunk.id::text AS chunk_id, chunk.section_locator AS locator,
                       chunk.content AS excerpt
                FROM analysis_run_documents snapshot
                JOIN case_documents d ON d.id = snapshot.document_id AND d.case_id = snapshot.case_id
                JOIN document_chunks chunk ON chunk.document_id = d.id AND chunk.case_id = snapshot.case_id
                WHERE snapshot.analysis_run_id = CAST(:run AS uuid)
                  AND (d.id::text = ANY(:ids) OR chunk.id::text = ANY(:ids))
                UNION ALL
                SELECT 'policy' AS source_kind, version.id::text AS source_id,
                       chunk.id::text AS chunk_id, chunk.section_locator AS locator,
                       chunk.content AS excerpt
                FROM analysis_run_policy_versions snapshot
                JOIN analysis_runs run ON run.id = snapshot.analysis_run_id
                JOIN policy_versions version ON version.id = snapshot.policy_version_id
                JOIN policy_chunks chunk ON chunk.policy_version_id = version.id
                WHERE snapshot.analysis_run_id = CAST(:run AS uuid)
                  AND (version.id::text = ANY(:ids) OR chunk.id::text = ANY(:ids))
                  AND ('*' = ANY(chunk.jurisdictions)
                    OR run.case_snapshot #>> '{applicant,jurisdiction}' = ANY(chunk.jurisdictions))
                  AND ('*' = ANY(chunk.products)
                    OR run.case_snapshot #>> '{applicant,product}' = ANY(chunk.products))
                  AND ('*' = ANY(chunk.business_types)
                    OR run.case_snapshot #>> '{applicant,business_type}' = ANY(chunk.business_types))
                ORDER BY source_kind, source_id, chunk_id
                LIMIT 10
                """
            ),
            {"run": run["analysis_run_id"], "ids": reference_ids},
        ).mappings()
        return {
            "analysis_run_id": run["analysis_run_id"],
            "results": [dict(row) for row in rows],
            "result_limit": 10,
        }

    async def run(self) -> Message:
        request = _payload(self.input_value)
        operation = str(request.get("operation") or "").strip()
        if operation not in {
            "get_state",
            "save_plan",
            "prepare_specialist_task",
            "list_evidence",
            "retrieve_evidence",
        }:
            raise ValueError("Unsupported state/evidence operation")

        job_id = self._job_id()
        engine = create_engine(await self._database_url())
        try:
            with engine.begin() as connection:
                run = self._load_run(
                    connection,
                    job_id,
                    lock=operation in {"save_plan", "prepare_specialist_task"},
                )
                supplied_run = request.get("analysis_run_id")
                if supplied_run and str(supplied_run) != run["analysis_run_id"]:
                    raise ValueError("cross-run state access rejected")
                if operation == "get_state":
                    result = run["state"]
                elif operation == "save_plan":
                    result = self._save_plan(connection, run, job_id, request)
                elif operation == "prepare_specialist_task":
                    result = self._prepare_task(connection, run, job_id, request)
                elif operation == "list_evidence":
                    result = self._evidence_refs(run)
                else:
                    result = self._retrieve_evidence(connection, run, request)
        finally:
            engine.dispose()

        self.status = f"Coordinator operation completed: {operation}"
        return Message(text=_canonical(result), session_id=run["session_id"])
