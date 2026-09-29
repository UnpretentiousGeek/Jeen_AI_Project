from __future__ import annotations

import json
import re
from urllib.parse import urlsplit

from sqlalchemy import create_engine, text

from lfx.custom import Component
from lfx.io import MessageTextInput, Output, SecretStrInput
from lfx.schema import Data, Message
from lfx.services.deps import session_scope


CHECKPOINT_ACTIONS = {
    "information_request": [("submit_clarification", "Submit Clarification"), ("reject", "Reject"), ("skip_for_now", "Skip for now")],
    "conflict_review": [("continue_without_evidence", "Continue Without Verification"), ("escalate", "Escalate"), ("reject", "Reject"), ("skip_for_now", "Skip for now")],
    "specialist_recovery": [("retry", "Retry"), ("abort", "Abort"), ("skip_for_now", "Skip for now")],
    "search_execution_approval": [("approve", "Approve"), ("changes_requested", "Request changes"), ("reject", "Reject"), ("skip_for_now", "Skip for now")],
    "web_result_review": [("accept", "Accept"), ("reject", "Reject"), ("skip_for_now", "Skip for now")],
    "analyst_approval": [("approve", "Approve"), ("changes_requested", "Request changes"), ("reject", "Reject"), ("skip_for_now", "Skip for now")],
}
POSITIVE_ACTIONS = {"submit_clarification", "escalate", "retry", "approve", "accept"}


