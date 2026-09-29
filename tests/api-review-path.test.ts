import { describe, expect, it } from "vitest";

import { buildReviewPath } from "../src/api/review-path.js";

const plan = [
  { specialty: "entity", required: true, task_objective: "Compare registered identity." },
  { specialty: "ownership", required: true, task_objective: "Reconstruct ownership." },
  { specialty: "policy", required: true, task_objective: "Assess policy requirements." },
];

describe("review path", () => {
  it("counts validated specialist work and a pending analyst checkpoint", () => {
    const taskEvents = plan.map((item) => ({
      specialty: item.specialty, task_id: `task-${item.specialty}`,
      attempt: 1, event_type: "validated",
    }));
    const contributions = [
      { specialty: "entity", task_id: "task-entity", status: "completed", payload: { reconciliations: [{}, {}] } },
      { specialty: "ownership", task_id: "task-ownership", status: "partial", payload: { relationships: [{}], anomalies: [{}] } },
      { specialty: "policy", task_id: "task-policy", status: "completed", payload: { requirement_evidence_matrix: [{}, {}, {}] } },
    ];
    const result = buildReviewPath({
      plan, taskEvents, contributions,
      pendingCheckpoint: {
        request_id: "answer-ownership",
        request_payload: { title: "Provide agent input", explanation: "Clarify the ownership evidence." },
      },
    });

    expect(result).toMatchObject({ completed_steps: 3, total_steps: 4 });
    expect(result?.steps.map((step) => step.status)).toEqual([
      "completed", "completed", "completed", "input_required",
    ]);
    expect(result?.steps[1]).toMatchObject({
      label: "Check beneficial owners", counts: { relationships: 1, anomalies: 1 },
      result_summary: "1 ownership relationship assessed; evidence is incomplete",
    });
  });

  it("shows a retry as working instead of counting a prior failed attempt", () => {
    const result = buildReviewPath({
      plan: [plan[0]],
      taskEvents: [
        { specialty: "entity", task_id: "first", attempt: 1, event_type: "failed" },
        { specialty: "entity", task_id: "retry", attempt: 2, event_type: "dispatched" },
      ],
      contributions: [],
      pendingCheckpoint: null,
    });

    expect(result).toMatchObject({ completed_steps: 0, total_steps: 1 });
    expect(result?.steps[0]).toMatchObject({ status: "working", waiting_on: "entity" });
  });

  it("shows an unfinished dispatched specialist as failed when its workflow job fails", () => {
    const result = buildReviewPath({
      plan: [plan[0]],
      taskEvents: [{ specialty: "entity", task_id: "entity-task", attempt: 1, event_type: "dispatched" }],
      contributions: [], pendingCheckpoint: null, workflowFailed: true,
    });

    expect(result?.steps[0]).toMatchObject({ status: "failed", next_action: "Review specialist failure" });
  });

  it("does not invent a review path before the coordinator creates one", () => {
    expect(buildReviewPath({ plan: null, taskEvents: [], contributions: [], pendingCheckpoint: null })).toBeNull();
  });
});
