"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Archive,
  ArrowLeft,
  Building2,
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileText,
  Globe2,
  MessageSquare,
  Plus,
  Trash2,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  ArchiveRestore,
  Users,
  X,
  Activity as ActivityIcon,
  Inbox,
  Settings,
  SquarePen,
} from "lucide-react";

import ApprovalCard, { type ApprovalOptionDetail, type ApprovalOptionSource, type ApprovalQuestion, type ApprovalResult } from "@/components/primitives/ApprovalCard";
import SidebarNav from "@/components/primitives/SidebarNav";
import CodeBlock from "@/components/primitives/CodeBlock";
import { ContextCard, SourceChip } from "@/components/primitives/ContextCards";
import FilterTable, { StatusPill, type FilterChip, type FilterTableColumn, type StatusTone } from "@/components/primitives/FilterTable";
import { DecisionBody, DecisionDialog, DecisionFooter, skipForNowOption, type DecisionOption } from "@/components/primitives/DecisionDialog";
import TaskRows, { type TaskRow } from "@/components/primitives/TaskRows";
import LoadingState from "@/components/primitives/LoadingState";
import { CaseAssistantDialog } from "@/components/case-assistant-dialog";
import { CitationSourceDialog } from "@/components/citation-source-dialog";
import { CaseEvidencePanel } from "@/components/case-evidence-panel";
import { PolicyAssessmentReview } from "@/components/policy-assessment-review";
import { NewCaseIntake, type NewCaseDraft, type NewCaseEvidenceUpload } from "@/components/new-case-intake";
import { ProviderSettings } from "@/components/provider-settings";
import { SpecialistEvidenceSection } from "@/components/specialist-evidence";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { SourceExcerpt } from "@/components/ui/source-text";
import { isRegistryRead, readableLocator } from "@/lib/source-excerpt";
import {
  caseApi,
  type ApiCaseDetail,
  type ApiCaseTimelineEvent,
  type ApiCitation,
  type ApiCaseSummary,
  type ApiEvidenceReadiness,
  type ApiPolicyComparison,
  type ApiPolicyComparisonCitation,
  type ApiPolicyComparisonRequirement,
  type ApiPolicyEvidenceReference,
  type ApiPolicyRule,
  type ApiRun,
} from "@/lib/case-api";
import { BUSINESS_TYPES, CASE_STATUSES_OPEN_FOR_ANALYSIS, JURISDICTIONS, PRODUCTS, caseOptionLabel } from "@/src/case-catalog";
import { specialistEvidence, specialistSources, type SpecialistSourceRef } from "@/lib/specialist-evidence";
import { cn, titleCase } from "@/lib/utils";

type CaseStatus = "Draft" | "Ready for Review" | "Approval Needed" | "Input Needed" | "Processing" | "Completed" | "Attention Needed" | "Enhanced Review";
type CaseListScope = "all" | "drafts" | "archived";

type CaseItem = {
  id: string;
  name: string;
  reference: string;
  status: CaseStatus;
  jurisdiction: string;
  businessType: string;
  product: string;
  archivedAt: string | null;
  runStatus: string | null;
  coordinatorPhase: string | null;
  backendStatus: string;
  analysisRunId: string | null;
  checkpointKind: string | null;
  evidenceCount: number;
  findingCount: number;
};

type PortfolioActivityTarget = { caseId: string; runId: string };
type PortfolioActivityRunState = { runId: string; run: ApiRun | null; loading: boolean; error: string | null };

const CASES_NEEDING_ANALYST_ATTENTION = new Set<CaseStatus>([
  "Ready for Review",
  "Approval Needed",
  "Input Needed",
  "Attention Needed",
  "Enhanced Review",
]);

function displayStatus(status: string, checkpointKind: string | null): CaseStatus {
  if (status === "draft") return "Draft";
  if (status === "processing") return "Processing";
  if (status === "ready_for_review" || status === "under_review") return "Ready for Review";
  if (status === "completed") return "Completed";
  if (status === "attention_required") return "Attention Needed";
  if (status === "enhanced_review") return "Enhanced Review";
  if (status === "awaiting_information" || status === "awaiting_approval") {
    return checkpointKind === "search_execution_approval" || checkpointKind === "analyst_approval" || checkpointKind === "web_result_review"
      ? "Approval Needed"
      : "Input Needed";
  }
  return "Processing";
}

function toCaseItem(value: ApiCaseSummary): CaseItem {
  return {
    id: value.id,
    name: value.legal_name,
    reference: value.reference,
    status: displayStatus(value.status, value.pending_checkpoint_kind),
    jurisdiction: value.jurisdiction,
    businessType: value.business_type,
    product: value.product,
    archivedAt: value.archived_at,
    runStatus: value.run_status,
    coordinatorPhase: value.coordinator_phase,
    backendStatus: value.status,
    analysisRunId: value.analysis_run_id,
    checkpointKind: value.pending_checkpoint_kind,
    evidenceCount: value.evidence_count,
    findingCount: value.finding_count,
  };
}

function isAnalyzing(item: CaseItem): boolean {
  return item.runStatus === "queued" || item.runStatus === "running" || item.coordinatorPhase === "running";
}

function statusTone(status: CaseStatus): StatusTone {
  if (status === "Completed" || status === "Ready for Review") return "done";
  if (status === "Attention Needed") return "danger";
  if (status === "Enhanced Review") return "todo";
  if (status === "Approval Needed" || status === "Input Needed") return "todo";
  if (status === "Processing") return "progress";
  return "neutral";
}

function caseAction(status: CaseStatus, checkpointKind?: string | null) {
  if (status === "Approval Needed") {
    if (checkpointKind === "analyst_approval") return "Review Handoff";
    if (checkpointKind === "web_result_review") return "Review Search Results";
    return "Review Tool Request";
  }
  if (status === "Input Needed") return "Answer Agent";
  if (status === "Processing") return "View Progress";
  if (status === "Completed") return "View Decision";
  if (status === "Draft") return "Start Analysis";
  if (status === "Attention Needed") return "Review Issue";
  if (status === "Enhanced Review") return "Review Escalation";
  return "Review Package";
}

// Actions that carry the analyst's answer forward are offered first; the rest are alternatives.
const PRIMARY_INPUT_ACTIONS = new Set(["submit_clarification", "retry", "continue_without_evidence"]);

function actionLabel(action: string, checkpointKind?: string | null): string {
  if (action === "approve" && checkpointKind === "analyst_approval") {
    return "Mark Ready for Review";
  }
  if (action === "reject" && checkpointKind === "analyst_approval") {
    return "Reject and Stop Analysis";
  }
  if (action === "approve" && checkpointKind === "search_execution_approval") {
    return "Approve Search";
  }
  if (action === "changes_requested" && checkpointKind === "search_execution_approval") {
    return "Request Changes";
  }
  if (action === "reject" && checkpointKind === "search_execution_approval") {
    return "Reject Search";
  }
  if (action === "reject" && checkpointKind === "information_request") {
    return "Reject Request";
  }
  const labels: Record<string, string> = {
    approve: "Approve",
    changes_requested: "Request Changes",
    reject: "Reject",
    skip_for_now: "Skip for Now",
    submit_clarification: "Send Answer",
    escalate: "Escalate",
    continue_without_evidence: "Continue Without Verification",
    retry: "Retry Specialist",
    abort: "Stop Analysis",
    accept: "Accept Results",
  };
  return labels[action] ?? titleCase(action);
}

type SearchExecutionScope = {
  evidenceGapId: string;
  claim: string;
  query: string;
  allowedDomains: string[];
  disclosedApplicantFields: string[];
  resultLimit: number;
  rationale: string;
};

type WebReviewResult = {
  id: string;
  title: string;
  publisher: string;
  url: string | null;
};

type PreviousSearchDecision = {
  unresolvedQuestion: string;
  rationale: string | null;
  rejectedAt: string | null;
};

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

const comparableText = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Agent-authored texts often restate one another (a plan summary, a result summary and a live
// update can all carry the same sentence). Keeps each distinct text once, in priority order, and
// drops any text that repeats or is contained in one already kept.
function distinctTexts(values: (string | null | undefined)[]): (string | null)[] {
  const kept: string[] = [];
  return values.map((value) => {
    const text = textValue(value);
    if (!text) return null;
    const comparable = comparableText(text);
    if (kept.some((existing) => existing.includes(comparable) || comparable.includes(existing))) return null;
    kept.push(comparable);
    return text;
  });
}

function textList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function searchExecutionScope(payload: Record<string, unknown> | undefined): SearchExecutionScope | null {
  const scope = objectValue(payload?.approved_scope);
  if (!scope) return null;
  const evidenceGapId = textValue(scope.evidence_gap_id);
  const claim = textValue(scope.claim);
  const query = textValue(scope.query);
  const allowedDomains = textList(scope.allowed_domains);
  const disclosedApplicantFields = textList(scope.disclosed_applicant_fields);
  const resultLimit = typeof scope.result_limit === "number" ? scope.result_limit : null;
  const rationale = textValue(scope.rationale);
  if (!evidenceGapId || !claim || !query || allowedDomains.length === 0
    || disclosedApplicantFields.length === 0 || resultLimit === null || !rationale) return null;
  return {
    evidenceGapId,
    claim,
    query,
    allowedDomains,
    disclosedApplicantFields,
    resultLimit,
    rationale,
  };
}

function webReviewResults(payload: Record<string, unknown> | undefined): WebReviewResult[] {
  const values = Array.isArray(payload?.pending_results)
    ? payload.pending_results
    : Array.isArray(payload?.results) ? payload.results : [];

  const results: WebReviewResult[] = [];
  const seenIds = new Set<string>();
  for (const value of values) {
    const result = objectValue(value);
    const id = textValue(result?.result_id) ?? textValue(result?.web_result_id);
    if (!id || !result || seenIds.has(id)) return [];
    seenIds.add(id);
    results.push({
      id,
      title: textValue(result.title) ?? "Untitled Search Result",
      publisher: textValue(result.publisher) ?? "Publisher Not Provided",
      url: textValue(result.url),
    });
  }
  return results;
}

function previousSearchDecisions(run: ApiRun | null, scope: SearchExecutionScope | null): PreviousSearchDecision[] {
  if (!run || !scope?.evidenceGapId) return [];
  const coordinatorState = objectValue(run.coordinator_state);
  const rejectedSearches = Array.isArray(coordinatorState?.rejected_searches)
    ? coordinatorState.rejected_searches
    : [];
  const evidenceGap = run.evidence_gaps.find((gap) => gap.id === scope.evidenceGapId);
  const unresolvedQuestion = textValue(evidenceGap?.description)
    ?? textValue(evidenceGap?.requested_evidence)
    ?? scope.claim
    ?? "The related evidence gap is still unresolved.";

  return rejectedSearches.flatMap((value) => {
    const rejectedSearch = objectValue(value);
    if (!rejectedSearch || rejectedSearch.evidence_gap_id !== scope.evidenceGapId) return [];
    return [{
      unresolvedQuestion,
      rationale: textValue(rejectedSearch.rationale),
      rejectedAt: textValue(rejectedSearch.rejected_at),
    }];
  });
}

function safeWebUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

type ReviewStepStatus = NonNullable<ApiRun["review_path"]>["steps"][number]["status"];

function reviewStepVariant(status: ReviewStepStatus): "success" | "info" | "destructive" | "warning" | "outline" {
  if (status === "completed") return "success";
  if (status === "working") return "info";
  if (status === "failed") return "destructive";
  if (status === "input_required") return "warning";
  return "outline";
}

function reviewStepLabel(status: ReviewStepStatus): string {
  return titleCase(status);
}


function timelineDetails(details: Record<string, unknown>): Array<{ key: string; label: string; value: string }> {
  const entries: Array<{ key: string; label: string; value: string }> = [];
  const visit = (value: unknown, path: string, key: string) => {
    if (value == null) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, path, `${key}-${index}`));
      return;
    }
    if (typeof value === "object") {
      Object.entries(value).forEach(([name, item]) => {
        const childPath = path ? `${path}.${name}` : name;
        visit(item, childPath, `${key}-${name}`);
      });
      return;
    }
    const label = path.split(".").map((part) => part.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase())).join(" / ");
    entries.push({ key, label, value: String(value) });
  };
  Object.entries(details).forEach(([name, value]) => visit(value, name, name));
  return entries;
}

function timelineDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
}

