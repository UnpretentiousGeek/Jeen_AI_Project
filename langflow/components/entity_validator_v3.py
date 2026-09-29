from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from sqlalchemy import create_engine, text

from lfx.custom.custom_component.component import Component
from lfx.io import HandleInput, Output, SecretStrInput
from lfx.schema.data import Data
from lfx.schema.message import Message
from lfx.services.deps import session_scope


def _pinned_citations(supplied, allowed: dict, referenced: list[str]) -> tuple[list[dict], list[str]]:
    """The database copy of every citation the findings reference, plus any other pinned source the
    model named; ids it named that are not pinned to this run are dropped and reported, never saved."""
    ids = list(dict.fromkeys(referenced))
    dropped = []
    for citation in supplied if isinstance(supplied, list) else []:
        citation_id = citation.get("id") if isinstance(citation, dict) else None
        if citation_id in allowed:
            if citation_id not in ids:
                ids.append(citation_id)
        elif citation_id:
            dropped.append(str(citation_id)[:120])
    return [allowed[citation_id] for citation_id in ids], dropped


# --- specialist-observations-v3 (shared; keep identical in every validator) ---
_OBSERVATION_CAP, _OBSERVATION_PER_TARGET = 8, 2
_CONFIDENCE_RANK = {"high": 0, "medium": 1, "low": 2}
# A visual check reads a page image that no text excerpt can confirm: it cites the page's pinned
# passage without a quote, and never claims high confidence.
_UNQUOTED_KINDS = {"visual_check"}
_VERDICT = re.compile(
    r"\b(approve[sd]?|approval|reject(?:s|ed)?|decline[sd]?|(?:non-)?compliant|risk score|"
    r"(?:high|low|medium)[- ]risk|recommend(?:s|ed)?|should (?:be )?(?:approved|rejected|onboarded|declined))\b",
    re.I)
# Observations may also cite any passage of a document pinned to the run, as chunk-<id>, so a note can
# rest on text no extracted fact covers (an agreement clause, a register note). Quotes are then checked
# against the whole passage.
_RUN_PASSAGES_SQL = """
    SELECT chunk.id::text AS chunk_id, document.id::text AS source_id,
           chunk.section_locator AS locator, chunk.content AS excerpt
      FROM analysis_run_documents snapshot
      JOIN case_documents document ON document.id = snapshot.document_id AND document.case_id = snapshot.case_id
      JOIN document_chunks chunk ON chunk.document_id = document.id AND chunk.case_id = snapshot.case_id
     WHERE snapshot.analysis_run_id = CAST(:run_id AS uuid)
       AND document.ingestion_status = 'ready' ORDER BY chunk.id
"""


def _passage_citations(rows) -> dict:
    return {f"chunk-{row['chunk_id']}": {"id": f"chunk-{row['chunk_id']}", "source_kind": "case_document",
                                         "source_id": row["source_id"], "chunk_id": row["chunk_id"],
                                         "locator": row["locator"], "excerpt": row["excerpt"]} for row in rows}


_PERCENT = re.compile(r"(\d+(?:\.\d+)?)\s*(?:%|per ?cent\b)", re.I)


def _percent_values(text):
    return {round(float(value), 4) for value in _PERCENT.findall(text)}


def _observation_text(value, limit):
    if not isinstance(value, str):
        return None
    text = " ".join(re.sub(r"[\x00-\x1f\x7f]", " ", value).split())
    return text if 0 < len(text) <= limit else None


