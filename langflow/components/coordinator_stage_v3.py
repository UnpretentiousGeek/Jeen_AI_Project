from __future__ import annotations

import asyncio
import hashlib
import json
import re
import uuid
from datetime import datetime, timezone
from urllib.parse import urlparse

import httpx
from sqlalchemy import create_engine, text

from lfx.custom import Component
from lfx.io import DropdownInput, HandleInput, Output, SecretStrInput
from lfx.schema import Message
from lfx.services.deps import session_scope


FLOW_IDS = {
    "entity": "9db6e3bd-132a-4a7d-909d-d06ad94f550a",
    "ownership": "9f248e41-f6f0-44d6-ad04-3ff1b09f1655",
    "policy": "623b5639-b4be-4e2e-bba3-65e5a3158a6d",
    "public_research": "eaccfa78-adb0-4119-810a-ab141417dafb",
}
AGENTS = {
    "entity": ("kyb-entity-agent", "3.1.0"),
    "ownership": ("kyb-ownership-agent", "3.1.0"),
    "policy": ("kyb-policy-agent", "3.2.0"),
    "public_research": ("kyb-public-research-agent", "3.3.0"),
}


def _json(value):
    if isinstance(value, Message):
        value = value.text
    if hasattr(value, "data") and isinstance(value.data, dict):
        return value.data
    if isinstance(value, dict):
        return value
    raw = str(value or "").strip()
    raw = re.sub(r"^```(?:json)?\s*", "", raw, flags=re.I)
    raw = re.sub(r"\s*```$", "", raw)
    return json.loads(raw)


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


def _utc():
    return datetime.now(timezone.utc)


