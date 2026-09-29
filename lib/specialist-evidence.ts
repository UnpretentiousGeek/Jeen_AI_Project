// Turns validated specialist contributions into one display shape, so every specialist
// renders through the same row and source components instead of bespoke payload walks.
// Input types are structural so this module stays free of the browser API client.

import { titleCase } from "./utils.ts";

export type SpecialistCitation = {
  id: string;
  source_kind: "case_document" | "policy";
  source_id: string;
  chunk_id: string;
  locator: string;
  excerpt: string;
};

// An analyst's answer to the question an exception raised; the documents stay as they are.
export type SpecialistAnswerInput = {
  question_id: string;
  specialty: string | null;
  field: string | null;
  subject: string | null;
  answer: string;
  answered_by: string | null;
  answered_at: string;
};

export type SpecialistRunInput = {
  analyst_answers?: SpecialistAnswerInput[];
  // Absent or unverified means only the applicant's own documents support the identity.
  identity_verification?: { status: string } | null;
  agent_activity: {
    tasks: Array<{ role: string; status: string; task_id: string | null; specialty: string | null }>;
    contributions: Array<Record<string, unknown>>;
  };
};

export type SpecialistSourceRef = {
  citation: SpecialistCitation;
  label: string;
};

export type SpecialistObservedValue = {
  value: string;
  sources: SpecialistSourceRef[];
};

export type SpecialistEvidenceStatus = "match" | "conflict" | "missing" | "evidenced" | "gap";

export type SpecialistEvidenceRow = {
  key: string;
  label: string;
  status: SpecialistEvidenceStatus;
  badge: string;
  // Present only when it differs from what the observed values already show.
  declared: string | null;
  observed: SpecialistObservedValue[];
  detail: string | null;
  resolution: SpecialistResolution | null;
  notes: SpecialistNote[];
};

// An agent observation the validator kept: every source is pinned, but the statement itself is advisory.
export type SpecialistNote = {
  key: string;
  kind: string;
  confidence: "low" | "medium" | "high";
  statement: string;
  sources: SpecialistSourceRef[];
};

export type SpecialistResolution = {
  answer: string;
  answeredBy: string | null;
  answeredAt: string;
};

function resolution(answer: SpecialistAnswerInput | undefined): SpecialistResolution | null {
  return answer ? { answer: answer.answer, answeredBy: answer.answered_by, answeredAt: answer.answered_at } : null;
}

