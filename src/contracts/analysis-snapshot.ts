import { z } from "zod";

import { citationSchema, identifierSchema, rationaleSchema } from "./shared.js";

const agentContributionSchema = z.object({
  task_id: identifierSchema,
  context_id: identifierSchema,
  agent: z.object({
    name: identifierSchema,
    version: identifierSchema,
  }),
  status: z.enum(["submitted", "working", "input_required", "completed", "failed", "cancelled"]),
  artifact_ids: z.array(identifierSchema),
});

const findingSchema = z.object({
  id: identifierSchema,
  requirement_code: identifierSchema,
  outcome: z.enum(["met", "not_met", "uncertain"]),
  summary: z.string().min(1),
  rationale: rationaleSchema,
  confidence: z.number().min(0).max(1),
  citation_ids: z.array(identifierSchema).min(1),
  agent_artifact_ids: z.array(identifierSchema).min(1),
});

const evidenceGapSchema = z.object({
  id: identifierSchema,
  requirement_code: identifierSchema,
  description: z.string().min(1),
  requested_evidence: z.string().min(1),
  citation_ids: z.array(identifierSchema),
  agent_artifact_ids: z.array(identifierSchema).min(1),
});

const conflictSchema = z.object({
  id: identifierSchema,
  subject: z.string().min(1),
  description: z.string().min(1),
  citation_ids: z.array(identifierSchema).min(2),
  agent_artifact_ids: z.array(identifierSchema).min(1),
});

const humanInputRequestSchema = z.object({
  request_id: identifierSchema,
  type: z.literal("clarification"),
  question: z.string().min(1),
  reason: z.string().min(1),
  input_type: z.enum(["text", "choice", "document"]),
  allowed_choices: z.array(z.string().min(1)).min(1).optional(),
  originating_task_id: identifierSchema.nullable(),
}).superRefine((request, context) => {
  if ((request.input_type === "choice") !== (request.allowed_choices !== undefined)) {
    context.addIssue({
      code: "custom",
      message: "allowed_choices is required only for choice input",
      path: ["allowed_choices"],
    });
  }
});

export const recordInformationRequestActionSchema = z.object({
  id: identifierSchema,
  type: z.literal("record_information_request"),
  summary: z.string().min(1),
  finding_ids: z.array(identifierSchema).min(1),
  citation_ids: z.array(identifierSchema).min(1),
  payload: z.object({
    recipient: z.string().min(1),
    subject: z.string().min(1),
    requested_items: z.array(z.string().min(1)).min(1),
    delivery_channel: z.literal("case_portal"),
  }),
  idempotency_key: identifierSchema,
  requires_approval: z.literal(true),
});

const remainingStandardActionSchema = z.object({
  id: identifierSchema,
  type: z.enum([
    "mark_ready_for_review",
    "create_enhanced_review_task",
    "close_case",
  ]),
  summary: z.string().min(1),
  finding_ids: z.array(identifierSchema),
  citation_ids: z.array(identifierSchema),
  payload: z.record(z.string(), z.unknown()),
  idempotency_key: identifierSchema,
  requires_approval: z.literal(true),
});

export const webSearchActionSchema = z.object({
  id: identifierSchema,
  type: z.literal("run_web_search"),
  summary: z.string().min(1),
  finding_ids: z.array(identifierSchema).min(1),
  citation_ids: z.array(identifierSchema).min(1),
  payload: z.object({
    query: z.string().min(1),
    reason: z.string().min(1),
    allowed_domains: z.array(z.string().min(1)),
    max_results: z.number().int().min(1).max(10),
    intended_use: z.string().min(1),
    external_disclosure: z.array(z.string().min(1)),
  }),
  idempotency_key: identifierSchema,
  requires_approval: z.literal(true),
});

const proposedActionSchema = z.discriminatedUnion("type", [
  recordInformationRequestActionSchema,
  remainingStandardActionSchema,
  webSearchActionSchema,
]);

