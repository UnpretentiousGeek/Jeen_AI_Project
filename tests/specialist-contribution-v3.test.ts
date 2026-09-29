import { describe, expect, it } from "vitest";

import {
  entitySpecialistContributionV3Schema,
  ownershipSpecialistContributionV3Schema,
} from "../src/contracts/specialist-contribution-v3.js";

const validation = {
  validator: "validator-v3.1.0",
  outcome: "accepted" as const,
  checks: ["citation_pin"],
  validated_at: "2026-09-20T12:00:00Z",
};

describe("V3 Specialist Contribution contracts", () => {
  it("accepts a six-row entity contribution without findings or decisions", () => {
    const rows = [
      ["legal_name", null, null],
      ["jurisdiction", null, null],
      ["identifier", null, "registration_number"],
      ["address", "registered", null],
      ["address", "operating", null],
      ["address", "mailing", null],
    ].map(([field, address_type, identifier_type]) => ({
      field,
      address_type,
      identifier_type,
      declared_original: null,
      declared_normalized: null,
      documentary_values: [],
      outcome: "missing",
      rationale_summary: "A value is absent.",
    }));
    expect(entitySpecialistContributionV3Schema.parse({
      contract_version: "3.1.0",
      contribution_kind: "specialist_contribution",
      contribution_id: "entity-task-1",
      analysis_run_id: "a1000000-0000-4000-8000-000000000021",
      task_id: "task-1",
      context_id: "context-1",
      specialist: { name: "kyb-entity-agent", version: "3.1.0" },
      specialty: "entity",
      status: "partial",
      reconciliations: rows,
      citations: [],
      deterministic_validation: validation,
    })).not.toHaveProperty("findings");
  });

  it("rejects ownership references to an unpinned citation", () => {
    const result = ownershipSpecialistContributionV3Schema.safeParse({
      contract_version: "3.1.0",
      contribution_kind: "specialist_contribution",
      contribution_id: "ownership-task-2",
      analysis_run_id: "a1000000-0000-4000-8000-000000000025",
      task_id: "task-2",
      context_id: "context-2",
      specialist: { name: "kyb-ownership-agent", version: "3.1.0" },
      specialty: "ownership",
      status: "completed",
      relationships: [{ owner: "A", owner_type: "person", owned: "B", percentage: 100, citation_id: "fake" }],
      chains: [],
      direct_total_percent: 100,
      unexplained_remainder_percent: 0,
      anomalies: [],
      citations: [],
      deterministic_validation: validation,
    });
    expect(result.success).toBe(false);
  });

  describe("3.2.0 advisory observations", () => {
    const pinned = {
      id: "case-edge-1",
      source_kind: "case_document" as const,
      source_id: "doc-1",
      chunk_id: "chunk-1",
      locator: "Page 1",
      excerpt: "Holder A: 80%",
    };
    const ownership = (observations: unknown[]) => ({
      contract_version: "3.2.0",
      contribution_kind: "specialist_contribution",
      contribution_id: "ownership-task-3",
      analysis_run_id: "a1000000-0000-4000-8000-000000000026",
      task_id: "task-3",
      context_id: "context-3",
      specialist: { name: "kyb-ownership-agent", version: "3.2.0" },
      specialty: "ownership",
      status: "partial",
      relationships: [{ owner: "A", owner_type: "person", owned: "B", percentage: 80, citation_id: "case-edge-1" }],
      chains: [],
      direct_total_percent: 80,
      unexplained_remainder_percent: 20,
      anomalies: [],
      observations,
      citations: [pinned],
      deterministic_validation: { ...validation, dropped_citation_ids: [], dropped_observation_ids: ["obs-9"] },
    });
    const note = {
      id: "obs-1",
      kind: "unexplained_remainder",
      about: "run",
      statement: "The register names holders for 80%; the remaining 20% is not attributed.",
      confidence: "high",
      citations: ["case-edge-1"],
    };

    it("accepts a pinned observation", () => {
      expect(ownershipSpecialistContributionV3Schema.safeParse(ownership([note])).success).toBe(true);
    });

    it("rejects observations citing an unpinned source", () => {
      expect(ownershipSpecialistContributionV3Schema.safeParse(
        ownership([{ ...note, citations: ["case-other"] }]),
      ).success).toBe(false);
    });

    it("rejects kinds from the other specialty and verdict fields", () => {
      expect(ownershipSpecialistContributionV3Schema.safeParse(
        ownership([{ ...note, kind: "near_miss_equivalence" }]),
      ).success).toBe(false);
      expect(ownershipSpecialistContributionV3Schema.safeParse(
        ownership([{ ...note, verdict: "approve" }]),
      ).success).toBe(false);
    });

    it("caps observations per row and in total", () => {
      expect(ownershipSpecialistContributionV3Schema.safeParse(ownership([note, note, note])).success).toBe(false);
      const many = Array.from({ length: 9 }, (_, index) => ({ ...note, about: `chain:${index}` }));
      expect(ownershipSpecialistContributionV3Schema.safeParse(ownership(many)).success).toBe(false);
    });
  });
});
