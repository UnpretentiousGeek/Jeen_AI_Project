import { describe, expect, it } from "vitest";

import {
  InMemoryApprovalDecisionStore,
  proposeInformationRequest,
  submitAnalystDecision,
} from "../src/workflow/approval.js";

const proposal = {
  reviewRequestId: "review-request-001",
  caseId: "case-001",
  analysisRunId: "run-001",
  correlationId: "correlation-001",
  action: {
    id: "action-001",
    type: "record_information_request" as const,
    summary: "Request the missing beneficial-owner declaration.",
    finding_ids: ["finding-001"],
    citation_ids: ["citation-001"],
    payload: {
      recipient: "applicant",
      subject: "Complete ownership information required",
      requested_items: ["Identify the owner of the remaining 18% interest."],
      delivery_channel: "case_portal" as const,
    },
    idempotency_key: "run-001:ownership-information-request",
    requires_approval: true as const,
  },
};

function decision(value: "approved" | "rejected" | "changes_requested" = "approved") {
  return {
    schema_version: "1.0",
    request_id: proposal.reviewRequestId,
    case_id: proposal.caseId,
    analysis_run_id: proposal.analysisRunId,
    proposed_action_id: proposal.action.id,
    decision: value,
    decided_by: "analyst-42",
    rationale: "The cited ownership gap supports a targeted information request.",
    decided_at: "2026-09-19T18:00:00.000Z",
    idempotency_key: `${proposal.reviewRequestId}:${value}`,
  };
}

describe("analyst approval boundary", () => {
  it("executes one approved information-request action idempotently", async () => {
    const store = new InMemoryApprovalDecisionStore();
    await expect(proposeInformationRequest(proposal, store)).resolves.toBe("stored");
    await expect(proposeInformationRequest(proposal, store)).resolves.toBe("duplicate");

    await expect(submitAnalystDecision({
      command: decision(),
      authorization: { actorId: "analyst-42", roles: ["compliance_analyst"] },
      store,
    })).resolves.toBe("executed");
    await expect(submitAnalystDecision({
      command: decision(),
      authorization: { actorId: "analyst-42", roles: ["compliance_analyst"] },
      store,
    })).resolves.toBe("duplicate");

    expect(store.executionCount()).toBe(1);
  });

  it("rejects unauthorised or impersonated decisions before persistence", async () => {
    const store = new InMemoryApprovalDecisionStore();
    await proposeInformationRequest(proposal, store);

    expect(() => submitAnalystDecision({
      command: decision(),
      authorization: { actorId: "viewer-7", roles: ["case_viewer"] },
      store,
    })).toThrow("compliance analyst role");
    expect(() => submitAnalystDecision({
      command: decision(),
      authorization: { actorId: "another-analyst", roles: ["compliance_analyst"] },
      store,
    })).toThrow("does not match");
    expect(store.executionCount()).toBe(0);
  });

  it("records rejection without executing the proposed action", async () => {
    const store = new InMemoryApprovalDecisionStore();
    await proposeInformationRequest(proposal, store);

    await expect(submitAnalystDecision({
      command: decision("rejected"),
      authorization: { actorId: "analyst-42", roles: ["compliance_analyst"] },
      store,
    })).resolves.toBe("rejected");

    expect(store.executionCount()).toBe(0);
  });
});
