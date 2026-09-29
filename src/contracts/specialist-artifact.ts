import { z } from "zod";

import { citationSchema, identifierSchema } from "./shared.js";

const observationSchema = z.object({
  id: identifierSchema,
  requirement_code: identifierSchema.optional(),
  summary: z.string().min(1),
  rationale_summary: z.string().min(1),
  confidence: z.number().min(0).max(1),
  citation_ids: z.array(identifierSchema).min(1),
});

const artifactEvidenceGapSchema = z.object({
  id: identifierSchema,
  requirement_code: identifierSchema,
  description: z.string().min(1),
  requested_evidence: z.string().min(1),
  citation_ids: z.array(identifierSchema),
});

const artifactConflictSchema = z.object({
  id: identifierSchema,
  subject: z.string().min(1),
  description: z.string().min(1),
  citation_ids: z.array(identifierSchema).min(2),
});

const artifactErrorSchema = z.object({
  code: identifierSchema,
  message: z.string().min(1),
  retryable: z.boolean(),
});

export const specialistArtifactSchema = z.object({
  schema_version: z.literal("1.0"),
  artifact_id: identifierSchema,
  analysis_run_id: identifierSchema,
  task_id: identifierSchema,
  context_id: identifierSchema,
  agent: z.object({
    name: identifierSchema,
    version: identifierSchema,
  }),
  specialty: z.enum(["entity", "ownership", "policy", "public_research"]),
  status: z.enum(["completed", "partial", "failed"]),
  confidence: z.number().min(0).max(1),
  observations: z.array(observationSchema),
  evidence_gaps: z.array(artifactEvidenceGapSchema),
  conflicts: z.array(artifactConflictSchema),
  citations: z.array(citationSchema),
  error: artifactErrorSchema.nullable(),
  created_at: z.iso.datetime(),
}).superRefine((artifact, context) => {
  if ((artifact.status === "failed") !== (artifact.error !== null)) {
    context.addIssue({
      code: "custom",
      message: "failed artifacts require error details, and successful artifacts cannot contain them",
      path: ["error"],
    });
  }

  const citationIds = new Set(artifact.citations.map((citation) => citation.id));
  const references = [
    ...artifact.observations.flatMap((observation) => observation.citation_ids),
    ...artifact.evidence_gaps.flatMap((gap) => gap.citation_ids),
    ...artifact.conflicts.flatMap((conflict) => conflict.citation_ids),
  ];

  for (const citationId of references) {
    if (!citationIds.has(citationId)) {
      context.addIssue({
        code: "custom",
        message: `unknown citation id: ${citationId}`,
        path: ["citations"],
      });
    }
  }

  if (citationIds.size !== artifact.citations.length) {
    context.addIssue({
      code: "custom",
      message: "citation ids must be unique",
      path: ["citations"],
    });
  }

  for (const citation of artifact.citations) {
    if (citation.source_kind !== "external_web") {
      continue;
    }

    if (artifact.specialty !== "public_research") {
      context.addIssue({
        code: "custom",
        message: "only public-research artifacts may contain external-web citations",
        path: ["citations"],
      });
    }

    if (citation.agent_task_id !== artifact.task_id || citation.agent_artifact_id !== artifact.artifact_id) {
      context.addIssue({
        code: "custom",
        message: "external-web citation provenance must match its artifact and task",
        path: ["citations"],
      });
    }
  }
});

export type SpecialistArtifact = z.infer<typeof specialistArtifactSchema>;

export function parseSpecialistArtifact(input: unknown): SpecialistArtifact {
  return specialistArtifactSchema.parse(input);
}
