import type { LangflowBackgroundJob, LangflowWorkflowStatus } from "../workflow/langflow-client.ts";
import { TERMINAL_UNSUCCESSFUL_JOB_STATUSES } from "../workflow/langflow-client.ts";
import {
  checkpointResponseSchema,
  createCaseSchema,
  archiveCaseSchema,
  entityDeclarationSchema,
  finalDecisionSchema,
  type OpenableSourceKind,
  type AnalysisRunRecord,
  shouldPollRun,
  startAnalysisSchema,
  type UploadedEvidence,
} from "./contracts.ts";
import { CASE_STATUSES_OPEN_FOR_ANALYSIS } from "../case-catalog.ts";
import type { CaseRepository } from "./repository.ts";
import { providerProfileSchema } from "../policy/applicability.ts";

type JsonObject = Record<string, unknown>;

export interface ApiWorkflowClient {
  deleteFile?(input: { flowId: string; storagePath: string }): Promise<void>;
  uploadFile?(input: {
    flowId: string;
    storagePath: string;
    filename: string;
    mimeType: string;
  }): Promise<string>;
  startBackground(input: {
    flowId: string;
    inputValue: string;
    sessionId: string;
    idempotencyKey?: string;
    tweaks?: Record<string, unknown>;
  }): Promise<LangflowBackgroundJob>;
  status(jobId: string): Promise<LangflowWorkflowStatus>;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// Checks an answer against agent-authored options: selections must come from `choices`,
// a single-choice question takes at most one, and `allow_custom: false` makes the answer
// exactly the "; "-joined selections.
function assertChoiceAnswer(
  question: Record<string, unknown>,
  answer: unknown,
  selected: unknown,
): void {
  const choices = Array.isArray(question.choices)
    ? question.choices.filter((choice): choice is string => typeof choice === "string")
    : [];
  const invalid = () => new ApiError(400, "invalid_choice_answer", "Choose from the options the coordinator provided.");
  if (selected !== undefined) {
    if (!Array.isArray(selected) || !choices.length
      || selected.some((choice) => typeof choice !== "string" || !choices.includes(choice))
      || new Set(selected).size !== selected.length
      || (question.multiple !== true && selected.length > 1)) {
      throw invalid();
    }
  }
  if (question.allow_custom === false && choices.length) {
    if (!Array.isArray(selected) || !selected.length || answer !== selected.join("; ")) {
      throw invalid();
    }
  }
}

export class CaseApiService {
  constructor(
    private readonly repository: CaseRepository,
    private readonly workflow: ApiWorkflowClient,
    private readonly config: {
      coordinatorFlowId: string;
      legacyCoordinatorFlowId?: string;
      ingestionFlowId?: string;
      ingestionFileNodeId?: string;
      ingestionGuardNodeId?: string;
      pollIntervalMs?: number;
    },
  ) {}

  getProviderProfile() {
    return this.repository.getProviderProfile();
  }

  saveProviderProfile(input: unknown) {
    return this.repository.saveProviderProfile(providerProfileSchema.parse(input));
  }

  listRuleApplicability(runId: string) {
    return this.repository.listRuleApplicability(runId);
  }

  createCase(input: unknown): Promise<JsonObject> {
    return this.repository.createCase(createCaseSchema.parse(input));
  }

  listCases(): Promise<JsonObject[]> {
    return this.repository.listCases();
  }

  async setCaseArchived(caseId: string, input: unknown, actorId: string): Promise<JsonObject> {
    const parsed = archiveCaseSchema.parse(input);
    const normalizedActorId = actorId.trim();
    if (!normalizedActorId || normalizedActorId.length > 200) {
      throw new ApiError(400, "invalid_actor", "The analyst identity must be between 1 and 200 characters.");
    }
    try {
      const result = await this.repository.setCaseArchived(caseId, parsed.archived, normalizedActorId);
      if (!result) throw new ApiError(404, "case_not_found", "Case not found.");
      return result;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof Error && error.message === "case_analysis_active") {
        throw new ApiError(409, "case_analysis_active", "Wait for the active analysis to stop before archiving this case.");
      }
      throw error;
    }
  }

