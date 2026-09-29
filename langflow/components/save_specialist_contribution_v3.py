from __future__ import annotations

import json
import re
import uuid
from urllib.parse import urlsplit

from sqlalchemy import create_engine, text

from lfx.custom import Component
from lfx.io import MessageTextInput, Output, SecretStrInput
from lfx.schema import Message
from lfx.services.deps import session_scope


SPECIALTIES = {"entity", "ownership", "policy", "public_research"}
ROUTING_KINDS = {"human_input_request", "research_request", "failure"}
CONTRIBUTION_KINDS = {"specialist_contribution", "public_research_specialist_contribution"}
RESULT_CORRELATION_FIELDS = (
    "analysis_run_id",
    "task_id",
    "context_id",
    "specialty",
)


def _object(value: object, label: str) -> dict:
    if isinstance(value, Message):
        value = value.text
    if isinstance(value, dict):
        parsed = value
    else:
        raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", str(value or "").strip(), flags=re.I)
        try:
            parsed = json.loads(raw or "{}")
        except json.JSONDecodeError as exc:
            raise ValueError(f"{label} must be one JSON object") from exc
    if not isinstance(parsed, dict):
        raise ValueError(f"{label} must be one JSON object")
    return parsed


def _uuid(value: object, field: str) -> str:
    try:
        return str(uuid.UUID(str(value)))
    except (AttributeError, TypeError, ValueError) as exc:
        raise ValueError(f"{field} must be a valid UUID") from exc


def _required_text(value: object, field: str) -> str:
    result = str(value or "").strip()
    if not result:
        raise ValueError(f"{field} is required")
    return result


def _explicit_ids(scope: dict, field: str) -> set[str]:
    values = scope.get(field)
    if not isinstance(values, list) or any(not str(item).strip() for item in values):
        raise ValueError(f"{field} must be an explicit list")
    return {str(item).strip() for item in values}


def validate_envelope(envelope: object, coordinator_run_id: object) -> dict:
    value = _object(envelope, "envelope")
    required = {
        "schema_version", "analysis_run_id", "coordinator_run_id", "case_id",
        "task_id", "context_id", "specialty", "attempt", "parent_task_id", "evidence_scope",
    }
    missing = sorted(required.difference(value))
    if missing:
        raise ValueError(f"envelope missing: {', '.join(missing)}")
    if value["schema_version"] != "3.0":
        raise ValueError("envelope schema_version must be 3.0")
    normalized = dict(value)
    normalized["analysis_run_id"] = _uuid(value["analysis_run_id"], "analysis_run_id")
    normalized["coordinator_run_id"] = _uuid(value["coordinator_run_id"], "coordinator_run_id")
    if normalized["coordinator_run_id"] != _uuid(coordinator_run_id, "coordinator_run_id"):
        raise ValueError("envelope coordinator_run_id does not match request")
    normalized["case_id"] = _uuid(value["case_id"], "case_id")
    for field in ("task_id", "context_id"):
        normalized[field] = _required_text(value[field], field)
    if value["specialty"] not in SPECIALTIES:
        raise ValueError("envelope specialty is unsupported")
    normalized["specialty"] = value["specialty"]
    attempt = value["attempt"]
    if isinstance(attempt, bool) or not isinstance(attempt, int) or not 1 <= attempt <= 3:
        raise ValueError("attempt must be an integer between 1 and 3")
    normalized["attempt"] = attempt
    parent = value["parent_task_id"]
    if attempt == 1 and parent is not None:
        raise ValueError("attempt 1 must have a null parent_task_id")
    if attempt > 1 and not _required_text(parent, "parent_task_id"):
        raise ValueError("retry attempts require parent_task_id")
    normalized["parent_task_id"] = parent
    scope = _object(value["evidence_scope"], "evidence_scope")
    for field in ("permitted_document_ids", "permitted_policy_version_ids", "permitted_web_result_ids"):
        _explicit_ids(scope, field)
    normalized["evidence_scope"] = scope
    return normalized


def _citation_id(citation: dict, source_kind: str) -> str:
    candidates = {
        "case_document": ("source_id", "document_id", "document_chunk_id"),
        "policy": ("source_id", "policy_version_id", "policy_chunk_id"),
        "external_web": ("web_result_id", "immutable_result_id", "source_id"),
    }[source_kind]
    for field in candidates:
        if citation.get(field):
            return str(citation[field])
    raise ValueError(f"{source_kind} citation is missing its permitted source id")


