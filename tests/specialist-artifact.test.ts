import { describe, expect, it } from "vitest";

import { parseSpecialistArtifact, specialistArtifactSchema } from "../src/contracts/specialist-artifact.js";

const validArtifact = {
  schema_version: "1.0",
  artifact_id: "artifact-ownership-001",
  analysis_run_id: "run-001",
  task_id: "task-ownership-001",
  context_id: "context-run-001",
  agent: { name: "ownership-agent", version: "1.0.0" },
  specialty: "ownership",
  status: "completed",
  confidence: 0.98,
  observations: [
    {
      id: "observation-001",
      requirement_code: "KYB-1.2",
      summary: "Declared ownership totals 100%.",
      rationale_summary: "The two named interests account for the full ownership declaration.",
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
  error: null,
  created_at: "2026-09-18T20:10:00Z",
} as const;

describe("specialistArtifactSchema", () => {
  it("accepts a versioned, cited specialist artifact", () => {
    expect(parseSpecialistArtifact(validArtifact)).toEqual(validArtifact);
  });

  it("rejects an unknown citation reference", () => {
    const result = specialistArtifactSchema.safeParse({
      ...validArtifact,
      observations: [{ ...validArtifact.observations[0], citation_ids: ["missing-citation"] }],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.message.includes("unknown citation"))).toBe(true);
  });

  it("requires structured error details for a failed artifact", () => {
    const result = specialistArtifactSchema.safeParse({ ...validArtifact, status: "failed" });

    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.path[0] === "error")).toBe(true);
  });

  it("keeps external-web citations inside public-research artifacts", () => {
    const result = specialistArtifactSchema.safeParse({
      ...validArtifact,
      citations: [
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
          agent_task_id: validArtifact.task_id,
          agent_artifact_id: validArtifact.artifact_id,
        },
      ],
      observations: [{ ...validArtifact.observations[0], citation_ids: ["citation-web"] }],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.message.includes("public-research"))).toBe(true);
  });

  it("accepts external-web evidence with matching public-research provenance", () => {
    const result = specialistArtifactSchema.safeParse({
      ...validArtifact,
      artifact_id: "artifact-public-001",
      task_id: "task-public-001",
      agent: { name: "public-research-agent", version: "1.0.0" },
      specialty: "public_research",
      citations: [
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
          agent_task_id: "task-public-001",
          agent_artifact_id: "artifact-public-001",
        },
      ],
      observations: [{ ...validArtifact.observations[0], citation_ids: ["citation-web"] }],
    });

    expect(result.success).toBe(true);
  });
});
