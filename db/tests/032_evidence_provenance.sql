\set ON_ERROR_STOP on

BEGIN;

DO $$
<<fixture>>
DECLARE
  applicant_id uuid;
  application_id uuid;
  case_id uuid;
  analysis_run_id uuid;
  coordinator_id uuid;
  submission_id uuid;
  document_id uuid;
  registry_document_id uuid;
  registry_run_id uuid;
  registry_application_id uuid;
  registry_case_id uuid;
  registry_submission_id uuid;
  verification jsonb;
  blocked boolean;
BEGIN
  IF (SELECT array_agg(host ORDER BY host) FROM official_registry_hosts('US-DE'))
     <> ARRAY['gleif.org', 'icis.corp.delaware.gov', 'sec.gov'] THEN
    RAISE EXCEPTION 'a Delaware applicant should search Delaware, SEC, and GLEIF';
  END IF;

  INSERT INTO applicants (legal_name, jurisdiction, business_type, product)
  VALUES ('Provenance Test Ltd', 'GB', 'software', 'payments')
  RETURNING id INTO applicant_id;
  INSERT INTO applications (applicant_id, submitted_payload)
  VALUES (applicant_id, '{}'::jsonb) RETURNING id INTO application_id;
  INSERT INTO onboarding_cases (application_id, applicant_id, reference)
  VALUES (application_id, applicant_id, 'KYB-PROVENANCE-' || left(gen_random_uuid()::text, 8))
  RETURNING id INTO case_id;
  INSERT INTO evidence_submissions (case_id, submission_number, submitted_by)
  VALUES (case_id, 1, 'db-test') RETURNING id INTO submission_id;
  INSERT INTO case_documents (
    evidence_submission_id, case_id, applicant_id, document_type,
    original_filename, mime_type, checksum_sha256, storage_path, ingestion_status
  ) VALUES (
    submission_id, case_id, applicant_id, 'formation_certificate',
    'certificate.pdf', 'application/pdf', repeat('e', 64), '/tmp/certificate.pdf', 'ready'
  ) RETURNING id INTO document_id;
  INSERT INTO analysis_runs (
    case_id, session_id, status, output_schema_version, policy_effective_on, case_snapshot
  ) VALUES (
    case_id, 'provenance-' || gen_random_uuid()::text, 'queued', '3.4.0', CURRENT_DATE,
    '{"applicant":{"legal_name":"Provenance Test Ltd","jurisdiction":"GB"}}'::jsonb
  ) RETURNING id INTO analysis_run_id;
  INSERT INTO analysis_run_documents (analysis_run_id, case_id, document_id)
  VALUES (analysis_run_id, case_id, document_id);

  IF (SELECT provenance FROM case_documents WHERE id = document_id) <> 'applicant_supplied' THEN
    RAISE EXCEPTION 'an upload must default to applicant-supplied provenance';
  END IF;
  verification := coordinator_v3_identity_verification(analysis_run_id);
  IF verification->>'status' <> 'unverified'
     OR NOT verification->'registries' @> '[{"host":"company-information.service.gov.uk"},{"host":"gleif.org"}]' THEN
    RAISE EXCEPTION 'applicant copies alone must leave identity unverified: %', verification;
  END IF;

  -- A second case, since a case has one active run at a time.
  INSERT INTO applications (applicant_id, submitted_payload)
  VALUES (applicant_id, '{}'::jsonb) RETURNING id INTO registry_application_id;
  INSERT INTO onboarding_cases (application_id, applicant_id, reference)
  VALUES (registry_application_id, applicant_id, 'KYB-PROVENANCE-REG-' || left(gen_random_uuid()::text, 8))
  RETURNING id INTO registry_case_id;
  INSERT INTO evidence_submissions (case_id, submission_number, submitted_by)
  VALUES (registry_case_id, 1, 'db-test') RETURNING id INTO registry_submission_id;
  INSERT INTO case_documents (
    evidence_submission_id, case_id, applicant_id, document_type,
    original_filename, mime_type, checksum_sha256, storage_path, ingestion_status, provenance
  ) VALUES (
    registry_submission_id, registry_case_id, applicant_id, 'supporting_document',
    'registry-extract.pdf', 'application/pdf', repeat('f', 64), '/tmp/registry-extract.pdf', 'ready',
    'registry_retrieved'
  ) RETURNING id INTO registry_document_id;
  INSERT INTO analysis_runs (
    case_id, session_id, status, output_schema_version, policy_effective_on, case_snapshot
  ) VALUES (
    registry_case_id, 'provenance-registry-' || gen_random_uuid()::text, 'queued', '3.4.0', CURRENT_DATE,
    '{"applicant":{"legal_name":"Provenance Test Ltd","jurisdiction":"GB"}}'::jsonb
  ) RETURNING id INTO registry_run_id;
  INSERT INTO analysis_run_documents (analysis_run_id, case_id, document_id)
  VALUES (registry_run_id, registry_case_id, registry_document_id);
  verification := coordinator_v3_identity_verification(registry_run_id);
  IF verification->>'status' <> 'verified'
     OR verification->'verified_by'->0->>'document_id' <> registry_document_id::text THEN
    RAISE EXCEPTION 'a registry-retrieved document must verify identity: %', verification;
  END IF;

  blocked := false;
  BEGIN
    UPDATE case_documents SET provenance = 'registry_retrieved' WHERE id = document_id;
  EXCEPTION WHEN OTHERS THEN blocked := true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'a pinned document''s provenance must not change'; END IF;

  UPDATE onboarding_cases SET active_analysis_run_id = analysis_run_id WHERE id = case_id;
  coordinator_id := (start_or_resume_simple_coordinator_v3(
    analysis_run_id, case_id,
    (SELECT session_id FROM analysis_runs WHERE id = analysis_run_id),
    'provenance-flow', 'provenance-job', 'Assess the case.', 8
  )->>'coordinator_run_id')::uuid;
  blocked := false;
  BEGIN
    PERFORM store_coordinator_v3_verification_research_plan(
      coordinator_id,
      '{"requested_changes":{"source":"verification_requirement"},"response_summary":"Search.","research":[{}]}'::jsonb,
      'provenance-test'
    );
  EXCEPTION WHEN SQLSTATE '40001' OR SQLSTATE '42501' THEN blocked := true;
  END;
  IF NOT blocked THEN
    RAISE EXCEPTION 'verification research must wait for findings';
  END IF;

  -- Only an empty search's recovery checkpoint may offer to continue without evidence.
  blocked := false;
  BEGIN
    PERFORM create_simple_coordinator_v3_checkpoint(coordinator_id, jsonb_build_object(
      'schema_version', '1.0', 'checkpoint_id', gen_random_uuid(), 'request_id', 'continue-without-search-id',
      'checkpoint_version', 1, 'parent_checkpoint_id', NULL, 'parent_request_id', NULL,
      'originating_task_id', NULL, 'originating_context_id', NULL, 'checkpoint_kind', 'conflict_review',
      'title', 'Review conflict', 'explanation', 'Documents disagree.',
      'allowed_actions', '["continue_without_evidence","escalate","reject","skip_for_now"]'::jsonb,
      'payload', jsonb_build_object('reason', 'Documents disagree.')
    ), 'continue-without-search-id');
  EXCEPTION WHEN SQLSTATE '22023' THEN blocked := true;
  END;
  IF NOT blocked THEN
    RAISE EXCEPTION 'continue_without_evidence must require an empty search execution';
  END IF;
  PERFORM create_simple_coordinator_v3_checkpoint(coordinator_id, jsonb_build_object(
    'schema_version', '1.0', 'checkpoint_id', gen_random_uuid(), 'request_id', 'empty-search-recovery',
    'checkpoint_version', 1, 'parent_checkpoint_id', NULL, 'parent_request_id', NULL,
    'originating_task_id', NULL, 'originating_context_id', NULL, 'checkpoint_kind', 'conflict_review',
    'title', 'Review uncertain web search execution', 'explanation', 'The search found nothing.',
    'allowed_actions', '["continue_without_evidence","escalate","reject","skip_for_now"]'::jsonb,
    'payload', jsonb_build_object('search_execution_id', gen_random_uuid(), 'reason', 'No candidates.')
  ), 'empty-search-recovery');
  IF NOT EXISTS (
    SELECT 1 FROM coordinator_v3_checkpoints checkpoint
    WHERE checkpoint.analysis_run_id = fixture.analysis_run_id AND checkpoint.request_id = 'empty-search-recovery'
  ) THEN
    RAISE EXCEPTION 'an empty search recovery checkpoint must accept continue_without_evidence';
  END IF;
END $$;

ROLLBACK;
