from __future__ import annotations

import hashlib
import json
import re
import uuid
from datetime import datetime, timezone
from urllib.parse import urlsplit, urlunsplit

import httpx
from sqlalchemy import create_engine, text

from lfx.custom import Component
from lfx.io import MessageTextInput, Output, SecretStrInput
from lfx.schema import Message
from lfx.services.deps import session_scope


def _canonical(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


def _object(value: object) -> dict:
    if isinstance(value, Message): value = value.text
    if isinstance(value, dict): return value
    raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", str(value or "").strip(), flags=re.I)
    parsed = json.loads(raw or "{}")
    if not isinstance(parsed, dict): raise ValueError("TinyFish Fetch request must be one JSON object")
    return parsed


def _assert_pending_operation(run: dict, *, operation_key: str, execution_id: str) -> dict:
    if run.get("phase") != "running" or (run.get("state") or {}).get("status") != "running":
        raise ValueError("TinyFish Fetch requires a running coordinator state")
    pending = (run.get("state") or {}).get("next_action")
    if not isinstance(pending, dict):
        raise ValueError("TinyFish Fetch requires a persisted pending operation")
    route = pending.get("route") or pending.get("next_action")
    if route != "fetch_search_results":
        raise ValueError("TinyFish Fetch requires the persisted fetch_search_results route")
    if pending.get("operation_key") != operation_key:
        raise ValueError("TinyFish Fetch operation_key does not match persisted state")
    if pending.get("search_execution_id") != execution_id:
        raise ValueError("TinyFish Fetch execution_id does not match persisted state")
    return pending


def _domain(value: str) -> str:
    return (urlsplit(value).hostname or "").lower().rstrip(".")


def _allowed(host: str, domains: list[str]) -> bool:
    return any(host == domain or host.endswith("." + domain) for domain in domains)


GLEIF_RECORD_PREFIX = "https://api.gleif.org/api/v1/lei-records/"
COMPANIES_HOUSE_PAGE = re.compile(r"^https://find-and-update\.company-information\.service\.gov\.uk/company/([A-Z0-9]{8})$")
COMPANIES_HOUSE_API = "https://api.company-information.service.gov.uk"


def _registry_source(url: str, companies_house_key: str) -> tuple[str, tuple | None] | None:
    """The official API address for a registry record found by the search step, or None for a web page.

    A registry record is read from the registry itself, not scraped: the result is the registry's own
    data. A Companies House page is read from its API only when a key is configured."""
    if url.startswith(GLEIF_RECORD_PREFIX) and re.fullmatch(r"[A-Z0-9]{20}", url[len(GLEIF_RECORD_PREFIX):]):
        return url, None
    match = COMPANIES_HOUSE_PAGE.match(url)
    if match and companies_house_key:
        return f"{COMPANIES_HOUSE_API}/company/{match.group(1)}", (companies_house_key, "")
    return None


def _labelled(fields: list[tuple[str, object]]) -> str:
    return "\n".join(f"{label}: {value}" for label, value in fields if str(value or "").strip())


def _joined(parts: list[object]) -> str:
    return ", ".join(str(part).strip() for part in parts if str(part or "").strip())


def _gleif_address(address: object) -> str:
    if not isinstance(address, dict): return ""
    return _joined([*(address.get("addressLines") or []), address.get("city"), address.get("region"),
                    address.get("postalCode"), address.get("country")])


def _registry_excerpt(api_url: str, body: object) -> str | None:
    """A registry record as the labelled facts it states, or None when the response is not one.

    The excerpt is what reviewers read and what research extraction is checked against; a JSON
    dump cut at the excerpt limit is neither readable nor complete. The raw response stays the
    stored content, so the content hash still covers exactly what the registry returned."""
    if not isinstance(body, dict): return None
    if api_url.startswith(GLEIF_RECORD_PREFIX):
        data = body.get("data")
        attributes = (data.get("attributes") if isinstance(data, dict) else None) or {}
        entity = attributes.get("entity") or {}
        registration = attributes.get("registration") or {}
        legal_form = entity.get("legalForm") or {}
        return _labelled([
            ("Legal name", (entity.get("legalName") or {}).get("name")),
            ("Other names", "; ".join(str(item.get("name")) for item in entity.get("otherNames") or []
                                      if isinstance(item, dict) and item.get("name"))),
            ("LEI", attributes.get("lei")),
            ("Registered as", entity.get("registeredAs")),
            ("Registration authority", (entity.get("registeredAt") or {}).get("id")),
            ("Jurisdiction", entity.get("jurisdiction")),
            ("Legal form", legal_form.get("other") or legal_form.get("id")),
            ("Entity status", entity.get("status")),
            ("Legal address", _gleif_address(entity.get("legalAddress"))),
            ("Headquarters address", _gleif_address(entity.get("headquartersAddress"))),
            ("LEI registration status", registration.get("status")),
            ("Initial registration date", registration.get("initialRegistrationDate")),
            ("Last update date", registration.get("lastUpdateDate")),
            ("Next renewal date", registration.get("nextRenewalDate")),
        ]) or None
    if api_url.startswith(COMPANIES_HOUSE_API):
        office = body.get("registered_office_address") or {}
        return _labelled([
            ("Company name", body.get("company_name")),
            ("Company number", body.get("company_number")),
            ("Status", body.get("company_status")),
            ("Company type", body.get("type")),
            ("Jurisdiction", body.get("jurisdiction")),
            ("Incorporated on", body.get("date_of_creation")),
            ("Dissolved on", body.get("date_of_cessation")),
            ("Registered office address", _joined([office.get(key) for key in (
                "premises", "address_line_1", "address_line_2", "locality", "region", "postal_code", "country")])),
            ("SIC codes", ", ".join(str(code) for code in body.get("sic_codes") or [])),
            ("Previous names", "; ".join(str(item.get("name")) for item in body.get("previous_company_names") or []
                                         if isinstance(item, dict) and item.get("name"))),
        ]) or None
    return None


def _error_text(exc: Exception) -> str:
    """Timeouts and connection errors often carry no message; the type still says what happened."""
    return f"{type(exc).__name__}: {exc}" if str(exc) else type(exc).__name__


def _persist_recovery_checkpoint(connection, coordinator_run_id: str, analysis_run_id: str, execution_id: str, reason: str) -> dict:
    checkpoint_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"kyb-v3:{analysis_run_id}:fetch-recovery:{execution_id}"))
    request = {
        "schema_version":"1.0","checkpoint_id":checkpoint_id,
        "request_id":f"coord-v3:{analysis_run_id}:fetch-recovery:{execution_id}",
        "checkpoint_version":1,"parent_checkpoint_id":None,"parent_request_id":None,
        "originating_task_id":None,"originating_context_id":None,
        "checkpoint_kind":"conflict_review","title":"Review uncertain web fetch execution",
        "explanation":reason,
        "allowed_actions":["escalate","reject","skip_for_now"],
        "payload":{"search_execution_id":execution_id,"reason":reason},
    }
    return connection.execute(text("""
        SELECT create_simple_coordinator_v3_checkpoint(
          CAST(:coordinator AS uuid),CAST(:request AS jsonb),:key
        )
    """), {"coordinator":coordinator_run_id,"request":_canonical(request),
             "key":f"fetch-recovery:{execution_id}"}).scalar_one()


