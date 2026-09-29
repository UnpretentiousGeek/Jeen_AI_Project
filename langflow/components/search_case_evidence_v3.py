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
        raise ValueError("Search Case Evidence request must be one JSON object")
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


class SearchCaseEvidenceV3(Component):
    display_name = "Search Case Evidence V3"
    description = "Searches only explicitly permitted document IDs pinned to one analysis run."
    icon = "file-search"
    name = "SearchCaseEvidenceV3"

    inputs = [
        MessageTextInput(
            name="input_value",
            display_name="Case Evidence Search Request",
            info="JSON with analysis_run_id, case_id, permitted_document_ids, query, and optional limit.",
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
    outputs = [Output(display_name="Case Evidence", name="result", method="run")]

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
        query = str(request.get("query") or "").strip()
        if not query:
            raise ValueError("query is required")
        if len(query) > 500:
            raise ValueError("query cannot exceed 500 characters")
        return {
            "analysis_run_id": _uuid(request.get("analysis_run_id"), "analysis_run_id"),
            "case_id": _uuid(request.get("case_id"), "case_id"),
            "permitted_document_ids": _ids(request.get("permitted_document_ids"), "permitted_document_ids"),
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
                        FROM analysis_run_documents snapshot
                        JOIN case_documents document
                          ON document.id = snapshot.document_id AND document.case_id = snapshot.case_id
                        WHERE snapshot.analysis_run_id = CAST(:analysis_run_id AS uuid)
                          AND snapshot.case_id = CAST(:case_id AS uuid)
                          AND document.id = ANY(
                            ARRAY(
                              SELECT value::uuid
                              FROM jsonb_array_elements_text(CAST(:document_ids AS jsonb))
                            )
                          )
                        """
                    ),
                    {
                        "analysis_run_id": request["analysis_run_id"],
                        "case_id": request["case_id"],
                        "document_ids": json.dumps(request["permitted_document_ids"]),
                    },
                ).scalar_one()
                if int(scoped_count) != len(request["permitted_document_ids"]):
                    raise ValueError("one or more permitted document IDs are outside the requested run/case")
                rows = connection.execute(
                    text(
                        """
                        WITH permitted_documents AS (
                          SELECT value::uuid AS document_id
                          FROM jsonb_array_elements_text(CAST(:document_ids AS jsonb))
                        ),
                        terms AS (
                          -- Passages with every word rank first, but a passage with any word still
                          -- matches: a query naming several topics otherwise finds nothing at all.
                          SELECT websearch_to_tsquery('english', :query) AS every_word,
                                 replace(plainto_tsquery('english', :query)::text, ' & ', ' | ')::tsquery AS any_word
                        )
                        SELECT
                          chunk.id::text AS chunk_id,
                          chunk.document_id::text AS document_id,
                          chunk.case_id::text AS case_id,
                          chunk.page_number,
                          chunk.section_locator,
                          chunk.content,
                          ts_rank_cd(chunk.search_vector, terms.any_word) AS relevance
                        FROM terms, analysis_runs run
                        JOIN analysis_run_documents snapshot
                          ON snapshot.analysis_run_id = run.id AND snapshot.case_id = run.case_id
                        JOIN case_documents document
                          ON document.id = snapshot.document_id AND document.case_id = snapshot.case_id
                        JOIN document_chunks chunk
                          ON chunk.document_id = document.id AND chunk.case_id = document.case_id
                        JOIN permitted_documents permitted ON permitted.document_id = document.id
                        WHERE run.id = CAST(:analysis_run_id AS uuid)
                          AND run.case_id = CAST(:case_id AS uuid)
                          AND document.ingestion_status = 'ready'
                          AND chunk.search_vector @@ terms.any_word
                        ORDER BY chunk.search_vector @@ terms.every_word DESC, relevance DESC,
                                 chunk.document_id, chunk.chunk_index
                        LIMIT :result_limit
                        """
                    ),
                    {
                        "analysis_run_id": request["analysis_run_id"],
                        "case_id": request["case_id"],
                        "document_ids": json.dumps(request["permitted_document_ids"]),
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
                        "case_id": request["case_id"],
                        "query": request["query"],
                        "results": result,
                    },
                    separators=(",", ":"),
                    default=str,
                )
            )
        finally:
            engine.dispose()
