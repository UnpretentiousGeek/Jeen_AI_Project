"use client";

import { useEffect, useState } from "react";
import { Download, ExternalLink, FileText, LoaderCircle } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SourceExcerpt, SourcePassage } from "@/components/ui/source-text";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { caseApi, type ApiCitation, type ApiOpenableSourceKind, type ApiSourceContent } from "@/lib/case-api";
import { caseOptionLabel, DOCUMENT_TYPES } from "@/src/case-catalog";
import { titleCase } from "@/lib/utils";
import { isRegistryRead, readableLocator } from "@/lib/source-excerpt";

type CitationSourceDialogProps = {
  runId: string | null;
  citation: ApiCitation | null;
  onOpenChange: (open: boolean) => void;
};

type LookupState =
  | { targetKey: string | null; status: "loading" }
  | { targetKey: string | null; status: "loaded"; source: ApiSourceContent }
  | { targetKey: string | null; status: "error" };

function isOpenableSourceKind(kind: string): kind is ApiOpenableSourceKind {
  return kind === "case_document" || kind === "policy" || kind === "external_web";
}

function sourceKindLabel(kind: ApiOpenableSourceKind): string {
  if (kind === "case_document") return "Case document";
  if (kind === "external_web") return "Public web source";
  return "Policy passage";
}

function formatDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

const RETRIEVAL_METHOD_LABELS: Record<string, string> = {
  tinyfish_fetch: "Web Page Fetch",
  tinyfish_search: "Web Search Result",
  firecrawl_search: "Web Search Result",
};

const GLEIF_RECORD_API = /^https:\/\/api\.gleif\.org\/api\/v1\/lei-records\/([A-Z0-9]{20})$/;

/** Where a reviewer reads a source: a GLEIF API record opens on GLEIF's own record page. */
function readableSourceUrl(url: string): string {
  const lei = GLEIF_RECORD_API.exec(url)?.[1];
  return lei ? `https://search.gleif.org/#/record/${lei}` : url;
}

const FILE_FORMAT_LABELS: Record<string, string> = {
  "application/pdf": "PDF",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word document",
  "application/msword": "Word document",
  "image/png": "PNG image",
  "image/jpeg": "JPEG image",
  "text/plain": "Text file",
};

function fileFormatLabel(mimeType: string | null | undefined): string | null {
  if (!mimeType) return null;
  return FILE_FORMAT_LABELS[mimeType] ?? mimeType;
}

function documentTypeLabel(value: string): string {
  const label = caseOptionLabel(DOCUMENT_TYPES, value);
  return label === value ? titleCase(value) : label;
}

