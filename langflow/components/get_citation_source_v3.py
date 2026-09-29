from __future__ import annotations

import json
import re
import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import create_engine, text

from lfx.custom import Component
from lfx.io import MessageTextInput, Output, SecretStrInput
from lfx.schema import Message
from lfx.services.deps import session_scope


SOURCE_KINDS = {"case_document", "policy", "human_input", "external_web"}
MAX_SOURCES = 25


def _request(value: object) -> dict:
    if isinstance(value, Message):
        value = value.text
    if isinstance(value, dict):
        parsed = value
    else:
        raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", str(value or "").strip(), flags=re.I)
        parsed = json.loads(raw or "{}")
    if not isinstance(parsed, dict):
        raise ValueError("Get Citation Source request must be one JSON object")
    return parsed


def _uuid(value: object, field: str) -> str:
    try:
        return str(uuid.UUID(str(value)))
    except (AttributeError, TypeError, ValueError) as exc:
        raise ValueError(f"{field} must be a valid UUID") from exc


def _ids(value: object, field: str) -> list[str]:
    if not isinstance(value, list) or not value:
        raise ValueError(f"{field} must be a non-empty explicit list")
    values = [_uuid(item, field) for item in value]
    if len(values) > MAX_SOURCES:
        raise ValueError(f"{field} cannot contain more than {MAX_SOURCES} IDs")
    if len(set(values)) != len(values):
        raise ValueError(f"{field} must not contain duplicates")
    return values


def _json_value(value: object) -> object:
    if isinstance(value, (datetime, date)):
        return value.isoformat().replace("+00:00", "Z")
    if isinstance(value, (uuid.UUID, Decimal)):
        return str(value)
    return value


def _row(value) -> dict | None:
    if value is None:
        return None
    return {key: _json_value(item) for key, item in dict(value).items()}


