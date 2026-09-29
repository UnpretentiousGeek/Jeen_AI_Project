import { describe, expect, it } from "vitest";

import { coordinatorDirectiveV3Schema, parseCoordinatorDirectiveV3 } from "../src/contracts/coordinator-directive-v3.js";

const analysisRunId = "10000000-0000-4000-8000-000000000001";
const plan = [{
  specialty: "entity" as const,
  reason: "Reconcile the declared legal identity.",
  task_objective: "Verify the legal name and registration details.",
  required: true,
}];

const base = {
  schema_version: "1.0" as const,
  analysis_run_id: analysisRunId,
  expected_state_version: 4,
  iteration: 1,
  plan,
  rationale_summary: "Choose exactly one persisted operation.",
};

describe("Coordinator Supervisor directive v3 semantic contract", () => {
  it("accepts a bounded specialist dispatch and enforces retry lineage", () => {
    const first = { ...base, next_action: "dispatch_specialist", target_specialty: "entity", attempt: 1, parent_task_id: null };
    expect(parseCoordinatorDirectiveV3(first)).toEqual(first);
    expect(coordinatorDirectiveV3Schema.safeParse({ ...first, attempt: 2 }).success).toBe(false);
    expect(coordinatorDirectiveV3Schema.safeParse({ ...first, parent_task_id: "old-task" }).success).toBe(false);
    expect(coordinatorDirectiveV3Schema.safeParse({ ...first, target_specialty: "policy" }).success).toBe(false);
  });

  it("dispatches Entity and Ownership first attempts together and nothing else", () => {
    const ownership = { ...plan[0], specialty: "ownership" as const };
    const parallel = {
      ...base, plan: [...plan, ownership], next_action: "dispatch_specialists",
      target_specialties: ["entity", "ownership"], attempt: 1, parent_task_id: null,
    };
    expect(parseCoordinatorDirectiveV3(parallel)).toEqual(parallel);
    for (const invalid of [
      { target_specialties: ["entity", "policy"] },
      { target_specialties: ["entity"] },
      { target_specialties: ["entity", "entity"] },
      { attempt: 2, parent_task_id: "old-task" },
      { plan },
      { target_specialty: "entity" },
    ]) {
      expect(coordinatorDirectiveV3Schema.safeParse({ ...parallel, ...invalid }).success).toBe(false);
    }
  });

  it("requires the full typed checkpoint directive and exact action set", () => {
    const checkpoint = {
      ...base,
      next_action: "request_checkpoint",
      checkpoint_kind: "information_request",
      checkpoint_request_key: "ownership-gap-1",
      checkpoint_title: "Missing ownership evidence",
      checkpoint_explanation: "Provide the missing ownership percentage.",
      allowed_actions: ["submit_clarification", "reject", "skip_for_now"],
      checkpoint_payload: { question: "What percentage does the owner hold?", choices: ["25%", "50%"] },
    };
    expect(coordinatorDirectiveV3Schema.safeParse(checkpoint).success).toBe(true);
    expect(coordinatorDirectiveV3Schema.safeParse({ ...checkpoint, checkpoint_payload: {} }).success).toBe(false);
    expect(coordinatorDirectiveV3Schema.safeParse({ ...checkpoint, allowed_actions: ["approve"] }).success).toBe(false);
    expect(coordinatorDirectiveV3Schema.safeParse({ ...checkpoint, attempt: 1 }).success).toBe(false);
  });

  it("requires strict cited final findings and forbids contradictory fields", () => {
    const finalDirective = {
      ...base,
      next_action: "save_final_findings",
      final_payload: {
        findings: [{
          requirement_code: "IDENTITY-1",
          outcome: "met",
          summary: "Identity supported.",
          rationale: "Pinned evidence matches.",
          confidence: 0.95,
          citations: [{
            source_kind: "case_document",
            document_chunk_id: "20000000-0000-4000-8000-000000000001",
            locator: "page 1",
            excerpt: "Legal entity name",
          }],
        }],
        evidence_gaps: [],
        conflicts: [],
      },
    };
    expect(coordinatorDirectiveV3Schema.safeParse(finalDirective).success).toBe(true);
    expect(coordinatorDirectiveV3Schema.safeParse({ ...finalDirective, terminal_reason: "also stop" }).success).toBe(false);
    expect(coordinatorDirectiveV3Schema.safeParse({
      ...finalDirective,
      final_payload: { ...finalDirective.final_payload, findings: [] },
    }).success).toBe(false);
  });

  it("allows only the review-ready proposal and a reasoned stop", () => {
    expect(coordinatorDirectiveV3Schema.safeParse({
      ...base,
      next_action: "propose_action",
      proposed_action_type: "mark_ready_for_review",
      proposed_action_summary: "Persisted findings are ready for analyst review.",
    }).success).toBe(true);
    expect(coordinatorDirectiveV3Schema.safeParse({ ...base, next_action: "stop", terminal_reason: "Bounded recovery exhausted." }).success).toBe(true);
    expect(coordinatorDirectiveV3Schema.safeParse({ ...base, next_action: "stop" }).success).toBe(false);
  });

  it("rejects unknown fields everywhere", () => {
    expect(coordinatorDirectiveV3Schema.safeParse({
      ...base,
      next_action: "stop",
      terminal_reason: "Finished.",
      unexpected: true,
    }).success).toBe(false);
  });
});
