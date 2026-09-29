import {
  type RecordInformationRequestAction,
  recordInformationRequestActionSchema,
} from "../contracts/analysis-snapshot.js";
import {
  type HumanReviewDecision,
  parseHumanReviewDecision,
} from "../contracts/human-review.js";

export interface AnalystAuthorization {
  actorId: string;
  roles: string[];
}

export interface InformationRequestProposal {
  reviewRequestId: string;
  caseId: string;
  analysisRunId: string;
  correlationId: string;
  action: RecordInformationRequestAction;
}

export type ApprovalOutcome = "executed" | "rejected" | "changes_requested" | "duplicate";

export interface ApprovalDecisionStore {
  propose(input: InformationRequestProposal): Promise<"stored" | "duplicate">;
  decide(command: HumanReviewDecision): Promise<ApprovalOutcome>;
}

interface ApprovalSqlQueryable {
  query(
    text: string,
    values: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>> }>;
}

function parseOutcome<T extends string>(
  rows: Array<Record<string, unknown>>,
  allowed: readonly T[],
): T {
  const outcome = rows[0]?.outcome;
  if (typeof outcome !== "string" || !allowed.includes(outcome as T)) {
    throw new Error("database did not confirm the approval operation");
  }
  return outcome as T;
}

export class PostgresApprovalDecisionStore implements ApprovalDecisionStore {
  constructor(private readonly database: ApprovalSqlQueryable) {}

  async propose(input: InformationRequestProposal): Promise<"stored" | "duplicate"> {
    const action = recordInformationRequestActionSchema.parse(input.action);
    const result = await this.database.query(
      `SELECT propose_information_request_action(
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::jsonb,
        $7::uuid[], $8::uuid[], $9, $10
      ) AS outcome`,
      [
        action.id,
        input.reviewRequestId,
        input.analysisRunId,
        input.caseId,
        action.summary,
        JSON.stringify(action.payload),
        action.finding_ids,
        action.citation_ids,
        action.idempotency_key,
        input.correlationId,
      ],
    );
    return parseOutcome(result.rows, ["stored", "duplicate"] as const);
  }

  async decide(command: HumanReviewDecision): Promise<ApprovalOutcome> {
    const result = await this.database.query(
      `SELECT decide_information_request_action(
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7,
        $8::timestamptz, $9
      ) AS outcome`,
      [
        command.request_id,
        command.proposed_action_id,
        command.analysis_run_id,
        command.case_id,
        command.decision,
        command.decided_by,
        command.rationale,
        command.decided_at,
        command.idempotency_key,
      ],
    );
    return parseOutcome(
      result.rows,
      ["executed", "rejected", "changes_requested", "duplicate"] as const,
    );
  }
}

export class InMemoryApprovalDecisionStore implements ApprovalDecisionStore {
  private readonly proposals = new Map<string, InformationRequestProposal>();
  private readonly decisions = new Map<string, {
    fingerprint: string;
    outcome: Exclude<ApprovalOutcome, "duplicate">;
  }>();

  async propose(input: InformationRequestProposal): Promise<"stored" | "duplicate"> {
    const normalized = {
      ...input,
      action: recordInformationRequestActionSchema.parse(input.action),
    };
    const existing = this.proposals.get(normalized.action.id);
    if (existing === undefined) {
      this.proposals.set(normalized.action.id, structuredClone(normalized));
      return "stored";
    }
    if (JSON.stringify(existing) === JSON.stringify(normalized)) {
      return "duplicate";
    }
    throw new Error(`proposed action ${normalized.action.id} conflicts with an existing proposal`);
  }

  async decide(command: HumanReviewDecision): Promise<ApprovalOutcome> {
    const proposal = this.proposals.get(command.proposed_action_id);
    if (proposal === undefined
      || proposal.reviewRequestId !== command.request_id
      || proposal.caseId !== command.case_id
      || proposal.analysisRunId !== command.analysis_run_id) {
      throw new Error("review decision does not match the pending proposed action");
    }
    const fingerprint = JSON.stringify(command);
    const existing = this.decisions.get(command.proposed_action_id);
    if (existing !== undefined) {
      if (existing.fingerprint === fingerprint) {
        return "duplicate";
      }
      throw new Error("proposed action has already received a different decision");
    }
    const outcome = command.decision === "approved" ? "executed" : command.decision;
    this.decisions.set(command.proposed_action_id, { fingerprint, outcome });
    return outcome;
  }

  executionCount(): number {
    return [...this.decisions.values()].filter(({ outcome }) => outcome === "executed").length;
  }
}

export function proposeInformationRequest(
  input: InformationRequestProposal,
  store: ApprovalDecisionStore,
): Promise<"stored" | "duplicate"> {
  return store.propose({
    ...input,
    action: recordInformationRequestActionSchema.parse(input.action),
  });
}

export function submitAnalystDecision(input: {
  command: unknown;
  authorization: AnalystAuthorization;
  store: ApprovalDecisionStore;
}): Promise<ApprovalOutcome> {
  const command = parseHumanReviewDecision(input.command);
  if (!input.authorization.roles.includes("compliance_analyst")) {
    throw new Error("compliance analyst role is required to decide proposed actions");
  }
  if (input.authorization.actorId !== command.decided_by) {
    throw new Error("decision actor does not match the authenticated analyst");
  }
  return input.store.decide(command);
}
