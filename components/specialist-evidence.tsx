"use client";

import { ChevronRight, FileText } from "lucide-react";

import { SourceChip } from "@/components/primitives/ContextCards";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { ApiPolicyComparisonCitation } from "@/lib/case-api";
import type {
  SpecialistEvidence,
  SpecialistEvidenceRow,
  SpecialistEvidenceStatus,
  SpecialistNote,
  SpecialistSourceRef,
} from "@/lib/specialist-evidence";

type ViewCitation = (citation: ApiPolicyComparisonCitation) => void;

const STATUS_BADGE: Record<SpecialistEvidenceStatus, "success" | "destructive" | "warning" | "outline"> = {
  match: "success",
  conflict: "destructive",
  missing: "warning",
  gap: "warning",
  evidenced: "outline",
};

function SourceChips({ sources, onViewCitation }: { sources: SpecialistSourceRef[]; onViewCitation: ViewCitation }) {
  if (sources.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap gap-1" role="group" aria-label="Sources">
      {sources.map(({ citation, label }) => (
        <SourceChip
          key={citation.id}
          name={label}
          kind={citation.source_kind}
          onClick={() => onViewCitation(citation)}
          label={`View ${label}${citation.locator ? ` at ${citation.locator}` : ""}`}
        />
      ))}
    </span>
  );
}

// Agent observations stay collapsed and visibly apart from the validated rows they sit under.
function AgentNotes({ notes, onViewCitation }: { notes: SpecialistNote[]; onViewCitation: ViewCitation }) {
  if (notes.length === 0) return null;
  return (
    <Disclosure summary={
      <span className="flex flex-wrap items-baseline gap-x-2">
        <span>Agent {notes.length === 1 ? "Note" : "Notes"} ({notes.length})</span>
        <span className="text-xs font-normal text-ink-3">Advisory, Not Verified by the System</span>
      </span>
    }>
      <ul className="mt-1 flex flex-col gap-3 border-l-2 border-line pl-3">
        {notes.map((note) => (
          <li key={note.key} className="flex min-w-0 flex-col gap-1">
            <span className="text-xs text-ink-3">{note.kind} · {note.confidence === "high" ? "High" : note.confidence === "medium" ? "Medium" : "Low"} Confidence</span>
            <p className="max-w-[70ch] whitespace-pre-wrap break-words text-sm text-ink-2">{note.statement}</p>
            <SourceChips sources={note.sources} onViewCitation={onViewCitation} />
          </li>
        ))}
      </ul>
    </Disclosure>
  );
}

function EvidenceRow({ row, onViewCitation }: { row: SpecialistEvidenceRow; onViewCitation: ViewCitation }) {
  return (
    <li className="flex min-w-0 flex-col gap-1.5 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">{row.label}</h4>
        <Badge variant={STATUS_BADGE[row.status]}>{row.badge}</Badge>
      </div>
      {row.declared && (
        <p className="break-words text-sm text-ink-2"><span className="text-ink-3">Declared</span> {row.declared}</p>
      )}
      {row.observed.map((item, index) => (
        <div key={index} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {item.value && (
            <p className="break-words text-sm text-ink-2">
              {row.declared && <span className="text-ink-3">Documents </span>}
              {item.value}
            </p>
          )}
          <SourceChips sources={item.sources} onViewCitation={onViewCitation} />
        </div>
      ))}
      {row.detail && <p className="break-words text-sm text-ink-3">{row.detail}</p>}
      {row.resolution && (
        <p className="break-words text-sm text-ink-2">
          <span className="text-ink-3">Analyst Answer</span> {row.resolution.answer}
        </p>
      )}
      <AgentNotes notes={row.notes} onViewCitation={onViewCitation} />
    </li>
  );
}

function Disclosure({ summary, children, defaultOpen = false }: {
  summary: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details open={defaultOpen}>
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-control py-1 text-sm font-medium text-ink-2 hover:text-ink [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden="true" className="size-4 shrink-0 transition-transform [details[open]>summary>&]:rotate-90" />
        {summary}
      </summary>
      {children}
    </details>
  );
}

function SpecialistCard({ evidence, onViewCitation }: { evidence: SpecialistEvidence; onViewCitation: ViewCitation }) {
  const confirmedLabel = evidence.specialty === "entity" ? "Matched Field" : "Evidenced Item";
  return (
    <Card id={`review-result-${evidence.specialty}`} className="scroll-mt-32 gap-0">
      <CardHeader className="gap-1 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <CardTitle><h3 className="text-base">{evidence.title}</h3></CardTitle>
          <CardDescription className="mt-0.5 tabular-nums">{evidence.summary}</CardDescription>
        </div>
        <Badge variant={evidence.status === "partial" ? "warning" : "success"} className="self-start">
          {evidence.status === "partial" ? "Evidence Incomplete" : "Validated"}
        </Badge>
      </CardHeader>
      {(evidence.exceptions.length > 0 || evidence.confirmed.length > 0 || evidence.notes.length > 0) && (
        <CardContent className="pt-2">
          {evidence.exceptions.length > 0 && (
            <ul className="divide-y divide-line">
              {evidence.exceptions.map((row) => <EvidenceRow key={row.key} row={row} onViewCitation={onViewCitation} />)}
            </ul>
          )}
          {evidence.confirmed.length > 0 && (
            <Disclosure summary={`${evidence.confirmed.length} ${confirmedLabel}${evidence.confirmed.length === 1 ? "" : "s"}`}>
              <ul className="divide-y divide-line">
                {evidence.confirmed.map((row) => <EvidenceRow key={row.key} row={row} onViewCitation={onViewCitation} />)}
              </ul>
            </Disclosure>
          )}
          <AgentNotes notes={evidence.notes} onViewCitation={onViewCitation} />
        </CardContent>
      )}
    </Card>
  );
}

// Before final findings exist this is the primary record of validated agent work; afterwards it
// becomes collapsed supporting evidence beneath the findings it informed.
export function SpecialistEvidenceSection({
  evidence,
  supporting,
  onViewCitation,
}: {
  evidence: SpecialistEvidence[];
  supporting: boolean;
  onViewCitation: ViewCitation;
}) {
  if (evidence.length === 0) return null;
  const cards = (
    <div className="mt-3 flex flex-col gap-4">
      {evidence.map((item) => <SpecialistCard key={item.taskId} evidence={item} onViewCitation={onViewCitation} />)}
    </div>
  );

  if (supporting) {
    const exceptionCount = evidence.reduce((total, item) => total + item.exceptions.length, 0);
    return (
      <section className="mt-6" aria-label="Supporting specialist evidence">
        <Disclosure summary={
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <span className="text-ink">Supporting Specialist Evidence</span>
            <span className="font-normal text-ink-3">{evidence.map((item) => `${item.title}: ${item.summary}`).join(" · ")}</span>
          </span>
        } defaultOpen={exceptionCount > 0}>
          {cards}
        </Disclosure>
      </section>
    );
  }

  return (
    <section className="mt-6" aria-labelledby="specialist-evidence-title">
      <h2 id="specialist-evidence-title" className="text-xl font-semibold tracking-[-0.025em]">Specialist Results</h2>
      {cards}
    </section>
  );
}
