import { z } from "zod";

import { identifierSchema } from "../contracts/shared.js";

export const scopedCitationSchema = z.object({
  source_id: identifierSchema,
  chunk_id: identifierSchema,
  locator: z.string().min(1),
  excerpt: z.string().min(1),
});

export const scopedHumanInputEvidenceSchema = z.object({
  source_id: identifierSchema,
  locator: z.string().min(1),
  excerpt: z.string().min(1),
  submitted_by: identifierSchema,
  submitted_at: z.iso.datetime(),
});

export const scopedTaskBaseSchema = z.object({
  schema_version: z.literal("1.0"),
  case_id: identifierSchema,
  analysis_run_id: identifierSchema,
});

export type ScopedCitation = z.infer<typeof scopedCitationSchema>;
export type ScopedHumanInputEvidence = z.infer<typeof scopedHumanInputEvidenceSchema>;

export interface EvidenceScopedTaskInput {
  analysis_run_id: string;
  case_evidence: ScopedCitation[];
  policy_evidence: ScopedCitation[];
  human_input_evidence?: ScopedHumanInputEvidence[] | undefined;
}

const uuidSchema = z.uuid();
const taskIdentifierSchema = z.string().min(1);
const specialtyV3Schema = z.enum(["entity", "ownership", "policy", "public_research"]);

const evidenceScopeV3Schema = z.object({
  permitted_document_ids: z.array(uuidSchema),
  permitted_policy_version_ids: z.array(uuidSchema),
  permitted_web_result_ids: z.array(uuidSchema),
}).strict();

const taskContextV3Shape = {
  schema_version: z.literal("3.0"),
  case_id: uuidSchema,
  analysis_run_id: uuidSchema,
  coordinator_run_id: uuidSchema,
  task_id: taskIdentifierSchema,
  context_id: taskIdentifierSchema,
  specialty: specialtyV3Schema,
  task_objective: z.string().min(1),
  attempt: z.number().int().min(1).max(3),
  parent_task_id: taskIdentifierSchema.nullable(),
  evidence_scope: evidenceScopeV3Schema,
  allow_network: z.literal(false),
};

const taskContextV3ObjectSchema = z.object(taskContextV3Shape).strict();

function addRetryLineageIssues(
  value: { attempt: number; parent_task_id: string | null },
  context: z.RefinementCtx,
): void {
  if (value.attempt === 1 && value.parent_task_id !== null) {
    context.addIssue({
      code: "custom",
      path: ["parent_task_id"],
      message: "attempt 1 must have a null parent_task_id",
    });
  }
  if (value.attempt > 1 && value.parent_task_id === null) {
    context.addIssue({
      code: "custom",
      path: ["parent_task_id"],
      message: "attempts greater than 1 require parent_task_id",
    });
  }
}

function addWebScopeIssues(
  value: {
    specialty: z.infer<typeof specialtyV3Schema>;
    evidence_scope: z.infer<typeof evidenceScopeV3Schema>;
  },
  context: z.RefinementCtx,
): void {
  if (value.specialty !== "public_research" && value.evidence_scope.permitted_web_result_ids.length > 0) {
    context.addIssue({
      code: "custom",
      path: ["evidence_scope", "permitted_web_result_ids"],
      message: "entity, ownership, and policy tasks cannot receive permitted web result ids",
    });
  }
}

export const specialistTaskInputV3Schema = taskContextV3ObjectSchema.superRefine((value, context) => {
  addRetryLineageIssues(value, context);
  addWebScopeIssues(value, context);
});

export type SpecialistTaskInputV3 = z.infer<typeof specialistTaskInputV3Schema>;

const humanInputRequestV3Schema = z.object({
  request_id: taskIdentifierSchema,
  response_type: taskIdentifierSchema,
}).strict();

const humanInputResponseV3Schema = z.object({
  request_id: taskIdentifierSchema,
  response_type: taskIdentifierSchema,
  values: z.record(z.string(), z.unknown()),
  responder: taskIdentifierSchema,
  responded_at: z.iso.datetime(),
}).strict();

