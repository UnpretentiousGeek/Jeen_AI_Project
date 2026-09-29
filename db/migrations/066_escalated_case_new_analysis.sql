BEGIN;

-- An escalated case (enhanced review) can take new evidence and start a fresh analysis,
-- like a case that needs attention; otherwise escalation was a dead end. The status list
-- matches CASE_STATUSES_OPEN_FOR_ANALYSIS in src/case-catalog.ts.
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
  evidence_readiness text;
BEGIN
  SELECT * INTO selected_case
  FROM onboarding_cases
  WHERE id = p_case_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'onboarding case % does not exist', p_case_id;
  END IF;

  IF selected_case.status NOT IN ('draft', 'attention_required', 'enhanced_review') THEN
    RAISE EXCEPTION 'case % cannot start a new analysis from status %', selected_case.id, selected_case.status;
  END IF;

  evidence_readiness := case_evidence_readiness(selected_case.id);
  IF evidence_readiness <> 'ready' THEN
    RAISE EXCEPTION 'case % evidence is not ready (status: %)', selected_case.id, evidence_readiness;
  END IF;

  SELECT * INTO STRICT selected_application
  FROM applications WHERE id = selected_case.application_id;
  SELECT * INTO STRICT selected_applicant
  FROM applicants WHERE id = selected_case.applicant_id;

  INSERT INTO analysis_runs (
    case_id, session_id, status, output_schema_version, analyst_instructions,
    policy_effective_on, case_snapshot, started_at
  ) VALUES (
    selected_case.id, p_session_id, 'queued', p_output_schema_version,
    p_analyst_instructions, p_policy_effective_on,
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
    ), NULL
  ) RETURNING * INTO created_run;

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
    AND NOT EXISTS (
      SELECT 1 FROM policy_new_run_exclusions exclusion
      WHERE exclusion.policy_version_id = version.id
    )
    AND policy_chunk_scope_eligible(created_run.id, chunk.id)
    AND ('*' = ANY(chunk.jurisdictions) OR selected_applicant.jurisdiction = ANY(chunk.jurisdictions))
    AND ('*' = ANY(chunk.products) OR selected_applicant.product = ANY(chunk.products))
    AND ('*' = ANY(chunk.business_types) OR selected_applicant.business_type = ANY(chunk.business_types));
  GET DIAGNOSTICS pinned_policy_count = ROW_COUNT;
  IF pinned_policy_count = 0 THEN
    RAISE EXCEPTION 'case % has no applicable policy on %', selected_case.id, p_policy_effective_on;
  END IF;

  UPDATE analysis_runs SET status = 'running', started_at = now()
  WHERE id = created_run.id RETURNING * INTO created_run;
  UPDATE onboarding_cases
  SET active_analysis_run_id = created_run.id, status = 'processing', updated_at = now()
  WHERE id = selected_case.id;
  RETURN created_run;
END;
$$;

COMMIT;
