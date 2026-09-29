import { z } from "zod";

import { identifierSchema } from "./shared.js";

export const humanInputResponseSchema = z.object({
  schema_version: z.literal("1.0"),
  request_id: identifierSchema,
  case_id: identifierSchema,
  analysis_run_id: identifierSchema,
  response: z.discriminatedUnion("input_type", [
    z.object({ input_type: z.literal("text"), value: z.string().min(1) }),
    z.object({ input_type: z.literal("choice"), value: z.string().min(1) }),
    z.object({ input_type: z.literal("document"), document_ids: z.array(identifierSchema).min(1) }),
  ]),
  submitted_by: identifierSchema,
  submitted_at: z.iso.datetime(),
  idempotency_key: identifierSchema,
});

export const humanReviewDecisionSchema = z.object({
  schema_version: z.literal("1.0"),
  request_id: identifierSchema,
  case_id: identifierSchema,
  analysis_run_id: identifierSchema,
  proposed_action_id: identifierSchema,
  decision: z.enum(["approved", "rejected", "changes_requested"]),
  decided_by: identifierSchema,
  rationale: z.string().min(1),
  decided_at: z.iso.datetime(),
  idempotency_key: identifierSchema,
});

export type HumanInputResponse = z.infer<typeof humanInputResponseSchema>;
export type HumanReviewDecision = z.infer<typeof humanReviewDecisionSchema>;

export function parseHumanInputResponse(input: unknown): HumanInputResponse {
  return humanInputResponseSchema.parse(input);
}

export function parseHumanReviewDecision(input: unknown): HumanReviewDecision {
  return humanReviewDecisionSchema.parse(input);
}
