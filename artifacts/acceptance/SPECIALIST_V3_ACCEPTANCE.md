# KYB Entity V3 and KYB Ownership V3 acceptance record

Run date: 2026-09-20  
Contract: `Specialist Contribution` `3.1.0`  
Database: existing direct local demo PostgreSQL configuration (`jeen` database on `127.0.0.1:5432`)  
Scope: Entity and Ownership only. No Policy, Public Research, Coordinator, or frontend work was performed.

## Live flows and exports

| Flow | Live flow ID | Final graph | Export |
| --- | --- | --- | --- |
| KYB Entity V3 | `9db6e3bd-132a-4a7d-909d-d06ad94f550a` | Chat Input → scoped deterministic reconciliation → Agent structured response → deterministic contribution validator → Chat Output | `artifacts/flows/KYB-Entity-V3.json` |
| KYB Ownership V3 | `9f248e41-f6f0-44d6-ad04-3ff1b09f1655` | Chat Input → scoped graph calculation → Agent structured response → deterministic contribution validator → Chat Output | `artifacts/flows/KYB-Ownership-V3.json` |

Both final Langflow graphs validated successfully with five components and no graph errors.

## Contract and validation boundary

Both outputs use `contract_version: "3.1.0"` and
`contribution_kind: "specialist_contribution"`. They do not contain Findings,
Decisions, approvals, rejections, or risk scores.

The retrieval/calculation component reads only documents and policy versions pinned
to the supplied analysis run. It rejects a supplied `case_id` that does not own the
run. The final validator independently reloads the pinned snapshot, recomputes the
expected reconciliation or ownership graph, compares every material field, and
requires exact source ID, chunk ID, locator, and excerpt equality for citations.

## Entity acceptance matrix

| Acceptance | Input / run | Expected | Actual inspected result | Result |
| --- | --- | --- | --- | --- |
| Legal name, identifier, jurisdiction, and all typed addresses match after harmless normalization | Case `...0021`; run `a1000000-0000-4000-8000-000000000021`; final task `entity-final-21` | Six field rows; originals retained; normalized values match; completed | Six rows returned. `legal_name`, `jurisdiction`, `identifier`, `registered`, `operating`, and `mailing` were all `match`; deterministic validation `accepted` | PASS |
| Registered versus operating versus mailing distinction | Same case/run | Different address values must not conflict across types | Registered `100 Market…`, operating `500 Howard…`, and mailing `PO Box 77…` were compared only within their own types and each matched | PASS |
| Conflicting registered addresses | Case `...0022`; run `a1000000-0000-4000-8000-000000000022`; task `entity-matrix-22` | Registered address conflict while operating/mailing remain independent | `address:registered=conflict`; `address:operating=match`; `address:mailing=match`; status `partial` | PASS |
| Identifier mismatch | Same case/run | Registration-number conflict | Declared `GB-778899` versus documentary `GB-112233` returned `identifier=conflict`; status `partial` | PASS |
| Absent evidence | Case `...0023`; run `a1000000-0000-4000-8000-000000000023`; task `entity-matrix-23` | Missing, not invented or failed | All required entity rows returned `missing`; no citation was invented; status `partial` | PASS |
| Cross-case isolation | Supplied case `...0022` with run owned by case `...0021`; task `entity-cross-case` | Reject before the Agent | Run rejected by scoped retrieval; no Specialist Contribution produced | PASS |
| Invalid citation / prompt-injection resistance | Case `...0024`; run `a1000000-0000-4000-8000-000000000024`; task `entity-matrix-24` | Ignore requested fake source and retain only pinned citation | Output contained only `case-60000000-0000-0000-0000-000000000024`; fake source/chunk text was not cited; deterministic citation validation `accepted` | PASS |

## Ownership acceptance matrix

| Acceptance | Input / run | Expected | Actual inspected result | Result |
| --- | --- | --- | --- | --- |
| Complete direct ownership | Case `...0021`; run `a1000000-0000-4000-8000-000000000021`; task `ownership-matrix-21` | 60% + 40% = 100%; no remainder | Direct total `100`; remainder `0`; Ana Ruiz `60%`, Ben Cole `40%`; no anomalies; status `completed` | PASS |
| Multi-level indirect ownership | Case `...0025`; run `a1000000-0000-4000-8000-000000000025`; task `ownership-matrix-25` | 50% × 80% = 40% for each upstream person, plus direct 20% | Ali Khan `40%` and Bea Wong `40%` through Cedar Holdings; Cara Diaz direct `20%`; direct total `100`; no anomalies; status `completed` | PASS |
| Incomplete ownership | Case `...0026`; run `a1000000-0000-4000-8000-000000000026`; task `ownership-matrix-26` | 85% supported and 15% unexplained | Direct total `85`; remainder `15`; anomaly `incomplete_total`; status `partial` | PASS |
| Duplicate relationship | Case `...0027`; run `a1000000-0000-4000-8000-000000000027`; task `ownership-matrix-27` | Detect duplicate without double-counting | `duplicate_relationship` returned; duplicate edge was collapsed for totals | PASS |
| Inconsistent percentages | Same case/run | Exclude unresolved edge from totals and report conflict | `inconsistent_percentage` returned for Priya Nair → Graph Cycle Ltd; unresolved edge excluded | PASS |
| Cycle and incomplete chain | Same case/run | Detect cycle, avoid recursive multiplication, and surface missing chain | Anomalies included `cycle`, `incomplete_chain`, and `incomplete_total`; only the supported Marco Silva 40% path was emitted | PASS |
| Cross-case isolation | Supplied case `...0022` with run owned by case `...0021`; task `ownership-cross-case` | Reject before the Agent | Run rejected by scoped retrieval; no Specialist Contribution produced | PASS |
| Invalid citation / prompt-injection resistance | Case `...0028`; run `a1000000-0000-4000-8000-000000000028`; task `ownership-matrix-28` | Ignore requested other-case source and keep pinned citation | Output contained only `case-60000000-0000-0000-0000-000000000028`; fake cross-case source/chunk was not cited; status `completed` | PASS |

## Supporting verification

- Langflow graph validation: Entity valid, five components, zero errors.
- Langflow graph validation: Ownership valid, five components, zero errors.
- Local TypeScript verification: 14 test files passed; 51 tests passed.
- Python syntax verification passed for all four custom Langflow components.
- The V3 contract test rejects a relationship that references a citation absent from the contribution's pinned citation set.

## Remaining limitations

1. The deterministic demo extractor consumes normalized `ENTITY_FACT` and
   `OWNERSHIP_EDGE` lines produced by the synthetic fixtures. A future ingestion
   flow must produce those normalized facts from PDFs/OCR; prose-only legacy chunks
   are intentionally treated as missing rather than guessed.
2. Citations are pinned at chunk/section granularity. Multiple facts in one chunk
   share one citation and excerpt; line-level locators are not yet stored.
3. The Agent's structured-response mechanism may still fail on provider or model
   outages. The validator fails closed, but these specialist flows do not yet have
   a separate bounded repair/retry branch or persisted failure artifact.
4. Contributions are returned by each specialist but are not yet published through
   A2A or persisted by a Coordinator. That work is deliberately deferred by scope.
5. The exported flow JSON is produced through the Langflow export boundary, which
   redacts sensitive fields. The live flows retain the existing direct local demo
   database configuration.