export const specialistTaskResumeInputV3Schema = z.object({
  ...taskContextV3Shape,
  outstanding_request: humanInputRequestV3Schema,
  response: humanInputResponseV3Schema,
}).strict().superRefine((value, context) => {
  addRetryLineageIssues(value, context);
  addWebScopeIssues(value, context);
  if (value.response.request_id !== value.outstanding_request.request_id) {
    context.addIssue({
      code: "custom",
      path: ["response", "request_id"],
      message: "response request_id must match outstanding_request request_id",
    });
  }
  if (value.response.response_type !== value.outstanding_request.response_type) {
    context.addIssue({
      code: "custom",
      path: ["response", "response_type"],
      message: "response response_type must match outstanding_request response_type",
    });
  }
});

export type SpecialistTaskResumeInputV3 = z.infer<typeof specialistTaskResumeInputV3Schema>;

const citationReferenceV3Schema = z.object({
  id: taskIdentifierSchema,
  source_kind: z.enum(["case_document", "policy", "human_input", "external_web"]),
  web_result_id: uuidSchema.nullable().optional(),
}).strict();

const resultEnvelopeV3Shape = {
  schema_version: z.literal("3.0"),
  analysis_run_id: uuidSchema,
  coordinator_run_id: uuidSchema,
  task_id: taskIdentifierSchema,
  context_id: taskIdentifierSchema,
  attempt: z.number().int().min(1).max(3),
  parent_task_id: taskIdentifierSchema.nullable(),
};

const specialistContributionResultV3Schema = z.object({
  ...resultEnvelopeV3Shape,
  result_type: z.literal("specialist_contribution"),
  specialty: specialtyV3Schema,
  payload: z.object({
    record_ref: taskIdentifierSchema,
    record_hash: taskIdentifierSchema,
    citation_refs: z.array(citationReferenceV3Schema).min(1),
  }).strict(),
}).strict().superRefine((value, context) => {
  addRetryLineageIssues(value, context);
  for (const [index, citation] of value.payload.citation_refs.entries()) {
    if (citation.source_kind === "external_web" && value.specialty !== "public_research") {
      context.addIssue({
        code: "custom",
        path: ["payload", "citation_refs", index, "source_kind"],
        message: "only public_research may return external_web citations",
      });
    }
    if (citation.source_kind === "external_web"
      && (citation.web_result_id === undefined || citation.web_result_id === null)) {
      context.addIssue({
        code: "custom",
        path: ["payload", "citation_refs", index, "web_result_id"],
        message: "external_web citations require an explicit web_result_id",
      });
    }
  }
});

const humanInputResultV3Schema = z.object({
  ...resultEnvelopeV3Shape,
  result_type: z.literal("human_input_request"),
  payload: z.object({
    request_id: taskIdentifierSchema,
    response_type: taskIdentifierSchema,
    prompt: z.string().min(1),
  }).strict(),
}).strict().superRefine((value, context) => addRetryLineageIssues(value, context));

const researchRequestResultV3Schema = z.object({
  ...resultEnvelopeV3Shape,
  result_type: z.literal("research_request"),
  payload: z.object({
    request_id: taskIdentifierSchema,
    query: z.string().min(1),
  }).strict(),
}).strict().superRefine((value, context) => addRetryLineageIssues(value, context));

const failureResultV3Schema = z.object({
  ...resultEnvelopeV3Shape,
  result_type: z.literal("failure"),
  payload: z.object({
    code: taskIdentifierSchema,
    message: z.string().min(1),
    retryable: z.boolean(),
  }).strict(),
}).strict().superRefine((value, context) => addRetryLineageIssues(value, context));

export const specialistResultEnvelopeV3Schema = z.union([
  specialistContributionResultV3Schema,
  humanInputResultV3Schema,
  researchRequestResultV3Schema,
  failureResultV3Schema,
]);

export type SpecialistResultEnvelopeV3 = z.infer<typeof specialistResultEnvelopeV3Schema>;

