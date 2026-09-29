\set ON_ERROR_STOP on

-- Exercise the archived-case purge path using only synthetic rows. The final
-- rollback keeps the database unchanged after the assertions pass.
BEGIN;

DO $$
<<purge_test>>
DECLARE
  applicant_id uuid := gen_random_uuid();
  target_application_id uuid := gen_random_uuid();
  neighbor_application_id uuid := gen_random_uuid();
  target_case_id uuid := gen_random_uuid();
  neighbor_case_id uuid := gen_random_uuid();
  submission_id uuid := gen_random_uuid();
  document_id uuid := gen_random_uuid();
  analysis_run_id uuid := gen_random_uuid();
  coordinator_run_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO applicants(id, legal_name, jurisdiction, business_type, product)
  VALUES (applicant_id, 'Purge Test Shared Applicant', 'GB', 'company', 'payments');

  INSERT INTO applications(id, applicant_id, submitted_payload)
  VALUES (target_application_id, applicant_id, '{}'::jsonb),
         (neighbor_application_id, applicant_id, '{}'::jsonb);

  INSERT INTO onboarding_cases(
    id, application_id, applicant_id, reference, status, archived_at, archived_by
  ) VALUES
    (target_case_id, target_application_id, applicant_id,
      'PURGE-' || replace(target_case_id::text, '-', ''), 'draft', clock_timestamp(), 'test-analyst'),
    (neighbor_case_id, neighbor_application_id, applicant_id,
      'NEIGHBOR-' || replace(neighbor_case_id::text, '-', ''), 'draft', NULL, NULL);

  INSERT INTO evidence_submissions(id, case_id, submission_number, submitted_by)
  VALUES (submission_id, target_case_id, 1, 'test-analyst');

  INSERT INTO case_documents(
    id, evidence_submission_id, case_id, applicant_id, document_type, original_filename,
    mime_type, checksum_sha256, storage_path, ingestion_status
  ) VALUES (
    document_id, submission_id, target_case_id, applicant_id, 'incorporation_record',
    'purge-test.pdf', 'application/pdf', repeat('a', 64), '/tmp/purge-test.pdf', 'ready'
  );

  INSERT INTO document_chunks(
    document_id, case_id, applicant_id, evidence_submission_id,
    chunk_index, content, section_locator
  ) VALUES (
    document_id, target_case_id, applicant_id, submission_id,
    0, 'synthetic evidence', 'page 1'
  );

  INSERT INTO analysis_runs(
    id, case_id, session_id, status, policy_effective_on, case_snapshot
  ) VALUES (
    analysis_run_id, target_case_id, 'purge-test-' || analysis_run_id::text,
    'queued', CURRENT_DATE, '{}'::jsonb
  );

  INSERT INTO analysis_run_documents(analysis_run_id, case_id, document_id)
  VALUES (analysis_run_id, target_case_id, document_id);

  UPDATE analysis_runs
  SET status = 'succeeded', started_at = clock_timestamp(), finished_at = clock_timestamp()
  WHERE id = analysis_run_id;

  UPDATE onboarding_cases
  SET active_analysis_run_id = analysis_run_id, status = 'completed'
  WHERE id = target_case_id;

  INSERT INTO case_final_decisions(
    case_id, analysis_run_id, decision, actor, rationale, idempotency_key
  ) VALUES (
    target_case_id, analysis_run_id, 'approved', 'test-analyst',
    'Synthetic purge fixture', 'purge-test-' || target_case_id::text
  );

  INSERT INTO audit_events(case_id, analysis_run_id, event_type, actor_type, actor_id, payload)
  VALUES (target_case_id, analysis_run_id, 'case.archived', 'analyst', 'test-analyst', '{"archived":true}'::jsonb);

  INSERT INTO case_assistant_conversations(case_id) VALUES (target_case_id);
  INSERT INTO case_assistant_turns(
    case_id, actor_id, idempotency_key, question, answer, status, completed_at, analysis_run_id
  ) VALUES (
    target_case_id, 'test-analyst', 'purge-test-turn-' || target_case_id::text,
    'Synthetic question?', 'Synthetic answer.', 'completed', clock_timestamp(), analysis_run_id
  );

  INSERT INTO coordinator_v3_runs(
    id, analysis_run_id, case_id, langflow_job_id, session_id, scenario,
    engine_version, phase, finalized_at
  ) VALUES (
    coordinator_run_id, analysis_run_id, target_case_id,
    'purge-test-job-' || coordinator_run_id::text,
    'purge-test-session-' || coordinator_run_id::text,
    'complete', 'durable-loop-v1', 'stopped', clock_timestamp()
  );

  INSERT INTO coordinator_v3_human_decisions(run_id, request_id, decision, decision_hash)
  VALUES (coordinator_run_id, 'purge-test-review', 'approve', repeat('b', 64));

  INSERT INTO coordinator_v3_events(
    event_id, run_id, analysis_run_id, case_id, event_type, correlation_id
  ) VALUES (
    gen_random_uuid(), coordinator_run_id, analysis_run_id, target_case_id,
    'case.completed', 'purge-test-correlation-' || coordinator_run_id::text
  );

  INSERT INTO coordinator_v3_final_snapshots(run_id, analysis_run_id, case_id)
  VALUES (coordinator_run_id, analysis_run_id, target_case_id);

  PERFORM set_config('jeen.case_purge_id', target_case_id::text, true);
  PERFORM set_config('jeen.case_purge_analysis_run_ids', jsonb_build_array(analysis_run_id)::text, true);
  PERFORM set_config('jeen.case_purge_coordinator_run_ids', jsonb_build_array(coordinator_run_id)::text, true);

  DELETE FROM case_final_decisions WHERE case_id = target_case_id;
  UPDATE onboarding_cases SET active_analysis_run_id = NULL WHERE id = target_case_id;
  DELETE FROM onboarding_cases WHERE id = target_case_id;

  DELETE FROM applications application
  WHERE application.id = target_application_id
    AND NOT EXISTS (
      SELECT 1 FROM onboarding_cases c WHERE c.application_id = application.id
    );
  DELETE FROM applicants applicant
  WHERE applicant.id = applicant_id
    AND NOT EXISTS (
      SELECT 1 FROM applications application WHERE application.applicant_id = applicant.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM onboarding_cases c WHERE c.applicant_id = applicant.id
    );

  IF EXISTS (SELECT 1 FROM onboarding_cases WHERE id = target_case_id)
    OR EXISTS (SELECT 1 FROM applications WHERE id = target_application_id)
    OR EXISTS (SELECT 1 FROM analysis_runs WHERE id = analysis_run_id)
    OR EXISTS (SELECT 1 FROM case_documents WHERE id = document_id)
    OR EXISTS (
      SELECT 1 FROM document_chunks chunks
      WHERE chunks.document_id = purge_test.document_id
    )
    OR EXISTS (
      SELECT 1 FROM analysis_run_documents snapshot
      WHERE snapshot.analysis_run_id = purge_test.analysis_run_id
    )
    OR EXISTS (SELECT 1 FROM case_final_decisions WHERE case_id = target_case_id)
    OR EXISTS (SELECT 1 FROM audit_events WHERE case_id = target_case_id)
    OR EXISTS (SELECT 1 FROM case_assistant_conversations WHERE case_id = target_case_id)
    OR EXISTS (SELECT 1 FROM coordinator_v3_runs WHERE id = coordinator_run_id)
    OR EXISTS (SELECT 1 FROM coordinator_v3_human_decisions WHERE run_id = coordinator_run_id)
    OR EXISTS (SELECT 1 FROM coordinator_v3_events WHERE case_id = target_case_id)
    OR EXISTS (SELECT 1 FROM coordinator_v3_final_snapshots WHERE case_id = target_case_id) THEN
    RAISE EXCEPTION 'archived-case purge left case history behind';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM onboarding_cases WHERE id = neighbor_case_id)
    OR NOT EXISTS (SELECT 1 FROM applicants WHERE id = applicant_id) THEN
    RAISE EXCEPTION 'archived-case purge removed shared or neighboring data';
  END IF;
END;
$$;

ROLLBACK;
