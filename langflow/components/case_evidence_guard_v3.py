from __future__ import annotations

import asyncio
import hashlib
import json
import math
import mimetypes
import re
import uuid
from pathlib import Path
from urllib.parse import urlsplit

from sqlalchemy import create_engine, text

from lfx.custom import Component
from lfx.io import DropdownInput, HandleInput, MessageTextInput, Output, SecretStrInput, StrInput
from lfx.schema import Data, Message
from lfx.services.deps import session_scope


MAX_RESULTS = 20


def _uuid_text(value: object, field: str) -> str:
    try:
        return str(uuid.UUID(str(value)))
    except (AttributeError, TypeError, ValueError) as exc:
        raise ValueError(f"{field} must be a valid UUID") from exc


def _message_text(value: object) -> str:
    if isinstance(value, Message):
        return str(value.text or "")
    return str(value or "")


def _single_local_path(value: object) -> Path:
    candidates: list[object] = []
    if isinstance(value, Message):
        candidates.append(getattr(value, "file_path", None))
    elif isinstance(value, Data):
        candidates.append(value.data.get("file_path"))
    elif hasattr(value, "to_dict"):
        try:
            for row in value.to_dict(orient="records"):
                candidates.append(row.get("file_path"))
        except TypeError:
            pass
    elif isinstance(value, dict):
        candidates.append(value.get("file_path"))
    elif isinstance(value, list):
        for row in value:
            if isinstance(row, Data):
                candidates.append(row.data.get("file_path"))
            elif isinstance(row, dict):
                candidates.append(row.get("file_path"))
    paths = [str(item).strip() for item in candidates if item]
    if not paths:
        paths = [line.strip() for line in _message_text(value).splitlines() if line.strip()]
    if len(paths) != 1:
        raise ValueError("Read File must provide exactly one local file path")
    path = Path(paths[0]).resolve()
    if not path.is_file():
        raise ValueError("Read File path is unavailable")
    return path


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _records(value: object) -> list[dict]:
    if value is None:
        return []
    if hasattr(value, "to_dict"):
        try:
            rows = value.to_dict(orient="records")
            if isinstance(rows, list):
                return [dict(row) for row in rows]
        except TypeError:
            pass
    values = value if isinstance(value, list) else [value]
    rows: list[dict] = []
    for item in values:
        if isinstance(item, Data):
            row = dict(item.data)
            row.setdefault("text", item.get_text())
        elif isinstance(item, Message):
            row = {"text": item.text}
        elif isinstance(item, dict):
            row = dict(item)
        else:
            row = {"text": str(item)}
        rows.append(row)
    return rows


def _first_positive_int(*values: object) -> int | None:
    for value in values:
        try:
            number = int(value)
        except (TypeError, ValueError):
            continue
        if number > 0:
            return number
    return None


def _page_number(row: dict) -> int | None:
    direct = _first_positive_int(row.get("page_number"), row.get("page"), row.get("page_no"))
    if direct is not None:
        return direct
    metadata = row.get("metadata")
    if isinstance(metadata, dict):
        nested = _first_positive_int(
            metadata.get("page_number"), metadata.get("page"), metadata.get("page_no")
        )
        if nested is not None:
            return nested
    docling = row.get("dl_meta")
    if isinstance(docling, dict):
        for item in docling.get("doc_items") or []:
            if not isinstance(item, dict):
                continue
            for provenance in item.get("prov") or []:
                if isinstance(provenance, dict):
                    nested = _first_positive_int(provenance.get("page_no"), provenance.get("page"))
                    if nested is not None:
                        return nested
    return None


