import { describe, expect, it, vi } from "vitest";

import { PostgresWebSearchStore } from "../src/web/postgres-web-search-store.js";

const decision = {
  schema_version: "1.0" as const,
  request_id: "10000000-0000-4000-8000-000000000001",
  case_id: "10000000-0000-4000-8000-000000000002",
  analysis_run_id: "10000000-0000-4000-8000-000000000003",
  proposed_action_id: "10000000-0000-4000-8000-000000000004",
  decision: "approved" as const,
  decided_by: "analyst_demo",
  rationale: "The exact official-registry search is necessary and proportionate.",
  decided_at: "2026-09-19T20:00:00.000Z",
  idempotency_key: "review-authorized-v1",
  executionId: "10000000-0000-4000-8000-000000000005",
  expiresAt: "2026-09-19T20:10:00.000Z",
};

describe("Postgres web-search decision authorization", () => {
  it("uses the role-enforcing database function for authenticated dashboard decisions", async () => {
    const query = vi.fn(async (_text: string, _values: unknown[]) => ({
      rows: [{ outcome: "approved" }],
    }));
    const store = new PostgresWebSearchStore(
      { query },
      { actorId: "analyst_demo", roles: ["compliance_analyst"] },
    );

    await expect(store.decide(decision)).resolves.toBe("approved");
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toContain("decide_web_search_action_authorized");
    expect(query.mock.calls[0]?.[1]?.at(-1)).toEqual(["compliance_analyst"]);
  });

  it("blocks an authenticated identity from submitting a decision as another analyst", async () => {
    const query = vi.fn(async (_text: string, _values: unknown[]) => ({
      rows: [{ outcome: "approved" }],
    }));
    const store = new PostgresWebSearchStore(
      { query },
      { actorId: "another_analyst", roles: ["compliance_analyst"] },
    );

    await expect(store.decide(decision)).rejects.toThrow("does not match");
    expect(query).not.toHaveBeenCalled();
  });
});
