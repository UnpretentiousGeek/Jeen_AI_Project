import { describe, expect, it } from "vitest";

import {
  coordinatorCheckpointDecisionSchema,
  coordinatorCheckpointRequestSchema,
  parseCoordinatorCheckpointRequest,
  routeCoordinatorCheckpointDecision,
} from "../src/contracts/coordinator-checkpoint-v3.js";

const ids = {
  checkpoint: "30000000-0000-4000-8000-000000000001",
  gap: "30000000-0000-4000-8000-000000000004",
  result1: "30000000-0000-4000-8000-000000000002",
  result2: "30000000-0000-4000-8000-000000000003",
};
const hash = "a".repeat(64);

function base(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: "1.0",
    checkpoint_id: ids.checkpoint,
    request_id: "request-1",
    checkpoint_version: 1,
    expected_state_version: 7,
    parent_checkpoint_id: null,
    parent_request_id: null,
    originating_task_id: "task-1",
    originating_context_id: "context-1",
    title: "Review needed",
    explanation: "A human decision is required before the supervisor can continue.",
    expires_at: "2026-09-21T00:00:00Z",
    checkpoint_kind: "information_request",
    allowed_actions: ["submit_clarification", "reject", "skip_for_now"],
    payload: {
      question: "Which address is current?",
      choices: ["Registered", "Operating"],
    },
    ...overrides,
  };
}

function decision(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: "1.0",
    request_id: "request-1",
    checkpoint_id: ids.checkpoint,
    checkpoint_version: 1,
    expected_state_version: 7,
    action: "skip_for_now",
    response_payload: {},
    authenticated_actor_id: "analyst-1",
    idempotency_key: "decision-1",
    decided_at: "2026-09-20T12:00:00Z",
    ...overrides,
  };
}

