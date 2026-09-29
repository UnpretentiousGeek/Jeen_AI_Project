type Row = Record<string, unknown>;

export type ReviewPathStep = {
  id: string;
  kind: "specialist" | "checkpoint";
  label: string;
  specialty: string | null;
  required: boolean;
  status: "planned" | "working" | "completed" | "failed" | "input_required";
  summary: string;
  result_summary: string | null;
  counts: Record<string, number>;
  waiting_on: string | null;
  next_action: string | null;
};

export type ReviewPath = {
  completed_steps: number;
  total_steps: number;
  steps: ReviewPathStep[];
};

const specialistLabels: Record<string, string> = {
  entity: "Verify company identity",
  ownership: "Check beneficial owners",
  policy: "Compare policy controls",
  public_research: "Review public records",
};

function record(value: unknown): Row | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
}

function nonempty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function contributionCounts(specialty: string, payload: Row | null): Record<string, number> {
  if (!payload) return {};
  if (specialty === "entity" && Array.isArray(payload.reconciliations)) {
    return { fields_assessed: payload.reconciliations.length };
  }
  if (specialty === "ownership") {
    return {
      ...(Array.isArray(payload.relationships) ? { relationships: payload.relationships.length } : {}),
      ...(Array.isArray(payload.anomalies) ? { anomalies: payload.anomalies.length } : {}),
    };
  }
  if (specialty === "policy" && Array.isArray(payload.requirement_evidence_matrix)) {
    return { requirements_assessed: payload.requirement_evidence_matrix.length };
  }
  return {};
}

function completedSummary(specialty: string, status: string, counts: Record<string, number>): string {
  const count = specialty === "entity" ? counts.fields_assessed
    : specialty === "ownership" ? counts.relationships
      : specialty === "policy" ? counts.requirements_assessed : undefined;
  const noun = specialty === "entity" ? (count === 1 ? "identity field" : "identity fields")
    : specialty === "ownership" ? (count === 1 ? "ownership relationship" : "ownership relationships")
      : specialty === "policy" ? (count === 1 ? "policy requirement" : "policy requirements") : "public research results";
  const detail = count === undefined ? "Specialist contribution validated" : `${count} ${noun} assessed`;
  return status === "partial" ? `${detail}; evidence is incomplete` : detail;
}

export function buildReviewPath(input: {
  plan: unknown;
  taskEvents: Row[];
  contributions: Row[];
  pendingCheckpoint: Row | null;
  workflowFailed?: boolean;
}): ReviewPath | null {
  const plan = Array.isArray(input.plan) ? input.plan : [];
  const steps: ReviewPathStep[] = [];

  for (const raw of plan) {
    const item = record(raw);
    const specialty = nonempty(item?.specialty);
    if (!specialty || !specialistLabels[specialty]) continue;
    const events = input.taskEvents.filter((event) => event.specialty === specialty);
    const latestAttempt = Math.max(0, ...events.map((event) => Number(event.attempt) || 0));
    const attemptEvents = events.filter((event) => Number(event.attempt) === latestAttempt);
    const validated = [...attemptEvents].reverse().find((event) => event.event_type === "validated");
    const failed = attemptEvents.some((event) => event.event_type === "failed");
    const contribution = validated && [...input.contributions].reverse().find((value) =>
      value.specialty === specialty && value.task_id === validated.task_id
      && (value.status === "completed" || value.status === "partial"));
    const status: ReviewPathStep["status"] = contribution ? "completed"
      : failed || (input.workflowFailed && attemptEvents.length > 0) ? "failed"
        : attemptEvents.length ? "working" : "planned";
    const counts = contribution ? contributionCounts(specialty, record(contribution.payload)) : {};
    const resultSummary = contribution ? completedSummary(specialty, String(contribution.status), counts) : null;
    steps.push({
      id: `specialist:${specialty}`,
      kind: "specialist",
      label: specialistLabels[specialty],
      specialty,
      required: item?.required !== false,
      status,
      summary: resultSummary ?? (status === "failed" ? "Specialist work failed"
        : nonempty(item?.task_objective) ?? (status === "working" ? "Specialist is working" : "Waiting to start")),
      result_summary: resultSummary,
      counts,
      waiting_on: status === "working" ? specialty : null,
      next_action: status === "failed" ? "Review specialist failure"
        : status === "planned" ? "Wait for coordinator dispatch" : null,
    });
  }

  const checkpoint = input.pendingCheckpoint;
  const requestId = nonempty(checkpoint?.request_id);
  if (requestId) {
    const request = record(checkpoint?.request_payload);
    steps.push({
      id: `checkpoint:${requestId}`,
      kind: "checkpoint",
      label: nonempty(request?.title) ?? "Provide analyst input",
      specialty: null,
      required: true,
      status: "input_required",
      summary: nonempty(request?.explanation) ?? "Waiting for analyst response",
      result_summary: null,
      counts: {},
      waiting_on: "analyst",
      next_action: "Respond to checkpoint",
    });
  }

  if (steps.length === 0) return null;
  return {
    completed_steps: steps.filter((step) => step.status === "completed").length,
    total_steps: steps.length,
    steps,
  };
}
