\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
  applicant uuid;
  application uuid;
  selected_case uuid;
  submission uuid;
  document uuid;
  analysis uuid;
  blocked boolean;
BEGIN
  INSERT INTO applicants (legal_name, jurisdiction, business_type, product)
  VALUES ('Backfill Fixture Ltd', 'GB', 'software', 'domestic_payments') RETURNING id INTO applicant;
  INSERT INTO applications (applicant_id) VALUES (applicant) RETURNING id INTO application;
  INSERT INTO onboarding_cases (application_id, applicant_id, reference)
  VALUES (application, applicant, 'BACKFILL-' || gen_random_uuid()) RETURNING id INTO selected_case;
  INSERT INTO evidence_submissions (case_id, submission_number, submitted_by)
  VALUES (selected_case, 1, 'db-test') RETURNING id INTO submission;
  INSERT INTO case_documents (evidence_submission_id, case_id, applicant_id, document_type,
    original_filename, mime_type, checksum_sha256, storage_path, ingestion_status, parsed_text)
  VALUES (submission, selected_case, applicant, 'supporting_document', 'fixture.txt',
    'text/plain', repeat('f', 64), '/tmp/fixture.txt', 'ready', 'Original evidence')
  RETURNING id INTO document;
  INSERT INTO analysis_runs (case_id, session_id, policy_effective_on, case_snapshot)
  VALUES (selected_case, 'backfill-' || gen_random_uuid(), CURRENT_DATE, '{}'::jsonb)
  RETURNING id INTO analysis;
  INSERT INTO analysis_run_documents (analysis_run_id, case_id, document_id)
  VALUES (analysis, selected_case, document);

  UPDATE case_documents SET source_metadata = jsonb_set(source_metadata,
    '{fact_extraction}', '{"status":"completed","schema_version":2}'::jsonb, true)
  WHERE id = document;
  IF (SELECT source_metadata #>> '{fact_extraction,status}' FROM case_documents WHERE id=document)
     <> 'completed' THEN RAISE EXCEPTION 'fact extraction status did not persist'; END IF;

  blocked := false;
  BEGIN
    UPDATE case_documents SET parsed_text='Changed evidence' WHERE id=document;
  EXCEPTION WHEN OTHERS THEN blocked := true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'pinned document content changed'; END IF;

  blocked := false;
  BEGIN
    UPDATE case_documents SET source_metadata = source_metadata || '{"other":"changed"}'::jsonb
    WHERE id=document;
  EXCEPTION WHEN OTHERS THEN blocked := true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'non-extraction metadata changed'; END IF;
END;
$$;

ROLLBACK;
