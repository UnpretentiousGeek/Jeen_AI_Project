import { describe, expect, it, vi } from "vitest";

import { type FirecrawlSearchClient } from "../src/web/firecrawl-client.js";
import {
  InMemoryWebSearchStore,
  type ApprovedWebSearchScope,
  executeApprovedWebSearch,
  proposeWebSearch,
  submitWebSearchDecision,
} from "../src/web/web-search.js";

const proposal = {
  reviewRequestId: "review-web-001",
  caseId: "case-001",
  analysisRunId: "run-001",
  correlationId: "correlation-web-001",
  action: {
    id: "action-web-001",
    type: "run_web_search" as const,
    summary: "Search for an official license record.",
    payload: {
      query: "Example Payments Ltd money transmitter license",
      reason: "The applicant supplied no supporting license document.",
      allowed_domains: ["regulator.example.gov"],
      max_results: 5,
      intended_use: "Locate an official public source for the license claim.",
      external_disclosure: ["legal_name", "claimed_license_type"],
    },
    finding_ids: ["finding-license-gap"],
    citation_ids: ["citation-applicant-claim"],
    idempotency_key: "run-001:web-search-license-v1",
    requires_approval: true as const,
  },
};

const decision = {
  schema_version: "1.0" as const,
  request_id: proposal.reviewRequestId,
  case_id: proposal.caseId,
  analysis_run_id: proposal.analysisRunId,
  proposed_action_id: proposal.action.id,
  decision: "approved" as const,
  decided_by: "analyst-42",
  rationale: "The search is narrow, read-only, and necessary to check the claimed license.",
  decided_at: "2026-09-19T18:00:00.000Z",
  idempotency_key: "review-web-001:approved",
  executionId: "webexec-001",
  expiresAt: "2026-09-19T18:10:00.000Z",
};

const scope: ApprovedWebSearchScope = {
  executionId: decision.executionId,
  actionId: proposal.action.id,
  caseId: proposal.caseId,
  analysisRunId: proposal.analysisRunId,
  query: proposal.action.payload.query,
  allowedDomains: proposal.action.payload.allowed_domains,
  maxResults: proposal.action.payload.max_results,
  intendedUse: proposal.action.payload.intended_use,
  externalDisclosure: proposal.action.payload.external_disclosure,
};

function fakeFirecrawl() {
  return {
    search: vi.fn<FirecrawlSearchClient["search"]>(async () => ({
      providerRequestId: "fc-request-001",
      results: [
        {
          url: "https://regulator.example.gov/licenses/example-payments?utm_source=test",
          title: "License record: Example Payments Ltd",
          description: "Example Payments Ltd holds license MT-1234.",
          markdown: "Example Payments Ltd holds license MT-1234.",
          publishedAt: undefined,
        },
        {
          url: "https://regulator.example.gov/licenses/example-payments",
          title: "Duplicate license record",
          description: "Example Payments Ltd holds license MT-1234.",
          markdown: "Example Payments Ltd holds license MT-1234.",
          publishedAt: undefined,
        },
      ],
    })),
  };
}

async function approvedStore() {
  const store = new InMemoryWebSearchStore();
  await proposeWebSearch(proposal, store);
  await submitWebSearchDecision({
    decision,
    authorization: { actorId: "analyst-42", roles: ["compliance_analyst"] },
    store,
  });
  return store;
}

describe("approval-gated web search", () => {
  it("never calls Firecrawl without a matching analyst approval", async () => {
    const store = new InMemoryWebSearchStore();
    const firecrawl = fakeFirecrawl();

    await expect(executeApprovedWebSearch({ scope, store, firecrawl }))
      .rejects.toThrow("no analyst approval");
    expect(firecrawl.search).not.toHaveBeenCalled();
  });

  it("executes the exact approved search once and stores deduplicated evidence", async () => {
    const store = await approvedStore();
    const firecrawl = fakeFirecrawl();
    const now = () => new Date("2026-09-19T18:05:00.000Z");

    const first = await executeApprovedWebSearch({ scope, store, firecrawl, now });
    const replay = await executeApprovedWebSearch({ scope, store, firecrawl, now });

    expect(first.outcome).toBe("executed");
    if (first.outcome === "executed") {
      expect(first.evidence).toHaveLength(1);
      expect(first.evidence[0]).toEqual(expect.objectContaining({
        canonicalUrl: "https://regulator.example.gov/licenses/example-payments",
        searchExecutionId: "webexec-001",
        contentHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      }));
    }
    expect(replay).toEqual({ outcome: "duplicate" });
    expect(firecrawl.search).toHaveBeenCalledOnce();
    expect(store.evidence("webexec-001")).toHaveLength(1);
  });

  it("blocks changed or expired scope before a provider call", async () => {
    const changedStore = await approvedStore();
    const changedFirecrawl = fakeFirecrawl();
    await expect(executeApprovedWebSearch({
      scope: { ...scope, query: `${scope.query} broadened` },
      store: changedStore,
      firecrawl: changedFirecrawl,
      now: () => new Date("2026-09-19T18:05:00.000Z"),
    })).rejects.toThrow("differs from the analyst-approved scope");
    expect(changedFirecrawl.search).not.toHaveBeenCalled();

    const expiredStore = await approvedStore();
    const expiredFirecrawl = fakeFirecrawl();
    await expect(executeApprovedWebSearch({
      scope,
      store: expiredStore,
      firecrawl: expiredFirecrawl,
      now: () => new Date("2026-09-19T18:10:00.000Z"),
    })).rejects.toThrow("approval has expired");
    expect(expiredFirecrawl.search).not.toHaveBeenCalled();
  });

  it("rejects a provider result outside the approved domains", async () => {
    const store = await approvedStore();
    const firecrawl: FirecrawlSearchClient = {
      search: async () => ({
        providerRequestId: "fc-request-bad-domain",
        results: [{
          url: "https://unapproved.example/license",
          title: "Unapproved source",
          description: "Claimed record.",
          markdown: undefined,
          publishedAt: undefined,
        }],
      }),
    };

    await expect(executeApprovedWebSearch({
      scope,
      store,
      firecrawl,
      now: () => new Date("2026-09-19T18:05:00.000Z"),
    })).rejects.toThrow("outside the approved domains");
    expect(store.evidence("webexec-001")).toEqual([]);
  });
});
