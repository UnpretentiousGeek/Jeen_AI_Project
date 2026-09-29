from __future__ import annotations

import hashlib
import json
import re
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit, urlunsplit

import httpx
from sqlalchemy import create_engine, text

from lfx.custom import Component
from lfx.io import MessageTextInput, Output, SecretStrInput
from lfx.schema import Message
from lfx.services.deps import session_scope


ALLOWED_DISCLOSURES = {
    "legal_name", "claimed_license_type", "jurisdiction", "product",
    "registration_number", "official_domain",
}


def _canonical(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


def _object(value: object) -> dict:
    if isinstance(value, Message):
        value = value.text
    if isinstance(value, dict):
        return value
    raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", str(value or "").strip(), flags=re.I)
    parsed = json.loads(raw or "{}")
    if not isinstance(parsed, dict):
        raise ValueError("TinyFish Search request must be one JSON object")
    return parsed


def _domain(value: str) -> str:
    parsed = urlsplit(value if "://" in value else f"https://{value}")
    return (parsed.hostname or "").lower().rstrip(".")


def _allowed(host: str, domains: list[str]) -> bool:
    return any(host == domain or host.endswith("." + domain) for domain in domains)


def _canonical_url(value: str) -> str:
    parsed = urlsplit(value)
    if parsed.scheme != "https" or not parsed.hostname:
        raise ValueError("TinyFish candidate URL must use HTTPS")
    return urlunsplit(("https", parsed.netloc.lower(), parsed.path or "/", parsed.query, ""))


def _canonical_scope(value: object) -> dict:
    if not isinstance(value, dict):
        raise ValueError("Approved search scope must be an object")
    domains = sorted({
        _domain(item) for item in (
            str(raw).strip() if "://" in str(raw) else f"https://{str(raw).strip()}"
            for raw in value.get("allowed_domains") or []
        ) if item
    })
    disclosures = sorted({str(item).strip() for item in value.get("disclosed_applicant_fields") or [] if str(item).strip()})
    return {
        "evidence_gap_id": str(value.get("evidence_gap_id") or ""),
        "claim_id": str(value.get("claim_id") or ""),
        "claim": str(value.get("claim") or ""),
        "query": str(value.get("query") or "").strip(),
        "allowed_domains": domains,
        "disclosed_applicant_fields": disclosures,
        "result_limit": int(value.get("result_limit") or 0),
        "rationale": str(value.get("rationale") or "").strip(),
    }


def _scope_hash(value: object) -> str:
    return hashlib.sha256(_canonical(_canonical_scope(value)).encode()).hexdigest()


GLEIF_API = "https://api.gleif.org/api/v1/lei-records"
COMPANIES_HOUSE_API = "https://api.company-information.service.gov.uk"
COMPANIES_HOUSE_SITE = "https://find-and-update.company-information.service.gov.uk"
# Official registries looked up through their own APIs, keyed by the approved domain they serve.
# Registry records sit behind search forms, so web search rarely finds them; an approved domain
# without an adapter is searched on the web instead.
REGISTRY_ADAPTERS = {"gleif.org": "gleif", "company-information.service.gov.uk": "companies_house"}


class RegistryUnavailable(Exception):
    """A registry adapter cannot run, for example because its API key is not configured."""


def _disclosed_applicant(snapshot: dict, disclosures: list[str]) -> dict:
    """Only the applicant values the analyst approved for disclosure, taken from the run's snapshot."""
    applicant = snapshot.get("applicant") or {}
    declaration = (snapshot.get("submitted_payload") or {}).get("entity_declaration") or {}
    values = {}
    if "legal_name" in disclosures and str(applicant.get("legal_name") or "").strip():
        values["legal_name"] = str(applicant["legal_name"]).strip()
    if "jurisdiction" in disclosures and str(applicant.get("jurisdiction") or "").strip():
        values["jurisdiction"] = str(applicant["jurisdiction"]).strip().upper()
    if "registration_number" in disclosures:
        number = next((str(item.get("value") or "").strip() for item in declaration.get("identifiers") or []
                       if isinstance(item, dict) and item.get("type") == "registration_number"), "")
        if number:
            values["registration_number"] = number
    return values


# Legal forms written differently by registries and applicants ("P.L.C." / "plc", "Limited" / "Ltd").
LEGAL_FORMS = {
    "LIMITED": "LTD", "PUBLIC LIMITED COMPANY": "PLC", "P L C": "PLC", "INCORPORATED": "INC",
    "CORPORATION": "CORP", "COMPANY": "CO", "L L C": "LLC", "LIMITED LIABILITY COMPANY": "LLC",
}


def _name_key(value: object) -> str:
    """A legal name compared the way registries mean it: case, punctuation and legal-form spelling ignored."""
    key = " ".join(re.sub(r"[^A-Z0-9]+", " ", str(value or "").upper()).split())
    for form, short in sorted(LEGAL_FORMS.items(), key=lambda item: -len(item[0])):
        key = re.sub(rf"(?<![A-Z0-9]){form}$", short, key)
    return key


def _record(url: str, name: object, title: str, site_name: str, fields: list[tuple[str, object]]) -> dict:
    snippet = "; ".join(f"{label}: {value}" for label, value in fields if str(value or "").strip())
    return {"url": url, "name": str(name or ""), "title": title, "site_name": site_name, "snippet": snippet}


def _gleif_rows(body: dict) -> list[dict]:
    rows = []
    for record in body.get("data") or []:
        attributes = record.get("attributes") or {}
        entity = attributes.get("entity") or {}
        lei = str(attributes.get("lei") or record.get("id") or "")
        name = (entity.get("legalName") or {}).get("name")
        address = entity.get("legalAddress") or {}
        rows.append(_record(f"{GLEIF_API}/{lei}", name, f"GLEIF LEI record: {name} ({lei})", "GLEIF LEI Register (official API)", [
            ("Legal name", name), ("LEI", lei), ("Registered as", entity.get("registeredAs")),
            ("Registration authority", (entity.get("registeredAt") or {}).get("id")),
            ("Jurisdiction", entity.get("jurisdiction")), ("Entity status", entity.get("status")),
            ("Legal address", ", ".join(str(item) for item in [*(address.get("addressLines") or []), address.get("city"),
                                                               address.get("region"), address.get("postalCode"),
                                                               address.get("country")] if item)),
            ("LEI registration status", (attributes.get("registration") or {}).get("status")),
        ]))
    return rows


def _companies_house_rows(companies: list[dict]) -> list[dict]:
    rows = []
    for company in companies:
        number = str(company.get("company_number") or "")
        name = company.get("company_name") or company.get("title")
        office = company.get("registered_office_address") or {}
        address = company.get("address_snippet") or ", ".join(str(office.get(key)) for key in (
            "address_line_1", "address_line_2", "locality", "region", "postal_code", "country") if office.get(key))
        rows.append(_record(f"{COMPANIES_HOUSE_SITE}/company/{number}", name, f"Companies House: {name} ({number})",
                            "Companies House (official API)", [
            ("Company name", name), ("Company number", number), ("Status", company.get("company_status")),
            ("Incorporated on", company.get("date_of_creation")), ("Company type", company.get("company_type") or company.get("type")),
            ("Registered office address", address),
        ]))
    return rows


def _exact_only(rows: list[dict], legal_name: str | None) -> list[dict]:
    """A registry name search also returns similar names; only the applicant's exact legal name is a match.

    A similar name is a different company, and offering it for review invites accepting the wrong
    entity as evidence. With no exact match the lookup finds nothing, which is itself the answer."""
    wanted = _name_key(legal_name)
    return [row for row in rows if wanted and _name_key(row["name"]) == wanted]


async def _gleif_lookup(client, applicant: dict, limit: int, _key: str) -> list[dict]:
    base = {"page[size]": str(limit)}
    if applicant.get("jurisdiction"):
        base["filter[entity.jurisdiction]"] = applicant["jurisdiction"]
    if applicant.get("registration_number"):
        response = await client.get(GLEIF_API, params={**base, "filter[entity.registeredAs]": applicant["registration_number"]})
        response.raise_for_status()
        rows = _gleif_rows(response.json())
        if rows:
            return rows
    if applicant.get("legal_name"):
        response = await client.get(GLEIF_API, params={**base, "filter[entity.legalName]": applicant["legal_name"]})
        response.raise_for_status()
        return _exact_only(_gleif_rows(response.json()), applicant["legal_name"])
    return []


async def _companies_house_lookup(client, applicant: dict, limit: int, key: str) -> list[dict]:
    if not key:
        raise RegistryUnavailable("COMPANIES_HOUSE_API_KEY is not configured in Langflow")
    if applicant.get("jurisdiction") and applicant["jurisdiction"].split("-")[0] != "GB":
        return []
    number = re.sub(r"\s+", "", applicant.get("registration_number") or "").upper()
    if number:
        response = await client.get(f"{COMPANIES_HOUSE_API}/company/{number}", auth=(key, ""))
        if response.status_code != 404:
            response.raise_for_status()
            return _companies_house_rows([response.json()])
    if applicant.get("legal_name"):
        response = await client.get(f"{COMPANIES_HOUSE_API}/search/companies",
                                    params={"q": applicant["legal_name"], "items_per_page": str(limit)}, auth=(key, ""))
        response.raise_for_status()
        return _exact_only(_companies_house_rows(response.json().get("items") or []), applicant["legal_name"])
    return []


LOOKUPS = {"gleif": _gleif_lookup, "companies_house": _companies_house_lookup}


def _web_query(query: str, domains: list[str]) -> str:
    """Restrict the approved query to the approved domains; the result filter still applies."""
    return f"{query} ({' OR '.join(f'site:{domain}' for domain in domains)})" if domains else query


def _assert_pending_operation(run: dict, *, operation_key: str, scope_hash: str) -> dict:
    """Fail closed unless this invocation owns the exact persisted search route."""
    if run.get("phase") != "running" or (run.get("state") or {}).get("status") != "running":
        raise ValueError("TinyFish Search requires a running coordinator state")
    pending = (run.get("state") or {}).get("next_action")
    if not isinstance(pending, dict):
        raise ValueError("TinyFish Search requires a persisted pending operation")
    route = pending.get("route") or pending.get("next_action")
    if route != "execute_search":
        raise ValueError("TinyFish Search requires the persisted execute_search route")
    if pending.get("operation_key") != operation_key:
        raise ValueError("TinyFish Search operation_key does not match persisted state")
    if pending.get("scope_hash") != scope_hash:
        raise ValueError("TinyFish Search scope_hash does not match persisted state")
    return pending


def _persist_recovery_checkpoint(connection, coordinator_run_id: str, analysis_run_id: str, execution_id: str, reason: str,
                                 allow_continue: bool = False) -> dict:
    checkpoint_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"kyb-v3:{analysis_run_id}:search-recovery:{execution_id}"))
    request = {
        "schema_version":"1.0","checkpoint_id":checkpoint_id,
        "request_id":f"coord-v3:{analysis_run_id}:search-recovery:{execution_id}",
        "checkpoint_version":1,"parent_checkpoint_id":None,"parent_request_id":None,
        "originating_task_id":None,"originating_context_id":None,
        "checkpoint_kind":"conflict_review","title":"Review uncertain web search execution",
        "explanation":reason,
        # A completed search that found nothing may be continued past: the evidence gap stays open.
        "allowed_actions":(["continue_without_evidence"] if allow_continue else [])+["escalate","reject","skip_for_now"],
        "payload":{"search_execution_id":execution_id,"reason":reason},
    }
    return connection.execute(text("""
        SELECT create_simple_coordinator_v3_checkpoint(
          CAST(:coordinator AS uuid),CAST(:request AS jsonb),:key
        )
    """), {"coordinator":coordinator_run_id,"request":_canonical(request),
             "key":f"search-recovery:{execution_id}"}).scalar_one()


