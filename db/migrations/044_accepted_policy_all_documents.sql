BEGIN;

CREATE OR REPLACE FUNCTION accepted_policy_assessments_for_run(p_run_id uuid)
RETURNS SETOF policy_assessment_proposals
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT proposal.*
  FROM policy_assessment_proposals proposal
  JOIN analysis_runs run
    ON run.id = proposal.analysis_run_id AND run.case_id = proposal.case_id
  JOIN analysis_run_policy_versions pinned_policy
    ON pinned_policy.analysis_run_id = run.id
  JOIN policy_versions version
    ON version.id = pinned_policy.policy_version_id
  JOIN policy_chunks policy_chunk
    ON policy_chunk.id = proposal.policy_chunk_id
   AND policy_chunk.policy_version_id = version.id
  JOIN analysis_run_documents pinned_document
    ON pinned_document.analysis_run_id = run.id
   AND pinned_document.case_id = run.case_id
   AND pinned_document.document_id = proposal.document_id
  JOIN case_documents document
    ON document.id = pinned_document.document_id
   AND document.case_id = pinned_document.case_id
  WHERE run.id = p_run_id
    AND proposal.review_state = 'accepted'
    AND version.effective_from <= run.policy_effective_on
    AND (version.effective_to IS NULL OR version.effective_to >= run.policy_effective_on)
    AND NOT version.superseded
    AND ('*' = ANY(policy_chunk.jurisdictions)
      OR run.case_snapshot #>> '{applicant,jurisdiction}' = ANY(policy_chunk.jurisdictions))
    AND ('*' = ANY(policy_chunk.products)
      OR run.case_snapshot #>> '{applicant,product}' = ANY(policy_chunk.products))
    AND ('*' = ANY(policy_chunk.business_types)
      OR run.case_snapshot #>> '{applicant,business_type}' = ANY(policy_chunk.business_types))
    AND document.ingestion_status = 'ready';
$$;

COMMIT;