describe("Coordinator checkpoint v3 contracts", () => {
  it("lets an analyst continue past an empty registry search without ending the run", () => {
    const request = parseCoordinatorCheckpointRequest(base({
      checkpoint_kind: "conflict_review",
      allowed_actions: ["continue_without_evidence", "escalate", "reject", "skip_for_now"],
      payload: { question: "The registry search found nothing. How should the case proceed?", choices: ["Continue", "Escalate"] },
    }));
    const route = routeCoordinatorCheckpointDecision(request, coordinatorCheckpointDecisionSchema.parse(
      decision({ action: "continue_without_evidence", response_payload: { comment: "Keep the gap open." } }),
    ));
    expect(route).toEqual({ route: "continue_without_evidence" });
  });

  it("accepts a structured request containing every distinct Identity and Ownership question", () => {
    const questions = [
      { id: "entity:address:registered", specialty: "entity", field: "address", question: "Verify the registered address." },
      { id: "ownership:direct_total", specialty: "ownership", field: "direct_total", question: "Explain the ownership remainder." },
    ];
    const request = base({ payload: {
      question: "Provide the requested information.",
      questions,
    } });
    expect(coordinatorCheckpointRequestSchema.safeParse(request).success).toBe(true);
    expect(coordinatorCheckpointRequestSchema.safeParse({ ...request, payload: {
      question: "Provide the requested information.",
      questions: [questions[0], questions[0]],
    } }).success).toBe(false);
  });
  it("accepts agent-authored answer options and rejects inconsistent ones", () => {
    const parse = (payload: Record<string, unknown>) => coordinatorCheckpointRequestSchema.safeParse(base({ payload })).success;
    expect(parse({ question: "Which markets?", choices: ["US", "EU"], multiple: true, allow_custom: false })).toBe(true);
    expect(parse({ question: "Which markets?", choices: ["US", "US"] })).toBe(false);
    expect(parse({ question: "Which markets?", choices: ["US"], multiple: "yes" })).toBe(false);
    const question = { id: "entity:address", specialty: "entity", field: "address", question: "Which address is current?" };
    expect(parse({ question: "Provide information.", questions: [{ ...question, choices: ["Registered", "Operating"], allow_custom: false }] })).toBe(true);
    expect(parse({ question: "Provide information.", questions: [{ ...question, allow_custom: false }] })).toBe(false);
  });

  it("accepts each choice's dated sources and a suggestion only when both name listed choices", () => {
    const parse = (fields: Record<string, unknown>) => coordinatorCheckpointRequestSchema.safeParse(base({ payload: {
      question: "Provide information.",
      questions: [{ id: "ownership:1", specialty: "ownership", field: "inconsistent_percentage",
        question: "What percentage?", choices: ["24% (proxy)", "24.12% (13D/A)"], ...fields }],
    } })).success;
    const details = [{ choice: "24.12% (13D/A)", sources: [{ as_of: "2026-07-15", excerpt: "24.12%" }] }];
    expect(parse({ choice_details: details, suggested_choice: "24.12% (13D/A)",
      suggestion_reason: "Most recent dated source." })).toBe(true);
    expect(parse({ suggested_choice: "25%" })).toBe(false);
    expect(parse({ choice_details: [{ ...details[0], choice: "25%" }] })).toBe(false);
    expect(parse({ choice_details: [{ ...details[0], sources: [{ as_of: null, excerpt: null, page: 6 }] }] })).toBe(false);
    expect(parse({ choice_details: [{ ...details[0], declared: true,
      sources: [{ label: "13D/A, page 6", citation_id: "case-o3", as_of: null, excerpt: null }] }] })).toBe(true);
  });

  it("accepts strict information requests and rejects unknown fields/control text", () => {
    expect(parseCoordinatorCheckpointRequest(base())).toEqual(base());
    expect(coordinatorCheckpointRequestSchema.safeParse({ ...base(), extra: true }).success).toBe(false);
    expect(coordinatorCheckpointRequestSchema.safeParse({
      ...base(),
      title: "Needs\nreview",
    }).success).toBe(false);
    expect(coordinatorCheckpointRequestSchema.safeParse({
      ...base(),
      payload: { question: "Question", choices: ["A"], extra: true },
    }).success).toBe(false);
  });

  it("enforces action sets and checkpoint parent/version lineage", () => {
    expect(coordinatorCheckpointRequestSchema.safeParse({
      ...base(),
      allowed_actions: ["submit_clarification", "changes_requested", "skip_for_now"],
    }).success).toBe(false);
    expect(coordinatorCheckpointRequestSchema.safeParse({
      ...base(),
      checkpoint_version: 2,
      parent_checkpoint_id: ids.checkpoint,
      parent_request_id: "request-1",
    }).success).toBe(true);
    expect(coordinatorCheckpointRequestSchema.safeParse({
      ...base(),
      checkpoint_version: 2,
      parent_checkpoint_id: null,
      parent_request_id: "request-1",
    }).success).toBe(false);
    expect(coordinatorCheckpointRequestSchema.safeParse({
      ...base(),
      originating_context_id: null,
    }).success).toBe(true);
  });

  it("accepts exact search and analyst approval payloads", () => {
    const search = base({
      checkpoint_kind: "search_execution_approval",
      allowed_actions: ["approve", "changes_requested", "reject", "skip_for_now"],
      payload: {
        approved_scope: {
          evidence_gap_id: ids.gap,
          claim_id: "claim-1",
          claim: "The applicant holds the stated license.",
          query: "Applicant license registry",
          allowed_domains: ["regulator.example"],
          disclosed_applicant_fields: ["legal_name", "jurisdiction"],
          result_limit: 5,
          rationale: "Resolve the documented licensing gap.",
        },
        scope_hash: hash,
      },
    });
    expect(coordinatorCheckpointRequestSchema.safeParse(search).success).toBe(true);
    const analyst = base({
      checkpoint_kind: "analyst_approval",
      allowed_actions: ["approve", "changes_requested", "reject", "skip_for_now"],
      payload: {
        proposal: { action_type: "mark_ready_for_review", summary: "Record the case as ready for review." },
        proposal_hash: hash,
      },
    });
    expect(coordinatorCheckpointRequestSchema.safeParse(analyst).success).toBe(true);
  });

  it("requires web-result summaries with unique complete result IDs", () => {
    const web = base({
      checkpoint_kind: "web_result_review",
      allowed_actions: ["accept", "reject", "skip_for_now"],
      payload: {
        pending_results: [
          { result_id: ids.result1, url: "https://example.com/a", title: "Registry A", publisher: "Registry", checksum: `sha256:${hash}` },
          { result_id: ids.result2, url: "https://example.com/b", title: "Registry B", publisher: "Registry", checksum: `sha256:${hash}` },
        ],
      },
    });
    expect(coordinatorCheckpointRequestSchema.safeParse(web).success).toBe(true);
    expect(coordinatorCheckpointRequestSchema.safeParse({
      ...web,
      payload: { pending_results: [{ result_id: "not-a-uuid", url: "https://example.com/a", title: "A", publisher: "P", checksum: `sha256:${hash}` }] },
    }).success).toBe(false);
  });

  it("routes skip_for_now as an empty no-transition result", () => {
    expect(routeCoordinatorCheckpointDecision(base(), decision())).toEqual({
      route: "pending",
      transition: false,
    });
    expect(() => routeCoordinatorCheckpointDecision(base(), decision({ response_payload: { note: "wait" } })))
      .toThrow("empty response_payload");
  });

  it("protects search and proposal hashes and requires structured changes", () => {
    const search = base({
      checkpoint_kind: "search_execution_approval",
      allowed_actions: ["approve", "changes_requested", "reject", "skip_for_now"],
      payload: {
        approved_scope: {
          evidence_gap_id: ids.gap, claim_id: "claim-1", claim: "Claim", query: "Query",
          allowed_domains: ["regulator.example"], disclosed_applicant_fields: ["legal_name"],
          result_limit: 1, rationale: "Reason",
        },
        scope_hash: hash,
      },
    });
    expect(routeCoordinatorCheckpointDecision(search, decision({ action: "approve", response_payload: { scope_hash: hash } })))
      .toEqual({ route: "execute_search", scope_hash: hash });
    expect(() => routeCoordinatorCheckpointDecision(search, decision({ action: "approve", response_payload: { scope_hash: "b".repeat(64) } })))
      .toThrow("scope_hash was altered");
    expect(() => routeCoordinatorCheckpointDecision(search, decision({ action: "changes_requested", response_payload: {} })))
      .toThrow("structured requested_changes");
    expect(routeCoordinatorCheckpointDecision(search, decision({
      action: "changes_requested",
      response_payload: { requested_changes: { comment: "Narrow the query." } },
    }))).toEqual({
      route: "request_revised_search",
      evidence_gap_id: ids.gap,
      original_scope_hash: hash,
      requested_changes: { comment: "Narrow the query." },
    });
    expect(routeCoordinatorCheckpointDecision(search, decision({ action: "reject" }))).toEqual({
      route: "continue_without_search",
      evidence_gap_id: ids.gap,
      claim_id: "claim-1",
      claim: "Claim",
    });
  });

  it("requires exactly one accept/reject rationale for every pending web result", () => {
    const web = base({
      checkpoint_kind: "web_result_review",
      allowed_actions: ["accept", "reject", "skip_for_now"],
      payload: {
        pending_results: [
          { result_id: ids.result1, url: "https://example.com/a", title: "A", publisher: "P", checksum: `sha256:${hash}` },
          { result_id: ids.result2, url: "https://example.com/b", title: "B", publisher: "P", checksum: `sha256:${hash}` },
        ],
      },
    });
    const routed = routeCoordinatorCheckpointDecision(web, decision({
      action: "accept",
      response_payload: {
        result_decisions: [
          { result_id: ids.result2, decision: "reject", rationale: "Not the applicant." },
          { result_id: ids.result1, decision: "accept", rationale: "Official matching record." },
        ],
      },
    }));
    expect(routed).toMatchObject({
      route: "release_web_results",
      accepted_result_ids: [ids.result1],
      rejected_result_ids: [ids.result2],
    });
    expect(() => routeCoordinatorCheckpointDecision(web, decision({
      action: "accept",
      response_payload: { result_decisions: [{ result_id: ids.result1, decision: "accept", rationale: "Only one." }] },
    }))).toThrow("every pending result");
    expect(() => routeCoordinatorCheckpointDecision(web, decision({
      action: "accept",
      response_payload: { result_decisions: [
        { result_id: ids.result1, decision: "accept", rationale: "A" },
        { result_id: ids.result1, decision: "accept", rationale: "Duplicate" },
      ] },
    }))).toThrow("exactly one");
  });

  it("rejects stale decisions and accepts analyst proposal approval", () => {
    const analyst = base({
      checkpoint_kind: "analyst_approval",
      allowed_actions: ["approve", "changes_requested", "reject", "skip_for_now"],
      payload: {
        proposal: { action_type: "mark_ready_for_review", summary: "Ready for review." },
        proposal_hash: hash,
      },
    });
    expect(routeCoordinatorCheckpointDecision(analyst, decision({
      action: "approve",
      response_payload: { proposal_hash: hash },
    }))).toEqual({ route: "execute_action", proposal_hash: hash });
    expect(() => routeCoordinatorCheckpointDecision(analyst, decision({ expected_state_version: 8 })))
      .toThrow("pending checkpoint version");
    expect(routeCoordinatorCheckpointDecision(analyst, decision({
      action: "changes_requested",
      response_payload: { requested_changes: { comment: "Run a web search." } },
    }))).toEqual({ route: "analyst_revision", requested_changes: { comment: "Run a web search." } });
  });
});
