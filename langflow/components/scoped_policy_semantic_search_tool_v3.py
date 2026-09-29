from __future__ import annotations

import json
import uuid

from lfx.custom import Component
from lfx.helpers import run_flow
from lfx.io import MessageTextInput, Output
from lfx.schema import Message


SEARCH_FLOW_ID = "5bce1bed-4022-4602-a2f7-2a570010da11"
SEARCH_INPUT_NODE_ID = "ChatInput-R91fA"


def _request(value: object) -> dict:
    if isinstance(value, Message):
        value = value.text
    request = value if isinstance(value, dict) else json.loads(str(value or ""))
    if not isinstance(request, dict) or set(request) != {
        "analysis_run_id", "permitted_policy_version_ids", "query", "limit"
    }:
        raise ValueError("Scoped policy search requires run ID, permitted policy versions, query, and limit")
    try:
        run_id = str(uuid.UUID(str(request["analysis_run_id"])))
        versions = request["permitted_policy_version_ids"]
        if not isinstance(versions, list) or not 1 <= len(versions) <= 25:
            raise ValueError("permitted_policy_version_ids must contain 1 to 25 IDs")
        version_ids = [str(uuid.UUID(str(item))) for item in versions]
    except (TypeError, ValueError, AttributeError) as exc:
        raise ValueError("Scoped policy search IDs must be explicit UUIDs") from exc
    if len(set(version_ids)) != len(version_ids):
        raise ValueError("permitted_policy_version_ids must be unique")
    query = request["query"]
    if not isinstance(query, str) or not 1 <= len(query.strip()) <= 500:
        raise ValueError("Scoped policy search query must be 1 to 500 characters")
    limit = request["limit"]
    if type(limit) is not int or not 1 <= limit <= 25:
        raise ValueError("Scoped policy search limit must be an integer from 1 to 25")
    return {
        "analysis_run_id": run_id,
        "permitted_policy_version_ids": version_ids,
        "query": query.strip(),
        "limit": limit,
    }


def _output_text(outputs: object) -> str:
    for run in outputs or []:
        for item in getattr(run, "outputs", None) or []:
            results = getattr(item, "results", None)
            values = list(results.values()) if isinstance(results, dict) else [results]
            values.append(getattr(item, "message", None))
            for value in values:
                if isinstance(value, Message) and value.text:
                    return value.text
                candidate = getattr(value, "text", None)
                if isinstance(candidate, str) and candidate:
                    return candidate
                if isinstance(value, str) and value:
                    return value
    return ""


class ScopedPolicySemanticSearchToolV3(Component):
    display_name = "Scoped Policy Semantic Search V3 Tool"
    description = (
        "Calls the existing Scoped Policy Semantic Search V3 flow with an explicit "
        "run-scoped JSON request. The external flow performs Cohere semantic search and reranking."
    )
    name = "ScopedPolicySemanticSearchToolV3"
    icon = "book-search"

    inputs = [
        MessageTextInput(
            name="input_value",
            display_name="Scoped Policy Search Request",
            info="JSON with analysis_run_id, permitted_policy_version_ids, query, and limit.",
            required=True,
            tool_mode=True,
        ),
    ]
    outputs = [Output(display_name="Scoped Policy Search Result", name="result", method="search")]

    async def search(self) -> Message:
        request = _request(self.input_value)
        graph = await self.load_flow(SEARCH_FLOW_ID)
        outputs = await run_flow(
            inputs={
                "components": [SEARCH_INPUT_NODE_ID],
                "input_value": json.dumps(request, separators=(",", ":")),
                "type": "chat",
            },
            graph=graph,
            user_id=str(self.user_id),
            session_id=f"policy-search:{request['analysis_run_id']}",
            output_type="any",
        )
        if not outputs:
            raise ValueError("Scoped policy semantic search returned no flow output")
        return Message(text=_output_text(outputs) or "No matching pinned policy passages.")
