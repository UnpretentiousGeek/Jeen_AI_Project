"use client";

import { useRef, useState } from "react";
import { Download, FileText, Plus, Trash2, X } from "lucide-react";

import { SearchableSelect } from "@/components/searchable-select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ContextCard, SourceChip } from "@/components/primitives/ContextCards";
import { StatusPill } from "@/components/primitives/StatusPill";
import { caseApi, type ApiDocument, type ApiEvidenceReadiness } from "@/lib/case-api";
import { caseOptionLabel, DOCUMENT_TYPES } from "@/src/case-catalog";
import { titleCase } from "@/lib/utils";

type PendingFile = {
  id: number;
  file: File;
  documentType: string;
};

function documentTypeLabel(value: string) {
  const label = caseOptionLabel(DOCUMENT_TYPES, value);
  return label === value ? titleCase(value) : label;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function CaseEvidencePanel({
  caseId,
  canUpload,
  documents,
  readiness,
  readinessError,
  onUploaded,
  onDeleted,
}: {
  caseId: string;
  canUpload: boolean;
  documents: ApiDocument[];
  readiness: ApiEvidenceReadiness | null;
  readinessError: string | null;
  onUploaded: () => Promise<void>;
  onDeleted: () => Promise<void>;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const evidenceHeadingRef = useRef<HTMLHeadingElement>(null);
  const deleteTriggerRef = useRef<HTMLButtonElement | null>(null);
  const focusEvidenceHeadingAfterCloseRef = useRef(false);
  const nextFileIdRef = useRef(0);
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [documentToDelete, setDocumentToDelete] = useState<ApiDocument | null>(null);
  const [deletingDocumentId, setDeletingDocumentId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<{ documentId: string; message: string } | null>(null);
  const [deleteNotice, setDeleteNotice] = useState<string | null>(null);
  const processingJobs = readiness?.jobs.filter((job) =>
    job.original_filename
    && ["queued", "in_progress", "suspended"].includes(job.status)
    && !documents.some((document) => document.checksum_sha256 === job.checksum_sha256)) ?? [];
  const failedJobs = readiness?.jobs.filter((job) => ["failed", "cancelled", "timed_out"].includes(job.status)) ?? [];
  const jobsByChecksum = new Map(
    (readiness?.jobs ?? []).filter((job) => job.checksum_sha256).map((job) => [job.checksum_sha256, job]),
  );
  const failedDocuments = documents.flatMap((document) => {
    const job = jobsByChecksum.get(document.checksum_sha256);
    return job && ["failed", "cancelled", "timed_out"].includes(job.status) ? [{ document, job }] : [];
  });
  const failedOrphanJobs = failedJobs.filter((job) =>
    !documents.some((document) => document.checksum_sha256 === job.checksum_sha256),
  );
  const hasEvidenceFailure = failedDocuments.length > 0 || failedOrphanJobs.length > 0;

  const confirmDocumentDelete = async () => {
    if (!documentToDelete || deletingDocumentId || !canUpload) return;
    const document = documentToDelete;
    if (["pending", "parsing"].includes(document.ingestion_status)) return;
    const job = jobsByChecksum.get(document.checksum_sha256);
    if (job && ["queued", "in_progress", "suspended"].includes(job.status)) return;

    setDeletingDocumentId(document.id);
    setDeleteError(null);
    setDeleteNotice(null);
    try {
      const result = await caseApi.deleteDocument(caseId, document.id);
      focusEvidenceHeadingAfterCloseRef.current = true;
      setDocumentToDelete(null);

      let refreshError: string | null = null;
      try {
        await onDeleted();
      } catch (error) {
        refreshError = error instanceof Error ? error.message : "Could not refresh the evidence list.";
      }

      const notices: string[] = [];
      if (refreshError) {
        notices.push(`The document was removed, but the evidence list could not be refreshed: ${refreshError}`);
      }
      const cleanupWarning = result.cleanup_warning?.trim();
      if (cleanupWarning) {
        notices.push(`The document was removed from the case, but file cleanup needs attention: ${cleanupWarning}`);
      }
      setDeleteNotice(notices.length > 0 ? notices.join(" ") : null);
    } catch (error) {
      focusEvidenceHeadingAfterCloseRef.current = false;
      setDeleteError({
        documentId: document.id,
        message: error instanceof Error ? error.message : "Could not delete this document.",
      });
      setDocumentToDelete(null);
    } finally {
      setDeletingDocumentId(null);
    }
  };

  const addFiles = (files: FileList | null) => {
    if (!files) return;
    const selected = Array.from(files);
    const valid = selected.filter((file) => file.size > 0 && file.size <= 10 * 1024 * 1024);
    if (valid.length !== selected.length) {
      setError("Each document must be larger than 0 bytes and no more than 10 MB.");
    } else {
      setError(null);
    }
    setPending((current) => [
      ...current,
      ...valid.map((file) => ({ id: nextFileIdRef.current++, file, documentType: "supporting_document" })),
    ]);
  };

  const uploadFiles = async () => {
    if (pending.length === 0 || uploading) return;
    setUploading(true);
    setError(null);
    const failed: PendingFile[] = [];
    const failures: string[] = [];
    for (const item of pending) {
      try {
        await caseApi.uploadEvidence(caseId, [item.file], item.documentType);
      } catch (uploadError) {
        failed.push(item);
        failures.push(`${item.file.name}: ${uploadError instanceof Error ? uploadError.message : "Upload failed."}`);
      }
    }
    setPending(failed);
    if (failures.length > 0) setError(failures.join(" "));
    if (failed.length < pending.length) {
      try {
        await onUploaded();
      } catch (refreshError) {
        setError(refreshError instanceof Error ? refreshError.message : "Could not refresh document status.");
      }
    }
    setUploading(false);
  };

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 ref={evidenceHeadingRef} tabIndex={-1} className="text-xl font-semibold">{documents.length + processingJobs.length} Applicant {documents.length + processingJobs.length === 1 ? "Document" : "Documents"}</h2>
        </div>
        {canUpload && (
          <Button type="button" variant="outline" onClick={() => fileInputRef.current?.click()} disabled={uploading} className="active:scale-100">
            <Plus data-icon="inline-start" />Add Documents
          </Button>
        )}
      </div>
      <p role="status" aria-live="polite" className={deleteNotice ? "mb-4 text-xs leading-5 text-ink-2" : "sr-only"}>
        {deleteNotice}
      </p>

      {canUpload && (
        <>
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.png,.jpg,.jpeg,.txt,.md,.docx"
            multiple
            hidden
            onChange={(event) => {
              addFiles(event.target.files);
              event.target.value = "";
            }}
          />
          {documents.length === 0 && processingJobs.length === 0 && !readinessError && (!readiness || readiness.status === "empty") ? (
            <p className="mb-5 py-8 text-center text-sm text-ink-3">No Evidence Yet</p>
          ) : null}
          {(readinessError || hasEvidenceFailure || (readiness?.status === "failed" && pending.length === 0 && processingJobs.length === 0)) && (
            <Alert variant="destructive" className="mb-5">
              <FileText />
              <AlertTitle>{readinessError ? "Unable to Check Evidence" : "Evidence Needs Attention"}</AlertTitle>
              <AlertDescription>
                {readinessError ? readinessError : hasEvidenceFailure ? (
                  <>
                    {failedDocuments.map(({ document, job }) => (
                      <p key={document.id}>
                        {document.original_filename} could not be processed. {(job.failure_summary?.trim().replace(/[.!?]+$/, "") || "Evidence processing failed")}. Remove this document and add it again to retry.
                      </p>
                    ))}
                    {failedOrphanJobs.map((job) => (
                      <p key={job.job_id}>
                        {job.original_filename ?? "A document"} could not be processed. {(job.failure_summary?.trim().replace(/[.!?]+$/, "") || "Evidence processing failed")}. Add this file again to retry.
                      </p>
                    ))}
                  </>
                ) : failedJobs[0]?.failure_summary
                  ?? (documents.length === 0
                    ? "A previous upload failed before a document was stored. Add the file again."
                    : "A document could not be prepared. Review its status or add another document.")}
              </AlertDescription>
            </Alert>
          )}
          {pending.length > 0 && (
            <fieldset disabled={uploading} aria-label="Documents to add" className="mb-5 rounded-window border border-line-strong bg-surface p-4 shadow-xs">
              <ul className="flex flex-col gap-3">
                {pending.map((item) => (
                  <li key={item.id} className="flex flex-wrap items-center gap-3 rounded-control bg-inset p-3 sm:flex-nowrap">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-control bg-surface text-ink-2" aria-hidden="true"><FileText className="size-4" /></span>
                    <span className="min-w-0 flex-1">
                      <strong className="block truncate text-sm" title={item.file.name}>{item.file.name}</strong>
                      <span className="text-xs text-ink-3">{formatBytes(item.file.size)}</span>
                    </span>
                    <div className="w-full sm:w-56">
                      <SearchableSelect
                        id={`evidence-type-${item.id}`}
                        value={item.documentType}
                        onValueChange={(documentType) => setPending((current) => current.map((file) => file.id === item.id ? { ...file, documentType } : file))}
                        options={DOCUMENT_TYPES}
                        placeholder="Select a Document Type…"
                        searchPlaceholder="Search Document Types…"
                        invalid={false}
                      />
                    </div>
                    <Button type="button" variant="ghost" size="icon-sm" className="active:scale-100" onClick={() => setPending((current) => current.filter((file) => file.id !== item.id))} aria-label={`Remove ${item.file.name}`}>
                      <X className="size-4" />
                    </Button>
                  </li>
                ))}
              </ul>
              <div className="mt-4 flex justify-end">
                <Button type="button" onClick={() => void uploadFiles()} disabled={uploading}>
                  {uploading ? "Adding…" : `Add ${pending.length} ${pending.length === 1 ? "Document" : "Documents"}`}
                </Button>
              </div>
            </fieldset>
          )}
          {error && <Alert variant="destructive" className="mb-5"><AlertTitle>Could not add every document</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
        </>
      )}

      {documents.length > 0 || processingJobs.length > 0 ? (
        <ul className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3" aria-label="Uploaded documents">
          {processingJobs.map((job) => (
            <li key={job.job_id}>
              <ContextCard
                className="h-full"
                title={documentTypeLabel(job.document_type ?? "supporting_document")}
                meta={<StatusPill tone="progress">Processing</StatusPill>}
                footer={<SourceChip name={job.original_filename ?? "Document"} />}
              />
            </li>
          ))}
          {documents.map((document) => {
            const readinessJob = jobsByChecksum.get(document.checksum_sha256);
            const failed = document.ingestion_status === "failed"
              || Boolean(readinessJob && ["failed", "cancelled", "timed_out"].includes(readinessJob.status));
            // Chunks are stored before the fact agent runs, so a ready document can still have an active job.
            const extractingFacts = !failed && document.ingestion_status === "ready"
              && Boolean(readinessJob && ["queued", "in_progress", "suspended"].includes(readinessJob.status));
            const processing = ["pending", "parsing"].includes(document.ingestion_status) || extractingFacts;
            const errorMessage = readinessJob && ["failed", "cancelled", "timed_out"].includes(readinessJob.status)
              ? readinessJob.failure_summary ?? document.ingestion_error
              : document.ingestion_error;
            const unavailableReason = !canUpload
              ? "Documents can only be deleted while the case is a draft."
              : processing
                ? "This document is still processing."
                : deletingDocumentId !== null
                  ? "A document deletion is in progress."
                  : null;

            return (
              <li key={document.id}>
                <ContextCard
                  className="h-full"
                  title={documentTypeLabel(document.document_type)}
                  meta={(
                    <StatusPill tone={failed ? "danger" : processing ? "progress" : "done"}>
                      {failed ? "Failed" : extractingFacts ? "Extracting Facts…" : document.ingestion_status === "ready" ? "Ready" : "Processing"}
                    </StatusPill>
                  )}
                  footer={(
                    <>
                      <SourceChip
                        name={document.original_filename}
                        href={caseApi.documentContentUrl(caseId, document.id)}
                        download={document.original_filename}
                        label={`Download ${document.original_filename}`}
                      />
                      {canUpload && unavailableReason && <span id={`delete-disabled-reason-${document.id}`} className="sr-only">{unavailableReason}</span>}
                      {canUpload && <span className="ml-auto inline-flex" title={unavailableReason ?? undefined}>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Delete ${document.original_filename}`}
                          aria-describedby={unavailableReason ? `delete-disabled-reason-${document.id}` : deleteError?.documentId === document.id ? `delete-error-${document.id}` : undefined}
                          disabled={Boolean(unavailableReason)}
                          onClick={(event) => {
                            if (unavailableReason) return;
                            deleteTriggerRef.current = event.currentTarget;
                            setDeleteError(null);
                            setDeleteNotice(null);
                            setDocumentToDelete(document);
                          }}
                        >
                          <Trash2 aria-hidden="true" />
                        </Button>
                      </span>}
                    </>
                  )}
                >
                  {failed && errorMessage && <p className="text-xs leading-5 text-red">{errorMessage}</p>}
                  {deleteError?.documentId === document.id && (
                    <p id={`delete-error-${document.id}`} role="alert" className="text-xs leading-5 text-red">
                      Could not delete this document: {deleteError.message}
                    </p>
                  )}
                </ContextCard>
              </li>
            );
          })}
        </ul>
      ) : !canUpload && (
        <p className="py-8 text-center text-sm text-ink-3">No Evidence Yet</p>
      )}

      <Dialog
        open={documentToDelete !== null}
        onOpenChange={(open) => {
          if (!open && deletingDocumentId === null) setDocumentToDelete(null);
        }}
      >
          <DialogContent
            showCloseButton={false}
            onEscapeKeyDown={(event) => {
              if (deletingDocumentId) event.preventDefault();
            }}
            onInteractOutside={(event) => {
              if (deletingDocumentId) event.preventDefault();
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (focusEvidenceHeadingAfterCloseRef.current) {
                focusEvidenceHeadingAfterCloseRef.current = false;
                evidenceHeadingRef.current?.focus();
              } else {
                deleteTriggerRef.current?.focus();
              }
            }}
          >
            <DialogHeader>
              <DialogTitle className="break-words">Delete {documentToDelete?.original_filename}?</DialogTitle>
              <DialogDescription>This will remove the document and its evidence from this case.</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={deletingDocumentId !== null}>Cancel</Button>
              </DialogClose>
              <Button type="button" variant="destructive" disabled={deletingDocumentId !== null} onClick={() => void confirmDocumentDelete()}>
                {deletingDocumentId === documentToDelete?.id ? "Deleting…" : "Delete Document"}
              </Button>
            </DialogFooter>
          </DialogContent>
      </Dialog>
    </div>
  );
}
