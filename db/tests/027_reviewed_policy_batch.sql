\set ON_ERROR_STOP on

BEGIN;

CREATE FUNCTION pg_temp.scope_test_run(
  p_case_id uuid,
  p_role text,
  p_provider_location text,
  p_activity text,
  p_operating_location text
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_run_id uuid;
BEGIN
  UPDATE onboarding_provider_profile
  SET regulated_roles = ARRAY[p_role],
      service_jurisdictions = ARRAY[p_provider_location],
      updated_at = now()
  WHERE id = 1;
  INSERT INTO analysis_runs (
    case_id, session_id, status, output_schema_version,
    policy_effective_on, case_snapshot, started_at
  ) VALUES (
    p_case_id, 'policy-batch-' || gen_random_uuid()::text,
    'succeeded', '1.1', CURRENT_DATE,
    jsonb_build_object(
      'applicant', jsonb_build_object(
        'jurisdiction', 'US-CA', 'business_type', 'marketplace',
        'product', 'merchant_payouts'
      ),
      'submitted_payload', jsonb_build_object(
        'activity_declaration', jsonb_build_object(
          'payment_activity', p_activity,
          'operating_jurisdictions',
            CASE WHEN p_operating_location IS NULL THEN '[]'::jsonb
              ELSE jsonb_build_array(p_operating_location) END
        )
      )
    ), now()
  ) RETURNING id INTO v_run_id;
  RETURN v_run_id;
END $$;

DO $$
DECLARE
  v_applicant uuid;
  v_application uuid;
  v_case uuid;
  v_rule record;
  v_role text;
  v_provider_location text;
  v_activity text;
  v_operating_location text;
  v_run uuid;
  v_count int := 0;
BEGIN
  IF (SELECT count(*) FROM policy_research_candidates
      WHERE review_state = 'promoted') <> 20 THEN
    RAISE EXCEPTION 'expected 20 promoted research candidates';
  END IF;
  IF EXISTS (
    SELECT 1 FROM policy_research_candidates candidate
    LEFT JOIN policy_rule_scopes rule
      ON rule.id = candidate.promoted_policy_rule_scope_id
    LEFT JOIN policy_chunks chunk ON chunk.id = rule.policy_chunk_id
    LEFT JOIN policy_versions version ON version.id = chunk.policy_version_id
    WHERE candidate.review_state = 'promoted' AND (
      rule.review_state IS DISTINCT FROM 'approved'
      OR vector_dims(chunk.embedding) IS DISTINCT FROM 1024
      OR version.checksum_sha256 IS DISTINCT FROM
        encode(digest(chunk.content, 'sha256'), 'hex')
      OR EXISTS (
        SELECT 1 FROM policy_new_run_exclusions exclusion
        WHERE exclusion.policy_version_id = version.id
      )
    )
  ) THEN
    RAISE EXCEPTION 'approved rule, source, or embedding is incomplete';
  END IF;

  INSERT INTO applicants (legal_name, jurisdiction, business_type, product)
  VALUES ('Batch Policy Scope Verification Ltd', 'US-CA', 'marketplace', 'merchant_payouts')
  RETURNING id INTO v_applicant;
  INSERT INTO applications (applicant_id, submitted_payload)
  VALUES (v_applicant, '{}'::jsonb)
  RETURNING id INTO v_application;
  INSERT INTO onboarding_cases (application_id, applicant_id, reference)
  VALUES (v_application, v_applicant,
    'KYB-POLICY-BATCH-' || left(gen_random_uuid()::text, 8))
  RETURNING id INTO v_case;

  FOR v_rule IN
    SELECT rule.*, candidate.jurisdiction
    FROM policy_rule_scopes rule
    JOIN policy_research_candidates candidate
      ON candidate.promoted_policy_rule_scope_id = rule.id
    ORDER BY rule.code
  LOOP
    v_count := v_count + 1;
    v_role := COALESCE(v_rule.provider_roles[1], 'payment_institution');
    v_provider_location := COALESCE(v_rule.provider_jurisdictions[1], 'GB');
    v_activity := COALESCE(v_rule.applicant_payment_activities[1], 'none');
    v_operating_location := v_rule.operating_jurisdictions[1];

    v_run := pg_temp.scope_test_run(v_case, v_role,
      v_provider_location, v_activity, v_operating_location);
    IF NOT policy_rule_applies_to_run(v_run, v_rule.id)
      OR NOT policy_chunk_scope_eligible(v_run, v_rule.policy_chunk_id) THEN
      RAISE EXCEPTION '% did not match its positive scope', v_rule.code;
    END IF;

    IF cardinality(v_rule.provider_roles) > 0 THEN
      v_run := pg_temp.scope_test_run(v_case, 'marketplace',
        v_provider_location, v_activity, v_operating_location);
      IF policy_rule_applies_to_run(v_run, v_rule.id) THEN
        RAISE EXCEPTION '% matched the wrong provider role', v_rule.code;
      END IF;
    END IF;
    IF cardinality(v_rule.provider_jurisdictions) > 0 THEN
      v_run := pg_temp.scope_test_run(v_case, v_role,
        CASE WHEN v_provider_location = 'GB' THEN 'CA' ELSE 'GB' END,
        v_activity, v_operating_location);
      IF policy_rule_applies_to_run(v_run, v_rule.id) THEN
        RAISE EXCEPTION '% matched the wrong provider location', v_rule.code;
      END IF;
    END IF;
    IF cardinality(v_rule.applicant_payment_activities) > 0 THEN
      v_run := pg_temp.scope_test_run(v_case, v_role,
        v_provider_location, 'none', v_operating_location);
      IF policy_rule_applies_to_run(v_run, v_rule.id) THEN
        RAISE EXCEPTION '% matched the wrong payment activity', v_rule.code;
      END IF;
    END IF;
    IF cardinality(v_rule.operating_jurisdictions) > 0 THEN
      v_run := pg_temp.scope_test_run(v_case, v_role,
        v_provider_location, v_activity, NULL);
      IF policy_rule_applies_to_run(v_run, v_rule.id) THEN
        RAISE EXCEPTION '% matched without its operating location', v_rule.code;
      END IF;
    END IF;
  END LOOP;
  IF v_count <> 20 THEN
    RAISE EXCEPTION 'expected 20 scope tests, got %', v_count;
  END IF;
END $$;

DO $$
DECLARE
  v_applicant uuid;
  v_application uuid;
  v_case uuid;
  v_submission uuid;
  v_run analysis_runs%ROWTYPE;
  v_codes text[];
BEGIN
  UPDATE onboarding_provider_profile
  SET regulated_roles = ARRAY['payment_institution']::text[],
      service_jurisdictions = ARRAY['GB']::text[], updated_at = now()
  WHERE id = 1;
  INSERT INTO applicants (legal_name, jurisdiction, business_type, product)
  VALUES ('Cross-Border Policy Verification Ltd', 'GB', 'marketplace', 'merchant_payouts')
  RETURNING id INTO v_applicant;
  INSERT INTO applications (applicant_id, submitted_payload)
  VALUES (v_applicant, jsonb_build_object(
    'activity_declaration', jsonb_build_object(
      'payment_activity', 'facilitates',
      'operating_jurisdictions', jsonb_build_array('IE', 'DE')
    )
  )) RETURNING id INTO v_application;
  INSERT INTO onboarding_cases (application_id, applicant_id, reference)
  VALUES (v_application, v_applicant,
    'KYB-POLICY-PIN-' || left(gen_random_uuid()::text, 8))
  RETURNING id INTO v_case;
  INSERT INTO evidence_submissions (case_id, submission_number, submitted_by)
  VALUES (v_case, 1, 'db-test') RETURNING id INTO v_submission;
  INSERT INTO case_documents (
    evidence_submission_id, case_id, applicant_id, document_type,
    original_filename, mime_type, checksum_sha256, storage_path,
    ingestion_status
  ) VALUES (
    v_submission, v_case, v_applicant, 'supporting_document',
    'policy-batch-test.txt', 'text/plain', repeat('c', 64),
    '/tmp/policy-batch-test.txt', 'ready'
  );
  v_run := start_analysis_run(v_case, 'policy-batch-pin-' || gen_random_uuid()::text);
  SELECT array_agg(document.code ORDER BY document.code) INTO v_codes
  FROM analysis_run_policy_versions pinned
  JOIN policy_versions version ON version.id = pinned.policy_version_id
  JOIN policy_documents document ON document.id = version.policy_document_id
  WHERE pinned.analysis_run_id = v_run.id;
  IF v_codes IS DISTINCT FROM ARRAY['DE-BUND-01', 'GB-01', 'IE-01']::text[] THEN
    RAISE EXCEPTION 'unexpected cross-border policy pinning: %', v_codes;
  END IF;
END $$;

ROLLBACK;
