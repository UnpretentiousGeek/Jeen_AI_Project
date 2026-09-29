import json
import re
from uuid import UUID

from sqlalchemy import create_engine, text

from lfx.custom.custom_component.component import Component
from lfx.io import MessageTextInput, Output, SecretStrInput
from lfx.schema.message import Message
from lfx.services.deps import session_scope


class KybEntityEvidence(Component):
    display_name = "Retrieve and Reconcile Scoped Entity Evidence"
    description = "Loads cited entity attributes from pinned documents and prepares field-level reconciliation."
    icon = "database"
    name = "KybEntityEvidence"

    inputs = [
        MessageTextInput(
            name="input_value",
            display_name="Entity Task Reference",
            info="JSON with analysis_run_id, task_id, context_id, and optional case_id.",
            required=True,
        ),
        SecretStrInput(
            name="database_url",
            display_name="Database URL",
            info="Private PostgreSQL connection used for pinned evidence retrieval.",
            required=True,
            advanced=False,
        ),
    ]

    outputs = [Output(display_name="Scoped Evidence", name="evidence", method="retrieve")]

    # Jurisdiction names documents use for the case catalog's codes, keyed by upper-case words.
    JURISDICTION_NAMES = {
        **dict.fromkeys(["UNITED KINGDOM", "UK", "GREAT BRITAIN", "ENGLAND AND WALES", "ENGLAND",
                         "WALES", "SCOTLAND", "NORTHERN IRELAND"], "GB"),
        **dict.fromkeys(["UNITED STATES", "UNITED STATES OF AMERICA", "USA"], "US"),
        **{f"{prefix}{state}{suffix}": code
           for state, code in {"DELAWARE": "US-DE", "CALIFORNIA": "US-CA", "NEW YORK": "US-NY",
                               "TEXAS": "US-TX", "WASHINGTON": "US-WA"}.items()
           for prefix in ("", "STATE OF ") for suffix in ("", " UNITED STATES", " USA")},
        "CANADA": "CA", "SINGAPORE": "SG", "AUSTRALIA": "AU",
    }

    @staticmethod
    def _normal(value, kind):
        if value is None:
            return None
        value = str(value).strip().upper()
        if kind in {"legal_name", "address"}:
            value = re.sub(r"[^A-Z0-9]+", " ", value)
            return " ".join(value.split())
        if kind == "identifier":
            return re.sub(r"[^A-Z0-9]", "", value)
        if kind == "jurisdiction":
            explicit_code = re.search(r"\(([A-Z]{2}(?:-[A-Z]{2})?)\)$", value)
            if explicit_code:
                return explicit_code.group(1)
            named = " ".join(re.sub(r"[^A-Z]+", " ", value).split())
            if named in KybEntityEvidence.JURISDICTION_NAMES:
                return KybEntityEvidence.JURISDICTION_NAMES[named]
        return " ".join(value.split())

    @staticmethod
    def _identifier_kind(value):
        kind = re.sub(r"[^a-z0-9]+", "_", str(value or "").lower()).strip("_")
        return "registration_number" if kind in {"company_number", "company_registration_number"} else kind

    @staticmethod
    def _entity_key(value):
        """Compare entity names ignoring case, punctuation, and how the legal form is spelled."""
        words = re.sub(r"[^A-Z0-9]+", " ", str(value or "").upper()).split()
        forms = {"LIMITED": "LTD", "INCORPORATED": "INC", "CORPORATION": "CORP", "COMPANY": "CO"}
        return re.sub(r"\bPUBLIC LTD CO$", "PLC", " ".join(forms.get(word, word) for word in words))

    @staticmethod
    def _describes_applicant(row, applicant_key):
        """Reconcile only the applicant's attributes, never another entity's number or address.

        An attribute of the entity the document is about is kept even when that entity's name
        differs from the applicant's: the resulting conflict is what the analyst must see. An
        attribute of another entity is kept only when that entity is named as the applicant.
        An attribute of an unnamed entity other than the document's own is ambiguous and is
        excluded, because assigning it to the applicant could invent a conflict or a match; at
        worst the field is reported missing and the analyst is asked. Rows extracted before
        subjects were recorded carry no subject and keep their original reading as the applicant's.
        """
        if row.get("describes_document_subject") is None or row["describes_document_subject"]:
            return True
        return bool(row.get("subject")) and KybEntityEvidence._entity_key(row["subject"]) == applicant_key

    async def _database_url(self):
        value = self.database_url
        if hasattr(value, "get_secret_value"):
            value = value.get_secret_value()
        database_url = str(value or "").strip()
        schemes = ("postgresql://", "postgresql+psycopg://", "postgresql+psycopg2://")
        if not database_url.startswith(schemes):
            async with session_scope() as session:
                database_url = await self.get_variable("DATABASE_URL", "value", session)
            if hasattr(database_url, "get_secret_value"):
                database_url = database_url.get_secret_value()
            database_url = str(database_url or "").strip()
        if not database_url.startswith(schemes):
            raise ValueError("Global DATABASE_URL is not a valid PostgreSQL SQLAlchemy URL")
        return database_url

    @staticmethod
    def _row(field, address_type, identifier_type, declared, facts):
        kind = "address" if field == "address" else field
        declared_original = None if declared is None else str(declared)
        declared_normalized = KybEntityEvidence._normal(declared_original, kind)
        documentary_values = [
            {
                "original": fact["value"],
                "normalized": KybEntityEvidence._normal(fact["value"], kind),
                "citation_id": fact["citation_id"],
                "observed_at": fact.get("observed_at") or None,
            }
            for fact in facts
        ]
        normalized = {item["normalized"] for item in documentary_values}
        if declared_normalized is None or not documentary_values:
            outcome = "missing"
            rationale = "A declared or documentary value is absent."
        elif len(normalized) == 1 and declared_normalized in normalized:
            outcome = "match"
            rationale = "Declared and documentary values match after harmless normalization."
        else:
            outcome = "conflict"
            rationale = "Declared and documentary values, or multiple documentary values, materially differ."
        return {
            "field": field,
            "address_type": address_type,
            "identifier_type": identifier_type,
            "declared_original": declared_original,
            "declared_normalized": declared_normalized,
            "documentary_values": documentary_values,
            "outcome": outcome,
            "rationale_summary": rationale,
        }

    async def retrieve(self) -> Message:
        raw = self.input_value.text if isinstance(self.input_value, Message) else self.input_value
        try:
            payload = json.loads(raw)
        except (TypeError, json.JSONDecodeError) as exc:
            raise ValueError("Entity task reference must be valid JSON") from exc
        if not isinstance(payload, dict):
            raise ValueError("Entity task reference must be a JSON object")
        run_id = str(payload.get("analysis_run_id", "")).strip()
        task_id = str(payload.get("task_id", "")).strip()
        context_id = str(payload.get("context_id", "")).strip()
        if not run_id or not task_id or not context_id:
            raise ValueError("analysis_run_id, task_id, and context_id are required")
        UUID(run_id)
        supplied_case_id = str(payload.get("case_id", "")).strip()
        if supplied_case_id:
            UUID(supplied_case_id)

        engine = create_engine(await self._database_url())
        try:
            with engine.connect() as connection:
                run = connection.execute(text("""
                    SELECT run.case_id::text AS case_id, run.case_snapshot,
                           applicant.legal_name, applicant.jurisdiction,
                           applicant.business_type, applicant.product
                      FROM analysis_runs run
                      JOIN onboarding_cases c ON c.id = run.case_id
                      JOIN applicants applicant ON applicant.id = c.applicant_id
                     WHERE run.id = CAST(:run_id AS uuid)
                """), {"run_id": run_id}).mappings().one_or_none()
                if run is None:
                    raise ValueError("analysis_run_id does not exist")
                if supplied_case_id and supplied_case_id != run["case_id"]:
                    raise ValueError("case_id does not own the supplied analysis_run_id")
                case_rows = list(connection.execute(text("""
                    SELECT fact.id::text AS fact_id, document.id::text AS source_id,
                           chunk.id::text AS chunk_id, chunk.section_locator AS locator,
                           fact.excerpt, fact.field, fact.address_type,
                           fact.identifier_type,
                           fact.identifier_jurisdiction AS jurisdiction,
                           fact.value, fact.observed_at,
                           fact.subject, fact.describes_document_subject
                      FROM analysis_run_documents snapshot
                      JOIN case_documents document ON document.id = snapshot.document_id
                                                 AND document.case_id = snapshot.case_id
                      JOIN document_chunks chunk ON chunk.document_id = document.id
                                                AND chunk.case_id = snapshot.case_id
                      JOIN case_entity_attributes fact ON fact.document_id = document.id
                                                       AND fact.case_id = document.case_id
                                                       AND fact.chunk_id = chunk.id
                     WHERE snapshot.analysis_run_id = CAST(:run_id AS uuid)
                       AND document.ingestion_status = 'ready'
                     ORDER BY fact.id
                """), {"run_id": run_id}).mappings())
                policy_rows = list(connection.execute(text("""
                    SELECT version.id::text AS source_id, chunk.id::text AS chunk_id,
                           chunk.section_locator AS locator, chunk.content AS excerpt
                      FROM analysis_run_policy_versions snapshot
                      JOIN analysis_runs run ON run.id = snapshot.analysis_run_id
                      JOIN policy_versions version ON version.id = snapshot.policy_version_id
                      JOIN policy_chunks chunk ON chunk.policy_version_id = version.id
                     WHERE snapshot.analysis_run_id = CAST(:run_id AS uuid)
                     AND ('*' = ANY(chunk.jurisdictions)
                        OR run.case_snapshot #>> '{applicant,jurisdiction}' = ANY(chunk.jurisdictions))
                    AND ('*' = ANY(chunk.products)
                        OR run.case_snapshot #>> '{applicant,product}' = ANY(chunk.products))
                    AND ('*' = ANY(chunk.business_types)
                        OR run.case_snapshot #>> '{applicant,business_type}' = ANY(chunk.business_types))
                       AND chunk.section_locator IN ('KYB-1.1', 'DOC-4.1')
                     ORDER BY chunk.id
                """), {"run_id": run_id}).mappings())
                # Every ready document in the run, so the agent can search documents no extracted fact
                # comes from (an agreement, a declaration); allowed_citations name only those that do.
                searchable_documents = [dict(row) for row in connection.execute(text("""
                    SELECT document.id::text AS document_id, document.original_filename AS filename,
                           document.document_type
                      FROM analysis_run_documents snapshot
                      JOIN case_documents document ON document.id = snapshot.document_id
                                                  AND document.case_id = snapshot.case_id
                     WHERE snapshot.analysis_run_id = CAST(:run_id AS uuid)
                       AND document.ingestion_status = 'ready'
                     ORDER BY document.original_filename, document.id
                """), {"run_id": run_id}).mappings()]
        finally:
            engine.dispose()

        submitted = (run["case_snapshot"] or {}).get("submitted_payload") or {}
        applicant_key = self._entity_key(
            (submitted.get("entity_declaration") or {}).get("legal_name") or run["legal_name"]
        )
        citations = []
        facts = []
        for row in case_rows:
            if not self._describes_applicant(row, applicant_key):
                continue
            citation_id = f"case-{row['fact_id']}"
            citations.append({
                "id": citation_id,
                "source_kind": "case_document",
                "source_id": row["source_id"],
                "chunk_id": row["chunk_id"],
                "locator": row["locator"],
                "excerpt": row["excerpt"],
            })
            facts.append({
                "field": row["field"], "address_type": row["address_type"],
                "identifier_type": row["identifier_type"],
                "jurisdiction": row["jurisdiction"], "value": row["value"],
                "observed_at": row["observed_at"], "citation_id": citation_id,
                "source_id": row["source_id"],
            })
        for row in policy_rows:
            citations.append({
                "id": f"policy-{row['chunk_id']}",
                "source_kind": "policy",
                "source_id": row["source_id"],
                "chunk_id": row["chunk_id"],
                "locator": row["locator"],
                "excerpt": row["excerpt"],
            })

        declaration = submitted.get("entity_declaration") or {}
        addresses = declaration.get("addresses") or {}
        identifiers = declaration.get("identifiers") or []
        identifiers = identifiers or [{"type": "registration_number", "value": None, "jurisdiction": declaration.get("jurisdiction") or run["jurisdiction"]}]

        def selected(field, address_type=None, identifier_type=None, identifier_jurisdiction=None):
            def jurisdiction_matches(fact):
                expected = self._normal(identifier_jurisdiction, "jurisdiction")
                if identifier_jurisdiction is None or (fact.get("jurisdiction") is not None
                    and self._normal(fact["jurisdiction"], "jurisdiction") == expected):
                    return True
                if fact.get("jurisdiction") is not None:
                    return False
                # A number with no stated jurisdiction takes its document's. A document silent on
                # jurisdiction does not disqualify it: the fact already describes the applicant
                # (see _describes_applicant), so it is compared, and a mistyped number surfaces.
                documented = {self._normal(item["value"], "jurisdiction") for item in facts
                              if item["field"] == "jurisdiction"
                              and item["source_id"] == fact["source_id"]}
                return not documented or documented == {expected}
            return [fact for fact in facts if fact.get("field") == field
                    and (address_type is None or fact.get("address_type") == address_type)
                    and (identifier_type is None or self._identifier_kind(fact.get("identifier_type"))
                         == self._identifier_kind(identifier_type))
                    and jurisdiction_matches(fact)]

        identifier_rows = [self._row(
            "identifier", None, identifier.get("type") or "registration_number", identifier.get("value"),
            selected("identifier", identifier_type=identifier.get("type") or "registration_number", identifier_jurisdiction=identifier.get("jurisdiction")),
        ) for identifier in identifiers]

        reconciliations = [
            self._row("legal_name", None, None, declaration.get("legal_name") or run["legal_name"], selected("legal_name")),
            self._row("jurisdiction", None, None, declaration.get("jurisdiction") or run["jurisdiction"], selected("jurisdiction")),
            *identifier_rows,
            self._row("address", "registered", None, addresses.get("registered"), selected("address", address_type="registered")),
            self._row("address", "operating", None, addresses.get("operating"), selected("address", address_type="operating")),
            self._row("address", "mailing", None, addresses.get("mailing"), selected("address", address_type="mailing")),
        ]
        status = "completed" if all(row["outcome"] == "match" for row in reconciliations) else "partial"
        result = {
            "contract_version": "3.2.0",
            "contribution_kind": "specialist_contribution",
            "case_id": run["case_id"],
            "analysis_run_id": run_id,
            "task_id": task_id,
            "context_id": context_id,
            "specialty": "entity",
            "specialist": {"name": "kyb-entity-agent", "version": "3.2.0"},
            "applicant": {"legal_name": run["legal_name"], "jurisdiction": run["jurisdiction"]},
            "expected_status": status,
            "expected_reconciliations": reconciliations,
            "allowed_citations": citations,
            "searchable_documents": searchable_documents,
            "instructions": "Return a Specialist Contribution, not a finding or decision. Copy expected deterministic rows and allowed citations exactly.",
        }
        message = Message(text=json.dumps(result, separators=(",", ":"), default=str))
        self.status = f"Prepared {len(reconciliations)} deterministic comparisons from {len(facts)} pinned attributes"
        return message
