from __future__ import annotations

import hashlib
import json
import re
import uuid
from urllib.parse import urlsplit

from sqlalchemy import create_engine, text

from lfx.custom import Component
from lfx.io import MessageTextInput, Output, SecretStrInput
from lfx.schema import Message
from lfx.services.deps import session_scope


def _canonical(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


def _object(value: object) -> dict:
    if isinstance(value, Message):
        value = value.text
    if isinstance(value, dict):
        parsed = value
    else:
        raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", str(value or "").strip(), flags=re.I)
        parsed = json.loads(raw or "{}")
    if not isinstance(parsed, dict):
        raise ValueError("Approved action request must be one JSON object")
    return parsed


def _assert_pending_operation(run: dict, *, operation_key: str, proposal_hash: str) -> dict:
    if run.get("phase") != "running" or (run.get("state") or {}).get("status") != "running":
        raise ValueError("Approved Action Executor requires a running coordinator state")
    pending = (run.get("state") or {}).get("next_action")
    if not isinstance(pending, dict):
        raise ValueError("Approved Action Executor requires a persisted pending operation")
    route = pending.get("route") or pending.get("next_action")
    if route != "execute_action":
        raise ValueError("Approved Action Executor requires the persisted execute_action route")
    if pending.get("operation_key") != operation_key:
        raise ValueError("Approved action operation_key does not match persisted state")
    if pending.get("proposal_hash") != proposal_hash:
        raise ValueError("Approved action proposal_hash does not match persisted state")
    return pending


class KybApprovedActionExecutorV3(Component):
    display_name = "6 · Approved Action Executor V3"
    description = "Executes the exact persisted analyst-approved handoff once, then finalizes authoritative state."
    icon = "badge-check"
    name = "KybApprovedActionExecutorV3"
    inputs = [
        MessageTextInput(name="input_value", display_name="Approved Action Operation", required=True, tool_mode=True),
        SecretStrInput(name="database_url", display_name="Database URL", value="DATABASE_URL", required=True, advanced=True),
    ]
    outputs = [Output(display_name="Approved Action Result", name="result", method="run")]

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

    async def run(self) -> Message:
        request = _object(self.input_value)
        if request.get("operation") != "execute_approved_action":
            raise ValueError("Approved Action Executor supports only execute_approved_action")
        analysis_run_id = str(uuid.UUID(str(request.get("analysis_run_id") or "")))
        coordinator_run_id = str(uuid.UUID(str(request.get("coordinator_run_id") or "")))
        proposal_hash = str(request.get("proposal_hash") or "")
        operation_key = str(request.get("operation_key") or "").strip()
        if not re.fullmatch(r"[0-9a-f]{64}", proposal_hash) or not operation_key:
            raise ValueError("Exact proposal_hash and operation_key are required")

        engine = create_engine(await self._database_url())
        try:
            with engine.begin() as connection:
                run = connection.execute(text("""
                    SELECT id::text AS coordinator_run_id,analysis_run_id::text,case_id::text,
                           session_id,langflow_job_id,state,phase
                    FROM coordinator_v3_runs
                    WHERE id=CAST(:coordinator AS uuid)
                      AND analysis_run_id=CAST(:run AS uuid)
                      AND engine_version='durable-loop-v1'
                    FOR UPDATE
                """), {"coordinator":coordinator_run_id,"run":analysis_run_id}).mappings().one()
                _assert_pending_operation(dict(run), operation_key=operation_key, proposal_hash=proposal_hash)
                checkpoint = connection.execute(text("""
                    SELECT request_payload,status,decision,values
                    FROM coordinator_v3_checkpoints
                    WHERE analysis_run_id=CAST(:run AS uuid)
                      AND langflow_job_id=:logical_job
                      AND checkpoint_kind='analyst_approval'
                    ORDER BY decided_at DESC NULLS LAST,created_at DESC
                    LIMIT 1
                """), {"run":analysis_run_id,"logical_job":run["langflow_job_id"]}).mappings().one_or_none()
                if checkpoint is None or checkpoint["status"] != "approved" or checkpoint["decision"] != "approve":
                    raise ValueError("Exact persisted analyst approval is required")
                checkpoint_payload = dict(checkpoint["request_payload"]).get("payload") or {}
                proposal = checkpoint_payload.get("proposal")
                if not isinstance(proposal, dict) or proposal.get("action_type") != "mark_ready_for_review":
                    raise ValueError("Persisted approved proposal is invalid")
                actual_hash = hashlib.sha256(_canonical(proposal).encode()).hexdigest()
                if (actual_hash != proposal_hash
                        or checkpoint_payload.get("proposal_hash") != proposal_hash
                        or checkpoint_payload.get("operation_key") != operation_key
                        or (checkpoint["values"] or {}).get("proposal_hash") != proposal_hash):
                    raise ValueError("Approved action correlation drifted")

                action_key = f"coord-v3-action:{analysis_run_id}:{proposal_hash}"
                existing = connection.execute(text("""
                    SELECT proposed_action_id::text,approval_id::text,proposal_hash,status,result
                    FROM coordinator_v3_action_results
                    WHERE idempotency_key=:key
                """), {"key":action_key}).mappings().one_or_none()
                if existing is not None:
                    if existing["proposal_hash"] != proposal_hash:
                        raise ValueError("Persisted duplicate action proposal_hash drifted")
                    return Message(text=_canonical({
                        "status":"duplicate_suppressed",
                        "idempotency_key":action_key,
                        "persisted_action":existing["result"],
                    }), session_id=run["session_id"])

                latest = connection.execute(text("""
                    SELECT state,phase FROM coordinator_v3_runs
                    WHERE id=CAST(:coordinator AS uuid) FOR UPDATE
                """), {"coordinator":coordinator_run_id}).mappings().one()
                _assert_pending_operation(dict(latest), operation_key=operation_key, proposal_hash=proposal_hash)
                action_id = str(uuid.uuid5(uuid.NAMESPACE_URL, action_key + ":action"))
                review_id = str(uuid.uuid5(uuid.NAMESPACE_URL, action_key + ":review"))
                approval_id = str(uuid.uuid5(uuid.NAMESPACE_URL, action_key + ":approval"))
                persisted = {"case_state":"ready_for_review","recorded_by":"KYB Coordinator V3"}
                params = {
                    "action":action_id,"review":review_id,"approval":approval_id,
                    "run":analysis_run_id,"case":run["case_id"],"proposal":_canonical(proposal),
                    "summary":str(proposal.get("summary") or "Ready for analyst review"),
                    "key":action_key,"hash":proposal_hash,"result":_canonical(persisted),
                }
                connection.execute(text("""
                    INSERT INTO proposed_actions(
                      id,analysis_run_id,case_id,action_type,payload,status,
                      idempotency_key,execution_result,summary
                    ) VALUES(
                      CAST(:action AS uuid),CAST(:run AS uuid),CAST(:case AS uuid),
                      'mark_ready_for_review',CAST(:proposal AS jsonb),'executed',
                      :key,CAST(:result AS jsonb),:summary
                    )
                """), params)
                connection.execute(text("""
                    INSERT INTO review_requests(
                      id,proposed_action_id,analysis_run_id,case_id,correlation_id,status,decided_at
                    ) VALUES(
                      CAST(:review AS uuid),CAST(:action AS uuid),CAST(:run AS uuid),
                      CAST(:case AS uuid),:key,'decided',clock_timestamp()
                    )
                """), params)
                connection.execute(text("""
                    INSERT INTO approvals(
                      id,proposed_action_id,review_request_id,decision,decided_by,
                      rationale,decided_at,idempotency_key
                    ) VALUES(
                      CAST(:approval AS uuid),CAST(:action AS uuid),CAST(:review AS uuid),
                      'approved','coordinator-v3-analyst','Exact persisted analyst approval',
                      clock_timestamp(),:key
                    )
                """), params)
                connection.execute(text("""
                    INSERT INTO coordinator_v3_action_results(
                      analysis_run_id,case_id,proposed_action_id,idempotency_key,
                      proposal_hash,approval_id,status,result
                    ) VALUES(
                      CAST(:run AS uuid),CAST(:case AS uuid),CAST(:action AS uuid),:key,
                      :hash,CAST(:approval AS uuid),'executed',CAST(:result AS jsonb)
                    )
                """), params)
                result_status = "executed"
                latest = connection.execute(text("""
                    SELECT state,phase FROM coordinator_v3_runs
                    WHERE id=CAST(:coordinator AS uuid) FOR UPDATE
                """), {"coordinator":coordinator_run_id}).mappings().one()
                _assert_pending_operation(dict(latest), operation_key=operation_key, proposal_hash=proposal_hash)
                connection.execute(text("""
                    UPDATE coordinator_v3_runs
                    SET state_version=state_version+1,
                        state=state || jsonb_build_object(
                          'next_action',NULL,
                          'next_action_idempotency_key',NULL,
                          'approved_action_result',jsonb_build_object(
                            'idempotency_key',:key,
                            'proposal_hash',:hash,
                            'status',:status,
                            'result',CAST(:result AS jsonb)
                          ),
                          'updated_at',clock_timestamp()
                        ),updated_at=clock_timestamp()
                    WHERE id=CAST(:run AS uuid)
                """), {"run":coordinator_run_id, "key": action_key, "hash": proposal_hash,
                       "status": result_status, "result": _canonical(persisted)})
                ready = connection.execute(
                    text("SELECT mark_simple_coordinator_v3_ready(CAST(:run AS uuid),:key)"),
                    {"run":coordinator_run_id,"key":action_key+":ready"},
                ).scalar_one()
            self.status = "Executed exact approved handoff"
            return Message(text=_canonical({
                "status":result_status,"idempotency_key":action_key,
                "persisted_action_id":action_id,"approval_id":approval_id,
                "persisted_action":persisted,"final_state":ready,
            }), session_id=run["session_id"])
        finally:
            engine.dispose()
