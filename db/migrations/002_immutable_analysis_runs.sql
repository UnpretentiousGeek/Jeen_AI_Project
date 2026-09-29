BEGIN;

ALTER TABLE analysis_runs
  ADD COLUMN IF NOT EXISTS policy_effective_on date,
  ADD COLUMN IF NOT EXISTS case_snapshot jsonb;

UPDATE analysis_runs run
SET
  policy_effective_on = COALESCE(run.policy_effective_on, run.created_at::date),
  case_snapshot = COALESCE(
    run.case_snapshot,
    jsonb_build_object(
      'case_reference', onboarding_case.reference,
      'application_id', application.id,
      'applicant', jsonb_build_object(
        'id', applicant.id,
        'legal_name', applicant.legal_name,
        'jurisdiction', applicant.jurisdiction,
        'business_type', applicant.business_type,
        'product', applicant.product
      ),
      'submitted_payload', application.submitted_payload
    )
  )
FROM onboarding_cases onboarding_case
JOIN applications application ON application.id = onboarding_case.application_id
JOIN applicants applicant ON applicant.id = onboarding_case.applicant_id
WHERE run.case_id = onboarding_case.id
  AND (run.policy_effective_on IS NULL OR run.case_snapshot IS NULL);

ALTER TABLE analysis_runs
  ALTER COLUMN policy_effective_on SET NOT NULL,
  ALTER COLUMN case_snapshot SET NOT NULL;

CREATE OR REPLACE FUNCTION start_analysis_run(
  p_case_id uuid,
  p_session_id text,
  p_analyst_instructions text DEFAULT NULL,
  p_output_schema_version text DEFAULT '1.1',
  p_policy_effective_on date DEFAULT CURRENT_DATE
)
RETURNS analysis_runs
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  selected_case onboarding_cases%ROWTYPE;
  selected_application applications%ROWTYPE;
  selected_applicant applicants%ROWTYPE;
  created_run analysis_runs%ROWTYPE;
  pinned_document_count integer;
  pinned_policy_count integer;
BEGIN
  SELECT *
  INTO selected_case
  FROM onboarding_cases
  WHERE id = p_case_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'onboarding case % does not exist', p_case_id;
  END IF;

  SELECT *
  INTO STRICT selected_application
  FROM applications
  WHERE id = selected_case.application_id;

  SELECT *
  INTO STRICT selected_applicant
  FROM applicants
  WHERE id = selected_case.applicant_id;

  INSERT INTO analysis_runs (
    case_id,
    session_id,
    status,
    output_schema_version,
    analyst_instructions,
    policy_effective_on,
    case_snapshot,
    started_at
  )
  VALUES (
    selected_case.id,
    p_session_id,
    'queued',
    p_output_schema_version,
    p_analyst_instructions,
    p_policy_effective_on,
    jsonb_build_object(
      'case_reference', selected_case.reference,
      'application_id', selected_application.id,
      'applicant', jsonb_build_object(
        'id', selected_applicant.id,
        'legal_name', selected_applicant.legal_name,
        'jurisdiction', selected_applicant.jurisdiction,
        'business_type', selected_applicant.business_type,
        'product', selected_applicant.product
      ),
      'submitted_payload', selected_application.submitted_payload
    ),
    NULL
  )
  RETURNING * INTO created_run;

  INSERT INTO analysis_run_documents (analysis_run_id, case_id, document_id)
  SELECT created_run.id, document.case_id, document.id
  FROM case_documents document
  WHERE document.case_id = selected_case.id
    AND document.ingestion_status = 'ready';

  GET DIAGNOSTICS pinned_document_count = ROW_COUNT;

  IF pinned_document_count = 0 THEN
    RAISE EXCEPTION 'case % has no ready evidence to analyze', selected_case.id;
  END IF;

  INSERT INTO analysis_run_policy_versions (analysis_run_id, policy_version_id)
  SELECT DISTINCT created_run.id, version.id
  FROM policy_versions version
  JOIN policy_chunks chunk ON chunk.policy_version_id = version.id
  WHERE version.effective_from <= p_policy_effective_on
    AND (version.effective_to IS NULL OR version.effective_to >= p_policy_effective_on)
    AND NOT version.superseded
    AND ('*' = ANY(chunk.jurisdictions) OR selected_applicant.jurisdiction = ANY(chunk.jurisdictions))
    AND ('*' = ANY(chunk.products) OR selected_applicant.product = ANY(chunk.products))
    AND ('*' = ANY(chunk.business_types) OR selected_applicant.business_type = ANY(chunk.business_types));

  GET DIAGNOSTICS pinned_policy_count = ROW_COUNT;

  IF pinned_policy_count = 0 THEN
    RAISE EXCEPTION 'case % has no applicable policy on %', selected_case.id, p_policy_effective_on;
  END IF;

  UPDATE analysis_runs
  SET
    status = 'running',
    started_at = now()
  WHERE id = created_run.id
  RETURNING * INTO created_run;

  UPDATE onboarding_cases
  SET
    active_analysis_run_id = created_run.id,
    status = 'processing',
    updated_at = now()
  WHERE id = selected_case.id;

  RETURN created_run;
END;
$$;

CREATE OR REPLACE FUNCTION reject_snapshot_row_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME;
END;
$$;

DROP TRIGGER IF EXISTS immutable_analysis_run_documents ON analysis_run_documents;

