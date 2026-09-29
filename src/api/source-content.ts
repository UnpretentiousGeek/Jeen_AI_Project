import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { ApiError } from "./service.ts";

export async function readCaseDocument(input: {
  storageRoot: string;
  caseId: string;
  storagePath: string;
  checksumSha256: string;
}): Promise<Buffer> {
  let root: string;
  let file: string;
  try {
    [root, file] = await Promise.all([realpath(input.storageRoot), realpath(input.storagePath)]);
  } catch {
    throw new ApiError(404, "document_content_unavailable", "Document content is unavailable.");
  }
  const relative = path.relative(root, file);
  if (path.isAbsolute(relative) || relative.startsWith(`..${path.sep}`)
    || relative === ".." || relative.split(path.sep)[0] !== input.caseId) {
    throw new ApiError(404, "document_content_unavailable", "Document content is unavailable.");
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch {
    throw new ApiError(404, "document_content_unavailable", "Document content is unavailable.");
  }
  if (createHash("sha256").update(bytes).digest("hex") !== input.checksumSha256) {
    throw new ApiError(409, "document_integrity_error", "Stored document content does not match its recorded checksum.");
  }
  return bytes;
}
