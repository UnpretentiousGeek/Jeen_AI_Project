/** How much a policy assessment proposal tells an analyst, most informative first. */
export const ASSESSMENT_TIERS = ["declaration_conflict", "decisive", "uncertain", "uninformative"] as const;
export type AssessmentTier = (typeof ASSESSMENT_TIERS)[number];

interface RankableAssessment {
  proposal: {
    outcome: string;
    facts: readonly unknown[];
    /** Absent on proposals stored before conflicts were reported. */
    declaration_conflicts?: readonly unknown[];
  };
}

/**
 * A proposal whose cited facts contradict the applicant's own declaration comes first, then one
 * that cites facts and reaches supports or contradicts, then an uncertain one that cites facts.
 * A not_addressed proposal, or one citing no facts, says least.
 */
export function assessmentTier({ proposal }: RankableAssessment): AssessmentTier {
  if (proposal.declaration_conflicts?.length) return "declaration_conflict";
  if (proposal.facts.length === 0 || proposal.outcome === "not_addressed") return "uninformative";
  return proposal.outcome === "uncertain" ? "uncertain" : "decisive";
}

/** Orders proposals by tier; within a tier, more conflicts, then contradicts before supports,
 * then more cited facts. Otherwise the given order is kept. */
export function rankAssessments<T extends RankableAssessment>(assessments: readonly T[]): T[] {
  const key = (item: T) => [
    ASSESSMENT_TIERS.indexOf(assessmentTier(item)),
    -(item.proposal.declaration_conflicts?.length ?? 0),
    item.proposal.outcome === "contradicts" ? 0 : 1,
    -item.proposal.facts.length,
  ];
  return assessments
    .map((item, index) => ({ item, index, key: key(item) }))
    .sort((a, b) => a.key.reduce((order, value, position) => order || value - b.key[position]!, 0) || a.index - b.index)
    .map(({ item }) => item);
}
