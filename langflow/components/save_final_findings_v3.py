from __future__ import annotations

import json
import re
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
        raise ValueError("Save Final Findings input must be one JSON object")
    return parsed


class SaveFinalFindingsV3(Component):
    display_name = "Save Final Findings V3"
    description = "Stores normalized cited findings for one logical coordinator run with exact replay suppression."
    icon = "list-checks"
    name = "SaveFinalFindingsV3"

    inputs = [
        MessageTextInput(
            name="input_value",
            display_name="Final Findings Operation",
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
    outputs = [Output(display_name="Stored Findings", name="result", method="save_final_findings_v3")]

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

    async def save_final_findings_v3(self) -> Message:
        request = _object(self.input_value)
        if request.get("operation") != "save_final_findings":
            raise ValueError("Save Final Findings supports only save_final_findings")
        payload = request.get("payload")
        if not isinstance(payload, dict):
            raise ValueError("save_final_findings requires one payload object")
        engine = create_engine(await self._database_url())
        try:
            with engine.begin() as connection:
                result = connection.execute(
                    text(
                        "SELECT save_simple_coordinator_v3_findings("
                        "CAST(:run AS uuid), CAST(:payload AS jsonb), :key)"
                    ),
                    {
                        "run": str(request.get("coordinator_run_id") or ""),
                        "payload": _canonical(payload),
                        "key": str(request.get("idempotency_key") or ""),
                    },
                ).scalar_one()
        finally:
            engine.dispose()
        self.status = "Stored final findings"
        return Message(text=_canonical(result))