class GetCitationSourceV3(Component):
    display_name = "Get Citation Source V3"
    description = "Resolves one exact citation source only within an explicit run-scoped permission set."
    icon = "quote"
    name = "GetCitationSourceV3"

    inputs = [
        MessageTextInput(
            name="input_value",
            display_name="Citation Source Request",
            info=(
                "JSON with analysis_run_id, case_id, source_kind, source_id, "
                "permitted_source_ids, and chunk_id for case_document or policy."
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
    outputs = [Output(display_name="Citation Source", name="result", method="run")]

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
        if not value.startswith(("postgresql://", "postgresql+psycopg2://")):
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
            raise ValueError("Global DATABASE_URL is not a valid PostgreSQL SQLAlchemy URL")
        return value

    @staticmethod
    def _validate(value: object) -> dict:
        request = _request(value)
        source_kind = str(request.get("source_kind") or "").strip()
        if source_kind not in SOURCE_KINDS:
            raise ValueError("source_kind must be case_document, policy, human_input, or external_web")
        source_id = _uuid(request.get("source_id"), "source_id")
        permitted_ids = _ids(request.get("permitted_source_ids"), "permitted_source_ids")
        if source_id not in permitted_ids:
            raise ValueError("source_id must appear in permitted_source_ids")
        chunk_id = request.get("chunk_id")
        if source_kind in {"case_document", "policy"}:
            chunk_id = _uuid(chunk_id, "chunk_id")
        elif chunk_id is not None:
            raise ValueError("chunk_id is supported only for case_document or policy")
        return {
            "analysis_run_id": _uuid(request.get("analysis_run_id"), "analysis_run_id"),
            "case_id": _uuid(request.get("case_id"), "case_id"),
            "source_kind": source_kind,
            "source_id": source_id,
            "permitted_source_ids": permitted_ids,
            "chunk_id": chunk_id,
        }

    @staticmethod
    def _case_document(connection, request: dict) -> dict | None:
        return _row(
            connection.execute(
                text(
                    """
                    SELECT document.id::text AS source_id, document.original_filename,
                           document.document_type, document.mime_type,
                           document.checksum_sha256, chunk.id::text AS chunk_id,
                           chunk.page_number, chunk.section_locator AS locator,
                           chunk.content AS excerpt
                    FROM analysis_runs run
                    JOIN analysis_run_documents snapshot
                      ON snapshot.analysis_run_id=run.id AND snapshot.case_id=run.case_id
                    JOIN case_documents document
                      ON document.id=snapshot.document_id AND document.case_id=snapshot.case_id
                    JOIN document_chunks chunk
                      ON chunk.document_id=document.id AND chunk.case_id=document.case_id
                    WHERE run.id=CAST(:analysis_run_id AS uuid)
                      AND run.case_id=CAST(:case_id AS uuid)
                      AND document.id=CAST(:source_id AS uuid)
                      AND chunk.id=CAST(:chunk_id AS uuid)
                      AND document.ingestion_status='ready'
                    """
                ),
                request,
            ).mappings().one_or_none()
        )

    @staticmethod
    def _policy(connection, request: dict) -> dict | None:
        return _row(
            connection.execute(
                text(
                    """
                    SELECT version.id::text AS source_id, policy.code AS policy_code,
                           policy.title, version.version, version.approved_at,
                           version.effective_from, version.effective_to,
                           version.checksum_sha256, chunk.id::text AS chunk_id,
                           chunk.section_locator AS locator, chunk.content AS excerpt
                    FROM analysis_runs run
                    JOIN analysis_run_policy_versions snapshot
                      ON snapshot.analysis_run_id=run.id
                    JOIN policy_versions version ON version.id=snapshot.policy_version_id
                    JOIN policy_documents policy ON policy.id=version.policy_document_id
                    JOIN policy_chunks chunk ON chunk.policy_version_id=version.id
                    WHERE run.id=CAST(:analysis_run_id AS uuid)
                      AND run.case_id=CAST(:case_id AS uuid)
                      AND version.id=CAST(:source_id AS uuid)
                      AND chunk.id=CAST(:chunk_id AS uuid)
                      AND ('*' = ANY(chunk.jurisdictions)
                        OR run.case_snapshot #>> '{applicant,jurisdiction}' = ANY(chunk.jurisdictions))
                        AND ('*' = ANY(chunk.products)
                        OR run.case_snapshot #>> '{applicant,product}' = ANY(chunk.products))
                        AND ('*' = ANY(chunk.business_types)
                        OR run.case_snapshot #>> '{applicant,business_type}' = ANY(chunk.business_types))
                    """
                ),
                request,
            ).mappings().one_or_none()
        )

    @staticmethod
    def _human_input(connection, request: dict) -> dict | None:
        return _row(
            connection.execute(
                text(
                    """
                    SELECT input.id::text AS source_id, input.question,
                           input.reason, input.input_type, input.response,
                           input.responded_at, 'human input response' AS locator,
                           input.response::text AS excerpt
                    FROM analysis_runs run
                    JOIN human_input_requests input ON input.analysis_run_id=run.id
                    WHERE run.id=CAST(:analysis_run_id AS uuid)
                      AND run.case_id=CAST(:case_id AS uuid)
                      AND input.id=CAST(:source_id AS uuid)
                      AND input.status='answered'
                    """
                ),
                request,
            ).mappings().one_or_none()
        )

    @staticmethod
    def _external_web(connection, request: dict) -> dict | None:
        return _row(
            connection.execute(
                text(
                    """
                    SELECT evidence.id::text AS source_id, evidence.url,
                           evidence.canonical_url, evidence.title, evidence.publisher,
                           evidence.published_at, evidence.retrieved_at,
                           evidence.excerpt, evidence.content_hash,
                           evidence.retrieval_method, evidence.search_execution_id::text,
                           evidence.canonical_url AS locator
                    FROM get_coordinator_v3_accepted_web_evidence(
                      CAST(:analysis_run_id AS uuid), ARRAY[CAST(:source_id AS uuid)]
                    ) evidence
                    JOIN analysis_runs run ON run.id=evidence.analysis_run_id
                    WHERE run.case_id=CAST(:case_id AS uuid)
                    """
                ),
                request,
            ).mappings().one_or_none()
        )

    async def run(self) -> Message:
        request = self._validate(self.input_value)
        engine = create_engine(await self._database_url())
        try:
            with engine.begin() as connection:
                resolver = {
                    "case_document": self._case_document,
                    "policy": self._policy,
                    "human_input": self._human_input,
                    "external_web": self._external_web,
                }[request["source_kind"]]
                source = resolver(connection, request)
            if source is None:
                raise ValueError("citation source is outside the requested run/case or is unavailable")

            if request["source_kind"] == "case_document":
                citation = {
                    "source_kind": "case_document",
                    "document_chunk_id": source["chunk_id"],
                    "locator": source["locator"],
                    "excerpt": source["excerpt"],
                }
            elif request["source_kind"] == "policy":
                citation = {
                    "source_kind": "policy",
                    "policy_chunk_id": source["chunk_id"],
                    "locator": source["locator"],
                    "excerpt": source["excerpt"],
                }
            elif request["source_kind"] == "human_input":
                citation = {
                    "source_kind": "human_input",
                    "human_input_request_id": source["source_id"],
                    "locator": source["locator"],
                    "excerpt": source["excerpt"],
                }
            else:
                citation = {
                    "source_kind": "external_web",
                    "external_web_evidence_id": source["source_id"],
                    "locator": source["locator"],
                    "excerpt": source["excerpt"],
                }

            return Message(
                text=json.dumps(
                    {
                        "status": "ok",
                        "analysis_run_id": request["analysis_run_id"],
                        "case_id": request["case_id"],
                        "source": source,
                        "citation": citation,
                    },
                    separators=(",", ":"),
                    default=str,
                )
            )
        finally:
            engine.dispose()
