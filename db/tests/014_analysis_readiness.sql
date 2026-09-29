\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
  applicant_id uuid;
  application_id uuid;
  v_case_id uuid;
  submission_id uuid;
  policy_document_id uuid;
  policy_version_id uuid;
  first_checksum text := repeat('a', 64);
  second_checksum text := repeat('b', 64);
  started analysis_runs%ROWTYPE;
BEGIN
  INSERT INTO applicants (legal_name, jurisdiction, business_type, product)
  VALUES ('Readiness Test Ltd', 'US', 'corporation', 'payments')
  RETURNING id INTO applicant_id;
  INSERT INTO applications (applicant_id, submitted_payload)
  VALUES (applicant_id, '{}'::jsonb)
  RETURNING id INTO application_id;
  INSERT INTO onboarding_cases (application_id, applicant_id, reference)
  VALUES (application_id, applicant_id, 'KYB-READINESS-' || left(gen_random_uuid()::text, 8))
  RETURNING id INTO v_case_id;

  IF case_evidence_readiness(v_case_id) <> 'empty' THEN
    RAISE EXCEPTION 'new case should have empty evidence status';
  END IF;
  BEGIN
    PERFORM start_analysis_run(v_case_id, 'readiness-empty-' || gen_random_uuid()::text);
    RAISE EXCEPTION 'empty evidence unexpectedly started an analysis';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%evidence is not ready (status: empty)%' THEN
      RAISE;
    END IF;
  END;

  INSERT INTO api_langflow_invocations (
    case_id, purpose, flow_id, job_id, session_id, status,
    idempotency_key, evidence_checksum_sha256
  ) VALUES (
    v_case_id, 'evidence_ingestion', 'test-flow', 'readiness-job-1-' || v_case_id::text,
    'readiness-session-1-' || v_case_id::text, 'queued',
    'readiness-attempt-1-' || v_case_id::text, first_checksum
  );
  INSERT INTO evidence_submissions (case_id, submission_number, submitted_by)
  VALUES (v_case_id, 1, 'db-test') RETURNING id INTO submission_id;
  INSERT INTO case_documents (
    evidence_submission_id, case_id, applicant_id, document_type,
    original_filename, mime_type, checksum_sha256, storage_path, ingestion_status
  ) VALUES (
    submission_id, v_case_id, applicant_id, 'supporting_document',
    'first.txt', 'text/plain', first_checksum, '/tmp/readiness-first.txt', 'ready'
  );
  IF case_evidence_readiness(v_case_id) <> 'processing' THEN
    RAISE EXCEPTION 'queued upload must block a partial evidence snapshot';
  END IF;
  BEGIN
    PERFORM start_analysis_run(v_case_id, 'readiness-processing-' || gen_random_uuid()::text);
    RAISE EXCEPTION 'processing evidence unexpectedly started an analysis';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%evidence is not ready (status: processing)%' THEN
      RAISE;
    END IF;
  END;
  UPDATE api_langflow_invocations SET status = 'completed'
  WHERE idempotency_key = 'readiness-attempt-1-' || v_case_id::text;
  IF case_evidence_readiness(v_case_id) <> 'ready' THEN
    RAISE EXCEPTION 'completed upload with ready document should permit analysis';
  END IF;

  INSERT INTO api_langflow_invocations (
    case_id, purpose, flow_id, job_id, session_id, status,
    idempotency_key, evidence_checksum_sha256
  ) VALUES (
    v_case_id, 'evidence_ingestion', 'test-flow', 'readiness-job-2-' || v_case_id::text,
    'readiness-session-2-' || v_case_id::text, 'failed',
    'readiness-attempt-2-' || v_case_id::text, second_checksum
  );
  INSERT INTO case_documents (
    evidence_submission_id, case_id, applicant_id, document_type,
    original_filename, mime_type, checksum_sha256, storage_path,
    ingestion_status, created_at
  ) VALUES (
    submission_id, v_case_id, applicant_id, 'supporting_document',
    'second-failed.txt', 'text/plain', second_checksum,
    '/tmp/readiness-second-failed.txt', 'failed',
    clock_timestamp() - interval '1 hour'
  );
  IF case_evidence_readiness(v_case_id) <> 'failed' THEN
    RAISE EXCEPTION 'failed upload must block a partial evidence snapshot';
  END IF;
  INSERT INTO api_langflow_invocations (
    case_id, purpose, flow_id, job_id, session_id, status,
    idempotency_key, evidence_checksum_sha256, created_at
  ) VALUES (
    v_case_id, 'evidence_ingestion', 'test-flow', 'readiness-job-3-' || v_case_id::text,
    'readiness-session-3-' || v_case_id::text, 'completed',
    'readiness-attempt-3-' || v_case_id::text, second_checksum,
    clock_timestamp() + interval '1 second'
  );
  IF case_evidence_readiness(v_case_id) <> 'failed' THEN
    RAISE EXCEPTION 'completed upload without a ready document must not appear ready';
  END IF;
  UPDATE case_documents
  SET ingestion_status = 'ready', original_filename = 'second.txt',
      storage_path = '/tmp/readiness-second.txt'
  WHERE case_id = v_case_id AND checksum_sha256 = second_checksum;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'retry did not find the failed document row';
  END IF;
  IF case_evidence_readiness(v_case_id) <> 'ready' THEN
    RAISE EXCEPTION 'successful retry should update the failed document to ready';
  END IF;

  INSERT INTO policy_documents (code, title)
  VALUES ('READINESS-' || left(v_case_id::text, 8), 'Readiness acceptance policy')
  RETURNING id INTO policy_document_id;
  INSERT INTO policy_versions (
    policy_document_id, version, approved_at, effective_from,
    source_path, checksum_sha256
  ) VALUES (
    policy_document_id, '1.0', CURRENT_DATE, CURRENT_DATE,
    '/tmp/readiness-policy.txt', repeat('c', 64)
  ) RETURNING id INTO policy_version_id;
  INSERT INTO policy_chunks (policy_version_id, chunk_index, content, section_locator)
  VALUES (policy_version_id, 0, 'Verify applicant evidence.', 'TEST-1');

  started := start_analysis_run(v_case_id, 'readiness-ready-' || gen_random_uuid()::text);
  IF started.status <> 'running' OR (
    SELECT count(*) FROM analysis_run_documents WHERE analysis_run_id = started.id
  ) <> 2 THEN
    RAISE EXCEPTION 'analysis did not pin both ready documents';
  END IF;
  UPDATE onboarding_cases SET status = 'completed' WHERE id = v_case_id;
  BEGIN
    PERFORM start_analysis_run(v_case_id, 'readiness-completed-' || gen_random_uuid()::text);
    RAISE EXCEPTION 'completed case unexpectedly started a new analysis';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%cannot start a new analysis from status completed%' THEN
      RAISE;
    END IF;
  END;
END;
$$;

ROLLBACK;