def _chunk_rows(value: object) -> list[dict]:
    chunks: list[dict] = []
    for row in _records(value):
        content = str(row.get("text") or row.get("content") or row.get("page_content") or "").strip()
        if not content:
            continue
        chunk_index = len(chunks)
        page_number = _page_number(row)
        metadata = row.get("metadata")
        metadata = metadata if isinstance(metadata, dict) else {}
        locator = str(
            row.get("section_locator")
            or row.get("heading")
            or row.get("title")
            or metadata.get("section_locator")
            or metadata.get("heading")
            or metadata.get("title")
            or (
                f"Page {page_number} · Chunk {chunk_index + 1}"
                if page_number
                else f"Document chunk {chunk_index + 1}"
            )
        ).strip()
        chunks.append(
            {
                "chunk_index": chunk_index,
                "content": content,
                "page_number": page_number,
                "section_locator": locator,
            }
        )
    if not chunks:
        raise ValueError("Split Text produced no non-empty chunks")
    return chunks


def _parse_search_request(value: object) -> dict:
    if isinstance(value, Message):
        value = value.text
    if isinstance(value, dict):
        request = value
    else:
        raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", str(value or "").strip(), flags=re.I)
        request = json.loads(raw or "{}")
    if not isinstance(request, dict):
        raise ValueError("retrieval request must be one JSON object")
    query = str(request.get("query") or "").strip()
    if not query:
        raise ValueError("query is required")
    if len(query) > 500:
        raise ValueError("query cannot exceed 500 characters")
    document_ids = request.get("permitted_document_ids")
    if not isinstance(document_ids, list) or not document_ids:
        raise ValueError("permitted_document_ids must be a non-empty explicit list")
    normalized_ids = [_uuid_text(item, "permitted_document_ids") for item in document_ids]
    if len(normalized_ids) > 25 or len(set(normalized_ids)) != len(normalized_ids):
        raise ValueError("permitted_document_ids must contain 1-25 unique IDs")
    try:
        limit = int(request.get("limit", 10))
    except (TypeError, ValueError) as exc:
        raise ValueError("limit must be an integer") from exc
    if not 1 <= limit <= MAX_RESULTS:
        raise ValueError(f"limit must be between 1 and {MAX_RESULTS}")
    return {
        "analysis_run_id": _uuid_text(request.get("analysis_run_id"), "analysis_run_id"),
        "case_id": _uuid_text(request.get("case_id"), "case_id"),
        "permitted_document_ids": normalized_ids,
        "query": query,
        "limit": limit,
    }


def _vector_literal(values: list[float]) -> str:
    if not values or any(not math.isfinite(float(value)) for value in values):
        raise ValueError("embedding model returned an invalid vector")
    return "[" + ",".join(str(float(value)) for value in values) + "]"


def _json_message(payload: dict) -> Message:
    return Message(text=json.dumps(payload, separators=(",", ":"), default=str))


