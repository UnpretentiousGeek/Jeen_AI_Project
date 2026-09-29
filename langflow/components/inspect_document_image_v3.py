from __future__ import annotations

import hashlib
import json
import re
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path

from sqlalchemy import create_engine, text

from lfx.custom import Component
from lfx.io import MessageTextInput, Output, SecretStrInput
from lfx.schema import Message
from lfx.services.deps import session_scope


MAX_DOCUMENTS = 25
MAX_IMAGE_BYTES = 20 * 1024 * 1024
MAX_IMAGE_PIXELS = 20_000_000


def _request(value: object) -> dict:
    if isinstance(value, Message):
        value = value.text
    if isinstance(value, dict):
        parsed = value
    else:
        raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", str(value or "").strip(), flags=re.I)
        parsed = json.loads(raw or "{}")
    if not isinstance(parsed, dict):
        raise ValueError("Inspect Document Image request must be one JSON object")
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


def _positive_int(value: object, field: str, minimum: int, maximum: int) -> int:
    try:
        result = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field} must be an integer") from exc
    if not minimum <= result <= maximum:
        raise ValueError(f"{field} must be between {minimum} and {maximum}")
    return result


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _verified_file(storage_path: object, checksum_sha256: object) -> Path:
    path = Path(str(storage_path or "")).resolve()
    if not path.is_file():
        raise ValueError("the permitted document file is unavailable")
    checksum = str(checksum_sha256 or "")
    if not re.fullmatch(r"[0-9a-f]{64}", checksum) or _sha256(path) != checksum:
        raise ValueError("the permitted document file no longer matches its immutable checksum")
    return path


def _inspect_image(path: Path) -> tuple[int, int]:
    try:
        from PIL import Image

        with Image.open(path) as image:
            image.verify()
        with Image.open(path) as image:
            width, height = image.size
    except (OSError, SyntaxError) as exc:
        raise ValueError("the authorized page did not produce a valid image") from exc
    if width * height > MAX_IMAGE_PIXELS or path.stat().st_size > MAX_IMAGE_BYTES:
        raise ValueError("the authorized document image exceeds the inspection size limit")
    return width, height


def _render_pdf_page(source: Path, checksum: str, page_number: int, dpi: int) -> Path:
    executable = shutil.which("pdftoppm")
    if executable is None:
        raise ValueError("PDF page inspection requires the pdftoppm runtime")
    target_dir = Path(tempfile.gettempdir()) / "kyb-document-images"
    target_dir.mkdir(parents=True, exist_ok=True)
    prefix = target_dir / f"{checksum}-page-{page_number}-dpi-{dpi}"
    target = prefix.with_suffix(".png")
    if not target.is_file():
        result = subprocess.run(
            [
                executable,
                "-f",
                str(page_number),
                "-l",
                str(page_number),
                "-singlefile",
                "-r",
                str(dpi),
                "-png",
                str(source),
                str(prefix),
            ],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        if result.returncode != 0 or not target.is_file():
            raise ValueError("the requested PDF page could not be rendered")
    return target


class InspectDocumentImageV3(Component):
    display_name = "Inspect Document Image V3"
    description = "Renders one authorized page from an explicitly permitted run-pinned document."
    icon = "scan-eye"
    name = "InspectDocumentImageV3"

    inputs = [
        MessageTextInput(
            name="input_value",
            display_name="Document Image Request",
            info=(
                "JSON with analysis_run_id, case_id, permitted_document_ids, document_id, "
                "page_number, and optional dpi."
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
    outputs = [Output(display_name="Authorized Document Image", name="result", method="run")]

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
        permitted_ids = _ids(request.get("permitted_document_ids"), "permitted_document_ids")
        document_id = _uuid(request.get("document_id"), "document_id")
        if document_id not in permitted_ids:
            raise ValueError("document_id must appear in permitted_document_ids")
        return {
            "analysis_run_id": _uuid(request.get("analysis_run_id"), "analysis_run_id"),
            "case_id": _uuid(request.get("case_id"), "case_id"),
            "permitted_document_ids": permitted_ids,
            "document_id": document_id,
            "page_number": _positive_int(request.get("page_number"), "page_number", 1, 10_000),
            "dpi": _positive_int(request.get("dpi", 144), "dpi", 72, 200),
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
                document = connection.execute(
                    text(
                        """
                        SELECT document.id::text AS document_id, document.original_filename,
                               document.mime_type, document.checksum_sha256, document.storage_path
                        FROM analysis_runs run
                        JOIN analysis_run_documents snapshot
                          ON snapshot.analysis_run_id=run.id AND snapshot.case_id=run.case_id
                        JOIN case_documents document
                          ON document.id=snapshot.document_id AND document.case_id=snapshot.case_id
                        WHERE run.id=CAST(:analysis_run_id AS uuid)
                          AND run.case_id=CAST(:case_id AS uuid)
                          AND document.id=CAST(:document_id AS uuid)
                          AND document.ingestion_status='ready'
                        """
                    ),
                    {
                        "analysis_run_id": request["analysis_run_id"],
                        "case_id": request["case_id"],
                        "document_id": request["document_id"],
                    },
                ).mappings().one_or_none()
            if document is None:
                raise ValueError("document_id is outside the requested run/case")

            source = _verified_file(document["storage_path"], document["checksum_sha256"])
            mime_type = str(document["mime_type"] or "").lower()
            if mime_type == "application/pdf" or source.suffix.lower() == ".pdf":
                image_path = _render_pdf_page(
                    source,
                    str(document["checksum_sha256"]),
                    request["page_number"],
                    request["dpi"],
                )
            elif mime_type.startswith("image/"):
                if request["page_number"] != 1:
                    raise ValueError("image documents expose only page 1")
                image_path = source
            else:
                raise ValueError("document type does not support image inspection")

            width, height = _inspect_image(image_path)
            response = {
                "status": "ok",
                "analysis_run_id": request["analysis_run_id"],
                "case_id": request["case_id"],
                "document_id": request["document_id"],
                "original_filename": document["original_filename"],
                "page_number": request["page_number"],
                "dpi": request["dpi"],
                "width": width,
                "height": height,
                "source_checksum_sha256": document["checksum_sha256"],
                "image_checksum_sha256": _sha256(image_path),
            }
            return Message(
                text=json.dumps(response, separators=(",", ":"), default=str),
                files=[str(image_path)],
            )
        finally:
            engine.dispose()
