import { describe, expect, it, vi } from "vitest";

import { shouldPollRun } from "../src/api/contracts.js";
import type { CaseRepository } from "../src/api/repository.js";
import { CaseApiService } from "../src/api/service.js";

const caseId = "32000000-0000-4000-8000-000000000051";
const runId = "a7c0b8f7-56ef-4058-b599-ac20e49d6907";

function repository(overrides: Partial<CaseRepository> = {}): CaseRepository {
  return {
    getProviderProfile: vi.fn().mockResolvedValue(null),
    saveProviderProfile: vi.fn().mockImplementation(async (input) => input),
    listRuleApplicability: vi.fn().mockResolvedValue([]),
    createCase: vi.fn().mockResolvedValue({ id: caseId }),
    listCases: vi.fn().mockResolvedValue([]),
    getCase: vi.fn().mockResolvedValue({
      legal_name: "Example Ltd",
      jurisdiction: "GB",
      submitted_payload: {
        entity_declaration: {
          identifiers: [{ type: "registration_number", value: "GB-123", jurisdiction: "GB" }],
          addresses: {
            registered: "1 Market Street",
            operating: "1 Market Street",
            mailing: "1 Market Street",
          },
        },
      },
    }),
    setCaseArchived: vi.fn().mockResolvedValue({ id: caseId, archived_at: null }),
    deleteArchivedCase: vi.fn().mockResolvedValue(null),
    getCaseTimeline: vi.fn().mockResolvedValue([]),
    getDocumentForDownload: vi.fn().mockResolvedValue(null),
    deleteCaseDocument: vi.fn().mockResolvedValue(null),
    getSource: vi.fn().mockResolvedValue(null),
    getEvidenceReadiness: vi.fn().mockResolvedValue({
      status: "ready",
      case_status: "draft",
      documents: [{ id: "document-1", ingestion_status: "ready" }],
      jobs: [],
    }),
    reserveEvidenceInvocation: vi.fn().mockResolvedValue(undefined),
    finishEvidenceInvocation: vi.fn().mockResolvedValue(undefined),
    failEvidenceInvocation: vi.fn().mockResolvedValue(undefined),
    recordFinalDecision: vi.fn().mockResolvedValue({
      id: "decision-1",
      case_id: caseId,
      analysis_run_id: runId,
      decision: "approved",
    }),
    startAnalysis: vi.fn().mockResolvedValue({
      id: runId,
      case_id: caseId,
      session_id: "kyb-analysis:test",
      status: "running",
      analyst_instructions: null,
      created_at: "2026-09-21T00:00:00Z",
    }),
    getRun: vi.fn(),
    getRunIdentity: vi.fn().mockResolvedValue({
      id: runId,
      case_id: caseId,
      session_id: "kyb-analysis:test",
      status: "suspended",
      analyst_instructions: null,
      created_at: "2026-09-21T00:00:00Z",
      task_objective: "Analyze the pinned case evidence.",
      coordinator_flow_id: null,
    }),
    getPendingCheckpoint: vi.fn().mockResolvedValue({
      request_id: "checkpoint-request-1",
      checkpoint_kind: "analyst_approval",
      expected_state_version: 34,
      request_payload: {
        allowed_actions: ["approve", "reject"],
        payload: {
          proposal_hash: "a".repeat(64),
          operation_key: "operation-1",
        },
      },
    }),
    hasAcceptedPolicyAssessment: vi.fn().mockResolvedValue(false),
    recordCheckpointSkip: vi.fn().mockResolvedValue(undefined),
    recordInvocation: vi.fn().mockResolvedValue(undefined),
    updateInvocationStatus: vi.fn().mockResolvedValue(undefined),
    markExecutionFailed: vi.fn().mockResolvedValue(undefined),
    markLaunchFailed: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function backgroundJob() {
  return {
    flow_id: "coordinator-flow",
    job_id: "langflow-job-1",
    object: "job" as const,
    status: "queued" as const,
    links: { status: "/status", events: "/events", stop: "/stop" },
  };
}

describe("case timeline", () => {
  it("checks case ownership and returns one extra row as has_more", async () => {
    const getCaseTimeline = vi.fn().mockResolvedValue([
      { id: "event-1" }, { id: "event-2" }, { id: "event-3" },
    ]);
    const service = new CaseApiService(repository({ getCaseTimeline }), {} as never, {
      coordinatorFlowId: "coordinator-flow",
    });

    await expect(service.getCaseTimeline(caseId, 2, 0)).resolves.toEqual({
      events: [{ id: "event-1" }, { id: "event-2" }], has_more: true, limit: 2, offset: 0,
    });
    expect(getCaseTimeline).toHaveBeenCalledWith(caseId, 3, 0);
    await expect(service.getCaseTimeline(caseId, 101)).rejects.toMatchObject({ status: 400 });
  });
});

describe("Phase 3 API bridge", () => {
  it("deletes a draft document and removes its Langflow file", async () => {
    const documentId = "32000000-0000-4000-8000-000000000053";
    const deleteCaseDocument = vi.fn().mockResolvedValue({
      storage_path: "/cache/ingestion-flow/document.pdf",
      original_filename: "document.pdf",
      checksum_sha256: "a".repeat(64),
    });
    const deleteFile = vi.fn().mockResolvedValue(undefined);
    const service = new CaseApiService(repository({ deleteCaseDocument }), {
      deleteFile, startBackground: vi.fn(), status: vi.fn(),
    }, { coordinatorFlowId: "coordinator-flow", ingestionFlowId: "ingestion-flow" });

    await expect(service.deleteDocument(caseId, documentId)).resolves.toEqual({
      checksumSha256: "a".repeat(64), cleanupWarning: null,
    });
    expect(deleteCaseDocument).toHaveBeenCalledWith(caseId, documentId);
    expect(deleteFile).toHaveBeenCalledWith({
      flowId: "ingestion-flow", storagePath: "/cache/ingestion-flow/document.pdf",
    });
  });

  it("does not delete a file if the document is absent", async () => {
    const deleteFile = vi.fn();
    const service = new CaseApiService(repository(), {
      deleteFile, startBackground: vi.fn(), status: vi.fn(),
    }, { coordinatorFlowId: "coordinator-flow", ingestionFlowId: "ingestion-flow" });

    await expect(service.deleteDocument(caseId, "32000000-0000-4000-8000-000000000053"))
      .rejects.toMatchObject({ status: 404, code: "document_not_found" });
    expect(deleteFile).not.toHaveBeenCalled();
  });

  it("returns a case-scoped download link for a pinned document source", async () => {
    const sourceId = "32000000-0000-4000-8000-000000000052";
    const repo = repository({
      getSource: vi.fn().mockResolvedValue({
        source_kind: "case_document", case_id: caseId,
        document_id: "32000000-0000-4000-8000-000000000053",
        source_id: sourceId,
      }),
    });
    const service = new CaseApiService(repo, { startBackground: vi.fn(), status: vi.fn() }, {
      coordinatorFlowId: "coordinator-flow",
    });

    await expect(service.getSource(runId, "case_document", sourceId)).resolves.toMatchObject({
      content_url: `/api/cases/${caseId}/documents/32000000-0000-4000-8000-000000000053/content`,
    });
  });

  it("launches the existing ingestion flow once per file without pre-creating document rows", async () => {
    const repo = repository();
    const uploadFile = vi.fn()
      .mockResolvedValueOnce("ingestion-flow/formation.pdf")
      .mockResolvedValueOnce("ingestion-flow/ownership.pdf");
    const startBackground = vi.fn()
      .mockResolvedValueOnce(backgroundJob())
      .mockResolvedValueOnce({ ...backgroundJob(), job_id: "langflow-job-2" });
    const service = new CaseApiService(repo, {
      uploadFile,
      startBackground,
      status: vi.fn(),
    }, {
      coordinatorFlowId: "coordinator-flow",
      ingestionFlowId: "ingestion-flow",
      ingestionFileNodeId: "file-node",
      ingestionGuardNodeId: "guard-node",
    });

    const result = await service.uploadEvidence({
      caseId,
      submittedBy: "analyst-1",
      documents: [
        {
          document_type: "formation_certificate",
          original_filename: "formation.pdf",
          mime_type: "application/pdf",
          checksum_sha256: "a".repeat(64),
          storage_path: "/evidence/formation.pdf",
        },
        {
          document_type: "ownership_register",
          original_filename: "ownership.pdf",
          mime_type: "application/pdf",
          checksum_sha256: "b".repeat(64),
          storage_path: "/evidence/ownership.pdf",
        },
      ],
    });

    expect(startBackground).toHaveBeenCalledTimes(2);
    expect(startBackground.mock.calls[0]![0]).toMatchObject({
      flowId: "ingestion-flow",
      tweaks: {
        "file-node": {
          path: ["ingestion-flow/formation.pdf"],
          file_path_str: "ingestion-flow/formation.pdf",
        },
        "guard-node": {
          case_id: caseId,
          file_path: "/evidence/formation.pdf",
          document_type: "formation_certificate",
          submitted_by: "analyst-1",
          original_filename: "formation.pdf",
          supplied_mime_type: "application/pdf",
          supplied_checksum_sha256: "a".repeat(64),
          operation: "Ingest",
        },
      },
    });
    expect(repo.reserveEvidenceInvocation).toHaveBeenCalledTimes(2);
    expect(uploadFile).toHaveBeenCalledWith({
      flowId: "ingestion-flow",
      storagePath: "/evidence/formation.pdf",
      filename: "formation.pdf",
      mimeType: "application/pdf",
    });
    expect(repo.finishEvidenceInvocation).toHaveBeenCalledTimes(2);
    expect(vi.mocked(repo.reserveEvidenceInvocation).mock.invocationCallOrder[0]).toBeLessThan(
      startBackground.mock.invocationCallOrder[0]!,
    );
    expect(repo.recordInvocation).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ingestion: { status: "queued" } });
  });

  it.each(["empty", "processing", "failed"])('does not launch analysis while evidence is %s', async (status) => {
    const repo = repository({
      getEvidenceReadiness: vi.fn().mockResolvedValue({ status, documents: [], jobs: [] }),
    });
    const startBackground = vi.fn();
    const service = new CaseApiService(repo, { startBackground, status: vi.fn() }, {
      coordinatorFlowId: "coordinator-flow",
    });

    await expect(service.startAnalysis(caseId, {})).rejects.toMatchObject({
      status: 409,
      code: `evidence_${status}`,
    });
    expect(repo.startAnalysis).not.toHaveBeenCalled();
    expect(startBackground).not.toHaveBeenCalled();
  });

  it("does not restart a case that is already ready for final review", async () => {
    const repo = repository({
      getEvidenceReadiness: vi.fn().mockResolvedValue({
        status: "ready", case_status: "ready_for_review", documents: [], jobs: [],
      }),
    });
    const startBackground = vi.fn();
    const service = new CaseApiService(repo, { startBackground, status: vi.fn() }, {
      coordinatorFlowId: "coordinator-flow",
    });

    await expect(service.startAnalysis(caseId, {})).rejects.toMatchObject({
      status: 409, code: "case_not_startable",
    });
    expect(repo.startAnalysis).not.toHaveBeenCalled();
  });

  it("keeps a draft without an entity declaration but blocks analysis", async () => {
    const repo = repository({
      getCase: vi.fn().mockResolvedValue({
        legal_name: "Example Ltd",
        jurisdiction: "GB",
        submitted_payload: { registered_address: "1 Market Street" },
      }),
    });
    const startBackground = vi.fn();
    const service = new CaseApiService(repo, { startBackground, status: vi.fn() }, {
      coordinatorFlowId: "coordinator-flow",
    });

    await expect(service.createCase({
      legal_name: "Example Ltd", jurisdiction: "GB", business_type: "software", product: "domestic_payments",
      submitted_payload: {},
    })).resolves.toMatchObject({ id: caseId });
    expect(repo.createCase).toHaveBeenCalled();
    await expect(service.startAnalysis(caseId, {})).rejects.toMatchObject({
      status: 409, code: "entity_declaration_required",
    });
    expect(repo.startAnalysis).not.toHaveBeenCalled();
    expect(startBackground).not.toHaveBeenCalled();
  });

  it("rejects a malformed or conflicting entity declaration at case creation", () => {
    const repo = repository();
    const service = new CaseApiService(repo, { startBackground: vi.fn(), status: vi.fn() }, {
      coordinatorFlowId: "coordinator-flow",
    });
    const base = { legal_name: "Example Ltd", jurisdiction: "GB", business_type: "software", product: "domestic_payments" };

    expect(() => service.createCase({
      ...base,
      submitted_payload: { entity_declaration: {
        identifiers: [{ type: "registration_number", value: " ", jurisdiction: "GB" }],
        addresses: { registered: "1 Market Street", operating: "1 Market Street", mailing: "1 Market Street" },
      } },
    })).toThrow();
    expect(() => service.createCase({
      ...base,
      submitted_payload: { entity_declaration: {
        legal_name: "Different Ltd",
        identifiers: [{ type: "registration_number", value: "GB-123", jurisdiction: "GB" }],
        addresses: { registered: "1 Market Street", operating: "1 Market Street", mailing: "1 Market Street" },
      } },
    })).toThrow();
    expect(repo.createCase).not.toHaveBeenCalled();
  });

  it("refreshes queued ingestion jobs before declaring evidence ready", async () => {
    const getEvidenceReadiness = vi.fn()
      .mockResolvedValueOnce({
        status: "processing", documents: [], jobs: [{ job_id: "ingestion-job-1", status: "queued" }],
      })
      .mockResolvedValueOnce({ status: "ready", case_status: "draft", documents: [{ ingestion_status: "ready" }], jobs: [] });
    const repo = repository({ getEvidenceReadiness });
    const status = vi.fn().mockResolvedValue({ status: "completed" });
    const service = new CaseApiService(repo, { startBackground: vi.fn(), status }, {
      coordinatorFlowId: "coordinator-flow",
    });

    await expect(service.getEvidenceReadiness(caseId)).resolves.toMatchObject({
      status: "ready", can_start: true,
    });
    expect(status).toHaveBeenCalledWith("ingestion-job-1");
    expect(repo.updateInvocationStatus).toHaveBeenCalledWith("ingestion-job-1", "completed", undefined);
  });

  it("lets an escalated case start a new analysis once its evidence is ready", async () => {
    const getEvidenceReadiness = vi.fn().mockResolvedValue({
      status: "ready", case_status: "enhanced_review", documents: [{ ingestion_status: "ready" }], jobs: [],
    });
    const service = new CaseApiService(repository({ getEvidenceReadiness }), { startBackground: vi.fn(), status: vi.fn() }, {
      coordinatorFlowId: "coordinator-flow",
    });
    await expect(service.getEvidenceReadiness(caseId)).resolves.toMatchObject({ can_start: true });
  });

  it("refreshes the safe failure reason for an already failed evidence job", async () => {
    const getEvidenceReadiness = vi.fn()
      .mockResolvedValueOnce({
        status: "failed", documents: [], jobs: [{ job_id: "ingestion-job-1", status: "failed", failure_summary: "Langflow workflow execution failed." }],
      })
      .mockResolvedValueOnce({
        status: "failed", case_status: "draft", documents: [], jobs: [{ job_id: "ingestion-job-1", status: "failed", failure_summary: "Langflow's document reader needs EasyOCR, or OCR must be disabled for text-based files." }],
      });
    const repo = repository({ getEvidenceReadiness });
    const status = vi.fn().mockResolvedValue({
      status: "failed", failure_reason: "Langflow's document reader needs EasyOCR, or OCR must be disabled for text-based files.",
    });
    const service = new CaseApiService(repo, { startBackground: vi.fn(), status }, {
      coordinatorFlowId: "coordinator-flow",
    });

    await expect(service.getEvidenceReadiness(caseId)).resolves.toMatchObject({ status: "failed" });
    expect(repo.updateInvocationStatus).toHaveBeenCalledWith("ingestion-job-1", "failed", "Langflow's document reader needs EasyOCR, or OCR must be disabled for text-based files.");
  });

  it("passes an approve or reject final decision to the database, not Langflow", async () => {
    const repo = repository();
    const startBackground = vi.fn();
    const service = new CaseApiService(repo, { startBackground, status: vi.fn() }, {
      coordinatorFlowId: "coordinator-flow",
    });

    await service.recordFinalDecision(caseId, {
      analysis_run_id: runId,
      decision: "rejected",
      actor_id: "analyst-1",
      rationale: "Ownership could not be verified.",
      idempotency_key: "decision-reject-001",
    });

    expect(repo.recordFinalDecision).toHaveBeenCalledWith({
      caseId,
      analysisRunId: runId,
      decision: "rejected",
      actorId: "analyst-1",
      rationale: "Ownership could not be verified.",
      idempotencyKey: "decision-reject-001",
    });
    expect(startBackground).not.toHaveBeenCalled();
  });

  it("requires a rationale and stable idempotency key for final decisions", async () => {
    const repo = repository();
    const service = new CaseApiService(repo, { startBackground: vi.fn(), status: vi.fn() }, {
      coordinatorFlowId: "coordinator-flow",
    });

    await expect(service.recordFinalDecision(caseId, {
      analysis_run_id: runId,
      decision: "approved",
      actor_id: "analyst-1",
      rationale: " ",
      idempotency_key: "short",
    })).rejects.toMatchObject({ name: "ZodError" });
    expect(repo.recordFinalDecision).not.toHaveBeenCalled();
  });

  it("starts Langflow with the PostgreSQL analysis_run_id", async () => {
    const repo = repository();
    const startBackground = vi.fn().mockResolvedValue(backgroundJob());
    const service = new CaseApiService(repo, {
      startBackground,
      status: vi.fn(),
    }, { coordinatorFlowId: "coordinator-flow" });

    const result = await service.startAnalysis(caseId, {});

    const request = startBackground.mock.calls[0]![0];
    expect(JSON.parse(request.inputValue)).toMatchObject({
      analysis_run_id: runId,
      case_id: caseId,
      session_id: "kyb-analysis:test",
    });
    expect(repo.recordInvocation).toHaveBeenCalledWith(expect.objectContaining({
      analysisRunId: runId,
      purpose: "analysis_start",
    }));
    expect(result).toMatchObject({ id: runId, poll_after_ms: 2000 });
  });

  it("resumes with the same analysis_run_id and server-trusted checkpoint hashes", async () => {
    const repo = repository();
    const startBackground = vi.fn().mockResolvedValue(backgroundJob());
    const service = new CaseApiService(repo, {
      startBackground,
      status: vi.fn(),
    }, { coordinatorFlowId: "coordinator-flow" });

    await service.submitCheckpoint(runId, {
      request_id: "checkpoint-request-1",
      action_id: "approve",
      actor_id: "analyst-1",
      idempotency_key: "approval-request-0001",
      values: { proposal_hash: "untrusted-client-value" },
    });

    const request = startBackground.mock.calls[0]![0];
    const payload = JSON.parse(request.inputValue);
    expect(payload.analysis_run_id).toBe(runId);
    expect(payload.session_id).toBe("kyb-analysis:test");
    expect(payload.checkpoint_response).toEqual({
      request_id: "checkpoint-request-1",
      action_id: "approve",
      actor_id: "analyst-1",
      idempotency_key: "approval-request-0001",
      values: {
        expected_state_version: 34,
        proposal_hash: "a".repeat(64),
        operation_key: "operation-1",
      },
    });
    expect(repo.recordInvocation).toHaveBeenCalledWith(expect.objectContaining({
      analysisRunId: runId,
      purpose: "analysis_resume",
      sessionId: "kyb-analysis:test",
    }));
  });

  it("requires an answer for every structured information question", async () => {
    const startBackground = vi.fn().mockResolvedValue(backgroundJob());
    const service = new CaseApiService(repository({
      getPendingCheckpoint: vi.fn().mockResolvedValue({
        request_id: "information-1", checkpoint_kind: "information_request",
        expected_state_version: 4,
        request_payload: { allowed_actions: ["submit_clarification"], payload: {
          question: "Provide the requested information.",
          questions: [{ id: "entity:name" }, { id: "ownership:remainder" }],
        } },
      }),
    }), { startBackground, status: vi.fn() }, { coordinatorFlowId: "coordinator-flow" });
    const input = {
      request_id: "information-1", action_id: "submit_clarification",
      actor_id: "analyst-1", idempotency_key: "information-answer-0001",
    };
    await expect(service.submitCheckpoint(runId, {
      ...input, values: { answers: { "entity:name": "Name evidence" } },
    })).rejects.toMatchObject({ code: "clarification_answers_required" });
    expect(startBackground).not.toHaveBeenCalled();
    await service.submitCheckpoint(runId, {
      ...input, values: { answers: {
        "entity:name": "Name evidence", "ownership:remainder": "Ownership evidence",
      } },
    });
    expect(startBackground).toHaveBeenCalledOnce();
  });

  it("checks answers against agent-authored choices", async () => {
    const startBackground = vi.fn().mockResolvedValue(backgroundJob());
    const service = new CaseApiService(repository({
      getPendingCheckpoint: vi.fn().mockResolvedValue({
        request_id: "information-2", checkpoint_kind: "information_request",
        expected_state_version: 4,
        request_payload: { allowed_actions: ["submit_clarification"], payload: {
          question: "Provide the requested information.",
          questions: [
            { id: "entity:address", choices: ["Registered", "Operating"], allow_custom: false },
            { id: "ownership:holders", choices: ["Parent Co", "Founder"], multiple: true },
          ],
        } },
      }),
    }), { startBackground, status: vi.fn() }, { coordinatorFlowId: "coordinator-flow" });
    const input = {
      request_id: "information-2", action_id: "submit_clarification",
      actor_id: "analyst-1", idempotency_key: "information-answer-0002",
    };

    // Free text is rejected where the agent disallowed it.
    await expect(service.submitCheckpoint(runId, {
      ...input, values: { answers: { "entity:address": "Somewhere else", "ownership:holders": "Founder" } },
    })).rejects.toMatchObject({ code: "invalid_choice_answer" });
    // Selections must come from the listed choices.
    await expect(service.submitCheckpoint(runId, {
      ...input, values: {
        answers: { "entity:address": "Registered", "ownership:holders": "Trust" },
        selected_choices: { "entity:address": ["Registered"], "ownership:holders": ["Trust"] },
      },
    })).rejects.toMatchObject({ code: "invalid_choice_answer" });
    // A single-choice question takes one selection.
    await expect(service.submitCheckpoint(runId, {
      ...input, values: {
        answers: { "entity:address": "Registered; Operating", "ownership:holders": "Founder" },
        selected_choices: { "entity:address": ["Registered", "Operating"] },
      },
    })).rejects.toMatchObject({ code: "invalid_choice_answer" });
    expect(startBackground).not.toHaveBeenCalled();

    await service.submitCheckpoint(runId, {
      ...input, values: {
        answers: { "entity:address": "Registered", "ownership:holders": "Parent Co; Founder; Also a trust" },
        selected_choices: { "entity:address": ["Registered"], "ownership:holders": ["Parent Co", "Founder"] },
      },
    });
    expect(startBackground).toHaveBeenCalledOnce();
  });

  it("allows one skip per checkpoint request", async () => {
    const startBackground = vi.fn().mockResolvedValue(backgroundJob());
    const pending = {
      request_id: "conflict-1", checkpoint_kind: "conflict_review",
      expected_state_version: 4,
      request_payload: { allowed_actions: ["escalate", "reject", "skip_for_now"], payload: {
        question: "Which address is current?", choices: ["Registered", "Operating"],
      } },
    };
    const getPendingCheckpoint = vi.fn().mockResolvedValue(pending);
    const repo = repository({ getPendingCheckpoint });
    const service = new CaseApiService(repo,
      { startBackground, status: vi.fn() }, { coordinatorFlowId: "coordinator-flow" });
    const input = {
      request_id: "conflict-1", action_id: "skip_for_now",
      actor_id: "analyst-1", idempotency_key: "conflict-skip-0001", values: {},
    };

    // Recorded synchronously so the next refresh hides Skip; no coordinator job runs.
    await expect(service.submitCheckpoint(runId, input)).resolves.toMatchObject({ skipped: true });
    expect(repo.recordCheckpointSkip).toHaveBeenCalledWith({
      runId, requestId: "conflict-1", expectedStateVersion: 4,
      actorId: "analyst-1", idempotencyKey: "conflict-skip-0001",
    });

    getPendingCheckpoint.mockResolvedValue({ ...pending, skipped_at: "2026-09-24T10:00:00.000Z" });
    await expect(service.submitCheckpoint(runId, { ...input, idempotency_key: "conflict-skip-0002" }))
      .rejects.toMatchObject({ code: "checkpoint_already_skipped" });
    expect(repo.recordCheckpointSkip).toHaveBeenCalledOnce();
    expect(startBackground).not.toHaveBeenCalled();
  });

  it("resumes a run on the coordinator recorded at its original launch", async () => {
    const repo = repository({
      getRunIdentity: vi.fn().mockResolvedValue({
        id: runId,
        case_id: caseId,
        session_id: "kyb-analysis:test",
        status: "suspended",
        task_objective: "Analyze the pinned case evidence.",
        coordinator_flow_id: "original-coordinator",
      }),
    });
    const startBackground = vi.fn().mockResolvedValue(backgroundJob());
    const service = new CaseApiService(repo, { startBackground, status: vi.fn() }, {
      coordinatorFlowId: "new-coordinator",
      legacyCoordinatorFlowId: "legacy-fallback",
    });

    await service.submitCheckpoint(runId, {
      request_id: "checkpoint-request-1",
      action_id: "approve",
      actor_id: "analyst-1",
      idempotency_key: "original-flow-resume",
      values: {},
    });

    expect(startBackground).toHaveBeenCalledWith(expect.objectContaining({
      flowId: "original-coordinator",
    }));
    expect(repo.recordInvocation).toHaveBeenCalledWith(expect.objectContaining({
      purpose: "analysis_resume",
      flowId: "original-coordinator",
    }));
  });

  it("uses the legacy coordinator for a preexisting run with no launch record", async () => {
    const repo = repository();
    const startBackground = vi.fn().mockResolvedValue(backgroundJob());
    const service = new CaseApiService(repo, { startBackground, status: vi.fn() }, {
      coordinatorFlowId: "new-coordinator",
      legacyCoordinatorFlowId: "original-coordinator",
    });

    await service.submitCheckpoint(runId, {
      request_id: "checkpoint-request-1",
      action_id: "approve",
      actor_id: "analyst-1",
      idempotency_key: "legacy-flow-resume",
      values: {},
    });

    expect(startBackground).toHaveBeenCalledWith(expect.objectContaining({
      flowId: "original-coordinator",
    }));
  });

  it("rejects an action that the persisted checkpoint did not allow", async () => {
    const service = new CaseApiService(repository(), {
      startBackground: vi.fn(),
      status: vi.fn(),
    }, { coordinatorFlowId: "coordinator-flow" });

    await expect(service.submitCheckpoint(runId, {
      request_id: "checkpoint-request-1",
      action_id: "changes_requested",
      actor_id: "analyst-1",
      idempotency_key: "approval-request-0002",
      values: { requested_changes: { comment: "Recheck ownership." } },
    })).rejects.toMatchObject({ status: 400, code: "action_not_allowed" });
  });

  it("polls only while execution can advance without a person", () => {
    expect(shouldPollRun("running", "running")).toBe(true);
    expect(shouldPollRun("queued", null)).toBe(true);
    expect(shouldPollRun("suspended", "waiting_for_human")).toBe(false);
    expect(shouldPollRun("succeeded", "ready_for_review")).toBe(false);
  });

  it("stops an active run after Langflow reports its latest job failed", async () => {
    const getRun = vi.fn()
      .mockResolvedValueOnce({
        id: runId, status: "running", coordinator_phase: "running",
        latest_job_id: "failed-job", latest_job_status: "in_progress",
      })
      .mockResolvedValueOnce({
        id: runId, status: "failed", coordinator_phase: "stopped",
        latest_job_id: "failed-job", latest_job_status: "failed",
      });
    const repo = repository({ getRun });
    const service = new CaseApiService(repo, {
      startBackground: vi.fn(),
      status: vi.fn().mockResolvedValue({
        flow_id: "coordinator-flow", job_id: "failed-job", object: "job", status: "failed",
        failure_reason: "A connected Langflow tool returned invalid JSON.",
      }),
    }, { coordinatorFlowId: "coordinator-flow" });

    await expect(service.getRun(runId)).resolves.toMatchObject({
      status: "failed", latest_job_status: "failed", polling: { active: false },
    });
    expect(repo.updateInvocationStatus).toHaveBeenCalledWith(
      "failed-job", "failed", "A connected Langflow tool returned invalid JSON.",
    );
    expect(repo.markExecutionFailed).toHaveBeenCalledWith(runId, "failed-job");
  });

  it.each(["cancelled", "timed_out"])("stops an active run whose latest job was %s", async (jobStatus) => {
    const getRun = vi.fn()
      .mockResolvedValueOnce({
        id: runId, status: "running", coordinator_phase: "running",
        latest_job_id: "stopped-job", latest_job_status: jobStatus,
      })
      .mockResolvedValueOnce({
        id: runId, status: "failed", coordinator_phase: "stopped",
        latest_job_id: "stopped-job", latest_job_status: jobStatus,
      });
    const repo = repository({ getRun });
    const status = vi.fn();
    const service = new CaseApiService(repo, { startBackground: vi.fn(), status },
      { coordinatorFlowId: "coordinator-flow" });

    await expect(service.getRun(runId)).resolves.toMatchObject({ status: "failed" });
    expect(status).not.toHaveBeenCalled();
    expect(repo.markExecutionFailed).toHaveBeenCalledWith(runId, "stopped-job");
  });

  it("resumes the coordinator when a failure after the handoff is recovered", async () => {
    const getRun = vi.fn()
      .mockResolvedValueOnce({
        id: runId, status: "running", coordinator_phase: "running",
        latest_job_id: "failed-job", latest_job_status: "failed",
      })
      .mockResolvedValueOnce({
        id: runId, status: "running", coordinator_phase: "running",
        latest_job_id: "recovery-job", latest_job_status: "queued",
      });
    const repo = repository({
      getRun,
      markExecutionFailed: vi.fn().mockResolvedValue({ recovered: true }),
    });
    const startBackground = vi.fn().mockResolvedValue({
      flow_id: "coordinator-flow", job_id: "recovery-job", object: "job", status: "queued",
      links: { status: "s", events: "e", stop: "x" },
    });
    const service = new CaseApiService(repo, { startBackground, status: vi.fn() },
      { coordinatorFlowId: "coordinator-flow" });

    await expect(service.getRun(runId)).resolves.toMatchObject({ status: "running" });
    expect(startBackground).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: `analysis-recover:${runId}:failed-job`,
    }));
    expect(JSON.parse(startBackground.mock.calls[0]![0].inputValue)).not.toHaveProperty("checkpoint_response");
    expect(repo.recordInvocation).toHaveBeenCalledWith(expect.objectContaining({
      purpose: "analysis_resume", jobId: "recovery-job",
    }));
  });
});