def validate_observations(raw, allowed: dict, kinds: set, targets: set, priority: set,
                          gates: dict | None = None,
                          known_percentages: set | None = None) -> tuple[list[dict], list[str]]:
    """Advisory agent notes: kept only when every citation is pinned and every quote is verbatim.
    They never feed the deterministic rows; anything doubtful is dropped, never repaired.
    With known_percentages, every percentage a note states must be computed or cited."""
    candidates, dropped = [], []
    for index, item in enumerate(raw[:32] if isinstance(raw, list) else []):
        observation_id = (_observation_text(item.get("id"), 64) if isinstance(item, dict) else None) or f"obs-{index + 1}"

        def drop(reason, observation_id=observation_id):
            dropped.append(f"{observation_id}:{reason}")

        if not isinstance(item, dict):
            drop("not_object")
            continue
        kind, about = item.get("kind"), _observation_text(item.get("about"), 120)
        statement = _observation_text(item.get("statement"), 600)
        confidence, citations, quotes = item.get("confidence"), item.get("citations"), item.get("quotes")
        if kind not in kinds:
            drop("kind")
            continue
        if about not in targets:
            drop("about")
            continue
        if statement is None:
            drop("statement")
            continue
        if _VERDICT.search(statement):
            drop("verdict_language")
            continue
        if confidence not in _CONFIDENCE_RANK:
            drop("confidence")
            continue
        if (not isinstance(citations, list) or not 1 <= len(citations) <= 5
                or any(not isinstance(citation, str) or citation not in allowed for citation in citations)):
            drop("citation")
            continue
        cited = [" ".join(str(allowed[citation].get("excerpt") or "").split()).casefold() for citation in citations]
        unquoted = kind in _UNQUOTED_KINDS
        if unquoted and confidence == "high":
            drop("confidence")
            continue
        if unquoted and quotes in (None, []):
            quotes = []
        elif (not isinstance(quotes, list) or not 1 <= len(quotes) <= 5
                or any(not isinstance(quote, str) or not quote.strip()
                       or not any(" ".join(quote.split()).casefold() in excerpt for excerpt in cited)
                       for quote in quotes)):
            drop("quote")
            continue
        if known_percentages is not None and _percent_values(statement) - set(known_percentages) - {
                value for excerpt in cited for value in _percent_values(excerpt)}:
            drop("percentage_not_in_findings")
            continue
        gate = (gates or {}).get(kind)
        if gate is not None and not gate(about):
            drop("inconsistent_with_findings")
            continue
        candidates.append((0 if about in priority else 1, _CONFIDENCE_RANK[confidence], index, {
            "id": observation_id, "kind": kind, "about": about, "statement": statement,
            "confidence": confidence, "citations": list(dict.fromkeys(citations))}))
    kept, per_target = [], {}
    for *_, observation in sorted(candidates, key=lambda candidate: candidate[:3]):
        about = observation["about"]
        if len(kept) >= _OBSERVATION_CAP or per_target.get(about, 0) >= _OBSERVATION_PER_TARGET:
            dropped.append(f"{observation['id']}:over_cap")
            continue
        per_target[about] = per_target.get(about, 0) + 1
        kept.append(observation)
    return kept, dropped
# --- end specialist-observations-v3 ---


