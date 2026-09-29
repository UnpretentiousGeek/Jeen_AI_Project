import { z } from "zod";

const identifierSchema = z.string().trim().min(1);
const uuidSchema = z.uuid();
const hashSchema = z.string().regex(/^[0-9a-f]{64}$/);

const displayTextSchema = z.string()
  .trim()
  .min(1)
  .max(4_000)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), {
    message: "display text must not contain control characters",
  });

const checkpointKindSchema = z.enum([
  "information_request",
  "conflict_review",
  "specialist_recovery",
  "search_execution_approval",
  "web_result_review",
  "analyst_approval",
]);

const actionSchema = z.enum([
  "submit_clarification",
  "continue_without_evidence",
  "escalate",
  "retry",
  "abort",
  "approve",
  "changes_requested",
  "reject",
  "accept",
  "skip_for_now",
]);

const actionSets = {
  information_request: ["submit_clarification", "reject", "skip_for_now"],
  conflict_review: ["continue_without_evidence", "escalate", "reject", "skip_for_now"],
  specialist_recovery: ["retry", "abort", "skip_for_now"],
  search_execution_approval: ["approve", "changes_requested", "reject", "skip_for_now"],
  web_result_review: ["accept", "reject", "skip_for_now"],
  analyst_approval: ["approve", "changes_requested", "reject", "skip_for_now"],
} as const;

// Agent-authored answer options. `multiple` allows several choices; `allow_custom: false`
// restricts the answer to the listed choices (it defaults to allowing free text).
const answerOptionsShape = {
  multiple: z.boolean().optional(),
  allow_custom: z.boolean().optional(),
};

function hasValidAnswerOptions(value: { choices?: string[] | undefined; allow_custom?: boolean | undefined }): boolean {
  if (value.allow_custom === false && !value.choices?.length) return false;
  return !value.choices || new Set(value.choices).size === value.choices.length;
}

const answerOptionsMessage = "choices must be unique, and allow_custom: false requires choices";

const choiceDetailSchema = z.object({
  choice: displayTextSchema,
  // The applicant stated this value on the case form.
  declared: z.boolean().optional(),
  sources: z.array(z.object({
    // Where the source is (file and page), and the specialist citation that pins it.
    label: displayTextSchema.optional(),
    citation_id: identifierSchema.nullable().optional(),
    as_of: z.string().nullable(),
    excerpt: z.string().nullable(),
  }).strict()),
}).strict();

const questionPayloadSchema = z.object({
  question: displayTextSchema,
  choices: z.array(displayTextSchema).min(1),
  ...answerOptionsShape,
}).strict().refine(hasValidAnswerOptions, answerOptionsMessage);

const structuredInformationPayloadSchema = z.object({
  question: displayTextSchema,
  questions: z.array(z.object({
    id: identifierSchema,
    specialty: z.enum(["entity", "ownership"]),
    field: identifierSchema,
    // The ownership anomaly a question resolves, e.g. "Owner -> Owned", so answers can be shown beside it.
    subject: displayTextSchema.optional(),
    question: displayTextSchema,
    choices: z.array(displayTextSchema).min(1).optional(),
    // Where each choice comes from: the date it applied and the exact quote, so the analyst
    // can decide without opening the document. `suggested_choice` must be one of `choices`.
    choice_details: z.array(choiceDetailSchema).min(1).optional(),
    suggested_choice: displayTextSchema.optional(),
    suggestion_reason: displayTextSchema.optional(),
    ...answerOptionsShape,
  }).strict().refine(hasValidAnswerOptions, answerOptionsMessage)
    .refine((question) => !question.suggested_choice || question.choices?.includes(question.suggested_choice),
      "suggested_choice must be one of choices")
    .refine((question) => !question.choice_details
      || question.choice_details.every((detail) => question.choices?.includes(detail.choice)),
      "choice_details must describe listed choices")).min(1),
}).strict().refine((value) => new Set(value.questions.map((question) => question.id)).size === value.questions.length,
  "question IDs must be unique");

