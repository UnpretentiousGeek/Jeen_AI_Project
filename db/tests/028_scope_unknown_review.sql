\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
  v_applicant uuid;
  v_application uuid;
  v_case uuid;
  v_submission uuid;
  v_run analysis_runs%ROWTYPE;
  v_rule policy_rule_scopes%ROWTYPE;
  v_pinned boolean;
  v_case_no integer := 0;
  v_activity text;
  v_locations jsonb;
BEGIN
  UPDATE onboarding_provider_profile
  SET legal_name = 'Scope Test Provider',
      regulated_roles = ARRAY['payment_institution']::text[],
      service_jurisdictions = ARRAY['CA']::text[],
      updated_at = now()
  WHERE id = 1;

  SELECT rule.* INTO STRICT v_rule
  FROM policy_rule_scopes rule WHERE rule.code = 'CA-FED-02';

  FOREACH v_activity IN ARRAY ARRAY[
    'unknown', 'receives_or_transmits', 'receives_or_transmits', 'facilitates'
  ] LOOP
    v_case_no := v_case_no + 1;
    v_locations := CASE WHEN v_case_no IN (1, 3, 4) THEN '["CA"]'::jsonb ELSE '[]'::jsonb END;
    INSERT INTO applicants (legal_name, jurisdiction, business_type, product)
    VALUES ('Unknown Scope Applicant ' || v_case_no, 'CA', 'software', 'business_account')
    RETURNING id INTO v_applicant;
    INSERT INTO applications (applicant_id, submitted_payload)
    VALUES (v_applicant, jsonb_build_object(
      'activity_declaration', jsonb_build_object(
        'payment_activity', v_activity,
        'operating_jurisdictions', v_locations
      )
    )) RETURNING id INTO v_application;
    INSERT INTO onboarding_cases (application_id, applicant_id, reference)
    VALUES (v_application, v_applicant, 'KYB-UNKNOWN-SCOPE-' || v_case_no)
    RETURNING id INTO v_case;
    INSERT INTO evidence_submissions (case_id, submission_number, submitted_by)
    VALUES (v_case, 1, 'scope-test') RETURNING id INTO v_submission;
    INSERT INTO case_documents (
      evidence_submission_id, case_id, applicant_id, document_type,
      original_filename, mime_type, checksum_sha256, storage_path, ingestion_status
    ) VALUES (
      v_submission, v_case, v_applicant, 'supporting_document',
      'scope-test.txt', 'text/plain', repeat(v_case_no::text, 64),
      '/tmp/scope-test.txt', 'ready'
    );
    SELECT * INTO STRICT v_run FROM start_analysis_run(
      v_case, 'unknown-scope-' || v_case_no || '-' || gen_random_uuid()::text
    );

    IF v_case_no IN (1, 2) THEN
      IF policy_rule_scope_status_for_run(v_run.id, v_rule.id) <> 'needs_information' THEN
        RAISE EXCEPTION 'unknown activity or location should remain a review prompt';
      END IF;
      IF NOT policy_chunk_scope_eligible(v_run.id, v_rule.policy_chunk_id) THEN
        RAISE EXCEPTION 'unknown activity or location should keep the rule retrievable';
      END IF;
    ELSIF v_case_no = 3 THEN
      IF policy_rule_scope_status_for_run(v_run.id, v_rule.id) <> 'applies' THEN
        RAISE EXCEPTION 'matching activity and location should apply';
      END IF;
      IF NOT policy_chunk_scope_eligible(v_run.id, v_rule.policy_chunk_id) THEN
        RAISE EXCEPTION 'matching activity and location should keep the rule retrievable';
      END IF;
    ELSE
      IF policy_rule_scope_status_for_run(v_run.id, v_rule.id) <> 'does_not_apply' THEN
        RAISE EXCEPTION 'explicit non-matching activity should not apply';
      END IF;
      IF policy_chunk_scope_eligible(v_run.id, v_rule.policy_chunk_id) THEN
        RAISE EXCEPTION 'explicit non-matching activity should exclude the rule';
      END IF;
    END IF;

    SELECT EXISTS (
      SELECT 1 FROM analysis_run_policy_versions pinned
      WHERE pinned.analysis_run_id = v_run.id
        AND pinned.policy_version_id = (
          SELECT policy_version_id FROM policy_chunks WHERE id = v_rule.policy_chunk_id
        )
    ) INTO v_pinned;
    IF v_pinned IS DISTINCT FROM (v_case_no <> 4) THEN
      RAISE EXCEPTION 'unexpected policy pinning for test case %: %', v_case_no, v_pinned;
    END IF;
  END LOOP;
END $$;

ROLLBACK;
