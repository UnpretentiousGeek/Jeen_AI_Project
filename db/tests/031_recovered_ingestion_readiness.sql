\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
  applicant_id uuid;
  application_id uuid;
  case_id uuid;
  submission_id uuid;
  document_id uuid;
  checksum text := repeat('c', 64);
BEGIN
  INSERT INTO applicants (legal_name, jurisdiction, business_type, product)
  VALUES ('Recovered Ingestion Test Ltd', 'GB', 'software', 'payments')
  RETURNING id INTO applicant_id;
  INSERT INTO applications (applicant_id, submitted_payload)
  VALUES (applicant_id, '{}'::jsonb) RETURNING id INTO application_id;
  INSERT INTO onboarding_cases (application_id, applicant_id, reference)
  VALUES (application_id, applicant_id, 'KYB-RECOVERED-' || left(gen_random_uuid()::text, 8))
  RETURNING id INTO case_id;
  INSERT INTO evidence_submissions (case_id, submission_number, submitted_by)
  VALUES (case_id, 1, 'db-test') RETURNING id INTO submission_id;
  INSERT INTO case_documents (
    evidence_submission_id, case_id, applicant_id, document_type,
    original_filename, mime_type, checksum_sha256, storage_path, ingestion_status
  ) VALUES (
    submission_id, case_id, applicant_id, 'supporting_document',
    'recovered.txt', 'text/plain', checksum, '/tmp/recovered.txt', 'ready'
  ) RETURNING id INTO document_id;
  INSERT INTO api_langflow_invocations (
    case_id, purpose, flow_id, job_id, session_id, status,
    idempotency_key, evidence_checksum_sha256
  ) VALUES (
    case_id, 'evidence_ingestion', 'test-flow', 'recovered-job-' || case_id::text,
    'recovered-session-' || case_id::text, 'failed',
    'recovered-attempt-' || case_id::text, checksum
  );
  IF case_evidence_readiness(case_id) <> 'failed' THEN
    RAISE EXCEPTION 'failed job with unextracted document must remain failed';
  END IF;
  UPDATE case_documents
  SET source_metadata = jsonb_set(source_metadata, '{fact_extraction}',
    '{"status":"completed","schema_version":2}'::jsonb, true)
  WHERE id = document_id;
  IF case_evidence_readiness(case_id) <> 'ready' THEN
    RAISE EXCEPTION 'verified same-checksum extraction should recover readiness';
  END IF;
END $$;

ROLLBACK;
