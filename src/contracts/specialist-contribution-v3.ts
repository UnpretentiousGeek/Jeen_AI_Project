import { z } from "zod";

const identifier = z.string().min(1).max(256);

export const pinnedCitationV3Schema = z.object({
  id: identifier,
  source_kind: z.enum(["case_document", "policy"]),
  source_id: identifier,
  chunk_id: identifier,
  locator: z.string().min(1),
  excerpt: z.string().min(1),
}).strict();

// 3.2.0 adds advisory observations; 3.1.0 contributions stay valid without them.
const contractVersion = z.enum(["3.1.0", "3.2.0"]);

export const entityObservationKinds = [
  "near_miss_equivalence",
  "date_explanation",
  "visual_check",
  "internal_consistency",
  "analyst_question",
] as const;

export const ownershipObservationKinds = [
  "unexplained_remainder",
  "control_beyond_shareholding",
  "incomplete_chain",
  "percentage_conflict_explanation",
  "person_name_match",
  "risk_pattern",
] as const;

// Advisory agent notes: verified against pinned citations, never part of the deterministic findings.
const observationSchema = <Kinds extends readonly [string, ...string[]]>(kinds: Kinds) => z.object({
  id: z.string().min(1).max(64).optional(),
  kind: z.enum(kinds),
  about: z.string().min(1).max(120),
  statement: z.string().min(1).max(600),
  confidence: z.enum(["low", "medium", "high"]),
  citations: z.array(identifier).min(1).max(5),
}).strict();

export const entityObservationV3Schema = observationSchema(entityObservationKinds);
export const ownershipObservationV3Schema = observationSchema(ownershipObservationKinds);

type Observation = { kind: string; about: string; confidence: string; citations: string[] };

function refineObservations(
  observations: Observation[] | undefined,
  citationIds: Set<string>,
  context: z.RefinementCtx,
) {
  const perRow = new Map<string, number>();
  for (const observation of observations ?? []) {
    perRow.set(observation.about, (perRow.get(observation.about) ?? 0) + 1);
    // A visual check reads a page image no excerpt can confirm, so it never claims high confidence.
    if (observation.kind === "visual_check" && observation.confidence === "high") {
      context.addIssue({ code: "custom", path: ["observations"], message: "visual checks cannot be high confidence" });
    }
    for (const citationId of observation.citations) {
      if (!citationIds.has(citationId)) {
        context.addIssue({ code: "custom", path: ["observations"], message: `unknown citation ${citationId}` });
      }
    }
  }
  if ([...perRow.values()].some((count) => count > 2)) {
    context.addIssue({ code: "custom", path: ["observations"], message: "at most 2 observations per row" });
  }
}

const contributionBase = z.object({
  contract_version: contractVersion,
  contribution_kind: z.literal("specialist_contribution"),
  contribution_id: identifier,
  analysis_run_id: z.uuid(),
  task_id: identifier,
  context_id: identifier,
  status: z.enum(["completed", "partial", "failed"]),
  citations: z.array(pinnedCitationV3Schema),
  deterministic_validation: z.object({
    validator: identifier,
    outcome: z.literal("accepted"),
    checks: z.array(identifier).min(1),
    validated_at: z.iso.datetime(),
    assembled_from: z.literal("pinned_evidence").optional(),
    dropped_citation_ids: z.array(z.string()).optional(),
    dropped_observation_ids: z.array(z.string()).optional(),
  }).strict(),
});

const documentaryValue = z.object({
  original: z.string().min(1),
  normalized: z.string().min(1),
  citation_id: identifier,
  observed_at: z.string().nullable(),
}).strict();

