from __future__ import annotations

import json
import re
from collections import defaultdict
from datetime import datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
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


class KybOwnershipArtifactValidator(Component):
    display_name = "Validate Ownership Specialist Contribution"
    description = "Reconstructs the pinned ownership graph and rejects incorrect totals, paths, anomalies, or citations."
    icon = "shield-check"
    name = "KybOwnershipArtifactValidator"

    inputs = [
        HandleInput(name="artifact", display_name="Ownership Contribution", input_types=["Data", "JSON", "Message"], required=True),
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
            raise ValueError("Ownership contribution must be a JSON object")
        return value

    @staticmethod
    def _number(value):
        return float(value.quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP))

    @staticmethod
    def _name_key(value):
        # A trailing descriptor such as "(natural person)" or "(private company, England and Wales)"
        # is extraction wording, not part of the name, so it must not make a second holder.
        name = re.sub(r"[.!?;:,]+$", "", str(value).strip()).strip()
        name = re.sub(r"\s*\([^()]*\)$", "", name).strip() or name
        return re.sub(r"\s+", " ", re.sub(r"[.!?;:,]+$", "", name)).strip().casefold()

    @staticmethod
    def _calculate(target, facts):
        # Edges group by normalised name; each name shows as its shortest stated spelling.
        spellings = defaultdict(set)
        for fact in facts:
            for name in (fact["owner"], fact["owned"]):
                spellings[KybOwnershipArtifactValidator._name_key(name)].add(name)
        display = {key: min(names, key=lambda name: (len(name), name)) for key, names in spellings.items()}
        groups = defaultdict(list)
        for fact in facts:
            groups[(KybOwnershipArtifactValidator._name_key(fact["owner"]), KybOwnershipArtifactValidator._name_key(fact["owned"]))].append(fact)
        anomalies, resolved = [], []
        for (owner_key, owned_key), group in sorted(groups.items()):
            owner, owned = display[owner_key], display[owned_key]
            # The same relationship at the same percentage in several sources corroborates it;
            # it is resolved once with every citation, so repetition is not an anomaly.
            percentages = sorted({fact["percentage"] for fact in group})
            citation_ids = sorted({fact["citation_id"] for fact in group})
            if len(percentages) > 1:
                anomalies.append({"type": "inconsistent_percentage", "subject": f"{owner} -> {owned}", "details": "Pinned evidence assigns inconsistent percentages to the same relationship.", "citation_ids": citation_ids})
                continue
            resolved.append({"owner": owner, "owner_type": group[0]["owner_type"], "owned": owned, "percentage": percentages[0], "citation_ids": citation_ids})
        adjacency = defaultdict(list)
        for edge in resolved:
            adjacency[KybOwnershipArtifactValidator._name_key(edge["owner"])].append(edge)
        cycle_keys = set()
        def detect(node, path, edge_path):
            node_key = KybOwnershipArtifactValidator._name_key(node)
            path_keys = [KybOwnershipArtifactValidator._name_key(item) for item in path]
            if node_key in path_keys:
                start = path_keys.index(node_key)
                cycle_edges = edge_path[start:]
                key = tuple(sorted((KybOwnershipArtifactValidator._name_key(edge["owner"]),
                                    KybOwnershipArtifactValidator._name_key(edge["owned"]))
                                   for edge in cycle_edges))
                if key and key not in cycle_keys:
                    cycle_keys.add(key)
                    anomalies.append({"type": "cycle", "subject": " -> ".join(path[start:] + [node]), "details": "The ownership graph contains a cycle, so cyclic paths are excluded from percentage calculations.", "citation_ids": sorted({citation for edge in cycle_edges for citation in edge["citation_ids"]})})
                return
            for edge in adjacency.get(node_key, []):
                detect(edge["owned"], path + [node], edge_path + [edge])
        for node in sorted({edge["owner"] for edge in resolved}):
            detect(node, [], [])
        chains = []
        def walk(node, path, percentages, citations):
            if KybOwnershipArtifactValidator._name_key(node) == KybOwnershipArtifactValidator._name_key(target) and percentages:
                calculated = Decimal("100")
                for percentage in percentages:
                    calculated = calculated * percentage / Decimal("100")
                chains.append({"ultimate_owner": path[0], "path": path, "edge_percentages": [KybOwnershipArtifactValidator._number(value) for value in percentages], "calculated_percent": KybOwnershipArtifactValidator._number(calculated), "citation_ids": sorted(set(citations))})
                return
            for edge in adjacency.get(KybOwnershipArtifactValidator._name_key(node), []):
                if KybOwnershipArtifactValidator._name_key(edge["owned"]) in {
                    KybOwnershipArtifactValidator._name_key(item) for item in path
                }:
                    continue
                walk(edge["owned"], path + [edge["owned"]], percentages + [edge["percentage"]], citations + edge["citation_ids"])
        for person in sorted({edge["owner"] for edge in resolved if edge["owner_type"] == "person"}):
            walk(person, [person], [], [])
        chains.sort(key=lambda item: (item["ultimate_owner"], item["path"]))
        direct_edges = [edge for edge in resolved
                        if KybOwnershipArtifactValidator._name_key(edge["owned"])
                        == KybOwnershipArtifactValidator._name_key(target)]
        direct_total = sum((edge["percentage"] for edge in direct_edges), Decimal("0"))
        if direct_total < 100:
            anomalies.append({"type": "incomplete_total", "subject": target, "details": f"Direct interests account for {KybOwnershipArtifactValidator._number(direct_total)}%; {KybOwnershipArtifactValidator._number(Decimal('100') - direct_total)}% is unexplained.", "citation_ids": sorted({citation for edge in direct_edges for citation in edge["citation_ids"]})})
        elif direct_total > 100:
            anomalies.append({"type": "overallocated_total", "subject": target, "details": f"Direct interests account for {KybOwnershipArtifactValidator._number(direct_total)}%, exceeding 100%.", "citation_ids": sorted({citation for edge in direct_edges for citation in edge["citation_ids"]})})
        entity_direct = {edge["owner"] for edge in direct_edges if edge["owner_type"] == "entity"}
        represented = {KybOwnershipArtifactValidator._name_key(node)
                       for chain in chains for node in chain["path"][:-1]}
        for entity in sorted(item for item in entity_direct
                             if KybOwnershipArtifactValidator._name_key(item) not in represented):
            edge = next(edge for edge in direct_edges if edge["owner"] == entity)
            anomalies.append({"type": "incomplete_chain", "subject": entity, "details": "An entity directly owns the applicant but no complete natural-person path to that entity is evidenced.", "citation_ids": edge["citation_ids"]})
        order = {"duplicate_relationship": 0, "inconsistent_percentage": 1, "cycle": 2, "incomplete_total": 3, "overallocated_total": 4, "incomplete_chain": 5}
        anomalies.sort(key=lambda item: (order[item["type"]], item["subject"]))
        relationships = [{"owner": fact["owner"], "owner_type": fact["owner_type"], "owned": fact["owned"], "percentage": KybOwnershipArtifactValidator._number(fact["percentage"]), "citation_id": fact["citation_id"]} for fact in facts]
        relationships.sort(key=lambda item: (item["owner"], item["owned"], item["percentage"], item["citation_id"]))
        return {"relationships": relationships, "chains": chains, "direct_total_percent": KybOwnershipArtifactValidator._number(direct_total), "unexplained_remainder_percent": KybOwnershipArtifactValidator._number(max(Decimal("0"), Decimal("100") - direct_total)), "anomalies": anomalies}

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
            raise ValueError(f"Ownership contribution is missing fields: {', '.join(missing)}")
        run_id = str(artifact["analysis_run_id"])
        UUID(run_id)
        # 3.2.0 adds advisory observations; 3.1.0 contributions validate exactly as before.
        version = artifact["contract_version"]
        if version not in {"3.1.0", "3.2.0"} or artifact["contribution_kind"] != "specialist_contribution":
            raise ValueError("Unsupported Ownership Specialist Contribution contract")
        if artifact["specialist"] != {"name": "kyb-ownership-agent", "version": version} or artifact["specialty"] != "ownership":
            raise ValueError("Unexpected ownership specialist identity")
        if artifact["contribution_id"] != f"ownership-{artifact['task_id']}":
            raise ValueError("contribution_id must equal ownership- plus task_id")

        engine = create_engine(await self._database_url())
        try:
            with engine.connect() as connection:
                run = connection.execute(text("""
                    SELECT applicant.legal_name FROM analysis_runs run
                    JOIN onboarding_cases c ON c.id = run.case_id
                    JOIN applicants applicant ON applicant.id = c.applicant_id
                    WHERE run.id = CAST(:run_id AS uuid)
                """), {"run_id": run_id}).mappings().one_or_none()
                if run is None:
                    raise ValueError("analysis_run_id does not exist")
                case_rows = list(connection.execute(text("""
                    SELECT edge.id::text AS fact_id, document.id::text AS source_id,
                           chunk.id::text AS chunk_id, chunk.section_locator AS locator,
                           edge.excerpt, edge.owner, edge.owner_type, edge.owned,
                           edge.percentage
                    FROM analysis_run_documents snapshot
                    JOIN case_documents document ON document.id = snapshot.document_id AND document.case_id = snapshot.case_id
                    JOIN document_chunks chunk ON chunk.document_id = document.id AND chunk.case_id = snapshot.case_id
                    JOIN case_ownership_edges edge ON edge.document_id = document.id
                                                  AND edge.case_id = document.case_id
                                                  AND edge.chunk_id = chunk.id
                    WHERE snapshot.analysis_run_id = CAST(:run_id AS uuid)
                      AND document.ingestion_status = 'ready'
                      -- Must select exactly what the evidence step selects (direct holdings only).
                      AND edge.holding = 'direct' ORDER BY edge.id
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
                      AND chunk.section_locator IN ('KYB-1.2', 'DOC-4.1') ORDER BY chunk.id
                """), {"run_id": run_id}).mappings())
                passage_rows = list(connection.execute(text(_RUN_PASSAGES_SQL), {"run_id": run_id}).mappings()) \
                    if version == "3.2.0" else []
        finally:
            engine.dispose()

        allowed, facts = {}, []
        for row in case_rows:
            citation_id = f"case-{row['fact_id']}"
            allowed[citation_id] = {"id": citation_id, "source_kind": "case_document", "source_id": row["source_id"], "chunk_id": row["chunk_id"], "locator": row["locator"], "excerpt": row["excerpt"]}
            facts.append({"owner": row["owner"], "owner_type": row["owner_type"],
                          "owned": row["owned"], "percentage": row["percentage"],
                          "citation_id": citation_id})
        for row in policy_rows:
            citation_id = f"policy-{row['chunk_id']}"
            allowed[citation_id] = {"id": citation_id, "source_kind": "policy", "source_id": row["source_id"], "chunk_id": row["chunk_id"], "locator": row["locator"], "excerpt": row["excerpt"]}
        expected = self._calculate(run["legal_name"], facts)
        expected_status = "completed" if not expected["anomalies"] else "partial"
        # The contribution's findings are this deterministic computation, never the model's copy of
        # it: a model re-typing long identifiers slips, and one slip used to fail a correct run.
        artifact["status"] = expected_status
        for field in ("relationships", "chains", "direct_total_percent", "unexplained_remainder_percent", "anomalies"):
            artifact[field] = expected[field]
        # Advisory observations are kept beside the computed graph, never merged into it.
        anomaly_types = {anomaly["type"] for anomaly in expected["anomalies"]}
        # An incomplete-chain note must name the flagged anomaly or the holding of the entity it flags.
        # Relationship rows keep each source's spelling, so they match the anomaly by normalised name.
        unresolved = {self._name_key(anomaly["subject"]) for anomaly in expected["anomalies"] if anomaly["type"] == "incomplete_chain"}
        incomplete_targets = {f"relationship:{row['citation_id']}" for row in expected["relationships"]
                              if row["owner_type"] == "entity" and self._name_key(row["owner"]) in unresolved}
        if unresolved:
            incomplete_targets.add("anomaly:incomplete_chain")
        # A note may state a computed or cited percentage, or the 25% ownership threshold, and no other.
        known_percentages = {round(float(value), 4) for value in (
            *(row["percentage"] for row in expected["relationships"]),
            *(value for chain in expected["chains"] for value in chain["edge_percentages"]),
            *(chain["calculated_percent"] for chain in expected["chains"]),
            expected["direct_total_percent"], expected["unexplained_remainder_percent"], 100, 25)}
        targets = {"run",
                   *(f"relationship:{row['citation_id']}" for row in expected["relationships"]),
                   *(f"chain:{index}" for index in range(len(expected["chains"]))),
                   *(f"anomaly:{kind}" for kind in anomaly_types)}
        observation_allowed = {**_passage_citations(passage_rows), **allowed}
        observations, dropped_observations = [], []
        if version == "3.2.0":
            try:
                observations, dropped_observations = validate_observations(
                    artifact.get("observations"), observation_allowed,
                    kinds={"unexplained_remainder", "control_beyond_shareholding", "incomplete_chain",
                           "percentage_conflict_explanation", "person_name_match", "risk_pattern"},
                    targets=targets, priority={item for item in targets if item.startswith("anomaly:")},
                    # A note may not contradict the computed graph.
                    gates={
                        "unexplained_remainder": lambda about: expected["unexplained_remainder_percent"] > 0,
                        "incomplete_chain": incomplete_targets.__contains__,
                        "percentage_conflict_explanation": lambda about: "inconsistent_percentage" in anomaly_types,
                    },
                    known_percentages=known_percentages)
            except Exception:
                observations, dropped_observations = [], ["*:validator_error"]
        artifact["observations"] = observations
        referenced = [row["citation_id"] for row in expected["relationships"]]
        referenced += [citation for chain in expected["chains"] for citation in chain["citation_ids"]]
        referenced += [citation for anomaly in expected["anomalies"] for citation in anomaly["citation_ids"]]
        referenced += [citation for observation in observations for citation in observation["citations"]]
        artifact["citations"], dropped = _pinned_citations(artifact.get("citations"), observation_allowed, referenced)
        artifact["deterministic_validation"] = {"validator": f"ownership-graph-v{version}", "outcome": "accepted", "assembled_from": "pinned_evidence", "dropped_citation_ids": dropped, "dropped_observation_ids": dropped_observations, "checks": ["edge_deduplication", "percentage_consistency", "direct_total", "indirect_products", "cycle_detection", "citation_pin", "case_scope", "observations"], "validated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")}
        result = Data(data=artifact)
        self.status = f"Accepted {len(artifact['relationships'])} relationships and {len(artifact['chains'])} calculated paths"
        return result