def validate_contribution_scope(result: dict, envelope: dict) -> None:
    citations = result.get("citations")
    if citations is None and isinstance(result.get("payload"), dict):
        citations = result["payload"].get("citation_refs")
    if not isinstance(citations, list):
        raise ValueError("specialist contribution citations must be a list")
    scope = envelope["evidence_scope"]
    permitted = {
        "case_document": _explicit_ids(scope, "permitted_document_ids"),
        "policy": _explicit_ids(scope, "permitted_policy_version_ids"),
        "external_web": _explicit_ids(scope, "permitted_web_result_ids"),
    }
    for citation in citations:
        if not isinstance(citation, dict):
            raise ValueError("each citation must be an object")
        source_kind = str(citation.get("source_kind") or "")
        if source_kind not in permitted:
            raise ValueError("citation source_kind is unsupported")
        citation_id = _citation_id(citation, source_kind)
        if citation_id not in permitted[source_kind]:
            raise ValueError(f"{source_kind} citation is outside the permitted evidence scope")


def validate_result(result: object, envelope: dict) -> tuple[dict, str]:
    value = _object(result, "result")
    for field in RESULT_CORRELATION_FIELDS:
        if field not in value or value[field] != envelope[field]:
            raise ValueError(f"result {field} does not match the envelope")
    kind = str(value.get("result_type") or value.get("contribution_kind") or "").strip()
    if kind not in CONTRIBUTION_KINDS | ROUTING_KINDS:
        raise ValueError("result kind is unsupported")
    if kind in CONTRIBUTION_KINDS:
        validate_contribution_scope(value, envelope)
    return value, kind


def normalize_routing_result(envelope: dict, result: dict, kind: str) -> dict:
    return {
        "status": "routed",
        "persisted": False,
        "route": kind,
        "coordinator_run_id": envelope["coordinator_run_id"],
        "task_id": envelope["task_id"],
        "result": result,
    }


class SaveSpecialistContributionV3(Component):
    display_name = "save_specialist_contribution_v3"
    description = "Validate and persist one correlated specialist contribution for the durable coordinator."
    icon = "save"
    name = "save_specialist_contribution_v3"

    inputs = [
        MessageTextInput(
            name="input_value",
            display_name="Specialist Contribution",
            info="JSON with coordinator_run_id, envelope, and result.",
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
    outputs = [Output(display_name="Contribution Result", name="result", method="run")]

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
        async with session_scope() as session:
            value = await self.get_variable("DATABASE_URL", "value", session)
        if hasattr(value, "get_secret_value"):
            value = value.get_secret_value()
        value = str(value or "").strip().strip("\"'")
        if value.startswith("postgres://"):
            value = "postgresql://" + value[len("postgres://") :]
        if not value.startswith(schemes):
            scheme = urlsplit(value).scheme or "missing"
            raise ValueError(f"Server-side DATABASE_URL has unsupported scheme: {scheme}")
        return value

    async def run(self) -> Message:
        request = _object(self.input_value, "save specialist contribution request")
        coordinator_run_id = _uuid(request.get("coordinator_run_id"), "coordinator_run_id")
        envelope = validate_envelope(request.get("envelope"), coordinator_run_id)
        result, kind = validate_result(request.get("result"), envelope)
        if kind in ROUTING_KINDS:
            return Message(text=json.dumps(normalize_routing_result(envelope, result, kind), separators=(",", ":")))
        engine = create_engine(await self._database_url())
        try:
            with engine.begin() as connection:
                persisted_payload = {
                    **result,
                    "coordinator_run_id": envelope["coordinator_run_id"],
                    "case_id": envelope["case_id"],
                    "attempt": envelope["attempt"],
                    "parent_task_id": envelope["parent_task_id"],
                    "evidence_scope": envelope["evidence_scope"],
                }
                persisted = connection.execute(
                    text(
                        """
                        SELECT save_simple_coordinator_v3_contribution(
                          CAST(:run AS uuid), CAST(:payload AS jsonb), :attempt, :parent_task_id
                        )
                        """
                    ),
                    {
                        "run": coordinator_run_id,
                        "payload": json.dumps(persisted_payload, separators=(",", ":")),
                        "attempt": envelope["attempt"],
                        "parent_task_id": envelope["parent_task_id"],
                    },
                ).scalar_one()
        finally:
            engine.dispose()
        if isinstance(persisted, str):
            persisted = json.loads(persisted)
        return Message(text=json.dumps({"status": "accepted", "persisted": True, "result": persisted}, separators=(",", ":")))
