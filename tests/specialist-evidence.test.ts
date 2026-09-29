import { describe, expect, it } from "vitest";

import { specialistEvidence, type SpecialistEvidence } from "../lib/specialist-evidence.ts";
import { runSourceLabels, withCitationSourceLabels } from "../src/source-labels.ts";

function citation(id: string, sourceId: string, label?: string) {
  return {
    id, source_kind: "case_document", source_id: sourceId, chunk_id: `chunk-${id}`,
    locator: "Document chunk 1", excerpt: "…", ...(label ? { source_label: label } : {}),
  };
}

function only(specialty: "entity" | "ownership", payload: Record<string, unknown>): SpecialistEvidence {
  const [evidence] = specialistEvidence({
    agent_activity: {
      tasks: [{ role: "specialist", status: "completed", task_id: "task-1", specialty }],
      contributions: [{ task_id: "task-1", specialty, status: "completed", payload }],
    },
  });
  if (!evidence) throw new Error("Expected one specialist result");
  return evidence;
}

describe("run source labels", () => {
  const labels = runSourceLabels([
    { source_kind: "case_document", source_id: "doc-cert", document_type: "formation_certificate", original_filename: "cert.pdf", policy_code: null },
    { source_kind: "case_document", source_id: "doc-reg-a", document_type: "ownership_register", original_filename: "register-2025.pdf", policy_code: null },
    { source_kind: "case_document", source_id: "doc-reg-b", document_type: "ownership_register", original_filename: "register-2026.pdf", policy_code: null },
    { source_kind: "case_document", source_id: "doc-other", document_type: "supporting_document", original_filename: "declaration.pdf", policy_code: null },
    { source_kind: "policy", source_id: "version-1", document_type: null, original_filename: null, policy_code: "KYB-POL" },
  ]);

  it("names documents by type and falls back to filenames for shared or generic types", () => {
    expect(labels.get("case_document:doc-cert")).toBe("Certificate of Incorporation");
    expect(labels.get("case_document:doc-reg-a")).toBe("register-2025.pdf");
    expect(labels.get("case_document:doc-other")).toBe("declaration.pdf");
  });

  it("stamps labels onto contribution citations, qualifying policy passages by section", () => {
    const labeled = withCitationSourceLabels({
      specialty: "policy",
      payload: { citations: [
        citation("c1", "doc-cert"),
        { id: "p1", source_kind: "policy", source_id: "version-1", locator: "KYB-1.1" },
        { id: "c9", source_kind: "case_document", source_id: "unpinned" },
      ] },
    }, labels);
    expect((labeled.payload as { citations: Array<{ source_label: string }> }).citations.map((item) => item.source_label))
      .toEqual(["Certificate of Incorporation", "KYB-POL · KYB-1.1", "Case Document"]);
  });
});