/** Splits event details into short facts and structured payloads (objects, or strings holding JSON) shown as code. */
function auditDetails(details: Record<string, unknown>) {
  const facts: Record<string, unknown> = {};
  const payloads: { name: string; code: string }[] = [];
  for (const [name, value] of Object.entries(details)) {
    if (value !== null && typeof value === "object") {
      payloads.push({ name, code: JSON.stringify(value, null, 2) });
      continue;
    }
    if (typeof value === "string" && /^\s*[[{]/.test(value)) {
      try {
        payloads.push({ name, code: JSON.stringify(JSON.parse(value), null, 2) });
        continue;
      } catch {
        // Not JSON after all; show it as text.
      }
    }
    facts[name] = value;
  }
  return { facts: timelineDetails(facts), payloads };
}

function AuditEventRow({ event }: { event: ApiCaseTimelineEvent }) {
  const [open, setOpen] = useState(false);
  const detailsId = useId().replaceAll(":", "");
  const { facts, payloads } = auditDetails(event.details ?? {});
  const expandable = facts.length > 0 || payloads.length > 0;
  const header = (
    <>
      <time dateTime={event.occurred_at} className="text-xs tabular-nums text-ink-3">{timelineDate(event.occurred_at)}</time>
      <code className="min-w-0 truncate font-mono text-xs text-ink">{event.event_type}</code>
      <span className="min-w-0 truncate text-xs text-ink-2">
        {titleCase(event.actor_type)}{event.actor_id ? ` · ${event.actor_id}` : ""}
        {event.analysis_run_id && <span className="text-ink-3" title={event.analysis_run_id}> · Run {event.analysis_run_id.slice(0, 8)}</span>}
      </span>
      {expandable
        ? <ChevronDown aria-hidden="true" className={`size-4 text-ink-3 transition-transform duration-300 motion-reduce:transition-none ${open ? "rotate-180" : ""}`} />
        : <span />}
    </>
  );
  const headerClass = "grid w-full grid-cols-[minmax(150px,0.8fr)_minmax(0,1fr)_minmax(0,1.2fr)_16px] items-center gap-4 px-4 py-3 text-left";
  return (
    <li className="border-b border-line last:border-0">
      {expandable ? (
        <button type="button" aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen((current) => !current)}
          className={`${headerClass} transition-colors hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent`}>
          {header}
        </button>
      ) : <div className={headerClass}>{header}</div>}
      {expandable && (
        <div id={detailsId} hidden={!open} className="flex flex-col gap-3 border-t border-line bg-inset/40 px-4 py-4">
          {open && facts.length > 0 && (
            <dl className="grid gap-x-4 gap-y-1.5 sm:grid-cols-[minmax(120px,auto)_minmax(0,1fr)]">
              {facts.map((detail) => (
                <div key={detail.key} className="contents">
                  <dt className="text-[11.5px] text-ink-3">{detail.label}</dt>
                  <dd className="wrap-anywhere text-xs text-ink-2">{detail.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {open && payloads.map((payload) => (
            <CodeBlock key={payload.name} filename={`${payload.name}.json`} code={payload.code} />
          ))}
        </div>
      )}
    </li>
  );
}

function taskRowsFor(run: ApiRun | null): TaskRow[] {
  const tasks = run?.agent_activity?.tasks ?? [];
  return tasks.map((task) => {
    const failureReason = task.failure_reason
      ?? (task.status === "failed" && task.role === "coordinator"
        ? textValue(run?.latest_job_failure_reason)
        : null);
    const failureDetail = { label: "Failure Reason", value: failureReason };
    const textDetails = [
      failureDetail,
      { label: "Current Update", value: textValue(task.current_summary) },
      { label: "Completed Summary", value: textValue(task.completed_summary) },
      { label: "Waiting For", value: textValue(task.waiting_for) },
      { label: "Next Step", value: textValue(task.next_summary) },
    ];
    const summaryDetail = task.status === "failed" && failureReason
      ? failureDetail
      : textDetails.slice(1).find((detail) => detail.value) ?? null;
    const details = textDetails
      .filter((detail) => detail !== summaryDetail && detail.value)
      .map((detail) => ({ label: detail.label, value: detail.value! }));

    return {
      key: task.id,
      label: titleCase(task.label),
      status: task.status,
      summary: summaryDetail?.value ?? null,
      details,
    };
  });
}

function policyRequirementStatus(status: ApiPolicyComparisonRequirement["status"]): {
  label: string;
  variant: "success" | "warning" | "destructive";
} {
  if (status === "supported") return { label: "Supported", variant: "success" };
  if (status === "conflicting") return { label: "Conflicting", variant: "destructive" };
  return { label: "Unsupported", variant: "warning" };
}

function policyComparisonCitation(citation: ApiPolicyComparisonCitation): ApiCitation {
  return {
    id: citation.id,
    finding_id: null,
    evidence_gap_id: null,
    conflict_id: null,
    source_kind: citation.source_kind,
    // The run-scoped source route resolves citation chunks, not their parent document or policy version.
    source_id: citation.chunk_id,
    locator: citation.locator,
    excerpt: citation.excerpt,
    document_id: null,
    original_filename: null,
    policy_code: null,
    policy_title: null,
    policy_version: null,
    web_title: null,
    web_publisher: null,
    web_url: null,
    web_retrieved_at: null,
    web_retrieval_method: null,
  };
}

function policyComparisonStatusMessage(
  policyTask: ApiRun["agent_activity"]["tasks"][number] | null,
  needsAttention: boolean,
  coordinatorFailed: boolean,
  policyReviewAttempt: number | null,
): string {
  if (policyReviewAttempt !== null) {
    return policyReviewAttempt >= 3
      ? "The Policy Specialist Has Used All Three Attempts. Stop This Run and Start a New Analysis to Continue Policy Review."
      : "The Policy Specialist Is Waiting for a Cited Assessment to Be Accepted and Retried.";
  }
  if (coordinatorFailed && policyTask?.status === "working") {
    return "The Coordinator Failed while the Policy Specialist Still Shows as Working. No Validated Policy Comparison Is Available. Review Agent Activity for Details.";
  }
  if (needsAttention) {
    return "This Case Needs Attention. No Validated Policy Comparison Is Available for This Run. Review Agent Activity for Details.";
  }
  if (!policyTask) return "No Validated Policy Comparison Is Available for This Run.";
  if (policyTask.status === "working") {
    return "The Policy Specialist Is Working. A Comparison Will Appear after Its Result Is Validated.";
  }
  if (policyTask.status === "queued") {
    return "The Policy Specialist Is Queued. A Comparison Will Appear after Its Result Is Validated.";
  }
  if (policyTask.status === "waiting") {
    return policyTask.waiting_for
      ? `The Policy Specialist Is Waiting for ${policyTask.waiting_for}. A Comparison Will Appear after Its Result Is Validated.`
      : "The Policy Specialist Is Waiting. A Comparison Will Appear after Its Result Is Validated.";
  }
  if (policyTask.status === "input_required") {
    return "The Policy Specialist Is Waiting for Analyst Input. A Comparison Will Appear after Its Result Is Validated.";
  }
  if (policyTask.status === "failed") {
    return "The Policy Specialist Failed before Saving a Validated Comparison. Review Agent Activity for Details.";
  }
  return "The Policy Specialist Completed, but No Validated Policy Comparison Was Saved for This Run.";
}

function PolicyEvidenceReferences({
  references,
  citationsById,
  onViewCitation,
  emptyMessage,
}: {
  references: ApiPolicyEvidenceReference[];
  citationsById: Map<string, ApiPolicyComparisonCitation>;
  onViewCitation: (citation: ApiPolicyComparisonCitation) => void;
  emptyMessage: string;
}) {
  if (references.length === 0) {
    return <p className="text-sm text-ink-3">{emptyMessage}</p>;
  }

  return (
    <ul className="ml-[7px] flex flex-col gap-2.5 border-l border-line pl-3">
      {references.map((reference, index) => {
        const citation = citationsById.get(reference.citation_id);
        return (
          <li key={`${reference.citation_id}-${index}`} className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <strong className="text-xs font-medium text-ink">{titleCase(reference.evidence_type)}</strong>
              <span className={`text-xs ${reference.status === "present" ? "text-green" : "text-ink-3"}`}>{titleCase(reference.status)}</span>
            </div>
            <p className="mt-0.5 break-words text-xs leading-5 text-ink-2">{reference.value || reference.reference}</p>
            {citation?.chunk_id && (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="mt-0.5 -ml-2 text-ink-3 hover:text-ink"
                aria-label={`View ${titleCase(reference.evidence_type)} case evidence passage${citation.locator ? ` at ${citation.locator}` : ""}`}
                onClick={() => onViewCitation(citation)}
              >
                View Case Evidence<ChevronRight data-icon="inline-end" />
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function PolicyComparisonCard({
  comparison,
  hasRun,
  loading,
  policyTask,
  needsAttention,
  coordinatorFailed,
  policyReviewAttempt,
  onViewCitation,
  onViewActivity,
}: {
  comparison: ApiPolicyComparison | null;
  hasRun: boolean;
  loading: boolean;
  policyTask: ApiRun["agent_activity"]["tasks"][number] | null;
  needsAttention: boolean;
  coordinatorFailed: boolean;
  policyReviewAttempt: number | null;
  onViewCitation: (citation: ApiPolicyComparisonCitation) => void;
  onViewActivity: () => void;
}) {
  const id = useId().replaceAll(":", "");
  const citationsById = new Map((comparison?.citations ?? []).map((citation) => [citation.id, citation]));
  const requirements = comparison?.requirements ?? [];
  const versions = comparison?.pinned_policy_versions ?? [];

  return (
    <section id="review-result-policy" className="mt-6 scroll-mt-32" aria-labelledby={`${id}-title`}>
      <Card className="gap-0 overflow-hidden">
        <CardHeader className="gap-3 border-b border-line [.border-b]:pb-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <CardTitle><h2 id={`${id}-title`} className="text-lg">Policy Comparison</h2></CardTitle>
            {comparison && (
              <p className="mt-1 text-xs text-ink-3">
                {[
                  `${requirements.length} ${requirements.length === 1 ? "Requirement" : "Requirements"}`,
                  comparison.policy_effective_on ? `Effective ${comparison.policy_effective_on}` : null,
                  versions.length > 0 ? `Pinned ${versions.map((version) => `${version.policy_code} v${version.version}`).join(", ")}` : null,
                ].filter(Boolean).join(" · ")}
              </p>
            )}
          </div>
          {comparison && (
            <CardAction>
              <Badge variant={comparison.status === "completed" ? "success" : "warning"}>
                {comparison.status === "completed" ? "Policy Review Completed" : "Partial Policy Review"}
              </Badge>
            </CardAction>
          )}
        </CardHeader>

        <CardContent className="flex flex-col gap-4 pt-4">
          {loading && !comparison ? (
            <p role="status" aria-live="polite" className="py-4 text-center text-sm text-ink-3">Loading Policy Comparison…</p>
          ) : !hasRun ? (
            <p className="py-4 text-sm text-ink-3">Start an analysis to compare applicable pinned policy requirements with case evidence.</p>
          ) : !comparison ? (
            <div className="flex flex-col items-start gap-3 py-3 sm:flex-row sm:items-center sm:justify-between">
              <p role="status" aria-live="polite" className="text-sm text-ink-2">
                {policyComparisonStatusMessage(policyTask, needsAttention, coordinatorFailed, policyReviewAttempt)}
              </p>
              <Button type="button" variant="outline" size="sm" onClick={onViewActivity}>
                View Agent Activity<ChevronRight data-icon="inline-end" />
              </Button>
            </div>
          ) : (
            <>
              {requirements.length === 0 ? (
                <p className="rounded-card border border-dashed border-line px-4 py-6 text-center text-sm text-ink-3">
                  No Applicable Policy Requirements Were Included in This Analysis Run.
                </p>
              ) : (
                <div className="flex flex-col divide-y divide-line">
                  {requirements.map((requirement, index) => {
                    const requirementId = `${id}-requirement-${index}`;
                    const status = policyRequirementStatus(requirement.status);
                    const policyCitations = (requirement.policy_citation_ids ?? [])
                      .map((citationId) => citationsById.get(citationId))
                      .filter((citation): citation is ApiPolicyComparisonCitation => Boolean(citation?.chunk_id));
                    const evidenceReferences = requirement.available_evidence_references ?? [];
                    const exceptions = requirement.conditional_exceptions ?? [];
                    const escalationConditions = requirement.escalation_conditions ?? [];

                    return (
                      <article key={`${requirement.requirement_code}-${index}`} aria-labelledby={requirementId} className="flex flex-col gap-5 py-5 first:pt-1 last:pb-1">
                        <header className="flex flex-col gap-2">
                          <span className="flex min-w-0 items-center gap-2">
                            <Badge variant={status.variant}>{status.label}</Badge>
                            <span className="truncate font-mono text-[11px] text-ink-3">{requirement.requirement_code}</span>
                          </span>
                          <h3 id={requirementId} className="break-words text-[15px] font-medium leading-6 text-ink">{requirement.description || requirement.requirement_code}</h3>
                        </header>

                        <div className="flex flex-col gap-6">
                          <section aria-label={`Policy requirement ${requirement.requirement_code}`} className="flex min-w-0 flex-col gap-5">
                            {requirement.applicability_rationale && (
                              <div>
                                <h4 className="mb-1.5 text-xs font-medium text-ink-3">Why It Applies</h4>
                                <p className="whitespace-pre-wrap break-words text-sm leading-6 text-ink-2">{requirement.applicability_rationale}</p>
                              </div>
                            )}
                            {(requirement.required_evidence ?? []).length > 0 && (
                              <div>
                                <h4 className="mb-1.5 text-xs font-medium text-ink-3">Required Evidence</h4>
                                <ul className="flex flex-col gap-1.5 text-sm leading-5 text-ink-2">
                                  {requirement.required_evidence.map((evidenceType) => (
                                    <li key={evidenceType} className="flex gap-2">
                                      <span className="mt-2 size-1 shrink-0 rounded-full bg-ink-3" aria-hidden="true" />
                                      <span className="min-w-0">{titleCase(evidenceType)}</span>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}
                            <div>
                              <h4 className="mb-1 text-xs font-medium text-ink-3">Pinned Policy Passages</h4>
                              {policyCitations.length > 0 ? (
                                <div className="flex flex-wrap gap-1">
                                  {policyCitations.map((citation) => (
                                    <Button
                                      key={citation.id}
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      className="-ml-2"
                                      aria-label={`View policy passage for ${requirement.requirement_code}${citation.locator ? ` at ${citation.locator}` : ""}`}
                                      onClick={() => onViewCitation(citation)}
                                    >
                                      View Policy Passage<ChevronRight data-icon="inline-end" />
                                    </Button>
                                  ))}
                                </div>
                              ) : <p className="text-sm text-ink-3">No Policy Passage Is Linked.</p>}
                            </div>
                          </section>

                          <section aria-label={`Supporting case evidence ${requirement.requirement_code}`} className="min-w-0">
                            <h4 className="mb-1.5 text-xs font-medium text-ink-3">Supporting Case Evidence</h4>
                            <PolicyEvidenceReferences
                              references={evidenceReferences}
                              citationsById={citationsById}
                              onViewCitation={onViewCitation}
                              emptyMessage="No Run-Scoped Case Evidence Is Linked to This Requirement."
                            />
                          </section>
                        </div>

                        {(exceptions.length > 0 || escalationConditions.length > 0) && (
                          <div className="grid gap-3 lg:grid-cols-2">
                            {exceptions.length > 0 && (
                              <section aria-label={`Conditional exceptions for ${requirement.requirement_code}`} className="rounded-card border border-line bg-inset p-4">
                                <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-2">Conditional Exceptions</h4>
                                <ul className="flex flex-col gap-3">
                                  {exceptions.map((exception, exceptionIndex) => (
                                    <li key={`${exception.code}-${exceptionIndex}`} className="min-w-0">
                                      <div className="flex flex-wrap items-center gap-2">
                                        {exception.code && <Badge variant="outline">{exception.code}</Badge>}
                                        <Badge variant={exception.status === "satisfied" ? "success" : exception.status === "conflicting" ? "destructive" : "warning"}>
                                          {titleCase(exception.status)}
                                        </Badge>
                                      </div>
                                      {exception.conditions && <p className="mt-2 text-sm text-ink-2">{exception.conditions}</p>}
                                      {(exception.required_evidence ?? []).length > 0 && (
                                        <p className="mt-2 text-xs text-ink-3">Required: {exception.required_evidence.map(titleCase).join(", ")}</p>
                                      )}
                                      {(exception.unresolved_gaps ?? []).map((gap) => (
                                        <p key={gap} className="mt-2 text-xs text-orange">{gap}</p>
                                      ))}
                                      <PolicyEvidenceReferences
                                        references={exception.available_evidence_references ?? []}
                                        citationsById={citationsById}
                                        onViewCitation={onViewCitation}
                                        emptyMessage="No Exception Evidence Is Linked."
                                      />
                                    </li>
                                  ))}
                                </ul>
                              </section>
                            )}
                            {escalationConditions.length > 0 && (
                              <section aria-label={`Escalation conditions for ${requirement.requirement_code}`} className="rounded-card border border-line bg-inset p-4">
                                <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-2">Escalation Conditions</h4>
                                <ul className="flex flex-col gap-2">
                                  {escalationConditions.map((condition, conditionIndex) => (
                                    <li key={`${condition.condition}-${conditionIndex}`} className="flex flex-wrap items-start gap-2 text-sm text-ink-2">
                                      <Badge variant={condition.triggered ? "warning" : "outline"}>
                                        {condition.triggered ? "Triggered" : "Not Triggered"}
                                      </Badge>
                                      <span className="min-w-0 flex-1">{condition.condition}</span>
                                    </li>
                                  ))}
                                </ul>
                              </section>
                            )}
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

function PortfolioActivityView({
  cases,
  loadingCases,
  caseListError,
  onRetryCases,
  onOpenCase,
  onStartCase,
  onTaskAttentionCasesChange,
}: {
  cases: CaseItem[];
  loadingCases: boolean;
  caseListError: string | null;
  onRetryCases: () => void;
  onOpenCase: (caseId: string) => void;
  onStartCase: () => void;
  onTaskAttentionCasesChange: (caseIds: string[]) => void;
}) {
  const activityTargets = cases
    .filter((item): item is CaseItem & { analysisRunId: string } => Boolean(item.analysisRunId))
    .map((item) => ({ caseId: item.id, runId: item.analysisRunId }))
    .sort((first, second) => first.caseId.localeCompare(second.caseId));
  const runKey = JSON.stringify(activityTargets.map(({ caseId, runId }) => [caseId, runId]));
  const targetsRef = useRef(activityTargets);
  targetsRef.current = activityTargets;
  const [runStates, setRunStates] = useState<Record<string, PortfolioActivityRunState>>({});
  const runStatesRef = useRef(runStates);
  const [reload, setReload] = useState(0);
  const [filter, setFilter] = useState<ActivityFilter>("all");

  useEffect(() => {
    const targets = targetsRef.current;
    const controllers = new Set<AbortController>();
    let cancelled = false;
    let pollTimer: number | null = null;

    const publish = (caseId: string, state: PortfolioActivityRunState) => {
      if (cancelled) return;
      const next = { ...runStatesRef.current, [caseId]: state };
      runStatesRef.current = next;
      setRunStates(next);
    };

    const initialStates = Object.fromEntries(targets.map(({ caseId, runId }) => [caseId, {
      runId,
      run: null,
      loading: true,
      error: null,
    }])) as Record<string, PortfolioActivityRunState>;
    runStatesRef.current = initialStates;
    setRunStates(initialStates);

    const fetchOne = async (target: PortfolioActivityTarget) => {
      const previous = runStatesRef.current[target.caseId];
      publish(target.caseId, {
        runId: target.runId,
        run: previous?.runId === target.runId ? previous.run : null,
        loading: true,
        error: null,
      });

      const controller = new AbortController();
      controllers.add(controller);
      try {
        const run = await caseApi.getRun(target.runId, controller.signal);
        publish(target.caseId, { runId: target.runId, run, loading: false, error: null });
      } catch (error) {
        if (controller.signal.aborted || cancelled) return;
        const current = runStatesRef.current[target.caseId];
        publish(target.caseId, {
          runId: target.runId,
          run: current?.runId === target.runId ? current.run : null,
          loading: false,
          error: error instanceof Error ? error.message : "Unable to load this run's activity.",
        });
      } finally {
        controllers.delete(controller);
      }
    };

    const fetchTargets = async (batch: PortfolioActivityTarget[]) => {
      let nextIndex = 0;
      const worker = async () => {
        while (!cancelled) {
          const index = nextIndex;
          nextIndex += 1;
          const target = batch[index];
          if (!target) return;
          await fetchOne(target);
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, batch.length) }, () => worker()));
    };

    const schedulePoll = () => {
      if (cancelled) return;
      const activeTargets = targets.filter(({ caseId, runId }) => {
        const state = runStatesRef.current[caseId];
        return state?.runId === runId && state.run?.polling.active === true;
      });
      if (activeTargets.length === 0) return;
      const interval = Math.min(...activeTargets.map(({ caseId }) =>
        Math.max(1_000, runStatesRef.current[caseId]?.run?.polling.interval_ms ?? 5_000),
      ));
      pollTimer = window.setTimeout(() => {
        void fetchTargets(activeTargets).then(schedulePoll);
      }, interval);
    };

    void fetchTargets(targets).then(schedulePoll);

    return () => {
      cancelled = true;
      if (pollTimer !== null) window.clearTimeout(pollTimer);
      controllers.forEach((controller) => controller.abort());
    };
  }, [runKey, reload]);

  const runCases = cases.filter((item) => item.analysisRunId);
  const needsAttention = (item: CaseItem) => {
    const run = runStates[item.id]?.run;
    return CASES_NEEDING_ANALYST_ATTENTION.has(item.status)
      || Boolean(run?.agent_activity?.tasks.some((task) => task.status === "input_required" || task.status === "failed"));
  };
  const inProgress = (item: CaseItem) => {
    const state = runStates[item.id];
    return item.status === "Processing"
      || state?.run?.polling.active === true
      || Boolean(state?.run?.agent_activity?.tasks.some((task) =>
        task.status === "queued" || task.status === "working" || task.status === "waiting",
      ));
  };
  const sortedCases = [...runCases].sort((first, second) => {
    const urgency = (item: CaseItem) => needsAttention(item) ? 0 : inProgress(item) ? 1 : 2;
    return urgency(first) - urgency(second) || first.reference.localeCompare(second.reference);
  });
  const attentionCount = runCases.filter(needsAttention).length;
  const inProgressCount = runCases.filter((item) => !needsAttention(item) && inProgress(item)).length;
  const initialLoadingCount = runCases.filter((item) => {
    const state = runStates[item.id];
    return !state || (state.loading && !state.run);
  }).length;
  const taskAttentionCaseIds = JSON.stringify(runCases
    .filter((item) => runStates[item.id]?.run?.agent_activity?.tasks.some((task) => task.status === "input_required" || task.status === "failed"))
    .map((item) => item.id)
    .sort());

  useEffect(() => {
    onTaskAttentionCasesChange(JSON.parse(taskAttentionCaseIds) as string[]);
  }, [onTaskAttentionCasesChange, taskAttentionCaseIds]);

  useEffect(() => () => onTaskAttentionCasesChange([]), [onTaskAttentionCasesChange]);

  const activityChips: FilterChip<ActivityFilter>[] = [
    { key: "all", label: "All", count: runCases.length },
    { key: "attention", label: "Needs Attention", count: attentionCount, tone: "todo" },
    { key: "progress", label: "In Progress", count: inProgressCount, tone: "progress" },
  ];
  const activityRows: ActivityRow[] = sortedCases.map((item) => {
    const state = runStates[item.id];
    const run = state?.runId === item.analysisRunId ? state.run : null;
    return { item, run, loading: !state || (state.loading && !run), error: state?.error ?? null, tasks: taskRowsFor(run) };
  });

  return (
    <div className="mx-auto w-full max-w-5xl py-8">
      <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-[-0.035em] sm:text-[30px]">Activity</h1>
        </div>
        <Button type="button" className="self-start sm:self-auto lg:hidden" onClick={onStartCase}>
          <Plus data-icon="inline-start" />Start New Case
        </Button>
      </header>

      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {loadingCases && cases.length === 0
          ? "Loading Cases."
          : initialLoadingCount > 0
            ? `Loading Activity for ${initialLoadingCount} ${initialLoadingCount === 1 ? "Case" : "Cases"}.`
            : ""}
      </p>

      {caseListError && (
        <Alert variant="destructive" className="mb-5" role="alert">
          <AlertTriangle />
          <AlertTitle>Could Not Load the Case List</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>{caseListError}</span>
            <Button type="button" variant="outline" size="sm" onClick={onRetryCases}>Try Again</Button>
          </AlertDescription>
        </Alert>
      )}

      {loadingCases && cases.length === 0 ? (
        <p className="rounded-card border border-dashed border-line px-4 py-8 text-center text-sm text-ink-3">Loading Cases…</p>
      ) : sortedCases.length > 0 ? (
        <FilterTable
          label="Case Activity"
          rows={activityRows}
          rowKey={(row) => `${row.item.id}-${row.item.analysisRunId}`}
          rowLabel={(row) => row.item.name}
          columns={ACTIVITY_COLUMNS}
          chips={activityChips}
          activeChip={filter}
          onChipChange={setFilter}
          matches={(row, chip) => chip === "all"
            || (chip === "attention" ? needsAttention(row.item) : !needsAttention(row.item) && inProgress(row.item))}
          onOpenRow={(row) => onOpenCase(row.item.id)}
          details={(row) => (
            <ActivityDetails row={row} onRetry={() => setReload((current) => current + 1)} />
          )}
          detailsLabel={(row) => `agent tasks for ${row.item.name}`}
          emptyMessage="No Cases Match This Filter."
          minWidth={760}
          actionsWidth={48}
        />
      ) : cases.length === 0 && !caseListError ? (
        <Card className="mx-auto max-w-xl text-center">
          <CardHeader>
            <CardTitle>No Cases Yet</CardTitle>
            <CardDescription>Create a Case to Begin Tracking Agent Activity Across Your Portfolio.</CardDescription>
          </CardHeader>
        </Card>
      ) : cases.length === 0 ? null : (
        <Card className="mx-auto max-w-xl text-center">
          <CardHeader>
            <CardTitle>No Agent Activity Yet</CardTitle>
            <CardDescription>Start an Analysis on a Case to See Its Tasks Here.</CardDescription>
          </CardHeader>
          <CardFooter className="justify-center">
            <Button type="button" variant="outline" onClick={() => onOpenCase(cases[0].id)}>Open a Case<ChevronRight data-icon="inline-end" /></Button>
          </CardFooter>
        </Card>
      )}
    </div>
  );
}

const TASK_SEGMENT_CLASS: Record<TaskRow["status"], string> = {
  queued: "bg-line",
  waiting: "bg-line",
  working: "bg-accent",
  input_required: "bg-orange",
  completed: "bg-green",
  failed: "bg-red",
};

const TASK_HEADLINE_PREFIX: Partial<Record<TaskRow["status"], string>> = {
  input_required: "Needs Your Input",
  failed: "Failed",
  working: "Working",
};

type ActivityFilter = "all" | "attention" | "progress";
type ActivityRow = { item: CaseItem; run: ApiRun | null; loading: boolean; error: string | null; tasks: TaskRow[] };

// The one task an analyst should look at first: blocked, then failed, then in flight.
function headlineTask(tasks: TaskRow[]) {
  return (["input_required", "failed", "working"] as const)
    .map((status) => tasks.find((task) => task.status === status))
    .find(Boolean);
}

const ACTIVITY_COLUMNS: FilterTableColumn<ActivityRow>[] = [
  { key: "case", header: "Case", width: "minmax(170px,1fr)", primary: true, cell: ({ item }) => item.name },
  {
    key: "reference",
    header: "Reference",
    width: "minmax(170px,0.8fr)",
    className: "font-mono text-[12px] text-ink-3",
    cell: ({ item }) => <span className="truncate">{item.reference}</span>,
  },
  {
    key: "task",
    header: "Current Task",
    width: "minmax(0,1.8fr)",
    cell: ({ loading, error, run, tasks }) => {
      const task = headlineTask(tasks);
      const completed = tasks.filter((item) => item.status === "completed").length;
      return (
        <span className="truncate" title={task?.summary ?? undefined}>
          {loading
            ? "Loading Agent Activity…"
            : error && !run
              ? "Could Not Load This Run"
              : task
                ? <><span className={task.status === "failed" ? "text-red" : task.status === "input_required" ? "text-orange" : "text-ink"}>{task.label} · {TASK_HEADLINE_PREFIX[task.status]}</span>{task.summary ? <span className="text-ink-3"> — {task.summary}</span> : null}</>
                : `${completed} of ${tasks.length} Agent Tasks Completed`}
        </span>
      );
    },
  },
  {
    key: "progress",
    header: "Progress",
    width: "112px",
    cell: ({ tasks }) => {
      if (tasks.length === 0) return <span className="text-ink-3">—</span>;
      const completed = tasks.filter((task) => task.status === "completed").length;
      return (
        <span className="flex items-center gap-2" title={`${completed} of ${tasks.length} agent tasks completed`}>
          <span className="flex gap-0.5" aria-hidden="true">
            {tasks.map((task) => <span key={task.key} className={`h-1.5 w-2.5 rounded-full ${TASK_SEGMENT_CLASS[task.status]}`} />)}
          </span>
          <span className="text-xs tabular-nums text-ink-3"><span className="sr-only">Agent tasks completed: </span>{completed}/{tasks.length}</span>
        </span>
      );
    },
  },
  {
    key: "status",
    header: "Status",
    width: "220px",
    cell: ({ item, run }) => (
      <span className="flex items-center gap-1.5">
        <StatusBadge status={item.status} />
        {item.archivedAt && <StatusPill tone="neutral">Archived</StatusPill>}
        {run?.polling.active && <StatusPill tone="progress">Live</StatusPill>}
      </span>
    ),
  },
];

function ActivityDetails({ row, onRetry }: { row: ActivityRow; onRetry: () => void }) {
  const { run, loading, error, tasks } = row;
  return (
    <>
      {error && (
        <Alert variant={run ? "warning" : "destructive"} className="mb-4">
          <AlertTriangle />
          <AlertTitle>{run ? "Activity May Be out of Date" : "Could Not Load This Run"}</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>{error}</span>
            <Button type="button" variant="outline" size="sm" onClick={onRetry}>Try Again</Button>
          </AlertDescription>
        </Alert>
      )}
      {loading ? <p className="text-sm text-ink-3">Loading Agent Activity…</p> : !(error && !run) && (
        <TaskRows
          rows={tasks}
          variant="list"
          className="max-w-none"
          emptyMessage={run ? "No Agent Tasks Are Available for This Analysis Run Yet." : "Agent Activity Is Not Available Yet."}
        />
      )}
    </>
  );
}

function StatusBadge({ status }: { status: CaseStatus }) {
  return <StatusPill tone={statusTone(status)}>{status}</StatusPill>;
}

function CaseListView({
  scope,
  cases,
  totalCount,
  draftCount,
  archivedCount,
  query,
  onScopeChange,
  onOpenCase,
  onSetArchived,
  onDeleteCase,
  archivingId,
  deletingId,
  notice,
  error,
  onStartCase,
  onClearSearch,
}: {
  scope: CaseListScope;
  cases: CaseItem[];
  totalCount: number;
  draftCount: number;
  archivedCount: number;
  query: string;
  onScopeChange: (scope: CaseListScope) => void;
  onOpenCase: (id: string) => void;
  onSetArchived: (item: CaseItem, archived: boolean) => void;
  onDeleteCase: (item: CaseItem) => Promise<boolean>;
  archivingId: string | null;
  deletingId: string | null;
  notice: string | null;
  error: string | null;
  onStartCase: () => void;
  onClearSearch: () => void;
}) {
  const [deleteTarget, setDeleteTarget] = useState<CaseItem | null>(null);
  const listTitle = scope === "drafts" ? "Draft Cases" : scope === "archived" ? "Archived Cases" : "All Cases";
  const inScope = (item: CaseItem, chip: CaseListScope) => chip === "archived"
    ? Boolean(item.archivedAt)
    : !item.archivedAt && (chip !== "drafts" || item.status === "Draft");
  const scopeChips: FilterChip<CaseListScope>[] = [
    { key: "all", label: "All", count: totalCount },
    { key: "drafts", label: "Drafts", count: draftCount, tone: "neutral" },
    { key: "archived", label: "Archived", count: archivedCount },
  ];
  const caseColumns: FilterTableColumn<CaseItem>[] = [
    { key: "name", header: "Case", width: "minmax(0,1.4fr)", primary: true, cell: (item) => item.name },
    { key: "reference", header: "Reference", width: "minmax(220px,1fr)", className: "font-mono text-[12px] text-ink-3", cell: (item) => <span className="truncate">{item.reference}</span> },
    { key: "jurisdiction", header: "Jurisdiction", width: "minmax(0,0.8fr)", cell: (item) => <span className="truncate">{caseOptionLabel(JURISDICTIONS, item.jurisdiction)}</span> },
    { key: "status", header: "Status", width: "160px", cell: (item) => <StatusBadge status={item.status} /> },
  ];

  return (
    <div className="mx-auto max-w-6xl pb-12">
      <header className="sticky top-0 z-20 -mx-4 flex min-h-24 items-center justify-between gap-4 border-b border-line bg-page/92 px-4 py-4 backdrop-blur-xl sm:-mx-6 sm:px-6 xl:-mx-12 xl:px-12">
        <div>
          <h1 className="text-2xl font-semibold tracking-[-0.035em] sm:text-[30px]">{listTitle}</h1>
        </div>
        <Button type="button" className="lg:hidden" onClick={onStartCase}><Plus data-icon="inline-start" />Start New Case</Button>
      </header>

      {notice && (
        <Alert variant="warning" className="mt-5">
          <AlertTriangle />
          <AlertTitle>Case deleted; cleanup needs attention</AlertTitle>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}

      {error && (
        <Alert variant="destructive" className="mt-5">
          <AlertTriangle />
          <AlertTitle>Could not update cases</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {cases.length > 0 ? (
        <div className="mt-6">
          <FilterTable
            label={listTitle}
            rows={cases}
            rowKey={(item) => item.id}
            rowLabel={(item) => item.name}
            columns={caseColumns}
            chips={scopeChips}
            activeChip={scope}
            onChipChange={onScopeChange}
            matches={inScope}
            onOpenRow={(item) => onOpenCase(item.id)}
            actions={(item) => isAnalyzing(item) ? <LoadingState label="Analyzing" compact /> : (
              <>
                <Button type="button" variant="ghost" size="icon-sm" disabled={archivingId === item.id}
                  aria-label={`${item.archivedAt ? "Restore" : "Archive"} ${item.name}`}
                  title={item.archivedAt ? "Restore Case" : "Archive Case"}
                  onClick={() => onSetArchived(item, !item.archivedAt)}>
                  {item.archivedAt ? <ArchiveRestore /> : <Archive />}
                </Button>
                {item.archivedAt && (
                  <Button type="button" variant="ghost" size="icon-sm" className="hover:bg-destructive/10 hover:text-destructive"
                    disabled={deletingId === item.id}
                    aria-label={`Delete ${item.name} permanently`}
                    title="Delete Permanently"
                    onClick={() => setDeleteTarget(item)}>
                    <Trash2 />
                  </Button>
                )}
              </>
            )}
            emptyMessage={query ? "No Cases Match This Search." : scope === "archived" ? "No Archived Cases." : scope === "drafts" ? "No Drafts Yet." : "No Cases Yet."}
          />
        </div>      ) : (
        <Card className="mt-5">
          <CardHeader>
            <CardTitle><h2 className="text-base">{query ? "No Matching Cases" : "No Cases Yet"}</h2></CardTitle>
            <CardDescription>{query ? "Try another search or clear the search field." : "Start a new case to begin reviewing evidence."}</CardDescription>
          </CardHeader>
          <CardFooter>{query
            ? <Button type="button" variant="outline" onClick={onClearSearch}>Clear Search</Button>
            : <Button type="button" onClick={onStartCase}><Plus data-icon="inline-start" />Start New Case</Button>}
          </CardFooter>
        </Card>
      )}

      <Dialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open && (!deleteTarget || deletingId !== deleteTarget.id)) setDeleteTarget(null);
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader className="pr-0">
            <DialogTitle>Delete this case permanently?</DialogTitle>
            <DialogDescription>
              {deleteTarget
                ? `“${deleteTarget.name}” and all of its analysis, documents, and history will be permanently removed. This action cannot be undone.`
                : "This case and its analysis and history will be permanently removed."}
            </DialogDescription>
            {deleteTarget && error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={Boolean(deleteTarget && deletingId === deleteTarget.id)}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="button"
              variant="destructive"
              disabled={!deleteTarget || deletingId === deleteTarget.id}
              onClick={async () => {
                if (!deleteTarget) return;
                if (await onDeleteCase(deleteTarget)) setDeleteTarget(null);
              }}
            >
              {deleteTarget && deletingId === deleteTarget.id ? "Deleting…" : "Delete Permanently"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function FindingRow({
  code,
  badge,
  title,
  confidence,
  sourceCount,
  children,
  body,
  emptyLabel,
}: {
  code?: string | null;
  badge: React.ReactNode;
  title: string;
  confidence?: string;
  sourceCount: number;
  children: React.ReactNode;
  body?: React.ReactNode;
  emptyLabel?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const sourcesId = useId().replaceAll(":", "");
  return (
    <li className="flex flex-col gap-2 px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
        <span className="flex min-w-0 items-center gap-2">
          {badge}
          {code && <span className="truncate font-mono text-[11px] text-ink-3">{code}</span>}
        </span>
        {confidence && <span className="tabular-nums text-ink-3"><span className="font-semibold text-ink">{confidence}</span> Confidence</span>}
      </div>
      <h3 className="whitespace-pre-wrap text-[15px] font-medium leading-6 text-ink">{title}</h3>
      {body}
      {sourceCount > 0 ? (
        <>
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={sourcesId}
            onClick={() => setExpanded((current) => !current)}
            className="flex w-fit items-center gap-1 rounded-control text-xs font-medium text-ink-3 transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
          >
            {sourceCount} {sourceCount === 1 ? "Source" : "Sources"}
            <ChevronDown aria-hidden="true" className={`size-3.5 transition-transform motion-reduce:transition-none ${expanded ? "rotate-180" : ""}`} />
          </button>
          <div id={sourcesId} hidden={!expanded} className="pt-1">{children}</div>
        </>
      ) : emptyLabel && <span className="text-xs text-ink-3">{emptyLabel}</span>}
    </li>
  );
}

function webHost(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function CitationList({
  citations,
  emptyLabel,
  onView,
}: {
  citations: ApiCitation[];
  emptyLabel?: string;
  onView: (citation: ApiCitation) => void;
}) {
  if (citations.length === 0) {
    return emptyLabel ? <span className="text-xs text-ink-3">{emptyLabel}</span> : null;
  }
  return (
    <ul className="flex flex-col gap-2">
      {citations.map((citation) => {
        const web = citation.source_kind === "external_web";
        const host = web ? webHost(citation.web_url) : null;
        const name = citation.original_filename ?? citation.policy_code ?? host ?? citation.web_title ?? titleCase(citation.source_kind);
        const openable = Boolean(citation.source_id)
          && (citation.source_kind === "case_document" || citation.source_kind === "policy" || web);
        return (
          <li key={citation.id}>
            <ContextCard
              // A web citation's locator is its URL, which the chip and source view already carry.
              title={web ? citation.web_title ?? host : readableLocator(citation.locator)}
              meta={web ? (isRegistryRead(citation.web_retrieval_method, citation.excerpt) ? "Registry API" : "Web Page") : undefined}
              footer={(
                <SourceChip
                  name={name}
                  kind={citation.source_kind}
                  onClick={openable ? () => onView(citation) : undefined}
                  label={openable ? `View source: ${citation.original_filename ?? citation.policy_title ?? citation.web_title ?? citation.source_kind}` : undefined}
                />
              )}
            >
              <SourceExcerpt>{citation.excerpt}</SourceExcerpt>
            </ContextCard>
          </li>
        );
      })}
    </ul>
  );
}

function OpenGapsAndConflicts({
  run,
  onViewCitation,
}: {
  run: ApiRun;
  onViewCitation: (citation: ApiCitation) => void;
}) {
  const gaps = run.evidence_gaps;
  const conflicts = run.conflicts;
  if (gaps.length === 0 && conflicts.length === 0) return null;
  const heading = [
    gaps.length > 0 ? `${gaps.length} Evidence ${gaps.length === 1 ? "Gap" : "Gaps"}` : null,
    conflicts.length > 0 ? `${conflicts.length} ${conflicts.length === 1 ? "Conflict" : "Conflicts"}` : null,
  ].filter(Boolean).join(" and ");

  return (
    <section className="mt-6 flex min-w-0 flex-col gap-4" aria-labelledby="open-issues-title">
      <div>
        <h2 id="open-issues-title" className="text-xl font-semibold tracking-[-0.025em]">{heading}</h2>
      </div>
      <Card className="gap-0 py-0">
        <ul className="divide-y divide-line">
          {conflicts.map((conflict) => {
            const citations = run.citations.filter((citation) => citation.conflict_id === conflict.id);
            return (
              <FindingRow
                key={conflict.id}
                badge={<Badge variant="destructive"><AlertTriangle />Conflict</Badge>}
                title={conflict.subject?.trim() || "Conflicting Evidence"}
                sourceCount={citations.length}
                body={conflict.description?.trim() && (
                  <p className="max-w-[70ch] whitespace-pre-wrap text-sm leading-6 text-ink-2">{conflict.description}</p>
                )}
              >
                <CitationList citations={citations} onView={onViewCitation} />
              </FindingRow>
            );
          })}
          {gaps.map((gap) => {
            const citations = run.citations.filter((citation) => citation.evidence_gap_id === gap.id);
            return (
              <FindingRow
                key={gap.id}
                code={gap.requirement_code}
                badge={<Badge variant="warning">Evidence Gap</Badge>}
                title={gap.description?.trim() || "Missing Evidence"}
                sourceCount={citations.length}
                body={gap.requested_evidence?.trim() && (
                  <p className="whitespace-pre-wrap text-sm leading-6 text-ink-2">
                    <span className="text-ink-3">Requested: </span>{gap.requested_evidence}
                  </p>
                )}
              >
                <CitationList citations={citations} onView={onViewCitation} />
              </FindingRow>
            );
          })}
        </ul>
      </Card>
    </section>
  );
}

type AnswerOptions = {
  choices: string[];
  multiple: boolean;
  allowCustom: boolean;
  details: ApprovalOptionDetail[];
};

type ChoiceSource = Pick<ApprovalOptionSource, "name" | "kind" | "onView">;

// Reads agent-authored answer options (`choices`, `multiple`, `allow_custom`) from a checkpoint question,
// with each choice's sources (`choice_details`) and the coordinator's `suggested_choice`, if any.
// `resolveSource` names a cited source the way the specialist results do, and opens it.
function answerOptions(
  value: Record<string, unknown>,
  resolveSource: (citationId: string) => ChoiceSource | null = () => null,
): AnswerOptions {
  const choices = Array.isArray(value.choices)
    ? value.choices.filter((choice): choice is string => typeof choice === "string" && choice.trim().length > 0)
    : [];
  const described = new Map<unknown, Record<string, unknown>>();
  for (const item of Array.isArray(value.choice_details) ? value.choice_details : []) {
    const detail = objectValue(item);
    if (detail) described.set(detail.choice, detail);
  }
  const details = choices.map((choice): ApprovalOptionDetail => {
    const detail = described.get(choice);
    const sources: unknown[] = Array.isArray(detail?.sources) ? detail.sources : [];
    return {
      sources: [
        ...(detail?.declared === true ? [{ asOf: null, excerpt: null, name: "Case Form", kind: "case" }] : []),
        ...sources.flatMap((item): ApprovalOptionSource[] => {
          const source = objectValue(item);
          if (!source) return [];
          const cited = typeof source.citation_id === "string" ? resolveSource(source.citation_id) : null;
          return [{
            asOf: typeof source.as_of === "string" ? source.as_of : null,
            excerpt: typeof source.excerpt === "string" ? source.excerpt : null,
            ...(cited ?? (typeof source.label === "string" ? { name: source.label } : {})),
          }];
        }),
      ],
      suggested: choice === value.suggested_choice,
    };
  });
  return { choices, multiple: value.multiple === true, allowCustom: value.allow_custom !== false || choices.length === 0, details };
}

type InlineCheckpointQuestion = ApprovalQuestion & { id: string };

function inlineApprovalQuestion(id: string, text: string, options: AnswerOptions): InlineCheckpointQuestion {
  return {
    id,
    q: text,
    type: options.multiple ? "check" : "radio",
    options: options.choices,
    optionDetails: options.details,
    // Options that carry sources are competing values of one fact.
    compareOptions: options.details.some((detail) => detail.sources.length > 0),
    allowCustom: options.allowCustom,
  };
}

// Answers stay strings ("; "-joined selections plus any free text) so existing coordinator
// routing keeps working; `selected_choices` records exactly which options were picked.
function inlineCheckpointValues(
  questions: InlineCheckpointQuestion[],
  structured: boolean,
  result: ApprovalResult,
): Record<string, unknown> {
  const picked = questions.map((question, index) =>
    (result.selections[index] ?? []).map((choice) => question.options[choice]).filter(Boolean));
  const text = questions.map((question, index) =>
    [...picked[index], result.custom[index]].filter(Boolean).join("; "));
  if (!structured) {
    return {
      answer: text[0],
      ...(questions[0].options.length ? { selected_choices: picked[0] } : {}),
    };
  }
  const selected = Object.fromEntries(questions.flatMap((question, index) =>
    question.options.length ? [[question.id, picked[index]]] : []));
  return {
    answers: Object.fromEntries(questions.map((question, index) => [question.id, text[index]])),
    ...(Object.keys(selected).length ? { selected_choices: selected } : {}),
  };
}

type CheckpointSubmitHandler =(actionId: string, values: Record<string, unknown>) => Promise<boolean>;

function SearchScopeField({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-ink-3">{label}</dt>
      <dd className={cn("mt-0.5 break-words text-sm leading-5 text-ink", className)}>{value}</dd>
    </div>
  );
}

type ReadyForReviewProposal = { actionType: string; summary: string };

function readyForReviewProposal(payload: Record<string, unknown> | undefined): ReadyForReviewProposal | null {
  // The coordinator sends `proposal`; older checkpoints may carry `proposed_action` with the same shape.
  const candidate = payload?.proposal ?? payload?.proposed_action;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const { action_type: actionType, summary } = candidate as Record<string, unknown>;
  if (typeof actionType !== "string" || typeof summary !== "string" || !summary.trim()) return null;
  return { actionType, summary };
}

const PROPOSED_ACTION_LABELS: Record<string, string> = {
  mark_ready_for_review: "Mark Ready for Review",
};

function SearchExecutionReviewForm({
  title,
  description,
  scope,
  allowedActions,
  previousDecisions,
  error,
  refreshing,
  submitting,
  onRefresh,
  onEdit,
  onSubmit,
  onSkip,
}: {
  title: string;
  description?: string;
  scope: SearchExecutionScope | null;
  allowedActions: string[];
  previousDecisions: PreviousSearchDecision[];
  error: string | null;
  refreshing: boolean;
  submitting: boolean;
  onRefresh: () => void;
  onEdit: () => void;
  onSubmit: CheckpointSubmitHandler;
  onSkip?: () => void;
}) {
  const [requestedChanges, setRequestedChanges] = useState("");
  const [changeError, setChangeError] = useState<string | null>(null);
  const changesRef = useRef<HTMLTextAreaElement>(null);

  const requestChanges = () => {
    const comment = requestedChanges.trim();
    if (comment.length < 8) {
      setChangeError("Describe What Should Change in at Least 8 Characters.");
      changesRef.current?.focus();
      return;
    }
    setChangeError(null);
    void onSubmit("changes_requested", { requested_changes: { comment } });
  };

  const options: DecisionOption[] = [];
  if (allowedActions.includes("approve")) {
    options.push({ key: "approve", cta: actionLabel("approve", "search_execution_approval"), short: "Run This Search", disabled: !scope, onConfirm: () => void onSubmit("approve", {}) });
  }
  if (allowedActions.includes("changes_requested")) {
    options.push({
      key: "changes_requested",
      cta: "Send Request",
      short: "Request Changes",
      hint: "Coordinator Revises",
      disabled: !scope,
      onConfirm: requestChanges,
      detail: (
        <label className="flex flex-col gap-1.5 text-xs font-medium text-ink-3" htmlFor="search-requested-changes">
          What Should Change?
          <Textarea
            ref={changesRef}
            id="search-requested-changes"
            value={requestedChanges}
            onChange={(event) => {
              setRequestedChanges(event.target.value);
              setChangeError(null);
              onEdit();
            }}
            placeholder="Describe how the search should change…"
            rows={3}
            autoFocus
            aria-invalid={changeError !== null}
            aria-describedby={changeError ? "search-requested-changes-error" : undefined}
            disabled={submitting}
          />
          {changeError && <span id="search-requested-changes-error" role="alert" className="text-xs font-normal text-red">{changeError}</span>}
        </label>
      ),
    });
  }
  if (allowedActions.includes("reject")) {
    options.push({ key: "reject", cta: actionLabel("reject", "search_execution_approval"), short: "Reject Search", hint: "Continues Without It", danger: true, disabled: !scope, onConfirm: () => void onSubmit("reject", {}) });
  }
  if (onSkip) options.push(skipForNowOption(onSkip));

  return (
    <>
      <DecisionBody title={title} description={description} descriptionHidden>
        {scope ? (
          <dl className="flex flex-col gap-5">
            <SearchScopeField label="Question to Resolve" value={scope.claim} />
            <SearchScopeField label="Search Rationale" value={scope.rationale} />
            <SearchScopeField
              label="Proposed Search Query"
              value={scope.query}
              className="mt-1.5 rounded-control bg-inset px-3 py-2 font-mono text-[13px]"
            />
            {/* Fields keep their natural width and wrap to a new line when they don't fit, so a long domain never squeezes its neighbours. */}
            <div className="flex flex-wrap gap-x-8 gap-y-4 border-t border-line pt-4 [&>div]:max-w-full [&>div]:shrink-0">
              <SearchScopeField label="Allowed Domains" value={scope.allowedDomains.join(", ")} />
              <SearchScopeField label="Applicant Fields Shared" value={scope.disclosedApplicantFields.map(titleCase).join(", ")} />
              <SearchScopeField label="Maximum Results" value={String(scope.resultLimit)} />
            </div>
          </dl>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-ink-2">The Proposed Search Details Were Not Included. Refresh the Case Before Responding.</p>
            <Button type="button" variant="outline" onClick={onRefresh} disabled={refreshing || submitting}>
              {refreshing ? "Refreshing…" : "Refresh Case"}
            </Button>
          </div>
        )}

        {previousDecisions.length > 0 && (
          <section className="space-y-2" aria-labelledby="previous-search-decisions-title">
            <h3 id="previous-search-decisions-title" className="text-xs font-medium text-ink-3">Previously Rejected Searches for This Question</h3>
            {previousDecisions.map((decision, index) => (
              <div key={`${decision.rejectedAt ?? "previous"}-${index}`} className="flex flex-col gap-1 border-l-2 border-orange/40 pl-3">
                <p className="text-sm text-ink">{decision.unresolvedQuestion}</p>
                <p className="text-xs leading-5 text-ink-2">
                  A Previous Search Was Rejected, so Analysis Continued with the Available Evidence.
                  {decision.rationale ? ` Analyst Rationale: ${decision.rationale}` : " No Rationale Was Recorded."}
                </p>
                {decision.rejectedAt && (
                  <time className="text-[11px] text-ink-3" dateTime={decision.rejectedAt}>
                    {timelineDate(decision.rejectedAt)}
                  </time>
                )}
              </div>
            ))}
          </section>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>Response Could Not Be Recorded</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </DecisionBody>
      <DecisionFooter status={{ label: "Needs Approval" }} options={options} submitting={submitting} />
    </>
  );
}

function WebResultReviewForm({
  title,
  description,
  results,
  allowedActions,
  error,
  refreshing,
  submitting,
  onRefresh,
  onEdit,
  onSubmit,
  onSkip,
}: {
  title: string;
  description?: string;
  results: WebReviewResult[];
  allowedActions: string[];
  error: string | null;
  refreshing: boolean;
  submitting: boolean;
  onRefresh: () => void;
  onEdit: () => void;
  onSubmit: CheckpointSubmitHandler;
  onSkip?: () => void;
}) {
  const [decisions, setDecisions] = useState<Record<string, "accept" | "reject">>({});
  const [rationales, setRationales] = useState<Record<string, string>>({});
  const canAccept = allowedActions.includes("accept");
  const canReject = allowedActions.includes("reject");
  const canSubmitReview = canAccept;
  const reviewedCount = results.filter((result) => decisions[result.id] && rationales[result.id]?.trim()).length;

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmitReview) return;
    const resultDecisions = results.map((result) => ({
      result_id: result.id,
      decision: decisions[result.id],
      rationale: rationales[result.id]?.trim() ?? "",
    }));
    const emptyRationaleIndex = resultDecisions.findIndex((decision) => !decision.rationale);
    if (emptyRationaleIndex >= 0) {
      const textarea = document.getElementById(`web-result-${results[emptyRationaleIndex].id}-rationale`) as HTMLTextAreaElement | null;
      textarea?.setCustomValidity("Enter a Reason With at Least One Non-Space Character.");
      textarea?.reportValidity();
      textarea?.focus();
      return;
    }
    if (resultDecisions.some((decision) => !decision.decision || !allowedActions.includes(decision.decision))) return;

    // The active workflow routes top-level reject as a terminal response; individual decisions carry the result outcomes.
    void onSubmit("accept", { result_decisions: resultDecisions });
  };

  return (
    <form onSubmit={handleSubmit} className="contents">
      <DecisionBody title={title} description={description} descriptionHidden>

      {error && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Review Could Not Be Recorded</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {results.length > 0 ? results.map((result, index) => {
        const safeUrl = safeWebUrl(result.url);
        const chosenDecision = decisions[result.id];
        const acceptId = `web-result-${result.id}-accept`;
        const rejectId = `web-result-${result.id}-reject`;
        const rationaleId = `web-result-${result.id}-rationale`;
        return (
          <section key={result.id} aria-label={`Result ${index + 1}`} className="flex flex-col gap-3 border-t border-line pt-4">
            <div className="min-w-0">
              <p className="text-xs text-ink-3">{result.publisher}</p>
              <h3 className="mt-0.5 break-words text-[15px] font-medium leading-6 text-ink">{result.title}</h3>
                {safeUrl ? (
                  <a
                    href={safeUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Open ${result.title} From ${result.publisher} in a New Tab`}
                    className="mt-0.5 inline-flex max-w-full items-start gap-1 break-all text-xs text-accent-ink underline decoration-line underline-offset-2 focus-visible:rounded-chip focus-visible:outline-2 focus-visible:outline-accent"
                  >
                    <span>{result.url}</span><ExternalLink className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                  </a>
                ) : (
                  <p className="mt-0.5 break-all text-xs text-ink-3">{result.url ?? "URL Not Provided"}</p>
                )}
            </div>

              <fieldset className="space-y-2" disabled={submitting}>
                <legend className="sr-only">Decision</legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  {canAccept && (
                    <label className={`flex min-h-10 cursor-pointer items-center gap-2 rounded-control border px-3 py-2 text-sm focus-within:ring-2 focus-within:ring-ring/40 ${chosenDecision === "accept" ? "border-green/30 bg-green-tint text-ink" : "border-line bg-surface text-ink-2"}`}>
                      <input
                        id={acceptId}
                        type="radio"
                        name={`web-result-decision-${result.id}`}
                        value="accept"
                        required
                        checked={chosenDecision === "accept"}
                        onChange={() => {
                          setDecisions((current) => ({ ...current, [result.id]: "accept" }));
                          onEdit();
                        }}
                        className="size-4 accent-green"
                      />
                      <span>Accept</span>
                    </label>
                  )}
                  {canReject && (
                    <label className={`flex min-h-10 cursor-pointer items-center gap-2 rounded-control border px-3 py-2 text-sm focus-within:ring-2 focus-within:ring-ring/40 ${chosenDecision === "reject" ? "border-red/30 bg-red-tint text-ink" : "border-line bg-surface text-ink-2"}`}>
                      <input
                        id={rejectId}
                        type="radio"
                        name={`web-result-decision-${result.id}`}
                        value="reject"
                        required
                        checked={chosenDecision === "reject"}
                        onChange={() => {
                          setDecisions((current) => ({ ...current, [result.id]: "reject" }));
                          onEdit();
                        }}
                        className="size-4 accent-red"
                      />
                      <span>Reject</span>
                    </label>
                  )}
                </div>
              </fieldset>

              <label className="flex flex-col gap-2 text-sm font-medium" htmlFor={rationaleId}>
                <span className="sr-only">Reason for This Decision</span>
                <Textarea
                  id={rationaleId}
                  value={rationales[result.id] ?? ""}
                  onChange={(event) => {
                    setRationales((current) => ({ ...current, [result.id]: event.target.value }));
                    event.currentTarget.setCustomValidity("");
                    onEdit();
                  }}
                  placeholder="Why accept or reject this source?"
                  rows={2}
                 
                  required
                  disabled={submitting}
                />
              </label>
          </section>
        );
      }) : (
        <Alert variant="warning">
          <AlertTriangle />
          <AlertTitle>No Search Results to Review</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>Refresh the Case to Load the Pending Results Before Responding.</span>
            <Button type="button" variant="outline" onClick={onRefresh} disabled={refreshing || submitting}>
              {refreshing ? "Refreshing…" : "Refresh Case"}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {results.length > 0 && !canSubmitReview && (
        <Alert variant="warning">
          <AlertTriangle />
          <AlertTitle>Result Review Is Unavailable</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>The Checkpoint Does Not Allow a Review Submission. Refresh the Case Before Responding.</span>
            <Button type="button" variant="outline" onClick={onRefresh} disabled={refreshing || submitting}>
              {refreshing ? "Refreshing…" : "Refresh Case"}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      </DecisionBody>
      <DecisionFooter
        status={{
          label: `${reviewedCount} of ${results.length} Reviewed`,
          tone: results.length > 0 && reviewedCount === results.length ? "positive" : "attention",
        }}
        options={[
          ...(results.length > 0 && canSubmitReview ? [{ key: "submit", cta: "Submit Review", short: "Submit Review", submit: true }] : []),
          ...(onSkip ? [skipForNowOption(onSkip)] : []),
        ]}
        submitting={submitting}
      />
    </form>
  );
}

export function CaseReviewDashboard({ initialView }: { initialView?: "provider-settings" | "activity" } = {}) {
  const [cases, setCases] = useState<CaseItem[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [caseDetail, setCaseDetail] = useState<ApiCaseDetail | null>(null);
  const [loadingCases, setLoadingCases] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [activeTab, setActiveTab] = useState("overview");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [toolOpen, setToolOpen] = useState(false);
  const [checkpointError, setCheckpointError] = useState<string | null>(null);
  const [checkpointSubmitting, setCheckpointSubmitting] = useState(false);
  const [pendingResume, setPendingResume] = useState<{ caseId: string; runId: string; requestId: string; startedAt: number } | null>(null);
  const [inputOpen, setInputOpen] = useState(false);
  // Which response the input dialog opens on, when the analyst already chose one (e.g. Reject from the inline card).
  const [inputStartAction, setInputStartAction] = useState<string | null>(null);
  useEffect(() => {
    if (!inputOpen) setInputStartAction(null);
  }, [inputOpen]);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [sourceSelection, setSourceSelection] = useState<{ caseId: string; runId: string; citation: ApiCitation } | null>(null);
  const assistantTriggerRef = useRef<HTMLButtonElement>(null);
  const [decisionDialogMode, setDecisionDialogMode] = useState<"record" | "view" | null>(null);
  const [decisionRationale, setDecisionRationale] = useState("");
  const [decisionSubmitting, setDecisionSubmitting] = useState<"approved" | "rejected" | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const decisionIdempotencyRef = useRef<{ payload: string; key: string } | null>(null);
  const checkpointIdempotencyRef = useRef<{ payload: string; key: string } | null>(null);
  const [comment, setComment] = useState("");
  const [inputComment, setInputComment] = useState("");
  const [inputAnswers, setInputAnswers] = useState<Record<string, string>>({});
  const [choiceSelection, setChoiceSelection] = useState<{ requestId: string; choice: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creatingCase, setCreatingCase] = useState(false);
  const [caseListScope, setCaseListScope] = useState<CaseListScope | null>(null);
  const [showProviderSettings, setShowProviderSettings] = useState(initialView === "provider-settings");
  const [showPortfolioActivity, setShowPortfolioActivity] = useState(initialView === "activity");
  const [caseListError, setCaseListError] = useState<string | null>(null);
  const [taskAttentionCaseIds, setTaskAttentionCaseIds] = useState<string[]>([]);
  const [evidenceReadiness, setEvidenceReadiness] = useState<ApiEvidenceReadiness | null>(null);
  const [evidenceReadinessError, setEvidenceReadinessError] = useState<string | null>(null);
  const [timelineEvents, setTimelineEvents] = useState<ApiCaseTimelineEvent[]>([]);
  const [timelineOffset, setTimelineOffset] = useState(0);
  const [timelineHasMore, setTimelineHasMore] = useState(false);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineLoadingMore, setTimelineLoadingMore] = useState(false);
  const [timelineError, setTimelineError] = useState<string | null>(null);
  const [timelineReload, setTimelineReload] = useState(0);
  const timelineAbortRef = useRef<AbortController | null>(null);
  const timelineGenerationRef = useRef(0);
  const [policyRules, setPolicyRules] = useState<ApiPolicyRule[]>([]);
  const [policyRulesError, setPolicyRulesError] = useState<string | null>(null);
  const [archivingId, setArchivingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const updateTaskAttentionCases = useCallback((caseIds: string[]) => {
    setTaskAttentionCaseIds((current) => current.length === caseIds.length
      && current.every((caseId, index) => caseId === caseIds[index])
      ? current
      : caseIds);
  }, []);

  const refreshCases = useCallback(async (preferredId?: string) => {
    try {
      const result = (await caseApi.list()).map(toCaseItem);
      setCases(result);
      setApiError(null);
      setCaseListError(null);
      setSelectedId((current) => {
        const target = preferredId ?? current;
        if (result.some((item) => item.id === target)) return target;
        if (!target && initialView === "activity") return "";
        return result.find((item) => !item.archivedAt)?.id ?? result[0]?.id ?? "";
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to load cases.";
      setApiError(message);
      setCaseListError(message);
    } finally {
      setLoadingCases(false);
    }
  }, [initialView]);

  const refreshCaseDetail = useCallback(async (caseId: string) => {
    if (!caseId) return;
    setLoadingDetail(true);
    try {
      setCaseDetail(await caseApi.get(caseId));
      setApiError(null);
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "Unable to load the case.");
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  const refreshEvidenceReadiness = useCallback(async (caseId: string) => {
    const readiness = await caseApi.getEvidenceReadiness(caseId);
    setEvidenceReadiness(readiness);
    setEvidenceReadinessError(null);
    return readiness;
  }, []);

  useEffect(() => {
    void refreshCases();
  }, [refreshCases]);

  useEffect(() => {
    setShowPortfolioActivity(initialView === "activity");
    setShowProviderSettings(initialView === "provider-settings");
    if (initialView === "activity" || initialView === "provider-settings") {
      setCreatingCase(false);
      setCaseListScope(null);
    }
  }, [initialView]);

  useEffect(() => {
    setSourceSelection(null);
    setCaseDetail(null);
    setPolicyRules([]);
    void refreshCaseDetail(selectedId);
  }, [refreshCaseDetail, selectedId]);

  useEffect(() => {
    const runId = caseDetail?.run?.id;
    if (!runId) return;
    let cancelled = false;
    void caseApi.getPolicyRules(runId).then((rules) => {
      if (!cancelled) { setPolicyRules(rules); setPolicyRulesError(null); }
    }).catch((cause: unknown) => {
      if (!cancelled) setPolicyRulesError(cause instanceof Error ? cause.message : "Unable to load policy rules.");
    });
    return () => { cancelled = true; };
  }, [caseDetail?.run?.id]);

  useEffect(() => {
    const polling = caseDetail?.run?.polling;
    if (!polling?.active || !selectedId) return;
    const timer = window.setTimeout(() => {
      void Promise.all([refreshCaseDetail(selectedId), refreshCases(selectedId)]);
    }, polling.interval_ms);
    return () => window.clearTimeout(timer);
  }, [caseDetail?.run?.polling, refreshCaseDetail, refreshCases, selectedId]);

  useEffect(() => {
    if (!pendingResume) return;
    if (selectedId !== pendingResume.caseId) {
      setPendingResume(null);
      return;
    }
    const run = caseDetail?.run;
    if (run?.id === pendingResume.runId && run.pending_checkpoint?.request_id !== pendingResume.requestId) {
      setPendingResume(null);
    }
  }, [caseDetail?.run?.id, caseDetail?.run?.pending_checkpoint?.request_id, pendingResume, selectedId]);

  useEffect(() => {
    if (!pendingResume) return;
    const timer = window.setInterval(() => {
      if (Date.now() - pendingResume.startedAt > 120_000) {
        setPendingResume(null);
        setApiError("The coordinator has not cleared this request yet. Refresh Agent Activity to check whether the resume failed.");
        return;
      }
      void Promise.all([refreshCaseDetail(pendingResume.caseId), refreshCases(pendingResume.caseId)]);
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [pendingResume, refreshCaseDetail, refreshCases]);

  useEffect(() => {
    if (!cases.some(isAnalyzing)) return;
    const timer = window.setInterval(() => { void refreshCases(); }, 5_000);
    return () => window.clearInterval(timer);
  }, [cases, refreshCases]);

  const selectedCase = cases.find((item) => item.id === selectedId) ?? null;
  const activeSourceSelection = sourceSelection?.caseId === selectedId ? sourceSelection : null;

  useEffect(() => {
    if (!selectedId || selectedCase?.status !== "Draft") {
      setEvidenceReadiness(null);
      setEvidenceReadinessError(null);
      return;
    }
    setEvidenceReadiness(null);
    void refreshEvidenceReadiness(selectedId).catch((error: unknown) => {
      setEvidenceReadinessError(error instanceof Error ? error.message : "Unable to check document status.");
    });
  }, [selectedId, selectedCase?.status, refreshEvidenceReadiness]);

  useEffect(() => {
    if (!selectedId || selectedCase?.status !== "Draft" || evidenceReadiness?.status !== "processing") return;
    let refreshing = false;
    const timer = window.setInterval(() => {
      if (refreshing) return;
      refreshing = true;
      void Promise.all([
        refreshEvidenceReadiness(selectedId),
        refreshCaseDetail(selectedId),
        refreshCases(),
      ]).catch((error: unknown) => {
        setEvidenceReadinessError(error instanceof Error ? error.message : "Unable to refresh document status.");
      }).finally(() => { refreshing = false; });
    }, Math.max(1_000, evidenceReadiness.poll_after_ms));
    return () => window.clearInterval(timer);
  }, [selectedId, selectedCase?.status, evidenceReadiness?.status, evidenceReadiness?.poll_after_ms, refreshEvidenceReadiness, refreshCaseDetail, refreshCases]);

  useEffect(() => {
    timelineAbortRef.current?.abort();
    timelineAbortRef.current = null;
    const generation = ++timelineGenerationRef.current;
    setTimelineEvents([]);
    setTimelineOffset(0);
    setTimelineHasMore(false);
    setTimelineError(null);
    setTimelineLoading(activeTab === "audit");
    setTimelineLoadingMore(false);

    if (activeTab !== "audit" || !selectedId) {
      setTimelineLoading(false);
      return;
    }

    const controller = new AbortController();
    timelineAbortRef.current = controller;
    void caseApi.getCaseTimeline(selectedId, 50, 0, controller.signal)
      .then((result) => {
        if (controller.signal.aborted || generation !== timelineGenerationRef.current) return;
        setTimelineEvents(result.events);
        setTimelineOffset(result.offset + result.events.length);
        setTimelineHasMore(result.has_more);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || generation !== timelineGenerationRef.current) return;
        setTimelineError(error instanceof Error ? error.message : "Unable to load the case timeline.");
      })
      .finally(() => {
        if (generation === timelineGenerationRef.current) setTimelineLoading(false);
      });

    return () => {
      controller.abort();
      if (timelineAbortRef.current === controller) timelineAbortRef.current = null;
      timelineGenerationRef.current += 1;
    };
  }, [activeTab, selectedId, timelineReload]);

  const loadOlderTimelineEvents = async () => {
    if (!selectedId || timelineLoadingMore || !timelineHasMore) return;
    const caseId = selectedId;
    const generation = timelineGenerationRef.current;
    const controller = new AbortController();
    timelineAbortRef.current?.abort();
    timelineAbortRef.current = controller;
    setTimelineLoadingMore(true);
    setTimelineError(null);
    try {
      const result = await caseApi.getCaseTimeline(caseId, 50, timelineOffset, controller.signal);
      if (controller.signal.aborted || generation !== timelineGenerationRef.current) return;
      setTimelineEvents((current) => [...current, ...result.events]);
      setTimelineOffset(result.offset + result.events.length);
      setTimelineHasMore(result.has_more);
    } catch (error) {
      if (!controller.signal.aborted && generation === timelineGenerationRef.current) {
        setTimelineError(error instanceof Error ? error.message : "Unable to load older timeline events.");
      }
    } finally {
      if (generation === timelineGenerationRef.current) setTimelineLoadingMore(false);
      if (timelineAbortRef.current === controller) timelineAbortRef.current = null;
    }
  };
  const filteredCases = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return cases;
    return cases.filter((item) => `${item.name} ${item.reference} ${item.status}`.toLowerCase().includes(normalized));
  }, [cases, query]);
  const activeCases = cases.filter((item) => !item.archivedAt);
  const draftCount = activeCases.filter((item) => item.status === "Draft").length;
  const archivedCount = cases.length - activeCases.length;
  const taskAttentionCaseIdSet = new Set(taskAttentionCaseIds);
  const attentionCaseCount = activeCases.filter((item) =>
    CASES_NEEDING_ANALYST_ATTENTION.has(item.status) || taskAttentionCaseIdSet.has(item.id),
  ).length;
  const sidebarCases = filteredCases.filter((item) => !item.archivedAt);
  const agentTasks = caseDetail?.run?.agent_activity?.tasks ?? [];
  const taskRows = taskRowsFor(caseDetail?.run ?? null);
  const taskRowsEmptyMessage = loadingDetail
    ? "Loading Agent Activity…"
    : caseDetail?.run
    ? "No Agent Tasks Are Available for This Analysis Run Yet."
    : "Agent Activity Will Appear Here after Analysis Starts.";
  const reviewPath = caseDetail?.run?.review_path ?? null;
  const checkpoint = caseDetail?.run?.pending_checkpoint ?? null;
  const checkpointPayload = checkpoint?.request_payload.payload;
  const questionSources = specialistSources(caseDetail?.run ?? null);
  const choiceSource = ({ citation, label }: SpecialistSourceRef): ChoiceSource => ({
    name: label,
    kind: citation.source_kind,
    onView: () => viewPolicyCitation(citation),
  });
  const informationQuestions = checkpoint?.checkpoint_kind === "information_request"
    && Array.isArray(checkpointPayload?.questions)
    ? checkpointPayload.questions.filter((item): item is { id: string; specialty: "entity" | "ownership"; field: string; question: string } =>
      !!item && typeof item === "object" && !Array.isArray(item)
      && typeof item.id === "string" && typeof item.question === "string"
      && (item.specialty === "entity" || item.specialty === "ownership")
      && typeof item.field === "string")
    : [];
  const checkpointQuestion = !informationQuestions.length && typeof checkpointPayload?.question === "string"
    && checkpointPayload.question.trim()
    ? checkpointPayload.question
    : null;
  const checkpointChoices = checkpointQuestion && Array.isArray(checkpointPayload?.choices)
    ? checkpointPayload.choices.filter((choice): choice is string => typeof choice === "string" && choice.trim().length > 0)
    : [];
  const selectedChoice = checkpoint && choiceSelection?.requestId === checkpoint.request_id
    && checkpointChoices.includes(choiceSelection.choice)
    ? choiceSelection.choice
    : "";
  const answersWithChoice = checkpointChoices.length > 0
    && (checkpoint?.request_payload.allowed_actions ?? []).includes("submit_clarification");
  // Information requests are answered inline; other checkpoints keep their review dialogs.
  const inlineQuestions: InlineCheckpointQuestion[] = checkpoint?.checkpoint_kind !== "information_request"
    || !(checkpoint.request_payload.allowed_actions ?? []).includes("submit_clarification")
    ? []
    : informationQuestions.length
      ? informationQuestions.map((item) => inlineApprovalQuestion(
        item.id,
        item.question,
        answerOptions(item as Record<string, unknown>, (citationId) => {
          const ref = questionSources.get(item.specialty)?.get(citationId);
          return ref ? choiceSource(ref) : null;
        }),
      ))
      : checkpointQuestion && checkpointPayload
        ? [inlineApprovalQuestion("answer", checkpointQuestion, answerOptions(checkpointPayload))]
        : [];
  // The backend records one skip per checkpoint request; a skipped request needs a real decision.
  const canSkipCheckpoint = (checkpoint?.request_payload.allowed_actions ?? []).includes("skip_for_now")
    && !checkpoint?.skipped_at;
  const reviewProposal = checkpoint?.checkpoint_kind === "analyst_approval"
    ? readyForReviewProposal(checkpointPayload)
    : null;
  const reviewActionOrder = ["reject", "changes_requested", "approve"];
  const reviewActions = (checkpoint?.request_payload.allowed_actions ?? [])
    .filter((action) => reviewActionOrder.includes(action))
    .sort((left, right) => reviewActionOrder.indexOf(left) - reviewActionOrder.indexOf(right));
  const isPolicyAssessmentRecovery = checkpoint?.checkpoint_kind === "specialist_recovery"
    && checkpointPayload?.specialty === "policy"
    && typeof checkpointPayload.assessment_api_path === "string";
  const currentSearchScope = checkpoint?.checkpoint_kind === "search_execution_approval"
    ? searchExecutionScope(checkpointPayload)
    : null;
  const currentWebResults = checkpoint?.checkpoint_kind === "web_result_review"
    ? webReviewResults(checkpointPayload)
    : [];
  const relatedSearchDecisions = previousSearchDecisions(caseDetail?.run ?? null, currentSearchScope);

  const exitDashboardRoute = () => {
    if (typeof window !== "undefined" && (window.location.pathname === "/provider-settings" || window.location.pathname === "/activity")) {
      window.history.replaceState(null, "", "/");
    }
  };

  const openPortfolioActivity = () => {
    setShowPortfolioActivity(true);
    setShowProviderSettings(false);
    setCreatingCase(false);
    setCaseListScope(null);
    setAssistantOpen(false);
  };

  const openNewCase = () => {
    exitDashboardRoute();
    setShowPortfolioActivity(false);
    setShowProviderSettings(false);
    setCaseListScope(null);
    setCreatingCase(true);
  };

  const openProviderSettings = () => {
    exitDashboardRoute();
    setAssistantOpen(false);
    setReviewOpen(false);
    setToolOpen(false);
    setInputOpen(false);
    setDecisionDialogMode(null);
    setSourceSelection(null);
    setCreatingCase(false);
    setCaseListScope(null);
    setShowPortfolioActivity(false);
    setShowProviderSettings(true);
    setNotice(null);
  };

  const selectCase = (id: string) => {
    const cameFromPortfolioActivity = showPortfolioActivity;
    exitDashboardRoute();
    setShowPortfolioActivity(false);
    setShowProviderSettings(false);
    setAssistantOpen(false);
    setSelectedId(id);
    setActiveTab(cameFromPortfolioActivity ? "activity" : "overview");
    setNotice(null);
    setDecisionDialogMode(null);
    setDecisionRationale("");
    setDecisionSubmitting(null);
    setDecisionError(null);
    decisionIdempotencyRef.current = null;
    setCreatingCase(false);
    setCaseListScope(null);
  };

  const openCaseList = (scope: CaseListScope) => {
    exitDashboardRoute();
    setShowPortfolioActivity(false);
    setShowProviderSettings(false);
    setAssistantOpen(false);
    setCreatingCase(false);
    setCaseListScope(scope);
    setQuery("");
    setNotice(null);
  };

  const setCaseArchived = async (item: CaseItem, archived: boolean) => {
    setArchivingId(item.id);
    setApiError(null);
    try {
      await caseApi.setArchived(item.id, archived);
      await refreshCases();
      if (archived && selectedId === item.id) setCaseListScope("archived");
      if (selectedId === item.id) await refreshCaseDetail(item.id);
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "Unable to update the archive.");
    } finally {
      setArchivingId(null);
    }
  };

  const deleteCase = async (item: CaseItem): Promise<boolean> => {
    setDeletingId(item.id);
    setApiError(null);
    try {
      const result = await caseApi.deleteCase(item.id);
      setNotice(result.cleanup_warning ?? null);
      setCases((current) => current.filter((candidate) => candidate.id !== item.id));
      if (selectedId === item.id) {
        setCaseDetail(null);
        setEvidenceReadiness(null);
        setEvidenceReadinessError(null);
        setSelectedId("");
      }
      await refreshCases();
      return true;
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "Unable to delete this case.");
      return false;
    } finally {
      setDeletingId(null);
    }
  };

  const createCase = async (draft: NewCaseDraft, files: NewCaseEvidenceUpload[]) => {
    const created = await caseApi.create({
      legal_name: draft.legalName,
      jurisdiction: draft.jurisdiction,
      business_type: draft.businessType,
      product: draft.product,
      submitted_payload: {
        activity_declaration: {
          operating_jurisdictions: draft.operatingJurisdictions,
          payment_activity: draft.paymentActivity,
          handles_customer_funds: draft.handlesCustomerFunds,
          licensing_basis: draft.licensingBasis,
        },
        entity_declaration: {
          identifiers: [{ type: "registration_number", value: draft.registrationNumber.trim(), jurisdiction: draft.jurisdiction }],
          addresses: {
            registered: draft.registeredAddress.trim(),
            operating: draft.operatingAddress.trim(),
            mailing: draft.mailingAddress.trim(),
          },
        },
      },
    });
    const uploadFailures: string[] = [];
    for (const { file, documentType } of files) {
      try {
        await caseApi.uploadEvidence(created.id, [file], documentType);
      } catch (error) {
        uploadFailures.push(`${file.name}: ${error instanceof Error ? error.message : "Upload failed."}`);
      }
    }
    const uploadError = uploadFailures.length > 0 ? uploadFailures.join(" ") : null;
    await refreshCases(created.id);
    await refreshCaseDetail(created.id);
    return { caseId: created.id, uploadError };
  };

  const openCreatedCase = (caseId: string, uploadError: string | null) => {
    exitDashboardRoute();
    setShowPortfolioActivity(false);
    setShowProviderSettings(false);
    setSelectedId(caseId);
    setCreatingCase(false);
    setCaseListScope(null);
    setActiveTab("overview");
    setNotice(uploadError
      ? `Case saved as a draft, but some documents could not be uploaded: ${uploadError}`
      : null);
  };

  const handleEvidenceUploaded = async (caseId: string) => {
    await Promise.all([
      refreshCaseDetail(caseId),
      refreshCases(),
      refreshEvidenceReadiness(caseId),
    ]);
  };

  const handlePrimaryAction = () => {
    if (pendingResume) return;
    if (!selectedCase) return;
    if (selectedCase.archivedAt) return;
    if (selectedCase.backendStatus === "completed") {
      setDecisionError(null);
      setDecisionDialogMode("view");
    } else if (selectedCase.backendStatus === "ready_for_review") {
      setDecisionError(null);
      setDecisionDialogMode("record");
    } else if (checkpoint?.checkpoint_kind === "search_execution_approval" || checkpoint?.checkpoint_kind === "web_result_review") {
      setCheckpointError(null);
      setToolOpen(true);
    }
    else if (checkpoint?.checkpoint_kind === "analyst_approval") setReviewOpen(true);
    else if (checkpoint) setInputOpen(true);
    else if (selectedCase.status === "Draft") {
      void caseApi.getEvidenceReadiness(selectedCase.id)
        .then(async (readiness) => {
          if (!readiness.can_start) {
            setActiveTab("evidence");
            setNotice(readiness.status === "empty"
              ? "Upload at least one document before starting analysis."
              : readiness.status === "processing"
                ? "Documents are still processing. Try again when they are ready."
                : "Document processing failed. Review the evidence before trying again.");
            return;
          }
          await caseApi.startAnalysis(selectedCase.id);
          await Promise.all([refreshCases(selectedCase.id), refreshCaseDetail(selectedCase.id)]);
          setNotice("Analysis started. The specialist agents are preparing the first checks.");
        })
        .catch((error: unknown) => setApiError(error instanceof Error ? error.message : "Unable to start analysis."));
    } else if (selectedCase.status === "Processing" || selectedCase.status === "Attention Needed") {
      // A stopped run's failure reasons live on the failed agent rows.
      setActiveTab("activity");
    } else setActiveTab("overview");
  };

  const startNewAnalysis = async () => {
    if (!selectedCase || selectedCase.status === "Draft"
      || !CASE_STATUSES_OPEN_FOR_ANALYSIS.includes(selectedCase.backendStatus)) return;
    setApiError(null);
    try {
      const readiness = await caseApi.getEvidenceReadiness(selectedCase.id);
      if (!readiness.can_start) {
        setActiveTab("evidence");
        setNotice("Review the evidence before starting another analysis.");
        return;
      }
      await caseApi.startAnalysis(selectedCase.id);
      await Promise.all([refreshCases(selectedCase.id), refreshCaseDetail(selectedCase.id)]);
      setNotice("New analysis started. Its policy assessment must be reviewed for this new run.");
    } catch (cause) {
      setApiError(cause instanceof Error ? cause.message : "Could Not Start a New Analysis.");
    }
  };

  const draftNeedsEvidence = selectedCase?.status === "Draft" && !evidenceReadiness?.can_start;
  const processingEvidenceCount = evidenceReadiness?.jobs.filter((job) =>
    job.original_filename
    && ["queued", "in_progress", "suspended"].includes(job.status)
    && !caseDetail?.documents.some((document) => document.checksum_sha256 === job.checksum_sha256)).length ?? 0;
  const evidenceTabCount = (caseDetail?.documents.length ?? selectedCase?.evidenceCount ?? 0) + processingEvidenceCount;
  const primaryActionLabel = pendingResume ? "Resuming Analysis…" : selectedCase?.archivedAt ? "Restore Case" : isPolicyAssessmentRecovery
    ? "Review Policy Assessment" : draftNeedsEvidence
    ? evidenceReadiness?.status === "processing" ? "View Evidence" : "Add Evidence"
    : selectedCase?.backendStatus === "ready_for_review" ? "Record Final Decision"
    : selectedCase ? caseAction(selectedCase.status, checkpoint?.checkpoint_kind) : "Open Case";
  // Without a pending request or decision, the primary action only switches tabs, which the
  // Review Path card already offers through its own activity link.
  const primaryActionOnlyNavigates = Boolean(selectedCase && !selectedCase.archivedAt && !pendingResume && !checkpoint
    && !isPolicyAssessmentRecovery && !draftNeedsEvidence && selectedCase.status !== "Draft"
    && selectedCase.backendStatus !== "completed" && selectedCase.backendStatus !== "ready_for_review");
  // The banner (or inline question card) above the overview already carries the pending request's action.
  const checkpointPromptVisible = Boolean(!pendingResume && selectedCase
    && (selectedCase.status === "Approval Needed" || selectedCase.status === "Input Needed"));
  const handleVisiblePrimaryAction = () => {
    if (selectedCase?.archivedAt) void setCaseArchived(selectedCase, false);
    else if (draftNeedsEvidence) setActiveTab("evidence");
    else handlePrimaryAction();
  };

  const submitFinalDecision = async (decision: "approved" | "rejected") => {
    if (!selectedCase || selectedCase.backendStatus !== "ready_for_review" || caseDetail?.status !== "ready_for_review") {
      setDecisionError("This case is no longer ready for a final decision. Refresh the case and try again.");
      return;
    }

    const analysisRunId = caseDetail.active_analysis_run_id;
    if (!analysisRunId) {
      setDecisionError("The active analysis run is unavailable. Refresh the case and try again.");
      return;
    }

    const rationale = decisionRationale.trim();
    if (!rationale) {
      setDecisionError("Enter a rationale before recording the final decision.");
      return;
    }

    const payload = JSON.stringify([selectedCase.id, analysisRunId, decision, "local-analyst", rationale]);
    if (!decisionIdempotencyRef.current || decisionIdempotencyRef.current.payload !== payload) {
      decisionIdempotencyRef.current = { payload, key: crypto.randomUUID() };
    }
    const idempotencyKey = decisionIdempotencyRef.current.key;

    setDecisionSubmitting(decision);
    setDecisionError(null);
    const recorded = await caseApi.recordFinalDecision(selectedCase.id, {
      analysis_run_id: analysisRunId,
      decision,
      actor_id: "local-analyst",
      rationale,
      idempotency_key: idempotencyKey,
    }).catch((error: unknown) => {
      setDecisionError(error instanceof Error ? error.message : "Unable to record the final decision.");
      return null;
    });
    if (!recorded) {
      setDecisionSubmitting(null);
      return;
    }

    setDecisionSubmitting(null);
    setCaseDetail((current) => current?.id === selectedCase.id
      ? { ...current, status: "completed", final_decision: recorded }
      : current);
    setCases((current) => current.map((item) => item.id === selectedCase.id
      ? { ...item, status: "Completed", backendStatus: "completed", checkpointKind: null }
      : item));
    setNotice(`Final case decision recorded: ${recorded.decision}.`);
    setDecisionRationale("");
    decisionIdempotencyRef.current = null;
    setDecisionDialogMode("view");
    try {
      await Promise.all([refreshCases(selectedCase.id), refreshCaseDetail(selectedCase.id)]);
    } catch (error) {
      setApiError(error instanceof Error
        ? `The decision was recorded, but case refresh failed: ${error.message}`
        : "The decision was recorded, but case refresh failed.");
    }
  };

  const submitCheckpoint = async (actionId: string, values: Record<string, unknown>): Promise<boolean> => {
    if (!caseDetail?.run || !checkpoint) return false;
    const runId = caseDetail.run.id;
    const requestId = checkpoint.request_id;
    const payload = stableJson([runId, requestId, actionId, values]);
    if (!checkpointIdempotencyRef.current || checkpointIdempotencyRef.current.payload !== payload) {
      checkpointIdempotencyRef.current = { payload, key: crypto.randomUUID() };
    }
    const idempotencyKey = checkpointIdempotencyRef.current.key;
    setCheckpointSubmitting(true);
    setCheckpointError(null);
    try {
      await caseApi.submitCheckpoint(runId, {
        request_id: requestId,
        action_id: actionId,
        values,
        idempotency_key: idempotencyKey,
      });
      if (checkpointIdempotencyRef.current?.key === idempotencyKey) {
        checkpointIdempotencyRef.current = null;
      }
      setReviewOpen(false);
      setToolOpen(false);
      setInputOpen(false);
      if (actionId === "skip_for_now") {
        // A skip leaves the same checkpoint pending, so there is no resume to wait for.
        setNotice("Request skipped for now. It stays pending until you choose another action.");
      } else {
        setNotice("Response recorded. The coordinator is resuming the analysis.");
        setPendingResume({ caseId: selectedId, runId, requestId, startedAt: Date.now() });
      }
      await Promise.all([refreshCases(selectedId), refreshCaseDetail(selectedId)]);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to submit the response.";
      setCheckpointError(message);
      setApiError(message);
      return false;
    } finally {
      setCheckpointSubmitting(false);
    }
  };

  const valuesForAction = (actionId: string, note: string): Record<string, unknown> => {
    if (actionId === "changes_requested") return { requested_changes: { comment: note.trim() } };
    if (actionId === "submit_clarification") return { answer: note.trim() };
    return note.trim() ? { comment: note.trim() } : {};
  };

  const valuesWithChoice = (actionId: string, note: string): Record<string, unknown> => {
    if (!selectedChoice) return valuesForAction(actionId, note);
    if (actionId === "submit_clarification") {
      return { answer: selectedChoice, selected_choices: [selectedChoice], ...(note.trim() ? { comment: note.trim() } : {}) };
    }
    return { ...valuesForAction(actionId, note), selected_choice: selectedChoice };
  };

  const skipCheckpoint = () => {
    void submitCheckpoint("skip_for_now", {});
  };

  const resolveReview = (decision: "approve" | "changes_requested") => {
    if (comment.trim().length < 8) return;
    void submitCheckpoint(decision, valuesForAction(decision, comment)).then((submitted) => {
      if (submitted) setComment("");
    });
  };

  const selected = selectedCase!;
  const policyComparison = caseDetail?.run?.policy_comparisons ?? null;
  const specialistResults = specialistEvidence(caseDetail?.run ?? null);
  const hasPolicyRun = Boolean(caseDetail?.run || selectedCase?.analysisRunId);
  const policyTask = caseDetail?.run?.agent_activity.tasks.find((task) => task.specialty === "policy") ?? null;
  const coordinatorFailed = caseDetail?.run?.agent_activity.tasks.some(
    (task) => task.role === "coordinator" && task.status === "failed",
  ) ?? false;
  const coordinatorProgress = typeof caseDetail?.run?.current_iteration === "number"
    && caseDetail.run.current_iteration > 0
    && typeof caseDetail.run.max_iterations === "number" && caseDetail.run.max_iterations > 0
    ? { current: Math.min(caseDetail.run.current_iteration, caseDetail.run.max_iterations), max: caseDetail.run.max_iterations }
    : null;
  const policyComparisonNeedsAttention = selectedCase?.status === "Attention Needed" || coordinatorFailed;
  const policyReviewAttempt = isPolicyAssessmentRecovery && typeof checkpointPayload?.attempt === "number"
    ? checkpointPayload.attempt : null;
  const showReviewResult = (elementId: string) => {
    const target = document.getElementById(elementId);
    if (!target) return;
    // Results may sit inside the collapsed supporting-evidence disclosure.
    target.closest("details")?.setAttribute("open", "");
    // Wait a frame so the opened disclosure has laid out before scrolling to it.
    requestAnimationFrame(() => target.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "start",
    }));
  };
  const viewPolicyCitation = (citation: ApiPolicyComparisonCitation) => {
    const runId = caseDetail?.run?.id;
    if (!runId || !citation.chunk_id) return;
    setSourceSelection({
      caseId: selectedId,
      runId,
      citation: policyComparisonCitation(citation),
    });
  };
  const policyComparisonCard = (
    <PolicyComparisonCard
      comparison={policyComparison}
      hasRun={hasPolicyRun}
      loading={loadingDetail}
      policyTask={policyTask}
      needsAttention={policyComparisonNeedsAttention}
      coordinatorFailed={coordinatorFailed}
      policyReviewAttempt={policyReviewAttempt}
      onViewCitation={viewPolicyCitation}
      onViewActivity={() => setActiveTab("activity")}
    />
  );

  return (
    <div className="min-h-screen bg-page text-ink">
      <a href="#case-content" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-control focus:bg-ink focus:px-3 focus:py-2 focus:text-canvas">
        Skip to content
      </a>

      <div className="mx-auto grid min-h-screen max-w-[1680px] lg:grid-cols-[auto_minmax(0,1fr)]">
        <SidebarNav
          brand={{ name: "Jeen AI", icon: <ShieldCheck /> }}
          primaryAction={{ key: "new", label: "Start New Case", icon: <SquarePen />, active: creatingCase, onClick: openNewCase }}
          items={[
            {
              key: "all",
              label: "All Cases",
              icon: <Inbox />,
              count: activeCases.length,
              active: caseListScope !== null && !showProviderSettings && !showPortfolioActivity && !creatingCase,
              onClick: () => openCaseList("all"),
            },
            {
              key: "activity",
              label: "Activity",
              icon: <ActivityIcon />,
              count: attentionCaseCount,
              href: "/activity",
              active: showPortfolioActivity,
              onClick: openPortfolioActivity,
              ariaLabel: `Activity, ${attentionCaseCount} ${attentionCaseCount === 1 ? "case needs" : "cases need"} attention`,
            },
            { key: "settings", label: "Provider Settings", icon: <Settings />, active: showProviderSettings, onClick: openProviderSettings },
          ]}
          listTitle="Cases"
          listItems={sidebarCases.map((item) => ({
            id: item.id,
            label: item.name,
            meta: item.status,
            active: !showProviderSettings && !showPortfolioActivity && !creatingCase && !caseListScope && item.id === selected?.id,
            trailing: isAnalyzing(item) ? <LoadingState label={`${item.name} analysis in progress`} compact /> : undefined,
            actions: isAnalyzing(item) ? undefined : (
              <Button type="button" variant="ghost" size="icon-xs" disabled={archivingId === item.id}
                aria-label={`Archive ${item.name}`} title="Archive Case"
                onClick={() => { void setCaseArchived(item, true); }}>
                <Archive />
              </Button>
            ),
          }))}
          onPick={selectCase}
          query={query}
          onQueryChange={setQuery}
          searchLabel="Search Cases"
          emptyMessage="No Matching Cases"
        />

        <main id="case-content" className="min-w-0 px-4 pb-12 sm:px-6 xl:px-12">
          <nav className="flex justify-end gap-1 py-3 lg:hidden" aria-label="Workspace">
            <Button asChild variant={showPortfolioActivity ? "secondary" : "ghost"} size="sm">
              <Link
                href="/activity"
                onClick={openPortfolioActivity}
                aria-current={showPortfolioActivity ? "page" : undefined}
                aria-label={`Activity, ${attentionCaseCount} ${attentionCaseCount === 1 ? "case needs" : "cases need"} attention`}
              >
                Activity <span className="tabular-nums text-ink-3">{attentionCaseCount}</span>
              </Link>
            </Button>
            <Button type="button" variant={caseListScope === "all" ? "secondary" : "ghost"} size="sm" onClick={() => openCaseList("all")}>
              All Cases <span className="tabular-nums text-ink-3">{activeCases.length}</span>
            </Button>
          </nav>
          {showProviderSettings ? (
            <>
              <div className="mb-3 flex justify-end lg:hidden">
                <Button type="button" variant="ghost" size="sm" onClick={() => openCaseList("all")}>
                  <ArrowLeft data-icon="inline-start" />All Cases
                </Button>
              </div>
              <div className="mx-auto w-full max-w-3xl py-8">
                <ProviderSettings embedded />
              </div>
            </>
          ) : creatingCase ? (
            <NewCaseIntake
              onCancel={() => setCreatingCase(false)}
              onCreate={createCase}
              onOpenWorkspace={openCreatedCase}
            />
          ) : caseListScope ? (
            <CaseListView
              scope={caseListScope}
              cases={filteredCases}
              totalCount={activeCases.length}
              draftCount={draftCount}
              archivedCount={archivedCount}
              query={query}
              onScopeChange={setCaseListScope}
              onOpenCase={selectCase}
              onSetArchived={(item, archived) => { void setCaseArchived(item, archived); }}
              onDeleteCase={deleteCase}
              archivingId={archivingId}
              deletingId={deletingId}
              notice={notice}
              error={apiError}
              onStartCase={openNewCase}
              onClearSearch={() => setQuery("")}
            />
          ) : showPortfolioActivity ? (
            <PortfolioActivityView
              cases={cases}
              loadingCases={loadingCases}
              caseListError={caseListError}
              onRetryCases={() => { void refreshCases(); }}
              onOpenCase={selectCase}
              onStartCase={openNewCase}
              onTaskAttentionCasesChange={updateTaskAttentionCases}
            />
          ) : selectedCase ? (
          <>
          <header className="sticky top-0 z-20 -mx-4 flex min-h-24 items-center justify-between gap-5 border-b border-line bg-page/92 px-4 py-4 backdrop-blur-xl sm:-mx-6 sm:px-6 xl:-mx-12 xl:px-12">
            <div className="min-w-0">
              <div className="mb-2 flex items-center justify-between gap-4 lg:hidden">
                <span className="flex items-center gap-2">
                  <span className="flex size-7 items-center justify-center rounded-control bg-ink text-canvas"><ShieldCheck /></span>
                  <span className="text-xs font-semibold">Jeen AI</span>
                </span>
              </div>
              <h1 className="truncate text-2xl font-semibold tracking-[-0.035em] sm:text-[30px]">{selected.name}</h1>
              <p className="mt-1 truncate text-[13px] text-ink-3">
                {[
                  selected.reference,
                  caseOptionLabel(JURISDICTIONS, selected.jurisdiction),
                  caseOptionLabel(BUSINESS_TYPES, selected.businessType),
                  caseOptionLabel(PRODUCTS, selected.product),
                ].join(" · ")}
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <StatusBadge status={selected.status} />
              <Button variant="outline" size="icon" aria-label="Start New Case" className="lg:hidden" onClick={openNewCase}>
                <Plus />
              </Button>
              <Button ref={assistantTriggerRef} variant="outline" size="icon" aria-label="Ask about this case" aria-haspopup="dialog" className="inline-flex" onClick={() => setAssistantOpen(true)}>
                <MessageSquare />
              </Button>
            </div>
          </header>

          {apiError && (
            <Alert variant="destructive" className="mt-5">
              <AlertTriangle />
              <AlertTitle>Could not update this case</AlertTitle>
              <AlertDescription>{apiError}</AlertDescription>
            </Alert>
          )}

          <Tabs value={activeTab} onValueChange={setActiveTab} className="mt-6 gap-0">
            <TabsList variant="line" className="dashboard-scrollbar w-full justify-start gap-4 overflow-x-auto border-b border-line pb-0">
              <TabsTrigger value="overview" className="flex-none px-1 pb-3">Overview</TabsTrigger>
              <TabsTrigger value="evidence" className="flex-none px-1 pb-3">Evidence <Badge variant="secondary">{evidenceTabCount}</Badge></TabsTrigger>
              <TabsTrigger value="policy" className="flex-none px-1 pb-3">Policy Scope</TabsTrigger>
              <TabsTrigger value="activity" className="flex-none px-1 pb-3">Agent Activity</TabsTrigger>
              <TabsTrigger value="audit" className="flex-none px-1 pb-3">Audit</TabsTrigger>
            </TabsList>

            <TabsContent value="policy" className="pt-7">
              <section className="flex max-w-4xl flex-col gap-4" aria-labelledby="policy-scope-title">
                <div>
                  <h2 id="policy-scope-title" className="text-xl font-semibold tracking-[-0.025em]">Policy Applicability</h2>
                  {policyRules.length > 0 && (
                    <p className="mt-1 text-xs text-ink-3">
                      {[
                        `${policyRules.filter((rule) => rule.applicability === "applies").length} Apply`,
                        `${policyRules.filter((rule) => rule.applicability === "needs_information").length} Need Information`,
                        `${policyRules.filter((rule) => rule.applicability !== "applies" && rule.applicability !== "needs_information").length} Do Not Apply`,
                      ].filter((part) => !part.startsWith("0 ")).join(" · ")}
                    </p>
                  )}
                </div>
                {policyRulesError && <Alert variant="destructive" role="alert"><AlertTitle>Could not load policy rules</AlertTitle><AlertDescription>{policyRulesError}</AlertDescription></Alert>}
                {!caseDetail?.run && <p className="text-sm text-ink-3">Start an analysis to see its policy scope.</p>}
                {caseDetail?.run && !policyRulesError && policyRules.length === 0 && <p className="text-sm text-ink-3">No reviewed policy rules are pinned to this analysis yet.</p>}
                {policyRules.length > 0 && (
                  <Card className="gap-0 py-0">
                    <ul className="divide-y divide-line">
                      {policyRules.map((rule) => (
                        <FindingRow
                          key={rule.id}
                          code={rule.code}
                          badge={(
                            <Badge variant={rule.applicability === "applies" ? "success" : rule.applicability === "needs_information" ? "warning" : "secondary"}>
                              {rule.applicability === "applies" ? "Applies" : rule.applicability === "needs_information" ? "Needs Information" : "Does Not Apply"}
                            </Badge>
                          )}
                          title={rule.statement}
                          sourceCount={1}
                          body={rule.reasons.length > 0 && (
                            <p className="text-xs leading-5 text-ink-3">Scope Conditions: <span className="text-ink-2">{rule.reasons.map(titleCase).join(", ")}</span></p>
                          )}
                        >
                          <div className="ml-[7px] border-l border-line pl-3 text-xs leading-5">
                            <p className="font-medium text-ink">{rule.section_locator}</p>
                            <p className="mt-0.5 text-ink-2"><SourceExcerpt>{rule.source_excerpt}</SourceExcerpt></p>
                          </div>
                        </FindingRow>
                      ))}
                    </ul>
                  </Card>
                )}
              </section>
            </TabsContent>

            <TabsContent value="overview" className="pt-7">
              {(selected.status === "Attention Needed" || selected.status === "Enhanced Review") && (
                <Alert variant="warning" className="mb-5 flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <div className="flex items-center gap-2">
                      <AlertTriangle className="size-4 shrink-0" />
                      <AlertTitle>{selected.status === "Enhanced Review" ? "Escalated for Enhanced Review" : "Analysis Needs Attention"}</AlertTitle>
                    </div>
                    <AlertDescription>
                      <span>{selected.status === "Enhanced Review"
                        ? "An analyst escalated this case. Its findings stay on record; add evidence if needed, then start a new analysis for a fresh specialist review."
                        : "This run stopped. A new analysis uses the current case evidence and starts a fresh specialist review."}</span>
                    </AlertDescription>
                  </div>
                  <Button type="button" size="sm" className="shrink-0" onClick={() => { void startNewAnalysis(); }}>Start New Analysis</Button>
                </Alert>
              )}
              {pendingResume && (
                <Alert variant="info" role="status" className="mb-5">
                  <AlertTitle>Coordinator Resuming</AlertTitle>
                  <AlertDescription>Your response was sent. This case will refresh as the coordinator processes it.</AlertDescription>
                </Alert>
              )}
              {!pendingResume && inlineQuestions.length === 0 && (selected.status === "Approval Needed" || selected.status === "Input Needed") && (
                <Alert variant="warning" className="mb-5 flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <div className="flex items-center gap-2">
                      {selected.status === "Approval Needed"
                        ? <Globe2 className="size-4 shrink-0" />
                        : <MessageSquare className="size-4 shrink-0" />}
                      <AlertTitle>{checkpoint?.request_payload.title ?? "Workflow Paused for Your Response"}</AlertTitle>
                    </div>
                  </div>
                  <Button type="button" size="sm" className="shrink-0" onClick={handleVisiblePrimaryAction}>{primaryActionLabel}</Button>
                </Alert>
              )}

              <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.65fr)_minmax(300px,0.7fr)]">
                <div className="flex min-w-0 flex-col">
                {!pendingResume && inlineQuestions.length > 0 && checkpoint && (
                  <section className="mb-6" aria-label={checkpoint.request_payload.title ?? "Agent Needs Your Input"}>
                    <ApprovalCard
                      key={checkpoint.request_id}
                      className="w-full"
                      label={titleCase(checkpoint.request_payload.title ?? "Agent Needs Your Input")}
                      questions={inlineQuestions}
                      error={checkpointError}
                      labels={{ continue: "Continue", send: "Send Answers", sentMessage: "Answers Sent" }}
                      onSubmit={(result) => submitCheckpoint(
                        "submit_clarification",
                        inlineCheckpointValues(inlineQuestions, informationQuestions.length > 0, result),
                      )}
                      alternatives={[
                        ...((checkpoint.request_payload.allowed_actions ?? []).includes("reject")
                          ? [{ key: "reject", cta: "Reject Request", short: "Reject Request", hint: "Stops This Request", danger: true, onConfirm: () => { setCheckpointError(null); setInputStartAction("reject"); setInputOpen(true); } }]
                          : []),
                        ...(canSkipCheckpoint ? [skipForNowOption(skipCheckpoint)] : []),
                      ]}
                    />
                  </section>
                )}
                <section className="flex min-w-0 flex-col gap-4" aria-labelledby="findings-title">
                  <div className="flex items-end justify-between gap-4 pb-1">
                    <div>
                      <h2 id="findings-title" className="text-xl font-semibold tracking-[-0.025em]">
                        {caseDetail?.run?.findings.length ?? 0} Final {(caseDetail?.run?.findings.length ?? 0) === 1 ? "Finding" : "Findings"}
                      </h2>
                    </div>
                    {loadingDetail && <Badge variant="info">Refreshing</Badge>}
                  </div>

                  {(caseDetail?.run?.findings.length ?? 0) > 0 && (
                    <Card className="gap-0 py-0">
                      <ul className="divide-y divide-line">
                        {caseDetail!.run!.findings.map((finding) => {
                          const citations = caseDetail?.run?.citations.filter((citation) => citation.finding_id === finding.id) ?? [];
                          return (
                            <FindingRow
                              key={finding.id}
                              code={finding.requirement_code}
                              badge={<Badge variant={finding.outcome === "met" ? "success" : "warning"}>{titleCase(finding.outcome)}</Badge>}
                              confidence={finding.confidence == null ? "—" : `${Math.round(finding.confidence * 100)}%`}
                              title={finding.summary}
                              sourceCount={citations.length}
                              emptyLabel="No Sources Attached"
                            >
                              <CitationList
                                citations={citations}
                                onView={(citation) => {
                                  const runId = caseDetail?.run?.id;
                                  if (runId) setSourceSelection({ caseId: selectedId, runId, citation });
                                }}
                              />
                            </FindingRow>
                          );
                        })}
                      </ul>
                    </Card>
                  )}

                  {!loadingDetail && !caseDetail?.run && (
                    <p className="py-4 text-sm text-ink-3">Start an Analysis to Generate Final Findings.</p>
                  )}
                </section>
                {caseDetail?.run && (
                  <OpenGapsAndConflicts
                    run={caseDetail.run}
                    onViewCitation={(citation) => setSourceSelection({ caseId: selectedId, runId: caseDetail.run!.id, citation })}
                  />
                )}
                <SpecialistEvidenceSection
                  evidence={specialistResults}
                  supporting={(caseDetail?.run?.findings.length ?? 0) > 0}
                  onViewCitation={viewPolicyCitation}
                />
                {policyComparison && policyComparisonCard}
                </div>

                <aside className="flex flex-col gap-4 xl:sticky xl:top-30" aria-label="Review plan and agent activity">
                  {selected.status === "Draft" ? (
                    <Card className="gap-4">
                      <CardHeader>
                        <CardTitle><h2 className="text-lg">Prepare Analysis</h2></CardTitle>
                        <CardDescription>{evidenceReadiness?.status === "processing"
                          ? "Documents are processing. Check the Evidence tab for updates."
                          : evidenceReadiness?.can_start
                            ? "Evidence is ready. You can start analysis."
                            : "Add evidence to this draft before starting analysis."}</CardDescription>
                      </CardHeader>
                      <CardContent className="text-sm text-ink-2">
                        {caseDetail?.documents.length ?? 0} {(caseDetail?.documents.length ?? 0) === 1 ? "Document" : "Documents"} Stored
                      </CardContent>
                      <CardFooter>
                        <Button className="w-full" onClick={handleVisiblePrimaryAction} disabled={Boolean(pendingResume)}>{primaryActionLabel}</Button>
                      </CardFooter>
                    </Card>
                  ) : (
                    <>
                    <section className="flex flex-col gap-3" aria-labelledby="review-path-title">
                    <div className="flex items-baseline justify-between gap-3 px-1">
                      <h2 id="review-path-title" className="text-[15px] font-semibold">Review Path</h2>
                      {(reviewPath || caseDetail?.run?.polling.active) && (
                        <span className="flex items-center gap-2 text-xs tabular-nums text-ink-3">
                          {caseDetail?.run?.polling.active && <StatusPill tone="progress">Live</StatusPill>}
                          {reviewPath && <span>{reviewPath.completed_steps} of {reviewPath.total_steps}</span>}
                        </span>
                      )}
                    </div>
                    {coordinatorProgress && (
                      <p className="-mt-2 px-1 text-xs tabular-nums text-ink-3" title="Each coordinator step plans, dispatches, or reviews specialist work. The run stops if it reaches the step limit.">
                        Coordinator Step {coordinatorProgress.current} of {coordinatorProgress.max}
                      </p>
                    )}
                    {loadingDetail && !caseDetail ? (
                      <p className="px-1 text-sm text-ink-3">Loading Review Plan…</p>
                    ) : reviewPath ? (
                      <TaskRows
                        variant="list"
                        rows={reviewPath.steps.map((step, index): TaskRow => {

                            const compactPlannedOptionalStep = !step.required && step.status === "planned";
                            const repeatedSummaryCount = step.status === "completed" && step.result_summary
                              ? {
                                entity: "fields_assessed",
                                ownership: "relationships",
                                policy: "requirements_assessed",
                              }[step.specialty ?? ""]
                              : undefined;
                            const counts = Object.entries(step.counts).filter(([key, count]) =>
                              key !== repeatedSummaryCount && key !== "anomalies",
                            );
                            // Surface the matching agent's latest update on steps that are still in flight.
                            const liveTask = step.kind === "specialist" && ["working", "failed"].includes(step.status)
                              ? agentTasks.findLast((task) => task.role === "specialist" && task.specialty === step.specialty)
                              : undefined;
                            const liveUpdate = liveTask
                              ? textValue(step.status === "failed" ? liveTask.failure_reason : liveTask.current_summary)
                              : null;
                            // Finished steps whose result is shown in the main column link to it instead of restating it.
                            const resultTarget = step.kind === "specialist" && step.status === "completed"
                              ? step.specialty === "policy"
                                ? (policyComparison ? "review-result-policy" : null)
                                : specialistResults.some((item) => item.specialty === step.specialty) ? `review-result-${step.specialty}` : null
                              : null;
                            const resultExceptions = resultTarget
                              ? specialistResults.find((item) => item.specialty === step.specialty)?.exceptions.length ?? 0
                              : 0;
                            const showStepSummary = step.kind !== "checkpoint" && !compactPlannedOptionalStep && !resultTarget;
                            // The agent's live update (or failure reason) leads; plan and result text only add what it doesn't already say.
                            const [liveTextToShow, summaryText, resultText] = distinctTexts([
                              liveUpdate,
                              showStepSummary ? step.summary : null,
                              showStepSummary ? step.result_summary : null,
                            ]);

                          return {
                            key: step.id,
                            label: titleCase(step.label),
                            status: step.status === "planned" ? "queued" : step.status,
                            step: index + 1,
                            meta: [
                              !step.required ? "Optional" : null,
                              resultExceptions > 0 ? `${resultExceptions} ${resultExceptions === 1 ? "Exception" : "Exceptions"}` : null,
                            ].filter(Boolean).join(" · ") || undefined,
                            summary: [liveTextToShow, summaryText, resultText].filter(Boolean).join("\n\n") || null,
                            details: resultTarget ? [] : counts.map(([key, count]) => ({ label: titleCase(key), value: String(count) })),
                            onSelect: resultTarget ? () => showReviewResult(resultTarget) : undefined,
                            selectLabel: resultTarget ? `View ${titleCase(step.label)} Result` : undefined,
                          };
                        })}
                      />
                    ) : (
                      <p className="px-1 text-sm text-ink-3">The Coordinator Has Not Recorded a Review Plan Yet.</p>
                    )}
                    <div className="flex flex-col gap-2">
                      {!primaryActionOnlyNavigates && !checkpointPromptVisible && (
                        <Button className="w-full" onClick={handleVisiblePrimaryAction} disabled={Boolean(pendingResume)}>{primaryActionLabel}</Button>
                      )}
                      <Button variant="secondary" size="sm" className="w-full" onClick={() => setActiveTab("activity")}>View All Agent Activity</Button>
                    </div>
                  </section>
                    </>
                  )}
                </aside>
              </div>
            </TabsContent>

            <TabsContent value="evidence" forceMount className="pt-7 data-[state=inactive]:hidden">
              <CaseEvidencePanel
                key={selected.id}
                caseId={selected.id}
                canUpload={CASE_STATUSES_OPEN_FOR_ANALYSIS.includes(selected.backendStatus) && !selected.archivedAt}
                documents={caseDetail?.documents ?? []}
                readiness={evidenceReadiness}
                readinessError={evidenceReadinessError}
                onUploaded={() => handleEvidenceUploaded(selected.id)}
                onDeleted={() => handleEvidenceUploaded(selected.id)}
              />
            </TabsContent>

            <TabsContent value="activity" className="pt-7">
              <div className="mb-5 flex items-end justify-between gap-4">
                <h2 className="text-xl font-semibold">Agent Activity</h2>
                {taskRows.length > 0 && <span className="text-xs text-ink-3">Sorted by urgency</span>}
              </div>
              <TaskRows key={`activity-${selected.id}`} rows={taskRows} className="max-w-none" emptyMessage={taskRowsEmptyMessage} />
            </TabsContent>

            <TabsContent value="audit" className="pt-7">
              <div className="mb-5 flex items-end justify-between gap-4">
                <h2 className="text-xl font-semibold">Audit Trail</h2>
                <span className="text-xs tabular-nums text-ink-3">{timelineEvents.length} Events Shown</span>
              </div>
              {timelineError && (
                <Alert variant="destructive" className="mb-4">
                  <AlertTriangle />
                  <AlertTitle>Could Not Load the Case Timeline</AlertTitle>
                  <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
                    <span>{timelineError}</span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        if (timelineEvents.length > 0) void loadOlderTimelineEvents();
                        else setTimelineReload((current) => current + 1);
                      }}
                    >
                      Try Again
                    </Button>
                  </AlertDescription>
                </Alert>
              )}
              <Card className="gap-0 py-0">
                <CardHeader className="sr-only"><CardTitle>Audit events</CardTitle></CardHeader>
                <CardContent className="px-0">
                  {timelineLoading ? (
                    <p role="status" className="px-4 py-8 text-center text-sm text-ink-3">Loading Case History…</p>
                  ) : timelineEvents.length > 0 ? (
                    <ol>
                      {timelineEvents.map((event) => <AuditEventRow key={event.id} event={event} />)}
                    </ol>
                  ) : !timelineError ? (
                    <p className="px-4 py-8 text-center text-sm text-ink-3">No Case History Has Been Recorded Yet.</p>
                  ) : null}
                </CardContent>
              </Card>
              {timelineHasMore && (
                <div className="mt-4 flex justify-center">
                  <Button type="button" variant="outline" onClick={() => void loadOlderTimelineEvents()} disabled={timelineLoadingMore}>
                    {timelineLoadingMore ? "Loading Older Events…" : "Load Older Events"}
                  </Button>
                </div>
              )}
            </TabsContent>
          </Tabs>
          </>
          ) : loadingCases && cases.length === 0 ? (
            <div className="flex min-h-[70vh] items-center justify-center py-8">
              <LoadingState label="Loading Cases" />
            </div>
          ) : (
            <div className="flex min-h-[70vh] items-center justify-center py-8">
              <Card className="w-full max-w-lg text-center">
                <CardHeader>
                  <CardTitle>No cases yet</CardTitle>
                  <CardDescription>Create the first case to connect the review workspace to the specialist workflow.</CardDescription>
                </CardHeader>
                <CardContent>{apiError && <Alert variant="destructive"><AlertTriangle /><AlertTitle>Unable to load cases</AlertTitle><AlertDescription>{apiError}</AlertDescription></Alert>}</CardContent>
                <CardFooter className="flex-col justify-center gap-3">
                  <Button onClick={openNewCase}><Plus data-icon="inline-start" />Start New Case</Button>
                  <Button type="button" variant="ghost" onClick={openProviderSettings}>Provider Settings</Button>
                </CardFooter>
              </Card>
            </div>
          )}
        </main>
      </div>

      {selectedCase && <>
      <CaseAssistantDialog
        key={selected.id}
        caseId={selected.id}
        caseName={selected.name}
        open={assistantOpen}
        onOpenChange={setAssistantOpen}
        triggerRef={assistantTriggerRef}
      />

      <CitationSourceDialog
        runId={activeSourceSelection?.runId ?? null}
        citation={activeSourceSelection?.citation ?? null}
        onOpenChange={(open) => {
          if (!open) setSourceSelection(null);
        }}
      />

      <DecisionDialog
        open={decisionDialogMode === "record"}
        size="sm"
        onOpenChange={(open) => {
          if (decisionSubmitting) return;
          if (!open) {
            setDecisionDialogMode(null);
            setDecisionError(null);
          }
        }}
      >
        <DecisionBody title={`Final Decision for ${selected.name}`}>
          {decisionError && (
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertTitle>Decision Could Not Be Confirmed</AlertTitle>
              <AlertDescription>{decisionError}</AlertDescription>
            </Alert>
          )}
          <label className="flex flex-col gap-1.5 text-xs font-medium text-ink-3" htmlFor="final-decision-rationale">
            Rationale
            <Textarea
              id="final-decision-rationale"
              value={decisionRationale}
              onChange={(event) => {
                setDecisionRationale(event.target.value);
                setDecisionError(null);
              }}
              placeholder="Explain the evidence and reasoning behind this outcome…"
              rows={5}
              maxLength={2_000}
              required
              disabled={decisionSubmitting !== null}
              aria-invalid={decisionError?.startsWith("Enter a rationale") ?? false}
            />
          </label>
        </DecisionBody>
        <DecisionFooter
          status={{ label: "Final Decision" }}
          submitting={decisionSubmitting !== null}
          submittingLabel="Recording…"
          options={[
            { key: "approved", cta: "Approve Case", short: "Approve Case", onConfirm: () => void submitFinalDecision("approved") },
            { key: "rejected", cta: "Reject Case", short: "Reject Case", danger: true, onConfirm: () => void submitFinalDecision("rejected") },
          ]}
        />
      </DecisionDialog>

      <Dialog
        open={decisionDialogMode === "view"}
        onOpenChange={(open) => {
          if (!open) setDecisionDialogMode(null);
        }}
      >
        {decisionDialogMode === "view" && (
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                {caseDetail?.final_decision && (
                  <span className={`flex size-5 items-center justify-center rounded-full ${caseDetail.final_decision.decision === "approved" ? "bg-green-tint text-green" : "bg-red-tint text-red"}`} aria-hidden="true">
                    {caseDetail.final_decision.decision === "approved" ? <Check className="size-3" /> : <X className="size-3" />}
                  </span>
                )}
                {caseDetail?.final_decision
                  ? caseDetail.final_decision.decision === "rejected" ? "Case Rejected" : "Case Approved"
                  : loadingDetail ? "Loading Recorded Decision" : "Decision Unavailable"}
              </DialogTitle>
              <DialogDescription>
                {caseDetail?.final_decision ? (
                  <>
                    {selected.reference} · {caseDetail.final_decision.actor} ·{" "}
                    <time className="tabular-nums" dateTime={caseDetail.final_decision.decided_at}>
                      {new Date(caseDetail.final_decision.decided_at).toLocaleString("en-US", {
                        dateStyle: "medium",
                        timeStyle: "short",
                        timeZone: "UTC",
                      })} UTC
                    </time>
                  </>
                ) : selected.reference}
              </DialogDescription>
            </DialogHeader>
            {caseDetail?.final_decision ? (
              <p className="whitespace-pre-wrap text-sm leading-6 text-ink-2">{caseDetail.final_decision.rationale}</p>
            ) : loadingDetail ? (
              <div className="py-6 text-center text-sm text-ink-3" aria-live="polite">Loading recorded decision…</div>
            ) : (
              <Alert variant="warning">
                <AlertTriangle />
                <AlertTitle>Decision unavailable</AlertTitle>
                <AlertDescription>No persisted final decision was returned for this completed case.</AlertDescription>
              </Alert>
            )}
          </DialogContent>
        )}
      </Dialog>

      <DecisionDialog open={reviewOpen} onOpenChange={setReviewOpen}>
        <DecisionBody
          title={checkpoint?.request_payload.title ?? `Review ${selected.name}`}
          description={checkpoint?.request_payload.explanation ?? "Review the coordinator proposal before responding."}
          descriptionHidden
        >
          {reviewProposal ? (
            <section aria-label="Proposed action" className="rounded-control bg-inset px-4 py-3">
              <p className="text-xs text-ink-3">Proposed Action</p>
              <p className="mt-0.5 text-sm font-medium text-ink">
                {PROPOSED_ACTION_LABELS[reviewProposal.actionType] ?? titleCase(reviewProposal.actionType)}
              </p>
              <p className="mt-1 wrap-anywhere whitespace-pre-wrap text-[13px] leading-5 text-ink-2">{reviewProposal.summary}</p>
            </section>
          ) : (
            <Alert variant="warning">
              <AlertTriangle />
              <AlertTitle>Proposal Unavailable</AlertTitle>
              <AlertDescription>Refresh the case to load the coordinator&apos;s proposal before responding.</AlertDescription>
            </Alert>
          )}
          <label className="flex flex-col gap-1.5 text-xs font-medium text-ink-3" htmlFor="review-comment">
            Analyst Comment
            <Textarea id="review-comment" value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Add context for this decision…" rows={4} aria-required="true" aria-invalid={comment.length > 0 && comment.trim().length < 8} />
          </label>
        </DecisionBody>
        <DecisionFooter
          key={checkpoint?.request_id}
          status={{ label: "Needs Approval" }}
          submitting={checkpointSubmitting}
          options={[
            ...[...reviewActions].sort((left, right) => (left === "approve" ? -1 : right === "approve" ? 1 : 0)).map((action): DecisionOption => ({
              key: action,
              cta: actionLabel(action, checkpoint?.checkpoint_kind),
              short: actionLabel(action, checkpoint?.checkpoint_kind),
              hint: action === "reject" ? "Stops This Run" : action === "changes_requested" ? "Coordinator Revises" : undefined,
              danger: action === "reject",
              disabled: comment.trim().length < 8 || (action === "approve" && !reviewProposal),
              onConfirm: () => action === "approve" || action === "changes_requested"
                ? resolveReview(action)
                : void submitCheckpoint(action, valuesForAction(action, comment)),
            })),
            ...(canSkipCheckpoint ? [skipForNowOption(skipCheckpoint)] : []),
          ]}
        />
      </DecisionDialog>

      <DecisionDialog
        open={toolOpen}
        onOpenChange={(open) => {
          if (!checkpointSubmitting) setToolOpen(open);
        }}
      >
          {checkpoint?.checkpoint_kind === "search_execution_approval" ? (
            <SearchExecutionReviewForm
              key={checkpoint.request_id}
              title={checkpoint.request_payload.title ?? "Review Search Proposal"}
              description={checkpoint.request_payload.explanation}
              scope={currentSearchScope}
              allowedActions={checkpoint.request_payload.allowed_actions ?? []}
              previousDecisions={relatedSearchDecisions}
              error={checkpointError}
              refreshing={loadingDetail}
              submitting={checkpointSubmitting}
              onRefresh={() => {
                setCheckpointError(null);
                void refreshCaseDetail(selectedId);
              }}
              onEdit={() => setCheckpointError(null)}
              onSubmit={submitCheckpoint}
              onSkip={canSkipCheckpoint ? skipCheckpoint : undefined}
            />
          ) : checkpoint?.checkpoint_kind === "web_result_review" ? (
            <WebResultReviewForm
              key={checkpoint.request_id}
              title={checkpoint.request_payload.title ?? "Review Search Results"}
              description={checkpoint.request_payload.explanation}
              results={currentWebResults}
              allowedActions={checkpoint.request_payload.allowed_actions ?? []}
              error={checkpointError}
              refreshing={loadingDetail}
              submitting={checkpointSubmitting}
              onRefresh={() => {
                setCheckpointError(null);
                void refreshCaseDetail(selectedId);
              }}
              onEdit={() => setCheckpointError(null)}
              onSubmit={submitCheckpoint}
              onSkip={canSkipCheckpoint ? skipCheckpoint : undefined}
            />
          ) : (
            <DecisionBody title="Research Request Unavailable" description="Refresh the case to load the pending search decision." />
          )}
      </DecisionDialog>

      <DecisionDialog open={inputOpen} onOpenChange={setInputOpen} size={isPolicyAssessmentRecovery ? "lg" : informationQuestions.length ? "md" : "sm"}>
          {isPolicyAssessmentRecovery && caseDetail?.run ? (
            <PolicyAssessmentReview
              key={checkpoint!.request_id}
              title={checkpoint?.request_payload.title ?? "Review Policy Assessment"}
              runId={caseDetail.run.id}
              attempt={typeof checkpointPayload?.attempt === "number" ? checkpointPayload.attempt : 0}
              submittingCheckpoint={checkpointSubmitting}
              checkpointError={checkpointError}
              onViewSource={(source) => setSourceSelection({
                caseId: selectedId,
                runId: caseDetail.run!.id,
                citation: policyComparisonCitation({
                  id: `assessment-${source.chunkId}`,
                  source_kind: source.kind,
                  source_id: "",
                  chunk_id: source.chunkId,
                  locator: "",
                  excerpt: source.excerpt,
                }),
              })}
              onRetry={() => submitCheckpoint("retry", {})}
              onAbort={() => submitCheckpoint("abort", {})}
              onSkip={canSkipCheckpoint ? skipCheckpoint : undefined}
            />
          ) : (
          <>
          <DecisionBody
            title={checkpoint?.request_payload.title ?? "Agent Needs Your Input"}
            description={checkpoint?.request_payload.explanation ?? "Your response determines how the coordinator continues."}
            descriptionHidden={inputStartAction === "reject"}
          >
          {checkpoint?.checkpoint_kind === "specialist_recovery" && typeof checkpointPayload?.attempt === "number" && checkpointPayload.attempt >= 3 && (
            <Alert variant="warning">
              <AlertTitle>Specialist Retry Limit Reached</AlertTitle>
              <AlertDescription>This run has used all three specialist attempts. Stop the run to start a new analysis.</AlertDescription>
            </Alert>
          )}
          {informationQuestions.length && inputStartAction === "reject" ? null : informationQuestions.length ? (
            <div className="flex flex-col gap-4">
              {informationQuestions.map((item, index) => (
                <label className="flex flex-col gap-1.5 text-[13px] font-medium text-ink" htmlFor={`information-answer-${index}`} key={item.id}>
                  <span>{item.specialty === "entity" ? "Identity" : "Ownership"} · {item.question}</span>
                  <Textarea id={`information-answer-${index}`} value={inputAnswers[item.id] ?? ""}
                    onChange={(event) => setInputAnswers((current) => ({ ...current, [item.id]: event.target.value }))}
                    rows={3} required aria-required="true" />
                </label>
              ))}
            </div>
          ) : (
            <>
            {checkpointQuestion && (
              <fieldset className="space-y-2" disabled={checkpointSubmitting}>
                <legend className="mb-2 text-[13px] font-medium text-ink">{checkpointQuestion}</legend>
                {checkpointChoices.length > 0 && (
                  <div className="grid gap-2 sm:grid-cols-2">
                    {checkpointChoices.map((choice, index) => (
                      <label
                        key={`${index}-${choice}`}
                        className={`flex min-h-10 cursor-pointer items-center gap-2 rounded-control border px-3 py-2 text-sm focus-within:ring-2 focus-within:ring-ring/40 ${selectedChoice === choice ? "border-orange/30 bg-orange-tint text-ink" : "border-line bg-surface text-ink-2"}`}
                      >
                        <input
                          type="radio"
                          name={`checkpoint-choice-${checkpoint?.request_id ?? ""}`}
                          value={choice}
                          checked={selectedChoice === choice}
                          onChange={() => {
                            if (checkpoint) setChoiceSelection({ requestId: checkpoint.request_id, choice });
                          }}
                          className="size-4 accent-orange"
                        />
                        <span className="wrap-anywhere">{choice}</span>
                      </label>
                    ))}
                  </div>
                )}
              </fieldset>
            )}
            <label className="flex flex-col gap-1.5 text-xs font-medium text-ink-3" htmlFor="input-comment">
              Analyst Response
              <Textarea id="input-comment" value={inputComment} onChange={(event) => setInputComment(event.target.value)} placeholder={answersWithChoice ? "Add context, or send the selected answer…" : "Answer the coordinator request…"} rows={4} aria-required={!answersWithChoice} aria-invalid={inputComment.length > 0 && inputComment.trim().length < 3} />
            </label>
            </>
          )}
          </DecisionBody>
          <DecisionFooter
            key={`${checkpoint?.request_id}-${inputStartAction ?? "default"}`}
            initialKey={inputStartAction}
            status={{ label: "Needs Your Input" }}
            submitting={checkpointSubmitting}
            options={[
              ...(checkpoint?.request_payload.allowed_actions ?? [])
                .filter((action) => action !== "skip_for_now"
                  // Opened for Reject from the inline card: answering stays on the card.
                  && !(inputStartAction === "reject" && action === "submit_clarification")
                  && !(action === "retry" && checkpoint?.checkpoint_kind === "specialist_recovery"
                    && typeof checkpointPayload?.attempt === "number" && checkpointPayload.attempt >= 3))
                .sort((left, right) => Number(PRIMARY_INPUT_ACTIONS.has(right)) - Number(PRIMARY_INPUT_ACTIONS.has(left)))
                .map((action): DecisionOption => ({
                  key: action,
                  cta: actionLabel(action, checkpoint?.checkpoint_kind),
                  short: actionLabel(action, checkpoint?.checkpoint_kind),
                  danger: action === "abort" || action === "reject",
                  disabled: informationQuestions.length
                    ? action === "submit_clarification" && informationQuestions.some((item) => !(inputAnswers[item.id] ?? "").trim())
                    : !(action === "submit_clarification" && selectedChoice) && inputComment.trim().length < 3,
                  onConfirm: () => {
                    const values = action === "submit_clarification" && informationQuestions.length
                      ? { answers: Object.fromEntries(informationQuestions.map((item) => [item.id, inputAnswers[item.id].trim()])) }
                      : valuesWithChoice(action, inputComment);
                    void submitCheckpoint(action, values).then((submitted) => {
                      if (submitted) { setInputComment(""); setInputAnswers({}); setChoiceSelection(null); }
                    });
                  },
                })),
              ...(canSkipCheckpoint ? [skipForNowOption(skipCheckpoint)] : []),
            ]}
          />
          </>
          )}
      </DecisionDialog>
      </>}
    </div>
  );
}