const approvedScopeSchema = z.object({
  evidence_gap_id: uuidSchema,
  claim_id: identifierSchema,
  claim: displayTextSchema,
  query: displayTextSchema,
  allowed_domains: z.array(identifierSchema).min(1),
  disclosed_applicant_fields: z.array(identifierSchema).min(1),
  result_limit: z.number().int().min(1).max(10),
  rationale: displayTextSchema,
}).strict();

const approvedSearchPayloadSchema = z.object({
  approved_scope: approvedScopeSchema,
  scope_hash: hashSchema,
}).strict();

const webResultSummarySchema = z.object({
  result_id: uuidSchema,
  url: z.url(),
  title: displayTextSchema,
  publisher: displayTextSchema,
  checksum: z.string().regex(/^sha256:[0-9a-f]{64}$/),
}).strict();

const webResultSummaryContentHashSchema = z.object({
  result_id: uuidSchema,
  url: z.url(),
  title: displayTextSchema,
  publisher: displayTextSchema,
  content_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
}).strict();

const webResultSummaryWebIdSchema = z.object({
  web_result_id: uuidSchema,
  url: z.url(),
  title: displayTextSchema,
  publisher: displayTextSchema,
  checksum: z.string().regex(/^sha256:[0-9a-f]{64}$/),
}).strict();

const webResultReviewPayloadSchema = z.object({
  pending_results: z.array(z.union([
    webResultSummarySchema,
    webResultSummaryContentHashSchema,
    webResultSummaryWebIdSchema,
  ])).min(1),
}).strict();

const webResultReviewResultsPayloadSchema = z.object({
  results: z.array(z.union([
    webResultSummarySchema,
    webResultSummaryContentHashSchema,
    webResultSummaryWebIdSchema,
  ])).min(1),
}).strict();

const proposalSchema = z.object({
  action_type: z.literal("mark_ready_for_review"),
  summary: displayTextSchema,
}).strict();

const analystApprovalPayloadSchema = z.object({
  proposal: proposalSchema,
  proposal_hash: hashSchema,
}).strict();

const proposedActionApprovalPayloadSchema = z.object({
  proposed_action: proposalSchema,
  proposal_hash: hashSchema,
}).strict();

const requestBaseShape = {
  schema_version: z.literal("1.0"),
  checkpoint_id: uuidSchema,
  request_id: identifierSchema,
  checkpoint_version: z.number().int().min(1),
  expected_state_version: z.number().int().min(0),
  parent_checkpoint_id: uuidSchema.nullable(),
  parent_request_id: identifierSchema.nullable(),
  originating_task_id: identifierSchema.nullable(),
  originating_context_id: identifierSchema.nullable(),
  title: displayTextSchema,
  explanation: displayTextSchema,
  expires_at: z.iso.datetime(),
};

const informationRequestSchema = z.object({
  ...requestBaseShape,
  checkpoint_kind: z.literal("information_request"),
  allowed_actions: z.array(z.enum(actionSets.information_request)).min(1),
  payload: z.union([questionPayloadSchema, structuredInformationPayloadSchema]),
}).strict();

const conflictReviewSchema = z.object({
  ...requestBaseShape,
  checkpoint_kind: z.literal("conflict_review"),
  allowed_actions: z.array(z.enum(actionSets.conflict_review)).min(1),
  payload: questionPayloadSchema,
}).strict();

const specialistRecoverySchema = z.object({
  ...requestBaseShape,
  checkpoint_kind: z.literal("specialist_recovery"),
  allowed_actions: z.array(z.enum(actionSets.specialist_recovery)).min(1),
  payload: questionPayloadSchema,
}).strict();

const searchExecutionApprovalSchema = z.object({
  ...requestBaseShape,
  checkpoint_kind: z.literal("search_execution_approval"),
  allowed_actions: z.array(z.enum(actionSets.search_execution_approval)).min(1),
  payload: approvedSearchPayloadSchema,
}).strict();

