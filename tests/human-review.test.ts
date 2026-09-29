import { describe, expect, it } from "vitest";

import {
  humanInputResponseSchema,
  humanReviewDecisionSchema,
  parseHumanInputResponse,
  parseHumanReviewDecision,
} from "../src/contracts/human-review.js";

describe("human review contracts", () => {
  it("accepts an idempotent analyst decision command", () => {
    const decision = {
      schema_version: "1.0",
      request_id: "review-001",
      case_id: "case-001",
      analysis_run_id: "run-001",
      proposed_action_id: "action-001",
      decision: "approved",
      decided_by: "analyst-42",
      rationale: "The action is supported by the cited ownership gap.",
      decided_at: "2026-09-18T20:15:00Z",
      idempotency_key: "review-001:approved",
    } as const;

    expect(parseHumanReviewDecision(decision)).toEqual(decision);
  });

  it("rejects a decision without rationale", () => {
    const result = humanReviewDecisionSchema.safeParse({
      schema_version: "1.0",
      request_id: "review-001",
      case_id: "case-001",
      analysis_run_id: "run-001",
      proposed_action_id: "action-001",
      decision: "rejected",
      decided_by: "analyst-42",
      rationale: "",
      decided_at: "2026-09-18T20:15:00Z",
      idempotency_key: "review-001:rejected",
    });

    expect(result.success).toBe(false);
  });

  it("accepts a document response to a clarification request", () => {
    const response = {
      schema_version: "1.0",
      request_id: "input-001",
      case_id: "case-001",
      analysis_run_id: "run-001",
      response: {
        input_type: "document",
        document_ids: ["document-002"],
      },
      submitted_by: "operations-17",
      submitted_at: "2026-09-18T20:16:00Z",
      idempotency_key: "input-001:document-002",
    } as const;

    expect(parseHumanInputResponse(response)).toEqual(response);
  });

  it("rejects an empty document response", () => {
    const result = humanInputResponseSchema.safeParse({
      schema_version: "1.0",
      request_id: "input-001",
      case_id: "case-001",
      analysis_run_id: "run-001",
      response: { input_type: "document", document_ids: [] },
      submitted_by: "operations-17",
      submitted_at: "2026-09-18T20:16:00Z",
      idempotency_key: "input-001:empty",
    });

    expect(result.success).toBe(false);
  });
});
