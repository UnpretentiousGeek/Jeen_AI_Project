# KYB Public Research V3 acceptance record

Run date: 2026-09-20  
Contract: `Public Research Specialist Contribution` `3.3.0`  
Flow ID: `eaccfa78-adb0-4119-810a-ab141417dafb`  
Scope: Public Research V3 behavior plus the shared Policy/Public Research Structured Response transport migration. Entity, Ownership, Coordinator, and frontend work were not modified.

## Final live graph

`Chat Input → Scope Public Research Operation → Public Research Agent Structured Response → Validate Public Research Contribution → Chat Output`

The Agent uses its built-in `structured_response` output with one required `contribution_json` field, which the validator decodes before checking the complete signed contribution. The legacy parser node was removed. The final graph has five components and four edges. It contains no generic API Request, Firecrawl, search, fetch, or other network-capable component. Langflow exposes it as an A2A agent whose card describes the bounded proposal and accepted-result analysis capability.

Langflow Desktop 1.12.2 currently generates an OpenAI strict schema without the required `additionalProperties: false`, so the provider rejects the native strategy. This flow applies a local `prefer_native=False` compatibility setting and uses Langflow's schema-validated prompt fallback while retaining the Structured Response port. The setting can be removed after the installed runtime fixes its native schema generator.

## Operations and authority boundary

### `propose_research`

The scope component validates `analysis_run_id`, `task_id`, `context_id`, `case_id`, case/run ownership, `operation_mode`, and `evidence_gap_id`. It loads one gap documented in that run and produces one exact proposal containing:

- claim and claim identifier;
- exact query;
- allowed domains;
- disclosed applicant fields;
- result limit;
- rationale;
- explicit Search Execution Approval requirement; and
- explicit separate Web Result Review requirement.

This operation has no network access and returns no web citation.

### `analyze_accepted_results`

The scope component validates the same task/case/run identity plus an exact `search_execution_id` and caller-supplied `approved_plan`. It requires the stored proposed action, approval, execution, scope hash, query, domains, disclosure, limit, claim, run, and case to correlate. It reads immutable stored results and excludes any result whose separate review state is not `accepted`, whose content hash differs, whose URL is outside the approved domain scope, or whose applicant match lacks corroboration.

Search execution approval is never treated as evidence acceptance. A later search can appear only as a new bounded proposal with fresh execution approval and another result review.

## Deterministic validation

The final validator verifies the complete contribution integrity proof and independently reloads storage to check:

- case/run ownership and operation mode;
- documented-gap provenance;
- exact approved query, domains, disclosure, result limit, claim, execution, and review;
- immutable result IDs and accepted review state;
- URL, canonical URL, title, publisher, source date, retrieval time, excerpt, content hash, and retrieval method;
- citation references used by each claim and conflict; and
- fresh approval and review boundaries on follow-up proposals.

The direct tamper test altered a citation excerpt and recomputed the contribution integrity proof. The validator still rejected it by comparing the citation to the accepted immutable result in storage.

## Acceptance matrix

| # | Acceptance | Inspected actual result | Result |
| --- | --- | --- | --- |
| 1 | Same-name unrelated company is rejected | The result matched only `legal_name`; no identifier, official domain, address-plus-jurisdiction pair, or supplied corroboration matched. It was excluded as `no_reliable_applicant_match`. | PASS |
| 2 | Registration evidence does not support licensing | The applicant-matched registry result was retained as a limitation citation, but the licensing assessment stayed `evidence_gap` with no supporting citation. | PASS |
| 3 | Contradictory accepted sources create an explicit conflict | One accepted source supported licensing and one contradicted it. The claim outcome was `conflicting`, with both citation sets and an explicit conflict record. | PASS |
| 4 | Insufficient results create a gap or bounded follow-up | The claim stayed `evidence_gap`. The output contained one exact identifier-specific follow-up proposal with result limit `3`, fresh approval, and separate result review requirements. | PASS |
| 5 | Pending, rejected, and unapproved results are excluded | A mixed batch contributed only its accepted result. `pending_review`, `rejected`, and result-without-review-decision entries were listed as excluded and did not affect the supported claim. | PASS |
| 6 | Outside approved query/domain/disclosure scope is rejected | An accepted result from an unapproved domain was excluded. Caller-supplied altered query, broadened domain list, and broadened disclosure list were each rejected before analysis. | PASS |
| 7 | Cross-case/run input is rejected | A valid run paired with a different case failed before the Agent with `case_id does not own the supplied analysis_run_id`. | PASS |
| 8 | Fabricated or altered citations are rejected | After an excerpt was altered and the integrity proof was recomputed, the validator rejected the citation because stored URL/result/excerpt/date/hash/review/plan provenance differed. | PASS |

Proposal verification also passed: the exact query, domains, disclosed applicant fields, result limit, claim, rationale, and both human approval boundaries were present.

## Artifacts

- Secret-scrubbed flow export: `artifacts/flows/KYB-Public-Research-V3.json`
- Machine-readable results: `artifacts/acceptance/public-research-v3-runs/results.json`
- Raw live run evidence: `artifacts/acceptance/public-research-v3-runs/01-proposal.json` through `09-citation-guard.json`
- Direct citation-tamper rejection: `artifacts/acceptance/public-research-v3-runs/09b-validator-tamper.json`
- Synthetic fixtures: `db/seeds/006_public_research_v3_acceptance.sql`
- Flow components: `langflow/components/public_research_scope_v3.py` and `public_research_validator_v3.py`
- Agent instructions: `langflow/prompts/public_research_agent_v3.md`
- Reproducible verification: `scripts/verify-public-research-v3.mjs` and `tests/public-research-validator-tamper.py`

## Remaining limitations

1. Synthetic result excerpts include normalized `PUBLIC_EVIDENCE` facts. A future approved TinyFish execution route and ingestion stage must normalize arbitrary fetched pages into equivalent facts without trusting page instructions.
2. Search and fetch are intentionally absent from this specialist. TinyFish Search/Fetch should live only behind the future Coordinator's explicit execution-approval route; that route was not started.
3. Entity-match confidence values are deterministic demo weights, not calibrated probabilities. They cannot override a missing identifier or a contradiction.
4. Model/provider outages or a response with no JSON object fail closed. The specialist has no persisted bounded retry branch yet.
5. Validation failures currently surface as Langflow graph errors. A future coordinator can map them to typed specialist failure artifacts without weakening the checks.
6. The A2A Agent Card is live, but no Coordinator dispatch or persistence was implemented, by design.
7. The export redacts the local database connection. An imported copy must be configured with the same server-side `DATABASE_URL`.

## Structured Response migration check

A live proposal smoke run returned an accepted `proposal_ready` contribution through `structured_response`. The exported graph contains five nodes and four edges, the Agent schema contains `contribution_json`, and its Structured Response edge connects directly to the validator.
