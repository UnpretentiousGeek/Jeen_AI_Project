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
        raise ValueError("Read Accepted Web Evidence request must be one JSON object")
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
        result = int(value if value is not None else MAX_RESULTS)
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


class ReadAcceptedWebEvidenceV3(Component):
    display_name = "Read Accepted Web Evidence V3"
    description = "Reads only analyst-accepted web evidence through the migration 020 acceptance function."
    icon = "globe-lock"
    name = "ReadAcceptedWebEvidenceV3"

    inputs = [
        MessageTextInput(
            name="input_value",
            display_name="Accepted Web Evidence Request",
            info="JSON with analysis_run_id, permitted_web_result_ids, and optional limit.",
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
    outputs = [Output(display_name="Accepted Web Evidence", name="result", method="run")]

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
        permitted_ids = _ids(request.get("permitted_web_result_ids"), "permitted_web_result_ids")
        limit = _limit(request.get("limit"))
        if limit < len(permitted_ids):
            raise ValueError("limit cannot be smaller than the explicit permitted result-id set")
        return {
            "analysis_run_id": _uuid(request.get("analysis_run_id"), "analysis_run_id"),
            "permitted_web_result_ids": permitted_ids,
            "limit": limit,
        }

    async def run(self) -> Message:
        request = self._validate(self.input_value)
        engine = create_engine(await self._database_url())
        try:
            with engine.begin() as connection:
                rows = connection.execute(
                    text(
                        """
                        WITH accepted AS (
                          SELECT evidence.*
                          FROM get_coordinator_v3_accepted_web_evidence(
                            CAST(:analysis_run_id AS uuid), CAST(:result_ids AS uuid[])
                          ) AS evidence
                          JOIN analysis_runs run ON run.id = evidence.analysis_run_id
                          WHERE evidence.analysis_run_id = CAST(:analysis_run_id AS uuid)
                            AND evidence.case_id = run.case_id
                        )
                        SELECT * FROM accepted
                        ORDER BY retrieved_at DESC, id
                        LIMIT :result_limit
                        """
                    ),
                    {
                        "analysis_run_id": request["analysis_run_id"],
                        "result_ids": "{" + ",".join(request["permitted_web_result_ids"]) + "}",
                        "result_limit": request["limit"],
                    },
                ).mappings()
                result = _rows(rows)
                if len(result) != len(request["permitted_web_result_ids"]):
                    raise ValueError("one or more permitted web result IDs are outside the requested run/case")
            return Message(
                text=json.dumps(
                    {
                        "status": "ok",
                        "analysis_run_id": request["analysis_run_id"],
                        "results": result,
                    },
                    separators=(",", ":"),
                    default=str,
                )
            )
        finally:
            engine.dispose()