class KybEntityArtifactValidator(Component):
    display_name = "Validate Entity Specialist Contribution"
    description = "Recomputes all six reconciliation rows from pinned database evidence and rejects altered citations."
    icon = "shield-check"
    name = "KybEntityArtifactValidator"

    inputs = [
        HandleInput(name="artifact", display_name="Entity Contribution", input_types=["Data", "JSON", "Message"], required=True),
        SecretStrInput(name="database_url", display_name="Database URL", info="Private PostgreSQL connection used to verify pinned evidence.", required=True, advanced=False),
    ]
    outputs = [Output(display_name="Validated Contribution", name="validated", method="validate")]

    @staticmethod
    def _payload(value: Any) -> dict:
        if isinstance(value, Data):
            value = value.data
        elif isinstance(value, Message):
            value = value.text
        if isinstance(value, str):
            value = value.strip()
            if value.startswith("```"):
                value = value.split("\n", 1)[1].rsplit("```", 1)[0].strip()
            value = json.loads(value)
        if not isinstance(value, dict):
            raise ValueError("Entity contribution must be a JSON object")
        return value

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
            return " ".join(re.sub(r"[^A-Z0-9]+", " ", value).split())
        if kind == "identifier":
            return re.sub(r"[^A-Z0-9]", "", value)
        if kind == "jurisdiction":
            explicit_code = re.search(r"\(([A-Z]{2}(?:-[A-Z]{2})?)\)$", value)
            if explicit_code:
                return explicit_code.group(1)
            named = " ".join(re.sub(r"[^A-Z]+", " ", value).split())
            if named in KybEntityArtifactValidator.JURISDICTION_NAMES:
                return KybEntityArtifactValidator.JURISDICTION_NAMES[named]
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
        return bool(row.get("subject")) and KybEntityArtifactValidator._entity_key(row["subject"]) == applicant_key

    @staticmethod
    def _reason_code(row):
        # Names why a row got its outcome, so consumers need not parse rationale prose.
        documentary = row["documentary_values"]
        if row["outcome"] == "missing":
            return "missing_declared" if row["declared_normalized"] is None else "missing_documentary"
        if row["outcome"] == "conflict":
            return "conflict_documentary" if len({value["normalized"] for value in documentary}) > 1 else "conflict_declared"
        declared = (row["declared_original"] or "").strip()
        return "match_exact" if all(value["original"].strip() == declared for value in documentary) else "match_normalized"

    @staticmethod
    def _row(field, address_type, identifier_type, declared, facts):
        kind = "address" if field == "address" else field
        original = None if declared is None else str(declared)
        normalized = KybEntityArtifactValidator._normal(original, kind)
        values = [{"original": fact["value"], "normalized": KybEntityArtifactValidator._normal(fact["value"], kind), "citation_id": fact["citation_id"], "observed_at": fact.get("observed_at") or None} for fact in facts]
        documentary_norms = {value["normalized"] for value in values}
        if normalized is None or not values:
            outcome, rationale = "missing", "A declared or documentary value is absent."
        elif len(documentary_norms) == 1 and normalized in documentary_norms:
            outcome, rationale = "match", "Declared and documentary values match after harmless normalization."
        else:
            outcome, rationale = "conflict", "Declared and documentary values, or multiple documentary values, materially differ."
        return {"field": field, "address_type": address_type, "identifier_type": identifier_type, "declared_original": original, "declared_normalized": normalized, "documentary_values": values, "outcome": outcome, "rationale_summary": rationale}

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

    async def validate(self) -> Data:
        artifact = self._payload(self.artifact)
        # Only the identity comes from the model; the findings are computed below.
        required = {"contract_version", "contribution_kind", "contribution_id", "analysis_run_id", "task_id", "context_id", "specialist", "specialty"}
        missing = sorted(required - set(artifact))
        if missing:
            raise ValueError(f"Entity contribution is missing fields: {', '.join(missing)}")
        run_id = str(artifact["analysis_run_id"])
        UUID(run_id)
        # 3.2.0 adds advisory observations; 3.1.0 contributions validate exactly as before.
        version = artifact["contract_version"]
        if version not in {"3.1.0", "3.2.0"} or artifact["contribution_kind"] != "specialist_contribution":
            raise ValueError("Unsupported Entity Specialist Contribution contract")
        if artifact["specialist"] != {"name": "kyb-entity-agent", "version": version} or artifact["specialty"] != "entity":
            raise ValueError("Unexpected entity specialist identity")
        if artifact["contribution_id"] != f"entity-{artifact['task_id']}":
            raise ValueError("contribution_id must equal entity- plus task_id")

        engine = create_engine(await self._database_url())
        try:
            with engine.connect() as connection:
                run = connection.execute(text("""
                    SELECT run.case_snapshot, applicant.legal_name, applicant.jurisdiction
                      FROM analysis_runs run JOIN onboarding_cases c ON c.id = run.case_id
                      JOIN applicants applicant ON applicant.id = c.applicant_id
                     WHERE run.id = CAST(:run_id AS uuid)
                """), {"run_id": run_id}).mappings().one_or_none()
                if run is None:
                    raise ValueError("analysis_run_id does not exist")
                case_rows = list(connection.execute(text("""
                    SELECT fact.id::text AS fact_id, document.id::text AS source_id,
                           chunk.id::text AS chunk_id, chunk.section_locator AS locator,
                           fact.excerpt, fact.field, fact.address_type,
                           fact.identifier_type,
                           fact.identifier_jurisdiction AS jurisdiction,
                           fact.value, fact.observed_at,
                           fact.subject, fact.describes_document_subject
                      FROM analysis_run_documents snapshot
                      JOIN case_documents document ON document.id = snapshot.document_id AND document.case_id = snapshot.case_id
                      JOIN document_chunks chunk ON chunk.document_id = document.id AND chunk.case_id = snapshot.case_id
                      JOIN case_entity_attributes fact ON fact.document_id = document.id
                                                       AND fact.case_id = document.case_id
                                                       AND fact.chunk_id = chunk.id
                     WHERE snapshot.analysis_run_id = CAST(:run_id AS uuid)
                       AND document.ingestion_status = 'ready' ORDER BY fact.id
                """), {"run_id": run_id}).mappings())
                policy_rows = list(connection.execute(text("""
                    SELECT version.id::text AS source_id, chunk.id::text AS chunk_id, chunk.section_locator AS locator, chunk.content AS excerpt
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
                       AND chunk.section_locator IN ('KYB-1.1', 'DOC-4.1') ORDER BY chunk.id
                """), {"run_id": run_id}).mappings())
                passage_rows = list(connection.execute(text(_RUN_PASSAGES_SQL), {"run_id": run_id}).mappings()) \
                    if version == "3.2.0" else []
        finally:
            engine.dispose()

        submitted = (run["case_snapshot"] or {}).get("submitted_payload") or {}
        applicant_key = self._entity_key(
            (submitted.get("entity_declaration") or {}).get("legal_name") or run["legal_name"]
        )
        allowed, facts = {}, []
        for row in case_rows:
            if not self._describes_applicant(row, applicant_key):
                continue
            citation_id = f"case-{row['fact_id']}"
            allowed[citation_id] = {"id": citation_id, "source_kind": "case_document", "source_id": row["source_id"], "chunk_id": row["chunk_id"], "locator": row["locator"], "excerpt": row["excerpt"]}
            facts.append({"field": row["field"], "address_type": row["address_type"],
                          "identifier_type": row["identifier_type"],
                          "jurisdiction": row["jurisdiction"], "value": row["value"],
                          "observed_at": row["observed_at"], "citation_id": citation_id,
                          "source_id": row["source_id"]})
        for row in policy_rows:
            citation_id = f"policy-{row['chunk_id']}"
            allowed[citation_id] = {"id": citation_id, "source_kind": "policy", "source_id": row["source_id"], "chunk_id": row["chunk_id"], "locator": row["locator"], "excerpt": row["excerpt"]}

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
                documented = {self._normal(item["value"], "jurisdiction") for item in facts
                              if item["field"] == "jurisdiction"
                              and item["source_id"] == fact["source_id"]}
                # Mirrors the evidence step: a document silent on jurisdiction does not disqualify its number.
                return not documented or documented == {expected}
            return [fact for fact in facts if fact.get("field") == field
                    and (address_type is None or fact.get("address_type") == address_type)
                    and (identifier_type is None or self._identifier_kind(fact.get("identifier_type"))
                         == self._identifier_kind(identifier_type))
                    and jurisdiction_matches(fact)]
        identifier_rows = [self._row("identifier", None, identifier.get("type") or "registration_number", identifier.get("value"), selected("identifier", identifier_type=identifier.get("type") or "registration_number", identifier_jurisdiction=identifier.get("jurisdiction"))) for identifier in identifiers]
        expected = [
            self._row("legal_name", None, None, declaration.get("legal_name") or run["legal_name"], selected("legal_name")),
            self._row("jurisdiction", None, None, declaration.get("jurisdiction") or run["jurisdiction"], selected("jurisdiction")),
            *identifier_rows,
            self._row("address", "registered", None, addresses.get("registered"), selected("address", address_type="registered")),
            self._row("address", "operating", None, addresses.get("operating"), selected("address", address_type="operating")),
            self._row("address", "mailing", None, addresses.get("mailing"), selected("address", address_type="mailing")),
        ]
        expected_status = "completed" if all(row["outcome"] == "match" for row in expected) else "partial"
        # The contribution's findings are this deterministic computation, never the model's copy of
        # it: a model re-typing long identifiers slips, and one slip used to fail a correct run.
        # reason_code is derived here too; the model is never asked to produce it.
        artifact["status"] = expected_status
        artifact["reconciliations"] = [{**row, "reason_code": self._reason_code(row)} for row in expected]
        # Advisory observations are kept beside the rows, never merged into them.
        def target(row):
            detail = row["address_type"] if row["field"] == "address" else row["identifier_type"] if row["field"] == "identifier" else None
            return f"{row['field']}:{detail}" if detail else row["field"]
        targets = {"run", *(target(row) for row in expected)}
        open_rows = {target(row) for row in expected if row["outcome"] != "match"}
        observation_allowed = {**_passage_citations(passage_rows), **allowed}
        observations, dropped_observations = [], []
        if version == "3.2.0":
            try:
                observations, dropped_observations = validate_observations(
                    artifact.get("observations"), observation_allowed,
                    # visual_check is off until the image tool returns pixels the agent can see: without
                    # them a visual note, the one kind allowed without a quote, cannot be verified.
                    kinds={"near_miss_equivalence", "date_explanation", "internal_consistency", "analyst_question"},
                    targets=targets, priority=open_rows,
                    # Explanations only make sense for rows the system did not match.
                    gates={kind: open_rows.__contains__ for kind in ("near_miss_equivalence", "date_explanation", "analyst_question")})
            except Exception:
                observations, dropped_observations = [], ["*:validator_error"]
        artifact["observations"] = observations
        referenced = [value["citation_id"] for row in expected for value in row["documentary_values"]]
        referenced += [citation for observation in observations for citation in observation["citations"]]
        artifact["citations"], dropped = _pinned_citations(artifact.get("citations"), observation_allowed, referenced)
        artifact["deterministic_validation"] = {"validator": f"entity-reconciliation-v{version}", "outcome": "accepted", "assembled_from": "pinned_evidence", "dropped_citation_ids": dropped, "dropped_observation_ids": dropped_observations, "checks": ["field_rows", "normalization", "classification", "citation_pin", "case_scope", "observations"], "validated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")}
        result = Data(data=artifact)
        self.status = f"Accepted {len(expected)} deterministic entity reconciliation rows"
        return result
