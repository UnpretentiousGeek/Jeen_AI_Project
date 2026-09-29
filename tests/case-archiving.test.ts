import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

import { createApiHandler } from "../src/api/http.js";
import { PostgresCaseRepository } from "../src/api/repository.js";
import type { CaseRepository } from "../src/api/repository.js";
import { CaseApiService } from "../src/api/service.js";

const caseId = "32000000-0000-4000-8000-000000000051";

describe("case archive API", () => {
  it("routes archive requests with the analyst identity and validates the request body", async () => {
    const setCaseArchived = vi.fn().mockResolvedValue({ id: caseId, archived_at: "2026-09-24T12:00:00Z" });
    const service = new CaseApiService({ setCaseArchived } as unknown as CaseRepository, {} as never, {
      coordinatorFlowId: "flow",
    });
    const handle = createApiHandler({
      service,
      storageRoot: "/tmp",
    });

    const response = await handle(new Request(`http://localhost/api/cases/${caseId}/archive`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-actor-id": "analyst-7" },
      body: JSON.stringify({ archived: true }),
    }));

    expect(response.status).toBe(200);
    expect(setCaseArchived).toHaveBeenCalledWith(caseId, true, "analyst-7");
    const invalid = await handle(new Request(`http://localhost/api/cases/${caseId}/archive`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: "{}",
    }));
    expect(invalid.status).toBe(400);
  });

  it("uses the local analyst fallback and maps active-analysis conflicts", async () => {
    const setCaseArchived = vi.fn().mockRejectedValue(new Error("case_analysis_active"));
    const service = new CaseApiService({ setCaseArchived } as unknown as CaseRepository, {} as never, {
      coordinatorFlowId: "flow",
    });
    const handle = createApiHandler({
      service,
      storageRoot: "/tmp",
    });

    const response = await handle(new Request(`http://localhost/api/cases/${caseId}/archive`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ archived: true }),
    }));

    expect(response.status).toBe(409);
    expect(setCaseArchived).toHaveBeenCalledWith(caseId, true, "local-analyst");
    await expect(response.json()).resolves.toMatchObject({ error: { code: "case_analysis_active" } });
  });

  it("normalizes analyst identity and reports missing or actively running cases", async () => {
    const repository: Partial<CaseRepository> = {
      setCaseArchived: vi.fn().mockResolvedValue({ id: caseId, archived_at: "now" }),
    };
    const service = new CaseApiService(repository as CaseRepository, {} as never, { coordinatorFlowId: "flow" });

    await expect(service.setCaseArchived(caseId, { archived: true }, " analyst-7 ")).resolves.toEqual({
      id: caseId, archived_at: "now",
    });
    expect(repository.setCaseArchived).toHaveBeenCalledWith(caseId, true, "analyst-7");

    repository.setCaseArchived = vi.fn().mockResolvedValue(null);
    await expect(service.setCaseArchived(caseId, { archived: false }, "analyst-7"))
      .rejects.toMatchObject({ status: 404, code: "case_not_found" });

    repository.setCaseArchived = vi.fn().mockRejectedValue(new Error("case_analysis_active"));
    await expect(service.setCaseArchived(caseId, { archived: true }, "analyst-7"))
      .rejects.toMatchObject({ status: 409, code: "case_analysis_active" });
  });
});

describe("Postgres case archiving", () => {
  function createRepository(options: {
    archivedAt?: string | null;
    runStatus?: string | null;
    coordinatorPhase?: string | null;
  } = {}) {
    const query = vi.fn().mockImplementation(async (sql: string, parameters?: unknown[]) => {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
      if (sql.includes("FROM onboarding_cases c") && sql.includes("FOR UPDATE OF c")) {
        return { rows: [{
          id: caseId,
          archived_at: options.archivedAt ?? null,
          run_status: options.runStatus ?? null,
          coordinator_phase: options.coordinatorPhase ?? null,
          analysis_run_id: "a7c0b8f7-56ef-4058-b599-ac20e49d6907",
        }] };
      }
      if (sql.includes("UPDATE onboarding_cases")) return { rows: [{ id: caseId, archived_at: parameters?.[1] ? "now" : null }] };
      return { rows: [] };
    });
    const release = vi.fn();
    const repository = new PostgresCaseRepository({
      connect: vi.fn().mockResolvedValue({ query, release }),
    } as unknown as Pool);
    return { repository, query, release };
  }

  it("archives transactionally and records an analyst audit event", async () => {
    const { repository, query, release } = createRepository();

    await expect(repository.setCaseArchived(caseId, true, "analyst-7")).resolves.toEqual({
      id: caseId, archived_at: "now",
    });

    const statements = query.mock.calls.map(([sql]) => String(sql));
    expect(statements[0]).toBe("BEGIN");
    expect(statements.find((sql) => sql.includes("FOR UPDATE OF c"))).toBeTruthy();
    expect(statements.some((sql) => sql.includes("INSERT INTO audit_events"))).toBe(true);
    const audit = query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO audit_events"));
    expect(audit?.[1]).toEqual([
      caseId, "a7c0b8f7-56ef-4058-b599-ac20e49d6907", "case.archived", "analyst-7", true,
    ]);
    expect(statements.at(-1)).toBe("COMMIT");
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([
    { runStatus: "queued" },
    { runStatus: "running" },
    { coordinatorPhase: "running" },
  ])("rejects archiving while workflow activity is running: %o", async (options) => {
    const { repository, query } = createRepository(options);

    await expect(repository.setCaseArchived(caseId, true, "analyst-7")).rejects.toThrow("case_analysis_active");
    expect(query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO audit_events"))).toBe(false);
  });

  it("unarchives a case and records the restoration event", async () => {
    const { repository, query } = createRepository({ archivedAt: "2026-09-23T10:00:00Z" });

    await expect(repository.setCaseArchived(caseId, false, "analyst-7")).resolves.toEqual({
      id: caseId, archived_at: null,
    });
    const update = query.mock.calls.find(([sql]) => String(sql).includes("UPDATE onboarding_cases"));
    expect(update?.[1]).toEqual([caseId, false, "analyst-7"]);
    const audit = query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO audit_events"));
    expect(audit?.[1]).toEqual([
      caseId, "a7c0b8f7-56ef-4058-b599-ac20e49d6907", "case.unarchived", "analyst-7", false,
    ]);
  });

  it("does not start analysis for an archived case", async () => {
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql === "BEGIN" || sql === "ROLLBACK" || sql === "COMMIT") return { rows: [] };
      if (sql.includes("SELECT archived_at FROM onboarding_cases")) {
        return { rows: [{ archived_at: "2026-09-23T10:00:00Z" }] };
      }
      return { rows: [] };
    });
    const repository = new PostgresCaseRepository({
      connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
    } as unknown as Pool);

    await expect(repository.startAnalysis({
      caseId, sessionId: "kyb-analysis:test", analystInstructions: null,
    })).rejects.toThrow("case_archived");
    expect(query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(query.mock.calls.some(([sql]) => String(sql).includes("start_analysis_run"))).toBe(false);
  });
});
