BEGIN;

CREATE TABLE policy_assessment_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_run_id uuid NOT NULL,
  case_id uuid NOT NULL,
  policy_chunk_id uuid NOT NULL REFERENCES policy_chunks(id),
  document_id uuid NOT NULL,
  model text NOT NULL CHECK (length(btrim(model)) > 0),
  proposal jsonb NOT NULL CHECK (jsonb_typeof(proposal) = 'object'),
  review_state text NOT NULL DEFAULT 'pending_review'
    CHECK (review_state IN ('pending_review', 'accepted', 'rejected')),
  reviewed_by text,
  review_rationale text,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (analysis_run_id, case_id) REFERENCES analysis_runs(id, case_id) ON DELETE CASCADE,
  FOREIGN KEY (document_id, case_id) REFERENCES case_documents(id, case_id) ON DELETE CASCADE,
  CHECK (
    (review_state = 'pending_review' AND reviewed_by IS NULL
      AND review_rationale IS NULL AND reviewed_at IS NULL)
    OR
    (review_state <> 'pending_review' AND reviewed_by IS NOT NULL
      AND review_rationale IS NOT NULL AND length(btrim(reviewed_by)) > 0
      AND length(btrim(review_rationale)) > 0 AND reviewed_at IS NOT NULL)
  )
);

CREATE INDEX policy_assessment_proposals_run_created_idx
  ON policy_assessment_proposals (analysis_run_id, created_at DESC, id);

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
    JOIN policy_chunks chunk
      ON chunk.policy_version_id = pinned.policy_version_id
    WHERE run.id = NEW.analysis_run_id
      AND run.case_id = NEW.case_id
      AND chunk.id = NEW.policy_chunk_id
      AND ('*' = ANY(chunk.jurisdictions)
        OR run.case_snapshot #>> '{applicant,jurisdiction}' = ANY(chunk.jurisdictions))
      AND ('*' = ANY(chunk.products)
        OR run.case_snapshot #>> '{applicant,product}' = ANY(chunk.products))
      AND ('*' = ANY(chunk.business_types)
        OR run.case_snapshot #>> '{applicant,business_type}' = ANY(chunk.business_types));
  IF policy_text IS NULL THEN
    RAISE EXCEPTION 'policy passage is not applicable and pinned to this run';
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

CREATE TRIGGER policy_assessment_sources_guard
BEFORE INSERT ON policy_assessment_proposals
FOR EACH ROW EXECUTE FUNCTION check_policy_assessment_sources();

CREATE OR REPLACE FUNCTION protect_policy_assessment_proposal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.review_state <> 'pending_review'
    OR NEW.analysis_run_id IS DISTINCT FROM OLD.analysis_run_id
    OR NEW.case_id IS DISTINCT FROM OLD.case_id
    OR NEW.policy_chunk_id IS DISTINCT FROM OLD.policy_chunk_id
    OR NEW.document_id IS DISTINCT FROM OLD.document_id
    OR NEW.model IS DISTINCT FROM OLD.model
    OR NEW.proposal IS DISTINCT FROM OLD.proposal
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'policy assessment proposal is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER policy_assessment_proposal_immutable
BEFORE UPDATE ON policy_assessment_proposals
FOR EACH ROW EXECUTE FUNCTION protect_policy_assessment_proposal();

COMMIT;
