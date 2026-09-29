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


MAX_RESULTS = 25


def _request(value: object) -> dict:
    if isinstance(value, Message):
        value = value.text
    if isinstance(value, dict):
        parsed = value
    else:
        raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", str(value or "").strip(), flags=re.I)
        parsed = json.loads(raw or "{}")
    if not isinstance(parsed, dict):
        raise ValueError("Search Pinned Policy Evidence request must be one JSON object")
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
    if len(values) > MAX_RESULTS:
        raise ValueError(f"{field} cannot contain more than {MAX_RESULTS} IDs")
    if len(set(values)) != len(values):
        raise ValueError(f"{field} must not contain duplicates")
    return values


def _limit(value: object) -> int:
    try:
        result = int(value if value is not None else 10)
    except (TypeError, ValueError) as exc:
        raise ValueError("limit must be an integer") from exc
    if not 1 <= result <= MAX_RESULTS:
        raise ValueError(f"limit must be between 1 and {MAX_RESULTS}")
    return result


def _json_value(value: object) -> object:
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, (uuid.UUID, Decimal)):
        return str(value)
    return value


def _rows(rows) -> list[dict]:
    return [{key: _json_value(value) for key, value in dict(row).items()} for row in rows]


class SearchPinnedPolicyEvidenceV3(Component):
    display_name = "Search Pinned Policy Evidence V3"
    description = "Searches only explicitly permitted policy versions pinned to one analysis run."
    icon = "book-search"
    name = "SearchPinnedPolicyEvidenceV3"

    inputs = [
        MessageTextInput(
            name="input_value",
            display_name="Pinned Policy Search Request",
            info="JSON with analysis_run_id, permitted_policy_version_ids, query, and optional limit.",
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
    outputs = [Output(display_name="Pinned Policy Evidence", name="result", method="run")]

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
        if not value.startswith(("postgresql://", "postgresql+psycopg://", "postgresql+psycopg2://")):
            raise ValueError("Global DATABASE_URL is not a valid PostgreSQL SQLAlchemy URL")
        return value

    @staticmethod
    def _validate(value: object) -> dict:
        request = _request(value)
        query = str(request.get("query") or "").strip()
        if not query:
            raise ValueError("query is required")
        if len(query) > 500:
            raise ValueError("query cannot exceed 500 characters")
        return {
            "analysis_run_id": _uuid(request.get("analysis_run_id"), "analysis_run_id"),
            "permitted_policy_version_ids": _ids(
                request.get("permitted_policy_version_ids"), "permitted_policy_version_ids"
            ),
            "query": query,
            "limit": _limit(request.get("limit")),
        }

    async def run(self) -> Message:
        request = self._validate(self.input_value)
        if not request["query"]:
            raise ValueError("query is required")
        engine = create_engine(await self._database_url())
        try:
            with engine.begin() as connection:
                scoped_count = connection.execute(
                    text(
                        """
                        SELECT count(*)
                        FROM analysis_run_policy_versions snapshot
                        WHERE snapshot.analysis_run_id = CAST(:analysis_run_id AS uuid)
                          AND snapshot.policy_version_id = ANY(
                            ARRAY(
                              SELECT value::uuid
                              FROM jsonb_array_elements_text(CAST(:policy_version_ids AS jsonb))
                            )
                          )
                        """
                    ),
                    {
                        "analysis_run_id": request["analysis_run_id"],
                        "policy_version_ids": json.dumps(request["permitted_policy_version_ids"]),
                    },
                ).scalar_one()
                if int(scoped_count) != len(request["permitted_policy_version_ids"]):
                    raise ValueError("one or more permitted policy version IDs are outside the requested run")
                rows = connection.execute(
                    text(
                        """
                        WITH permitted_versions AS (
                          SELECT value::uuid AS policy_version_id
                          FROM jsonb_array_elements_text(CAST(:policy_version_ids AS jsonb))
                        )
                        SELECT
                          chunk.id::text AS chunk_id,
                          chunk.policy_version_id::text AS policy_version_id,
                          document.code AS policy_code,
                          document.title AS policy_title,
                          version.version,
                          version.effective_from,
                          version.effective_to,
                          chunk.section_locator,
                          chunk.content,
                          ts_rank_cd(chunk.search_vector, websearch_to_tsquery('english', :query)) AS relevance
                        FROM analysis_runs run
                        JOIN analysis_run_policy_versions snapshot ON snapshot.analysis_run_id = run.id
                        JOIN policy_versions version ON version.id = snapshot.policy_version_id
                        JOIN policy_documents document ON document.id = version.policy_document_id
                        JOIN policy_chunks chunk ON chunk.policy_version_id = version.id
                        JOIN permitted_versions permitted ON permitted.policy_version_id = version.id
                        AND ('*' = ANY(chunk.jurisdictions)
                            OR run.case_snapshot #>> '{applicant,jurisdiction}' = ANY(chunk.jurisdictions))
                        AND ('*' = ANY(chunk.products)
                            OR run.case_snapshot #>> '{applicant,product}' = ANY(chunk.products))
                        AND ('*' = ANY(chunk.business_types)
                            OR run.case_snapshot #>> '{applicant,business_type}' = ANY(chunk.business_types))
                        AND policy_chunk_scope_eligible(run.id, chunk.id)
                        WHERE run.id = CAST(:analysis_run_id AS uuid)
                          AND chunk.search_vector @@ websearch_to_tsquery('english', :query)
                        ORDER BY relevance DESC, chunk.policy_version_id, chunk.chunk_index
                        LIMIT :result_limit
                        """
                    ),
                    {
                        "analysis_run_id": request["analysis_run_id"],
                        "policy_version_ids": json.dumps(request["permitted_policy_version_ids"]),
                        "query": request["query"],
                        "result_limit": request["limit"],
                    },
                ).mappings()
                result = _rows(rows)
            return Message(
                text=json.dumps(
                    {
                        "status": "ok",
                        "analysis_run_id": request["analysis_run_id"],
                        "query": request["query"],
                        "results": result,
                    },
                    separators=(",", ":"),
                    default=str,
                )
            )
        finally:
            engine.dispose()