def _canonical(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


def _object(value: object, label: str) -> dict:
    if isinstance(value, Message):
        value = value.text
    if isinstance(value, Data):
        value = value.data
        if isinstance(value, dict) and isinstance(value.get("data"), dict):
            value = value["data"]
    if isinstance(value, dict):
        parsed = value
    else:
        raw = str(value or "").strip()
        raw = re.sub(r"^```(?:json)?\s*", "", raw, flags=re.IGNORECASE)
        raw = re.sub(r"\s*```$", "", raw)
        parsed = json.loads(raw)
    if isinstance(parsed, dict) and isinstance(parsed.get("data"), dict):
        parsed = parsed["data"]
    if not isinstance(parsed, dict):
        raise ValueError(f"{label} must be one JSON object")
    return parsed


def route_human_decision(kind: str, action_id: str, values: dict, context: dict) -> dict:
    """Map one persisted human decision without consulting a language model."""
    if kind not in CHECKPOINT_ACTIONS:
        raise ValueError("checkpoint_kind is unsupported")
    allowed = {item[0] for item in CHECKPOINT_ACTIONS[kind]}
    if action_id not in allowed:
        raise ValueError("human checkpoint decision is not allowed")
    if not isinstance(values, dict) or not isinstance(context, dict):
        raise ValueError("human checkpoint values and context must be objects")

    if action_id == "skip_for_now":
        return {"route": "pending", "transition": False}

    if kind == "conflict_review" and action_id == "continue_without_evidence":
        # The search is settled with no evidence; the coordinator moves on and the gap stays open.
        return {"route": "continue_without_evidence"}

    if action_id == "changes_requested":
        if kind not in {"search_execution_approval", "analyst_approval"}:
            raise ValueError("changes_requested is unsupported for this checkpoint")
        requested_changes = values.get("requested_changes")
        if not isinstance(requested_changes, dict) or not requested_changes:
            raise ValueError("changes_requested requires a structured requested_changes payload")
        if kind == "search_execution_approval":
            scope = context.get("approved_scope")
            scope_hash = str(context.get("scope_hash") or "")
            if not isinstance(scope, dict) or not scope.get("evidence_gap_id") or not scope_hash:
                raise ValueError("search revision has no documented scope")
            return {
                "route": "request_revised_search",
                "evidence_gap_id": str(scope["evidence_gap_id"]),
                "original_scope_hash": scope_hash,
                "requested_changes": requested_changes,
            }
        # The coordinator reads the analyst's request and may draft bounded research;
        # re-issuing the same handoff would silently drop it.
        return {"route": "analyst_revision", "requested_changes": requested_changes}

    terminal = {
        ("conflict_review", "escalate"): "escalated",
        ("conflict_review", "reject"): "stopped",
        ("specialist_recovery", "abort"): "failed",
        ("web_result_review", "reject"): "stopped",
        ("analyst_approval", "reject"): "stopped",
        ("information_request", "reject"): "stopped",
    }
    if (kind, action_id) in terminal:
        return {"route": terminal[(kind, action_id)]}

    if kind == "search_execution_approval" and action_id == "reject":
        scope = context.get("approved_scope")
        if not isinstance(scope, dict) or not scope.get("evidence_gap_id"):
            raise ValueError("rejected search has no documented evidence gap")
        return {
            "route": "continue_without_search",
            "evidence_gap_id": str(scope["evidence_gap_id"]),
            "claim_id": str(scope.get("claim_id") or ""),
            "claim": str(scope.get("claim") or ""),
        }

    if kind == "information_request":
        if not values:
            raise ValueError("submit_clarification requires a non-empty response")
        return {"route": "resume_coordinator", "response_values": values}

    if kind == "specialist_recovery":
        specialty = str(context.get("specialty") or "")
        task_id = str(context.get("task_id") or "")
        attempt = int(context.get("attempt") or 0)
        if specialty not in {"entity", "ownership", "policy", "public_research"} or not task_id:
            raise ValueError("specialist retry context is incomplete")
        if attempt < 1 or attempt >= 3:
            raise ValueError("specialist retry budget exhausted")
        return {
            "route": "retry_specialist",
            "specialty": specialty,
            "attempt": attempt + 1,
            "parent_task_id": task_id,
            "response_values": values,
        }

    if kind == "search_execution_approval":
        expected_hash = str(context.get("scope_hash") or "")
        supplied_hash = str(values.get("scope_hash") or "")
        expected_operation_key = str(context.get("operation_key") or "")
        supplied_operation_key = str(values.get("operation_key") or "")
        if (
            not expected_hash
            or supplied_hash != expected_hash
            or not expected_operation_key
            or supplied_operation_key != expected_operation_key
        ):
            raise ValueError("approved search scope was altered")
        return {
            "route": "execute_search",
            "operation_key": expected_operation_key,
            "scope_hash": expected_hash,
        }

    if kind == "web_result_review":
        raw_pending = context.get("pending_web_result_ids") or context.get("pending_results") or context.get("results") or []
        pending = [
            str(value.get("web_result_id") or value.get("result_id") or "")
            if isinstance(value, dict) else str(value)
            for value in raw_pending
        ]
        decisions = values.get("result_decisions") or []
        if not pending or any(not result_id for result_id in pending) or not isinstance(decisions, list):
            raise ValueError("web result review context is incomplete")
        by_id: dict[str, dict] = {}
        for item in decisions:
            if not isinstance(item, dict):
                raise ValueError("each web result decision must be an object")
            web_result_id = item.get("web_result_id")
            result_id_alias = item.get("result_id")
            if web_result_id is not None and result_id_alias is not None and str(web_result_id) != str(result_id_alias):
                raise ValueError("web result decision identifiers disagree")
            result_id = str(web_result_id if web_result_id is not None else result_id_alias or "")
            decision = str(item.get("decision") or "")
            rationale = str(item.get("rationale") or "").strip()
            if not result_id or result_id in by_id or decision not in {"accept", "reject"} or not rationale:
                raise ValueError("web review requires exactly one decision and rationale per result")
            by_id[result_id] = {"decision": decision, "rationale": rationale}
        if set(by_id) != set(pending):
            raise ValueError("web review requires exactly one decision for every pending result")
        return {
            "route": "release_web_results",
            "accepted_web_result_ids": sorted(
                result_id for result_id, item in by_id.items() if item["decision"] == "accept"
            ),
            "rejected_web_result_ids": sorted(
                result_id for result_id, item in by_id.items() if item["decision"] == "reject"
            ),
            "result_decisions": [
                {"web_result_id": result_id, **by_id[result_id]}
                for result_id in sorted(by_id)
            ],
        }

    if kind == "analyst_approval":
        expected_hash = str(context.get("proposal_hash") or "")
        supplied_hash = str(values.get("proposal_hash") or "")
        expected_operation_key = str(context.get("operation_key") or "")
        supplied_operation_key = str(values.get("operation_key") or "")
        if (
            not expected_hash
            or supplied_hash != expected_hash
            or not expected_operation_key
            or supplied_operation_key != expected_operation_key
        ):
            raise ValueError("approved action was altered")
        return {
            "route": "execute_action",
            "operation_key": expected_operation_key,
            "proposal_hash": expected_hash,
        }

    raise ValueError("human checkpoint decision has no deterministic route")


class KybHumanCheckpointV3(Component):
    display_name = "Create Human Checkpoint V3"
    description = (
        "Persists or resolves one typed checkpoint for a logical analysis run. It returns "
        "normally; the UI resumes work by invoking the flow again with analysis_run_id."
    )
    icon = "user-check"
    name = "KybHumanCheckpointV3"

    inputs = [
        MessageTextInput(
            name="input_value",
            display_name="Checkpoint Operation",
            info="JSON operation: create_checkpoint or apply_decision.",
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
    outputs = [Output(display_name="Checkpoint Result", name="result", method="run")]

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
            value = "postgresql://" + value[len("postgres://") :]
        if value.startswith("postgresql+asyncpg://"):
            value = "postgresql+psycopg2://" + value[len("postgresql+asyncpg://") :]
        if value.startswith("postgresql+psycopg://"):
            value = "postgresql+psycopg2://" + value[len("postgresql+psycopg://") :]
        if not value.startswith(("postgresql://", "postgresql+psycopg2://")):
            scheme = urlsplit(value).scheme or "missing"
            raise ValueError(f"Server-side DATABASE_URL has unsupported scheme: {scheme}")
        return value

    async def run(self) -> Message:
        request = _object(self.input_value, "checkpoint operation")
        operation = str(request.get("operation") or "").strip()
        if operation not in {"create_checkpoint", "apply_decision"}:
            raise ValueError("Unsupported checkpoint operation")
        engine = create_engine(await self._database_url())
        try:
            with engine.begin() as connection:
                if operation == "create_checkpoint":
                    checkpoint_request = request.get("request")
                    if not isinstance(checkpoint_request, dict):
                        raise ValueError("create_checkpoint requires one typed request object")
                    result = connection.execute(
                        text(
                            "SELECT create_simple_coordinator_v3_checkpoint("
                            "CAST(:run AS uuid), CAST(:request AS jsonb), :key)"
                        ),
                        {
                            "run": str(request.get("coordinator_run_id") or ""),
                            "request": _canonical(checkpoint_request),
                            "key": str(request.get("idempotency_key") or ""),
                        },
                    ).scalar_one()
                    self.status = "Stored human checkpoint"
                    return Message(text=_canonical(result))

                analysis_run_id = str(request.get("analysis_run_id") or "")
                request_id = str(request.get("request_id") or "")
                action_id = str(request.get("action_id") or "")
                values = request.get("values") or {}
                checkpoint = connection.execute(
                    text(
                        """
                        SELECT checkpoint.id::text AS checkpoint_id,
                               checkpoint.request_payload,
                               coordinator.id::text AS coordinator_run_id
                        FROM coordinator_v3_checkpoints checkpoint
                        JOIN coordinator_v3_runs coordinator
                          ON coordinator.analysis_run_id = checkpoint.analysis_run_id
                         AND coordinator.langflow_job_id = checkpoint.langflow_job_id
                         AND coordinator.engine_version = 'durable-loop-v1'
                        WHERE checkpoint.analysis_run_id = CAST(:run AS uuid)
                          AND checkpoint.request_id = :request
                        """
                    ),
                    {"run": analysis_run_id, "request": request_id},
                ).mappings().one_or_none()
                if checkpoint is None:
                    raise ValueError("Persisted checkpoint is unavailable")
                persisted = dict(checkpoint["request_payload"])
                expected_state_version = persisted.get("expected_state_version")
                try:
                    if isinstance(expected_state_version, bool):
                        raise ValueError
                    expected_state_version = int(expected_state_version)
                except (TypeError, ValueError) as exc:
                    raise ValueError("Persisted checkpoint expected_state_version is invalid") from exc
                submitted_state_version = request.get("expected_state_version")
                if submitted_state_version is None and isinstance(values, dict):
                    submitted_state_version = values.get("expected_state_version")
                if submitted_state_version is not None:
                    try:
                        if isinstance(submitted_state_version, bool):
                            raise ValueError
                        submitted_state_version = int(submitted_state_version)
                    except (TypeError, ValueError) as exc:
                        raise ValueError("expected_state_version must be an integer") from exc
                    if submitted_state_version != expected_state_version:
                        raise ValueError("checkpoint expected_state_version does not match persistence")
                result = connection.execute(
                    text(
                        "SELECT apply_simple_coordinator_v3_checkpoint_decision("
                        "p_analysis_run_id => CAST(:run AS uuid), "
                        "p_request_id => :request, "
                        "p_expected_state_version => CAST(:expected_state_version AS bigint), "
                        "p_action => :action, p_values => CAST(:values AS jsonb), "
                        "p_actor_id => :actor, p_idempotency_key => :key)"
                    ),
                    {
                        "run": analysis_run_id,
                        "request": request_id,
                        "expected_state_version": expected_state_version,
                        "action": action_id,
                        "values": _canonical(values),
                        "actor": str(request.get("actor_id") or ""),
                        "key": str(request.get("idempotency_key") or ""),
                    },
                ).scalar_one()
                if isinstance(result, str):
                    result = json.loads(result)
                if not isinstance(result, dict):
                    raise ValueError("Checkpoint decision function returned an invalid result")
                if result.get("status") != "applied":
                    self.status = f"Checkpoint decision {action_id} was already handled"
                    return Message(text=_canonical(result))
                kind = str(persisted.get("checkpoint_kind") or persisted.get("kind") or "")
                payload = persisted.get("payload") if isinstance(persisted.get("payload"), dict) else {}
                context = {**persisted, **payload}
                route = route_human_decision(kind, action_id, values, context)
                coordinator_run_id = str(checkpoint["coordinator_run_id"])
                route_name = route.get("route")
                continuation = None
                if route_name in {"retry_specialist", "execute_search", "execute_action", "analyst_revision"}:
                    continuation = connection.execute(
                        text(
                            "SELECT set_simple_coordinator_v3_next_action("
                            "CAST(:run AS uuid), :request, CAST(:next_action AS jsonb), :key)"
                        ),
                        {
                            "run": coordinator_run_id,
                            "request": request_id,
                            "next_action": _canonical(route),
                            "key": str(request.get("idempotency_key") or "") + ":route",
                        },
                    ).scalar_one()
                elif route_name == "release_web_results":
                    for decision in route["result_decisions"]:
                        connection.execute(
                            text(
                                "SELECT review_coordinator_v3_web_result("
                                "CAST(:result AS uuid), CAST(:run AS uuid), :status, :reviewer, :rationale)"
                            ),
                            {
                                "result": decision["web_result_id"],
                                "run": analysis_run_id,
                                "status": "accepted" if decision["decision"] == "accept" else "rejected",
                                "reviewer": str(request.get("actor_id") or ""),
                                "rationale": decision["rationale"],
                            },
                        )
                    # Public Research may only analyze a review that is closed as a whole.
                    connection.execute(
                        text(
                            "SELECT complete_coordinator_v3_web_result_review("
                            "CAST(:run AS uuid), CAST(:results AS jsonb), :reviewer, :key)"
                        ),
                        {
                            "run": analysis_run_id,
                            "results": _canonical([item["web_result_id"] for item in route["result_decisions"]]),
                            "reviewer": str(request.get("actor_id") or ""),
                            "key": str(request.get("idempotency_key") or "") + ":review-complete",
                        },
                    )
                    connection.execute(
                        text(
                            """
                            UPDATE coordinator_v3_runs
                            SET state_version = state_version + 1,
                                state = state || jsonb_build_object(
                                  'accepted_evidence_ids', CAST(:accepted AS jsonb),
                                  'next_action', NULL,
                                  'next_action_idempotency_key', NULL,
                                  'updated_at', clock_timestamp()
                                ),
                                updated_at = clock_timestamp()
                            WHERE id = CAST(:run AS uuid)
                            """
                        ),
                        {"run": coordinator_run_id, "accepted": _canonical(route["accepted_web_result_ids"])},
                    )
                elif route_name == "continue_without_search":
                    continuation = {"status": "continued_without_search", "evidence_gap_id": route["evidence_gap_id"]}
                elif route_name == "request_revised_search":
                    continuation = {"status": "revision_requested", "evidence_gap_id": route["evidence_gap_id"]}
                elif route_name in {"stopped", "failed", "escalated"}:
                    continuation = connection.execute(
                        text(
                            "SELECT stop_simple_coordinator_v3("
                            "CAST(:run AS uuid), :reason, :key)"
                        ),
                        {
                            "run": coordinator_run_id,
                            "reason": f"Human checkpoint {request_id} resolved as {route_name}",
                            "key": str(request.get("idempotency_key") or "") + ":terminal",
                        },
                    ).scalar_one()
                response = {**result, "route_result": route, "continuation": continuation}
                self.status = f"Recorded checkpoint decision: {action_id}"
                return Message(text=_canonical(response))
        finally:
            engine.dispose()
