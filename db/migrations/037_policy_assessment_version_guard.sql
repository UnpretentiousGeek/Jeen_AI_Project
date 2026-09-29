BEGIN;

CREATE OR REPLACE FUNCTION check_policy_assessment_sources()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  policy_text text;
  evidence_text text;
  fact jsonb;
BEGIN
  SELECT chunk.content INTO policy_text
    FROM analysis_runs run
    JOIN analysis_run_policy_versions pinned
      ON pinned.analysis_run_id = run.id
    JOIN policy_versions version
      ON version.id = pinned.policy_version_id
    JOIN policy_chunks chunk
      ON chunk.policy_version_id = version.id
    WHERE run.id = NEW.analysis_run_id
      AND run.case_id = NEW.case_id
      AND chunk.id = NEW.policy_chunk_id
      AND version.effective_from <= run.policy_effective_on
      AND (version.effective_to IS NULL OR version.effective_to >= run.policy_effective_on)
      AND NOT version.superseded
      AND ('*' = ANY(chunk.jurisdictions)
        OR run.case_snapshot #>> '{applicant,jurisdiction}' = ANY(chunk.jurisdictions))
      AND ('*' = ANY(chunk.products)
        OR run.case_snapshot #>> '{applicant,product}' = ANY(chunk.products))
      AND ('*' = ANY(chunk.business_types)
        OR run.case_snapshot #>> '{applicant,business_type}' = ANY(chunk.business_types));
  IF policy_text IS NULL THEN
    RAISE EXCEPTION 'policy passage is not active, applicable and pinned to this run';
  END IF;
  IF length(btrim(COALESCE(NEW.proposal #>> '{requirement,excerpt}', ''))) < 8
    OR strpos(policy_text, COALESCE(NEW.proposal #>> '{requirement,excerpt}', '')) = 0 THEN
    RAISE EXCEPTION 'policy requirement excerpt is not present in its source passage';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM analysis_run_documents pinned
    JOIN case_documents document
      ON document.id = pinned.document_id AND document.case_id = pinned.case_id
    WHERE pinned.analysis_run_id = NEW.analysis_run_id
      AND pinned.case_id = NEW.case_id
      AND document.id = NEW.document_id
      AND document.document_type = 'formation_certificate'
      AND document.ingestion_status = 'ready'
  ) THEN
    RAISE EXCEPTION 'formation certificate is not ready and pinned to this run';
  END IF;
  IF jsonb_typeof(NEW.proposal -> 'facts') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'policy assessment facts must be an array';
  END IF;
  FOR fact IN SELECT value FROM jsonb_array_elements(NEW.proposal -> 'facts') LOOP
    SELECT chunk.content INTO evidence_text
    FROM document_chunks chunk
    WHERE chunk.id = (fact ->> 'chunk_id')::uuid
      AND chunk.document_id = NEW.document_id
      AND chunk.case_id = NEW.case_id;
    IF evidence_text IS NULL OR length(btrim(COALESCE(fact ->> 'excerpt', ''))) < 8
      OR strpos(COALESCE(evidence_text, ''), COALESCE(fact ->> 'excerpt', '')) = 0 THEN
      RAISE EXCEPTION 'policy assessment fact excerpt is not present in its source passage';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

COMMIT;