class KybTinyFishSearchV3(Component):
    display_name = "5a · TinyFish Search V3"
    description = "Executes one exact analyst-approved lookup (official registry APIs, then TinyFish web search) and immutably stores its bounded in-domain candidate set."
    icon = "search-check"
    name = "KybTinyFishSearchV3"

    inputs = [
        MessageTextInput(name="input_value", display_name="Approved Search Operation", required=True, tool_mode=True),
        SecretStrInput(name="database_url", display_name="Database URL", value="DATABASE_URL", required=True, advanced=True),
        SecretStrInput(name="tinyfish_key", display_name="TinyFish API Key", value="TINY_FISH_KEY", required=True, advanced=True),
    ]
    outputs = [Output(display_name="Approved Search Result", name="result", method="run")]

    async def _secret(self, field: str, variable: str) -> str:
        value = getattr(self, field)
        if hasattr(value, "get_secret_value"):
            value = value.get_secret_value()
        value = str(value or "").strip().strip("\"'")
        if not value or value == variable or (field == "database_url" and not value.startswith("postgres")):
            async with session_scope() as session:
                value = await self.get_variable(variable, "value", session)
            if hasattr(value, "get_secret_value"):
                value = value.get_secret_value()
            value = str(value or "").strip().strip("\"'")
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

    @staticmethod
    def _scope(checkpoint: dict) -> dict:
        values = checkpoint.get("values") or {}
        supplied = values.get("approved_scope")
        if not isinstance(supplied, dict):
            try:
                prompt = json.loads(checkpoint["prompt"])
            except (KeyError, TypeError, json.JSONDecodeError) as exc:
                raise ValueError("Search approval prompt must disclose one canonical JSON scope") from exc
            supplied = prompt.get("approved_scope", prompt)
        if not isinstance(supplied, dict):
            raise ValueError("Approved search scope is unavailable")
        query = str(supplied.get("query") or "").strip()
        normalized = _canonical_scope(supplied)
        query = normalized["query"]
        domains = normalized["allowed_domains"]
        disclosures = normalized["disclosed_applicant_fields"]
        limit = normalized["result_limit"]
        if not query or len(query) > 500:
            raise ValueError("Approved query is empty or too long")
        if not 1 <= len(domains) <= 8 or any(not item for item in domains):
            raise ValueError("Approved domains must contain 1-8 hostnames")
        if not disclosures or not set(disclosures).issubset(ALLOWED_DISCLOSURES):
            raise ValueError("Approved disclosure is outside the public-data allowlist")
        if not 1 <= limit <= 10:
            raise ValueError("Approved result limit must be between 1 and 10")
        return normalized

    async def run(self) -> Message:
        request = _object(self.input_value)
        if request.get("operation") != "execute_approved_search":
            raise ValueError("TinyFish Search supports only execute_approved_search")
        analysis_run_id = str(uuid.UUID(str(request.get("analysis_run_id") or "")))
        coordinator_run_id = str(uuid.UUID(str(request.get("coordinator_run_id") or "")))
        operation_key = str(request.get("operation_key") or "").strip()
        expected_scope_hash = str(request.get("scope_hash") or "")
        if not operation_key or not re.fullmatch(r"[0-9a-f]{64}", expected_scope_hash):
            raise ValueError("TinyFish Search requires the exact approved operation_key and scope_hash")
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
                _assert_pending_operation(dict(run), operation_key=operation_key, scope_hash=expected_scope_hash)
                checkpoint = connection.execute(text("""
                    SELECT request_id,request_payload,values,decision,status
                    FROM coordinator_v3_checkpoints
                    WHERE analysis_run_id=CAST(:run AS uuid)
                      AND langflow_job_id=:logical_job
                      AND checkpoint_kind='search_execution_approval'
                    ORDER BY decided_at DESC NULLS LAST,created_at DESC LIMIT 1
                """), {"run": analysis_run_id, "logical_job": run["langflow_job_id"]}).mappings().one_or_none()
                if checkpoint is None or checkpoint["status"] != "approved" or checkpoint["decision"] != "approve":
                    raise ValueError("TinyFish requires an exact persisted Search Execution Approval")
                request_payload = dict(checkpoint["request_payload"])
                payload = request_payload.get("payload") if isinstance(request_payload.get("payload"), dict) else {}
                scope = self._scope({"values": {"approved_scope": payload.get("approved_scope")}})
                scope_digest = _scope_hash(scope)
                if (payload.get("scope_hash") != expected_scope_hash
                        or payload.get("operation_key") != operation_key
                        or scope_digest != expected_scope_hash):
                    raise ValueError("Approved TinyFish search scope hash drifted")
                snapshot = connection.execute(text("""
                    SELECT case_snapshot FROM analysis_runs WHERE id=CAST(:run AS uuid)
                """), {"run": analysis_run_id}).scalar_one() or {}
                applicant = _disclosed_applicant(snapshot, scope["disclosed_applicant_fields"])
                action_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"kyb-v3:{analysis_run_id}:search-action:{scope_digest}"))
                review_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"kyb-v3:{analysis_run_id}:search-review:{scope_digest}"))
                approval_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"kyb-v3:{analysis_run_id}:search-approval:{scope_digest}"))
                execution_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"kyb-v3:{analysis_run_id}:search-execution:{scope_digest}"))
                existing = list(connection.execute(text("""
                    SELECT id::text,url,canonical_url,title,site_name,snippet,rank
                    FROM coordinator_v3_search_candidates WHERE search_execution_id=CAST(:execution AS uuid)
                    ORDER BY rank
                """), {"execution": execution_id}).mappings())
                prior_execution = connection.execute(text("""
                    SELECT status,claimed_at,completed_at,error_code,error_message
                    FROM web_search_executions WHERE id=CAST(:execution AS uuid)
                    FOR UPDATE
                """), {"execution": execution_id}).mappings().one_or_none()
                if existing:
                    return Message(text=_canonical({"status":"duplicate_suppressed","search_execution_id":execution_id,"approved_plan":scope,"candidates":[dict(row) for row in existing]}), session_id=run["session_id"])
                if prior_execution is not None:
                    recovery = _persist_recovery_checkpoint(
                        connection, coordinator_run_id, analysis_run_id, execution_id,
                        "The external search was already claimed without a complete persisted candidate set. It will not be replayed automatically.",
                    )
                    return Message(text=_canonical({"status":"waiting_for_human","checkpoint":recovery}),session_id=run["session_id"])
                payload = {
                    "query": scope["query"], "reason": scope["rationale"],
                    "allowed_domains": scope["allowed_domains"], "max_results": scope["result_limit"],
                    "intended_use": scope["rationale"], "external_disclosure": scope["disclosed_applicant_fields"],
                    "claim_id": scope["claim_id"], "claim": scope["claim"],
                    "operation_key": operation_key, "scope_hash": expected_scope_hash,
                }
                params = {"action": action_id,"review":review_id,"approval":approval_id,"execution":execution_id,
                          "run":run["analysis_run_id"],"case":run["case_id"],"payload":_canonical(payload),
                          "summary":f"Execute approved bounded search for {scope['claim_id'] or 'documented gap'}",
                          "action_key":f"coord-v3-search:{analysis_run_id}:{scope_digest}",
                          "correlation":f"coord-v3-search:{analysis_run_id}:{scope_digest}","approval_key":f"coord-v3-search-approval:{analysis_run_id}:{scope_digest}",
                          "query":scope["query"],"domains":scope["allowed_domains"],"limit":scope["result_limit"],
                          "use":scope["rationale"],"disclosure":scope["disclosed_applicant_fields"],
                          "expires":datetime.now(timezone.utc)+timedelta(minutes=30)}
                connection.execute(text("""
                    INSERT INTO proposed_actions(id,analysis_run_id,case_id,action_type,summary,payload,status,idempotency_key)
                    VALUES(CAST(:action AS uuid),CAST(:run AS uuid),CAST(:case AS uuid),'run_web_search',:summary,CAST(:payload AS jsonb),'approved',:action_key)
                    ON CONFLICT (idempotency_key) DO NOTHING
                """), params)
                connection.execute(text("""
                    INSERT INTO review_requests(id,proposed_action_id,analysis_run_id,case_id,correlation_id,status,decided_at)
                    VALUES(CAST(:review AS uuid),CAST(:action AS uuid),CAST(:run AS uuid),CAST(:case AS uuid),:correlation,'decided',clock_timestamp())
                    ON CONFLICT (id) DO NOTHING
                """), params)
                connection.execute(text("""
                    INSERT INTO approvals(id,proposed_action_id,review_request_id,decision,decided_by,rationale,decided_at,idempotency_key)
                    VALUES(CAST(:approval AS uuid),CAST(:action AS uuid),CAST(:review AS uuid),'approved','coordinator-v3-analyst',
                      'Exact persisted Langflow search scope approved',clock_timestamp(),:approval_key)
                    ON CONFLICT (idempotency_key) DO NOTHING
                """), params)
                params["scope_hash"] = scope_digest
                connection.execute(text("""
                    INSERT INTO web_search_executions(id,proposed_action_id,approval_id,analysis_run_id,case_id,query,allowed_domains,
                      max_results,intended_use,external_disclosure,scope_hash,status,expires_at,claimed_at)
                    VALUES(CAST(:execution AS uuid),CAST(:action AS uuid),CAST(:approval AS uuid),CAST(:run AS uuid),CAST(:case AS uuid),
                      :query,:domains,:limit,:use,:disclosure,:scope_hash,'running',:expires,clock_timestamp())
                    ON CONFLICT (id) DO NOTHING
                """), params)

            # Registries with an API are looked up directly with only the approved applicant values;
            # when none finds the applicant, the remaining approved domains are searched on the web.
            # Each provider runs once.
            registry_domains = [domain for domain in scope["allowed_domains"] if domain in REGISTRY_ADAPTERS]
            web_domains = [domain for domain in scope["allowed_domains"] if domain not in REGISTRY_ADAPTERS]
            raw_results, attempts, provider_request_id = [], [], None
            async with httpx.AsyncClient(timeout=30, follow_redirects=False) as client:
                for domain in registry_domains:
                    adapter = REGISTRY_ADAPTERS[domain]
                    try:
                        key = await self._optional_variable("COMPANIES_HOUSE_API_KEY") if adapter == "companies_house" else ""
                        found = await LOOKUPS[adapter](client, applicant, scope["result_limit"], key)
                        raw_results.extend(found)
                        attempts.append({"provider": adapter, "status": "ok", "results": len(found)})
                    except RegistryUnavailable as exc:
                        # An adapter that cannot run leaves its registry to the web search.
                        web_domains.append(domain)
                        attempts.append({"provider": adapter, "status": "skipped", "error": str(exc)[:300]})
                    except Exception as exc:
                        attempts.append({"provider": adapter, "status": "error", "error": str(exc)[:300]})
                # The web is the fallback: a registry's own record is authoritative, and a web search
                # beside it only adds pages that merely mention the name or number.
                if web_domains and not raw_results:
                    try:
                        api_key = await self._secret("tinyfish_key", "TINY_FISH_KEY")
                        if not api_key:
                            raise ValueError("Server-side TINY_FISH_KEY is unavailable")
                        response = await client.get("https://api.search.tinyfish.ai",
                                                    params={"query": _web_query(scope["query"], web_domains)},
                                                    headers={"X-API-Key": api_key, "Idempotency-Key": execution_id})
                        response.raise_for_status()
                        body = response.json()
                        if not isinstance(body, dict) or (body.get("results") is not None and not isinstance(body.get("results"), list)):
                            raise ValueError("TinyFish Search returned invalid results")
                        provider_request_id = response.headers.get("x-request-id")
                        raw_results.extend(item for item in body.get("results") or [] if isinstance(item, dict))
                        attempts.append({"provider": "tinyfish_web_search", "status": "ok", "results": len(body.get("results") or [])})
                    except Exception as exc:
                        attempts.append({"provider": "tinyfish_web_search", "status": "error", "error": str(exc)[:300]})
            attempt_summary = "; ".join(
                f"{item['provider']}: {item['results']} result(s)" if item["status"] == "ok" else f"{item['provider']}: {item['error']}"
                for item in attempts)
            if attempts and all(item["status"] != "ok" for item in attempts):
                with engine.begin() as connection:
                    current = connection.execute(text("""
                        SELECT state,phase FROM coordinator_v3_runs
                        WHERE id=CAST(:coordinator AS uuid) FOR UPDATE
                    """), {"coordinator":coordinator_run_id}).mappings().one()
                    _assert_pending_operation(dict(current), operation_key=operation_key, scope_hash=expected_scope_hash)
                    connection.execute(text("""
                        UPDATE web_search_executions
                        SET status='failed',completed_at=clock_timestamp(),
                            error_code='provider_request_failed',error_message=:error
                        WHERE id=CAST(:execution AS uuid) AND status='running'
                    """), {"execution": execution_id, "error": attempt_summary[:2000]})
                    recovery = _persist_recovery_checkpoint(
                        connection, coordinator_run_id, analysis_run_id, execution_id,
                        f"Every approved source failed after its one permitted attempt ({attempt_summary}). Automatic replay is disabled.",
                    )
                return Message(text=_canonical({"status":"waiting_for_human","checkpoint":recovery}),session_id=run["session_id"])
            candidates, seen_urls = [], set()
            for raw in raw_results:
                if len(candidates) >= scope["result_limit"]:
                    break
                try:
                    canonical = _canonical_url(str(raw.get("url") or ""))
                except ValueError:
                    continue
                if canonical in seen_urls or not _allowed(_domain(canonical), scope["allowed_domains"]):
                    continue
                seen_urls.add(canonical)
                row = {"id":str(uuid.uuid5(uuid.NAMESPACE_URL,f"{execution_id}:{canonical}")),"url":canonical,
                       "canonical_url":canonical,"title":str(raw.get("title") or canonical)[:1000],
                       "site_name":str(raw.get("site_name") or _domain(canonical))[:500],
                       "snippet":str(raw.get("snippet") or "")[:5000],"rank":len(candidates)+1}
                row["payload_hash"] = hashlib.sha256(_canonical(row).encode()).hexdigest()
                candidates.append(row)
            if not candidates:
                with engine.begin() as connection:
                    current = connection.execute(text("""
                        SELECT state,phase FROM coordinator_v3_runs
                        WHERE id=CAST(:coordinator AS uuid) FOR UPDATE
                    """), {"coordinator":coordinator_run_id}).mappings().one()
                    _assert_pending_operation(dict(current), operation_key=operation_key, scope_hash=expected_scope_hash)
                    connection.execute(text("""
                        UPDATE web_search_executions
                        SET status='failed',completed_at=clock_timestamp(),
                            error_code='no_eligible_candidates',
                            error_message=:error
                        WHERE id=CAST(:execution AS uuid) AND status='running'
                    """), {"execution":execution_id,"error":f"No matching record on the approved sources ({attempt_summary})"[:2000]})
                    recovery = _persist_recovery_checkpoint(
                        connection, coordinator_run_id, analysis_run_id, execution_id,
                        f"The approved sources returned no matching record ({attempt_summary}). It will not be replayed automatically. "
                        "Continue without verification to keep the evidence gap open and move on, or escalate the case.",
                        allow_continue=True,
                    )
                return Message(text=_canonical({"status":"waiting_for_human","checkpoint":recovery}),session_id=run["session_id"])
            with engine.begin() as connection:
                run = connection.execute(text("""
                    SELECT analysis_run_id::text,case_id::text,session_id,state,phase,langflow_job_id
                    FROM coordinator_v3_runs WHERE id=CAST(:coordinator AS uuid) FOR UPDATE
                """), {"coordinator":coordinator_run_id}).mappings().one()
                _assert_pending_operation(dict(run), operation_key=operation_key, scope_hash=expected_scope_hash)
                for row in candidates:
                    connection.execute(text("""
                        INSERT INTO coordinator_v3_search_candidates(id,analysis_run_id,case_id,langflow_job_id,search_execution_id,
                          rank,url,canonical_url,title,site_name,snippet,payload_hash)
                        VALUES(CAST(:id AS uuid),CAST(:run AS uuid),CAST(:case AS uuid),:job,CAST(:execution AS uuid),
                          :rank,:url,:canonical_url,:title,:site_name,:snippet,:payload_hash) ON CONFLICT DO NOTHING
                    """), {**row,"run":run["analysis_run_id"],"case":run["case_id"],"job":run["langflow_job_id"],"execution":execution_id})
                connection.execute(text("""
                    UPDATE web_search_executions
                    SET status='succeeded',completed_at=clock_timestamp(),
                        provider_request_id=COALESCE(:provider,provider_request_id)
                    WHERE id=CAST(:execution AS uuid) AND status='running'
                """), {"execution": execution_id, "provider": provider_request_id})
                next_action = {"route":"fetch_search_results","search_execution_id":execution_id,
                               "operation_key":str(request.get("operation_key") or "") + ":fetch"}
                connection.execute(text("""
                    UPDATE coordinator_v3_runs
                    SET state_version=state_version+1,
                        state=state || jsonb_build_object(
                          'approved_search',CAST(:approved AS jsonb),
                          'next_action',CAST(:next_action AS jsonb),
                          'next_action_idempotency_key',:next_key,
                          'updated_at',clock_timestamp()
                        ),updated_at=clock_timestamp()
                    WHERE id=CAST(:coordinator AS uuid)
                """), {"approved":_canonical({"search_execution_id":execution_id,"approved_plan":scope,"candidate_count":len(candidates),
                                              "sources_checked":attempts}),
                         "next_action":_canonical(next_action),"next_key":next_action["operation_key"],"coordinator":coordinator_run_id})
            self.status = f"Stored {len(candidates)} approved candidate(s) ({attempt_summary})"
            return Message(text=_canonical({"status":"executed","search_execution_id":execution_id,"approved_plan":scope,
                                            "sources_checked":attempts,"candidates":candidates}), session_id=run["session_id"])
        finally:
            engine.dispose()
