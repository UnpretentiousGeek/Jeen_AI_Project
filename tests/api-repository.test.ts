import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

import { PostgresCaseRepository } from "../src/api/repository.js";

const caseId = "32000000-0000-4000-8000-000000000051";
const documentId = "32000000-0000-4000-8000-000000000052";
const deletedDocument = {
  storage_path: "cases/test/evidence.pdf",
  original_filename: "evidence.pdf",
  checksum_sha256: "a".repeat(64),
};

function deletionRepository(options: {
  caseStatus?: string;
  analysisExists?: boolean;
  documentExists?: boolean;
  pinned?: boolean;
  cited?: boolean;
  latestInvocationStatus?: string | null;
  duplicateChecksum?: boolean;
} = {}) {
  const query = vi.fn().mockImplementation(async (sql: string) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
    if (sql.includes("FROM onboarding_cases") && sql.includes("FOR UPDATE")) {
      return { rows: [{ status: options.caseStatus ?? "draft" }] };
    }
    if (sql.includes("FROM analysis_runs")) {
      return { rows: [{ started: options.analysisExists ?? false }] };
    }
    if (sql.includes("SELECT storage_path, original_filename, checksum_sha256")) {
      return { rows: options.documentExists === false ? [] : [deletedDocument] };
    }
    if (sql.includes("FROM analysis_run_documents")) {
      return { rows: [{ pinned: options.pinned ?? false }] };
    }
    if (sql.includes("FROM citations citation")) {
      return { rows: [{ cited: options.cited ?? false }] };
    }
    if (sql.includes("FROM api_langflow_invocations")) {
      return { rows: options.latestInvocationStatus ? [{ status: options.latestInvocationStatus }] : [] };
    }
    if (sql.includes("checksum_sha256") && sql.includes("AS duplicate")) {
      return { rows: [{ duplicate: options.duplicateChecksum ?? false }] };
    }
    if (sql.includes("DELETE FROM case_documents")) return { rows: [deletedDocument] };
    return { rows: [] };
  });
  const release = vi.fn();
  const client = { query, release };
  const pool = { connect: vi.fn().mockResolvedValue(client) };
  return {
    repository: new PostgresCaseRepository(pool as unknown as Pool),
    query,
    release,
  };
}