  async deleteCase(caseId: string): Promise<{
    caseId: string;
    storagePaths: string[];
    cleanupWarning: string | null;
  }> {
    let deleted: Awaited<ReturnType<CaseRepository["deleteArchivedCase"]>>;
    try {
      deleted = await this.repository.deleteArchivedCase(caseId);
    } catch (error) {
      if (error instanceof Error && error.message === "case_not_archived") {
        throw new ApiError(409, "case_not_archived", "Archive this case before permanently deleting it.");
      }
      if (error instanceof Error && error.message === "case_analysis_active") {
        throw new ApiError(409, "case_analysis_active", "Wait for the active analysis to stop before deleting this case.");
      }
      throw error;
    }
    if (!deleted) throw new ApiError(404, "case_not_found", "Case not found.");

    const storagePaths = [...new Set(deleted.storage_paths)];
    let cleanupWarning: string | null = null;
    if (storagePaths.length > 0 && this.config.ingestionFlowId && this.workflow.deleteFile) {
      const results = await Promise.allSettled(storagePaths.map((storagePath) => this.workflow.deleteFile!({
        flowId: this.config.ingestionFlowId!,
        storagePath,
      })));
      if (results.some((result) => result.status === "rejected")) {
        cleanupWarning = "The case and its history were deleted, but some stored evidence could not be removed from processing storage.";
      }
    } else if (storagePaths.length > 0) {
      cleanupWarning = "The case and its history were deleted, but processing storage cleanup is not configured.";
    }

    return { caseId: deleted.case_id, storagePaths, cleanupWarning };
  }

  async getCase(caseId: string): Promise<JsonObject> {
    const selected = await this.repository.getCase(caseId);
    if (!selected) throw new ApiError(404, "case_not_found", "Case not found.");
    const run = selected.run;
    if (run && typeof run === "object" && "id" in run && typeof run.id === "string") {
      return { ...selected, run: await this.getRun(run.id) };
    }
    return selected;
  }

