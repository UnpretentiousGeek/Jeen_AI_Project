import { describe, expect, it } from "vitest";

import { buildAgentTasks } from "../src/api/agent-activity.js";
import { buildReviewPath } from "../src/api/review-path.js";

describe("agent activity", () => {
  it("keeps the recorded failure reason instead of earlier authored next steps", () => {
    const taskEvents = [{
      specialty: "policy", task_id: "policy-task", attempt: 1, event_type: "dispatched",
    }];
    const reviewPath = buildReviewPath({
      plan: [{ specialty: "policy", task_objective: "Assess policy requirements.", required: true }],
      taskEvents, contributions: [], pendingCheckpoint: null, workflowFailed: true,
    });
    const tasks = buildAgentTasks({
      reviewPath, taskEvents, pendingCheckpoint: null,
      coordinatorPhase: "stopped", coordinatorState: {},
      stopReason: "Langflow workflow execution failed", currentIteration: 1,
      workflowFailureReason: "A connected Langflow tool returned invalid JSON.",
      activityUpdates: [{
        subject_key: "coordinator", iteration_no: 1,
        payload: { next_summary: "Dispatch policy specialist" },
      }],
    });
    expect(tasks.find((task) => task.id === "specialist:policy")?.status).toBe("failed");
    expect(tasks.find((task) => task.id === "specialist:policy")?.failure_reason)
      .toBe("A connected Langflow tool returned invalid JSON.");
    expect(tasks.find((task) => task.id === "coordinator")?.next_summary)
      .toBe("Langflow workflow execution failed");
    expect(tasks.find((task) => task.id === "coordinator")?.failure_reason)
      .toBe("A connected Langflow tool returned invalid JSON.");
  });

  it("does not attach the latest workflow error to a previous failed specialist", () => {
    const taskEvents = [
      { specialty: "entity", task_id: "entity-task", attempt: 1, event_type: "dispatched" },
      { specialty: "entity", task_id: "entity-task", attempt: 1, event_type: "failed" },
      { specialty: "policy", task_id: "policy-task", attempt: 1, event_type: "dispatched" },
    ];
    const reviewPath = buildReviewPath({
      plan: [
        { specialty: "entity", required: true },
        { specialty: "policy", required: true },
      ],
      taskEvents, contributions: [], pendingCheckpoint: null, workflowFailed: true,
    });
    const tasks = buildAgentTasks({
      reviewPath, taskEvents, pendingCheckpoint: null,
      coordinatorPhase: "stopped", coordinatorState: {},
      stopReason: "Langflow workflow execution failed",
      workflowFailureReason: "A connected Langflow tool returned invalid JSON.",
    });
    expect(tasks.find((task) => task.id === "specialist:entity")?.failure_reason).toBeNull();
    expect(tasks.find((task) => task.id === "specialist:policy")?.failure_reason)
      .toBe("A connected Langflow tool returned invalid JSON.");
  });

  it("shows an active specialist and the coordinator waiting for that task", () => {
    const taskEvents = [{
      specialty: "ownership", task_id: "ownership-task-1", attempt: 1,
      event_type: "dispatched", details: { parent_task_id: null },
    }];
    const reviewPath = buildReviewPath({
      plan: [{ specialty: "ownership", task_objective: "Reconstruct ownership.", required: true }],
      taskEvents, contributions: [], pendingCheckpoint: null,
    });

    expect(buildAgentTasks({
      reviewPath, taskEvents, pendingCheckpoint: null,
      coordinatorPhase: "running", coordinatorState: {}, stopReason: null,
    })).toMatchObject([
      {
        id: "specialist:ownership", task_id: "ownership-task-1", status: "working",
        current_summary: "Reconstruct ownership.", next_summary: "Validate the specialist contribution",
      },
      {
        id: "coordinator", status: "waiting", dependency_ids: ["ownership-task-1"],
        waiting_for: "ownership specialist", next_summary: "Assess specialist result",
      },
    ]);
  });

  it("shows analyst input on the coordinator without attributing it to a specialist", () => {
    const checkpoint = { request_id: "approval-1", request_payload: { title: "Approve search" } };
    const taskEvents = [{ specialty: "public_research", task_id: "research-task-1", attempt: 1, event_type: "validated" }];
    const reviewPath = buildReviewPath({
      plan: [{ specialty: "public_research", task_objective: "Review public records.", required: true }],
      taskEvents,
      contributions: [{ specialty: "public_research", task_id: "research-task-1", status: "completed", payload: {} }],
      pendingCheckpoint: checkpoint,
    });

    const tasks = buildAgentTasks({
      reviewPath, taskEvents, pendingCheckpoint: checkpoint,
      coordinatorPhase: "waiting_for_human", coordinatorState: {}, stopReason: null,
    });
    expect(tasks[0]).toMatchObject({
      id: "coordinator", status: "input_required",
      dependency_ids: ["checkpoint:approval-1"], waiting_for: "Analyst response",
    });
    expect(tasks[1]).toMatchObject({ id: "specialist:public_research", status: "completed" });
  });

  it("shows an analyst's escalation as a finished outcome, not a coordinator failure", () => {
    const tasks = buildAgentTasks({
      reviewPath: buildReviewPath({ plan: [], taskEvents: [], contributions: [], pendingCheckpoint: null }),
      taskEvents: [], pendingCheckpoint: null, coordinatorPhase: "stopped",
      coordinatorState: { last_checkpoint_result: { checkpoint_kind: "conflict_review", action: "escalate" } },
      stopReason: "Human checkpoint search-recovery resolved as escalated",
    });
    expect(tasks.find((task) => task.id === "coordinator")).toMatchObject({
      status: "completed", completed_summary: "Escalated for enhanced review", failure_reason: null,
    });
  });

  it("shows Entity and Ownership working at the same time under one dispatch", () => {
    const plan = ["entity", "ownership"].map((specialty) => ({
      specialty, task_objective: `Assess ${specialty}.`, required: true,
    }));
    const coordinatorState = {
      next_action: { next_action: "dispatch_specialists", target_specialties: ["entity", "ownership"] },
    };
    const before = buildAgentTasks({
      reviewPath: buildReviewPath({ plan, taskEvents: [], contributions: [], pendingCheckpoint: null }),
      taskEvents: [], pendingCheckpoint: null, coordinatorPhase: "running", coordinatorState, stopReason: null,
    });
    expect(before.find((task) => task.id === "coordinator")?.current_summary)
      .toBe("Dispatching entity and ownership specialists");

    const taskEvents = ["entity", "ownership"].map((specialty) => ({
      specialty, task_id: `${specialty}-task`, attempt: 1, event_type: "dispatched",
    }));
    const during = buildAgentTasks({
      reviewPath: buildReviewPath({ plan, taskEvents, contributions: [], pendingCheckpoint: null }),
      taskEvents, pendingCheckpoint: null, coordinatorPhase: "running", coordinatorState, stopReason: null,
    });
    expect(during.filter((task) => task.status === "working").map((task) => task.id))
      .toEqual(["specialist:entity", "specialist:ownership"]);
    expect(during.find((task) => task.id === "coordinator")).toMatchObject({
      status: "waiting", waiting_for: "entity specialist, ownership specialist",
    });
  });

  it("keeps retry lineage and shows the current attempt status", () => {
    const taskEvents = [
      { specialty: "entity", task_id: "old-task", attempt: 1, event_type: "failed" },
      { specialty: "entity", task_id: "retry-task", attempt: 2, event_type: "dispatched", details: { parent_task_id: "old-task" } },
    ];
    const reviewPath = buildReviewPath({
      plan: [{ specialty: "entity", task_objective: "Compare identity.", required: true }],
      taskEvents, contributions: [], pendingCheckpoint: null,
    });
    const tasks = buildAgentTasks({
      reviewPath, taskEvents, pendingCheckpoint: null,
      coordinatorPhase: "running", coordinatorState: {}, stopReason: null,
    });
    expect(tasks[0]).toMatchObject({
      id: "specialist:entity", task_id: "retry-task", attempt: 2,
      status: "working", parent_task_id: "old-task", dependency_ids: [],
    });
  });

  it("uses authored text only for fields backed by the recorded task state", () => {
    const taskEvents = [{
      specialty: "entity", task_id: "entity-task", attempt: 1, event_type: "dispatched",
    }];
    const reviewPath = buildReviewPath({
      plan: [{ specialty: "entity", task_objective: "Compare legal identity.", required: true }],
      taskEvents, contributions: [], pendingCheckpoint: null,
    });
    const tasks = buildAgentTasks({
      reviewPath, taskEvents, pendingCheckpoint: null,
      coordinatorPhase: "running", coordinatorState: {}, stopReason: null,
      currentIteration: 2,
      activityUpdates: [{
        subject_key: "specialist:entity", iteration_no: 2,
        payload: {
          completed_summary: "Verified all identity records",
          current_summary: "Comparing the registered address",
          waiting_for: "Analyst response",
          next_summary: "Validate cited identity fields",
        },
      }],
    });
    expect(tasks[0]).toMatchObject({
      status: "working", current_summary: "Comparing the registered address",
      completed_summary: null, waiting_for: null,
      next_summary: "Validate cited identity fields",
    });
  });

  it("does not reuse an earlier attempt's authored result on a later task", () => {
    const taskEvents = [{
      specialty: "entity", task_id: "new-task", attempt: 2, event_type: "validated",
    }];
    const reviewPath = buildReviewPath({
      plan: [{ specialty: "entity", task_objective: "Compare identity.", required: true }],
      taskEvents,
      contributions: [{ specialty: "entity", task_id: "new-task", status: "completed", payload: { reconciliations: [{}] } }],
      pendingCheckpoint: null,
    });
    const tasks = buildAgentTasks({
      reviewPath, taskEvents, pendingCheckpoint: null,
      coordinatorPhase: "ready_for_review", coordinatorState: {}, stopReason: null,
      currentIteration: 3,
      activityUpdates: [{
        subject_key: "specialist:entity", iteration_no: 1,
        payload: { task_id: "old-task", completed_summary: "Earlier identity result" },
      }],
    });
    expect(tasks.find((task) => task.id === "specialist:entity")?.completed_summary)
      .toBe("1 identity field assessed");
  });
});
