import { describe, expect, it } from "vitest";

import { analysisOutputSchema, parseAnalysisOutput } from "../src/contracts/analysis-output.js";

const output = {
  schema_version: "1.0",
  case_id: "case-001",
  analysis_run_id: "run-001",
  status: "ready_for_review",
  findings: [
    {
      id: "finding-001",
      requirement_code: "KYB-1.2",
      outcome: "met",
      summary: "Declared ownership totals 100%.",
      rationale: "The two declared interests account for all ownership.",
      confidence: 0.98,
      citation_ids: ["citation-case"],
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
  ],
  human_input_request: null,
  proposed_actions: [],
} as const;

describe("analysisOutputSchema v1.0 compatibility", () => {
  it("continues to accept the current Langflow output shape", () => {
    expect(parseAnalysisOutput(output)).toEqual(output);
  });

  it("does not silently accept a 1.1 snapshot", () => {
    expect(analysisOutputSchema.safeParse({ ...output, schema_version: "1.1" }).success).toBe(false);
  });
});
