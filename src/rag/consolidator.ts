import { type AnalysisSnapshot, parseAnalysisSnapshot } from "../contracts/analysis-snapshot.js";
import { type Citation } from "../contracts/shared.js";
import { type SpecialistArtifact } from "../contracts/specialist-artifact.js";

function citationKey(citation: Citation): string {
  if (citation.source_kind === "external_web") {
    return `external_web:${citation.canonical_url}:${citation.content_hash}`;
  }
  if (citation.source_kind === "human_input") {
    return `human_input:${citation.source_id}`;
  }
  return `${citation.source_kind}:${citation.source_id}:${citation.chunk_id}`;
}

function deduplicateCitations(artifacts: SpecialistArtifact[]): {
  citations: Citation[];
  canonicalIdByArtifactCitation: Map<string, string>;
} {
  const citationByKey = new Map<string, Citation>();
  const canonicalIdByArtifactCitation = new Map<string, string>();
  for (const artifact of artifacts) {
    for (const citation of artifact.citations) {
      const key = citationKey(citation);
      const canonicalId = citationByKey.get(key)?.id
        ?? `citation-${citationByKey.size + 1}`;
      if (!citationByKey.has(key)) {
        citationByKey.set(key, { ...citation, id: canonicalId });
      }
      canonicalIdByArtifactCitation.set(`${artifact.artifact_id}:${citation.id}`, canonicalId);
    }
  }
  return { citations: [...citationByKey.values()], canonicalIdByArtifactCitation };
}

function canonicalReferences(
  artifact: SpecialistArtifact,
  citationIds: string[],
  mapping: Map<string, string>,
): string[] {
  return [...new Set(citationIds.map((citationId) => {
    const canonicalId = mapping.get(`${artifact.artifact_id}:${citationId}`);
    if (canonicalId === undefined) {
      throw new Error(`artifact ${artifact.artifact_id} references unknown citation ${citationId}`);
    }
    return canonicalId;
  }))];
}

export function consolidateSpecialistArtifacts(input: {
  caseId: string;
  analysisRunId: string;
  artifacts: SpecialistArtifact[];
}): AnalysisSnapshot {
  if (input.artifacts.length === 0) {
    throw new Error("at least one specialist artifact is required");
  }
  if (input.artifacts.some((artifact) => artifact.analysis_run_id !== input.analysisRunId)) {
    throw new Error("all specialist artifacts must belong to the requested analysis run");
  }
  const artifactIds = new Set(input.artifacts.map((artifact) => artifact.artifact_id));
  if (artifactIds.size !== input.artifacts.length) {
    throw new Error("specialist artifact ids must be unique");
  }

  const { citations, canonicalIdByArtifactCitation } = deduplicateCitations(input.artifacts);
  const observationsByRequirement = new Map<string, Array<{
    artifact: SpecialistArtifact;
    observation: SpecialistArtifact["observations"][number];
  }>>();
  for (const artifact of input.artifacts) {
    for (const observation of artifact.observations) {
      if (observation.requirement_code === undefined) {
        continue;
      }
      const entries = observationsByRequirement.get(observation.requirement_code) ?? [];
      entries.push({ artifact, observation });
      observationsByRequirement.set(observation.requirement_code, entries);
    }
  }

  const findings = [...observationsByRequirement.entries()].map(([requirementCode, entries], index) => {
    const contributingArtifacts = [...new Set(entries.map(({ artifact }) => artifact.artifact_id))];
    const hasAssessment = entries.some(({ artifact }) => artifact.specialty !== "policy");
    const hasGap = input.artifacts.some((artifact) =>
      artifact.evidence_gaps.some((gap) => gap.requirement_code === requirementCode)
    );
    const hasConflict = entries.some(({ artifact }) => artifact.conflicts.length > 0);
    const outcome = hasAssessment && !hasGap && !hasConflict ? "met" as const : "uncertain" as const;
    const citationIds = [...new Set(entries.flatMap(({ artifact, observation }) =>
      canonicalReferences(artifact, observation.citation_ids, canonicalIdByArtifactCitation)
    ))];
    const summaries = entries.map(({ observation }) => observation.summary);

    return {
      id: `finding-${index + 1}`,
      requirement_code: requirementCode,
      outcome,
      summary: summaries.join(" "),
      rationale: {
        requirement: entries.find(({ artifact }) => artifact.specialty === "policy")?.observation.summary
          ?? `Assess requirement ${requirementCode}.`,
        evidence_assessment: entries
          .filter(({ artifact }) => artifact.specialty !== "policy")
          .map(({ observation }) => observation.rationale_summary)
          .join(" ") || "No non-policy specialist assessment was supplied.",
        uncertainty: hasGap
          ? "A specialist reported missing evidence."
          : hasConflict
            ? "A specialist reported conflicting evidence."
            : hasAssessment
              ? "No material uncertainty was reported by the contributing specialists."
              : "Only policy applicability was established.",
        conclusion: outcome === "met"
          ? "The supplied evidence supports this requirement for analyst review."
          : "The requirement remains uncertain and needs analyst attention.",
        recommendation: outcome === "met"
          ? "Present the cited finding for analyst review."
          : "Resolve the cited gap or conflict before relying on this finding.",
      },
      confidence: Math.min(...entries.map(({ observation }) => observation.confidence)),
      citation_ids: citationIds,
      agent_artifact_ids: contributingArtifacts,
    };
  });

  const evidenceGaps = input.artifacts.flatMap((artifact) => artifact.evidence_gaps.map((gap) => ({
    ...gap,
    citation_ids: canonicalReferences(artifact, gap.citation_ids, canonicalIdByArtifactCitation),
    agent_artifact_ids: [artifact.artifact_id],
  })));
  const conflicts = input.artifacts.flatMap((artifact) => artifact.conflicts.map((conflict) => ({
    ...conflict,
    citation_ids: canonicalReferences(artifact, conflict.citation_ids, canonicalIdByArtifactCitation),
    agent_artifact_ids: [artifact.artifact_id],
  })));

  return parseAnalysisSnapshot({
    schema_version: "1.1",
    case_id: input.caseId,
    analysis_run_id: input.analysisRunId,
    status: evidenceGaps.length > 0 || conflicts.length > 0 ? "attention_required" : "ready_for_review",
    agent_contributions: input.artifacts.map((artifact) => ({
      task_id: artifact.task_id,
      context_id: artifact.context_id,
      agent: artifact.agent,
      status: artifact.status === "failed" ? "failed" : "completed",
      artifact_ids: [artifact.artifact_id],
    })),
    findings,
    evidence_gaps: evidenceGaps,
    conflicts,
    citations,
    human_input_request: null,
    proposed_actions: [],
  });
}