function SourceMetadata({ source }: { source: ApiSourceContent }) {
  const entries: Array<[string, string | null]> = [];
  if (source.source_kind === "case_document") {
    // source_metadata holds ingestion internals (parser, chunk count, fact extraction), so only reviewer-facing fields are shown.
    entries.push(
      ["Page", source.page_number == null ? null : String(source.page_number)],
      ["Document type", documentTypeLabel(source.document_type)],
      ["Format", fileFormatLabel(source.mime_type)],
    );
  } else if (source.source_kind === "policy") {
    entries.push(
      ["Policy", `${source.policy_code} · ${source.policy_title}`],
      ["Version", source.version],
      ["Effective from", formatDate(source.effective_from)],
      ["Effective to", formatDate(source.effective_to)],
    );
  } else {
    entries.push(
      ["Publisher", source.publisher],
      ["Published", formatDate(source.published_at)],
      ["Retrieved", formatDate(source.retrieved_at)],
      ["Retrieval method", isRegistryRead(source.retrieval_method, source.excerpt)
        ? "Registry API"
        : RETRIEVAL_METHOD_LABELS[source.retrieval_method] ?? titleCase(source.retrieval_method)],
    );
  }
  // A web source's locator is its URL, linked below the passage.
  const location = source.source_kind === "external_web" ? "" : readableLocator(source.locator);
  if (location) entries.unshift(["Location", location]);

  const visibleEntries = entries.filter((entry): entry is [string, string] => Boolean(entry[1]));
  if (visibleEntries.length === 0) return null;

  return (
    <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
      {visibleEntries.map(([label, value]) => (
        <div key={label} className="flex min-w-0 gap-1">
          <dt className="capitalize text-ink-3">{label}</dt>
          <dd className="break-words text-ink-2">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function CitationSourceDialog({ runId, citation, onOpenChange }: CitationSourceDialogProps) {
  const [lookup, setLookup] = useState<LookupState>({ targetKey: null, status: "loading" });
  const sourceKind = citation && isOpenableSourceKind(citation.source_kind) ? citation.source_kind : null;
  const sourceId = citation?.source_id ?? null;
  const targetKey = runId && sourceKind && sourceId
    ? JSON.stringify([runId, sourceKind, sourceId])
    : null;
  const canLookup = targetKey !== null;

  useEffect(() => {
    if (!runId || !sourceKind || !sourceId || !targetKey) {
      setLookup({ targetKey, status: "error" });
      return;
    }

    let active = true;
    setLookup({ targetKey, status: "loading" });
    void caseApi.getSource(runId, sourceKind, sourceId)
      .then((source) => {
        if (active) setLookup({ targetKey, status: "loaded", source });
      })
      .catch(() => {
        if (active) setLookup({ targetKey, status: "error" });
      });

    return () => {
      active = false;
    };
  }, [runId, sourceId, sourceKind, targetKey]);

  // Effects run after render. Hide the previous lookup immediately when the
  // selected case or citation changes, before the new request starts.
  const visibleLookup = lookup.targetKey === targetKey
    ? lookup
    : targetKey
      ? { targetKey, status: "loading" as const }
      : { targetKey, status: "error" as const };
  const source = visibleLookup.status === "loaded" ? visibleLookup.source : null;
  const title = source?.source_kind === "case_document"
    ? source.original_filename
    : source?.source_kind === "policy"
      ? source.policy_title
      : source?.source_kind === "external_web"
        ? source.title
        : citation?.original_filename ?? citation?.policy_title ?? citation?.web_title ?? "Cited source";
  const sourceText = source?.source_kind === "external_web" ? source.excerpt : source?.content;
  const externalUrl = source?.source_kind === "external_web" ? safeHttpUrl(readableSourceUrl(source.url)) : null;
  const registryRecord = source?.source_kind === "external_web" && isRegistryRead(source.retrieval_method, source.excerpt);
  const locator = sourceKind === "external_web" ? "" : readableLocator(citation?.locator);
  const contentUrl = source?.source_kind === "case_document" ? source.content_url : null;

  return (
    <Dialog open={citation !== null} onOpenChange={onOpenChange}>
      {citation && (
        <DialogContent className="max-h-[85vh] overflow-y-auto overscroll-contain sm:max-w-2xl">
          <DialogHeader>
            <div className="flex flex-wrap items-center gap-2">
              {sourceKind && <Badge variant="outline">{sourceKindLabel(sourceKind)}</Badge>}
              {locator && <span className="text-xs text-ink-3">{locator}</span>}
            </div>
            <DialogTitle className="break-words">{title}</DialogTitle>
            <DialogDescription className="sr-only">
              Run-scoped source content for this analysis citation.
            </DialogDescription>
          </DialogHeader>

          {visibleLookup.status === "loading" && (
            <div className="flex items-center gap-3 rounded-card border border-line bg-inset px-4 py-5 text-sm text-ink-2" role="status" aria-live="polite">
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
              Loading source content…
            </div>
          )}

          {visibleLookup.status === "error" && (
            <Alert variant="info">
              <FileText aria-hidden="true" />
              <AlertTitle>Source content unavailable</AlertTitle>
              <AlertDescription>
                This citation could not be opened from the selected analysis run. The stored passage from this citation is shown below.
              </AlertDescription>
            </Alert>
          )}

          {source && <SourceMetadata source={source} />}

          {sourceText && (
            <section aria-label={visibleLookup.status === "error" ? "Stored cited passage" : "Source passage"} className="flex flex-col gap-3">
              <blockquote className="border-l-2 border-line pl-4">
                <SourcePassage>{sourceText}</SourcePassage>
              </blockquote>
            </section>
          )}

          {visibleLookup.status === "error" && citation.excerpt && !sourceText && (
            <blockquote className="border-l-2 border-line pl-4 text-sm leading-relaxed text-ink-2">
              <SourceExcerpt>{citation.excerpt}</SourceExcerpt>
            </blockquote>
          )}

          {source?.source_kind === "external_web" && externalUrl && (
            <a href={externalUrl} target="_blank" rel="noreferrer" className="inline-flex w-fit items-center gap-2 text-sm font-medium text-accent-ink underline-offset-4 hover:underline">
              <ExternalLink className="size-4" aria-hidden="true" />
              {registryRecord ? "Open Registry Record" : "Open Original Web Page"}
            </a>
          )}

          {contentUrl && (
            <DialogFooter>
              <Button asChild variant="outline">
                <a href={contentUrl} download={source?.source_kind === "case_document" ? source.original_filename : undefined}>
                  <Download data-icon="inline-start" />
                  Download Original Document
                </a>
              </Button>
            </DialogFooter>
          )}
          {!canLookup && visibleLookup.status === "error" && !citation.excerpt && (
            <p className="sr-only">No stored excerpt is available for this citation.</p>
          )}
        </DialogContent>
      )}
    </Dialog>
  );
}
