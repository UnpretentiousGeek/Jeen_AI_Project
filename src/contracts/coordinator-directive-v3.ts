import { z } from "zod";

const specialtySchema = z.enum(["entity", "ownership", "policy", "public_research"]);
const nonEmptyText = z.string().trim().min(1);
const uuidSchema = z.uuid();

const planItemSchema = z.object({
  specialty: specialtySchema,
  reason: nonEmptyText,
  task_objective: nonEmptyText,
  required: z.boolean(),
}).strict();

const checkpointKindSchema = z.enum([
  "information_request",
  "conflict_review",
  "specialist_recovery",
  "search_execution_approval",
  "web_result_review",
  "analyst_approval",
]);

const checkpointActionSets = {
  information_request: ["submit_clarification", "reject", "skip_for_now"],
  conflict_review: ["escalate", "reject", "skip_for_now"],
  specialist_recovery: ["retry", "abort", "skip_for_now"],
  search_execution_approval: ["approve", "changes_requested", "reject", "skip_for_now"],
  web_result_review: ["accept", "reject", "skip_for_now"],
  analyst_approval: ["approve", "changes_requested", "reject", "skip_for_now"],
} as const;

const checkpointPayloadSchema = z.record(z.string(), z.unknown()).refine(
  (value) => Object.keys(value).length > 0,
  "checkpoint_payload must not be empty",
);

const citationSchema = z.discriminatedUnion("source_kind", [
  z.object({
    source_kind: z.literal("case_document"),
    document_chunk_id: uuidSchema,
    locator: nonEmptyText,
    excerpt: nonEmptyText,
  }).strict(),
  z.object({
    source_kind: z.literal("policy"),
    policy_chunk_id: uuidSchema,
    locator: nonEmptyText,
    excerpt: nonEmptyText,
  }).strict(),
  z.object({
    source_kind: z.literal("human_input"),
    human_input_request_id: uuidSchema,
    locator: nonEmptyText,
    excerpt: nonEmptyText,
  }).strict(),
  z.object({
    source_kind: z.literal("external_web"),
    external_web_evidence_id: uuidSchema,
    agent_task_id: nonEmptyText,
    agent_artifact_id: nonEmptyText,
    locator: nonEmptyText,
    excerpt: nonEmptyText,
  }).strict(),
]);

const finalFindingsPayloadSchema = z.object({
  findings: z.array(z.object({
    requirement_code: nonEmptyText,
    outcome: z.enum(["met", "not_met", "uncertain"]),
    summary: nonEmptyText,
    rationale: nonEmptyText,
    confidence: z.number().min(0).max(1).nullable().optional(),
    citations: z.array(citationSchema).min(1),
  }).strict()).min(1),
  evidence_gaps: z.array(z.object({
    requirement_code: nonEmptyText,
    description: nonEmptyText,
    requested_evidence: nonEmptyText,
  }).strict()),
  conflicts: z.array(z.object({
    subject: nonEmptyText,
    description: nonEmptyText,
  }).strict()),
}).strict();

const baseShape = {
  schema_version: z.literal("1.0"),
  analysis_run_id: uuidSchema,
  expected_state_version: z.number().int().min(0),
  iteration: z.number().int().min(1),
  plan: z.array(planItemSchema),
  rationale_summary: nonEmptyText,
};

const directiveSchema = z.discriminatedUnion("next_action", [
  z.object({
    ...baseShape,
    next_action: z.literal("dispatch_specialist"),
    target_specialty: specialtySchema,
    attempt: z.number().int().min(1).max(3),
    parent_task_id: nonEmptyText.nullable(),
  }).strict(),
  // Entity and Ownership first attempts may run together; retries stay single.
  z.object({
    ...baseShape,
    next_action: z.literal("dispatch_specialists"),
    target_specialties: z.array(z.enum(["entity", "ownership"])).min(2),
    attempt: z.literal(1),
    parent_task_id: z.null(),
  }).strict(),
  z.object({
    ...baseShape,
    next_action: z.literal("request_checkpoint"),
    checkpoint_kind: checkpointKindSchema,
    checkpoint_request_key: nonEmptyText,
    checkpoint_title: nonEmptyText,
    checkpoint_explanation: nonEmptyText,
    allowed_actions: z.array(nonEmptyText).min(1),
    checkpoint_payload: checkpointPayloadSchema,
  }).strict(),
  z.object({
    ...baseShape,
    next_action: z.literal("save_final_findings"),
    final_payload: finalFindingsPayloadSchema,
  }).strict(),
  z.object({
    ...baseShape,
    next_action: z.literal("propose_action"),
    proposed_action_type: z.literal("mark_ready_for_review"),
    proposed_action_summary: nonEmptyText,
  }).strict(),
  z.object({
    ...baseShape,
    next_action: z.literal("stop"),
    terminal_reason: nonEmptyText,
  }).strict(),
]);

export const coordinatorDirectiveV3Schema = directiveSchema.superRefine((directive, context) => {
  if (directive.next_action === "dispatch_specialist") {
    if (!directive.plan.some((item) => item.specialty === directive.target_specialty)) {
      context.addIssue({ code: "custom", path: ["target_specialty"], message: "target_specialty must appear in plan" });
    }
    if (directive.attempt === 1 && directive.parent_task_id !== null) {
      context.addIssue({ code: "custom", path: ["parent_task_id"], message: "attempt 1 cannot have a parent task" });
    }
    if (directive.attempt > 1 && directive.parent_task_id === null) {
      context.addIssue({ code: "custom", path: ["parent_task_id"], message: "retry attempts require a parent task" });
    }
  }

  if (directive.next_action === "dispatch_specialists") {
    if (new Set(directive.target_specialties).size !== directive.target_specialties.length) {
      context.addIssue({ code: "custom", path: ["target_specialties"], message: "target_specialties must be distinct" });
    }
    if (!directive.target_specialties.every((specialty) => directive.plan.some((item) => item.specialty === specialty))) {
      context.addIssue({ code: "custom", path: ["target_specialties"], message: "target_specialties must appear in plan" });
    }
  }

  if (directive.next_action === "request_checkpoint") {
    const expected = checkpointActionSets[directive.checkpoint_kind];
    const actual = directive.allowed_actions;
    const exact = actual.length === expected.length
      && expected.every((action, index) => actual[index] === action);
    if (!exact) {
      context.addIssue({
        code: "custom",
        path: ["allowed_actions"],
        message: `allowed_actions must exactly match ${directive.checkpoint_kind}`,
      });
    }
  }
});

export type CoordinatorDirectiveV3 = z.infer<typeof coordinatorDirectiveV3Schema>;

export function parseCoordinatorDirectiveV3(input: unknown): CoordinatorDirectiveV3 {
  return coordinatorDirectiveV3Schema.parse(input);
}

export const coordinatorDirectiveSchema = coordinatorDirectiveV3Schema;
export const parseCoordinatorDirective = parseCoordinatorDirectiveV3;
export const validateCoordinatorDirectiveV3 = parseCoordinatorDirectiveV3;
export const validateCoordinatorDirective = parseCoordinatorDirectiveV3;
