import { DOCUMENT_TYPES, caseOptionLabel } from "./case-catalog.ts";

// Reviewer-facing names for cited sources. Specialist contributions cite sources by id only,
// so the API stamps these labels onto their citations when it serves a run.

export type RunSource = {
  source_kind: string;
  source_id: string;
  document_type: string | null;
  original_filename: string | null;
  policy_code: string | null;
};

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Names each document by its type, falling back to the filename when the type is generic
// or when two pinned documents share it.
export function runSourceLabels(sources: RunSource[]): Map<string, string> {
  const typeCounts = new Map<string, number>();
  for (const source of sources) {
    if (source.source_kind === "case_document" && source.document_type) {
      typeCounts.set(source.document_type, (typeCounts.get(source.document_type) ?? 0) + 1);
    }
  }
  return new Map(sources.map((source) => {
    const key = `${source.source_kind}:${source.source_id}`;
    if (source.source_kind === "policy") return [key, source.policy_code ?? "Policy"];
    const type = source.document_type ?? "";
    const typeLabel = caseOptionLabel(DOCUMENT_TYPES, type);
    const generic = !type || type === "supporting_document" || typeLabel === type;
    const label = generic || (typeCounts.get(type) ?? 0) > 1
      ? source.original_filename ?? "Case Document"
      : typeLabel;
    return [key, label];
  }));
}

function citationLabel(citation: JsonObject, labels: Map<string, string>): string {
  const kind = citation.source_kind === "policy" ? "policy" : "case_document";
  const base = labels.get(`${kind}:${String(citation.source_id ?? "")}`)
    ?? (kind === "policy" ? "Policy" : "Case Document");
  const locator = typeof citation.locator === "string" ? citation.locator.trim() : "";
  // Policy passages are told apart by section; document chunks carry opaque locators.
  return kind === "policy" && locator ? `${base} · ${locator}` : base;
}

export function withCitationSourceLabels<T extends JsonObject>(contribution: T, labels: Map<string, string>): T {
  const payload = contribution.payload;
  if (!isObject(payload) || !Array.isArray(payload.citations)) return contribution;
  return {
    ...contribution,
    payload: {
      ...payload,
      citations: payload.citations.map((citation) => isObject(citation)
        ? { ...citation, source_label: citationLabel(citation, labels) }
        : citation),
    },
  };
}