  async getCaseTimeline(caseId: string, limit = 50, offset = 0): Promise<JsonObject> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100
      || !Number.isInteger(offset) || offset < 0) {
      throw new ApiError(400, "invalid_pagination", "Use a limit from 1 to 100 and a non-negative offset.");
    }
    const selected = await this.repository.getCase(caseId);
    if (!selected) throw new ApiError(404, "case_not_found", "Case not found.");
    const events = await this.repository.getCaseTimeline(caseId, limit + 1, offset);
    return { events: events.slice(0, limit), has_more: events.length > limit, limit, offset };
  }

  async getDocumentForDownload(caseId: string, documentId: string): Promise<JsonObject> {
    const document = await this.repository.getDocumentForDownload(caseId, documentId);
    if (!document) throw new ApiError(404, "document_not_found", "Document not found in this case.");
    return document;
  }

  async deleteDocument(caseId: string, documentId: string): Promise<{
    checksumSha256: string;
    cleanupWarning: string | null;
  }> {
    const deleted = await this.repository.deleteCaseDocument(caseId, documentId);
    if (!deleted) throw new ApiError(404, "document_not_found", "Document not found in this case.");

    let cleanupWarning: string | null = null;
    if (this.config.ingestionFlowId && this.workflow.deleteFile) {
      try {
        await this.workflow.deleteFile({
          flowId: this.config.ingestionFlowId,
          storagePath: deleted.storage_path,
        });
      } catch {
        cleanupWarning = "The document record was removed, but its stored file could not be cleaned up.";
      }
    } else {
      cleanupWarning = "The document record was removed, but file cleanup is not configured.";
    }
    return { checksumSha256: deleted.checksum_sha256, cleanupWarning };
  }

  async getSource(runId: string, sourceKind: OpenableSourceKind, sourceId: string): Promise<JsonObject> {
    const source = await this.repository.getSource(runId, sourceKind, sourceId);
    if (!source) throw new ApiError(404, "source_not_found", "Source not found in this analysis run.");
    if (sourceKind === "case_document") {
      return {
        ...source,
        content_url: `/api/cases/${source.case_id}/documents/${source.document_id}/content`,
      };
    }
    return source;
  }

  async uploadEvidence(input: {
    caseId: string;
    submittedBy: string;
    documents: UploadedEvidence[];
  }): Promise<JsonObject> {
    if (input.documents.length === 0) {
      throw new ApiError(400, "evidence_required", "Select at least one evidence file.");
    }
    const ingestionFlowId = this.config.ingestionFlowId;
    if (!ingestionFlowId) {
      throw new ApiError(503, "ingestion_unavailable", "Evidence ingestion is not configured.");
    }
    const fileNodeId = this.config.ingestionFileNodeId ?? "File-Yt4Yk";
    const guardNodeId = this.config.ingestionGuardNodeId ?? "CustomComponent-9FyMw";
    if (!this.workflow.uploadFile) {
      throw new ApiError(503, "ingestion_unavailable", "Evidence upload is not configured.");
    }
    const jobs = [];
    for (const document of input.documents) {
      const attemptId = randomUUID();
      const idempotencyKey = `evidence-ingestion:${input.caseId}:${document.checksum_sha256}:${attemptId}`;
      const sessionId = `kyb-ingestion:${input.caseId}:${attemptId}`;
      await this.repository.reserveEvidenceInvocation({
        caseId: input.caseId,
        checksumSha256: document.checksum_sha256,
        originalFilename: document.original_filename,
        documentType: document.document_type,
        idempotencyKey,
        flowId: ingestionFlowId,
        sessionId,
      });
      try {
        const langflowPath = await this.workflow.uploadFile({
          flowId: ingestionFlowId,
          storagePath: document.storage_path,
          filename: document.original_filename,
          mimeType: document.mime_type,
        });
        const job = await this.workflow.startBackground({
          flowId: ingestionFlowId,
          sessionId,
          idempotencyKey,
          inputValue: langflowPath,
          tweaks: {
            [fileNodeId]: {
              path: [langflowPath],
              file_path_str: langflowPath,
            },
            [guardNodeId]: {
              case_id: input.caseId,
              file_path: document.storage_path,
              document_type: document.document_type,
              submitted_by: input.submittedBy,
              original_filename: document.original_filename,
              supplied_mime_type: document.mime_type,
              supplied_checksum_sha256: document.checksum_sha256,
              operation: "Ingest",
            },
          },
        });
        await this.repository.finishEvidenceInvocation(idempotencyKey, job.job_id, job.status);
        jobs.push({ ...job, original_filename: document.original_filename });
      } catch (error) {
        await this.repository.failEvidenceInvocation(idempotencyKey);
        throw error;
      }
    }
    return { documents: input.documents, ingestion: { status: "queued", jobs } };
  }

  async getEvidenceReadiness(caseId: string): Promise<JsonObject> {
    let readiness = await this.repository.getEvidenceReadiness(caseId);
    if (!readiness) throw new ApiError(404, "case_not_found", "Case not found.");
    const jobs = Array.isArray(readiness.jobs) ? readiness.jobs : [];
    await Promise.all(jobs.map(async (item) => {
      if (!item || typeof item !== "object") return;
      const job = item as Record<string, unknown>;
      if (typeof job.job_id !== "string" || job.job_id.startsWith("pending:")) return;
      const needsFailureDetail = job.status === "failed"
        && (!job.failure_summary || job.failure_summary === "Langflow workflow execution failed.");
      if (job.status !== "queued" && job.status !== "in_progress" && job.status !== "suspended"
        && !needsFailureDetail) return;
      try {
        const current = await this.workflow.status(job.job_id);
        if (current.status !== job.status
          || (current.status === "failed" && current.failure_reason && current.failure_reason !== job.failure_summary)) {
          await this.repository.updateInvocationStatus(job.job_id, current.status, current.failure_reason);
        }
      } catch {
        // Keep the persisted status until Langflow can be reached again.
      }
    }));
    readiness = await this.repository.getEvidenceReadiness(caseId);
    if (!readiness) throw new ApiError(404, "case_not_found", "Case not found.");
    return {
      ...readiness,
      can_start: readiness.status === "ready" && CASE_STATUSES_OPEN_FOR_ANALYSIS.includes(String(readiness.case_status)),
      poll_after_ms: this.pollIntervalMs,
    };
  }

  async recordFinalDecision(caseId: string, input: unknown): Promise<JsonObject> {
    const parsed = finalDecisionSchema.parse(input);
    try {
      return await this.repository.recordFinalDecision({
        caseId,
        analysisRunId: parsed.analysis_run_id,
        decision: parsed.decision,
        actorId: parsed.actor_id,
        rationale: parsed.rationale,
        idempotencyKey: parsed.idempotency_key,
      });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : null;
      if (code === "23P01") {
        throw new ApiError(409, "decision_conflict", "A different final decision is already recorded.");
      }
      if (code === "55000") {
        throw new ApiError(409, "case_not_ready", "The case is not ready for a final decision.");
      }
      if (code === "23503") {
        throw new ApiError(404, "case_not_found", "Case not found.");
      }
      throw error;
    }
  }

  async startAnalysis(caseId: string, input: unknown): Promise<JsonObject> {
    const parsed = startAnalysisSchema.parse(input);
    const readiness = await this.getEvidenceReadiness(caseId);
    if (!readiness.can_start) {
      if (readiness.status === "ready") {
        throw new ApiError(409, "case_not_startable", "This case cannot start a new analysis.");
      }
      const messages: Record<string, string> = {
        empty: "Upload evidence before starting analysis.",
        processing: "Wait for evidence ingestion to finish before starting analysis.",
        failed: "Resolve failed evidence ingestion before starting analysis.",
      };
      throw new ApiError(409, `evidence_${readiness.status}`, messages[String(readiness.status)] ?? "Evidence is not ready.");
    }
    const selectedCase = await this.repository.getCase(caseId);
    if (!selectedCase) throw new ApiError(404, "case_not_found", "Case not found.");
    const submittedPayload = selectedCase.submitted_payload;
    const declaration = submittedPayload && typeof submittedPayload === "object"
      ? (submittedPayload as JsonObject).entity_declaration
      : undefined;
    const parsedDeclaration = entityDeclarationSchema.safeParse(declaration);
    if (!parsedDeclaration.success
      || (parsedDeclaration.data.legal_name && parsedDeclaration.data.legal_name !== selectedCase.legal_name)
      || (parsedDeclaration.data.jurisdiction && parsedDeclaration.data.jurisdiction !== selectedCase.jurisdiction)) {
      throw new ApiError(409, "entity_declaration_required", "Add the entity addresses and registration number before starting analysis.");
    }
    const sessionId = `kyb-analysis:${randomUUID()}`;
    let run: AnalysisRunRecord;
    try {
      run = await this.repository.startAnalysis({
        caseId,
        sessionId,
        analystInstructions: parsed.analyst_instructions ?? null,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "case_archived") {
        throw new ApiError(409, "case_archived", "Unarchive this case before starting analysis.");
      }
      throw error;
    }
    const idempotencyKey = `analysis-start:${run.id}`;
    try {
      const job = await this.startCoordinator({
        run,
        taskObjective: parsed.task_objective,
        idempotencyKey,
      });
      await this.repository.recordInvocation({
        caseId,
        analysisRunId: run.id,
        purpose: "analysis_start",
        flowId: this.config.coordinatorFlowId,
        jobId: job.job_id,
        sessionId,
        status: job.status,
        idempotencyKey,
      });
      return { ...run, langflow: job, poll_after_ms: this.pollIntervalMs };
    } catch (error) {
      await this.repository.markLaunchFailed(
        run.id,
        error instanceof Error ? error.message : "Langflow launch failed",
      );
      throw error;
    }
  }

  async getRun(runId: string): Promise<JsonObject> {
    let run = await this.repository.getRun(runId);
    if (!run) throw new ApiError(404, "run_not_found", "Analysis run not found.");

    const jobId = typeof run.latest_job_id === "string" ? run.latest_job_id : null;
    const jobStatus = typeof run.latest_job_status === "string" ? run.latest_job_status : null;
    if (jobId && (jobStatus === "queued" || jobStatus === "in_progress")) {
      try {
        const current = await this.workflow.status(jobId);
        if (current.status !== jobStatus) {
          await this.repository.updateInvocationStatus(jobId, current.status, current.failure_reason);
          run = { ...run, latest_job_status: current.status,
            latest_job_failure_reason: current.status === "failed" ? current.failure_reason ?? null : null };
        }
      } catch {
        // PostgreSQL remains authoritative for coordinator state. A transient
        // Langflow status read must not make the case snapshot unavailable.
      }
    }

    if (jobId && TERMINAL_UNSUCCESSFUL_JOB_STATUSES.has(String(run.latest_job_status))
      && (run.status === "queued" || run.status === "running")) {
      const outcome = await this.repository.markExecutionFailed(runId, jobId);
      if (outcome?.recovered) await this.resumeAfterRecoveredFailure(runId, jobId);
      run = await this.repository.getRun(runId) ?? run;
    }

    const status = String(run.status ?? "");
    const phase = typeof run.coordinator_phase === "string" ? run.coordinator_phase : null;
    return {
      ...run,
      polling: {
        active: shouldPollRun(status, phase),
        interval_ms: this.pollIntervalMs,
      },
    };
  }

  async submitCheckpoint(runId: string, input: unknown): Promise<JsonObject> {
    const parsed = checkpointResponseSchema.parse(input);
    const [run, checkpoint] = await Promise.all([
      this.repository.getRunIdentity(runId),
      this.repository.getPendingCheckpoint(runId, parsed.request_id),
    ]);
    if (!run) throw new ApiError(404, "run_not_found", "Analysis run not found.");
    if (!checkpoint) {
      throw new ApiError(409, "checkpoint_unavailable", "This checkpoint is no longer pending.");
    }
    if (run.status !== "suspended") {
      throw new ApiError(409, "run_not_suspended", "The analysis run is not waiting for input.");
    }
    const allowed = checkpoint.request_payload.allowed_actions;
    if (!Array.isArray(allowed) || !allowed.includes(parsed.action_id)) {
      throw new ApiError(400, "action_not_allowed", "Select one of the checkpoint's allowed actions.");
    }
    if (parsed.action_id === "skip_for_now" && checkpoint.skipped_at) {
      throw new ApiError(409, "checkpoint_already_skipped", "This request was already skipped. Choose another action to continue.");
    }
    if (parsed.action_id === "skip_for_now") {
      // A skip leaves the checkpoint pending, so record it directly: no coordinator job to
      // wait for, and the next case refresh already shows the request as skipped.
      await this.repository.recordCheckpointSkip({
        runId,
        requestId: parsed.request_id,
        expectedStateVersion: checkpoint.expected_state_version,
        actorId: parsed.actor_id,
        idempotencyKey: parsed.idempotency_key,
      });
      return {
        analysis_run_id: run.id,
        case_id: run.case_id,
        status: "waiting_for_human",
        skipped: true,
        poll_after_ms: this.pollIntervalMs,
      };
    }

    const checkpointContext = checkpoint.request_payload.payload;
    if (checkpoint.checkpoint_kind === "specialist_recovery" && parsed.action_id === "retry"
      && checkpointContext && typeof checkpointContext === "object" && !Array.isArray(checkpointContext)) {
      const context = checkpointContext as Record<string, unknown>;
      if (!Number.isInteger(context.attempt) || typeof context.attempt !== "number"
        || context.attempt < 1 || context.attempt >= 3) {
        throw new ApiError(409, "specialist_retry_exhausted", "This specialist has used all three attempts. Stop this run to start a new analysis.");
      }
      if (context.specialty === "policy" && typeof context.assessment_api_path === "string"
        && !(await this.repository.hasAcceptedPolicyAssessment(runId))) {
        throw new ApiError(409, "policy_assessment_required", "Accept a cited policy assessment before retrying the Policy Specialist.");
      }
    }

    const checkpointPayload = checkpoint.request_payload.payload;
    const trustedValues = checkpointPayload && typeof checkpointPayload === "object"
      ? checkpointPayload as Record<string, unknown>
      : {};
    if (checkpoint.checkpoint_kind === "information_request" && parsed.action_id === "submit_clarification"
      && Array.isArray(trustedValues.questions)) {
      const questions = trustedValues.questions as Array<Record<string, unknown>>;
      const answers = parsed.values.answers;
      const expectedIds = questions.map((question) => question.id);
      if (!answers || typeof answers !== "object" || Array.isArray(answers)
        || Object.keys(answers).length !== expectedIds.length
        || expectedIds.some((id) => {
          const answer = typeof id === "string" ? (answers as Record<string, unknown>)[id] : null;
          return typeof answer !== "string" || !answer.trim();
        })) {
        throw new ApiError(400, "clarification_answers_required", "Answer each requested item before sending your response.");
      }
      const selections = parsed.values.selected_choices;
      if (selections !== undefined && (!selections || typeof selections !== "object" || Array.isArray(selections)
        || Object.keys(selections).some((id) => !expectedIds.includes(id)))) {
        throw new ApiError(400, "invalid_choice_answer", "Choose from the options the coordinator provided.");
      }
      for (const question of questions) {
        const id = String(question.id);
        assertChoiceAnswer(
          question,
          (answers as Record<string, unknown>)[id],
          (selections as Record<string, unknown> | undefined)?.[id],
        );
      }
    } else if (checkpoint.checkpoint_kind === "information_request" && parsed.action_id === "submit_clarification"
      && Array.isArray(trustedValues.choices)) {
      assertChoiceAnswer(trustedValues, parsed.values.answer, parsed.values.selected_choices);
    }
    const values = {
      ...parsed.values,
      expected_state_version: checkpoint.expected_state_version,
      ...(typeof trustedValues.proposal_hash === "string"
        ? { proposal_hash: trustedValues.proposal_hash }
        : {}),
      ...(typeof trustedValues.scope_hash === "string"
        ? { scope_hash: trustedValues.scope_hash }
        : {}),
      ...(typeof trustedValues.operation_key === "string"
        ? { operation_key: trustedValues.operation_key }
        : {}),
    };
    const coordinatorFlowId = run.coordinator_flow_id
      || this.config.legacyCoordinatorFlowId
      || this.config.coordinatorFlowId;
    const job = await this.startCoordinator({
      run,
      flowId: coordinatorFlowId,
      taskObjective: run.task_objective,
      idempotencyKey: `analysis-resume:${run.id}:${parsed.idempotency_key}`,
      checkpointResponse: {
        request_id: parsed.request_id,
        action_id: parsed.action_id,
        actor_id: parsed.actor_id,
        idempotency_key: parsed.idempotency_key,
        values,
      },
    });
    await this.repository.recordInvocation({
      caseId: run.case_id,
      analysisRunId: run.id,
      purpose: "analysis_resume",
      flowId: coordinatorFlowId,
      jobId: job.job_id,
      sessionId: run.session_id,
      status: job.status,
      idempotencyKey: `analysis-resume:${run.id}:${parsed.idempotency_key}`,
    });
    return {
      analysis_run_id: run.id,
      case_id: run.case_id,
      status: job.status,
      langflow: job,
      poll_after_ms: this.pollIntervalMs,
    };
  }

  /** Restart the coordinator so it returns the recovered case to the analyst handoff. */
  private async resumeAfterRecoveredFailure(runId: string, failedJobId: string): Promise<void> {
    const run = await this.repository.getRunIdentity(runId);
    if (!run) return;
    const flowId = run.coordinator_flow_id
      || this.config.legacyCoordinatorFlowId
      || this.config.coordinatorFlowId;
    const idempotencyKey = `analysis-recover:${run.id}:${failedJobId}`;
    try {
      const job = await this.startCoordinator({
        run, flowId, taskObjective: run.task_objective, idempotencyKey,
      });
      await this.repository.recordInvocation({
        caseId: run.case_id,
        analysisRunId: run.id,
        purpose: "analysis_resume",
        flowId,
        jobId: job.job_id,
        sessionId: run.session_id,
        status: job.status,
        idempotencyKey,
      });
    } catch (error) {
      await this.repository.markLaunchFailed(
        run.id, error instanceof Error ? error.message : "Langflow launch failed",
      );
    }
  }

  private get pollIntervalMs(): number {
    return this.config.pollIntervalMs ?? 2_000;
  }

  private startCoordinator(input: {
    run: { id: string; case_id: string; session_id: string };
    flowId?: string;
    taskObjective: string;
    idempotencyKey: string;
    checkpointResponse?: Record<string, unknown>;
  }): Promise<LangflowBackgroundJob> {
    return this.workflow.startBackground({
      flowId: input.flowId ?? this.config.coordinatorFlowId,
      sessionId: input.run.session_id,
      idempotencyKey: input.idempotencyKey,
      inputValue: JSON.stringify({
        schema_version: "1.0",
        analysis_run_id: input.run.id,
        case_id: input.run.case_id,
        session_id: input.run.session_id,
        task_objective: input.taskObjective,
        ...(input.checkpointResponse
          ? { checkpoint_response: input.checkpointResponse }
          : {}),
      }),
    });
  }
}
import { randomUUID } from "node:crypto";
