import { describe, expect, it } from "vitest";

import { analysisSnapshotSchema, parseAnalysisSnapshot } from "../src/contracts/analysis-snapshot.js";

const validSnapshot = {
  schema_version: "1.1",
  case_id: "case-001",
  analysis_run_id: "run-001",
  status: "ready_for_review",
  agent_contributions: [
    {
      task_id: "task-ownership-001",
      context_id: "context-run-001",
      agent: { name: "ownership-agent", version: "1.0.0" },
      status: "completed",
      artifact_ids: ["artifact-ownership-001"],
    },
  ],
  findings: [
    {
      id: "finding-001",
      requirement_code: "KYB-1.2",
      outcome: "met",
      summary: "Declared ownership totals 100%.",
      rationale: {
        requirement: "The ownership chain must account for 100%.",
        evidence_assessment: "The two declared interests total 100%.",
        uncertainty: "No ownership remainder is present in the supplied declaration.",
        conclusion: "The supplied ownership declaration meets this requirement.",
        recommendation: "Present the finding for analyst review.",
      },
      confidence: 0.98,
      citation_ids: ["citation-case", "citation-policy"],
      agent_artifact_ids: ["artifact-ownership-001"],
    },
  ],
  evidence_gaps: [],
  conflicts: [],
  citations: [
    {
      id: "citation-case",
      source_kind: "case_document",
      source_id: "document-001",
      chunk_id: "chunk-001",
      locator: "Ownership",
      excerpt: "Maya Chen owns 60% and Daniel Ortiz owns 40%.",
    },
    {
      id: "citation-policy",
      source_kind: "policy",
      source_id: "policy-version-001",
      chunk_id: "policy-chunk-001",
      locator: "KYB-1.2",
      excerpt: "The ownership chain must account for 100%.",
    },
  ],
  human_input_request: null,
  proposed_actions: [],
} as const;

describe("analysisSnapshotSchema", () => {
  it("accepts a cited snapshot with specialist provenance", () => {
    expect(parseAnalysisSnapshot(validSnapshot)).toEqual(validSnapshot);
  });

  it("rejects unknown citation references", () => {
    const result = analysisSnapshotSchema.safeParse({
      ...validSnapshot,
      findings: [{ ...validSnapshot.findings[0], citation_ids: ["missing-citation"] }],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.message.includes("unknown citation"))).toBe(true);
  });

  it("rejects unknown specialist artifact references", () => {
    const result = analysisSnapshotSchema.safeParse({
      ...validSnapshot,
      findings: [{ ...validSnapshot.findings[0], agent_artifact_ids: ["missing-artifact"] }],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.message.includes("unknown specialist artifact"))).toBe(true);
  });

  it("requires a targeted request while awaiting information", () => {
    const result = analysisSnapshotSchema.safeParse({
      ...validSnapshot,
      status: "awaiting_information",
      human_input_request: null,
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.path[0] === "human_input_request")).toBe(true);
  });

  it("requires approval state for proposed actions", () => {
    const result = analysisSnapshotSchema.safeParse({
      ...validSnapshot,
      proposed_actions: [
        {
          id: "action-001",
          type: "mark_ready_for_review",
          summary: "Advance the case for analyst review.",
          finding_ids: ["finding-001"],
          citation_ids: ["citation-case", "citation-policy"],
          payload: {},
          idempotency_key: "run-001:mark-ready",
          requires_approval: true,
        },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.path[0] === "proposed_actions")).toBe(true);
  });

  it("accepts a narrowly scoped web-search proposal without executing it", () => {
    const result = analysisSnapshotSchema.safeParse({
      ...validSnapshot,
      status: "awaiting_approval",
      proposed_actions: [
        {
          id: "action-web-001",
          type: "run_web_search",
          summary: "Search the regulator site for the claimed license.",
          finding_ids: ["finding-001"],
          citation_ids: ["citation-case"],
          payload: {
            query: "Acme Analytics LLC money transmitter license",
            reason: "The claimed license is not supported by supplied evidence.",
            allowed_domains: ["regulator.example.gov"],
            max_results: 5,
            intended_use: "Locate an authoritative public license record.",
            external_disclosure: ["legal_name", "claimed_license_type"],
          },
          idempotency_key: "run-001:web-search-license-v1",
          requires_approval: true,
        },
      ],
    });

    expect(result.success).toBe(true);
  });

  it("accepts a typed information-request proposal", () => {
    const result = analysisSnapshotSchema.safeParse({
      ...validSnapshot,
      status: "awaiting_approval",
      proposed_actions: [{
        id: "action-information-001",
        type: "record_information_request",
        summary: "Request the missing beneficial-owner declaration.",
        finding_ids: ["finding-001"],
        citation_ids: ["citation-case", "citation-policy"],
        payload: {
          recipient: "applicant",
          subject: "Complete ownership information required",
          requested_items: ["Identify the owner of the remaining 18% interest."],
          delivery_channel: "case_portal",
        },
        idempotency_key: "run-001:ownership-information-request",
        requires_approval: true,
      }],
    });

    expect(result.success).toBe(true);
  });

  it("rejects an information request without requested items", () => {
    const result = analysisSnapshotSchema.safeParse({
      ...validSnapshot,
      status: "awaiting_approval",
      proposed_actions: [{
        id: "action-information-001",
        type: "record_information_request",
        summary: "Request missing information.",
        finding_ids: ["finding-001"],
        citation_ids: ["citation-policy"],
        payload: {
          recipient: "applicant",
          subject: "More information required",
          requested_items: [],
          delivery_channel: "case_portal",
        },
        idempotency_key: "run-001:invalid-information-request",
        requires_approval: true,
      }],
    });

    expect(result.success).toBe(false);
  });

  it("rejects duplicate agent task identifiers", () => {
    const result = analysisSnapshotSchema.safeParse({
      ...validSnapshot,
      agent_contributions: [
        validSnapshot.agent_contributions[0],
        { ...validSnapshot.agent_contributions[0], artifact_ids: ["artifact-ownership-002"] },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.message.includes("task ids must be unique"))).toBe(true);
  });

  it("rejects external-web citations without known A2A provenance", () => {
    const result = analysisSnapshotSchema.safeParse({
      ...validSnapshot,
      citations: [
        ...validSnapshot.citations,
        {
          id: "citation-web",
          source_kind: "external_web",
          url: "https://regulator.example/license",
          canonical_url: "https://regulator.example/license",
          title: "License record",
          publisher: "Example Regulator",
          published_at: null,
          retrieved_at: "2026-09-18T20:20:00Z",
          excerpt: "Acme holds license MT-1234.",
          content_hash: `sha256:${"a".repeat(64)}`,
          retrieval_method: "firecrawl_search",
          search_execution_id: "webexec-001",
          agent_task_id: "missing-task",
          agent_artifact_id: "missing-artifact",
        },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.message.includes("external-web citations"))).toBe(true);
  });
});
