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


MAX_DOCUMENTS = 25
MAX_PAGES = 10
MAX_CHARACTERS = 50_000


def _request(value: object) -> dict:
    if isinstance(value, Message):
        value = value.text
    if isinstance(value, dict):
        parsed = value
    else:
        raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", str(value or "").strip(), flags=re.I)
        parsed = json.loads(raw or "{}")
    if not isinstance(parsed, dict):
        raise ValueError("Read Document Pages request must be one JSON object")
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
    if len(values) > MAX_DOCUMENTS:
        raise ValueError(f"{field} cannot contain more than {MAX_DOCUMENTS} IDs")
    if len(set(values)) != len(values):
        raise ValueError(f"{field} must not contain duplicates")
    return values


def _pages(value: object) -> list[int]:
    if not isinstance(value, list) or not value:
        raise ValueError("page_numbers must be a non-empty explicit list")
    if len(value) > MAX_PAGES:
        raise ValueError(f"page_numbers cannot contain more than {MAX_PAGES} pages")
    try:
        pages = [int(item) for item in value]
    except (TypeError, ValueError) as exc:
        raise ValueError("page_numbers must contain integers") from exc
    if any(page < 1 or page > 10_000 for page in pages):
        raise ValueError("page_numbers must be between 1 and 10000")
    if len(set(pages)) != len(pages):
        raise ValueError("page_numbers must not contain duplicates")
    return pages


def _max_characters(value: object) -> int:
    try:
        result = int(value if value is not None else 20_000)
    except (TypeError, ValueError) as exc:
        raise ValueError("max_characters must be an integer") from exc
    if not 1 <= result <= MAX_CHARACTERS:
        raise ValueError(f"max_characters must be between 1 and {MAX_CHARACTERS}")
    return result


def _json_value(value: object) -> object:
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, (uuid.UUID, Decimal)):
        return str(value)
    return value


class ReadDocumentPagesV3(Component):
    display_name = "Read Document Pages V3"
    description = "Reads bounded pages only from explicitly permitted documents pinned to one analysis run."
    icon = "book-open-check"
    name = "ReadDocumentPagesV3"

    inputs = [
        MessageTextInput(
            name="input_value",
            display_name="Document Page Request",
            info=(
                "JSON with analysis_run_id, case_id, permitted_document_ids, document_id, "
                "page_numbers, and optional max_characters."
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
    outputs = [Output(display_name="Document Pages", name="result", method="run")]

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
        permitted_ids = _ids(request.get("permitted_document_ids"), "permitted_document_ids")
        document_id = _uuid(request.get("document_id"), "document_id")
        if document_id not in permitted_ids:
            raise ValueError("document_id must appear in permitted_document_ids")
        return {
            "analysis_run_id": _uuid(request.get("analysis_run_id"), "analysis_run_id"),
            "case_id": _uuid(request.get("case_id"), "case_id"),
            "permitted_document_ids": permitted_ids,
            "document_id": document_id,
            "page_numbers": _pages(request.get("page_numbers")),
            "max_characters": _max_characters(request.get("max_characters")),
        }

    async def run(self) -> Message:
        request = self._validate(self.input_value)
        engine = create_engine(await self._database_url())
        try:
            with engine.begin() as connection:
                scoped_count = connection.execute(
                    text(
                        """
                        SELECT count(*)
                        FROM analysis_run_documents snapshot
                        JOIN case_documents document
                          ON document.id=snapshot.document_id AND document.case_id=snapshot.case_id
                        WHERE snapshot.analysis_run_id=CAST(:analysis_run_id AS uuid)
                          AND snapshot.case_id=CAST(:case_id AS uuid)
                          AND document.id=ANY(ARRAY(
                            SELECT value::uuid
                            FROM jsonb_array_elements_text(CAST(:document_ids AS jsonb))
                          ))
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
                        SELECT
                          document.id::text AS document_id,
                          document.original_filename,
                          document.mime_type,
                          document.checksum_sha256,
                          chunk.id::text AS chunk_id,
                          chunk.chunk_index,
                          COALESCE(chunk.page_number, 1) AS page_number,
                          chunk.section_locator,
                          chunk.content
                        FROM analysis_runs run
                        JOIN analysis_run_documents snapshot
                          ON snapshot.analysis_run_id=run.id AND snapshot.case_id=run.case_id
                        JOIN case_documents document
                          ON document.id=snapshot.document_id AND document.case_id=snapshot.case_id
                        JOIN document_chunks chunk
                          ON chunk.document_id=document.id AND chunk.case_id=document.case_id
                        WHERE run.id=CAST(:analysis_run_id AS uuid)
                          AND run.case_id=CAST(:case_id AS uuid)
                          AND document.id=CAST(:document_id AS uuid)
                          AND document.ingestion_status='ready'
                          AND COALESCE(chunk.page_number, 1)=ANY(CAST(:page_numbers AS integer[]))
                        ORDER BY COALESCE(chunk.page_number, 1), chunk.chunk_index
                        """
                    ),
                    {
                        "analysis_run_id": request["analysis_run_id"],
                        "case_id": request["case_id"],
                        "document_id": request["document_id"],
                        "page_numbers": request["page_numbers"],
                    },
                ).mappings()
                raw_rows = [dict(row) for row in rows]
            if not raw_rows:
                raise ValueError("requested pages are unavailable in the permitted document")

            remaining = request["max_characters"]
            results = []
            truncated = False
            for raw in raw_rows:
                content = str(raw.pop("content") or "")
                if remaining <= 0:
                    truncated = True
                    break
                excerpt = content[:remaining]
                content_truncated = len(excerpt) < len(content)
                remaining -= len(excerpt)
                results.append(
                    {
                        **{key: _json_value(value) for key, value in raw.items()},
                        "content": excerpt,
                        "content_truncated": content_truncated,
                        "citation_id": (
                            f"case_document:{request['document_id']}:{raw['chunk_id']}"
                        ),
                    }
                )
                if content_truncated:
                    truncated = True
                    break

            return Message(
                text=json.dumps(
                    {
                        "status": "ok",
                        "analysis_run_id": request["analysis_run_id"],
                        "case_id": request["case_id"],
                        "document_id": request["document_id"],
                        "requested_page_numbers": request["page_numbers"],
                        "truncated": truncated,
                        "results": results,
                    },
                    separators=(",", ":"),
                    default=str,
                )
            )
        finally:
            engine.dispose()
