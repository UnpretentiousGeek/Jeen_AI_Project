import { z } from "zod";

import { identifierSchema } from "./shared.js";

const citationSchema = z.object({
  id: identifierSchema,
  source_kind: z.enum(["case_document", "policy"]),
  source_id: identifierSchema,
  chunk_id: identifierSchema,
  locator: z.string().min(1),
  excerpt: z.string().min(1),
});

const findingSchema = z.object({
  id: identifierSchema,
  requirement_code: identifierSchema,
  outcome: z.enum(["met", "not_met", "uncertain"]),
  summary: z.string().min(1),
  rationale: z.string().min(1),
  confidence: z.number().min(0).max(1),
  citation_ids: z.array(identifierSchema).min(1),
});

const evidenceGapSchema = z.object({
  id: identifierSchema,
  requirement_code: identifierSchema,
  description: z.string().min(1),
  requested_evidence: z.string().min(1),
  citation_ids: z.array(identifierSchema),
});

const conflictSchema = z.object({
  id: identifierSchema,
  subject: z.string().min(1),
  description: z.string().min(1),
  citation_ids: z.array(identifierSchema).min(2),
});

const humanInputRequestSchema = z.object({
  request_id: identifierSchema,
  type: z.literal("clarification"),
  question: z.string().min(1),
  reason: z.string().min(1),
  input_type: z.enum(["text", "choice", "document"]),
  allowed_choices: z.array(z.string().min(1)).min(1).optional(),
}).superRefine((request, context) => {
  if ((request.input_type === "choice") !== (request.allowed_choices !== undefined)) {
    context.addIssue({
      code: "custom",
      message: "allowed_choices is required only for choice input",
      path: ["allowed_choices"],
    });
  }
});

const proposedActionSchema = z.object({
  id: identifierSchema,
  type: z.enum([
    "record_information_request",
    "mark_ready_for_review",
    "create_enhanced_review_task",
    "close_case",
  ]),
  summary: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  idempotency_key: identifierSchema,
  requires_approval: z.literal(true),
});

export const analysisOutputSchema = z.object({
  schema_version: z.literal("1.0"),
  case_id: identifierSchema,
  analysis_run_id: identifierSchema,
  status: z.enum([
    "awaiting_information",
    "ready_for_review",
    "awaiting_approval",
    "attention_required",
  ]),
  findings: z.array(findingSchema),
  evidence_gaps: z.array(evidenceGapSchema),
  conflicts: z.array(conflictSchema),
  citations: z.array(citationSchema),
  human_input_request: humanInputRequestSchema.nullable(),
  proposed_actions: z.array(proposedActionSchema),
}).superRefine((output, context) => {
  if ((output.status === "awaiting_information") !== (output.human_input_request !== null)) {
    context.addIssue({
      code: "custom",
      message: "only awaiting-information outputs contain a human-input request",
      path: ["human_input_request"],
    });
  }

  if ((output.status === "awaiting_approval") !== (output.proposed_actions.length > 0)) {
    context.addIssue({
      code: "custom",
      message: "proposed actions require awaiting-approval status",
      path: ["proposed_actions"],
    });
  }

  const citationIds = new Set(output.citations.map((citation) => citation.id));
  const referencedCitationIds = [
    ...output.findings.flatMap((finding) => finding.citation_ids),
    ...output.evidence_gaps.flatMap((gap) => gap.citation_ids),
    ...output.conflicts.flatMap((conflict) => conflict.citation_ids),
  ];

  for (const citationId of referencedCitationIds) {
    if (!citationIds.has(citationId)) {
      context.addIssue({
        code: "custom",
        message: `unknown citation id: ${citationId}`,
        path: ["citations"],
      });
    }
  }

  if (citationIds.size !== output.citations.length) {
    context.addIssue({
      code: "custom",
      message: "citation ids must be unique",
      path: ["citations"],
    });
  }
});

export type AnalysisOutput = z.infer<typeof analysisOutputSchema>;

export function parseAnalysisOutput(input: unknown): AnalysisOutput {
  return analysisOutputSchema.parse(input);
}
