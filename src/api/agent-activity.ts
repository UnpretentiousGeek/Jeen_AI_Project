import type { ReviewPath } from "./review-path.ts";

type Row = Record<string, unknown>;

export type AgentTask = {
  id: string;
  task_id: string | null;
  parent_task_id: string | null;
  role: "specialist" | "coordinator";
  specialty: string | null;
  label: string;
  status: "queued" | "working" | "waiting" | "input_required" | "completed" | "failed";
  attempt: number | null;
  dependency_ids: string[];
  current_summary: string | null;
  completed_summary: string | null;
  waiting_for: string | null;
  next_summary: string | null;
  failure_reason: string | null;
};

function record(value: unknown): Row | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function latestAttempt(events: Row[]): { events: Row[]; taskId: string | null; attempt: number | null } {
  if (events.length === 0) return { events: [], taskId: null, attempt: null };
  const attempt = Math.max(...events.map((event) => Number(event.attempt) || 0));
  const selected = events.filter((event) => Number(event.attempt) === attempt);
  return {
    events: selected,
    taskId: text(selected.at(-1)?.task_id),
    attempt: attempt || null,
  };
}

const urgency: Record<AgentTask["status"], number> = {
  input_required: 0,
  failed: 1,
  working: 2,
  waiting: 3,
  queued: 4,
  completed: 5,
};

export function buildAgentTasks(input: {
  reviewPath: ReviewPath | null;
  taskEvents: Row[];
  pendingCheckpoint: Row | null;
  coordinatorPhase: unknown;
  coordinatorState: unknown;
  stopReason: unknown;
  workflowFailureReason?: unknown;
  currentIteration?: unknown;
  activityUpdates?: Row[];
}): AgentTask[] {
  const steps = input.reviewPath?.steps.filter((step) => step.kind === "specialist") ?? [];
  const failureReason = text(input.workflowFailureReason);
  const lastDispatch = [...input.taskEvents].reverse().find((event) => event.event_type === "dispatched");
  const tasks: AgentTask[] = steps.map((step) => {
    const specialty = step.specialty!;
    const attempt = latestAttempt(input.taskEvents.filter((event) => event.specialty === specialty));
    const dispatched = attempt.events.find((event) => event.event_type === "dispatched");
    const details = record(dispatched?.details);
    const parentTaskId = text(details?.parent_task_id);
    const status = step.status === "planned" ? "queued" : step.status;
    return {
      id: step.id,
      task_id: attempt.taskId,
      parent_task_id: parentTaskId,
      role: "specialist",
      specialty,
      label: `${specialty.replaceAll("_", " ")} specialist`,
      status,
      attempt: attempt.attempt,
      dependency_ids: [],
      current_summary: status === "working" ? step.summary : null,
      completed_summary: status === "completed" ? step.result_summary : null,
      waiting_for: null,
      next_summary: status === "queued" ? "Wait for coordinator dispatch"
        : status === "working" ? "Validate the specialist contribution"
          : status === "failed" ? "Review failure or retry" : null,
      failure_reason: status === "failed" && attempt.taskId === text(lastDispatch?.task_id)
        && !attempt.events.some((event) => event.event_type === "failed" || event.event_type === "validated")
        ? failureReason : null,
    };
  });

  const phase = text(input.coordinatorPhase);
  const state = record(input.coordinatorState);
  const nextAction = record(state?.next_action);
  const pendingRequestId = text(input.pendingCheckpoint?.request_id);
  const active = tasks.filter((task) => task.status === "working" && task.task_id);
  const completedCount = tasks.filter((task) => task.status === "completed").length;
  // An analyst's escalation stops the run on purpose; it is an outcome, not a failure.
  const escalated = phase === "stopped" && text(record(state?.last_checkpoint_result)?.action) === "escalate";
  const coordinatorStatus: AgentTask["status"] = pendingRequestId ? "input_required"
    : phase === "ready_for_review" || phase === "finalized" || escalated ? "completed"
      : phase === "stopped" ? "failed"
        : !phase ? "queued" : active.length ? "waiting" : "working";
  const targets = Array.isArray(nextAction?.target_specialties)
    ? nextAction.target_specialties.flatMap((item) => text(item) ?? [])
    : [text(nextAction?.target_specialty)].flatMap((item) => item ?? []);
  const dispatching = targets.length
    ? `${targets.map((item) => item.replaceAll("_", " ")).join(" and ")} specialist${targets.length > 1 ? "s" : ""}`
    : null;
  tasks.push({
    id: "coordinator",
    task_id: null,
    parent_task_id: null,
    role: "coordinator",
    specialty: null,
    label: "Review coordinator",
    status: coordinatorStatus,
    attempt: null,
    dependency_ids: pendingRequestId ? [`checkpoint:${pendingRequestId}`]
      : active.flatMap((task) => task.task_id ? [task.task_id] : []),
    current_summary: coordinatorStatus === "working"
      ? (dispatching ? `Dispatching ${dispatching}` : "Coordinating case review")
      : null,
    completed_summary: coordinatorStatus === "completed"
      ? (phase === "ready_for_review" ? "Analysis ready for review"
        : escalated ? "Escalated for enhanced review" : "Coordinator work completed")
      : completedCount ? `${completedCount} specialist contribution${completedCount === 1 ? "" : "s"} validated` : null,
    waiting_for: coordinatorStatus === "input_required" ? "Analyst response"
      : coordinatorStatus === "waiting" ? active.map((task) => task.label).join(", ") : null,
    next_summary: coordinatorStatus === "input_required" ? "Resume after analyst response"
      : coordinatorStatus === "waiting" ? "Assess specialist result"
        : coordinatorStatus === "queued" ? "Start analysis"
          : coordinatorStatus === "failed" ? text(input.stopReason) ?? "Review the stopped run" : null,
    failure_reason: coordinatorStatus === "failed" ? failureReason : null,
  });

  const copies = new Map<string, Array<{ payload: Row; iteration: number }>>();
  for (const update of input.activityUpdates ?? []) {
    const subject = text(update.subject_key);
    const payload = record(update.payload);
    if (subject && payload) {
      const entries = copies.get(subject) ?? [];
      entries.push({ payload, iteration: Number(update.iteration_no) || 0 });
      copies.set(subject, entries);
    }
  }
  const currentIteration = Number(input.currentIteration) || 0;
  for (const task of tasks) {
    const entries = copies.get(task.id) ?? [];
    const completedCopy = [...entries].reverse().find(({ payload, iteration }) =>
      text(payload.completed_summary)
      && (task.role === "coordinator" ? iteration === currentIteration
        : text(payload.task_id) === task.task_id));
    if (task.completed_summary && completedCopy) {
      task.completed_summary = text(completedCopy.payload.completed_summary)!;
    }
    const liveCopy = [...entries].reverse().find(({ payload, iteration }) =>
      iteration === currentIteration
      && (!text(payload.task_id) || text(payload.task_id) === task.task_id));
    if (!liveCopy || task.status === "failed") continue;
    if (task.current_summary) task.current_summary = text(liveCopy.payload.current_summary) ?? task.current_summary;
    if (task.waiting_for) task.waiting_for = text(liveCopy.payload.waiting_for) ?? task.waiting_for;
    if (task.next_summary) task.next_summary = text(liveCopy.payload.next_summary) ?? task.next_summary;
  }
  return tasks.sort((a, b) => urgency[a.status] - urgency[b.status]);
}