export const analysisSnapshotSchema = z.object({
  schema_version: z.literal("1.1"),
  case_id: identifierSchema,
  analysis_run_id: identifierSchema,
  status: z.enum([
    "awaiting_information",
    "ready_for_review",
    "awaiting_approval",
    "attention_required",
  ]),
  agent_contributions: z.array(agentContributionSchema),
  findings: z.array(findingSchema),
  evidence_gaps: z.array(evidenceGapSchema),
  conflicts: z.array(conflictSchema),
  citations: z.array(citationSchema),
  human_input_request: humanInputRequestSchema.nullable(),
  proposed_actions: z.array(proposedActionSchema),
}).superRefine((snapshot, context) => {
  if ((snapshot.status === "awaiting_information") !== (snapshot.human_input_request !== null)) {
    context.addIssue({
      code: "custom",
      message: "only awaiting-information snapshots contain a human-input request",
      path: ["human_input_request"],
    });
  }

  if ((snapshot.status === "awaiting_approval") !== (snapshot.proposed_actions.length > 0)) {
    context.addIssue({
      code: "custom",
      message: "proposed actions require awaiting-approval status",
      path: ["proposed_actions"],
    });
  }

  const citationIds = new Set(snapshot.citations.map((citation) => citation.id));
  if (citationIds.size !== snapshot.citations.length) {
    context.addIssue({
      code: "custom",
      message: "citation ids must be unique",
      path: ["citations"],
    });
  }

  const contributionArtifactIds = snapshot.agent_contributions.flatMap(
    (contribution) => contribution.artifact_ids,
  );
  const artifactIds = new Set(contributionArtifactIds);
  const contributionTaskIds = snapshot.agent_contributions.map((contribution) => contribution.task_id);
  const taskIds = new Set(contributionTaskIds);
  const findingIds = new Set(snapshot.findings.map((finding) => finding.id));

  if (taskIds.size !== contributionTaskIds.length) {
    context.addIssue({
      code: "custom",
      message: "agent contribution task ids must be unique",
      path: ["agent_contributions"],
    });
  }

  if (artifactIds.size !== contributionArtifactIds.length) {
    context.addIssue({
      code: "custom",
      message: "agent contribution artifact ids must be unique",
      path: ["agent_contributions"],
    });
  }

  const citationReferences = [
    ...snapshot.findings.flatMap((finding) => finding.citation_ids),
    ...snapshot.evidence_gaps.flatMap((gap) => gap.citation_ids),
    ...snapshot.conflicts.flatMap((conflict) => conflict.citation_ids),
    ...snapshot.proposed_actions.flatMap((action) => action.citation_ids),
  ];

  for (const citationId of citationReferences) {
    if (!citationIds.has(citationId)) {
      context.addIssue({
        code: "custom",
        message: `unknown citation id: ${citationId}`,
        path: ["citations"],
      });
    }
  }

  const artifactReferences = [
    ...snapshot.findings.flatMap((finding) => finding.agent_artifact_ids),
    ...snapshot.evidence_gaps.flatMap((gap) => gap.agent_artifact_ids),
    ...snapshot.conflicts.flatMap((conflict) => conflict.agent_artifact_ids),
  ];

  for (const artifactId of artifactReferences) {
    if (!artifactIds.has(artifactId)) {
      context.addIssue({
        code: "custom",
        message: `unknown specialist artifact id: ${artifactId}`,
        path: ["agent_contributions"],
      });
    }
  }

  for (const action of snapshot.proposed_actions) {
    for (const findingId of action.finding_ids) {
      if (!findingIds.has(findingId)) {
        context.addIssue({
          code: "custom",
          message: `unknown finding id: ${findingId}`,
          path: ["proposed_actions"],
        });
      }
    }
  }

  for (const citation of snapshot.citations) {
    if (citation.source_kind === "external_web"
      && (!taskIds.has(citation.agent_task_id) || !artifactIds.has(citation.agent_artifact_id))) {
      context.addIssue({
        code: "custom",
        message: "external-web citations require known agent task and artifact provenance",
        path: ["citations"],
      });
    }
  }

  const requestTaskId = snapshot.human_input_request?.originating_task_id;
  if (requestTaskId !== undefined && requestTaskId !== null && !taskIds.has(requestTaskId)) {
    context.addIssue({
      code: "custom",
      message: `unknown originating task id: ${requestTaskId}`,
      path: ["human_input_request", "originating_task_id"],
    });
  }
});

export type AnalysisSnapshot = z.infer<typeof analysisSnapshotSchema>;
export type RecordInformationRequestAction = z.infer<typeof recordInformationRequestActionSchema>;
export type WebSearchAction = z.infer<typeof webSearchActionSchema>;

export function parseAnalysisSnapshot(input: unknown): AnalysisSnapshot {
  return analysisSnapshotSchema.parse(input);
}