describe("specialist evidence view-model", () => {
  it("groups repeated documentary values into one line with one source per document", () => {
    const entity = only("entity", {
      citations: [
        citation("c1", "doc-cert", "Certificate of Incorporation"),
        citation("c2", "doc-cert", "Certificate of Incorporation"),
        citation("c3", "doc-reg-a", "Shareholder Register"),
      ],
      reconciliations: [{
        field: "legal_name",
        outcome: "match",
        declared_original: "Northbridge Market Ltd",
        rationale_summary: "Declared and documentary values match after harmless normalization.",
        documentary_values: [
          { original: "Northbridge Market Ltd", normalized: "NORTHBRIDGE MARKET LTD", citation_id: "c1" },
          { original: "Northbridge Market Ltd", normalized: "NORTHBRIDGE MARKET LTD", citation_id: "c2" },
          { original: "Northbridge Market Ltd", normalized: "NORTHBRIDGE MARKET LTD", citation_id: "c3" },
        ],
      }],
    });

    expect(entity.summary).toBe("1 of 1 Field Consistent · Not Independently Verified");
    expect(entity.exceptions).toEqual([]);
    expect(entity.confirmed).toMatchObject([{
      declared: null,
      detail: null,
      observed: [{ value: "Northbridge Market Ltd" }],
    }]);
    expect(entity.confirmed[0]?.observed[0]?.sources.map((source) => source.label))
      .toEqual(["Certificate of Incorporation", "Shareholder Register"]);
  });

  it("keeps the declared value and a reason note for conflicts", () => {
    const entity = only("entity", {
      citations: [citation("c1", "doc-cert")],
      reconciliations: [
        {
          field: "address",
          address_type: "registered",
          outcome: "conflict",
          declared_original: "42 Harbor Lane",
          declared_normalized: "42 HARBOR LANE",
          documentary_values: [{ original: "7 Quay Street", normalized: "7 QUAY STREET", citation_id: "c1" }],
        },
        {
          field: "jurisdiction",
          outcome: "match",
          declared_original: "GB",
          documentary_values: [{ original: "England and Wales (GB)", normalized: "GB", citation_id: "c1" }],
        },
      ],
    });

    expect(entity.summary).toBe("1 of 2 Fields Consistent · 1 Conflict · Not Independently Verified");
    expect(entity.exceptions).toMatchObject([{
      label: "Registered Address",
      declared: "42 Harbor Lane",
      detail: "Documents Agree with Each Other but Differ from the Declared Value.",
    }]);
    expect(entity.exceptions[0]?.observed[0]?.sources[0]?.label).toBe("Case Document");
    // A match whose document wording differs from the declaration still shows both.
    expect(entity.confirmed[0]?.declared).toBe("GB");
  });

  it("prefers the validator's reason code over re-deriving it", () => {
    const entity = only("entity", {
      citations: [citation("c1", "doc-cert"), citation("c2", "doc-reg-a")],
      reconciliations: [{
        field: "legal_name",
        outcome: "conflict",
        reason_code: "missing_documentary",
        declared_original: "Northbridge Market Ltd",
        documentary_values: [
          { original: "Northbridge Market Ltd", normalized: "NORTHBRIDGE MARKET LTD", citation_id: "c1" },
          { original: "Northbridge Markets Ltd", normalized: "NORTHBRIDGE MARKETS LTD", citation_id: "c2" },
        ],
      }],
    });

    expect(entity.exceptions[0]?.detail).toBe("No Pinned Document States This Value.");
    expect(entity.exceptions[0]?.observed.map((item) => item.value)).toEqual(["Northbridge Market Ltd", "Northbridge Markets Ltd"]);
  });

  it("derives documentary conflicts when no reason code was stamped", () => {
    const entity = only("entity", {
      citations: [],
      reconciliations: [{
        field: "legal_name",
        outcome: "conflict",
        declared_original: "Northbridge Market Ltd",
        documentary_values: [
          { original: "Northbridge Market Ltd", normalized: "NORTHBRIDGE MARKET LTD" },
          { original: "Northbridge Markets Ltd", normalized: "NORTHBRIDGE MARKETS LTD" },
        ],
      }],
    });

    expect(entity.exceptions[0]?.detail).toBe("Documents State Different Values.");
  });

  it("orders ownership evidence gaps before relationships", () => {
    const ownership = only("ownership", {
      citations: [citation("c1", "doc-reg-a", "Shareholder Register")],
      relationships: [{ owner: "Jane Doe", owned: "Northbridge Market Ltd", percentage: 60, citation_id: "c1" }],
      anomalies: [{ type: "missing_register", details: "No current register.", citation_ids: [] }],
    });

    expect(ownership.summary).toBe("1 Relationship · 1 Evidence Gap");
    expect(ownership.exceptions.map((row) => row.label)).toEqual(["Missing Register"]);
    expect(ownership.confirmed[0]?.observed[0]).toMatchObject({ value: "60% of Northbridge Market Ltd" });
  });

  it("shows the analyst's answer beside the exception it resolved", () => {
    const answered = (questionId: string, answer: string, extra: Record<string, string> = {}) => ({
      question_id: questionId, specialty: questionId.split(":")[0]!, field: null, subject: null,
      answer, answered_by: "analyst", answered_at: "2026-09-26T08:30:00Z", ...extra,
    });
    const [entity, ownership] = specialistEvidence({
      analyst_answers: [
        answered("entity:address:registered", "41 Grey Street"),
        answered("entity:legal_name:", "Unused for a matched field"),
        answered("ownership:abc", "30%", { field: "inconsistent_percentage", subject: "Marco -> Holding B.V." }),
      ],
      agent_activity: {
        tasks: [
          { role: "specialist", status: "completed", task_id: "task-e", specialty: "entity" },
          { role: "specialist", status: "completed", task_id: "task-o", specialty: "ownership" },
        ],
        contributions: [
          { task_id: "task-e", specialty: "entity", status: "partial", payload: { citations: [], reconciliations: [
            { field: "legal_name", address_type: null, outcome: "match", declared_original: "Acme Ltd",
              declared_normalized: "ACME LTD", documentary_values: [] },
            { field: "address", address_type: "registered", outcome: "conflict", declared_original: "Quayside",
              declared_normalized: "QUAYSIDE", documentary_values: [] },
          ] } },
          { task_id: "task-o", specialty: "ownership", status: "partial", payload: { citations: [], anomalies: [
            { type: "inconsistent_percentage", subject: "Marco -> Holding B.V.", details: "Inconsistent." },
            { type: "incomplete_chain", subject: "Holding B.V.", details: "No person path." },
          ] } },
        ],
      },
    });
    expect(entity!.exceptions.map((row) => row.resolution?.answer ?? null)).toEqual(["41 Grey Street"]);
    expect(entity!.confirmed.every((row) => row.resolution === null)).toBe(true);
    expect(ownership!.exceptions.map((row) => row.resolution?.answer ?? null)).toEqual(["30%", null]);
  });

  it("calls agreeing applicant copies consistent until a registry verifies them", () => {
    const run = (status: string | null) => specialistEvidence({
      identity_verification: status ? { status } : null,
      agent_activity: {
        tasks: [{ role: "specialist", status: "completed", task_id: "task-1", specialty: "entity" }],
        contributions: [{ task_id: "task-1", specialty: "entity", status: "completed", payload: { citations: [],
          reconciliations: [{ field: "legal_name", address_type: null, outcome: "match",
            declared_original: "Acme Ltd", declared_normalized: "ACME LTD", documentary_values: [] }] } }],
      },
    })[0]!;
    expect(run("unverified").confirmed[0]!.badge).toBe("Consistent");
    expect(run("verified").confirmed[0]!.badge).toBe("Match");
    expect(run("verified").summary).toBe("1 of 1 Field Match · Registry Verified");
  });

  describe("advisory agent notes", () => {
    const note = (about: string, citations: string[], extra: Record<string, unknown> = {}) => ({
      kind: "near_miss_equivalence", about, statement: "\"Ste 4\" and \"Suite 4\" name the same unit.",
      confidence: "medium", citations, ...extra,
    });

    it("places entity notes under the row they are about and hides unpinned ones", () => {
      const entity = only("entity", {
        citations: [citation("c1", "doc-cert", "Certificate of Incorporation")],
        reconciliations: [
          { field: "address", address_type: "registered", outcome: "conflict", declared_original: "4 Quay, Ste 4",
            documentary_values: [{ original: "4 Quay, Suite 4", normalized: "4 QUAY SUITE 4", citation_id: "c1" }] },
          { field: "legal_name", outcome: "match", declared_original: "Acme Ltd",
            documentary_values: [{ original: "Acme Ltd", normalized: "ACME LTD", citation_id: "c1" }] },
        ],
        observations: [
          note("address:registered", ["c1"], { id: "obs-1" }),
          note("legal_name", ["not-pinned"]),
          note("run", ["c1"], { kind: "internal_consistency", confidence: "certain" }),
        ],
      });

      expect(entity.exceptions[0]?.notes).toMatchObject([{
        key: "obs-1", kind: "Near Miss Equivalence", confidence: "medium",
        sources: [{ label: "Certificate of Incorporation" }],
      }]);
      expect(entity.confirmed[0]?.notes).toEqual([]);
      expect(entity.notes).toEqual([]);
      // Notes never change the validated outcome.
      expect(entity.exceptions[0]?.status).toBe("conflict");
    });

    it("keeps ownership notes on anomalies, relationships, and chains, and run notes on the card", () => {
      const ownership = only("ownership", {
        citations: [citation("c1", "doc-reg", "Shareholder Register")],
        relationships: [{ owner: "Jane Doe", owned: "Acme Ltd", percentage: 80, citation_id: "c1" }],
        chains: [{ ultimate_owner: "Jane Doe", path: ["Jane Doe", "Acme Ltd"], calculated_percent: 80, citation_ids: ["c1"] }],
        anomalies: [{ type: "incomplete_total", subject: "Acme Ltd", details: "80% attributed.", citation_ids: ["c1"] }],
        observations: [
          note("anomaly:incomplete_total", ["c1"], { kind: "unexplained_remainder" }),
          note("relationship:c1", ["c1"], { kind: "control_beyond_shareholding" }),
          note("chain:0", ["c1"], { kind: "risk_pattern" }),
          note("run", ["c1"], { kind: "person_name_match" }),
          note("chain:7", ["c1"], { kind: "incomplete_chain" }),
        ],
      });

      expect(ownership.exceptions[0]?.notes.map((item) => item.kind)).toEqual(["Unexplained Remainder"]);
      expect(ownership.confirmed.map((row) => row.notes.map((item) => item.kind)))
        .toEqual([["Control Beyond Shareholding"], ["Risk Pattern"]]);
      expect(ownership.notes.map((item) => item.kind)).toEqual(["Person Name Match", "Incomplete Chain"]);
    });
  });
});