const webResultReviewSchema = z.object({
  ...requestBaseShape,
  checkpoint_kind: z.literal("web_result_review"),
  allowed_actions: z.array(z.enum(actionSets.web_result_review)).min(1),
  payload: z.union([webResultReviewPayloadSchema, webResultReviewResultsPayloadSchema]),
}).strict();

const analystApprovalSchema = z.object({
  ...requestBaseShape,
  checkpoint_kind: z.literal("analyst_approval"),
  allowed_actions: z.array(z.enum(actionSets.analyst_approval)).min(1),
  payload: z.union([analystApprovalPayloadSchema, proposedActionApprovalPayloadSchema]),
}).strict();

const requestUnionSchema = z.discriminatedUnion("checkpoint_kind", [
  informationRequestSchema,
  conflictReviewSchema,
  specialistRecoverySchema,
  searchExecutionApprovalSchema,
  webResultReviewSchema,
  analystApprovalSchema,
]);

function expectedActions(kind: z.infer<typeof checkpointKindSchema>): readonly string[] {
  return actionSets[kind];
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length
    && left.every((value) => right.includes(value));
}

export const coordinatorCheckpointRequestSchema = requestUnionSchema.superRefine((request, context) => {
  const expected = expectedActions(request.checkpoint_kind);
  if (!sameSet(request.allowed_actions, expected)) {
    context.addIssue({
      code: "custom",
      path: ["allowed_actions"],
      message: `allowed_actions must be exactly the actions for ${request.checkpoint_kind}`,
    });
  }

  const isRootVersion = request.checkpoint_version === 1;
  if (isRootVersion && (request.parent_checkpoint_id !== null || request.parent_request_id !== null)) {
    context.addIssue({
      code: "custom",
      path: ["checkpoint_version"],
      message: "checkpoint version 1 cannot have parent checkpoint lineage",
    });
  }
  if (!isRootVersion && (request.parent_checkpoint_id === null || request.parent_request_id === null)) {
    context.addIssue({
      code: "custom",
      path: ["parent_checkpoint_id"],
      message: "revised checkpoints require parent checkpoint and request lineage",
    });
  }
  if (request.checkpoint_kind === "web_result_review") {
    const pendingResults = "pending_results" in request.payload
      ? request.payload.pending_results
      : request.payload.results;
    const resultIds = pendingResults.map((result) => "result_id" in result ? result.result_id : result.web_result_id);
    if (new Set(resultIds).size !== resultIds.length) {
      context.addIssue({
        code: "custom",
        path: ["payload"],
        message: "web result review pending result IDs must be unique",
      });
    }
  }
});

export type CoordinatorCheckpointRequest = z.infer<typeof coordinatorCheckpointRequestSchema>;

const responsePayloadSchema = z.record(z.string(), z.unknown());

export const coordinatorCheckpointDecisionSchema = z.object({
  schema_version: z.literal("1.0"),
  request_id: identifierSchema,
  checkpoint_id: uuidSchema,
  checkpoint_version: z.number().int().min(1),
  expected_state_version: z.number().int().min(0),
  action: actionSchema,
  response_payload: responsePayloadSchema,
  authenticated_actor_id: identifierSchema,
  idempotency_key: identifierSchema,
  decided_at: z.iso.datetime(),
}).strict();

export type CoordinatorCheckpointDecision = z.infer<typeof coordinatorCheckpointDecisionSchema>;

export type CoordinatorCheckpointRouteResult =
  | { route: "pending"; transition: false }
  | { route: "analyst_revision"; requested_changes: Record<string, unknown> }
  | { route: "request_revised_search"; evidence_gap_id: string; original_scope_hash: string; requested_changes: Record<string, unknown> }
  | { route: "execute_search"; scope_hash: string }
  | { route: "continue_without_search"; evidence_gap_id: string; claim_id: string; claim: string }
  | { route: "execute_action"; proposal_hash: string }
  | { route: "release_web_results"; accepted_result_ids: string[]; rejected_result_ids: string[]; result_decisions: Array<{ result_id: string; decision: "accept" | "reject"; rationale: string }> }
  | { route: "resume_information"; response_payload: Record<string, unknown> }
  | { route: "escalated" | "stopped" | "failed" }
  | { route: "continue_without_evidence" };

