import { z } from "zod";

import { DECLARED_ACTIVITY_FIELD_CODES, type DeclaredActivityField } from "../case-catalog.ts";
import { findVerbatimQuote } from "../source-quote.ts";

/** What the model returns. The declared answer itself is filled in from the case snapshot, never
 * taken from the model, so a conflict cannot misstate what the applicant declared. */
export const assessmentProposalSchema = z.object({
  requirement: z.object({
    statement: z.string(),
    excerpt: z.string(),
    required_evidence: z.array(z.string()),
  }),
  facts: z.array(z.object({
    chunk_id: z.string(),
    fact: z.string(),
    excerpt: z.string(),
  })),
  outcome: z.enum(["supports", "contradicts", "not_addressed", "uncertain"]),
  rationale: z.string(),
  declaration_conflicts: z.array(z.object({
    field: z.enum(DECLARED_ACTIVITY_FIELD_CODES),
    // Plain numbers keep the model's JSON schema minimal; validation requires integers.
    fact_indexes: z.array(z.number()),
    explanation: z.string(),
  })),
});

export type AssessmentCandidate = z.infer<typeof assessmentProposalSchema>;

/** A case-form answer that cited, verified document facts contradict. */
export interface DeclarationConflict {
  field: DeclaredActivityField;
  /** The applicant's answer as submitted: a code, or codes for operating_jurisdictions. */
  declared_value: string | string[];
  /** Zero-based positions in the proposal's facts. */
  fact_indexes: number[];
  explanation: string;
}

export type AssessmentProposal = Omit<AssessmentCandidate, "declaration_conflicts"> & {
  declaration_conflicts: DeclarationConflict[];
};

/** The applicant's answered activity declaration questions; unanswered ones are omitted. */
export type DeclaredAnswers = Partial<Record<DeclaredActivityField, string | string[]>>;

/** Reads the answered questions from a case snapshot's activity_declaration. "unknown" and an
 * empty location list are not answers, so nothing can be said to contradict them. */
export function declaredAnswers(activityDeclaration: unknown): DeclaredAnswers {
  if (!activityDeclaration || typeof activityDeclaration !== "object") return {};
  const source = activityDeclaration as Record<string, unknown>;
  const answers: DeclaredAnswers = {};
  for (const field of DECLARED_ACTIVITY_FIELD_CODES) {
    const value = source[field];
    if (typeof value === "string" && value && value !== "unknown") answers[field] = value;
    if (Array.isArray(value) && value.length && value.every((item) => typeof item === "string")) {
      answers[field] = value as string[];
    }
  }
  return answers;
}

export interface AssessmentContext {
  analysis_run_id: string;
  case_id: string;
  policy: {
    chunk_id: string;
    version_id: string;
    locator: string;
    content: string;
  };
  /** The applicant's own case-form answers, checked against what the document shows. */
  declaration?: DeclaredAnswers;
  document: {
    id: string;
    original_filename: string;
    chunks: Array<{ id: string; locator: string; content: string }>;
    /** Present when only part of the document is supplied; see `selectEvidence`. */
    selection?: EvidenceSelection;
    /** Extracted facts in the supplied chunks. Their quotes are in the chunk text itself. */
    facts?: Array<{
      id: string;
      chunk_id: string;
      subject: string;
      predicate: string;
      value: string;
    }>;
  };
}

/** Document text sent with one policy passage. Each assessment's model input stays bounded
 * whatever the document's size, so assessments cost about the same for any case. */
export const EVIDENCE_CHAR_BUDGET = 24_000;

export interface EvidenceSelection {
  method: "most_relevant";
  supplied_chunks: number;
  total_chunks: number;
}

export interface RankedChunk {
  id: string;
  locator: string;
  content: string;
  /** Similarity to the policy passage; null when either side has no embedding. */
  relevance: number | null;
}

