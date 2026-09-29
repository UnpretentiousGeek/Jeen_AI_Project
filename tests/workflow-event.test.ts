import { describe, expect, it } from "vitest";

import { parseWorkflowEvent, workflowEventSchema } from "../src/contracts/workflow-event.js";

const eventEnvelope = {
  schema_version: "1.0",
  event_id: "event-001",
  case_id: "case-001",
  analysis_run_id: "run-001",
  occurred_at: "2026-09-18T20:10:00Z",
  correlation_id: "correlation-001",
  causation_id: null,
} as const;

describe("workflowEventSchema", () => {
  it("accepts a typed agent-task lifecycle event", () => {
    const event = {
      ...eventEnvelope,
      event_type: "agent.task.updated",
      payload: {
        task_id: "task-001",
        context_id: "context-run-001",
        agent_name: "ownership-agent",
        agent_version: "1.0.0",
        status: "working",
        attempt: 1,
      },
    } as const;

    expect(parseWorkflowEvent(event)).toEqual(event);
  });

  it("rejects an invalid payload for the selected event type", () => {
    const result = workflowEventSchema.safeParse({
      ...eventEnvelope,
      event_type: "agent.task.updated",
      payload: {
        proposed_action_id: "action-001",
        idempotency_key: "run-001:action-001",
      },
    });

    expect(result.success).toBe(false);
  });

  it("accepts an attributable human-review decision event", () => {
    const event = {
      ...eventEnvelope,
      event_type: "human.review.decided",
      payload: {
        request_id: "review-001",
        proposed_action_id: "action-001",
        decision: "approved",
        decided_by: "analyst-42",
      },
    } as const;

    expect(parseWorkflowEvent(event)).toEqual(event);
  });

  it("links a clarification request to its replacement specialist task", () => {
    const event = {
      ...eventEnvelope,
      event_type: "human.input.resumed",
      payload: {
        request_id: "input-001",
        originating_task_id: "ownership-task-original",
        replacement_task_id: "ownership-task-resumed",
      },
    } as const;

    expect(parseWorkflowEvent(event)).toEqual(event);
  });
});
