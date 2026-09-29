import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { UploadedEvidence } from "./contracts.ts";
import { ApiError } from "./service.ts";

const allowedMimeTypes = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "text/plain",
  "text/markdown",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

function safeFilename(filename: string): string {
  return path.basename(filename).replaceAll(/[^a-zA-Z0-9._-]/g, "-").slice(0, 160) || "evidence";
}

export async function storeEvidenceFiles(input: {
  storageRoot: string;
  caseId: string;
  documentType: string;
  files: File[];
  maxFileBytes?: number;
}): Promise<UploadedEvidence[]> {
  const maxFileBytes = input.maxFileBytes ?? 10 * 1024 * 1024;
  const targetDirectory = path.resolve(input.storageRoot, input.caseId);
  await mkdir(targetDirectory, { recursive: true });
  const stored: UploadedEvidence[] = [];
  for (const file of input.files) {
    if (file.size === 0 || file.size > maxFileBytes) {
      throw new ApiError(400, "invalid_evidence_size", "Each evidence file must be between 1 byte and 10 MB.");
    }
    const mimeType = file.type || "application/octet-stream";
    if (!allowedMimeTypes.has(mimeType)
      || (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        && path.extname(file.name).toLowerCase() !== ".docx")) {
      throw new ApiError(400, "unsupported_evidence_type", "Upload a PDF, PNG, JPEG, plain-text, Markdown, or DOCX file.");
    }
    const bytes = Buffer.from(await file.arrayBuffer());
    const originalFilename = safeFilename(file.name);
    const storagePath = path.join(targetDirectory, `${randomUUID()}-${originalFilename}`);
    await writeFile(storagePath, bytes, { flag: "wx", mode: 0o600 });
    stored.push({
      document_type: input.documentType,
      original_filename: originalFilename,
      mime_type: mimeType,
      checksum_sha256: createHash("sha256").update(bytes).digest("hex"),
      storage_path: storagePath,
    });
  }
  return stored;
}

export async function removeStoredEvidenceCopies(input: {
  storageRoot: string;
  caseId: string;
  checksumSha256: string;
}): Promise<void> {
  const directory = path.resolve(input.storageRoot, input.caseId);
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = path.join(directory, entry.name);
    const checksum = createHash("sha256").update(await readFile(filePath)).digest("hex");
    if (checksum === input.checksumSha256) await unlink(filePath);
  }
}

export async function removeCaseEvidenceFiles(input: {
  storageRoot: string;
  caseId: string;
}): Promise<void> {
  const root = path.resolve(input.storageRoot);
  const directory = path.resolve(root, input.caseId);
  if (path.dirname(directory) !== root) throw new Error("invalid_case_storage_directory");

  const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    if (entry.isFile()) await unlink(path.join(directory, entry.name));
  }
  await rmdir(directory).catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  });
}