describe("PostgresCaseRepository", () => {
  it("uses the saved provider fields when showing a pinned rule's applicability", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{
      case_snapshot: {
        provider: {
          legal_name: "Example Payments Ltd",
          regulated_roles: ["payment_institution"],
          service_jurisdictions: ["GB"],
          profile_updated_at: "2026-09-25T01:07:51Z",
        },
        applicant: { jurisdiction: "GB", business_type: "marketplace", product: "merchant_payouts" },
      },
      id: "rule-1", code: "GB-01", statement: "Customer due diligence",
      rule_kind: "operator_cdd", policy_chunk_id: "chunk-1", policy_version_id: "version-1",
      section_locator: "Regulation 28", source_excerpt: "A relevant person must apply customer due diligence measures",
      source_path: "https://www.legislation.gov.uk/uksi/2017/692/regulation/28",
      jurisdictions: ["*"], products: ["*"], business_types: ["*"],
      provider_roles: ["payment_institution"], provider_jurisdictions: ["GB"],
      applicant_payment_activities: [], operating_jurisdictions: [], funds_handling: null,
    }] });
    const repository = new PostgresCaseRepository({ query } as unknown as Pool);

    await expect(repository.listRuleApplicability("run-1")).resolves.toMatchObject([
      { code: "GB-01", applicability: "applies" },
    ]);
  });

  it("deletes unpinned draft evidence and clears its chunks and ingestion history transactionally", async () => {
    const { repository, query, release } = deletionRepository({ latestInvocationStatus: "completed" });

    await expect(repository.deleteCaseDocument(caseId, documentId)).resolves.toEqual(deletedDocument);

    const statements = query.mock.calls.map(([sql]) => String(sql));
    expect(statements[0]).toBe("BEGIN");
    expect(statements.find((sql) => sql.includes("onboarding_cases"))).toContain("FOR UPDATE");
    expect(statements.find((sql) => sql.includes("FROM analysis_runs"))).toContain("SELECT EXISTS");
    expect(statements.find((sql) => sql.includes("FROM case_documents"))).toContain("FOR UPDATE");
    expect(statements.findIndex((sql) => sql.includes("DELETE FROM document_chunks")))
      .toBeLessThan(statements.findIndex((sql) => sql.includes("DELETE FROM case_documents")));
    expect(statements.findIndex((sql) => sql.includes("DELETE FROM case_documents")))
      .toBeLessThan(statements.findIndex((sql) => sql.includes("DELETE FROM api_langflow_invocations")));
    expect(statements.at(-1)).toBe("COMMIT");
    expect(statements.some((sql) => sql.includes("DELETE FROM evidence_submissions"))).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([
    [{ caseStatus: "under_review" }, "evidence_delete_unavailable"],
    [{ analysisExists: true }, "evidence_delete_unavailable"],
    [{ pinned: true }, "document_pinned"],
    [{ latestInvocationStatus: "in_progress" }, "evidence_processing"],
    [{ duplicateChecksum: true }, "document_checksum_shared"],
  ])("rejects evidence deletion when the case or evidence is protected", async (options, error) => {
    const { repository, query } = deletionRepository(options);

    await expect(repository.deleteCaseDocument(caseId, documentId)).rejects.toThrow(error);
    expect(query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(query.mock.calls.some(([sql]) => String(sql).includes("DELETE FROM document_chunks"))).toBe(false);
  });

  it("loads case events across runs in stable timeline order", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{
      id: "task:42", analysis_run_id: "older-run", event_type: "task.failed",
    }] });
    const repository = new PostgresCaseRepository({ query } as unknown as Pool);

    await expect(repository.getCaseTimeline(caseId, 11, 10)).resolves.toMatchObject([
      { id: "task:42", analysis_run_id: "older-run" },
    ]);
    const [sql, parameters] = query.mock.calls[0]!;
    expect(sql).toContain("JOIN analysis_runs r ON r.id = t.analysis_run_id");
    expect(sql).toContain("WHERE r.case_id = $1::uuid");
    expect(sql).toContain("ORDER BY occurred_at DESC, id DESC LIMIT $2 OFFSET $3");
    expect(parameters).toEqual([caseId, 11, 10]);
  });

  it("stores a bounded failure summary with the failed invocation", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const repository = new PostgresCaseRepository({ query } as unknown as Pool);

    await repository.updateInvocationStatus(
      "failed-job", "failed", "A connected Langflow tool returned invalid JSON.",
    );

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("failure_summary"),
      ["failed-job", "failed", "A connected Langflow tool returned invalid JSON."],
    );
  });

  it("builds the review path from the persisted directive and validated task records", async () => {
    const runId = "a7c0b8f7-56ef-4058-b599-ac20e49d6907";
    const coordinatorRunId = "32000000-0000-4000-8000-000000000061";
    const query = vi.fn().mockImplementation((sql: string) => {
      if (sql.includes("FROM analysis_runs r")) return Promise.resolve({ rows: [{
        id: runId, case_id: caseId, coordinator_run_id: coordinatorRunId,
        coordinator_phase: "ready_for_review", status: "succeeded",
      }] });
      if (sql.includes("FROM coordinator_v3_iterations")) return Promise.resolve({ rows: [{
        plan: [{ specialty: "entity", required: true, task_objective: "Compare identity." }],
      }] });
      if (sql.includes("FROM coordinator_v3_task_events")) return Promise.resolve({ rows: [{
        specialty: "entity", task_id: "entity-task", attempt: 1, event_type: "validated",
      }] });
      if (sql.includes("FROM coordinator_v3_contributions")) return Promise.resolve({ rows: [{
        specialty: "entity", task_id: "entity-task", status: "completed",
        payload: { reconciliations: [{}, {}] },
      }] });
      if (sql.includes("FROM coordinator_v3_activity_updates")) return Promise.resolve({ rows: [{
        subject_key: "specialist:entity", iteration_no: 2,
        payload: { task_id: "entity-task", completed_summary: "Matched two identity fields against evidence" },
      }] });
      return Promise.resolve({ rows: [] });
    });
    const repository = new PostgresCaseRepository({ query } as unknown as Pool);

    await expect(repository.getRun(runId)).resolves.toMatchObject({
      review_path: {
        completed_steps: 1, total_steps: 1,
        steps: [{ id: "specialist:entity", status: "completed", counts: { fields_assessed: 2 } }],
      },
      agent_activity: {
        tasks: [
          { id: "specialist:entity", status: "completed", completed_summary: "Matched two identity fields against evidence" },
          { id: "coordinator", status: "completed" },
        ],
      },
    });
    expect(query.mock.calls.find(([sql]) => String(sql).includes("FROM coordinator_v3_iterations"))?.[1])
      .toEqual([coordinatorRunId]);
  });

  it("labels specialist citations with the pinned document they cite", async () => {
    const runId = "a7c0b8f7-56ef-4058-b599-ac20e49d6907";
    const query = vi.fn().mockImplementation((sql: string) => {
      if (sql.includes("FROM analysis_runs r")) return Promise.resolve({ rows: [{ id: runId, case_id: caseId }] });
      if (sql.includes("FROM analysis_run_documents snapshot")) return Promise.resolve({ rows: [{
        source_kind: "case_document", source_id: "doc-1", document_type: "formation_certificate",
        original_filename: "extract.pdf", policy_code: null,
      }] });
      if (sql.includes("FROM coordinator_v3_contributions")) return Promise.resolve({ rows: [{
        specialty: "entity", task_id: "entity-task", status: "completed",
        payload: { citations: [{ id: "case-1", source_kind: "case_document", source_id: "doc-1", chunk_id: "chunk-1" }] },
      }] });
      return Promise.resolve({ rows: [] });
    });
    const repository = new PostgresCaseRepository({ query } as unknown as Pool);

    await expect(repository.getRun(runId)).resolves.toMatchObject({
      agent_activity: {
        contributions: [{ payload: { citations: [{ id: "case-1", source_label: "Certificate of Incorporation" }] } }],
      },
    });
  });

  it("exposes the validated policy matrix as a comparison view", async () => {
    const runId = "a7c0b8f7-56ef-4058-b599-ac20e49d6907";
    const query = vi.fn().mockImplementation((sql: string) => {
      if (sql.includes("FROM analysis_runs r")) return Promise.resolve({ rows: [{ id: runId, case_id: caseId }] });
      if (sql.includes("FROM coordinator_v3_contributions")) return Promise.resolve({ rows: [{
        specialty: "policy", status: "completed", payload: {
          policy_effective_on: "2026-09-23",
          pinned_policy_versions: [{ policy_version_id: "version-1" }],
          requirement_evidence_matrix: [{ requirement_code: "KYB-1.1", status: "supported" }],
          citations: [{ id: "policy-citation-1", source_kind: "policy", chunk_id: "chunk-1" }],
        },
      }] });
      return Promise.resolve({ rows: [] });
    });
    const repository = new PostgresCaseRepository({ query } as unknown as Pool);

    await expect(repository.getRun(runId)).resolves.toMatchObject({
      policy_comparisons: {
        policy_effective_on: "2026-09-23",
        requirements: [{ requirement_code: "KYB-1.1", status: "supported" }],
        citations: [{ id: "policy-citation-1", chunk_id: "chunk-1" }],
      },
    });
  });

  it("returns document ingestion errors and source metadata with case details", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({
        rows: [{
          id: caseId,
          reference: "KYB-TEST",
          active_analysis_run_id: null,
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: "document-1",
          ingestion_status: "failed",
          ingestion_error: "The PDF could not be parsed.",
          source_metadata: { page_count: 0 },
        }],
      })
      .mockResolvedValueOnce({ rows: [] });
    const repository = new PostgresCaseRepository({ query } as unknown as Pool);

    const result = await repository.getCase(caseId);

    expect(result).toMatchObject({
      documents: [{
        ingestion_status: "failed",
        ingestion_error: "The PDF could not be parsed.",
        source_metadata: { page_count: 0 },
      }],
    });
    expect(query.mock.calls[1]?.[0]).toContain("ingestion_error");
    expect(query.mock.calls[1]?.[0]).toContain("source_metadata");
  });

  it("returns the persisted final decision with case details", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: caseId, active_analysis_run_id: null }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        id: "decision-1",
        case_id: caseId,
        decision: "rejected",
        rationale: "Insufficient ownership evidence.",
      }] });
    const repository = new PostgresCaseRepository({ query } as unknown as Pool);

    await expect(repository.getCase(caseId)).resolves.toMatchObject({
      final_decision: { decision: "rejected", rationale: "Insufficient ownership evidence." },
    });
  });
});
