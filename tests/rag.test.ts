import { describe, expect, it } from "vitest";

import { parseSpecialistArtifact, type SpecialistArtifact } from "../src/contracts/specialist-artifact.js";
import { consolidateSpecialistArtifacts } from "../src/rag/consolidator.js";
import {
  PostgresRunEvidenceRetriever,
  passageToCitation,
  type RetrievalDatabase,
} from "../src/rag/retriever.js";

function artifact(overrides: Partial<SpecialistArtifact> & Pick<SpecialistArtifact, "specialty" | "artifact_id" | "task_id">): SpecialistArtifact {
  const { artifact_id, specialty, task_id, ...rest } = overrides;
  return parseSpecialistArtifact({
    schema_version: "1.0",
    artifact_id,
    analysis_run_id: "run-001",
    task_id,
    context_id: `context-${task_id}`,
    agent: { name: `jeen-${specialty}-agent`, version: "1.0.0" },
    specialty,
    status: "completed",
    confidence: 1,
    observations: [],
    evidence_gaps: [],
    conflicts: [],
    citations: [],
    error: null,
    created_at: "2026-09-19T01:00:00.000Z",
    ...rest,
  });
}

const caseCitation = {
  id: "case-1",
  source_kind: "case_document" as const,
  source_id: "document-001",
  chunk_id: "case-chunk-001",
  locator: "Registration",
  excerpt: "Acme Analytics LLC is registered at 100 Market Street.",
};
const policyCitation = {
  id: "policy-1",
  source_kind: "policy" as const,
  source_id: "policy-version-001",
  chunk_id: "policy-chunk-001",
  locator: "KYB-1.1",
  excerpt: "Verify legal name and registered address.",
};

describe("run-scoped evidence retrieval", () => {
  it("queries case and policy functions with the same run scope", async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const database: RetrievalDatabase = {
      async query(text, values) {
        calls.push({ text, values });
        return {
          rows: [{
            source_kind: text.includes("case") ? "case_document" : "policy",
            source_id: text.includes("case") ? "document-001" : "policy-version-001",
            chunk_id: text.includes("case") ? "case-chunk-001" : "policy-chunk-001",
            locator: "KYB-1.1",
            excerpt: "Stable cited passage.",
            retrieval_score: "0.75",
            retrieval_mode: "hybrid",
          }],
        };
      },
    };
    const retriever = new PostgresRunEvidenceRetriever(database);

    const result = await retriever.retrieve({
      analysisRunId: "00000000-0000-0000-0000-000000000001",
      query: "registered address",
      limit: 3,
      queryEmbedding: [0.1, 0.2],
    });

    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.values[0] === "00000000-0000-0000-0000-000000000001")).toBe(true);
    expect(calls.every((call) => call.values[2] === "[0.1,0.2]")).toBe(true);
    expect(result.caseEvidence[0]?.source_kind).toBe("case_document");
    expect(result.policyEvidence[0]?.source_kind).toBe("policy");
  });

  it("rejects malformed query embeddings before database access", async () => {
    const database: RetrievalDatabase = {
      async query() {
        throw new Error("must not be called");
      },
    };

    await expect(new PostgresRunEvidenceRetriever(database).retrieve({
      analysisRunId: "run-001",
      query: "ownership",
      queryEmbedding: [Number.NaN],
    })).rejects.toThrow("finite numbers");
  });

  it("turns a retrieved passage into a visible stable citation", () => {
    expect(passageToCitation({
      source_kind: "policy",
      source_id: "policy-version-001",
      chunk_id: "policy-chunk-001",
      locator: "KYB-1.1",
      excerpt: "Verify the registered address.",
      retrieval_score: 0.8,
      retrieval_mode: "lexical",
    })).toMatchObject({
      id: "rag-policy-policy-chunk-001",
      source_kind: "policy",
      locator: "KYB-1.1",
    });
  });
});

describe("artifact-to-finding consolidation", () => {
  it("deduplicates citations and records every contributing artifact", () => {
    const entity = artifact({
      specialty: "entity",
      artifact_id: "artifact-entity",
      task_id: "task-entity",
      observations: [{
        id: "entity-observation",
        requirement_code: "KYB-1.1",
        summary: "Entity identity matches registration evidence.",
        rationale_summary: "Name and address match.",
        confidence: 0.99,
        citation_ids: ["case-1", "policy-1"],
      }],
      citations: [caseCitation, policyCitation],
    });
    const policy = artifact({
      specialty: "policy",
      artifact_id: "artifact-policy",
      task_id: "task-policy",
      observations: [{
        id: "policy-observation",
        requirement_code: "KYB-1.1",
        summary: "Verify legal name and registered address.",
        rationale_summary: "The policy selectors match.",
        confidence: 1,
        citation_ids: ["case-1", "policy-1"],
      }],
      citations: [caseCitation, policyCitation],
    });

    const snapshot = consolidateSpecialistArtifacts({
      caseId: "case-001",
      analysisRunId: "run-001",
      artifacts: [entity, policy],
    });

    expect(snapshot.status).toBe("ready_for_review");
    expect(snapshot.citations).toHaveLength(2);
    expect(snapshot.findings).toHaveLength(1);
    expect(snapshot.findings[0]?.outcome).toBe("met");
    expect(snapshot.findings[0]?.agent_artifact_ids.sort()).toEqual([
      "artifact-entity",
      "artifact-policy",
    ]);
  });

  it("keeps a cited conflict visible and marks the result for attention", () => {
    const entity = artifact({
      specialty: "entity",
      artifact_id: "artifact-entity-conflict",
      task_id: "task-entity-conflict",
      observations: [{
        id: "entity-observation-conflict",
        requirement_code: "KYB-1.1",
        summary: "Registered addresses conflict.",
        rationale_summary: "The two supplied addresses differ.",
        confidence: 1,
        citation_ids: ["case-1", "policy-1"],
      }],
      conflicts: [{
        id: "address-conflict",
        subject: "Registered address",
        description: "Application and incorporation addresses differ.",
        citation_ids: ["case-1", "policy-1"],
      }],
      citations: [caseCitation, policyCitation],
    });

    const snapshot = consolidateSpecialistArtifacts({
      caseId: "case-001",
      analysisRunId: "run-001",
      artifacts: [entity],
    });

    expect(snapshot.status).toBe("attention_required");
    expect(snapshot.findings[0]?.outcome).toBe("uncertain");
    expect(snapshot.conflicts[0]?.agent_artifact_ids).toEqual(["artifact-entity-conflict"]);
  });
});
