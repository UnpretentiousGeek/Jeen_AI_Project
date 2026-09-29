# KYB Coordinator V3 — Phase 2 acceptance

Date: 2026-09-20
Branch: `codex/langflow-v3-clean-start`
Pre-change Git baseline: `4af4ead`
Legacy flow (unchanged): `475ec98e-7bbf-41b3-a769-866608299598`
Candidate flow: `17eb207d-3f51-492c-8652-2962efa92b67`

## Result

All 24 Phase 2 acceptance checks passed. The launcher was not switched. The legacy flow remains the immediate production rollback path.

## Acceptance checks

1. **PASS — one true Coordinator Supervisor.** Candidate graph contains exactly one `KybDurableCoordinatorV3` (`CustomComponent-J52gM`).
2. **PASS — no Supervisor Agent nodes.** Candidate contains zero Langflow `Agent` nodes; OpenAI is only the coordinator's model provider.
3. **PASS — exact candidate topology.** Repository graph verifier reports 20 nodes and 19 approved edges with no missing or unexpected node/edge.
4. **PASS — chat memory is context-only.** `KybPostgresqlChatMemoryV3` is retained as a future extension and has no outgoing coordinator edge.
5. **PASS — legacy flow untouched.** Fresh MCP inspection reports the legacy flow still at 16 nodes/18 edges with both legacy Agent nodes present.
6. **PASS — persisted refresh before iteration.** Coordinator reloads the database-owned run snapshot and compares `state_version`/next iteration before accepting a directive.
7. **PASS — durable resume key.** `analysis_run_id`, not Langflow execution-frame identity, selects the logical coordinator run across invocations.
8. **PASS — waiting poll is read-only.** SQL acceptance proves a `waiting_for_human` poll does not advance the version, iteration, or analysis status.
9. **PASS — terminal replay is read-only.** Two live invocations for synthetic run `a5000000-0000-4000-8000-000000000051` returned the same stopped snapshot at iteration 1/state version 11.
10. **PASS — bounded iterations.** Database constraints and SQL acceptance enforce `max_iterations` in the range 1–12 and stop advancement at the bound.
11. **PASS — strict directive structure.** TypeScript, Python, and SQL validators reject unknown fields, invalid schema versions, malformed plans, and wrong primitive types.
12. **PASS — semantic specialist dispatch.** `dispatch_specialist` requires a valid specialty, integer attempt 1–3, matching plan entry, and forbids contradictory action fields.
13. **PASS — semantic checkpoint directive.** `request_checkpoint` requires kind/key/title/explanation/allowed actions/payload with kind-specific action sets and forbids specialist/final/action fields.
14. **PASS — semantic final/proposal/stop directives.** Final findings require cited structured payloads; proposal is restricted to review readiness; stop requires a reason; contradictory combinations fail.
15. **PASS — optimistic directive commit.** Supervisor output is durably committed with exact run, iteration, expected state version, and a database-derived JSONB hash before any operation executes.
16. **PASS — specialist reservation precedes execution.** Dispatch creates a durable task-event reservation keyed by logical run, task/context, specialty, and attempt before calling an A2A specialist; late or unreserved results are rejected.
17. **PASS — specialist correlation and scope.** Contribution saving verifies run/task/context/specialty/attempt lineage and rejects document, policy, or web citations outside persisted scope.
18. **PASS — deterministic human router.** Information responses return to the coordinator without replaying a specialist; retries are bounded; skip, reject, revise, and approve routes are deterministic.
19. **PASS — safe checkpoint continuation.** Checkpoint decisions require the persisted expected version, support exact idempotent replay, reject stale/conflicting replay, and suppress duplicate side effects.
20. **PASS — search authorization is exact.** TinyFish execution requires a running coordinator and the currently persisted operation key plus canonical scope hash; unapproved, altered, or stale payloads cannot be claimed or written.
21. **PASS — fetch/review release is exact.** Only immutable accepted web-result IDs from the approved execution are released; rejected results remain auditable and cross-run reads fail.
22. **PASS — final actions are idempotent.** Exact approved proposal identity and currently persisted running operation are required; replay cannot execute a final action twice or finalize a stopped/suspended run.
23. **PASS — final validation is database-authoritative.** The validator re-reads run/case status, findings, gaps, conflicts, contributions, accepted web evidence, and citation provenance; terminal snapshots with pending work or inconsistent status are rejected, and model-supplied review decisions are never trusted.
24. **PASS — live no-duplicate end-to-end replay.** The synthetic live stop produced one directive and zero operations, contributions, A2A tasks, searches, web evidence, proposed actions, or action results; a repeated invocation left all counts and state version unchanged.

## Verification evidence

- `npm run verify`: 17 files, 71 tests passed.
- Focused Python acceptance: 53 tests passed.
- `npm run db:verify-durable-coordinator`: durable seam passed; all 11 simple coordinator SQL scenarios passed.
- Python compilation and `git diff --check`: passed.
- Live graph verifier: 20 nodes, 19 edges, one durable coordinator, zero Supervisor Agent nodes.
- Live terminal replay graph runs include `ab835161-d1c0-4a59-96e4-3bcab982ffba`, `e47df17c-8802-411d-a5fb-50634140f6ca`, and hardened replay `1b756e30-235a-4940-b881-719100c45ea5`.
- Pre-migration export SHA-256: `bc04ae0ae1455a77229e7b90b891c8b91a5a7447bcab1ec679de64d44de8a01f`.
- Phase 2 export SHA-256: `1440da79bf597788f5d1a30bfb14a58a2f7ea7edf989a0438ae56ae89bd827dd`.

## Rollback verification

1. The launcher still targets the legacy flow; no Phase 3 cutover was performed.
2. The legacy flow remains available and unchanged at 16 nodes/18 edges.
3. Immediate operational rollback is therefore to keep or restore the launcher target to legacy flow `475ec98e-7bbf-41b3-a769-866608299598`.
4. Candidate-only rollback is to import `langflow/exports/KYB Coordinator V3 durable-loop candidate.pre-migration.json` and verify its SHA-256 above.
5. The Phase 2 candidate can be restored from `langflow/exports/KYB Coordinator V3 durable-loop candidate.phase2.json` and verified by its SHA-256 above.
6. Additive migrations 020/021 are intentionally left in place during rollback; they do not affect the legacy launcher and preserve audit/history rows.

The generic `coordinator_v3_operations` table from migration 020 remains a reserved seam, not the active runtime ledger. Phase 2 idempotency is enforced by the committed-iteration table plus the operation-specific durable ledgers: specialist task events/contributions, web search executions/candidates/evidence, checkpoint decisions, action results, and exact persisted `next_action` correlation.

## Phase boundary

Phase 2 builds and proves the candidate only. Phase 3 will switch the launcher, monitor production runs, reconcile or retire legacy runs, and eventually remove the legacy flow.