CREATE TRIGGER immutable_analysis_run_documents
BEFORE UPDATE OR DELETE ON analysis_run_documents
FOR EACH ROW EXECUTE FUNCTION reject_snapshot_row_mutation();

DROP TRIGGER IF EXISTS immutable_analysis_run_policy_versions ON analysis_run_policy_versions;

CREATE TRIGGER immutable_analysis_run_policy_versions
BEFORE UPDATE OR DELETE ON analysis_run_policy_versions
FOR EACH ROW EXECUTE FUNCTION reject_snapshot_row_mutation();

CREATE OR REPLACE FUNCTION reject_late_snapshot_insertion()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM analysis_runs run
    WHERE run.id = NEW.analysis_run_id
      AND run.status = 'queued'
  ) THEN
    RAISE EXCEPTION 'cannot add inputs after an analysis run starts';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS reject_late_analysis_run_document ON analysis_run_documents;

CREATE TRIGGER reject_late_analysis_run_document
BEFORE INSERT ON analysis_run_documents
FOR EACH ROW EXECUTE FUNCTION reject_late_snapshot_insertion();

DROP TRIGGER IF EXISTS reject_late_analysis_run_policy_version ON analysis_run_policy_versions;

CREATE TRIGGER reject_late_analysis_run_policy_version
BEFORE INSERT ON analysis_run_policy_versions
FOR EACH ROW EXECUTE FUNCTION reject_late_snapshot_insertion();

CREATE OR REPLACE FUNCTION protect_analysis_run_inputs()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.case_id IS DISTINCT FROM OLD.case_id
    OR NEW.session_id IS DISTINCT FROM OLD.session_id
    OR NEW.output_schema_version IS DISTINCT FROM OLD.output_schema_version
    OR NEW.analyst_instructions IS DISTINCT FROM OLD.analyst_instructions
    OR NEW.policy_effective_on IS DISTINCT FROM OLD.policy_effective_on
    OR NEW.case_snapshot IS DISTINCT FROM OLD.case_snapshot
  THEN
    RAISE EXCEPTION 'analysis run inputs are immutable';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_analysis_run_inputs_trigger ON analysis_runs;

CREATE TRIGGER protect_analysis_run_inputs_trigger
BEFORE UPDATE ON analysis_runs
FOR EACH ROW EXECUTE FUNCTION protect_analysis_run_inputs();

CREATE OR REPLACE FUNCTION protect_pinned_document()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_document_id uuid := COALESCE(OLD.id, NEW.id);
BEGIN
  IF EXISTS (
    SELECT 1
    FROM analysis_run_documents snapshot
    WHERE snapshot.document_id = target_document_id
  ) THEN
    RAISE EXCEPTION 'pinned document % is immutable', target_document_id;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS protect_pinned_document_identity_trigger ON case_documents;
DROP TRIGGER IF EXISTS protect_pinned_document_trigger ON case_documents;
DROP FUNCTION IF EXISTS protect_pinned_document_identity();

CREATE TRIGGER protect_pinned_document_trigger
BEFORE UPDATE OR DELETE ON case_documents
FOR EACH ROW EXECUTE FUNCTION protect_pinned_document();

CREATE OR REPLACE FUNCTION protect_pinned_document_chunk()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  previous_document_id uuid := CASE WHEN TG_OP <> 'INSERT' THEN OLD.document_id END;
  next_document_id uuid := CASE WHEN TG_OP <> 'DELETE' THEN NEW.document_id END;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM analysis_run_documents snapshot
    WHERE snapshot.document_id IN (previous_document_id, next_document_id)
  ) THEN
    RAISE EXCEPTION 'chunks for a pinned document are immutable';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS protect_pinned_document_chunks_trigger ON document_chunks;

CREATE TRIGGER protect_pinned_document_chunks_trigger
BEFORE INSERT OR UPDATE OR DELETE ON document_chunks
FOR EACH ROW EXECUTE FUNCTION protect_pinned_document_chunk();

CREATE OR REPLACE FUNCTION protect_pinned_policy_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_policy_version_id uuid := COALESCE(OLD.id, NEW.id);
BEGIN
  IF EXISTS (
    SELECT 1
    FROM analysis_run_policy_versions snapshot
    WHERE snapshot.policy_version_id = target_policy_version_id
  ) THEN
    RAISE EXCEPTION 'pinned policy version % is immutable', target_policy_version_id;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS protect_pinned_policy_version_trigger ON policy_versions;

CREATE TRIGGER protect_pinned_policy_version_trigger
BEFORE UPDATE OR DELETE ON policy_versions
FOR EACH ROW EXECUTE FUNCTION protect_pinned_policy_version();

CREATE OR REPLACE FUNCTION protect_pinned_policy_chunk()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  previous_policy_version_id uuid := CASE WHEN TG_OP <> 'INSERT' THEN OLD.policy_version_id END;
  next_policy_version_id uuid := CASE WHEN TG_OP <> 'DELETE' THEN NEW.policy_version_id END;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM analysis_run_policy_versions snapshot
    WHERE snapshot.policy_version_id IN (
      previous_policy_version_id,
      next_policy_version_id
    )
  ) THEN
    RAISE EXCEPTION 'chunks for a pinned policy version are immutable';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS protect_pinned_policy_chunks_trigger ON policy_chunks;

CREATE TRIGGER protect_pinned_policy_chunks_trigger
BEFORE INSERT OR UPDATE OR DELETE ON policy_chunks
FOR EACH ROW EXECUTE FUNCTION protect_pinned_policy_chunk();

COMMIT;