export const entitySpecialistContributionV3Schema = contributionBase.extend({
  specialty: z.literal("entity"),
  specialist: z.object({
    name: z.literal("kyb-entity-agent"),
    version: contractVersion,
  }).strict(),
  reconciliations: z.array(z.object({
    field: z.enum(["legal_name", "identifier", "jurisdiction", "address"]),
    address_type: z.enum(["registered", "operating", "mailing"]).nullable(),
    identifier_type: z.string().min(1).nullable(),
    declared_original: z.string().nullable(),
    declared_normalized: z.string().nullable(),
    documentary_values: z.array(documentaryValue),
    outcome: z.enum(["match", "conflict", "missing"]),
    rationale_summary: z.string().min(1),
    // Added by the deterministic validator after acceptance; earlier contributions omit it.
    reason_code: z.enum([
      "match_exact", "match_normalized", "conflict_declared", "conflict_documentary",
      "missing_declared", "missing_documentary",
    ]).optional(),
  }).strict()).min(6),
  observations: z.array(entityObservationV3Schema).max(8).optional(),
}).strict().superRefine((value, context) => {
  if (value.contribution_id !== `entity-${value.task_id}`) {
    context.addIssue({ code: "custom", path: ["contribution_id"], message: "entity contribution id must be task-derived" });
  }
  const citationIds = new Set(value.citations.map((citation) => citation.id));
  for (const row of value.reconciliations) {
    for (const documentary of row.documentary_values) {
      if (!citationIds.has(documentary.citation_id)) {
        context.addIssue({ code: "custom", path: ["citations"], message: `unknown citation ${documentary.citation_id}` });
      }
    }
  }
  refineObservations(value.observations, citationIds, context);
});

const ownershipAnomalyType = z.enum([
  "duplicate_relationship",
  "inconsistent_percentage",
  "cycle",
  "incomplete_total",
  "overallocated_total",
  "incomplete_chain",
]);

export const ownershipSpecialistContributionV3Schema = contributionBase.extend({
  specialty: z.literal("ownership"),
  specialist: z.object({
    name: z.literal("kyb-ownership-agent"),
    version: contractVersion,
  }).strict(),
  relationships: z.array(z.object({
    owner: z.string().min(1),
    owner_type: z.enum(["person", "entity"]),
    owned: z.string().min(1),
    percentage: z.number().min(0).max(100),
    citation_id: identifier,
  }).strict()),
  chains: z.array(z.object({
    ultimate_owner: z.string().min(1),
    path: z.array(z.string().min(1)).min(2),
    edge_percentages: z.array(z.number().min(0).max(100)).min(1),
    calculated_percent: z.number().min(0).max(100),
    citation_ids: z.array(identifier).min(1),
  }).strict()),
  direct_total_percent: z.number().min(0),
  unexplained_remainder_percent: z.number().min(0).max(100),
  anomalies: z.array(z.object({
    type: ownershipAnomalyType,
    subject: z.string().min(1),
    details: z.string().min(1),
    citation_ids: z.array(identifier),
  }).strict()),
  observations: z.array(ownershipObservationV3Schema).max(8).optional(),
}).strict().superRefine((value, context) => {
  if (value.contribution_id !== `ownership-${value.task_id}`) {
    context.addIssue({ code: "custom", path: ["contribution_id"], message: "ownership contribution id must be task-derived" });
  }
  const citationIds = new Set(value.citations.map((citation) => citation.id));
  const references = [
    ...value.relationships.map((relationship) => relationship.citation_id),
    ...value.chains.flatMap((chain) => chain.citation_ids),
    ...value.anomalies.flatMap((anomaly) => anomaly.citation_ids),
  ];
  for (const citationId of references) {
    if (!citationIds.has(citationId)) {
      context.addIssue({ code: "custom", path: ["citations"], message: `unknown citation ${citationId}` });
    }
  }
  refineObservations(value.observations, citationIds, context);
});

export type EntitySpecialistContributionV3 = z.infer<typeof entitySpecialistContributionV3Schema>;
export type SpecialistObservationV3 = z.infer<typeof entityObservationV3Schema> | z.infer<typeof ownershipObservationV3Schema>;
export type OwnershipSpecialistContributionV3 = z.infer<typeof ownershipSpecialistContributionV3Schema>;
