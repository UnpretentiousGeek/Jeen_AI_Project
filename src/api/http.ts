import { ZodError } from "zod";

import { openableSourceKindSchema, uuidSchema } from "./contracts.ts";
import { removeCaseEvidenceFiles, removeStoredEvidenceCopies, storeEvidenceFiles } from "./evidence-storage.ts";
import { readCaseDocument } from "./source-content.ts";
import type { CaseAssistantService } from "./assistant-service.ts";
import { ApiError, type CaseApiService } from "./service.ts";
import type { PolicyAssessmentService } from "../policy/assessment-service.ts";
import type { DocumentFactService } from "../facts/extraction-service.ts";
import { WorkflowRejectedError } from "../workflow/langflow-client.ts";

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

async function parseJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ApiError(400, "invalid_json", "Send a valid JSON request body.");
  }
}

function errorResponse(error: unknown): Response {
  if (error instanceof ApiError) {
    return json({ error: { code: error.code, message: error.message } }, error.status);
  }
  if (error instanceof ZodError) {
    return json({
      error: {
        code: "invalid_request",
        message: "Check the request fields and try again.",
        fields: error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
    }, 400);
  }
  const message = error instanceof Error ? error.message : "Unexpected error";
  if (error instanceof WorkflowRejectedError) {
    return json({ error: {
      code: "workflow_rejected",
      message: `Langflow refused the request (HTTP ${error.status})${error.detail ? `: ${error.detail}` : "."}`,
    } }, 502);
  }
  if (message === "workflow_unavailable") {
    return json({ error: {
      code: "workflow_unavailable",
      message: "Langflow is not responding. Start Langflow, then try again.",
    } }, 503);
  }
  if (message === "case_not_found") {
    return json({ error: { code: "case_not_found", message: "Case not found." } }, 404);
  }
  if (message === "case_not_archived") {
    return json({ error: {
      code: "case_not_archived",
      message: "Archive this case before permanently deleting it.",
    } }, 409);
  }
  if (message === "case_analysis_active") {
    return json({ error: {
      code: "case_analysis_active",
      message: "Wait for the active analysis to stop before deleting this case.",
    } }, 409);
  }
  if (message === "evidence_upload_unavailable") {
    return json({ error: {
      code: "evidence_upload_unavailable",
      message: "Evidence can only be added before a new analysis starts.",
    } }, 409);
  }
  if (message === "evidence_delete_unavailable") {
    return json({ error: {
      code: "evidence_delete_unavailable",
      message: "Documents can only be deleted before analysis starts.",
    } }, 409);
  }
  if (message === "document_pinned") {
    return json({ error: {
      code: "document_pinned",
      message: "This document is part of an analysis and cannot be deleted.",
    } }, 409);
  }
  if (message === "evidence_processing") {
    return json({ error: {
      code: "evidence_processing",
      message: "Wait for this document to finish processing before deleting it.",
    } }, 409);
  }
  if (message === "document_checksum_shared") {
    return json({ error: {
      code: "document_checksum_shared",
      message: "This document shares a stored file with another document and cannot be deleted separately.",
    } }, 409);
  }
  return json({
    error: {
      code: "internal_error",
      message: "Unable to complete the request. Try again.",
    },
  }, 500);
}

export function createApiHandler(input: {
  service: CaseApiService;
  assistant?: CaseAssistantService;
  policyAssessments?: PolicyAssessmentService;
  documentFacts?: DocumentFactService;
  storageRoot: string;
}): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      const url = new URL(request.url);
      const segments = url.pathname.split("/").filter(Boolean);
      if (request.method === "GET" && url.pathname === "/api/health") {
        return json({ status: "ok" });
      }
      if (url.pathname === "/api/provider-profile") {
        if (request.method === "GET") return json({ profile: await input.service.getProviderProfile() });
        if (request.method === "PUT") return json({ profile: await input.service.saveProviderProfile(await parseJson(request)) });
      }
      if (request.method === "GET" && url.pathname === "/api/cases") {
        return json({ cases: await input.service.listCases() });
      }
      if (request.method === "POST" && url.pathname === "/api/cases") {
        return json(await input.service.createCase(await parseJson(request)), 201);
      }
      if (segments[0] === "api" && segments[1] === "cases" && segments[2]) {
        const caseId = uuidSchema.parse(segments[2]);
        if (request.method === "DELETE" && segments.length === 3) {
          const deleted = await input.service.deleteCase(caseId);
          let cleanupWarning = deleted.cleanupWarning;
          try {
            await removeCaseEvidenceFiles({ storageRoot: input.storageRoot, caseId: deleted.caseId });
          } catch {
            cleanupWarning = cleanupWarning
              ? `${cleanupWarning} Local evidence files could not be removed.`
              : "The case and its history were deleted, but local evidence files could not be removed.";
          }
          return json({ deleted: true, ...(cleanupWarning ? { cleanup_warning: cleanupWarning } : {}) });
        }
        if (request.method === "PATCH" && segments[3] === "archive" && segments.length === 4) {
          const actorId = request.headers.get("x-actor-id")?.trim() || "local-analyst";
          return json(await input.service.setCaseArchived(caseId, await parseJson(request), actorId));
        }
        if (request.method === "GET" && segments.length === 3) {
          return json(await input.service.getCase(caseId));
        }
        if (request.method === "GET" && segments[3] === "timeline" && segments.length === 4) {
          const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 50;
          const offset = url.searchParams.has("offset") ? Number(url.searchParams.get("offset")) : 0;
          return json(await input.service.getCaseTimeline(caseId, limit, offset));
        }
        if (request.method === "GET" && segments[3] === "documents"
          && segments[5] === "content" && segments.length === 6) {
          const documentId = uuidSchema.parse(segments[4]);
          const document = await input.service.getDocumentForDownload(caseId, documentId);
          const bytes = await readCaseDocument({
            storageRoot: input.storageRoot,
            caseId,
            storagePath: String(document.storage_path),
            checksumSha256: String(document.checksum_sha256),
          });
          const filename = String(document.original_filename).split(/[\\/]/).at(-1)!
            .replaceAll(/[^a-zA-Z0-9._-]/g, "-").slice(0, 160) || "evidence";
          const allowedTypes = new Set(["application/pdf", "image/jpeg", "image/png", "text/plain", "text/markdown", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"]);
          const mimeType = String(document.mime_type);
          return new Response(new Uint8Array(bytes), {
            headers: {
              "content-type": allowedTypes.has(mimeType) ? mimeType : "application/octet-stream",
              "content-disposition": `attachment; filename="${filename}"`,
              "content-length": String(bytes.length),
              "cache-control": "no-store",
              "x-content-type-options": "nosniff",
            },
          });
        }
        if (request.method === "POST" && segments[3] === "documents"
          && segments[5] === "facts" && segments[6] === "extract" && segments.length === 7) {
          if (!input.documentFacts) {
            throw new ApiError(503, "fact_extraction_unavailable", "Document fact extraction is not configured.");
          }
          const documentId = uuidSchema.parse(segments[4]);
          return json(await input.documentFacts.extract(caseId, documentId));
        }
        if (request.method === "DELETE" && segments[3] === "documents" && segments.length === 5) {
          const documentId = uuidSchema.parse(segments[4]);
          const deleted = await input.service.deleteDocument(caseId, documentId);
          let cleanupWarning = deleted.cleanupWarning;
          try {
            await removeStoredEvidenceCopies({
              storageRoot: input.storageRoot,
              caseId,
              checksumSha256: deleted.checksumSha256,
            });
          } catch {
            cleanupWarning = cleanupWarning
              ? `${cleanupWarning} A local copy could not be cleaned up.`
              : "The document record was removed, but a local copy could not be cleaned up.";
          }
          return json({ deleted: true, ...(cleanupWarning ? { cleanup_warning: cleanupWarning } : {}) });
        }
        if (segments[3] === "assistant" && segments[4] === "turns" && segments.length === 5) {
          if (!input.assistant) {
            throw new ApiError(503, "assistant_unavailable", "The case assistant is not configured.");
          }
          if (request.method === "GET") {
            return json(await input.assistant.getConversation(caseId, {
              ...(url.searchParams.has("before") ? { before: url.searchParams.get("before") } : {}),
              ...(url.searchParams.has("limit") ? { limit: url.searchParams.get("limit") } : {}),
            }));
          }
          if (request.method === "POST") {
            const result = await input.assistant.ask(
              caseId, request.headers.get("x-actor-id") || "local-analyst", await parseJson(request),
            );
            return json(result, result.replayed ? 200 : 201);
          }
        }
        if (request.method === "GET" && segments[3] === "evidence" && segments[4] === "status" && segments.length === 5) {
          return json(await input.service.getEvidenceReadiness(caseId));
        }
        if (request.method === "POST" && segments[3] === "evidence" && segments.length === 4) {
          const form = await request.formData();
          const documentType = String(form.get("document_type") ?? "supporting_document").trim();
          if (!documentType) {
            throw new ApiError(400, "document_type_required", "Choose an evidence type.");
          }
          const files = form.getAll("files").filter((value): value is File => value instanceof File);
          const documents = await storeEvidenceFiles({
            storageRoot: input.storageRoot,
            caseId,
            documentType,
            files,
          });
          return json(await input.service.uploadEvidence({
            caseId,
            submittedBy: request.headers.get("x-actor-id") || "local-analyst",
            documents,
          }), 202);
        }
        if (request.method === "POST" && segments[3] === "runs") {
          return json(await input.service.startAnalysis(caseId, await parseJson(request)), 202);
        }
        if (request.method === "POST" && segments[3] === "decision" && segments.length === 4) {
          return json(await input.service.recordFinalDecision(caseId, await parseJson(request)));
        }
      }
      if (segments[0] === "api" && segments[1] === "runs" && segments[2]) {
        const runId = uuidSchema.parse(segments[2]);
        if (request.method === "GET" && segments[3] === "policy-rules" && segments.length === 4) {
          return json({ rules: await input.service.listRuleApplicability(runId) });
        }
        if (request.method === "GET" && segments.length === 3) {
          return json(await input.service.getRun(runId));
        }
        if (segments[3] === "policy-assessments") {
          if (!input.policyAssessments) {
            throw new ApiError(503, "policy_assessment_unavailable", "Policy assessment is not configured.");
          }
          if (segments.length === 4 && request.method === "GET") {
            return json(await input.policyAssessments.list(runId));
          }
          if (segments.length === 5 && segments[4] === "candidates" && request.method === "GET") {
            return json(await input.policyAssessments.listCandidates(runId));
          }
          if (segments.length === 5 && segments[4] === "accepted" && request.method === "GET") {
            return json(await input.policyAssessments.listAccepted(runId));
          }
          if (segments.length === 4 && request.method === "POST") {
            return json(await input.policyAssessments.generate(runId, await parseJson(request)), 201);
          }
          if (segments.length === 5 && segments[4] === "batch" && request.method === "POST") {
            return json(await input.policyAssessments.generateAll(runId));
          }
          if (segments.length === 6 && segments[5] === "review" && request.method === "POST") {
            const proposalId = uuidSchema.parse(segments[4]);
            const actorId = request.headers.get("x-actor-id")?.trim() || "local-analyst";
            return json(await input.policyAssessments.review(
              runId, proposalId, actorId, await parseJson(request),
            ));
          }
        }
        if (request.method === "GET" && segments[3] === "sources" && segments.length === 6) {
          const sourceKind = openableSourceKindSchema.parse(segments[4]);
          const sourceId = uuidSchema.parse(segments[5]);
          return json(await input.service.getSource(runId, sourceKind, sourceId));
        }
        if (request.method === "POST" && segments[3] === "responses") {
          return json(await input.service.submitCheckpoint(runId, await parseJson(request)), 202);
        }
      }
      return json({ error: { code: "not_found", message: "Endpoint not found." } }, 404);
    } catch (error) {
      return errorResponse(error);
    }
  };
}