function requireAllowedAction(
  request: CoordinatorCheckpointRequest,
  decision: CoordinatorCheckpointDecision,
): void {
  if (!request.allowed_actions.includes(decision.action as never)) {
    throw new Error("checkpoint decision action is not allowed");
  }
  if (request.request_id !== decision.request_id || request.checkpoint_id !== decision.checkpoint_id
    || request.checkpoint_version !== decision.checkpoint_version
    || request.expected_state_version !== decision.expected_state_version) {
    throw new Error("checkpoint decision does not match the pending checkpoint version");
  }
}

function requireEmptyResponsePayload(payload: Record<string, unknown>): void {
  if (Object.keys(payload).length !== 0) {
    throw new Error("skip_for_now requires an empty response_payload");
  }
}

function requireHash(payload: Record<string, unknown>, key: "scope_hash" | "proposal_hash", expected: string): void {
  if (payload[key] !== expected) {
    throw new Error(`${key} was altered`);
  }
}

function webReviewResult(
  request: Extract<CoordinatorCheckpointRequest, { checkpoint_kind: "web_result_review" }>,
  decision: CoordinatorCheckpointDecision,
): CoordinatorCheckpointRouteResult {
  const raw = decision.response_payload.result_decisions;
  if (!Array.isArray(raw)) {
    throw new Error("web result review requires result_decisions");
  }
  const pendingResults = "pending_results" in request.payload
    ? request.payload.pending_results
    : request.payload.results;
  const pending = pendingResults.map((result) => "result_id" in result ? result.result_id : result.web_result_id);
  const seen = new Set<string>();
  const decisions: Array<{ result_id: string; decision: "accept" | "reject"; rationale: string }> = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("each web result decision must be an object");
    }
    const candidate = item as Record<string, unknown>;
    const resultId = candidate.result_id ?? candidate.web_result_id;
    const action = candidate.decision;
    const rationale = candidate.rationale;
    if (typeof resultId !== "string" || seen.has(resultId)
      || (action !== "accept" && action !== "reject")
      || typeof rationale !== "string" || rationale.trim().length === 0
      || (candidate.result_id !== undefined && candidate.web_result_id !== undefined)
      || Object.keys(candidate).some((key) => !["result_id", "web_result_id", "decision", "rationale"].includes(key))) {
      throw new Error("web result review requires exactly one decision and rationale per result");
    }
    seen.add(resultId);
    decisions.push({ result_id: resultId, decision: action, rationale: rationale.trim() });
  }
  if (seen.size !== pending.length || pending.some((resultId) => !seen.has(resultId))) {
    throw new Error("web result review requires exactly one decision for every pending result");
  }
  const ordered = decisions.sort((left, right) => left.result_id.localeCompare(right.result_id));
  return {
    route: "release_web_results",
    accepted_result_ids: ordered.filter((item) => item.decision === "accept").map((item) => item.result_id),
    rejected_result_ids: ordered.filter((item) => item.decision === "reject").map((item) => item.result_id),
    result_decisions: ordered,
  };
}

export function parseCoordinatorCheckpointRequest(input: unknown): CoordinatorCheckpointRequest {
  return coordinatorCheckpointRequestSchema.parse(input);
}

export function parseCoordinatorCheckpointDecision(input: unknown): CoordinatorCheckpointDecision {
  return coordinatorCheckpointDecisionSchema.parse(input);
}