class CaseEvidenceGuardV3(Component):
    display_name = "Case Evidence Guard"
    description = "Stores deduplicated evidence and retrieves only run-pinned, explicitly permitted documents."
    icon = "shield-check"
    name = "CaseEvidenceGuardV3"

    inputs = [
        DropdownInput(name="operation", display_name="Operation", options=["Ingest", "Retrieve"], value="Ingest"),
        HandleInput(
            name="file_path",
            display_name="Original File",
            input_types=["Message", "Data", "DataFrame", "Table", "JSON"],
            required=False,
            info="Connect the Structured Output from Read File.",
        ),
        HandleInput(
            name="chunks",
            display_name="Cited Chunks",
            input_types=["Data", "DataFrame", "Table", "JSON"],
            required=False,
            info="Connect the Chunks output from Split Text.",
        ),
        HandleInput(
            name="embedding",
            display_name="Embedding Model",
            input_types=["Embeddings"],
            required=True,
        ),
        MessageTextInput(name="case_id", display_name="Case ID", required=True),
        StrInput(name="document_type", display_name="Document Type", required=True),
        StrInput(name="submitted_by", display_name="Submitted By", required=True),
        StrInput(
            name="original_filename",
            display_name="Original Filename",
            required=False,
            advanced=True,
        ),
        StrInput(
            name="supplied_mime_type",
            display_name="MIME Type",
            required=False,
            advanced=True,
        ),
        StrInput(
            name="supplied_checksum_sha256",
            display_name="Expected SHA-256",
            required=False,
            advanced=True,
        ),
        MessageTextInput(
            name="retrieval_request",
            display_name="Scoped Retrieval Request",
            info="JSON with analysis_run_id, case_id, permitted_document_ids, query, and optional limit.",
            required=False,
            tool_mode=True,
        ),
        StrInput(
            name="embedding_model_name",
            display_name="Embedding Model Name",
            value="embed-english-v3.0",
            info="Must match the connected Cohere Embeddings model.",
            advanced=True,
        ),
        SecretStrInput(
            name="database_url",
            display_name="Database URL",
            value="DATABASE_URL",
            required=True,
            advanced=True,
        ),
    ]

    outputs = [
        Output(display_name="Ingestion Result", name="ingestion_result", method="ingest"),
        Output(display_name="Validated Search Query", name="search_query", method="validated_search_query"),
        Output(display_name="Scoped Search Results", name="search_results", method="search"),
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
        if value.startswith(("postgresql://", "postgresql+psycopg2://")):
            return value
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

    @property
    def _provider(self) -> str:
        return "cohere"

    async def _embed_documents(self, values: list[str]) -> list[list[float]]:
        if hasattr(self.embedding, "aembed_documents"):
            vectors = await self.embedding.aembed_documents(values)
        else:
            vectors = await asyncio.to_thread(self.embedding.embed_documents, values)
        result = [[float(value) for value in vector] for vector in vectors]
        if len(result) != len(values):
            raise ValueError("embedding model returned the wrong number of vectors")
        dimensions = {len(vector) for vector in result}
        if dimensions == {0} or len(dimensions) != 1:
            raise ValueError("embedding vectors must share one non-zero dimension")
        for vector in result:
            _vector_literal(vector)
        return result

    async def _embed_query(self, value: str) -> list[float]:
        if hasattr(self.embedding, "aembed_query"):
            vector = await self.embedding.aembed_query(value)
        else:
            vector = await asyncio.to_thread(self.embedding.embed_query, value)
        result = [float(item) for item in vector]
        _vector_literal(result)
        return result

    async def ingest(self) -> Message:
        if self.operation != "Ingest":
            return _json_message({"schema_version": "1.0", "status": "skipped", "operation": self.operation})

        case_id: str | None = None
        document_id: str | None = None
        evidence_submission_id: str | None = None
        checksum: str | None = None
        original_filename: str | None = None
        mime_type: str | None = None
        engine = None

        try:
            case_id = _uuid_text(self.case_id, "case_id")
            document_type = str(self.document_type or "").strip()
            submitted_by = str(self.submitted_by or "").strip()
            model_name = str(self.embedding_model_name or "").strip()
            if not document_type or not submitted_by or not model_name:
                raise ValueError("document_type, submitted_by, and embedding_model_name are required")

            path = _single_local_path(self.file_path)
            chunks = _chunk_rows(self.chunks)
            computed_checksum = _sha256(path)
            supplied_checksum = str(self.supplied_checksum_sha256 or "").strip().lower()
            if supplied_checksum:
                if not re.fullmatch(r"[0-9a-f]{64}", supplied_checksum):
                    raise ValueError("supplied_checksum_sha256 must contain 64 hexadecimal characters")
                if supplied_checksum != computed_checksum:
                    raise ValueError("uploaded file checksum does not match the API metadata")
            checksum = computed_checksum
            original_filename = str(self.original_filename or "").strip() or path.name
            mime_type = (
                str(self.supplied_mime_type or "").strip()
                or mimetypes.guess_type(original_filename)[0]
                or "application/octet-stream"
            )
            page_numbers = {
                chunk["page_number"] for chunk in chunks if chunk["page_number"] is not None
            }
            page_count = len(page_numbers) or None
            source_metadata = {
                "file_size_bytes": path.stat().st_size,
                "suffix": Path(original_filename).suffix.lower(),
                "chunk_count": len(chunks),
                "page_count": page_count,
                "parser": "Langflow Read File",
            }

            engine = create_engine(await self._database_url())
            with engine.begin() as connection:
                case = connection.execute(
                    text("SELECT applicant_id::text FROM onboarding_cases WHERE id=CAST(:case_id AS uuid) FOR UPDATE"),
                    {"case_id": case_id},
                ).mappings().one_or_none()
                if case is None:
                    raise ValueError("case_id does not identify an onboarding case")
                connection.execute(
                    text("SELECT pg_advisory_xact_lock(hashtextextended(:case_id, 0))"),
                    {"case_id": case_id},
                )
                existing = connection.execute(
                    text(
                        """
                        SELECT id::text, evidence_submission_id::text, ingestion_status,
                               original_filename, mime_type
                        FROM case_documents
                        WHERE case_id=CAST(:case_id AS uuid) AND checksum_sha256=:checksum
                        """
                    ),
                    {"case_id": case_id, "checksum": checksum},
                ).mappings().one_or_none()
                if existing and existing["ingestion_status"] == "ready":
                    self.status = f"Document {existing['id']} already ready"
                    return _json_message(
                        {
                            "schema_version": "1.0",
                            "status": "duplicate",
                            "ingestion_status": "ready",
                            "case_id": case_id,
                            "evidence_submission_id": existing["evidence_submission_id"],
                            "document_id": existing["id"],
                            "original_filename": existing["original_filename"],
                            "mime_type": existing["mime_type"],
                            "checksum_sha256": checksum,
                            "chunk_count": None,
                            "page_count": None,
                            "embedding_provider": self._provider,
                            "embedding_model": model_name,
                            "error": None,
                        }
                    )
                if existing and existing["ingestion_status"] in {"pending", "parsing"}:
                    self.status = f"Document {existing['id']} ingestion already in progress"
                    return _json_message(
                        {
                            "schema_version": "1.0",
                            "status": "duplicate_in_progress",
                            "ingestion_status": existing["ingestion_status"],
                            "case_id": case_id,
                            "evidence_submission_id": existing["evidence_submission_id"],
                            "document_id": existing["id"],
                            "original_filename": existing["original_filename"],
                            "mime_type": existing["mime_type"],
                            "checksum_sha256": checksum,
                            "chunk_count": None,
                            "page_count": None,
                            "embedding_provider": self._provider,
                            "embedding_model": model_name,
                            "error": None,
                        }
                    )
                if existing:
                    document_id = existing["id"]
                    evidence_submission_id = existing["evidence_submission_id"]
                    connection.execute(
                        text(
                            """
                            UPDATE case_documents
                            SET ingestion_status='parsing', ingestion_error=NULL,
                                original_filename=:filename, mime_type=:mime_type,
                                storage_path=:storage_path,
                                source_metadata=CAST(:source_metadata AS jsonb),
                                embedding_provider=:provider, embedding_model=:model
                            WHERE id=CAST(:document_id AS uuid)
                            """
                        ),
                        {
                            "document_id": document_id,
                            "filename": original_filename,
                            "mime_type": mime_type,
                            "storage_path": str(path),
                            "source_metadata": json.dumps(source_metadata),
                            "provider": self._provider,
                            "model": model_name,
                        },
                    )
                else:
                    submission_number = connection.execute(
                        text(
                            "SELECT COALESCE(MAX(submission_number),0)+1 FROM evidence_submissions "
                            "WHERE case_id=CAST(:case_id AS uuid)"
                        ),
                        {"case_id": case_id},
                    ).scalar_one()
                    evidence_submission_id = str(uuid.uuid4())
                    document_id = str(uuid.uuid4())
                    connection.execute(
                        text(
                            """
                            INSERT INTO evidence_submissions(id, case_id, submission_number, submitted_by)
                            VALUES (CAST(:submission_id AS uuid), CAST(:case_id AS uuid),
                                    :submission_number, :submitted_by)
                            """
                        ),
                        {
                            "submission_id": evidence_submission_id,
                            "case_id": case_id,
                            "submission_number": submission_number,
                            "submitted_by": submitted_by,
                        },
                    )
                    connection.execute(
                        text(
                            """
                            INSERT INTO case_documents(
                              id, evidence_submission_id, case_id, applicant_id, document_type,
                              original_filename, mime_type, checksum_sha256, storage_path,
                              ingestion_status, source_metadata, embedding_provider, embedding_model
                            ) VALUES (
                              CAST(:document_id AS uuid), CAST(:submission_id AS uuid),
                              CAST(:case_id AS uuid), CAST(:applicant_id AS uuid), :document_type,
                              :filename, :mime_type, :checksum, :storage_path, 'parsing',
                              CAST(:source_metadata AS jsonb), :provider, :model
                            )
                            """
                        ),
                        {
                            "document_id": document_id,
                            "submission_id": evidence_submission_id,
                            "case_id": case_id,
                            "applicant_id": case["applicant_id"],
                            "document_type": document_type,
                            "filename": original_filename,
                            "mime_type": mime_type,
                            "checksum": checksum,
                            "storage_path": str(path),
                            "source_metadata": json.dumps(source_metadata),
                            "provider": self._provider,
                            "model": model_name,
                        },
                    )

            vectors = await self._embed_documents([chunk["content"] for chunk in chunks])
            with engine.begin() as connection:
                document = connection.execute(
                    text(
                        "SELECT applicant_id::text FROM case_documents "
                        "WHERE id=CAST(:document_id AS uuid) "
                        "AND case_id=CAST(:case_id AS uuid) FOR UPDATE"
                    ),
                    {"document_id": document_id, "case_id": case_id},
                ).mappings().one()
                connection.execute(
                    text("DELETE FROM document_chunks WHERE document_id=CAST(:document_id AS uuid)"),
                    {"document_id": document_id},
                )
                for chunk, vector in zip(chunks, vectors, strict=True):
                    connection.execute(
                        text(
                            """
                            INSERT INTO document_chunks(
                              document_id, case_id, applicant_id, evidence_submission_id,
                              chunk_index, content, page_number, section_locator, embedding,
                              embedding_provider, embedding_model
                            ) VALUES (
                              CAST(:document_id AS uuid), CAST(:case_id AS uuid),
                              CAST(:applicant_id AS uuid), CAST(:submission_id AS uuid),
                              :chunk_index, :content, :page_number, :section_locator,
                              CAST(:embedding AS vector), :provider, :model
                            )
                            """
                        ),
                        {
                            "document_id": document_id,
                            "case_id": case_id,
                            "applicant_id": document["applicant_id"],
                            "submission_id": evidence_submission_id,
                            **chunk,
                            "embedding": _vector_literal(vector),
                            "provider": self._provider,
                            "model": model_name,
                        },
                    )
                connection.execute(
                    text(
                        """
                        UPDATE case_documents
                        SET ingestion_status='ready', parsed_text=:parsed_text,
                            ingestion_error=NULL, embedding_provider=:provider,
                            embedding_model=:model
                        WHERE id=CAST(:document_id AS uuid)
                        """
                    ),
                    {
                        "document_id": document_id,
                        "parsed_text": "\n\n".join(chunk["content"] for chunk in chunks),
                        "provider": self._provider,
                        "model": model_name,
                    },
                )

            self.status = f"Ingested {original_filename}: {len(chunks)} chunk(s)"
            return _json_message(
                {
                    "schema_version": "1.0",
                    "status": "ready",
                    "ingestion_status": "ready",
                    "case_id": case_id,
                    "evidence_submission_id": evidence_submission_id,
                    "document_id": document_id,
                    "original_filename": original_filename,
                    "mime_type": mime_type,
                    "checksum_sha256": checksum,
                    "chunk_count": len(chunks),
                    "page_count": page_count,
                    "embedding_provider": self._provider,
                    "embedding_model": model_name,
                    "error": None,
                }
            )
        except Exception as exc:
            error = {
                "code": "invalid_ingestion_input" if isinstance(exc, ValueError) else "evidence_ingestion_failed",
                "message": str(exc)[:500] if isinstance(exc, ValueError) else "Evidence ingestion failed.",
            }
            if document_id and engine is not None:
                try:
                    with engine.begin() as connection:
                        connection.execute(
                            text(
                                """
                                UPDATE case_documents
                                SET ingestion_status='failed', ingestion_error=:error
                                WHERE id=CAST(:document_id AS uuid)
                                """
                            ),
                            {
                                "document_id": document_id,
                                "error": json.dumps(error, separators=(",", ":")),
                            },
                        )
                except Exception:
                    pass
            self.status = error["message"]
            return _json_message(
                {
                    "schema_version": "1.0",
                    "status": "failed",
                    "ingestion_status": "failed",
                    "case_id": case_id,
                    "evidence_submission_id": evidence_submission_id,
                    "document_id": document_id,
                    "original_filename": original_filename,
                    "mime_type": mime_type,
                    "checksum_sha256": checksum,
                    "chunk_count": 0,
                    "page_count": None,
                    "embedding_provider": self._provider,
                    "embedding_model": str(self.embedding_model_name or "").strip() or None,
                    "error": error,
                }
            )
        finally:
            if engine is not None:
                engine.dispose()

    def validated_search_query(self) -> str:
        if self.operation != "Retrieve":
            return ""
        return _parse_search_request(self.retrieval_request)["query"]

    async def search(self) -> list[Data]:
        if self.operation != "Retrieve":
            return []
        request = _parse_search_request(self.retrieval_request)
        model_name = str(self.embedding_model_name or "").strip()
        query_vector = await self._embed_query(request["query"])
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
                        WITH candidates AS (
                          SELECT
                            chunk.id::text AS chunk_id,
                            document.id::text AS document_id,
                            document.original_filename,
                            document.mime_type,
                            chunk.page_number,
                            chunk.section_locator,
                            chunk.content,
                            ts_rank_cd(
                              chunk.search_vector,
                              websearch_to_tsquery('english', :query)
                            )::double precision AS lexical_score,
                            CASE
                              WHEN chunk.embedding IS NOT NULL
                               AND chunk.embedding_provider=:provider
                               AND chunk.embedding_model=:model
                               AND vector_dims(chunk.embedding)=:dimensions
                              THEN (1-(chunk.embedding <=> CAST(:query_embedding AS vector)))::double precision
                              ELSE 0::double precision
                            END AS semantic_score
                          FROM analysis_run_documents snapshot
                          JOIN case_documents document
                            ON document.id=snapshot.document_id AND document.case_id=snapshot.case_id
                          JOIN document_chunks chunk
                            ON chunk.document_id=document.id AND chunk.case_id=document.case_id
                          WHERE snapshot.analysis_run_id=CAST(:analysis_run_id AS uuid)
                            AND snapshot.case_id=CAST(:case_id AS uuid)
                            AND document.ingestion_status='ready'
                            AND document.id=ANY(ARRAY(
                              SELECT value::uuid
                              FROM jsonb_array_elements_text(CAST(:document_ids AS jsonb))
                            ))
                            AND (
                              chunk.search_vector @@ websearch_to_tsquery('english', :query)
                              OR (
                                chunk.embedding IS NOT NULL
                                AND chunk.embedding_provider=:provider
                                AND chunk.embedding_model=:model
                                AND vector_dims(chunk.embedding)=:dimensions
                              )
                            )
                        )
                        SELECT *, (0.4*lexical_score)+(0.6*semantic_score) AS retrieval_score
                        FROM candidates
                        ORDER BY retrieval_score DESC, chunk_id
                        LIMIT :result_limit
                        """
                    ),
                    {
                        "analysis_run_id": request["analysis_run_id"],
                        "case_id": request["case_id"],
                        "document_ids": json.dumps(request["permitted_document_ids"]),
                        "query": request["query"],
                        "provider": self._provider,
                        "model": model_name,
                        "dimensions": len(query_vector),
                        "query_embedding": _vector_literal(query_vector),
                        "result_limit": request["limit"],
                    },
                ).mappings()
                results = [dict(row) for row in rows]
            return [
                Data(
                    text=row.pop("content"),
                    data={
                        **row,
                        "case_id": request["case_id"],
                        "analysis_run_id": request["analysis_run_id"],
                        "citation_id": f"case_document:{row['document_id']}:{row['chunk_id']}",
                    },
                )
                for row in results
            ]
        finally:
            engine.dispose()
