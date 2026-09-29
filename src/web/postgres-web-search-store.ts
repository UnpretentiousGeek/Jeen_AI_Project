import { webSearchActionSchema } from "../contracts/analysis-snapshot.js";
import {
  type ApprovedWebSearchScope,
  type StoredWebEvidence,
  type WebSearchClaim,
  type WebSearchDecision,
  type WebSearchProposal,
  type WebSearchStore,
} from "./web-search.js";

interface SqlQueryable {
  query(text: string, values: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

function outcome(rows: Array<Record<string, unknown>>): string {
  const value = rows[0]?.outcome;
  if (typeof value !== "string") throw new Error("database did not confirm the web-search operation");
  return value;
}

export class PostgresWebSearchStore implements WebSearchStore {
  constructor(
    private readonly database: SqlQueryable,
    private readonly authorization?: { actorId: string; roles: string[] },
  ) {}

  async propose(proposal: WebSearchProposal): Promise<"stored" | "duplicate"> {
    const action = webSearchActionSchema.parse(proposal.action);
    const result = await this.database.query(
      `SELECT propose_web_search_action(
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::jsonb,
        $7::uuid[], $8::uuid[], $9, $10
      ) AS outcome`,
      [
        action.id,
        proposal.reviewRequestId,
        proposal.analysisRunId,
        proposal.caseId,
        action.summary,
        JSON.stringify(action.payload),
        action.finding_ids,
        action.citation_ids,
        action.idempotency_key,
        proposal.correlationId,
      ],
    );
    const value = outcome(result.rows);
    if (value !== "stored" && value !== "duplicate") throw new Error(`unexpected proposal outcome: ${value}`);
    return value;
  }

  async decide(decision: WebSearchDecision): Promise<"approved" | "rejected" | "changes_requested" | "duplicate"> {
    if (this.authorization && this.authorization.actorId !== decision.decided_by) {
      throw new Error("decision actor does not match the authenticated analyst");
    }
    const result = await this.database.query(
      `SELECT ${this.authorization ? "decide_web_search_action_authorized" : "decide_web_search_action"}(
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7,
        $8::timestamptz, $9, $10::uuid, $11::timestamptz
        ${this.authorization ? ", $12::text[]" : ""}
      ) AS outcome`,
      [
        decision.request_id,
        decision.proposed_action_id,
        decision.analysis_run_id,
        decision.case_id,
        decision.decision,
        decision.decided_by,
        decision.rationale,
        decision.decided_at,
        decision.idempotency_key,
        decision.executionId,
        decision.expiresAt,
        ...(this.authorization ? [this.authorization.roles] : []),
      ],
    );
    const value = outcome(result.rows);
    if (!["approved", "rejected", "changes_requested", "duplicate"].includes(value)) {
      throw new Error(`unexpected decision outcome: ${value}`);
    }
    return value as "approved" | "rejected" | "changes_requested" | "duplicate";
  }

  async claim(scope: ApprovedWebSearchScope, claimedAt: string): Promise<WebSearchClaim> {
    const result = await this.database.query(
      `SELECT claim_web_search_execution(
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::text[], $7,
        $8, $9::text[], $10::timestamptz
      ) AS outcome`,
      [
        scope.executionId,
        scope.actionId,
        scope.analysisRunId,
        scope.caseId,
        scope.query,
        scope.allowedDomains,
        scope.maxResults,
        scope.intendedUse,
        scope.externalDisclosure,
        claimedAt,
      ],
    );
    const value = outcome(result.rows);
    if (value === "expired") throw new Error("web-search approval has expired");
    if (value === "duplicate") return { outcome: "duplicate" };
    if (value !== "claimed") throw new Error(`unexpected claim outcome: ${value}`);
    return { outcome: "claimed", scope };
  }

  async complete(input: {
    scope: ApprovedWebSearchScope;
    providerRequestId: string | null;
    evidence: StoredWebEvidence[];
    completedAt: string;
  }): Promise<void> {
    const result = await this.database.query(
      `SELECT complete_web_search_execution(
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::jsonb, $7::timestamptz
      ) AS outcome`,
      [
        input.scope.executionId,
        input.scope.actionId,
        input.scope.analysisRunId,
        input.scope.caseId,
        input.providerRequestId,
        JSON.stringify(input.evidence),
        input.completedAt,
      ],
    );
    if (outcome(result.rows) !== "stored") throw new Error("web-search completion was not stored");
  }

  async fail(input: {
    scope: ApprovedWebSearchScope;
    errorCode: string;
    errorMessage: string;
    failedAt: string;
  }): Promise<void> {
    const result = await this.database.query(
      `SELECT fail_web_search_execution(
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::timestamptz
      ) AS outcome`,
      [
        input.scope.executionId,
        input.scope.actionId,
        input.scope.analysisRunId,
        input.scope.caseId,
        input.errorCode,
        input.errorMessage,
        input.failedAt,
      ],
    );
    if (outcome(result.rows) !== "stored") throw new Error("web-search failure was not stored");
  }
}
