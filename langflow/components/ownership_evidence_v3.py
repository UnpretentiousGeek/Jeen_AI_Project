import json
import re
from collections import defaultdict
from decimal import Decimal, ROUND_HALF_UP
from uuid import UUID

from sqlalchemy import create_engine, text

from lfx.custom.custom_component.component import Component
from lfx.io import MessageTextInput, Output, SecretStrInput
from lfx.schema.message import Message
from lfx.services.deps import session_scope


class KybOwnershipEvidence(Component):
    display_name = "Retrieve and Calculate Scoped Ownership Evidence"
    description = "Loads cited ownership edges from pinned documents and reconstructs direct and indirect ownership."
    icon = "database"
    name = "KybOwnershipEvidence"

    inputs = [
        MessageTextInput(name="input_value", display_name="Ownership Task Reference", info="JSON with analysis_run_id, task_id, context_id, and optional case_id.", required=True),
        SecretStrInput(name="database_url", display_name="Database URL", info="Private PostgreSQL connection used for pinned evidence retrieval.", required=True, advanced=False),
    ]
    outputs = [Output(display_name="Scoped Evidence", name="evidence", method="retrieve")]

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
    def _number(value):
        quantized = value.quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)
        return float(quantized)

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
                spellings[KybOwnershipEvidence._name_key(name)].add(name)
        display = {key: min(names, key=lambda name: (len(name), name)) for key, names in spellings.items()}
        groups = defaultdict(list)
        for fact in facts:
            groups[(KybOwnershipEvidence._name_key(fact["owner"]),
                    KybOwnershipEvidence._name_key(fact["owned"]))].append(fact)

        anomalies = []
        resolved = []
        for (owner_key, owned_key), group in sorted(groups.items()):
            owner, owned = display[owner_key], display[owned_key]
            # The same relationship at the same percentage in several sources corroborates it;
            # it is resolved once with every citation, so repetition is not an anomaly.
            percentages = sorted({fact["percentage"] for fact in group})
            citation_ids = sorted({fact["citation_id"] for fact in group})
            if len(percentages) > 1:
                anomalies.append({
                    "type": "inconsistent_percentage",
                    "subject": f"{owner} -> {owned}",
                    "details": "Pinned evidence assigns inconsistent percentages to the same relationship.",
                    "citation_ids": citation_ids,
                })
                continue
            resolved.append({
                "owner": owner,
                "owner_type": group[0]["owner_type"],
                "owned": owned,
                "percentage": percentages[0],
                "citation_ids": citation_ids,
            })

        adjacency = defaultdict(list)
        for edge in resolved:
            adjacency[KybOwnershipEvidence._name_key(edge["owner"])].append(edge)

        cycle_keys = set()
        def detect(node, path, edge_path):
            node_key = KybOwnershipEvidence._name_key(node)
            path_keys = [KybOwnershipEvidence._name_key(item) for item in path]
            if node_key in path_keys:
                start = path_keys.index(node_key)
                cycle_edges = edge_path[start:]
                key = tuple(sorted((KybOwnershipEvidence._name_key(edge["owner"]),
                                    KybOwnershipEvidence._name_key(edge["owned"]))
                                   for edge in cycle_edges))
                if key and key not in cycle_keys:
                    cycle_keys.add(key)
                    anomalies.append({
                        "type": "cycle",
                        "subject": " -> ".join(path[start:] + [node]),
                        "details": "The ownership graph contains a cycle, so cyclic paths are excluded from percentage calculations.",
                        "citation_ids": sorted({citation for edge in cycle_edges for citation in edge["citation_ids"]}),
                    })
                return
            for edge in adjacency.get(node_key, []):
                detect(edge["owned"], path + [node], edge_path + [edge])
        for node in sorted({edge["owner"] for edge in resolved}):
            detect(node, [], [])

        chains = []
        def walk(node, path, percentages, citations):
            if KybOwnershipEvidence._name_key(node) == KybOwnershipEvidence._name_key(target) and percentages:
                calculated = Decimal("100")
                for percentage in percentages:
                    calculated = calculated * percentage / Decimal("100")
                chains.append({
                    "ultimate_owner": path[0],
                    "path": path,
                    "edge_percentages": [KybOwnershipEvidence._number(value) for value in percentages],
                    "calculated_percent": KybOwnershipEvidence._number(calculated),
                    "citation_ids": sorted(set(citations)),
                })
                return
            for edge in adjacency.get(KybOwnershipEvidence._name_key(node), []):
                if KybOwnershipEvidence._name_key(edge["owned"]) in {
                    KybOwnershipEvidence._name_key(item) for item in path
                }:
                    continue
                walk(edge["owned"], path + [edge["owned"]], percentages + [edge["percentage"]], citations + edge["citation_ids"])
        people = sorted({edge["owner"] for edge in resolved if edge["owner_type"] == "person"})
        for person in people:
            walk(person, [person], [], [])
        chains.sort(key=lambda item: (item["ultimate_owner"], item["path"]))

        direct_edges = [edge for edge in resolved
                        if KybOwnershipEvidence._name_key(edge["owned"])
                        == KybOwnershipEvidence._name_key(target)]
        direct_total = sum((edge["percentage"] for edge in direct_edges), Decimal("0"))
        if direct_total < 100:
            anomalies.append({
                "type": "incomplete_total",
                "subject": target,
                "details": f"Direct interests account for {KybOwnershipEvidence._number(direct_total)}%; {KybOwnershipEvidence._number(Decimal('100') - direct_total)}% is unexplained.",
                "citation_ids": sorted({citation for edge in direct_edges for citation in edge["citation_ids"]}),
            })
        elif direct_total > 100:
            anomalies.append({
                "type": "overallocated_total",
                "subject": target,
                "details": f"Direct interests account for {KybOwnershipEvidence._number(direct_total)}%, exceeding 100%.",
                "citation_ids": sorted({citation for edge in direct_edges for citation in edge["citation_ids"]}),
            })

        entity_direct_owners = {edge["owner"] for edge in direct_edges if edge["owner_type"] == "entity"}
        represented_entities = {KybOwnershipEvidence._name_key(node)
                                for chain in chains for node in chain["path"][:-1]}
        for entity in sorted(item for item in entity_direct_owners
                             if KybOwnershipEvidence._name_key(item) not in represented_entities):
            edge = next(edge for edge in direct_edges if edge["owner"] == entity)
            anomalies.append({
                "type": "incomplete_chain",
                "subject": entity,
                "details": "An entity directly owns the applicant but no complete natural-person path to that entity is evidenced.",
                "citation_ids": edge["citation_ids"],
            })

        order = {"duplicate_relationship": 0, "inconsistent_percentage": 1, "cycle": 2, "incomplete_total": 3, "overallocated_total": 4, "incomplete_chain": 5}
        anomalies.sort(key=lambda item: (order[item["type"]], item["subject"]))
        relationships = [{
            "owner": fact["owner"],
            "owner_type": fact["owner_type"],
            "owned": fact["owned"],
            "percentage": KybOwnershipEvidence._number(fact["percentage"]),
            "citation_id": fact["citation_id"],
        } for fact in facts]
        relationships.sort(key=lambda item: (item["owner"], item["owned"], item["percentage"], item["citation_id"]))
        return {
            "relationships": relationships,
            "chains": chains,
            "direct_total_percent": KybOwnershipEvidence._number(direct_total),
            "unexplained_remainder_percent": KybOwnershipEvidence._number(max(Decimal("0"), Decimal("100") - direct_total)),
            "anomalies": anomalies,
        }

    async def retrieve(self) -> Message:
        raw = self.input_value.text if isinstance(self.input_value, Message) else self.input_value
        try:
            payload = json.loads(raw)
        except (TypeError, json.JSONDecodeError) as exc:
            raise ValueError("Ownership task reference must be valid JSON") from exc
        if not isinstance(payload, dict):
            raise ValueError("Ownership task reference must be a JSON object")
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
                    SELECT run.case_id::text AS case_id, applicant.legal_name, applicant.jurisdiction
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
                    SELECT edge.id::text AS fact_id, document.id::text AS source_id,
                           chunk.id::text AS chunk_id, chunk.section_locator AS locator,
                           edge.excerpt, edge.owner, edge.owner_type, edge.owned,
                           edge.percentage
                      FROM analysis_run_documents snapshot
                      JOIN case_documents document ON document.id = snapshot.document_id
                                                 AND document.case_id = snapshot.case_id
                      JOIN document_chunks chunk ON chunk.document_id = document.id
                                                AND chunk.case_id = snapshot.case_id
                      JOIN case_ownership_edges edge ON edge.document_id = document.id
                                                    AND edge.case_id = document.case_id
                                                    AND edge.chunk_id = chunk.id
                     WHERE snapshot.analysis_run_id = CAST(:run_id AS uuid)
                       AND document.ingestion_status = 'ready'
                       -- Look-through interests are derived from direct holdings; counting them too double-counts.
                       AND edge.holding = 'direct'
                     ORDER BY edge.id
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
                       AND chunk.section_locator IN ('KYB-1.2', 'DOC-4.1')
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

        citations = []
        facts = []
        for row in case_rows:
            citation_id = f"case-{row['fact_id']}"
            citations.append({"id": citation_id, "source_kind": "case_document", "source_id": row["source_id"], "chunk_id": row["chunk_id"], "locator": row["locator"], "excerpt": row["excerpt"]})
            facts.append({"owner": row["owner"], "owner_type": row["owner_type"],
                          "owned": row["owned"], "percentage": row["percentage"],
                          "citation_id": citation_id})
        for row in policy_rows:
            citations.append({"id": f"policy-{row['chunk_id']}", "source_kind": "policy", "source_id": row["source_id"], "chunk_id": row["chunk_id"], "locator": row["locator"], "excerpt": row["excerpt"]})

        calculation = self._calculate(run["legal_name"], facts)
        status = "completed" if not calculation["anomalies"] else "partial"
        result = {
            "contract_version": "3.2.0",
            "contribution_kind": "specialist_contribution",
            "case_id": run["case_id"],
            "analysis_run_id": run_id,
            "task_id": task_id,
            "context_id": context_id,
            "specialty": "ownership",
            "specialist": {"name": "kyb-ownership-agent", "version": "3.2.0"},
            "applicant": {"legal_name": run["legal_name"], "jurisdiction": run["jurisdiction"]},
            "expected_status": status,
            "expected_calculation": calculation,
            "allowed_citations": citations,
            "searchable_documents": searchable_documents,
            "instructions": "Return a Specialist Contribution, not a finding or decision. Copy deterministic relationships, chains, totals, anomalies, and cited sources exactly.",
        }
        message = Message(text=json.dumps(result, separators=(",", ":"), default=str))
        self.status = f"Calculated {len(calculation['chains'])} ownership paths and {len(calculation['anomalies'])} anomalies"
        return message