export type SpecialistEvidence = {
  taskId: string;
  specialty: "entity" | "ownership";
  title: string;
  status: "completed" | "partial";
  summary: string;
  exceptions: SpecialistEvidenceRow[];
  confirmed: SpecialistEvidenceRow[];
  // Notes about the whole contribution, or about a row this view does not show.
  notes: SpecialistNote[];
};

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function textList(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap((item) => textValue(item) ?? []) : [];
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

type LabeledCitation = SpecialistSourceRef;

// The API stamps source_label on each citation; the fallback covers responses without it.
function specialistCitations(payload: Record<string, unknown>): Map<string, LabeledCitation> {
  return new Map(arrayValue(payload.citations).flatMap((value) => {
    const citation = objectValue(value);
    const id = textValue(citation?.id);
    const sourceKind = citation?.source_kind;
    const chunkId = textValue(citation?.chunk_id);
    if (!id || !chunkId || (sourceKind !== "case_document" && sourceKind !== "policy")) return [];
    const locator = textValue(citation?.locator) ?? "";
    const fallback = sourceKind === "policy" ? `Policy${locator ? ` · ${locator}` : ""}` : "Case Document";
    return [[id, {
      citation: {
        id,
        source_kind: sourceKind,
        source_id: textValue(citation?.source_id) ?? "",
        chunk_id: chunkId,
        locator,
        excerpt: textValue(citation?.excerpt) ?? "",
      },
      label: textValue(citation?.source_label) ?? fallback,
    }]];
  }));
}

// One chip per cited document: several passages from the same document collapse into its first citation.
function sourceRefs(citationIds: string[], citations: Map<string, LabeledCitation>): SpecialistSourceRef[] {
  const seen = new Set<string>();
  return citationIds.flatMap((id) => {
    const labeled = citations.get(id);
    if (!labeled) return [];
    const { citation } = labeled;
    // Policy passages stay distinct per section; document chunks collapse per document.
    const documentKey = citation.source_kind === "policy"
      ? `policy:${citation.chunk_id}`
      : `case_document:${citation.source_id || citation.id}`;
    if (seen.has(documentKey)) return [];
    seen.add(documentKey);
    return [labeled];
  });
}

const CONFIDENCES = new Set(["low", "medium", "high"]);

// Takes each note once, by the row it is about; whatever no row claims stays with the card.
type NoteClaimer = (about: string) => SpecialistNote[];

function specialistNotes(
  payload: Record<string, unknown>,
  citations: Map<string, LabeledCitation>,
): Map<string, SpecialistNote[]> {
  const byTarget = new Map<string, SpecialistNote[]>();
  arrayValue(payload.observations).forEach((value, index) => {
    const observation = objectValue(value);
    const kind = textValue(observation?.kind);
    const statement = textValue(observation?.statement);
    const confidence = textValue(observation?.confidence);
    const sources = sourceRefs(textList(observation?.citations), citations);
    // A note without a pinned source was never verified, so it is not shown.
    if (!kind || !statement || !confidence || !CONFIDENCES.has(confidence) || sources.length === 0) return;
    const about = textValue(observation?.about) ?? "run";
    const note: SpecialistNote = {
      key: textValue(observation?.id) ?? `note-${index}`,
      // A visual check describes a page image; no text excerpt confirms it.
      kind: kind === "visual_check" ? "Visual Check, Not Text-Verified" : titleCase(kind),
      confidence: confidence as SpecialistNote["confidence"],
      statement,
      sources,
    };
    byTarget.set(about, [...(byTarget.get(about) ?? []), note]);
  });
  return byTarget;
}

function noteClaimer(notes: Map<string, SpecialistNote[]>): NoteClaimer {
  return (about) => {
    const claimed = notes.get(about) ?? [];
    notes.delete(about);
    return claimed;
  };
}

const ENTITY_BADGES: Record<"match" | "conflict" | "missing", string> = { match: "Match", conflict: "Conflict", missing: "Missing" };

export type EntityReasonCode =
  | "match_exact" | "match_normalized"
  | "conflict_declared" | "conflict_documentary"
  | "missing_declared" | "missing_documentary";

// A plain or normalized match is explained by its badge and values, so only exceptions carry a note.
const ENTITY_REASON_NOTES: Record<EntityReasonCode, string | null> = {
  match_exact: null,
  match_normalized: null,
  conflict_declared: "Documents Agree with Each Other but Differ from the Declared Value.",
  conflict_documentary: "Documents State Different Values.",
  missing_declared: "No Value Was Declared for This Field.",
  missing_documentary: "No Pinned Document States This Value.",
};

// The validator stamps reason_code on accepted rows; rows saved before it did are derived the same way.
function entityReasonCode(row: Record<string, unknown>, documentary: Record<string, unknown>[]): EntityReasonCode {
  const stamped = textValue(row.reason_code);
  if (stamped && stamped in ENTITY_REASON_NOTES) return stamped as EntityReasonCode;
  const outcome = textValue(row.outcome);
  if (outcome === "conflict") {
    return new Set(documentary.map((value) => textValue(value.normalized))).size > 1 ? "conflict_documentary" : "conflict_declared";
  }
  if (outcome === "match") {
    const declared = textValue(row.declared_original) ?? "";
    return documentary.every((value) => (textValue(value.original) ?? "") === declared) ? "match_exact" : "match_normalized";
  }
  return textValue(row.declared_normalized) === null ? "missing_declared" : "missing_documentary";
}

function entityRows(
  payload: Record<string, unknown>,
  citations: Map<string, LabeledCitation>,
  answers: SpecialistAnswerInput[],
  verified: boolean,
  claimNotes: NoteClaimer,
): SpecialistEvidenceRow[] {
  return arrayValue(payload.reconciliations).flatMap((value, index) => {
    const row = objectValue(value);
    if (!row) return [];
    const field = textValue(row.field) ?? "identity_field";
    const addressType = textValue(row.address_type);
    // Mirrors the coordinator's question id for this reconciliation row.
    const questionId = `entity:${field}:${addressType ?? textValue(row.identifier_type) ?? ""}`;
    // Observations name a row as field or field:detail, e.g. address:registered.
    const detailKey = field === "address" ? addressType : field === "identifier" ? textValue(row.identifier_type) : null;
    const outcome = textValue(row.outcome);
    const status: SpecialistEvidenceStatus = outcome === "match" || outcome === "conflict" ? outcome : "missing";

    // Documents that state the same normalized value become one line with several sources.
    const documentary = arrayValue(row.documentary_values).flatMap((item): Record<string, unknown>[] => {
      const value = objectValue(item);
      return value ? [value] : [];
    });
    const groups = new Map<string, { value: string; citationIds: string[] }>();
    for (const documentValue of documentary) {
      const original = textValue(documentValue?.original);
      if (!original) continue;
      const key = textValue(documentValue?.normalized) ?? original.toUpperCase();
      const group = groups.get(key) ?? { value: original, citationIds: [] };
      const citationId = textValue(documentValue?.citation_id);
      if (citationId) group.citationIds.push(citationId);
      groups.set(key, group);
    }
    const observed = [...groups.values()].map((group) => ({
      value: group.value,
      sources: sourceRefs(group.citationIds, citations),
    }));

    const declaredOriginal = textValue(row.declared_original);
    const declaredRepeatsObserved = status === "match"
      && observed.length > 0
      && observed.every((item) => item.value === declaredOriginal);
    return [{
      key: `${field}-${addressType ?? ""}-${index}`,
      label: addressType ? `${titleCase(addressType)} ${titleCase(field)}` : titleCase(field),
      status,
      // Agreement among the applicant's own copies is consistency; a registry makes it a verified match.
      badge: status === "match" && !verified ? "Consistent" : ENTITY_BADGES[status],
      declared: declaredRepeatsObserved ? null : declaredOriginal,
      observed,
      detail: ENTITY_REASON_NOTES[entityReasonCode(row, documentary)],
      resolution: status === "match" ? null
        : resolution(answers.find((answer) => answer.question_id === questionId)),
      notes: claimNotes(detailKey ? `${field}:${detailKey}` : field),
    }];
  });
}

function ownershipRows(
  payload: Record<string, unknown>,
  citations: Map<string, LabeledCitation>,
  answers: SpecialistAnswerInput[],
  claimNotes: NoteClaimer,
): SpecialistEvidenceRow[] {
  const relationships = arrayValue(payload.relationships).flatMap((value, index): SpecialistEvidenceRow[] => {
    const row = objectValue(value);
    if (!row) return [];
    const owner = textValue(row.owner) ?? "Unidentified Owner";
    const owned = textValue(row.owned);
    const percentage = typeof row.percentage === "number" ? row.percentage : null;
    const stake = [percentage !== null ? `${percentage}%` : null, owned ? `of ${owned}` : null].filter(Boolean).join(" ");
    const citationId = textValue(row.citation_id);
    return [{
      key: `relationship-${index}`,
      label: owner,
      status: "evidenced",
      badge: "Evidenced",
      declared: null,
      observed: [{ value: stake || "Ownership Relationship", sources: sourceRefs(citationId ? [citationId] : [], citations) }],
      detail: null,
      resolution: null,
      notes: citationId ? claimNotes(`relationship:${citationId}`) : [],
    }];
  });
  const chains = arrayValue(payload.chains).flatMap((value, index): SpecialistEvidenceRow[] => {
    const chain = objectValue(value);
    if (!chain) return [];
    const path = textList(chain.path);
    const percent = typeof chain.calculated_percent === "number" ? chain.calculated_percent : null;
    return [{
      key: `chain-${index}`,
      label: textValue(chain.ultimate_owner) ?? "Unidentified Owner",
      status: "evidenced",
      badge: "Calculated",
      declared: null,
      observed: [{
        value: percent !== null ? `${percent}% Calculated Interest` : "Calculated Interest",
        sources: sourceRefs(textList(chain.citation_ids), citations),
      }],
      detail: path.length > 1 ? `Path: ${path.join(" → ")}` : null,
      resolution: null,
      notes: claimNotes(`chain:${index}`),
    }];
  });
  const anomalies = arrayValue(payload.anomalies).flatMap((value, index): SpecialistEvidenceRow[] => {
    const anomaly = objectValue(value);
    if (!anomaly) return [];
    const sources = sourceRefs(textList(anomaly.citation_ids), citations);
    const type = textValue(anomaly.type);
    const subject = textValue(anomaly.subject);
    return [{
      key: `anomaly-${index}`,
      label: titleCase(textValue(anomaly.type) ?? "evidence_gap"),
      status: "gap",
      badge: "Evidence Gap",
      declared: null,
      observed: sources.length > 0 ? [{ value: "", sources }] : [],
      detail: textValue(anomaly.details),
      resolution: resolution(answers.find((answer) =>
        answer.specialty === "ownership" && answer.field === type && answer.subject === subject)),
      // The first anomaly of a type takes its notes; later ones of the same type have none left.
      notes: type ? claimNotes(`anomaly:${type}`) : [],
    }];
  });
  return [...anomalies, ...relationships, ...chains];
}

const EXCEPTION_STATUSES = new Set<SpecialistEvidenceStatus>(["conflict", "missing", "gap"]);

function entitySummary(rows: SpecialistEvidenceRow[], verified: boolean): string {
  if (rows.length === 0) return "No Identity Fields Reconciled";
  const matches = rows.filter((row) => row.status === "match").length;
  const conflicts = rows.filter((row) => row.status === "conflict").length;
  const missing = rows.filter((row) => row.status === "missing").length;
  return [
    `${matches} of ${plural(rows.length, "Field")} ${verified ? "Match" : "Consistent"}`,
    conflicts > 0 ? plural(conflicts, "Conflict") : null,
    missing > 0 ? `${missing} Missing` : null,
    verified ? "Registry Verified" : "Not Independently Verified",
  ].filter(Boolean).join(" · ");
}

function ownershipSummary(rows: SpecialistEvidenceRow[]): string {
  const relationships = rows.filter((row) => row.key.startsWith("relationship-")).length;
  const chains = rows.filter((row) => row.key.startsWith("chain-")).length;
  const gaps = rows.filter((row) => row.status === "gap").length;
  if (relationships === 0 && chains === 0 && gaps === 0) return "No Ownership Relationships Evidenced";
  return [
    plural(relationships, "Relationship"),
    chains > 0 ? plural(chains, "Calculated Path") : null,
    gaps > 0 ? plural(gaps, "Evidence Gap") : null,
  ].filter(Boolean).join(" · ");
}

type FinishedContribution = {
  taskId: string;
  specialty: "entity" | "ownership";
  status: unknown;
  payload: Record<string, unknown>;
};

function finishedContributions(run: SpecialistRunInput): FinishedContribution[] {
  return run.agent_activity.tasks.flatMap((task): FinishedContribution[] => {
    if (task.role !== "specialist" || task.status !== "completed" || !task.task_id
      || (task.specialty !== "entity" && task.specialty !== "ownership")) return [];
    const specialty = task.specialty;
    const contribution = run.agent_activity.contributions.find((value) =>
      value.task_id === task.task_id
      && value.specialty === specialty
      && (value.status === "completed" || value.status === "partial"));
    const payload = objectValue(contribution?.payload);
    return payload ? [{ taskId: task.task_id, specialty, status: contribution?.status, payload }] : [];
  });
}

// Each specialist's labeled citations by id, so other views (such as a question's answer options)
// name and open a source exactly as the specialist results do.
export function specialistSources(run: SpecialistRunInput | null): Map<string, Map<string, SpecialistSourceRef>> {
  if (!run) return new Map();
  return new Map(finishedContributions(run).map(({ specialty, payload }) => [specialty, specialistCitations(payload)]));
}

export function specialistEvidence(run: SpecialistRunInput | null): SpecialistEvidence[] {
  if (!run) return [];
  return finishedContributions(run).map(({ taskId, specialty, status, payload }): SpecialistEvidence => {
    const citations = specialistCitations(payload);
    const answers = run.analyst_answers ?? [];
    const verified = run.identity_verification?.status === "verified";
    const notes = specialistNotes(payload, citations);
    const claimNotes = noteClaimer(notes);
    const rows = specialty === "entity"
      ? entityRows(payload, citations, answers, verified, claimNotes)
      : ownershipRows(payload, citations, answers, claimNotes);
    return {
      taskId,
      specialty,
      title: specialty === "entity" ? "Company Identity" : "Beneficial Ownership",
      status: status === "partial" ? "partial" : "completed",
      summary: specialty === "entity" ? entitySummary(rows, verified) : ownershipSummary(rows),
      exceptions: rows.filter((row) => EXCEPTION_STATUSES.has(row.status)),
      confirmed: rows.filter((row) => !EXCEPTION_STATUSES.has(row.status)),
      notes: [...notes.values()].flat(),
    };
  });
}
