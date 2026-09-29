from __future__ import annotations

import json
import re
import uuid
from urllib.parse import urlsplit

from langchain_core.chat_history import BaseChatMessageHistory
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage
from sqlalchemy import create_engine, text

from lfx.base.memory.model import LCChatMemoryComponent
from lfx.field_typing.constants import Memory
from lfx.io import HandleInput, Output, SecretStrInput
from lfx.schema import Message
from lfx.services.deps import session_scope


def _object(value: object) -> dict:
    if isinstance(value, Message):
        value = value.text
    if isinstance(value, dict):
        parsed = value
    else:
        raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", str(value or "").strip(), flags=re.I)
        parsed = json.loads(raw or "{}")
    if not isinstance(parsed, dict):
        raise ValueError("PostgreSQL chat memory input must be one JSON object")
    return parsed


class CoordinatorPostgresHistory(BaseChatMessageHistory):
    """Context-only history for a future case assistant."""

    def __init__(self, database_url: str, analysis_run_id: str):
        self.database_url = database_url
        self.analysis_run_id = str(uuid.UUID(analysis_run_id))

    @property
    def messages(self) -> list[BaseMessage]:
        engine = create_engine(self.database_url)
        try:
            with engine.connect() as connection:
                rows = connection.execute(
                    text("""
                        SELECT role, content FROM coordinator_v3_chat_messages
                        WHERE analysis_run_id=CAST(:run AS uuid)
                        ORDER BY created_at,id
                    """),
                    {"run": self.analysis_run_id},
                ).mappings()
                constructors = {"human": HumanMessage, "ai": AIMessage, "system": SystemMessage}
                return [constructors[row["role"]](content=row["content"]) for row in rows]
        finally:
            engine.dispose()

    def add_messages(self, messages: list[BaseMessage]) -> None:
        raise ValueError("The Phase 2 coordinator reads chat memory but does not write case-assistant messages")

    def clear(self) -> None:
        raise ValueError("Coordinator chat memory is append-only")


class KybPostgresqlChatMemoryV3(LCChatMemoryComponent):
    display_name = "PostgreSQL Coordinator Chat Memory V3"
    description = "Context-only memory extension point; coordinator tables remain authoritative."
    icon = "database"
    name = "KybPostgresqlChatMemoryV3"

    inputs = [
        HandleInput(name="run_state", display_name="Persisted Run State", input_types=["Message"], required=True),
        SecretStrInput(name="database_url", display_name="Database URL", value="DATABASE_URL", required=True, advanced=True),
    ]
    outputs = [
        Output(
            display_name="Memory",
            name="memory",
            method="build_message_history",
            types=["Memory"],
            selected="Memory",
        )
    ]

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

    async def build_message_history(self) -> Memory:
        state = _object(self.run_state)
        analysis_run_id = str(uuid.UUID(str(state.get("analysis_run_id") or "")))
        return CoordinatorPostgresHistory(await self._database_url(), analysis_run_id)
