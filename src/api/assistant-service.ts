import { z } from "zod";

import type { AssistantAgent } from "./assistant-agent.ts";
import type { AssistantRepository, AssistantTurn } from "./assistant-repository.ts";
import { uuidSchema } from "./contracts.ts";
import { ApiError } from "./service.ts";

const messageSchema = z.object({
  question: z.string().trim().min(1).max(2_000),
  idempotency_key: z.string().trim().min(8).max(300),
}).strict();

const paginationSchema = z.object({
  before: uuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

function view(turn: AssistantTurn) {
  return {
    id: turn.id,
    case_id: turn.case_id,
    actor_id: turn.actor_id,
    question: turn.question,
    answer: turn.answer,
    analysis_run_id: turn.analysis_run_id,
    source_refs: turn.source_refs,
    status: turn.status,
    created_at: turn.created_at,
    completed_at: turn.completed_at,
  };
}

export class CaseAssistantService {
  constructor(
    private readonly repository: AssistantRepository,
    private readonly agent: AssistantAgent | null,
  ) {}

  async getConversation(caseId: string, options: unknown = {}) {
    const { before, limit } = paginationSchema.parse(options);
    const context = await this.repository.getCaseContext(caseId);
    if (!context) throw new ApiError(404, "case_not_found", "Case not found.");
    const fetched = await this.repository.listTurns(caseId, limit + 1, before);
    const hasMore = fetched.length > limit;
    const turns = hasMore ? fetched.slice(1) : fetched;
    return {
      case_id: caseId,
      turns: turns.map(view),
      next_before: hasMore ? turns[0]?.id ?? null : null,
    };
  }

  async ask(caseId: string, actorId: string, input: unknown) {
    const parsed = messageSchema.parse(input);
    const actor = actorId.trim();
    if (!actor || actor.length > 200) {
      throw new ApiError(400, "actor_id_invalid", "Provide a valid analyst identity.");
    }
    if (!this.agent) {
      throw new ApiError(503, "assistant_unavailable", "The case assistant is not configured.");
    }
    const context = await this.repository.getCaseContext(caseId);
    if (!context) throw new ApiError(404, "case_not_found", "Case not found.");

    let claim;
    try {
      claim = await this.repository.claimTurn({
        caseId, actorId: actor, question: parsed.question,
        idempotencyKey: parsed.idempotency_key,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "assistant_idempotency_conflict") {
        throw new ApiError(409, "idempotency_conflict", "This request key was already used for a different question.");
      }
      throw error;
    }
    if (claim.state === "busy") {
      throw new ApiError(409, "assistant_busy", "Another question is still being answered for this case.");
    }
    if (claim.state === "in_progress") {
      throw new ApiError(409, "assistant_in_progress", "This question is still being answered. Refresh the conversation in a moment.");
    }
    const turn = claim.turn!;
    if (claim.state === "completed") return { ...view(turn), replayed: true };

    try {
      const history = (await this.repository.listTurns(caseId, 30))
        .filter((item) => item.id !== turn.id && item.status === "completed")
        .slice(-12);
      const result = await this.agent.answer({ context, history, question: parsed.question });
      const completed = await this.repository.completeTurn({
        turnId: turn.id,
        claimToken: turn.claim_token,
        answer: result.answer,
        analysisRunId: context.analysis_run_id,
        sourceRefs: result.sourceRefs,
      });
      if (!completed) {
        throw new ApiError(409, "assistant_turn_superseded", "This question was retried. Refresh the conversation.");
      }
      return { ...view(completed), replayed: false };
    } catch (error) {
      await this.repository.failTurn(turn.id, turn.claim_token);
      if (error instanceof ApiError) throw error;
      throw new ApiError(502, "assistant_failed", "The assistant could not answer. Try again.");
    }
  }
}