type TaskCorrelation = Pick<SpecialistTaskInputV3, "analysis_run_id" | "coordinator_run_id" | "task_id" | "context_id" | "attempt" | "parent_task_id">;

function taskCorrelation(value: SpecialistTaskInputV3 | SpecialistTaskResumeInputV3): TaskCorrelation {
  return value;
}

export function parseSpecialistTaskInputV3(input: unknown): SpecialistTaskInputV3 {
  return specialistTaskInputV3Schema.parse(input);
}

export function parseSpecialistTaskResumeInputV3(input: unknown): SpecialistTaskResumeInputV3 {
  return specialistTaskResumeInputV3Schema.parse(input);
}

export function parseSpecialistResultEnvelopeV3(input: unknown): SpecialistResultEnvelopeV3 {
  return specialistResultEnvelopeV3Schema.parse(input);
}

export function validateSpecialistTaskResumeV3(
  input: unknown,
  originalTask: unknown,
): SpecialistTaskResumeInputV3 {
  const parsed = parseSpecialistTaskResumeInputV3(input);
  const original = parseSpecialistTaskInputV3(originalTask);
  const immutableFields: Array<keyof SpecialistTaskInputV3> = [
    "schema_version",
    "case_id",
    "analysis_run_id",
    "coordinator_run_id",
    "task_id",
    "context_id",
    "specialty",
    "task_objective",
    "attempt",
    "parent_task_id",
    "evidence_scope",
    "allow_network",
  ];
  for (const field of immutableFields) {
    if (JSON.stringify(parsed[field]) !== JSON.stringify(original[field])) {
      throw new Error(`resume input changed immutable task field ${field}`);
    }
  }
  return parsed;
}

export function validateSpecialistResultEnvelopeV3(
  input: unknown,
  originalTask: unknown,
): SpecialistResultEnvelopeV3 {
  const result = parseSpecialistResultEnvelopeV3(input);
  const task = parseSpecialistTaskInputV3(originalTask);
  const correlation = taskCorrelation(task);
  for (const field of [
    "analysis_run_id",
    "coordinator_run_id",
    "task_id",
    "context_id",
    "attempt",
    "parent_task_id",
  ] as const) {
    if (result[field] !== correlation[field]) {
      throw new Error(`result ${field} does not match the original specialist task`);
    }
  }

  if (result.result_type === "specialist_contribution") {
    const permittedWebResultIds = new Set(task.evidence_scope.permitted_web_result_ids);
    for (const [index, citation] of result.payload.citation_refs.entries()) {
      if (citation.source_kind === "external_web"
        && (citation.web_result_id === undefined
          || citation.web_result_id === null
          || !permittedWebResultIds.has(citation.web_result_id))) {
        throw new Error(`external_web citation ${index} is outside the permitted web-result scope`);
      }
    }
  }
  return result;
}

// Short aliases keep this contract convenient for A2A adapters while retaining
// the explicit v3 names used by the durable coordinator.
export const specialistTaskDispatchInputV3Schema = specialistTaskInputV3Schema;
export const specialistTaskDispatchV3Schema = specialistTaskInputV3Schema;
export const specialistTaskResumeV3Schema = specialistTaskResumeInputV3Schema;
export const specialistTaskResultEnvelopeV3Schema = specialistResultEnvelopeV3Schema;
export const specialistTaskSchema = specialistTaskInputV3Schema;
export const specialistTaskResumeSchema = specialistTaskResumeInputV3Schema;
export const specialistResultEnvelopeSchema = specialistResultEnvelopeV3Schema;
export const parseSpecialistTaskInput = parseSpecialistTaskInputV3;
export const parseSpecialistTaskResumeInput = parseSpecialistTaskResumeInputV3;
export const parseSpecialistResultEnvelope = parseSpecialistResultEnvelopeV3;
export const validateSpecialistTaskResume = validateSpecialistTaskResumeV3;
export const validateSpecialistResultEnvelope = validateSpecialistResultEnvelopeV3;
