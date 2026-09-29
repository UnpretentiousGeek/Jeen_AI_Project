# KYB Policy V3 acceptance record

Run date: 2026-09-20  
Contract: `Policy Specialist Contribution` `3.2.0`  
Flow ID: `623b5639-b4be-4e2e-bba3-65e5a3158a6d`  
Database: same existing direct local demo PostgreSQL configuration used by the Entity and Ownership V3 specialists  
Scope: Policy V3 behavior plus the shared Policy/Public Research Structured Response transport migration. Entity, Ownership, Coordinator, and frontend work were not modified.

## Final live graph

`Chat Input → Retrieve Applicable Policy → Policy Agent Structured Response → Validate Policy Contribution → Chat Output`

The Agent uses its built-in `structured_response` output with one required `contribution_json` field. The validator decodes that field and checks the complete signed contribution. The legacy parser node was removed. The final graph has five components and four edges.

Langflow Desktop 1.12.2 currently generates an OpenAI strict schema without the required `additionalProperties: false`, so the provider rejects the native strategy. This flow applies a local `prefer_native=False` compatibility setting and uses Langflow's schema-validated prompt fallback while retaining the Structured Response port. The setting can be removed after the installed runtime fixes its native schema generator.

The live marketplace inspection run (`policy-final-inspection-32`) showed:

| Stage | Inspected result |
| --- | --- |
| Chat Input | Valid case/run/task/context reference received. |
| Retrieve Applicable Policy | Prepared 2 applicable requirements from 2 active policy versions pinned to the run. |
| Policy Agent | Returned one `3.2.0` Policy Specialist Contribution; no Finding or Review Decision. |
| Structured Response | Returned one `contribution_json` record that decoded to the complete contribution. |
| Validate Policy Contribution | Accepted 2 requirements and 7 exact citations after all deterministic checks. |
| Chat Output | Returned the validated contribution. |

## Retrieval and validation boundary

- The retrieval component first validates that the supplied `case_id` owns the `analysis_run_id`.
- Policy rows come only from `analysis_run_policy_versions`; case evidence comes only from `analysis_run_documents`.
- Pinned versions are filtered again for superseded state, effective date, jurisdiction, product, and business activity before a requirement can enter the matrix.
- Inapplicable requirements are absent from the matrix and retained only in `excluded_inapplicable_requirements` for audit.
- Requirements and documentary evidence remain separate in `source_scope`, matrix fields, and citation `source_kind` values.
- Exceptions remain `unresolved` unless every required exception-evidence type is present and supported.
- Conflicting applicable passages remain `conflicting` unless exactly one passage carries documented precedence.
- The final validator independently reloads the owning run, active pinned versions, applicant context, case evidence, exact source IDs, chunk IDs, locators, excerpts, and citation references. It also verifies an opaque retrieval-integrity proof covering the complete matrix.
- Empty successful error objects are normalized to `null`; a successful contribution with any other error value is rejected.

## Acceptance matrix

| # | Acceptance | Input | Inspected actual result | Result |
| --- | --- | --- | --- | --- |
| 1 | Different applicant contexts retrieve different requirements | Domestic run `...0031`; marketplace run `...0032` | Domestic returned `KYB-BASE-2`; marketplace returned `KYB-BASE-2` and `MRKT-CB-1`. | PASS |
| 2 | Inapplicable requirements are excluded | Domestic software / domestic payments | `MRKT-CB-1`, licensing, and conflict requirements were absent from the matrix. | PASS |
| 3 | Superseded policy versions are excluded | Run `...0033` pins baseline `1.0` and `2.0` | `KYB-BASE-OLD` was absent; version `...0011` was explicitly excluded with reason `superseded`. | PASS |
| 4 | Unsupported exception remains unresolved | Money-services run `...0034` | `LIC-MS-1` was `unsupported`; `LIC-EX-REFERRAL` was `unresolved`; missing license and exception evidence remained gaps. | PASS |
| 5 | Conflicting policy passages produce an explicit conflict | Marketplace run `...0035` | Monthly and quarterly `MRKT-CONFLICT-1` passages produced status `conflicting`, two policy citations, and one explicit conflict record; no precedence was invented. | PASS |
| 6 | Missing documentary evidence produces an evidence gap | Run `...0036` | `KYB-BASE-2` was `unsupported` with `Missing required evidence: incorporation_record`. | PASS |
| 7 | Cross-case/run misuse is rejected | Run `...0031` paired with case `...0037` | Retrieval failed before the Agent with `case_id does not own the supplied analysis_run_id`. | PASS |
| 8 | Fabricated or altered citations are rejected | Prompt-injection run `...0038` plus direct one-field tamper test | The injected request did not alter citations and the contribution validated. An otherwise-valid artifact with one citation `source_id` changed to `fabricated-source` was rejected with `Policy contribution content differs from the deterministically retrieved matrix`. | PASS |

## Artifacts

- Secret-scrubbed Langflow export: `artifacts/flows/KYB-Policy-V3.json`
- Machine-readable result summary: `artifacts/acceptance/policy-v3-runs/results.json`
- Raw live run responses: `artifacts/acceptance/policy-v3-runs/01-domestic.json` through `08-citation-injection-guard.json`
- Direct altered-citation rejection: `artifacts/acceptance/policy-v3-runs/08b-validator-tamper.json`
- Synthetic Policy V3 fixtures: `db/seeds/005_policy_v3_acceptance.sql`
- Retrieval and validator components: `langflow/components/policy_retrieval_v3.py` and `langflow/components/policy_validator_v3.py`
- Agent instructions: `langflow/prompts/policy_agent_v3.md`
- Reproducible acceptance scripts: `scripts/verify-policy-v3.mjs` and `tests/policy-validator-tamper.py`

Supporting checks: A live smoke run returned an accepted Policy contribution through `structured_response`. A canvas regression check confirms that the visible Structured Response handle connects directly to validation and that the schema contains `contribution_json`. Local TypeScript verification passed 14 test files and 51 tests. The exported flow contains five nodes and four edges, and its password-marked database fields are redacted.

## Limitations

1. The deterministic demo extractor consumes normalized `POLICY_REQUIREMENT` and `CASE_EVIDENCE` lines from synthetic fixtures. A future ingestion flow must produce equivalent normalized records from PDF/OCR inputs; unstructured prose is not guessed into evidence.
2. Citations are stable source-line excerpts within a stored chunk, with the original source ID, chunk ID, and section locator. The current database does not store independent line IDs.
3. Model/provider outages or malformed Structured Response data fail closed at validation. Policy V3 does not yet include a bounded repair/retry branch or a persisted technical-failure artifact.
4. The demo integrity proof is keyed from the private local database connection value. A production implementation should use a dedicated server-side signing key or independently recompute the complete matrix in the validator.
5. This specialist returns a validated contribution but is not yet published through A2A or persisted by a Coordinator. Coordinator work was deliberately not started.
6. The export boundary redacts the local database connection, so an imported copy must be configured with the same server-side `DATABASE_URL` before execution.