/**
 * Chooses the document text for one policy passage: the whole document when it fits the budget,
 * otherwise the chunks most similar to the passage, returned in document order. Chunks are given
 * in document order.
 */
export function selectEvidence(chunks: RankedChunk[], budget = EVIDENCE_CHAR_BUDGET): {
  chunks: Array<{ id: string; locator: string; content: string }>;
  selection?: EvidenceSelection;
} {
  const plain = (items: RankedChunk[]) => items.map(({ id, locator, content }) => ({ id, locator, content }));
  if (chunks.reduce((sum, chunk) => sum + chunk.content.length, 0) <= budget) return { chunks: plain(chunks) };
  const order = new Map(chunks.map((chunk, index) => [chunk.id, index]));
  const ranked = [...chunks].sort((a, b) =>
    (b.relevance ?? -Infinity) - (a.relevance ?? -Infinity) || order.get(a.id)! - order.get(b.id)!);
  const chosen: RankedChunk[] = [];
  let used = 0;
  for (const chunk of ranked) {
    if (used + chunk.content.length > budget) continue;
    chosen.push(chunk);
    used += chunk.content.length;
  }
  chosen.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  return {
    chunks: plain(chosen),
    selection: { method: "most_relevant", supplied_chunks: chosen.length, total_chunks: chunks.length },
  };
}

export function validateAssessmentProposal(
  context: AssessmentContext,
  candidate: unknown,
): AssessmentProposal {
  const parsed = assessmentProposalSchema.parse(candidate);
  // Quotes are stored as the source's own text, so a citation always highlights exactly.
  const requirementExcerpt = findVerbatimQuote(context.policy.content, parsed.requirement.excerpt);
  if (!parsed.requirement.statement.trim()
    || !requirementExcerpt
    || parsed.requirement.required_evidence.some((item) => !item.trim())
    || !parsed.rationale.trim()) {
    throw new Error("policy_assessment_invalid_requirement");
  }
  if (parsed.facts.length > 20) throw new Error("policy_assessment_too_many_facts");
  const chunks = new Map(context.document.chunks.map((chunk) => [chunk.id, chunk.content]));
  const seen = new Set<string>();
  const facts = parsed.facts.map((fact) => {
    const content = chunks.get(fact.chunk_id);
    const excerpt = content === undefined ? null : findVerbatimQuote(content, fact.excerpt);
    if (!excerpt || !fact.fact.trim()) throw new Error("policy_assessment_invalid_fact_citation");
    const key = `${fact.chunk_id}:${excerpt}`;
    if (seen.has(key)) throw new Error("policy_assessment_duplicate_fact");
    seen.add(key);
    return { ...fact, excerpt };
  });
  if ((parsed.outcome === "supports" || parsed.outcome === "contradicts") && facts.length === 0) {
    throw new Error("policy_assessment_missing_facts");
  }
  // A conflict must name a question the applicant answered and rest on facts verified above.
  const conflictFields = new Set<string>();
  const declarationConflicts = parsed.declaration_conflicts.map((conflict): DeclarationConflict => {
    const declared = context.declaration?.[conflict.field];
    if (declared === undefined) throw new Error("policy_assessment_undeclared_conflict");
    const indexes = [...new Set(conflict.fact_indexes)].sort((a, b) => a - b);
    if (conflictFields.has(conflict.field)
      || !conflict.explanation.trim()
      || indexes.length === 0
      || indexes.length !== conflict.fact_indexes.length
      || indexes.some((index) => !Number.isInteger(index) || index < 0 || index >= facts.length)) {
      throw new Error("policy_assessment_invalid_conflict");
    }
    conflictFields.add(conflict.field);
    return { field: conflict.field, declared_value: declared, fact_indexes: indexes, explanation: conflict.explanation };
  });
  return {
    ...parsed,
    requirement: { ...parsed.requirement, excerpt: requirementExcerpt },
    facts,
    declaration_conflicts: declarationConflicts,
  };
}