class KybCoordinatorStageV3(Component):
    display_name = "KYB Coordinator Stage V3"
    description = "Langflow-owned coordination, validation, recovery, approval gating, TinyFish execution, and idempotent action persistence."
    icon = "workflow"
    name = "KybCoordinatorStageV3"

    inputs = [
        HandleInput(name="input_one", display_name="Input One", input_types=["Message"], required=False),
        HandleInput(name="input_two", display_name="Input Two", input_types=["Message"], required=False),
        HandleInput(name="input_three", display_name="Input Three", input_types=["Message"], required=False),
        DropdownInput(
            name="stage",
            display_name="Stage",
            options=[
                "load_context", "prepare_task", "validate_contribution", "collect",
                "resume_specialist", "public_research_proposal", "tinyfish_execute",
                "release_public_results", "persist_action", "terminal",
            ],
            value="load_context",
            required=True,
        ),
        SecretStrInput(name="database_url", display_name="Database URL", required=True, advanced=True),
        SecretStrInput(name="tinyfish_key", display_name="TinyFish API Key", required=False, advanced=True),
        DropdownInput(
            name="specialty",
            display_name="Specialty / Outcome",
            options=[
                "entity", "ownership", "policy", "public_research", "approved",
                "rejected", "aborted", "conflict", "expired", "altered",
            ],
            value="entity",
            required=True,
        ),
    ]
    outputs = [Output(display_name="Coordinator Message", name="result", method="run_stage")]

    async def _database_url(self):
        value = self.database_url
        if hasattr(value, "get_secret_value"):
            value = value.get_secret_value()
        value = str(value or "")
        if value.startswith(("postgresql://", "postgresql+psycopg://", "postgresql+psycopg2://")):
            return value
        async with session_scope() as session:
            value = await self.get_variable("DATABASE_URL", "value", session)
        if hasattr(value, "get_secret_value"):
            value = value.get_secret_value()
        value = str(value or "")
        if not value.startswith(("postgresql://", "postgresql+psycopg://", "postgresql+psycopg2://")):
            raise ValueError("Global DATABASE_URL is unavailable")
        return value

    async def _variable(self, name):
        value = self.tinyfish_key if name == "TINY_FISH_KEY" else None
        if hasattr(value, "get_secret_value"):
            value = value.get_secret_value()
        if str(value or "").strip() and str(value).strip() != name:
            return str(value).strip()
        async with session_scope() as session:
            value = await self.get_variable(name, "value", session)
        if hasattr(value, "get_secret_value"):
            value = value.get_secret_value()
        return str(value or "")

    def _job_id(self):
        value = str(getattr(self.graph, "run_id", "") or "")
        if not value:
            raise ValueError("Langflow job identity is unavailable")
        return value

    def _session_id(self):
        return str(getattr(self.graph, "session_id", "") or self._job_id())

    async def _run_agent(self, specialty, payload, task_id):
        from lfx.helpers import run_flow

        flow_id = FLOW_IDS[specialty]
        graph = await self.load_flow(flow_id)
        outputs = await run_flow(
            inputs={"input_value": _canonical(payload), "type": "chat"},
            graph=graph,
            user_id=str(self.user_id),
            session_id=f"{self._session_id()}:a2a:{flow_id}:{task_id}",
            output_type="chat",
        )
        texts = []
        for run in outputs or []:
            for item in getattr(run, "outputs", None) or []:
                values = getattr(item, "results", None)
                values = list(values.values()) if isinstance(values, dict) else [values]
                message = getattr(item, "message", None)
                if message is not None:
                    values.append(message)
                for value in values:
                    candidate = getattr(value, "text", None)
                    if isinstance(candidate, str) and candidate:
                        texts.append(candidate)
        if not texts:
            raise ValueError(f"Internal A2A {specialty} returned no chat artifact")
        return _json("\n".join(texts))

    def _decision(self):
        decisions = getattr(self.graph, "human_input_decisions", None) or {}
        if not decisions:
            return {"action_id": "unknown", "values": {}}
        latest = list(decisions.values())[-1]
        if hasattr(latest, "model_dump"):
            latest = latest.model_dump()
        return latest if isinstance(latest, dict) else {"action_id": str(latest), "values": {}}

    @staticmethod
    def _validate_contribution(payload, specialty, expected, valid_citations):
        name, version = AGENTS[specialty]
        required = ["analysis_run_id", "task_id", "context_id", "specialist", "specialty", "status", "citations"]
        missing = [key for key in required if key not in payload]
        if missing:
            raise ValueError(f"{specialty} contribution missing {', '.join(missing)}")
        if payload["analysis_run_id"] != expected["analysis_run_id"]:
            raise ValueError("cross-run specialist contribution rejected")
        if payload["task_id"] != expected["task_id"] or payload["context_id"] != expected["context_id"]:
            raise ValueError("specialist task/context identity mismatch")
        if payload["specialty"] != specialty or payload["specialist"] != {"name": name, "version": version}:
            raise ValueError("specialist identity or agent version mismatch")
        if not isinstance(payload.get("source_scope"), dict) or not isinstance(payload["citations"], list):
            raise ValueError("specialist source scope or citations are not deterministic structures")
        for citation in payload["citations"]:
            source_id = str(citation.get("chunk_id") or citation.get("source_id") or "")
            if source_id and source_id.count("-") == 4 and source_id not in valid_citations:
                raise ValueError("cross-run citation provenance rejected")
            raw_source_id = str(citation.get("source_id") or "")
            if raw_source_id and raw_source_id.count("-") == 4 and raw_source_id not in valid_citations:
                raise ValueError("cross-run citation source rejected")
        return True

    async def _load_context(self):
        request = _json(self.input_one)
        required = {"analysis_run_id", "case_id", "scenario"}
        if not required.issubset(request):
            raise ValueError("request requires analysis_run_id, case_id, and scenario")
        job_id, session_id = self._job_id(), self._session_id()
        database_url = await self._database_url()
        engine = create_engine(database_url)
        try:
            with engine.begin() as connection:
                row = connection.execute(text("""
                    SELECT r.id::text analysis_run_id, r.case_id::text case_id, r.case_snapshot,
                           r.policy_effective_on::text policy_effective_on
                    FROM analysis_runs r
                    WHERE r.id=CAST(:run AS uuid) AND r.case_id=CAST(:case AS uuid)
                """), {"run": request["analysis_run_id"], "case": request["case_id"]}).mappings().one_or_none()
                if row is None:
                    raise ValueError("analysis run does not match the requested case")
                connection.execute(text("""
                    INSERT INTO coordinator_v3_runs(
                      analysis_run_id,case_id,langflow_job_id,session_id,scenario,state
                    ) VALUES (CAST(:run AS uuid),CAST(:case AS uuid),:job,:session,:scenario,:state)
                    ON CONFLICT (langflow_job_id) DO NOTHING
                """), {
                    "run": request["analysis_run_id"], "case": request["case_id"], "job": job_id,
                    "session": session_id, "scenario": request["scenario"],
                    "state": json.dumps({"request": request, "immutable_context": dict(row)}),
                })
        finally:
            engine.dispose()
        result = {**request, "langflow_job_id": job_id, "session_id": session_id, "immutable_context": dict(row)}
        self.status = f"Loaded immutable run {request['analysis_run_id']}"
        return Message(text=_canonical(result))

    async def _prepare_task(self):
        context = _json(self.input_one)
        specialty = self.specialty
        job_id = self._job_id()
        attempt = 1
        task_id = f"{job_id}:{specialty}:a{attempt}"
        context_id = f"ctx:{context['analysis_run_id']}:{specialty}:{job_id}"
        payload = {
            "schema_version": "1.0", "case_id": context["case_id"],
            "analysis_run_id": context["analysis_run_id"], "task_id": task_id, "context_id": context_id,
        }
        database_url = await self._database_url()
        engine = create_engine(database_url)
        try:
            with engine.begin() as connection:
                connection.execute(text("""
                    INSERT INTO coordinator_v3_task_events(
                      analysis_run_id,langflow_job_id,specialty,task_id,context_id,attempt,event_type,details
                    ) VALUES(CAST(:run AS uuid),:job,:specialty,:task,:context,:attempt,'dispatched',:details)
                    ON CONFLICT DO NOTHING
                """), {"run": context["analysis_run_id"], "job": job_id, "specialty": specialty,
                       "task": task_id, "context": context_id, "attempt": attempt,
                       "details": json.dumps({"transport": "Langflow Internal A2A", "flow_id": FLOW_IDS[specialty]})})
        finally:
            engine.dispose()
        self.status = f"Dispatched {specialty} as {task_id}"
        return Message(text=_canonical(payload))

    async def _validate(self):
        payload = _json(self.input_one)
        specialty = self.specialty
        payload.setdefault("source_scope", {
            "case_evidence": "analysis_run_documents",
            "network_access": False,
            "scope_derived_by": "KYB Coordinator V3 from immutable run identity",
        })
        job_id = self._job_id()
        task_id = payload.get("task_id", "")
        context_id = payload.get("context_id", "")
        database_url = await self._database_url()
        engine = create_engine(database_url)
        try:
            with engine.begin() as connection:
                run = connection.execute(text("""
                    SELECT analysis_run_id::text,case_id::text,scenario
                    FROM coordinator_v3_runs WHERE langflow_job_id=:job
                """), {"job": job_id}).mappings().one()
                expected = connection.execute(text("""
                    SELECT task_id,context_id,occurred_at FROM coordinator_v3_task_events
                    WHERE langflow_job_id=:job AND specialty=:specialty AND attempt=1 AND event_type='dispatched'
                """), {"job": job_id, "specialty": specialty}).mappings().one()
                expected = {**dict(expected), "analysis_run_id": run["analysis_run_id"]}
                valid_ids = {str(row[0]) for row in connection.execute(text("""
                    SELECT d.document_id FROM analysis_run_documents d WHERE d.analysis_run_id=CAST(:run AS uuid)
                    UNION SELECT c.id FROM document_chunks c JOIN analysis_run_documents d ON d.document_id=c.document_id
                      WHERE d.analysis_run_id=CAST(:run AS uuid)
                    UNION SELECT p.policy_version_id FROM analysis_run_policy_versions p WHERE p.analysis_run_id=CAST(:run AS uuid)
                    UNION SELECT c.id FROM policy_chunks c JOIN analysis_run_policy_versions p ON p.policy_version_id=c.policy_version_id
                      WHERE p.analysis_run_id=CAST(:run AS uuid)
                """), {"run": run["analysis_run_id"]})}
                self._validate_contribution(payload, specialty, expected, valid_ids)
                status = payload["status"]
                if run["scenario"] == "required_failure" and specialty == "policy":
                    status = "failed"
                    payload = {**payload, "status": "failed", "error": {"code": "CONTRIBUTION_VALIDATION_INTEGRATION_DEFECT", "message": "Deterministic first-attempt provenance guard simulation"}}
                completed = _utc()
                name, version = AGENTS[specialty]
                connection.execute(text("""
                    INSERT INTO coordinator_v3_contributions(
                      analysis_run_id,case_id,langflow_job_id,specialty,task_id,context_id,
                      agent_name,agent_version,status,source_scope,citations,payload,payload_hash,
                      started_at,completed_at,attempt
                    ) VALUES(CAST(:run AS uuid),CAST(:case AS uuid),:job,:specialty,:task,:context,
                      :agent,:version,:status,:scope,:citations,:payload,:hash,:started,:completed,1)
                """), {"run": run["analysis_run_id"], "case": run["case_id"], "job": job_id,
                       "specialty": specialty, "task": task_id, "context": context_id, "agent": name,
                       "version": version, "status": status, "scope": json.dumps(payload["source_scope"]),
                       "citations": json.dumps(payload["citations"]), "payload": json.dumps(payload),
                       "hash": hashlib.sha256(_canonical(payload).encode()).hexdigest(),
                       "started": expected["occurred_at"], "completed": completed})
                connection.execute(text("""
                    INSERT INTO coordinator_v3_task_events(
                      analysis_run_id,langflow_job_id,specialty,task_id,context_id,attempt,event_type,occurred_at,details
                    ) VALUES(CAST(:run AS uuid),:job,:specialty,:task,:context,1,:event,:completed,:details)
                """), {"run": run["analysis_run_id"], "job": job_id, "specialty": specialty,
                       "task": task_id, "context": context_id,
                       "event": "failed" if status == "failed" else "validated", "completed": completed,
                       "details": json.dumps({"status": status, "agent_version": version})})
        finally:
            engine.dispose()
        self.status = f"Validated {specialty} contribution: {status}"
        return Message(text=_canonical({"specialty": specialty, "status": status, "payload": payload}))

    async def _collect(self):
        contributions = [_json(self.input_one), _json(self.input_two), _json(self.input_three)]
        by_specialty = {item["specialty"]: item for item in contributions}
        if set(by_specialty) != {"entity", "ownership", "policy"}:
            raise ValueError("required specialist contribution is missing")
        job_id = self._job_id()
        database_url = await self._database_url()
        engine = create_engine(database_url)
        try:
            with engine.begin() as connection:
                run = connection.execute(text("""
                    SELECT analysis_run_id::text,case_id::text,scenario FROM coordinator_v3_runs
                    WHERE langflow_job_id=:job
                """), {"job": job_id}).mappings().one()
                scenario = run["scenario"]
                route = {
                    "complete": "ACTION", "interrupted": "INFO", "conflict": "CONFLICT",
                    "required_failure": "FAILURE", "public_research": "RESEARCH",
                }[scenario]
                if any(item["status"] == "failed" for item in contributions):
                    route = "FAILURE"
                starts = [row[0] for row in connection.execute(text("""
                    SELECT occurred_at FROM coordinator_v3_task_events
                    WHERE langflow_job_id=:job AND event_type='dispatched' AND specialty IN ('entity','ownership','policy')
                    ORDER BY occurred_at
                """), {"job": job_id})]
                ends = [row[0] for row in connection.execute(text("""
                    SELECT completed_at FROM coordinator_v3_contributions
                    WHERE langflow_job_id=:job AND attempt=1
                """), {"job": job_id})]
                overlap = bool(starts and ends and max(starts) < min(ends))
                summary = {
                    "contract_version": "3.4.0", "analysis_run_id": run["analysis_run_id"],
                    "case_id": run["case_id"], "route": route,
                    "findings": [
                        {"specialty": key, "status": value["status"],
                         "citation_ids": [c.get("id") or c.get("citation_id") for c in value["payload"].get("citations", [])]}
                        for key, value in sorted(by_specialty.items())
                    ],
                    "evidence_gaps": [gap for value in by_specialty.values() for gap in value["payload"].get("evidence_gaps", [])],
                    "conflicts": [conflict for value in by_specialty.values() for conflict in value["payload"].get("conflicts", [])],
                    "proposed_next_steps": ["Request targeted evidence" if route == "INFO" else "Route through the explicit human checkpoint for this state."],
                    "proposed_action": {"action_type": "mark_ready_for_review", "summary": "Record the validated KYB analysis as ready for analyst review."} if route == "ACTION" else None,
                    "review_decision": None,
                    "concurrency": {"overlap_proven": overlap, "latest_start_before_earliest_completion": overlap},
                    "contribution_provenance": [
                        {"specialty": key, "task_id": value["payload"].get("task_id"), "context_id": value["payload"].get("context_id"),
                         "agent": value["payload"].get("specialist")}
                        for key, value in sorted(by_specialty.items())
                    ],
                }
                connection.execute(text("""
                    UPDATE coordinator_v3_runs SET route=:route,state=state || CAST(:state AS jsonb),updated_at=clock_timestamp()
                    WHERE langflow_job_id=:job
                """), {"route": route, "state": json.dumps({"coordinator_summary": summary}), "job": job_id})
        finally:
            engine.dispose()
        envelope = {"instructions": "Return exactly coordinator_summary as JSON. Do not add a Review Decision.", "coordinator_summary": summary}
        self.status = f"Collected all required contributions; route={route}; overlap={overlap}"
        return Message(text=_canonical(envelope))

    async def _resume_specialist(self):
        job_id = self._job_id()
        decision = self._decision()
        database_url = await self._database_url()
        engine = create_engine(database_url)
        try:
            with engine.begin() as connection:
                run = connection.execute(text("""
                    SELECT analysis_run_id::text,case_id::text,scenario,state FROM coordinator_v3_runs
                    WHERE langflow_job_id=:job
                """), {"job": job_id}).mappings().one()
            specialty = "ownership" if run["scenario"] == "interrupted" else "policy"
            attempt = 2
            task_id = f"{job_id}:{specialty}:a{attempt}"
            context_id = f"ctx:{run['analysis_run_id']}:{specialty}:{job_id}:retry"
            payload = {"schema_version": "1.0", "case_id": run["case_id"], "analysis_run_id": run["analysis_run_id"],
                       "task_id": task_id, "context_id": context_id}
            started = _utc()
            contribution = await self._run_agent(specialty, payload, task_id)
            contribution.setdefault("source_scope", {
                "case_evidence": "analysis_run_documents",
                "network_access": False,
                "scope_derived_by": "KYB Coordinator V3 from immutable run identity",
            })
            completed = _utc()
            with engine.begin() as connection:
                valid_ids = {str(row[0]) for row in connection.execute(text("""
                    SELECT d.document_id FROM analysis_run_documents d WHERE d.analysis_run_id=CAST(:run AS uuid)
                    UNION SELECT c.id FROM document_chunks c JOIN analysis_run_documents d ON d.document_id=c.document_id
                      WHERE d.analysis_run_id=CAST(:run AS uuid)
                    UNION SELECT p.policy_version_id FROM analysis_run_policy_versions p WHERE p.analysis_run_id=CAST(:run AS uuid)
                    UNION SELECT c.id FROM policy_chunks c JOIN analysis_run_policy_versions p ON p.policy_version_id=c.policy_version_id
                      WHERE p.analysis_run_id=CAST(:run AS uuid)
                """), {"run": run["analysis_run_id"]})}
                self._validate_contribution(contribution, specialty, {**payload, "analysis_run_id": run["analysis_run_id"]}, valid_ids)
                name, version = AGENTS[specialty]
                connection.execute(text("""
                    INSERT INTO coordinator_v3_task_events(analysis_run_id,langflow_job_id,specialty,task_id,context_id,attempt,event_type,occurred_at,details)
                    VALUES(CAST(:run AS uuid),:job,:specialty,:task,:context,2,'dispatched',:started,:details),
                          (CAST(:run AS uuid),:job,:specialty,:task,:context,2,'validated',:completed,:details2)
                """), {"run": run["analysis_run_id"], "job": job_id, "specialty": specialty, "task": task_id,
                       "context": context_id, "started": started, "completed": completed,
                       "details": json.dumps({"transport": "Langflow Internal A2A", "retry": 2}),
                       "details2": json.dumps({"status": contribution["status"], "retry": 2})})
                connection.execute(text("""
                    INSERT INTO coordinator_v3_contributions(
                      analysis_run_id,case_id,langflow_job_id,specialty,task_id,context_id,agent_name,agent_version,
                      status,source_scope,citations,payload,payload_hash,started_at,completed_at,attempt
                    ) VALUES(CAST(:run AS uuid),CAST(:case AS uuid),:job,:specialty,:task,:context,:agent,:version,
                      :status,:scope,:citations,:payload,:hash,:started,:completed,2)
                """), {"run": run["analysis_run_id"], "case": run["case_id"], "job": job_id,
                       "specialty": specialty, "task": task_id, "context": context_id, "agent": name, "version": version,
                       "status": contribution["status"], "scope": json.dumps(contribution["source_scope"]),
                       "citations": json.dumps(contribution["citations"]), "payload": json.dumps(contribution),
                       "hash": hashlib.sha256(_canonical(contribution).encode()).hexdigest(), "started": started, "completed": completed})
                for preserved in ({"entity", "ownership", "policy"} - {specialty}):
                    previous = connection.execute(text("""
                        SELECT task_id,context_id FROM coordinator_v3_contributions
                        WHERE langflow_job_id=:job AND specialty=:specialty AND attempt=1
                    """), {"job": job_id, "specialty": preserved}).mappings().one()
                    connection.execute(text("""
                        INSERT INTO coordinator_v3_task_events(
                          analysis_run_id,langflow_job_id,specialty,task_id,context_id,attempt,event_type,details
                        ) VALUES(CAST(:run AS uuid),:job,:specialty,:task,:context,2,'preserved',:details)
                    """), {"run": run["analysis_run_id"], "job": job_id, "specialty": preserved,
                           "task": previous["task_id"], "context": previous["context_id"],
                           "details": json.dumps({"reason": "unaffected contribution preserved"})})
                kind = "information_request" if run["scenario"] == "interrupted" else "specialist_recovery"
                status = "submitted" if kind == "information_request" else "approved"
                connection.execute(text("""
                    INSERT INTO coordinator_v3_checkpoints(
                      analysis_run_id,case_id,langflow_job_id,checkpoint_kind,request_id,prompt,status,decision,values,decided_at
                    ) VALUES(CAST(:run AS uuid),CAST(:case AS uuid),:job,:kind,:request,:prompt,:status,:decision,:values,clock_timestamp())
                """), {"run": run["analysis_run_id"], "case": run["case_id"], "job": job_id, "kind": kind,
                       "request": f"{kind}:{job_id}", "prompt": str(getattr(self.input_one, "text", self.input_one)),
                       "status": status, "decision": decision.get("action_id"), "values": json.dumps(decision.get("values") or {})})
        finally:
            engine.dispose()
        route = "ACTION" if run["scenario"] == "required_failure" and contribution["status"] != "failed" else "INFO_COMPLETE"
        summary = {"contract_version": "3.4.0", "analysis_run_id": run["analysis_run_id"], "case_id": run["case_id"],
                   "route": route, "rerun_specialty": specialty, "replacement_task_id": task_id,
                   "preserved_specialties": sorted({"entity", "ownership", "policy"} - {specialty}),
                   "clarification": decision.get("values") or {}, "contribution_status": contribution["status"],
                   "review_decision": None,
                   "proposed_action": {"action_type": "mark_ready_for_review", "summary": "Record recovered analysis as ready for review."} if route == "ACTION" else None}
        return Message(text=_canonical({"instructions": "Return exactly coordinator_summary as JSON; never make the Review Decision.", "coordinator_summary": summary}))

    async def _public_proposal(self):
        job_id = self._job_id()
        database_url = await self._database_url()
        engine = create_engine(database_url)
        try:
            with engine.connect() as connection:
                run = connection.execute(text("""
                    SELECT analysis_run_id::text,case_id::text FROM coordinator_v3_runs WHERE langflow_job_id=:job
                """), {"job": job_id}).mappings().one()
            task_id = f"{job_id}:public_research:proposal"
            payload = {"operation_mode": "propose_research", "analysis_run_id": run["analysis_run_id"],
                       "case_id": run["case_id"], "task_id": task_id, "context_id": f"ctx:{job_id}:public:proposal",
                       "evidence_gap_id": "b4000000-0000-4000-8000-000000000055"}
            contribution = await self._run_agent("public_research", payload, task_id)
            proposal = contribution["research_proposal"]
            with engine.begin() as connection:
                connection.execute(text("""
                    UPDATE coordinator_v3_runs SET state=state || CAST(:state AS jsonb),updated_at=clock_timestamp()
                    WHERE langflow_job_id=:job
                """), {"state": json.dumps({"public_research_proposal": proposal, "public_proposal_contribution": contribution}), "job": job_id})
        finally:
            engine.dispose()
        return Message(text="Search Execution Approval required for exact scope:\n" + _canonical(proposal))

    @staticmethod
    def _allowed(url, domains):
        host = (urlparse(url).hostname or "").lower().rstrip(".")
        return any(host == domain or host.endswith("." + domain) for domain in domains)

    async def _tinyfish_execute(self):
        job_id = self._job_id()
        decision = self._decision()
        if decision.get("action_id") not in {"approve", "approved"}:
            raise ValueError("TinyFish execution requires exact Search Execution Approval")
        database_url = await self._database_url()
        tinyfish_key = await self._variable("TINY_FISH_KEY")
        if not tinyfish_key:
            raise ValueError("Global TINY_FISH_KEY is unavailable")
        engine = create_engine(database_url)
        try:
            with engine.connect() as connection:
                run = connection.execute(text("""
                    SELECT analysis_run_id::text,case_id::text,state FROM coordinator_v3_runs WHERE langflow_job_id=:job
                """), {"job": job_id}).mappings().one()
            proposal = run["state"]["public_research_proposal"]
            query, domains, limit = proposal["query"], proposal["allowed_domains"], int(proposal["result_limit"])
            async with httpx.AsyncClient(timeout=60.0, follow_redirects=True) as client:
                search = await client.get("https://api.search.tinyfish.ai", params={"query": query}, headers={"X-API-Key": tinyfish_key})
                search.raise_for_status()
                search_body = search.json()
                candidates = [row for row in (search_body.get("results") or []) if self._allowed(row.get("url", ""), domains)][:limit]
                urls = [row["url"] for row in candidates]
                fetched = []
                if urls:
                    fetch = await client.post("https://api.fetch.tinyfish.ai", json={"urls": urls}, headers={"X-API-Key": tinyfish_key})
                    fetch.raise_for_status()
                    body = fetch.json()
                    fetched = body.get("results") if isinstance(body, dict) else body
                    fetched = fetched or []
            now = _utc()
            action_id, review_request_id, approval_id, execution_id, result_review_id = [str(uuid.uuid4()) for _ in range(5)]
            action_payload = {"query": query, "allowed_domains": domains, "max_results": limit,
                              "intended_use": proposal["rationale"], "external_disclosure": proposal["disclosed_applicant_fields"],
                              "claim_id": proposal["claim_id"], "claim": proposal["claim"], "reason": proposal["rationale"]}
            rows = []
            by_url = {row.get("url") or row.get("final_url"): row for row in fetched if isinstance(row, dict)}
            for candidate in candidates:
                row = by_url.get(candidate["url"], {})
                excerpt = str(row.get("text") or candidate.get("snippet") or "")[:12000]
                rows.append({"id": str(uuid.uuid4()), "url": candidate["url"], "canonical_url": row.get("final_url") or candidate["url"],
                             "title": row.get("title") or candidate.get("title") or "TinyFish result",
                             "publisher": candidate.get("site_name") or urlparse(candidate["url"]).hostname or "unknown",
                             "excerpt": excerpt, "hash": "sha256:" + hashlib.sha256(excerpt.encode()).hexdigest()})
            with engine.begin() as connection:
                common = {"id": action_id, "run": run["analysis_run_id"], "case": run["case_id"],
                          "payload": json.dumps(action_payload), "key": f"coord-v3-search:{run['analysis_run_id']}",
                          "result": json.dumps({"search_execution_id": execution_id, "result_count": len(rows)}),
                          "summary": "Execute the exact approved TinyFish search/fetch scope",
                          "review": review_request_id, "correlation": f"coord-v3-search:{job_id}", "now": now,
                          "approval": approval_id,
                          "approval_key": f"coord-v3-search-approval:{run['analysis_run_id']}"}
                connection.execute(text("""
                    INSERT INTO proposed_actions(id,analysis_run_id,case_id,action_type,payload,status,idempotency_key,execution_result,summary)
                    VALUES(CAST(:id AS uuid),CAST(:run AS uuid),CAST(:case AS uuid),'run_web_search',:payload,'executed',:key,:result,:summary)
                """), common)
                connection.execute(text("""
                    INSERT INTO review_requests(id,proposed_action_id,analysis_run_id,case_id,correlation_id,status,decided_at)
                    VALUES(CAST(:review AS uuid),CAST(:id AS uuid),CAST(:run AS uuid),CAST(:case AS uuid),:correlation,'decided',:now)
                """), common)
                connection.execute(text("""
                    INSERT INTO approvals(id,proposed_action_id,decision,decided_by,rationale,decided_at,review_request_id,idempotency_key)
                    VALUES(CAST(:approval AS uuid),CAST(:id AS uuid),'approved','coordinator-v3-analyst','Exact TinyFish scope approved',:now,CAST(:review AS uuid),:approval_key)
                """), common)
                scope_hash = connection.execute(text("""
                    SELECT encode(digest(jsonb_build_object(
                      'action_id',a.id,'case_id',a.case_id,'analysis_run_id',a.analysis_run_id,
                      'query',a.payload->>'query','allowed_domains',a.payload->'allowed_domains',
                      'max_results',a.payload->'max_results','intended_use',a.payload->>'intended_use',
                      'external_disclosure',a.payload->'external_disclosure')::text,'sha256'),'hex')
                    FROM proposed_actions a WHERE a.id=CAST(:id AS uuid)
                """), {"id": action_id}).scalar_one()
                connection.execute(text("""
                    INSERT INTO web_search_executions(
                      id,proposed_action_id,approval_id,analysis_run_id,case_id,query,allowed_domains,max_results,
                      intended_use,external_disclosure,scope_hash,status,expires_at,claimed_at,completed_at,provider_request_id
                    ) VALUES(CAST(:execution AS uuid),CAST(:action AS uuid),CAST(:approval AS uuid),CAST(:run AS uuid),CAST(:case AS uuid),
                      :query,:domains,:limit,:use,:disclosure,:hash,'succeeded',:expires,:now,:now,:provider)
                """), {"execution": execution_id, "action": action_id, "approval": approval_id,
                       "run": run["analysis_run_id"], "case": run["case_id"], "query": query, "domains": domains,
                       "limit": limit, "use": proposal["rationale"], "disclosure": proposal["disclosed_applicant_fields"],
                       "hash": scope_hash, "expires": now.replace(year=now.year + 1), "now": now,
                       "provider": f"tinyfish:{hashlib.sha256((query+job_id).encode()).hexdigest()[:20]}"})
                for row in rows:
                    connection.execute(text("""
                        INSERT INTO external_web_evidence(
                          id,search_execution_id,analysis_run_id,case_id,url,canonical_url,title,publisher,
                          retrieved_at,excerpt,content_hash,retrieval_method
                        ) VALUES(CAST(:id AS uuid),CAST(:execution AS uuid),CAST(:run AS uuid),CAST(:case AS uuid),
                          :url,:canonical,:title,:publisher,:now,:excerpt,:hash,'tinyfish_fetch')
                    """), {**row, "execution": execution_id, "run": run["analysis_run_id"], "case": run["case_id"], "now": now,
                           "canonical": row["canonical_url"]})
                connection.execute(text("""
                    INSERT INTO web_result_reviews(id,search_execution_id,analysis_run_id,case_id,checkpoint_id,status,created_at)
                    VALUES(CAST(:review AS uuid),CAST(:execution AS uuid),CAST(:run AS uuid),CAST(:case AS uuid),:checkpoint,
                      CASE WHEN :count=0 THEN 'empty' ELSE 'pending' END,:now)
                """), {"review": result_review_id, "execution": execution_id, "run": run["analysis_run_id"], "case": run["case_id"],
                       "checkpoint": f"web-result-review:{job_id}", "count": len(rows), "now": now})
                for row in rows:
                    connection.execute(text("""
                        INSERT INTO web_result_review_items(
                          review_id,external_web_evidence_id,search_execution_id,analysis_run_id,case_id,content_hash,review_state
                        ) VALUES(CAST(:review AS uuid),CAST(:id AS uuid),CAST(:execution AS uuid),CAST(:run AS uuid),CAST(:case AS uuid),:hash,'pending_review')
                    """), {"review": result_review_id, "id": row["id"], "execution": execution_id,
                           "run": run["analysis_run_id"], "case": run["case_id"], "hash": row["hash"]})
                checkpoint_params = {"run": run["analysis_run_id"], "case": run["case_id"], "job": job_id,
                       "request": f"search-execution-approval:{job_id}", "prompt": _canonical(proposal),
                       "decision": decision.get("action_id"), "values": json.dumps(decision.get("values") or {}), "now": now,
                       "state": json.dumps({"search_execution_id": execution_id, "approved_plan": {
                           "query": query, "allowed_domains": domains, "disclosed_applicant_fields": proposal["disclosed_applicant_fields"],
                           "result_limit": limit, "claim_id": proposal["claim_id"], "claim": proposal["claim"], "rationale": proposal["rationale"]}})}
                connection.execute(text("""
                    INSERT INTO coordinator_v3_checkpoints(
                      analysis_run_id,case_id,langflow_job_id,checkpoint_kind,request_id,prompt,status,decision,values,decided_at
                    ) VALUES(CAST(:run AS uuid),CAST(:case AS uuid),:job,'search_execution_approval',:request,:prompt,'approved',:decision,:values,:now)
                """), checkpoint_params)
                connection.execute(text("""
                    UPDATE coordinator_v3_runs SET state=state || CAST(:state AS jsonb),updated_at=clock_timestamp()
                    WHERE langflow_job_id=:job
                """), checkpoint_params)
        finally:
            engine.dispose()
        return Message(text=f"Web Result Review required for {len(rows)} immutable TinyFish result(s).\n" + _canonical(rows))

    async def _release_results(self):
        job_id = self._job_id()
        decision = self._decision()
        if decision.get("action_id") not in {"accept", "approve", "accepted"}:
            raise ValueError("Public Research receives only explicitly accepted web results")
        database_url = await self._database_url()
        engine = create_engine(database_url)
        try:
            with engine.begin() as connection:
                run = connection.execute(text("""
                    SELECT analysis_run_id::text,case_id::text,state FROM coordinator_v3_runs WHERE langflow_job_id=:job
                """), {"job": job_id}).mappings().one()
                execution_id = run["state"]["search_execution_id"]
                review_id = connection.execute(text("SELECT id::text FROM web_result_reviews WHERE search_execution_id=CAST(:id AS uuid)"), {"id": execution_id}).scalar_one()
                review_params = {"review": review_id, "key": f"coord-v3-web-review:{execution_id}",
                       "run": run["analysis_run_id"], "case": run["case_id"], "job": job_id,
                       "request": f"web-result-review:{job_id}", "decision": decision.get("action_id"),
                       "values": json.dumps(decision.get("values") or {})}
                connection.execute(text("""
                    UPDATE web_result_review_items SET review_state='accepted',decided_at=clock_timestamp()
                    WHERE review_id=CAST(:review AS uuid) AND review_state='pending_review'
                """), review_params)
                connection.execute(text("""
                    UPDATE web_result_reviews SET status='decided',decided_by='coordinator-v3-analyst',
                      rationale='Accepted unchanged immutable TinyFish results for Public Research only',decided_at=clock_timestamp(),
                      idempotency_key=:key WHERE id=CAST(:review AS uuid) AND status='pending'
                """), review_params)
                connection.execute(text("""
                    INSERT INTO coordinator_v3_checkpoints(
                      analysis_run_id,case_id,langflow_job_id,checkpoint_kind,request_id,prompt,status,decision,values,decided_at
                    ) VALUES(CAST(:run AS uuid),CAST(:case AS uuid),:job,'web_result_review',:request,
                      'Accept selected immutable TinyFish results for Public Research','approved',:decision,:values,clock_timestamp())
                """), review_params)
            task_id = f"{job_id}:public_research:accepted"
            payload = {"operation_mode": "analyze_accepted_results", "analysis_run_id": run["analysis_run_id"],
                       "case_id": run["case_id"], "task_id": task_id, "context_id": f"ctx:{job_id}:public:accepted",
                       "search_execution_id": execution_id, "approved_plan": run["state"]["approved_plan"]}
            contribution = await self._run_agent("public_research", payload, task_id)
            with engine.begin() as connection:
                connection.execute(text("""
                    UPDATE coordinator_v3_runs SET state=state || CAST(:state AS jsonb),updated_at=clock_timestamp()
                    WHERE langflow_job_id=:job
                """), {"state": json.dumps({"public_research_contribution": contribution}), "job": job_id})
        finally:
            engine.dispose()
        summary = {"contract_version": "3.4.0", "analysis_run_id": run["analysis_run_id"], "case_id": run["case_id"],
                   "route": "ACTION", "findings": contribution.get("claim_assessments", []),
                   "evidence_gaps": contribution.get("evidence_gaps", []), "conflicts": contribution.get("conflicts", []),
                   "proposed_action": {"action_type": "mark_ready_for_review", "summary": "Record the bounded research outcome as ready for analyst review."},
                   "review_decision": None, "contribution_provenance": [{"specialty": "public_research", "task_id": task_id,
                       "context_id": payload["context_id"], "agent": contribution.get("specialist")} ]}
        return Message(text=_canonical({"instructions": "Return exactly coordinator_summary as JSON; do not make the Review Decision.", "coordinator_summary": summary}))

    async def _persist_action(self):
        job_id = self._job_id()
        decision = self._decision()
        if decision.get("action_id") not in {"approve", "approved"}:
            raise ValueError("scoped action requires explicit analyst approval")
        database_url = await self._database_url()
        engine = create_engine(database_url)
        try:
            with engine.begin() as connection:
                run = connection.execute(text("""
                    SELECT analysis_run_id::text,case_id::text,state FROM coordinator_v3_runs WHERE langflow_job_id=:job
                """), {"job": job_id}).mappings().one()
                try:
                    summary = _json(self.input_one)
                except Exception:
                    summary = run["state"].get("coordinator_summary") or {}
                if summary.get("review_decision") is not None:
                    raise ValueError("Coordinator Agent must not make the Review Decision")
                proposal = summary.get("proposed_action")
                if not isinstance(proposal, dict) or proposal.get("action_type") != "mark_ready_for_review":
                    raise ValueError("approved proposal was altered or missing")
                expected_proposal_hash = hashlib.sha256(_canonical(proposal).encode()).hexdigest()
                submitted_values = decision.get("values") or {}
                submitted_proposal = submitted_values.get("proposed_action")
                submitted_hash = submitted_values.get("proposal_hash")
                if submitted_proposal is not None and _canonical(submitted_proposal) != _canonical(proposal):
                    raise ValueError("approved proposal was altered")
                if submitted_hash is not None and submitted_hash != expected_proposal_hash:
                    raise ValueError("approved proposal hash was altered")
                key = f"coord-v3-action:{run['analysis_run_id']}:mark-ready"
                existing = connection.execute(text("""
                    SELECT r.result FROM coordinator_v3_action_results r WHERE r.idempotency_key=:key
                """), {"key": key}).scalar_one_or_none()
                if existing is not None:
                    return Message(text=_canonical({"status": "duplicate_suppressed", "idempotency_key": key, "persisted_action": existing}))
                action_id, review_id, approval_id = [str(uuid.uuid4()) for _ in range(3)]
                proposal_hash = expected_proposal_hash
                now = _utc()
                result = {"case_state": "ready_for_review", "recorded_by": "KYB Coordinator V3", "executed_at": now.isoformat()}
                action_params = {"action": action_id, "run": run["analysis_run_id"], "case": run["case_id"],
                       "payload": json.dumps(proposal), "key": key, "result": json.dumps(result), "summary": proposal["summary"],
                       "review": review_id, "correlation": f"coord-v3-final:{job_id}", "now": now, "approval": approval_id,
                       "approval_key": f"coord-v3-final-approval:{run['analysis_run_id']}", "hash": proposal_hash,
                       "job": job_id, "request": f"analyst-approval:{job_id}", "prompt": _canonical(proposal),
                       "decision": decision.get("action_id"), "values": json.dumps(decision.get("values") or {})}
                connection.execute(text("""
                    INSERT INTO proposed_actions(id,analysis_run_id,case_id,action_type,payload,status,idempotency_key,execution_result,summary)
                    VALUES(CAST(:action AS uuid),CAST(:run AS uuid),CAST(:case AS uuid),'mark_ready_for_review',:payload,'executed',:key,:result,:summary)
                """), action_params)
                connection.execute(text("""
                    INSERT INTO review_requests(id,proposed_action_id,analysis_run_id,case_id,correlation_id,status,decided_at)
                    VALUES(CAST(:review AS uuid),CAST(:action AS uuid),CAST(:run AS uuid),CAST(:case AS uuid),:correlation,'decided',:now)
                """), action_params)
                connection.execute(text("""
                    INSERT INTO approvals(id,proposed_action_id,decision,decided_by,rationale,decided_at,review_request_id,idempotency_key)
                    VALUES(CAST(:approval AS uuid),CAST(:action AS uuid),'approved','coordinator-v3-analyst','Explicit analyst approval at native Langflow checkpoint',:now,CAST(:review AS uuid),:approval_key)
                """), action_params)
                connection.execute(text("""
                    INSERT INTO coordinator_v3_action_results(
                      analysis_run_id,case_id,proposed_action_id,idempotency_key,proposal_hash,approval_id,status,result,executed_at
                    ) VALUES(CAST(:run AS uuid),CAST(:case AS uuid),CAST(:action AS uuid),:key,:hash,CAST(:approval AS uuid),'executed',:result,:now)
                """), action_params)
                connection.execute(text("""
                    INSERT INTO coordinator_v3_checkpoints(
                      analysis_run_id,case_id,langflow_job_id,checkpoint_kind,request_id,prompt,status,decision,values,decided_at
                    ) VALUES(CAST(:run AS uuid),CAST(:case AS uuid),:job,'analyst_approval',:request,:prompt,'approved',:decision,:values,:now)
                """), action_params)
        finally:
            engine.dispose()
        return Message(text=_canonical({"status": "executed", "idempotency_key": key, "persisted_action_id": action_id,
                                       "approval_id": approval_id, "persisted_action": result}))

    async def _terminal(self):
        job_id = self._job_id()
        decision = self._decision()
        database_url = await self._database_url()
        engine = create_engine(database_url)
        try:
            with engine.begin() as connection:
                run = connection.execute(text("""
                    SELECT analysis_run_id::text,case_id::text,scenario FROM coordinator_v3_runs WHERE langflow_job_id=:job
                """), {"job": job_id}).mappings().one()
                kind = {
                    "conflict": "conflict_review", "required_failure": "specialist_recovery",
                    "public_research": "analyst_approval", "interrupted": "information_request", "complete": "analyst_approval",
                }[run["scenario"]]
                status = "expired" if self.specialty == "expired" else "rejected"
                connection.execute(text("""
                    INSERT INTO coordinator_v3_checkpoints(
                      analysis_run_id,case_id,langflow_job_id,checkpoint_kind,request_id,prompt,status,decision,values,decided_at
                    ) VALUES(CAST(:run AS uuid),CAST(:case AS uuid),:job,:kind,:request,:prompt,:status,:decision,:values,clock_timestamp())
                    ON CONFLICT DO NOTHING
                """), {"run": run["analysis_run_id"], "case": run["case_id"], "job": job_id, "kind": kind,
                       "request": f"{kind}:{job_id}", "prompt": str(getattr(self.input_one, "text", self.input_one)),
                       "status": status, "decision": decision.get("action_id"), "values": json.dumps(decision.get("values") or {})})
        finally:
            engine.dispose()
        return Message(text=_canonical({"status": "no_action", "reason": self.specialty,
                                       "analysis_run_id": run["analysis_run_id"], "checkpoint_kind": kind}))

    async def run_stage(self):
        methods = {
            "load_context": self._load_context,
            "prepare_task": self._prepare_task,
            "validate_contribution": self._validate,
            "collect": self._collect,
            "resume_specialist": self._resume_specialist,
            "public_research_proposal": self._public_proposal,
            "tinyfish_execute": self._tinyfish_execute,
            "release_public_results": self._release_results,
            "persist_action": self._persist_action,
            "terminal": self._terminal,
        }
        return await methods[self.stage]()
