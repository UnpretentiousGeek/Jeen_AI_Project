import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createApiHandler } from "../src/api/http.js";
import { ApiError, type CaseApiService } from "../src/api/service.js";

const caseId = "32000000-0000-4000-8000-000000000051";
const docxMimeType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

describe("case readiness and decision routes", () => {
  it("deletes only the matching local evidence copy", async () => {
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), "kyb-evidence-delete-"));
    const caseDirectory = path.join(storageRoot, caseId);
    const documentId = "32000000-0000-4000-8000-000000000053";
    const contents = "draft document to delete";
    const checksumSha256 = createHash("sha256").update(contents).digest("hex");
    try {
      await mkdir(caseDirectory);
      await writeFile(path.join(caseDirectory, "removed.txt"), contents);
      await writeFile(path.join(caseDirectory, "kept.txt"), "another document");
      const deleteDocument = vi.fn().mockResolvedValue({ checksumSha256, cleanupWarning: null });
      const handle = createApiHandler({
        service: { deleteDocument } as unknown as CaseApiService,
        storageRoot,
      });

      const response = await handle(new Request(`http://localhost/api/cases/${caseId}/documents/${documentId}`, {
        method: "DELETE",
      }));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ deleted: true });
      expect(deleteDocument).toHaveBeenCalledWith(caseId, documentId);
      await expect(readFile(path.join(caseDirectory, "removed.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(path.join(caseDirectory, "kept.txt"), "utf8")).resolves.toBe("another document");
    } finally {
      await rm(storageRoot, { recursive: true, force: true });
    }
  });

  it("rejects deletion after analysis begins", async () => {
    const deleteDocument = vi.fn().mockRejectedValue(new Error("evidence_delete_unavailable"));
    const handle = createApiHandler({
      service: { deleteDocument } as unknown as CaseApiService,
      storageRoot: "/tmp",
    });
    const response = await handle(new Request(`http://localhost/api/cases/${caseId}/documents/32000000-0000-4000-8000-000000000053`, {
      method: "DELETE",
    }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "evidence_delete_unavailable" } });
  });

  it("accepts DOCX evidence and still rejects legacy DOC files", async () => {
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), "kyb-docx-upload-"));
    try {
      const uploadEvidence = vi.fn().mockResolvedValue({ ingestion: { status: "queued" } });
      const handle = createApiHandler({
        service: { uploadEvidence } as unknown as CaseApiService,
        storageRoot,
      });
      const docxForm = new FormData();
      docxForm.append("files", new File(["sample"], "certificate.docx", { type: docxMimeType }));
      const accepted = await handle(new Request(`http://localhost/api/cases/${caseId}/evidence`, {
        method: "POST", body: docxForm,
      }));

      expect(accepted.status).toBe(202);
      expect(uploadEvidence).toHaveBeenCalledWith(expect.objectContaining({
        caseId,
        documents: [expect.objectContaining({ original_filename: "certificate.docx", mime_type: docxMimeType })],
      }));

      const docForm = new FormData();
      docForm.append("files", new File(["sample"], "certificate.doc", { type: "application/msword" }));
      const rejected = await handle(new Request(`http://localhost/api/cases/${caseId}/evidence`, {
        method: "POST", body: docForm,
      }));

      expect(rejected.status).toBe(400);
      await expect(rejected.json()).resolves.toMatchObject({ error: { code: "unsupported_evidence_type" } });
      const mismatchedForm = new FormData();
      mismatchedForm.append("files", new File(["sample"], "certificate.doc", { type: docxMimeType }));
      const mismatched = await handle(new Request(`http://localhost/api/cases/${caseId}/evidence`, {
        method: "POST", body: mismatchedForm,
      }));
      expect(mismatched.status).toBe(400);
      expect(uploadEvidence).toHaveBeenCalledTimes(1);
    } finally {
      await rm(storageRoot, { recursive: true, force: true });
    }
  });

  it("returns the case timeline with pagination", async () => {
    const getCaseTimeline = vi.fn().mockResolvedValue({
      events: [{ id: "audit:one", event_type: "case.created" }], has_more: false, limit: 10, offset: 20,
    });
    const handle = createApiHandler({
      service: { getCaseTimeline } as unknown as CaseApiService,
      storageRoot: "/tmp",
    });

    const response = await handle(new Request(`http://localhost/api/cases/${caseId}/timeline?limit=10&offset=20`));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ events: [{ event_type: "case.created" }] });
    expect(getCaseTimeline).toHaveBeenCalledWith(caseId, 10, 20);
  });

  it("exposes evidence readiness for a future intake UI", async () => {
    const getEvidenceReadiness = vi.fn().mockResolvedValue({
      status: "processing", can_start: false, documents: [], jobs: [], poll_after_ms: 2000,
    });
    const handle = createApiHandler({
      service: { getEvidenceReadiness } as unknown as CaseApiService,
      storageRoot: "/tmp",
    });

    const response = await handle(new Request(`http://localhost/api/cases/${caseId}/evidence/status`));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "processing", can_start: false });
    expect(getEvidenceReadiness).toHaveBeenCalledWith(caseId);
  });

  it("routes a final decision separately from a coordinator checkpoint", async () => {
    const recordFinalDecision = vi.fn().mockResolvedValue({ decision: "rejected" });
    const handle = createApiHandler({
      service: { recordFinalDecision } as unknown as CaseApiService,
      storageRoot: "/tmp",
    });
    const body = { analysis_run_id: "a7c0b8f7-56ef-4058-b599-ac20e49d6907", decision: "rejected" };

    const response = await handle(new Request(`http://localhost/api/cases/${caseId}/decision`, {
      method: "POST", body: JSON.stringify(body),
    }));

    expect(response.status).toBe(200);
    expect(recordFinalDecision).toHaveBeenCalledWith(caseId, body);
  });

  it("returns a conflict when analysis starts before ingestion is ready", async () => {
    const startAnalysis = vi.fn().mockRejectedValue(new ApiError(
      409, "evidence_processing", "Wait for evidence ingestion to finish before starting analysis.",
    ));
    const handle = createApiHandler({
      service: { startAnalysis } as unknown as CaseApiService,
      storageRoot: "/tmp",
    });

    const response = await handle(new Request(`http://localhost/api/cases/${caseId}/runs`, {
      method: "POST", body: "{}",
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "evidence_processing" } });
  });
});
