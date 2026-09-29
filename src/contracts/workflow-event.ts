import { z } from "zod";

import { identifierSchema } from "./shared.js";

const workflowStatusSchema = z.enum([
  "queued",
  "running",
  "suspended",
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
]);

const taskStatusSchema = z.enum([
  "submitted",
  "working",
  "input_required",
  "completed",
  "failed",
  "cancelled",
]);

const eventEnvelope = {
  schema_version: z.literal("1.0"),
  event_id: identifierSchema,
  case_id: identifierSchema,
  analysis_run_id: identifierSchema,
  occurred_at: z.iso.datetime(),
  correlation_id: identifierSchema,
  causation_id: identifierSchema.nullable(),
};

export const workflowEventSchema = z.discriminatedUnion("event_type", [
  z.object({
    ...eventEnvelope,
    event_type: z.literal("run.status_changed"),
    payload: z.object({
      from: workflowStatusSchema,
      to: workflowStatusSchema,
      reason: z.string().min(1).nullable(),
    }),
  }),
  z.object({
    ...eventEnvelope,
    event_type: z.literal("agent.task.updated"),
    payload: z.object({
      task_id: identifierSchema,
      context_id: identifierSchema,
      agent_name: identifierSchema,
      agent_version: identifierSchema,
      status: taskStatusSchema,
      attempt: z.number().int().min(1),
    }),
  }),
  z.object({
    ...eventEnvelope,
    event_type: z.literal("agent.artifact.available"),
    payload: z.object({
      task_id: identifierSchema,
      artifact_id: identifierSchema,
      specialty: z.enum(["entity", "ownership", "policy", "public_research"]),
    }),
  }),
  z.object({
    ...eventEnvelope,
    event_type: z.literal("human.input.requested"),
    payload: z.object({
      request_id: identifierSchema,
      originating_task_id: identifierSchema.nullable(),
      input_type: z.enum(["text", "choice", "document"]),
    }),
  }),
  z.object({
    ...eventEnvelope,
    event_type: z.literal("human.input.submitted"),
    payload: z.object({
      request_id: identifierSchema,
      submitted_by: identifierSchema,
    }),
  }),
  z.object({
    ...eventEnvelope,
    event_type: z.literal("human.input.resumed"),
    payload: z.object({
      request_id: identifierSchema,
      originating_task_id: identifierSchema,
      replacement_task_id: identifierSchema,
    }),
  }),
  z.object({
    ...eventEnvelope,
    event_type: z.literal("human.review.requested"),
    payload: z.object({
      request_id: identifierSchema,
      proposed_action_id: identifierSchema,
    }),
  }),
  z.object({
    ...eventEnvelope,
    event_type: z.literal("human.review.decided"),
    payload: z.object({
      request_id: identifierSchema,
      proposed_action_id: identifierSchema,
      decision: z.enum(["approved", "rejected", "changes_requested"]),
      decided_by: identifierSchema,
    }),
  }),
  z.object({
    ...eventEnvelope,
    event_type: z.literal("action.executed"),
    payload: z.object({
      proposed_action_id: identifierSchema,
      idempotency_key: identifierSchema,
    }),
  }),
  z.object({
    ...eventEnvelope,
    event_type: z.literal("action.failed"),
    payload: z.object({
      proposed_action_id: identifierSchema,
      idempotency_key: identifierSchema,
      error_code: identifierSchema,
      error_message: z.string().min(1),
    }),
  }),
]);

export type WorkflowEvent = z.infer<typeof workflowEventSchema>;

export function parseWorkflowEvent(input: unknown): WorkflowEvent {
  return workflowEventSchema.parse(input);
}