class KybTinyFishFetchV3(Component):
    display_name = "5b · TinyFish Fetch V3"
    description = "Fetches only candidates from the approved search, stores immutable pages, and enforces separate result acceptance."
    icon = "file-search"
    name = "KybTinyFishFetchV3"
    inputs = [
        MessageTextInput(name="input_value", display_name="Approved Fetch Operation", required=True, tool_mode=True),
        SecretStrInput(name="database_url", display_name="Database URL", value="DATABASE_URL", required=True, advanced=True),
        SecretStrInput(name="tinyfish_key", display_name="TinyFish API Key", value="TINY_FISH_KEY", required=True, advanced=True),
    ]
    outputs = [Output(display_name="Approved Fetch Result", name="result", method="run")]

    async def _secret(self, field: str, variable: str) -> str:
        value = getattr(self, field)
        if hasattr(value,"get_secret_value"): value=value.get_secret_value()
        value=str(value or "").strip().strip("\"'")
        if not value or value==variable or (field=="database_url" and not value.startswith("postgres")):
            async with session_scope() as session: value=await self.get_variable(variable,"value",session)
            if hasattr(value,"get_secret_value"): value=value.get_secret_value()
            value=str(value or "").strip().strip("\"'")
        if field == "database_url":
            # Langflow ships psycopg2 only; normalize like the other V3 components.
            for prefix in ("postgresql+psycopg://", "postgresql+asyncpg://", "postgres://"):
                if value.startswith(prefix):
                    value = "postgresql+psycopg2://" + value[len(prefix):]
        return value

    async def _optional_variable(self, variable: str) -> str:
        """A Langflow global variable that may not be configured; empty when it is absent."""
        try:
            async with session_scope() as session:
                value = await self.get_variable(variable, "value", session)
        except Exception:
            return ""
        if hasattr(value, "get_secret_value"):
            value = value.get_secret_value()
        return str(value or "").strip().strip("\"'")

    async def run(self) -> Message:
        request = _object(self.input_value)
        if request.get("operation") != "fetch_approved_results":
            raise ValueError("TinyFish Fetch supports only fetch_approved_results")
        analysis_run_id = str(uuid.UUID(str(request.get("analysis_run_id") or "")))
        coordinator_run_id = str(uuid.UUID(str(request.get("coordinator_run_id") or "")))
        execution_id = str(uuid.UUID(str(request.get("search_execution_id") or "")))
        operation_key = str(request.get("operation_key") or "").strip()
        if not operation_key:
            raise ValueError("TinyFish Fetch requires a stable operation_key")
        engine = create_engine(await self._secret("database_url", "DATABASE_URL"))
        try:
            with engine.begin() as connection:
                run = connection.execute(text("""
                    SELECT id::text AS coordinator_run_id,analysis_run_id::text,case_id::text,
                           session_id,state,phase,langflow_job_id
                    FROM coordinator_v3_runs
                    WHERE id=CAST(:coordinator AS uuid)
                      AND analysis_run_id=CAST(:run AS uuid)
                      AND engine_version='durable-loop-v1'
                    FOR UPDATE
                """), {"coordinator": coordinator_run_id, "run": analysis_run_id}).mappings().one()
                _assert_pending_operation(dict(run), operation_key=operation_key, execution_id=execution_id)
                approved = dict(run["state"]).get("approved_search") or {}
                if approved.get("search_execution_id") != execution_id:
                    raise ValueError("Fetch execution does not match the persisted approved search")
                execution = connection.execute(text("""
                    SELECT proposed_action_id::text,approval_id::text,status,allowed_domains,max_results
                    FROM web_search_executions
                    WHERE id=CAST(:execution AS uuid)
                      AND analysis_run_id=CAST(:run AS uuid)
                      AND case_id=CAST(:case AS uuid)
                    FOR UPDATE
                """), {"execution":execution_id,"run":analysis_run_id,"case":run["case_id"]}).mappings().one()
                if execution["status"] != "succeeded":
                    raise ValueError("TinyFish Fetch requires a successfully persisted approved search")
                existing = [dict(row) for row in connection.execute(text("""
                    SELECT id::text,url,canonical_url,title,publisher,retrieved_at,
                           excerpt,content_hash
                    FROM external_web_evidence
                    WHERE search_execution_id=CAST(:execution AS uuid)
                    ORDER BY id
                """), {"execution":execution_id}).mappings()]
                candidates = [dict(row) for row in connection.execute(text("""
                    SELECT url,canonical_url,title,site_name,snippet,rank
                    FROM coordinator_v3_search_candidates
                    WHERE search_execution_id=CAST(:execution AS uuid)
                    ORDER BY rank
                """), {"execution":execution_id}).mappings()]
                if not candidates:
                    raise ValueError("Approved search has no persisted candidates")
                state = dict(run["state"])
                if existing:
                    return Message(text=_canonical({
                        "status":"duplicate_suppressed",
                        "search_execution_id":execution_id,
                        "result_count":len(existing),
                    }), session_id=run["session_id"])
                if not existing:
                    if state.get("fetch_status") in {"in_progress", "failed"}:
                        recovery = _persist_recovery_checkpoint(
                            connection, coordinator_run_id, analysis_run_id, execution_id,
                            "The external fetch was already claimed without a complete persisted result set. It will not be replayed automatically.",
                        )
                        return Message(text=_canonical({"status":"waiting_for_human","checkpoint":recovery}),session_id=run["session_id"])
                    connection.execute(text("""
                        UPDATE coordinator_v3_runs
                        SET state_version=state_version+1,
                            state=state || jsonb_build_object(
                              'fetch_status','in_progress',
                              'fetch_execution_id',:execution,
                              'fetch_operation_key',:operation_key,
                              'updated_at',clock_timestamp()
                            ),updated_at=clock_timestamp()
                        WHERE id=CAST(:coordinator AS uuid)
                    """), {"execution":execution_id,"operation_key":operation_key,"coordinator":coordinator_run_id})

            # Existing immutable pages are a successful durable provider outcome, even
            # when the worker crashed before it could create the review checkpoint.
            pages = existing
            if not pages:
                urls = [row["canonical_url"] for row in candidates][:execution["max_results"]]
                allowed_domains = list(execution["allowed_domains"] or [])
                companies_house_key = await self._optional_variable("COMPANIES_HOUSE_API_KEY")
                registry = {url: _registry_source(url, companies_house_key) for url in urls}
                web_urls = [url for url in urls if registry[url] is None]
                titles = {row["canonical_url"]: row["title"] for row in candidates}
                fetched, errors = [], []
                async with httpx.AsyncClient(timeout=90, follow_redirects=False) as client:
                    for url, source in registry.items():
                        if source is None:
                            continue
                        api_url, auth = source
                        try:
                            response = await client.get(api_url, auth=auth)
                            response.raise_for_status()
                            body = response.json()
                            fetched.append({"url": url, "final_url": url, "title": titles.get(url),
                                            "text": json.dumps(body, indent=2, ensure_ascii=False),
                                            "registry_excerpt": _registry_excerpt(api_url, body)})
                        except Exception as exc:
                            errors.append(f"{_domain(url)}: {_error_text(exc)}")
                    if web_urls:
                        try:
                            api_key = await self._secret("tinyfish_key", "TINY_FISH_KEY")
                            if not api_key:
                                raise ValueError("Server-side TINY_FISH_KEY is unavailable")
                            response = await client.post(
                                "https://api.fetch.tinyfish.ai",
                                json={"urls": web_urls, "format": "markdown"},
                                headers={"X-API-Key": api_key, "Content-Type": "application/json", "Idempotency-Key": operation_key},
                            )
                            response.raise_for_status()
                            body = response.json()
                            if not isinstance(body, dict) or (body.get("results") is not None and not isinstance(body.get("results"), list)):
                                raise ValueError("TinyFish Fetch returned invalid results")
                            fetched.extend(item for item in body.get("results") or [] if isinstance(item, dict))
                        except Exception as exc:
                            # Web pages failing does not discard registry records already read.
                            errors.append(f"TinyFish fetch: {_error_text(exc)}")
                if not fetched and errors:
                    with engine.begin() as connection:
                        current = connection.execute(text("""
                            SELECT state,phase FROM coordinator_v3_runs
                            WHERE id=CAST(:coordinator AS uuid) FOR UPDATE
                        """), {"coordinator":coordinator_run_id}).mappings().one()
                        _assert_pending_operation(dict(current), operation_key=operation_key, execution_id=execution_id)
                        connection.execute(text("""
                            UPDATE coordinator_v3_runs
                            SET state_version=state_version+1,
                                state=state || jsonb_build_object(
                                  'fetch_status','failed','fetch_error',:error,
                                  'updated_at',clock_timestamp()
                                ),updated_at=clock_timestamp()
                            WHERE id=CAST(:coordinator AS uuid)
                        """), {"coordinator":coordinator_run_id,"error":"; ".join(errors)[:2000]})
                        recovery = _persist_recovery_checkpoint(
                            connection, coordinator_run_id, analysis_run_id, execution_id,
                            f"Fetching the approved results failed after its one permitted attempt ({'; '.join(errors)[:600]}). "
                            "Automatic replay is disabled.",
                        )
                    return Message(text=_canonical({"status":"waiting_for_human","checkpoint":recovery}),session_id=run["session_id"])
                pages = []
                for raw in fetched:
                    source = str(raw.get("url") or "")
                    final = str(raw.get("final_url") or source)
                    if source not in urls or urlsplit(final).scheme != "https" or not _allowed(_domain(final), allowed_domains):
                        continue
                    canonical_url = urlunsplit(("https", urlsplit(final).netloc.lower(), urlsplit(final).path or "/", urlsplit(final).query, ""))
                    content = str(raw.get("text") or "")[:50000]
                    checksum = "sha256:" + hashlib.sha256(content.encode()).hexdigest()
                    pages.append({
                        "id": str(uuid.uuid5(uuid.NAMESPACE_URL, f"{execution_id}:{canonical_url}:{checksum}")),
                        "query": approved["approved_plan"]["query"],
                        "approved_scope": approved["approved_plan"],
                        "url": source,
                        "canonical_url": canonical_url,
                        "title": str(raw.get("title") or canonical_url)[:1000],
                        "publisher": _domain(canonical_url),
                        "retrieved_at": datetime.now(timezone.utc).isoformat(),
                        "excerpt": str(raw.get("registry_excerpt") or content)[:5000],
                        "content": content,
                        "checksum": checksum,
                        "retrieval_method": "registry_api" if registry.get(source) else "tinyfish_fetch",
                    })
                if not pages:
                    with engine.begin() as connection:
                        current = connection.execute(text("""
                            SELECT state,phase FROM coordinator_v3_runs
                            WHERE id=CAST(:coordinator AS uuid) FOR UPDATE
                        """), {"coordinator":coordinator_run_id}).mappings().one()
                        _assert_pending_operation(dict(current), operation_key=operation_key, execution_id=execution_id)
                        connection.execute(text("""
                            UPDATE coordinator_v3_runs
                            SET state_version=state_version+1,
                                state=state || jsonb_build_object(
                                  'fetch_status','failed',
                                  'fetch_error','TinyFish Fetch returned no eligible approved pages',
                                  'updated_at',clock_timestamp()
                                ),updated_at=clock_timestamp()
                            WHERE id=CAST(:coordinator AS uuid)
                        """), {"coordinator":coordinator_run_id})
                        recovery = _persist_recovery_checkpoint(
                            connection, coordinator_run_id, analysis_run_id, execution_id,
                            "The approved fetch returned no eligible pages. It will not be replayed automatically.",
                        )
                    return Message(text=_canonical({"status":"waiting_for_human","checkpoint":recovery}),session_id=run["session_id"])
                with engine.begin() as connection:
                    current = connection.execute(text("""
                        SELECT state,phase FROM coordinator_v3_runs
                        WHERE id=CAST(:coordinator AS uuid) FOR UPDATE
                    """), {"coordinator":coordinator_run_id}).mappings().one()
                    _assert_pending_operation(dict(current), operation_key=operation_key, execution_id=execution_id)
                    for page in pages:
                        connection.execute(text("""
                            SELECT record_coordinator_v3_web_result(
                              CAST(:execution AS uuid),CAST(:approval AS uuid),CAST(:run AS uuid),
                              CAST(:case AS uuid),CAST(:result_id AS uuid),CAST(:payload AS jsonb)
                            )
                        """), {"execution":execution_id,"approval":execution["approval_id"],"run":analysis_run_id,
                                 "case":run["case_id"],"result_id":page["id"],"payload":_canonical(page)})

            checkpoint_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"kyb-v3:{analysis_run_id}:web-result-review:{execution_id}"))
            request_id = f"coord-v3:{analysis_run_id}:web-result-review:{execution_id}"
            checkpoint = {
                "schema_version":"1.0","checkpoint_id":checkpoint_id,"request_id":request_id,
                "checkpoint_version":1,"parent_checkpoint_id":None,"parent_request_id":None,
                "originating_task_id":None,"originating_context_id":None,
                "checkpoint_kind":"web_result_review","title":"Review immutable web evidence",
                "explanation":"Accept or reject each immutable result before Public Research may use it.",
                "allowed_actions":["accept","reject","skip_for_now"],
                "payload":{"pending_results":[{
                    "result_id":row["id"],"url":row["canonical_url"],"title":row["title"],
                    "publisher":row["publisher"],"checksum":row.get("checksum") or row["content_hash"]
                } for row in pages]},
            }
            with engine.begin() as connection:
                current = connection.execute(text("""
                    SELECT state,phase FROM coordinator_v3_runs
                    WHERE id=CAST(:coordinator AS uuid) FOR UPDATE
                """), {"coordinator":coordinator_run_id}).mappings().one()
                _assert_pending_operation(dict(current), operation_key=operation_key, execution_id=execution_id)
                result = connection.execute(text("""
                    SELECT create_simple_coordinator_v3_checkpoint(
                      CAST(:coordinator AS uuid),CAST(:request AS jsonb),:key
                    )
                """), {"coordinator":coordinator_run_id,"request":_canonical(checkpoint),"key":operation_key+":review"}).scalar_one()
                connection.execute(text("""
                    UPDATE coordinator_v3_runs
                    SET state=state || jsonb_build_object(
                      'fetch_status','succeeded','fetch_execution_id',:execution,
                      'updated_at',clock_timestamp()
                    ),updated_at=clock_timestamp()
                    WHERE id=CAST(:coordinator AS uuid)
                """), {"coordinator":coordinator_run_id,"execution":execution_id})
            self.status = f"Awaiting review of {len(pages)} immutable TinyFish page(s)"
            return Message(text=_canonical({"status":"waiting_for_human","search_execution_id":execution_id,
                                            "result_count":len(pages),"checkpoint":result}),session_id=run["session_id"])
        finally:
            engine.dispose()
