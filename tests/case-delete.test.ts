import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

import { createApiHandler } from "../src/api/http.js";
import { PostgresCaseRepository, type CaseRepository } from "../src/api/repository.js";
import { CaseApiService, type ApiError } from "../src/api/service.js";

const caseId = "32000000-0000-4000-8000-000000000051";
const runId = "a7c0b8f7-56ef-4058-b599-ac20e49d6907";
const coordinatorRunId = "a7c0b8f7-56ef-4058-b599-ac20e49d6908";

function createRepository(options: {
  archivedAt?: string | null;
  hasActiveAnalysis?: boolean;
  hasActiveCoordinator?: boolean;
} = {}) {
  const query = vi.fn().mockImplementation(async (sql: string) => {
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
    if (sql.includes("FROM onboarding_cases c") && sql.includes("FOR UPDATE OF c")) {
      return { rows: [{
        id: caseId,
        applicant_id: "applicant-1",
        application_id: "application-1",
        archived_at: options.archivedAt === undefined ? "2026-09-24T12:00:00Z" : options.archivedAt,
        has_active_analysis: options.hasActiveAnalysis ?? false,
        has_active_coordinator: options.hasActiveCoordinator ?? false,
      }] };
    }
    if (sql.includes("SELECT DISTINCT storage_path")) return { rows: [{ storage_path: "/evidence/test.pdf" }] };
    if (sql.includes("FROM analysis_runs") && sql.includes("array_agg")) return { rows: [{ ids: [runId] }] };
    if (sql.includes("FROM coordinator_v3_runs") && sql.includes("array_agg")) {
      return { rows: [{ ids: [coordinatorRunId] }] };
    }
    return { rows: [] };
  });
  const release = vi.fn();
  const repository = new PostgresCaseRepository({
    connect: vi.fn().mockResolvedValue({ query, release }),
  } as unknown as Pool);
  return { repository, query, release };
}

describe("archived case deletion", () => {
  it("routes DELETE and removes local case evidence files", async () => {
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), "kyb-case-delete-"));
    const caseDirectory = path.join(storageRoot, caseId);
    try {
      await mkdir(caseDirectory);
      await writeFile(path.join(caseDirectory, "evidence.pdf"), "synthetic evidence");
      const deleteCase = vi.fn().mockResolvedValue({
        caseId,
        storagePaths: ["/unused/evidence.pdf"],
        cleanupWarning: null,
      });
      const handle = createApiHandler({
        service: { deleteCase } as unknown as CaseApiService,
        storageRoot,
      });

      const response = await handle(new Request(`http://localhost/api/cases/${caseId}`, { method: "DELETE" }));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ deleted: true });
      expect(deleteCase).toHaveBeenCalledWith(caseId);
      await expect(readdir(caseDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(storageRoot, { recursive: true, force: true });
    }
  });

  it("only asks the repository to delete, then cleans unique processing files", async () => {
    const deleteArchivedCase = vi.fn().mockResolvedValue({
      case_id: caseId,
      storage_paths: ["/storage/one.pdf", "/storage/one.pdf"],
      applicant_id: "applicant-1",
      application_id: "application-1",
    });
    const deleteFile = vi.fn().mockResolvedValue(undefined);
    const service = new CaseApiService(
      { deleteArchivedCase } as unknown as CaseRepository,
      { deleteFile } as never,
      { coordinatorFlowId: "coordinator", ingestionFlowId: "ingestion" },
    );

    await expect(service.deleteCase(caseId)).resolves.toEqual({
      caseId,
      storagePaths: ["/storage/one.pdf"],
      cleanupWarning: null,
    });
    expect(deleteArchivedCase).toHaveBeenCalledWith(caseId);
    expect(deleteFile).toHaveBeenCalledOnce();
    expect(deleteFile).toHaveBeenCalledWith({ flowId: "ingestion", storagePath: "/storage/one.pdf" });
  });

  it.each([
    { error: "case_not_archived", code: "case_not_archived", status: 409 },
    { error: "case_analysis_active", code: "case_analysis_active", status: 409 },
  ])("maps $error to an API conflict", async ({ error, code, status }) => {
    const deleteArchivedCase = vi.fn().mockRejectedValue(new Error(error));
    const service = new CaseApiService(
      { deleteArchivedCase } as unknown as CaseRepository,
      {} as never,
      { coordinatorFlowId: "coordinator" },
    );

    await expect(service.deleteCase(caseId)).rejects.toMatchObject({
      status,
      code,
    } satisfies Partial<ApiError>);
  });

  it("returns a storage cleanup warning without restoring the deleted case", async () => {
    const deleteArchivedCase = vi.fn().mockResolvedValue({
      case_id: caseId,
      storage_paths: ["/storage/one.pdf"],
      applicant_id: "applicant-1",
      application_id: "application-1",
    });
    const deleteFile = vi.fn().mockRejectedValue(new Error("processing storage unavailable"));
    const service = new CaseApiService(
      { deleteArchivedCase } as unknown as CaseRepository,
      { deleteFile } as never,
      { coordinatorFlowId: "coordinator", ingestionFlowId: "ingestion" },
    );

    await expect(service.deleteCase(caseId)).resolves.toMatchObject({
      caseId,
      cleanupWarning: expect.stringContaining("case and its history were deleted"),
    });
  });

  it("purges in one transaction with case and analysis-scoped trigger context", async () => {
    const { repository, query, release } = createRepository();

    await expect(repository.deleteArchivedCase(caseId)).resolves.toEqual({
      case_id: caseId,
      storage_paths: ["/evidence/test.pdf"],
      applicant_id: "applicant-1",
      application_id: "application-1",
    });

    const statements = query.mock.calls.map(([sql]) => String(sql));
    expect(statements[0]).toBe("BEGIN");
    const purgeContext = query.mock.calls.find(([sql]) => String(sql).includes("set_config('jeen.case_purge_id'"));
    expect(purgeContext?.[1]).toEqual([caseId, JSON.stringify([runId]), JSON.stringify([coordinatorRunId])]);
    expect(statements.indexOf("DELETE FROM case_final_decisions WHERE case_id = $1::uuid"))
      .toBeLessThan(statements.findIndex((sql) => sql.includes("SET active_analysis_run_id = NULL")));
    expect(statements.findIndex((sql) => sql.includes("SET active_analysis_run_id = NULL")))
      .toBeLessThan(statements.indexOf("DELETE FROM onboarding_cases WHERE id = $1::uuid"));
    expect(statements.at(-1)).toBe("COMMIT");
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([
    { archivedAt: null },
    { hasActiveAnalysis: true },
    { hasActiveCoordinator: true },
  ])("rejects deletion when the case is unarchived or still active: %o", async (options) => {
    const { repository, query } = createRepository(options);

    await expect(repository.deleteArchivedCase(caseId)).rejects.toThrow(
      options.archivedAt === null ? "case_not_archived" : "case_analysis_active",
    );
    expect(query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(query.mock.calls.some(([sql]) => String(sql).includes("set_config('jeen.case_purge_id'"))).toBe(false);
  });
});