export function routeCoordinatorCheckpointDecision(
  requestInput: unknown,
  decisionInput: unknown,
): CoordinatorCheckpointRouteResult {
  const request = parseCoordinatorCheckpointRequest(requestInput);
  const decision = parseCoordinatorCheckpointDecision(decisionInput);
  requireAllowedAction(request, decision);
  const payload = decision.response_payload;

  if (decision.action === "skip_for_now") {
    requireEmptyResponsePayload(payload);
    return { route: "pending", transition: false };
  }

  if (decision.action === "changes_requested") {
    if (request.checkpoint_kind !== "search_execution_approval" && request.checkpoint_kind !== "analyst_approval") {
      throw new Error("changes_requested is unsupported for this checkpoint");
    }
    const requestedChanges = payload.requested_changes;
    if (typeof requestedChanges !== "object" || requestedChanges === null || Array.isArray(requestedChanges)
      || Object.keys(requestedChanges).length === 0) {
      throw new Error("changes_requested requires a structured requested_changes payload");
    }
    if (Object.keys(payload).some((key) => key !== "requested_changes")) {
      throw new Error("changes_requested response_payload has unknown fields");
    }
    if (request.checkpoint_kind === "search_execution_approval") {
      return {
        route: "request_revised_search",
        evidence_gap_id: request.payload.approved_scope.evidence_gap_id,
        original_scope_hash: request.payload.scope_hash,
        requested_changes: requestedChanges as Record<string, unknown>,
      };
    }
    // The coordinator reads the request and may draft bounded research.
    return { route: "analyst_revision", requested_changes: requestedChanges as Record<string, unknown> };
  }

  if (request.checkpoint_kind === "search_execution_approval" && decision.action === "approve") {
    if (Object.keys(payload).some((key) => key !== "scope_hash")) {
      throw new Error("search approval response_payload has unknown fields");
    }
    requireHash(payload, "scope_hash", request.payload.scope_hash);
    return { route: "execute_search", scope_hash: request.payload.scope_hash };
  }

  if (request.checkpoint_kind === "search_execution_approval" && decision.action === "reject") {
    const scope = request.payload.approved_scope;
    return {
      route: "continue_without_search",
      evidence_gap_id: scope.evidence_gap_id,
      claim_id: scope.claim_id,
      claim: scope.claim,
    };
  }

  if (request.checkpoint_kind === "analyst_approval" && decision.action === "approve") {
    if (Object.keys(payload).some((key) => key !== "proposal_hash")) {
      throw new Error("analyst approval response_payload has unknown fields");
    }
    requireHash(payload, "proposal_hash", request.payload.proposal_hash);
    return { route: "execute_action", proposal_hash: request.payload.proposal_hash };
  }

  if (request.checkpoint_kind === "web_result_review"
    && (decision.action === "accept" || decision.action === "reject")) {
    return webReviewResult(request, decision);
  }

  if (request.checkpoint_kind === "information_request" && decision.action === "submit_clarification") {
    return { route: "resume_information", response_payload: payload };
  }
  if (request.checkpoint_kind === "conflict_review" && decision.action === "continue_without_evidence") {
    return { route: "continue_without_evidence" };
  }
  if (request.checkpoint_kind === "conflict_review" && decision.action === "escalate") {
    return { route: "escalated" };
  }
  if (request.checkpoint_kind === "specialist_recovery" && decision.action === "retry") {
    return { route: "resume_information", response_payload: payload };
  }
  if (decision.action === "reject" || decision.action === "abort") {
    return { route: request.checkpoint_kind === "specialist_recovery" ? "failed" : "stopped" };
  }

  throw new Error("checkpoint decision has no deterministic route");
}

export const coordinatorCheckpointSchema = coordinatorCheckpointRequestSchema;
export const coordinatorCheckpointRequestV3Schema = coordinatorCheckpointRequestSchema;
export const coordinatorCheckpointDecisionV3Schema = coordinatorCheckpointDecisionSchema;
export const checkpointRequestSchema = coordinatorCheckpointRequestSchema;
export const checkpointDecisionSchema = coordinatorCheckpointDecisionSchema;
export const parseCheckpointRequest = parseCoordinatorCheckpointRequest;
export const parseCheckpointDecision = parseCoordinatorCheckpointDecision;
export const routeCheckpointDecision = routeCoordinatorCheckpointDecision;
