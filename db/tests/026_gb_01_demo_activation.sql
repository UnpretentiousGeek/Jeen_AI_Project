\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
  v_applicant uuid;
  v_application uuid;
  v_case uuid;
  v_submission uuid;
  v_run analysis_runs%ROWTYPE;
  v_codes text[];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM policy_research_candidates candidate
    JOIN policy_rule_scopes rule ON rule.id = candidate.promoted_policy_rule_scope_id
    JOIN policy_chunks chunk ON chunk.id = rule.policy_chunk_id
    WHERE candidate.code = 'GB-01' AND rule.review_state = 'approved'
      AND vector_dims(chunk.embedding) = 1024
  ) THEN
    RAISE EXCEPTION 'GB-01 must be approved and embedded';
  END IF;

  INSERT INTO applicants (legal_name, jurisdiction, business_type, product)
  VALUES ('GB-01 Demo Verification Ltd', 'GB', 'marketplace', 'merchant_payouts')
  RETURNING id INTO v_applicant;
  INSERT INTO applications (applicant_id, submitted_payload)
  VALUES (v_applicant, jsonb_build_object(
    'activity_declaration', jsonb_build_object(
      'payment_activity', 'none',
      'operating_jurisdictions', jsonb_build_array('GB')
    )
  ))
  RETURNING id INTO v_application;
  INSERT INTO onboarding_cases (application_id, applicant_id, reference)
  VALUES (v_application, v_applicant, 'KYB-GB01-VERIFY-' || left(gen_random_uuid()::text, 8))
  RETURNING id INTO v_case;
  INSERT INTO evidence_submissions (case_id, submission_number, submitted_by)
  VALUES (v_case, 1, 'db-test') RETURNING id INTO v_submission;
  INSERT INTO case_documents (
    evidence_submission_id, case_id, applicant_id, document_type,
    original_filename, mime_type, checksum_sha256, storage_path, ingestion_status
  ) VALUES (
    v_submission, v_case, v_applicant, 'supporting_document',
    'gb-01-test.txt', 'text/plain', repeat('a', 64), '/tmp/gb-01-test.txt', 'ready'
  );

  v_run := start_analysis_run(v_case, 'gb-01-positive-' || gen_random_uuid()::text);
  SELECT array_agg(document.code ORDER BY document.code) INTO v_codes
  FROM analysis_run_policy_versions pinned
  JOIN policy_versions version ON version.id = pinned.policy_version_id
  JOIN policy_documents document ON document.id = version.policy_document_id
  WHERE pinned.analysis_run_id = v_run.id;
  IF v_codes IS DISTINCT FROM ARRAY['GB-01']::text[] THEN
    RAISE EXCEPTION 'expected only GB-01 for UK payment institution, got %', v_codes;
  END IF;
  IF v_run.case_snapshot #>> '{provider,legal_name}' <> 'Example Payments Ltd' THEN
    RAISE EXCEPTION 'provider snapshot does not match confirmed demo provider';
  END IF;

  UPDATE onboarding_provider_profile
  SET regulated_roles = ARRAY['bank']::text[], updated_at = now()
  WHERE id = 1;
  INSERT INTO applicants (legal_name, jurisdiction, business_type, product)
  VALUES ('GB-01 Ineligible Provider Verification Ltd', 'GB', 'marketplace', 'merchant_payouts')
  RETURNING id INTO v_applicant;
  INSERT INTO applications (applicant_id, submitted_payload)
  VALUES (v_applicant, jsonb_build_object(
    'activity_declaration', jsonb_build_object(
      'payment_activity', 'none',
      'operating_jurisdictions', jsonb_build_array('GB')
    )
  ))
  RETURNING id INTO v_application;
  INSERT INTO onboarding_cases (application_id, applicant_id, reference)
  VALUES (v_application, v_applicant, 'KYB-GB01-NEG-' || left(gen_random_uuid()::text, 8))
  RETURNING id INTO v_case;
  INSERT INTO evidence_submissions (case_id, submission_number, submitted_by)
  VALUES (v_case, 1, 'db-test') RETURNING id INTO v_submission;
  INSERT INTO case_documents (
    evidence_submission_id, case_id, applicant_id, document_type,
    original_filename, mime_type, checksum_sha256, storage_path, ingestion_status
  ) VALUES (
    v_submission, v_case, v_applicant, 'supporting_document',
    'gb-01-negative.txt', 'text/plain', repeat('b', 64), '/tmp/gb-01-negative.txt', 'ready'
  );
  BEGIN
    PERFORM start_analysis_run(v_case, 'gb-01-negative-' || gen_random_uuid()::text);
    RAISE EXCEPTION 'GB-01 was pinned to a provider without the required role';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%has no applicable policy%' THEN RAISE; END IF;
  END;
END $$;

ROLLBACK;
