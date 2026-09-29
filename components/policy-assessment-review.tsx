"use client";

import { useEffect, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { SourceExcerpt } from "@/components/ui/source-text";
import { DecisionBody, DecisionFooter, skipForNowOption, type DecisionOption } from "@/components/primitives/DecisionDialog";
import { titleCase } from "@/lib/utils";
import { caseApi, type ApiPolicyAssessment, type ApiPolicyAssessmentCandidates } from "@/lib/case-api";
import { DECLARED_ACTIVITY_FIELDS, declaredAnswerLabel } from "@/src/case-catalog";
import { ASSESSMENT_TIERS, assessmentTier, rankAssessments, type AssessmentTier } from "@/src/policy/assessment-ranking";

type Source = { kind: "policy" | "case_document"; chunkId: string; excerpt: string };

const TIER_LABELS: Record<AssessmentTier, string> = {
  declaration_conflict: "Contradicts the Applicant's Declaration",
  decisive: "Supports or Contradicts the Requirement",
  uncertain: "Uncertain with Cited Facts",
  uninformative: "Little or No Evidence",
};

function reviewStateLabel(state: ApiPolicyAssessment["review_state"]): string {
  if (state === "pending_review") return "Needs Review";
  return state === "accepted" ? "Accepted" : "Rejected";
}

export function PolicyAssessmentReview({
  title,
  runId,
  attempt,
  submittingCheckpoint,
  checkpointError,
  onViewSource,
  onRetry,
  onAbort,
  onSkip,
}: {
  title: string;
  runId: string;
  attempt: number;
  submittingCheckpoint: boolean;
  checkpointError: string | null;
  onViewSource: (source: Source) => void;
  onRetry: () => Promise<boolean>;
  onAbort: () => Promise<boolean>;
  onSkip?: () => void;
}) {
  const [candidates, setCandidates] = useState<ApiPolicyAssessmentCandidates | null>(null);
  const [assessments, setAssessments] = useState<ApiPolicyAssessment[]>([]);
  const [usableAssessmentCount, setUsableAssessmentCount] = useState(0);
  const [policyId, setPolicyId] = useState("");
  const [documentId, setDocumentId] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [rationale, setRationale] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void Promise.all([
      caseApi.getPolicyAssessmentCandidates(runId),
      caseApi.listPolicyAssessments(runId),
      caseApi.listAcceptedPolicyAssessments(runId),
    ]).then(([available, proposals, usable]) => {
      if (cancelled) return;
      setCandidates(available);
      setAssessments(rankAssessments(proposals));
      setUsableAssessmentCount(usable.length);
      setPolicyId(available.policy_passages[0]?.chunk_id ?? "");
      setDocumentId(available.documents.find((document) => /incorporation|formation/i.test(document.original_filename))?.document_id
        ?? available.documents[0]?.document_id ?? "");
      const ranked = rankAssessments(proposals);
      setSelectedId(ranked.find((proposal) => proposal.review_state === "pending_review")?.id
        ?? ranked.find((proposal) => proposal.review_state === "accepted")?.id ?? "");
    }).catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : "Could Not Load Policy Assessments.");
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [runId]);

  const selected = assessments.find((assessment) => assessment.id === selectedId) ?? null;
  // Retry is gated on the run-pinned accepted feed, which can exclude an accepted proposal the list still shows.
  const accepted = usableAssessmentCount > 0;
  const acceptedButUnusable = !accepted && assessments.some((assessment) => assessment.review_state === "accepted");
  const canRetry = attempt >= 1 && attempt < 3;
  const documentNames = new Map(candidates?.documents.map((document) => [document.document_id, document.original_filename]) ?? []);
  const policyNames = new Map(candidates?.policy_passages.map((passage) => [passage.chunk_id, passage.locator]) ?? []);
  const conflictingFacts = new Set(selected?.proposal.declaration_conflicts.flatMap((conflict) => conflict.fact_indexes) ?? []);

  const generate = async () => {
    if (!policyId || !documentId) return;
    setBusy(true);
    setError(null);
    try {
      const proposal = await caseApi.generatePolicyAssessment(runId, policyId, documentId);
      setAssessments((current) => rankAssessments([proposal, ...current]));
      setSelectedId(proposal.id);
      setRationale("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could Not Generate the Assessment.");
    } finally {
      setBusy(false);
    }
  };

  /** Records the analyst's decision and returns how many accepted assessments this run can use. */
  const review = async (decision: "accepted" | "rejected"): Promise<number> => {
    if (!selected || !rationale.trim()) return 0;
    setBusy(true);
    setError(null);
    try {
      const reviewed = await caseApi.reviewPolicyAssessment(runId, selected.id, decision, rationale.trim());
      setAssessments((current) => current.map((item) => item.id === reviewed.id ? reviewed : item));
      setRationale("");
      if (decision === "accepted") {
        const usable = await caseApi.listAcceptedPolicyAssessments(runId);
        setUsableAssessmentCount(usable.length);
        return usable.length;
      }
      return usableAssessmentCount;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could Not Review the Assessment.");
      return 0;
    } finally {
      setBusy(false);
    }
  };

  const acceptAndResume = async () => {
    // An accepted assessment that is not pinned to this run cannot resume it; the warning below explains why.
    if (await review("accepted") > 0) await onRetry();
  };

  const selectClass = "h-9 w-full rounded-control border border-line bg-surface px-3 text-sm text-ink";
  const pending = selected?.review_state === "pending_review" ? selected : null;
  const rationaleField = (
    <label className="flex flex-col gap-1.5 text-xs font-medium text-ink-3">
      Review Rationale
      <Textarea value={rationale} onChange={(event) => setRationale(event.target.value)} rows={3} autoFocus placeholder="Explain why you accept or reject this assessment…" disabled={busy} />
    </label>
  );
  const generateOption: DecisionOption = {
    key: "generate",
    cta: "Generate Assessment",
    short: "Generate New Assessment",
    disabled: busy || !policyId || !documentId,
    onConfirm: () => { void generate(); },
    detail: (
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-ink-3">
          Policy Passage
          <select className={selectClass} value={policyId} onChange={(event) => setPolicyId(event.target.value)} disabled={busy}>
            {candidates?.policy_passages.map((passage) => <option key={passage.chunk_id} value={passage.chunk_id}>{passage.locator}</option>)}
          </select>
        </label>
        <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-ink-3">
          Pinned Document
          <select className={selectClass} value={documentId} onChange={(event) => setDocumentId(event.target.value)} disabled={busy}>
            {candidates?.documents.map((document) => <option key={document.document_id} value={document.document_id}>{document.original_filename}</option>)}
          </select>
        </label>
      </div>
    ),
  };
  const options: DecisionOption[] = loading ? [] : !canRetry
    ? [{ key: "abort", cta: "Stop This Run", short: "Stop This Run", danger: true, disabled: busy, onConfirm: () => { void onAbort(); } }]
    : accepted
      ? [{ key: "retry", cta: "Resume Policy Specialist", short: "Resume Policy Specialist", disabled: busy, onConfirm: () => { void onRetry(); } }, generateOption]
      : pending
        ? [
          { key: "accept", cta: "Accept and Resume", short: "Accept Assessment", disabled: busy || !rationale.trim(), onConfirm: () => { void acceptAndResume(); }, detail: rationaleField },
          { key: "reject", cta: "Reject Assessment", short: "Reject Assessment", danger: true, disabled: busy || !rationale.trim(), onConfirm: () => { void review("rejected"); }, detail: rationaleField },
          generateOption,
        ]
        : [generateOption];
  if (onSkip) options.push(skipForNowOption(onSkip, busy));

  const sourceLink = (source: Source) => (
    <button type="button" onClick={() => onViewSource(source)} className="ml-1.5 text-xs text-ink-3 underline decoration-line underline-offset-2 transition-colors hover:text-ink">
      Source
    </button>
  );

  return (
    <>
    <DecisionBody title={title}>
      {loading ? <p role="status" className="text-sm text-ink-3">Loading Policy Assessments…</p> : (
        <>
          {error && <Alert variant="destructive" role="alert"><AlertTitle>Policy Review Unavailable</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
          {checkpointError && <Alert variant="destructive" role="alert"><AlertTitle>Could Not Update the Run</AlertTitle><AlertDescription>{checkpointError}</AlertDescription></Alert>}
          {!canRetry && (
            <Alert variant="warning">
              <AlertTitle>Specialist Retry Limit Reached</AlertTitle>
              <AlertDescription>
                This run is on attempt {attempt} of 3. Stop this run, then start a new analysis and review a proposal for that new run.
              </AlertDescription>
            </Alert>
          )}
          {acceptedButUnusable && canRetry && (
            <Alert variant="warning">
              <AlertTitle>Accepted Assessment Not Usable for This Run</AlertTitle>
              <AlertDescription>It cites a policy passage or document that is not pinned to this run. Generate and accept an assessment from this run&apos;s pinned sources.</AlertDescription>
            </Alert>
          )}

          {assessments.length > 1 && (
            <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-ink-3">
              Assessment Proposal
              <select className={selectClass} value={selectedId} onChange={(event) => { setSelectedId(event.target.value); setRationale(""); }}>
                {ASSESSMENT_TIERS.map((tier) => {
                  const group = assessments.filter((assessment) => assessmentTier(assessment) === tier);
                  return group.length > 0 && (
                    <optgroup key={tier} label={`${TIER_LABELS[tier]} (${group.length})`}>
                      {group.map((assessment) => <option key={assessment.id} value={assessment.id}>
                        {documentNames.get(assessment.document_id) ?? "Pinned Document"} · {policyNames.get(assessment.policy_chunk_id) ?? "Policy Passage"} · {reviewStateLabel(assessment.review_state)}
                      </option>)}
                    </optgroup>
                  );
                })}
              </select>
            </label>
          )}

          {selected ? (
            <article aria-label="Selected assessment" className="flex flex-col gap-4">
              <header className="flex flex-col gap-1.5">
                <span className="flex min-w-0 flex-wrap items-center gap-2">
                  <Badge variant={selected.review_state === "accepted" ? "success" : selected.review_state === "rejected" ? "destructive" : "warning"}>
                    {reviewStateLabel(selected.review_state)}
                  </Badge>
                  <span className="text-xs text-ink-3">{policyNames.get(selected.policy_chunk_id) ?? "Pinned Policy Passage"}</span>
                </span>
                <h3 className="text-[15px] font-medium leading-6 text-ink">{selected.proposal.requirement.statement}</h3>
              </header>
              {selected.proposal.declaration_conflicts.length > 0 && (
                <Alert variant="warning">
                  <AlertTitle>Contradicts the Applicant&apos;s Declaration</AlertTitle>
                  <AlertDescription>
                    <ul className="flex flex-col gap-1">
                      {selected.proposal.declaration_conflicts.map((conflict) => (
                        <li key={conflict.field}>
                          <span className="font-medium text-ink">{DECLARED_ACTIVITY_FIELDS[conflict.field].label}: Declared {declaredAnswerLabel(conflict.field, conflict.declared_value)}.</span>{" "}
                          {conflict.explanation}
                        </li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              )}
              <section>
                <h4 className="text-xs text-ink-3">Policy Citation</h4>
                <blockquote className="mt-1 border-l-2 border-line pl-3">
                  <SourceExcerpt>{selected.proposal.requirement.excerpt}</SourceExcerpt>
                  {sourceLink({ kind: "policy", chunkId: selected.policy_chunk_id, excerpt: selected.proposal.requirement.excerpt })}
                </blockquote>
              </section>
              <section>
                <h4 className="text-xs text-ink-3">Document Facts</h4>
                {selected.proposal.facts.length === 0 ? <p className="mt-1 text-ink-3">No Document Facts Were Cited.</p> : (
                  <ul className="mt-1 flex flex-col gap-3">
                    {selected.proposal.facts.map((fact, index) => (
                      <li key={`${fact.chunk_id}-${index}`} className={`border-l-2 pl-3 ${conflictingFacts.has(index) ? "border-orange" : "border-line"}`}>
                        <p className="font-medium text-ink">{fact.fact}</p>
                        <p className="mt-0.5 text-xs leading-5 text-ink-2">
                          <SourceExcerpt>{fact.excerpt}</SourceExcerpt>
                          {sourceLink({ kind: "case_document", chunkId: fact.chunk_id, excerpt: fact.excerpt })}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <section>
                <h4 className="flex items-center gap-2 text-xs text-ink-3">Outcome <Badge variant="outline">{titleCase(selected.proposal.outcome)}</Badge></h4>
                <p className="mt-1 whitespace-pre-wrap">{selected.proposal.rationale}</p>
              </section>
            </article>
          ) : canRetry && (
            <p className="text-ink-3">No Assessment Yet. Choose a Policy Passage and Pinned Document to Generate One.</p>
          )}
        </>
      )}
    </DecisionBody>
    <DecisionFooter
      status={!canRetry
        ? { label: "Retry Limit Reached", tone: "negative" }
        : accepted ? { label: "Assessment Accepted", tone: "positive" }
          : pending ? { label: "Needs Review" } : { label: "Needs an Assessment" }}
      submitting={submittingCheckpoint || busy}
      submittingLabel="Working…"
      options={options}
    />
    </>
  );
}
