\set ON_ERROR_STOP on
BEGIN;

DO $$
<<test>>
DECLARE
  applicant_id uuid;
  application_id uuid;
  case_id uuid;
  analysis_run_id uuid;
  coordinator_id uuid;
  coordinator_job text;
  payload jsonb;
  blocked boolean := false;
BEGIN
  INSERT INTO applicants (legal_name, jurisdiction, business_type, product)
  VALUES ('Synthetic Retry Test Ltd', 'US-CA', 'software', 'domestic_payments')
  RETURNING id INTO applicant_id;
  INSERT INTO applications (applicant_id) VALUES (applicant_id)
  RETURNING id INTO application_id;
  INSERT INTO onboarding_cases (application_id, applicant_id, reference, status)
  VALUES (application_id, applicant_id, 'SYNTHETIC-RETRY-' || gen_random_uuid()::text, 'processing')
  RETURNING id INTO case_id;
  INSERT INTO analysis_runs (
    case_id, session_id, status, policy_effective_on, case_snapshot, started_at
  ) VALUES (
    case_id, 'synthetic-retry-' || gen_random_uuid()::text, 'running', CURRENT_DATE,
    jsonb_build_object('applicant', jsonb_build_object(
      'jurisdiction', 'US-CA', 'product', 'domestic_payments', 'business_type', 'software'
    )), now()
  ) RETURNING id INTO analysis_run_id;
  UPDATE onboarding_cases SET active_analysis_run_id = analysis_run_id WHERE id = case_id;
  SELECT (start_or_resume_simple_coordinator_v3(
    analysis_run_id, case_id,
    (SELECT session_id FROM analysis_runs WHERE id = analysis_run_id),
    'synthetic-flow', 'synthetic-job', 'Test authorized retry.', 8
  )->>'coordinator_run_id')::uuid INTO coordinator_id;
  SELECT langflow_job_id INTO coordinator_job FROM coordinator_v3_runs WHERE id = coordinator_id;
  UPDATE coordinator_v3_runs
  SET state = state || jsonb_build_object('next_action', jsonb_build_object(
    'route', 'retry_specialist', 'specialty', 'policy', 'attempt', 2,
    'parent_task_id', 'synthetic-parent-task', 'response_values', '{}'::jsonb
  ))
  WHERE id = coordinator_id;

  INSERT INTO coordinator_v3_task_events (
    analysis_run_id, langflow_job_id, specialty, task_id, context_id,
    attempt, event_type, details
  ) VALUES (
    analysis_run_id, coordinator_job, 'policy', 'synthetic-retry-task',
    'synthetic-retry-context', 2, 'dispatched',
    jsonb_build_object(
      'analysis_run_id', analysis_run_id, 'coordinator_run_id', coordinator_id,
      'case_id', case_id, 'specialty', 'policy',
      'task_id', 'synthetic-retry-task', 'context_id', 'synthetic-retry-context',
      'attempt', 2, 'parent_task_id', 'synthetic-parent-task',
      'operation_key', 'synthetic-retry-operation'
    )
  );
  payload := jsonb_build_object(
    'analysis_run_id', analysis_run_id, 'coordinator_run_id', coordinator_id,
    'case_id', case_id, 'specialty', 'policy',
    'task_id', 'synthetic-retry-task', 'context_id', 'synthetic-retry-context',
    'status', 'partial', 'citations', '[]'::jsonb,
    'evidence_scope', jsonb_build_object(
      'permitted_document_ids', '[]'::jsonb,
      'permitted_policy_version_ids', '[]'::jsonb,
      'permitted_web_result_ids', '[]'::jsonb
    )
  );
  BEGIN
    PERFORM save_simple_coordinator_v3_contribution(
      coordinator_id, payload, 2, 'wrong-parent-task'
    );
  EXCEPTION WHEN serialization_failure THEN
    blocked := position('not the persisted dispatch' IN SQLERRM) > 0;
  END;
  IF NOT blocked THEN
    RAISE EXCEPTION 'retry contribution with wrong parent task was accepted';
  END IF;
  PERFORM save_simple_coordinator_v3_contribution(
    coordinator_id, payload, 2, 'synthetic-parent-task'
  );
  IF NOT EXISTS (
    SELECT 1 FROM coordinator_v3_contributions contribution
    WHERE contribution.analysis_run_id = test.analysis_run_id
      AND task_id = 'synthetic-retry-task' AND attempt = 2
  ) THEN
    RAISE EXCEPTION 'checkpoint-authorized retry contribution was not stored';
  END IF;
END $$;

ROLLBACK;
