\set ON_ERROR_STOP on

BEGIN;

DO $$
<<test_case>>
DECLARE
  scenario record;
  applicant_id uuid;
  application_id uuid;
  case_id uuid;
  analysis_run_id uuid;
  session_id text;
  coordinator_id uuid;
  request_id text;
  checkpoint_request jsonb;
  checkpoint_payload jsonb;
  allowed_actions jsonb;
  expected_version bigint;
  applied jsonb;
  replay jsonb;
  stop_result jsonb;
  expected_case_status text;
  previous_version bigint;
BEGIN
  FOR scenario IN
    SELECT * FROM (VALUES
      ('information_request', 'reject'),
      ('specialist_recovery', 'abort'),
      ('conflict_review', 'escalate'),
      ('web_result_review', 'reject'),
      ('analyst_approval', 'reject')
    ) AS scenarios(kind, action)
  LOOP
    INSERT INTO applicants (legal_name, jurisdiction, business_type, product)
    VALUES ('Terminal Checkpoint Test Ltd', 'GB', 'software', 'payments')
    RETURNING id INTO applicant_id;
    INSERT INTO applications (applicant_id, submitted_payload)
    VALUES (applicant_id, '{}'::jsonb) RETURNING id INTO application_id;
    INSERT INTO onboarding_cases (application_id, applicant_id, reference)
    VALUES (application_id, applicant_id, 'KYB-TERMINAL-' || left(gen_random_uuid()::text, 8))
    RETURNING id INTO case_id;
    session_id := 'terminal-test-' || gen_random_uuid()::text;
    INSERT INTO analysis_runs (
      case_id, session_id, status, output_schema_version, policy_effective_on, case_snapshot
    ) VALUES (
      case_id, session_id, 'queued', '3.4.0', CURRENT_DATE, '{}'::jsonb
    ) RETURNING id INTO analysis_run_id;
    UPDATE onboarding_cases SET active_analysis_run_id = analysis_run_id WHERE id = case_id;

    coordinator_id := (start_or_resume_simple_coordinator_v3(
      analysis_run_id, case_id, session_id, 'terminal-test-flow',
      'terminal-test-job', 'Assess the case.', 8
    )->>'coordinator_run_id')::uuid;
    request_id := 'terminal-' || scenario.kind || '-' || scenario.action;
    checkpoint_payload := CASE scenario.kind
      WHEN 'information_request' THEN jsonb_build_object('question', 'Can you clarify ownership?')
      WHEN 'specialist_recovery' THEN jsonb_build_object('specialty', 'entity', 'task_id', 'entity-task', 'attempt', 1)
      WHEN 'conflict_review' THEN jsonb_build_object('reason', 'Conflicting ownership claims')
      WHEN 'web_result_review' THEN jsonb_build_object('pending_web_result_ids', jsonb_build_array(gen_random_uuid()))
      ELSE jsonb_build_object('proposal', jsonb_build_object('action', 'mark_ready'),
                              'proposal_hash', repeat('a', 64), 'operation_key', 'terminal-proposal')
    END;
    allowed_actions := CASE scenario.kind
      WHEN 'information_request' THEN '["submit_clarification","reject","skip_for_now"]'::jsonb
      WHEN 'specialist_recovery' THEN '["retry","abort","skip_for_now"]'::jsonb
      WHEN 'conflict_review' THEN '["escalate","reject","skip_for_now"]'::jsonb
      WHEN 'web_result_review' THEN '["accept","reject","skip_for_now"]'::jsonb
      ELSE '["approve","changes_requested","reject","skip_for_now"]'::jsonb
    END;
    checkpoint_request := jsonb_build_object(
      'schema_version', '1.0',
      'checkpoint_id', gen_random_uuid(),
      'request_id', request_id,
      'checkpoint_version', 1,
      'parent_checkpoint_id', NULL,
      'parent_request_id', NULL,
      'originating_task_id', NULL,
      'originating_context_id', NULL,
      'checkpoint_kind', scenario.kind,
      'title', 'Resolve checkpoint',
      'explanation', 'Decide how the review proceeds.',
      'allowed_actions', allowed_actions,
      'payload', checkpoint_payload
    );
    PERFORM create_simple_coordinator_v3_checkpoint(
      coordinator_id, checkpoint_request, request_id || ':checkpoint'
    );
    UPDATE onboarding_cases SET status = 'awaiting_approval' WHERE id = case_id;
    SELECT checkpoint.expected_state_version INTO expected_version
    FROM coordinator_v3_checkpoints checkpoint
    WHERE checkpoint.analysis_run_id = test_case.analysis_run_id
      AND checkpoint.request_id = test_case.request_id;
    expected_case_status := CASE WHEN scenario.action = 'escalate'
      THEN 'enhanced_review' ELSE 'attention_required' END;

    IF scenario.kind = 'information_request' THEN
      UPDATE onboarding_cases SET active_analysis_run_id = NULL WHERE id = case_id;
      BEGIN
        PERFORM apply_simple_coordinator_v3_checkpoint_decision(
          analysis_run_id, request_id, expected_version, scenario.action,
          '{}'::jsonb, 'test-analyst', request_id || ':decision'
        );
        RAISE EXCEPTION 'terminal decision without an active case was accepted';
      EXCEPTION WHEN SQLSTATE '40001' THEN NULL;
      END;
      IF (SELECT phase FROM coordinator_v3_runs WHERE id = coordinator_id) <> 'waiting_for_human'
         OR (SELECT status FROM analysis_runs WHERE id = analysis_run_id) <> 'suspended'
         OR EXISTS (SELECT 1 FROM coordinator_v3_human_decisions decision
                    WHERE decision.run_id = coordinator_id AND decision.request_id = test_case.request_id) THEN
        RAISE EXCEPTION 'failed terminal decision left partial changes';
      END IF;
      UPDATE onboarding_cases SET active_analysis_run_id = analysis_run_id WHERE id = case_id;
    END IF;

    applied := apply_simple_coordinator_v3_checkpoint_decision(
      analysis_run_id, request_id, expected_version, scenario.action,
      '{}'::jsonb, 'test-analyst', request_id || ':decision'
    );
    IF applied->>'status' <> 'applied'
       OR (SELECT phase FROM coordinator_v3_runs WHERE id = coordinator_id) <> 'stopped'
       OR (SELECT status FROM analysis_runs WHERE id = analysis_run_id) <> 'failed'
       OR (SELECT status FROM onboarding_cases WHERE id = case_id) <> expected_case_status
       OR (SELECT checkpoint.decision FROM coordinator_v3_checkpoints checkpoint
           WHERE checkpoint.analysis_run_id = test_case.analysis_run_id
             AND checkpoint.request_id = test_case.request_id) <> scenario.action THEN
      RAISE EXCEPTION 'terminal checkpoint %/% left inconsistent case or run state', scenario.kind, scenario.action;
    END IF;

    SELECT state_version INTO previous_version FROM coordinator_v3_runs WHERE id = coordinator_id;
    replay := apply_simple_coordinator_v3_checkpoint_decision(
      analysis_run_id, request_id, expected_version, scenario.action,
      '{}'::jsonb, 'test-analyst', request_id || ':decision'
    );
    IF replay->>'status' <> 'duplicate_suppressed'
       OR (SELECT state_version FROM coordinator_v3_runs WHERE id = coordinator_id) <> previous_version THEN
      RAISE EXCEPTION 'terminal checkpoint replay changed persisted state';
    END IF;

    stop_result := stop_simple_coordinator_v3(
      coordinator_id, 'Human checkpoint ' || request_id || ' ended', request_id || ':terminal'
    );
    IF stop_result->>'status' <> 'stopped'
       OR (SELECT status FROM onboarding_cases WHERE id = case_id) <> expected_case_status THEN
      RAISE EXCEPTION 'terminal route downgraded case status';
    END IF;
    SELECT state_version INTO previous_version FROM coordinator_v3_runs WHERE id = coordinator_id;
    stop_result := stop_simple_coordinator_v3(
      coordinator_id, 'Human checkpoint ' || request_id || ' ended', request_id || ':terminal'
    );
    IF stop_result->>'status' <> 'duplicate_suppressed'
       OR (SELECT state_version FROM coordinator_v3_runs WHERE id = coordinator_id) <> previous_version THEN
      RAISE EXCEPTION 'terminal stop replay changed persisted state';
    END IF;
  END LOOP;

  INSERT INTO applicants (legal_name, jurisdiction, business_type, product)
  VALUES ('Coordinator Failure Test Ltd', 'GB', 'software', 'payments')
  RETURNING id INTO applicant_id;
  INSERT INTO applications (applicant_id, submitted_payload)
  VALUES (applicant_id, '{}'::jsonb) RETURNING id INTO application_id;
  INSERT INTO onboarding_cases (application_id, applicant_id, reference)
  VALUES (application_id, applicant_id, 'KYB-STOP-' || left(gen_random_uuid()::text, 8))
  RETURNING id INTO case_id;
  session_id := 'stop-test-' || gen_random_uuid()::text;
  INSERT INTO analysis_runs (
    case_id, session_id, status, output_schema_version, policy_effective_on, case_snapshot
  ) VALUES (
    case_id, session_id, 'queued', '3.4.0', CURRENT_DATE, '{}'::jsonb
  ) RETURNING id INTO analysis_run_id;
  UPDATE onboarding_cases SET active_analysis_run_id = analysis_run_id WHERE id = case_id;
  coordinator_id := (start_or_resume_simple_coordinator_v3(
    analysis_run_id, case_id, session_id, 'stop-test-flow',
    'stop-test-job', 'Assess the case.', 8
  )->>'coordinator_run_id')::uuid;

  -- A stale case link must roll back the run update rather than leave split state.
  UPDATE onboarding_cases SET active_analysis_run_id = NULL WHERE id = case_id;
  BEGIN
    PERFORM stop_simple_coordinator_v3(coordinator_id, 'Iteration budget exhausted', 'stop-test:budget');
    RAISE EXCEPTION 'stopping a run without an active case was accepted';
  EXCEPTION WHEN SQLSTATE '40001' THEN NULL;
  END;
  IF (SELECT phase FROM coordinator_v3_runs WHERE id = coordinator_id) <> 'running'
     OR (SELECT status FROM analysis_runs WHERE id = analysis_run_id) <> 'running' THEN
    RAISE EXCEPTION 'failed stop left the coordinator or analysis changed';
  END IF;
  UPDATE onboarding_cases SET active_analysis_run_id = analysis_run_id WHERE id = case_id;
  stop_result := stop_simple_coordinator_v3(
    coordinator_id, 'Iteration budget exhausted', 'stop-test:budget'
  );
  IF stop_result->>'status' <> 'stopped'
     OR (SELECT status FROM onboarding_cases WHERE id = case_id) <> 'attention_required'
     OR (SELECT status FROM analysis_runs WHERE id = analysis_run_id) <> 'failed' THEN
    RAISE EXCEPTION 'coordinator failure did not move the case to attention required';
  END IF;
END;
$$;

ROLLBACK;

SELECT 'terminal checkpoint decisions update case and run together' AS result;
