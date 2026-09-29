\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
  applicant_uuid uuid;
  application_uuid uuid;
  case_uuid uuid;
  run_uuid uuid;
  submission_uuid uuid;
  document_uuid uuid;
  audit_uuid uuid;
BEGIN
  INSERT INTO applicants (legal_name, jurisdiction, business_type, product)
  VALUES ('Timeline test', 'GB', 'company', 'account') RETURNING id INTO applicant_uuid;
  INSERT INTO applications (applicant_id) VALUES (applicant_uuid) RETURNING id INTO application_uuid;
  INSERT INTO onboarding_cases (application_id, applicant_id, reference)
  VALUES (application_uuid, applicant_uuid, 'KYB-TIMELINE-ROLLBACK') RETURNING id INTO case_uuid;
  INSERT INTO analysis_runs (case_id, session_id, policy_effective_on, case_snapshot)
  VALUES (case_uuid, 'timeline-rollback-test', CURRENT_DATE, '{}'::jsonb)
  RETURNING id INTO run_uuid;

  UPDATE analysis_runs SET status = 'running' WHERE id = run_uuid;
  UPDATE onboarding_cases SET status = 'processing' WHERE id = case_uuid;
  IF (SELECT count(*) FROM audit_events WHERE case_id = case_uuid
      AND event_type IN ('analysis.running', 'case.status_changed')) <> 2 THEN
    RAISE EXCEPTION 'expected analysis and case status events';
  END IF;

  INSERT INTO evidence_submissions (case_id, submission_number, submitted_by)
  VALUES (case_uuid, 1, 'timeline-test') RETURNING id INTO submission_uuid;
  INSERT INTO case_documents (
    evidence_submission_id, case_id, applicant_id, document_type,
    original_filename, mime_type, checksum_sha256, storage_path
  ) VALUES (
    submission_uuid, case_uuid, applicant_uuid, 'supporting_document',
    'test.txt', 'text/plain', repeat('a', 64), '/tmp/timeline-test.txt'
  ) RETURNING id INTO document_uuid;
  UPDATE case_documents SET ingestion_status = 'ready' WHERE id = document_uuid;
  IF (SELECT count(*) FROM audit_events WHERE case_id = case_uuid
      AND event_type = 'document.ingestion_ready'
      AND payload->>'document_id' = document_uuid::text) <> 1 THEN
    RAISE EXCEPTION 'expected document ingestion event';
  END IF;

  INSERT INTO audit_events (case_id, event_type, actor_type)
  VALUES (case_uuid, 'timeline.test', 'system') RETURNING id INTO audit_uuid;
  BEGIN
    UPDATE audit_events SET event_type = 'changed' WHERE id = audit_uuid;
    RAISE EXCEPTION 'audit event was mutable';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'audit event was mutable' THEN RAISE; END IF;
  END;
END;
$$;

ROLLBACK;
