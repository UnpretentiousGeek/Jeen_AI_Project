import { z } from "zod";

import { uuidSchema } from "../api/contracts.ts";
import { ApiError } from "../api/service.ts";
import { validateAssessmentProposal } from "./assessment.ts";
import { rankAssessments } from "./assessment-ranking.ts";
import type { AssessmentRepository } from "./assessment-repository.ts";
import type { PolicyAssessmentExtractor } from "./openai-extractor.ts";

const createSchema = z.object({
  policy_chunk_id: uuidSchema,
  document_id: uuidSchema,
}).strict();

const reviewSchema = z.object({
  decision: z.enum(["accepted", "rejected"]),
  rationale: z.string().trim().min(1).max(2_000),
}).strict();

/** What to tell the model when its answer fails verification, keyed by the validation error. */
const ASSESSMENT_CORRECTIONS: Record<string, string> = {
  policy_assessment_invalid_requirement:
    "requirement.excerpt must be one contiguous passage copied exactly from the policy text, without joining separate sentences, and the statement, required evidence and rationale must not be empty.",
  policy_assessment_invalid_fact_citation:
    "each fact's excerpt must be one contiguous passage copied exactly from the document chunk named by its chunk_id.",
  policy_assessment_duplicate_fact: "the same excerpt was cited twice from one chunk.",
  policy_assessment_missing_facts: "a supports or contradicts outcome needs at least one cited fact.",
  policy_assessment_too_many_facts: "cite at most 20 facts.",
  policy_assessment_undeclared_conflict:
    "declaration_conflicts may only name a field listed in applicant_declaration.",
  policy_assessment_invalid_conflict:
    "each declaration_conflicts entry needs a distinct field, a non-empty explanation, and fact_indexes that are distinct zero-based positions of facts you cited.",
};

/** Pairs assessed per batch call; a larger case continues on the next call. */
const MAX_BATCH_PAIRS = 60;
/** Assessments in flight at once. The model client retries rate-limited calls, so this only
 * paces the burst against the account's tokens-per-minute limit. */
const BATCH_CONCURRENCY = 3;

export class PolicyAssessmentService {
  constructor(
    private readonly repository: AssessmentRepository,
    private readonly extractor: PolicyAssessmentExtractor | null,
  ) {}

  async listCandidates(runId: string) {
    return this.repository.listCandidates(runId);
  }

  async generate(runId: string, input: unknown) {
    if (!this.extractor) {
      throw new ApiError(503, "policy_extraction_unavailable", "Policy extraction is not configured.");
    }
    const { policy_chunk_id, document_id } = createSchema.parse(input);
    const context = await this.repository.getContext(runId, policy_chunk_id, document_id);
    if (!context) {
      throw new ApiError(404, "policy_assessment_scope", "The policy passage or document is not available for this run.");
    }
    if (!context.document.chunks.length) {
      throw new ApiError(422, "policy_assessment_no_text", "This document has no readable text to assess.");
    }

    // A misquote is usually one slip, so the model gets one more attempt told exactly what failed.
    // Its answer is still verified the same way; nothing unverified is stored.
    let correction: string | undefined;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      let candidate;
      try {
        candidate = await this.extractor.extract(context, correction);
      } catch {
        break;
      }
      try {
        const proposal = validateAssessmentProposal(context, candidate);
        return this.repository.save({ context, model: this.extractor.model, proposal });
      } catch (error) {
        correction = ASSESSMENT_CORRECTIONS[error instanceof Error ? error.message : ""]
          ?? "It did not match the required structure.";
      }
    }
    throw new ApiError(502, "policy_assessment_invalid", "The proposed assessment could not be verified against its source passages.");
  }

  /**
   * Assesses every applicable policy passage against every pinned document, in code, so the cost
   * of the policy step grows with the number of pairs rather than with an agent's conversation.
   * Pairs already proposed in this run or accepted earlier are skipped, so a retry resumes where an
   * interrupted batch stopped. Results are compact: identifiers and outcomes, never source text.
   */
  async generateAll(runId: string) {
    const [candidates, existing, accepted] = await Promise.all([
      this.repository.listCandidates(runId),
      this.repository.list(runId),
      this.repository.listAccepted(runId),
    ]);
    const done = new Set([...existing, ...accepted].map((item) => `${item.policy_chunk_id}:${item.document_id}`));
    const pairs = candidates.policy_passages.flatMap((passage) => candidates.documents
      .filter((document) => !done.has(`${passage.chunk_id}:${document.document_id}`))
      .map((document) => ({ passage, document })));
    const planned = pairs.slice(0, MAX_BATCH_PAIRS);
    const assessed: Array<Record<string, string>> = [];
    const failed: Array<Record<string, string>> = [];
    let next = 0;
    const worker = async () => {
      while (next < planned.length) {
        const { passage, document } = planned[next++]!;
        const pair = {
          policy_chunk_id: passage.chunk_id, policy_locator: passage.locator,
          document_id: document.document_id, document: document.original_filename,
        };
        try {
          const stored = await this.generate(runId, { policy_chunk_id: passage.chunk_id, document_id: document.document_id });
          assessed.push({ ...pair, proposal_id: stored.id, outcome: stored.proposal.outcome });
        } catch (error) {
          failed.push({ ...pair, error: error instanceof ApiError ? error.code : "policy_assessment_failed" });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, planned.length) }, worker));
    return {
      pair_count: candidates.policy_passages.length * candidates.documents.length,
      skipped_existing: candidates.policy_passages.length * candidates.documents.length - pairs.length,
      assessed,
      failed,
      not_attempted: pairs.length - planned.length,
    };
  }

  async list(runId: string) {
    // Most informative first, so the proposals an analyst must see are not buried among the rest.
    return { assessments: rankAssessments(await this.repository.list(runId)) };
  }

  async listAccepted(runId: string) {
    return { assessments: await this.repository.listAccepted(runId) };
  }

  async review(runId: string, proposalId: string, actorId: string, input: unknown) {
    const { decision, rationale } = reviewSchema.parse(input);
    const actor = actorId.trim();
    if (!actor || actor.length > 200) {
      throw new ApiError(400, "actor_id_invalid", "Provide a valid analyst identity.");
    }
    const reviewed = await this.repository.review({
      runId, proposalId, decision, actorId: actor, rationale,
    });
    if (!reviewed) {
      throw new ApiError(409, "policy_assessment_unavailable", "This proposal is missing or has already been reviewed.");
    }
    return reviewed;
  }
}
