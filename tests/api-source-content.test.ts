import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createApiHandler } from "../src/api/http.js";
import { readCaseDocument } from "../src/api/source-content.js";
import type { CaseApiService } from "../src/api/service.js";

const caseId = "32000000-0000-4000-8000-000000000051";
const documentId = "32000000-0000-4000-8000-000000000052";
const runId = "a7c0b8f7-56ef-4058-b599-ac20e49d6907";
const sourceId = "32000000-0000-4000-8000-000000000053";
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("source access", () => {
  it("downloads the exact case document with its recorded checksum", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kyb-evidence-"));
    temporary.push(root);
    const caseDirectory = path.join(root, caseId);
    await mkdir(caseDirectory);
    const storagePath = path.join(caseDirectory, "document.pdf");
    const bytes = Buffer.from("test PDF content");
    await writeFile(storagePath, bytes);
    const getDocumentForDownload = vi.fn().mockResolvedValue({
      storage_path: storagePath,
      checksum_sha256: createHash("sha256").update(bytes).digest("hex"),
      original_filename: "document.pdf",
      mime_type: "application/pdf",
    });
    const handle = createApiHandler({
      service: { getDocumentForDownload } as unknown as CaseApiService,
      storageRoot: root,
    });

    const response = await handle(new Request(`http://localhost/api/cases/${caseId}/documents/${documentId}/content`));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="document.pdf"');
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect(getDocumentForDownload).toHaveBeenCalledWith(caseId, documentId);
  });

  it("downloads DOCX evidence with its Word MIME type", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kyb-evidence-"));
    temporary.push(root);
    const caseDirectory = path.join(root, caseId);
    await mkdir(caseDirectory);
    const storagePath = path.join(caseDirectory, "certificate.docx");
    const bytes = Buffer.from("sample Word content");
    await writeFile(storagePath, bytes);
    const mimeType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    const handle = createApiHandler({
      service: { getDocumentForDownload: vi.fn().mockResolvedValue({
        storage_path: storagePath,
        checksum_sha256: createHash("sha256").update(bytes).digest("hex"),
        original_filename: "certificate.docx",
        mime_type: mimeType,
      }) } as unknown as CaseApiService,
      storageRoot: root,
    });

    const response = await handle(new Request(`http://localhost/api/cases/${caseId}/documents/${documentId}/content`));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(mimeType);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  });

  it("refuses another case's file, a symlink escape, or altered bytes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kyb-evidence-"));
    temporary.push(root);
    const caseDirectory = path.join(root, caseId);
    const otherDirectory = path.join(root, "other-case");
    await Promise.all([mkdir(caseDirectory), mkdir(otherDirectory)]);
    const bytes = Buffer.from("original");
    const checksumSha256 = createHash("sha256").update(bytes).digest("hex");
    const otherFile = path.join(otherDirectory, "other.pdf");
    await writeFile(otherFile, bytes);
    await expect(readCaseDocument({
      storageRoot: root, caseId, storagePath: otherFile, checksumSha256,
    })).rejects.toMatchObject({ status: 404, code: "document_content_unavailable" });

    const outside = path.join(root, "outside.pdf");
    await writeFile(outside, bytes);
    const link = path.join(caseDirectory, "linked.pdf");
    await symlink(outside, link);
    await expect(readCaseDocument({
      storageRoot: root, caseId, storagePath: link, checksumSha256,
    })).rejects.toMatchObject({ status: 404, code: "document_content_unavailable" });

    const inCase = path.join(caseDirectory, "changed.pdf");
    await writeFile(inCase, "changed");
    await expect(readCaseDocument({
      storageRoot: root, caseId, storagePath: inCase, checksumSha256,
    })).rejects.toMatchObject({ status: 409, code: "document_integrity_error" });
  });

  it("routes a source lookup with run and source identity", async () => {
    const getSource = vi.fn().mockResolvedValue({
      source_kind: "external_web", source_id: sourceId, url: "https://example.com/record",
    });
    const handle = createApiHandler({
      service: { getSource } as unknown as CaseApiService,
      storageRoot: "/tmp",
    });

    const response = await handle(new Request(`http://localhost/api/runs/${runId}/sources/external_web/${sourceId}`));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ url: "https://example.com/record" });
    expect(getSource).toHaveBeenCalledWith(runId, "external_web", sourceId);
  });
});
