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
  checkpoint_id uuid;
  expected_version bigint;
  request_id text := 'structured-information-test';
  request_payload jsonb;
  answers jsonb := '{"answers":{"entity:registry":"Official registry record supplied","ownership:register":"Independent shareholder register supplied"}}'::jsonb;
BEGIN
  INSERT INTO applicants (legal_name, jurisdiction, business_type, product)
  VALUES ('Structured Information Test Ltd', 'GB', 'software', 'payments')
  RETURNING id INTO applicant_id;
  INSERT INTO applications (applicant_id, submitted_payload)
  VALUES (applicant_id, '{}'::jsonb) RETURNING id INTO application_id;
  INSERT INTO onboarding_cases (application_id, applicant_id, reference)
  VALUES (application_id, applicant_id, 'KYB-STRUCTURED-' || left(gen_random_uuid()::text, 8))
  RETURNING id INTO case_id;
  INSERT INTO analysis_runs (
    case_id, session_id, status, output_schema_version, policy_effective_on, case_snapshot
  ) VALUES (
    case_id, 'structured-info-' || gen_random_uuid()::text, 'queued', '3.4.0', CURRENT_DATE, '{}'::jsonb
  ) RETURNING id INTO analysis_run_id;
  UPDATE onboarding_cases SET active_analysis_run_id = analysis_run_id WHERE id = case_id;

  coordinator_id := (start_or_resume_simple_coordinator_v3(
    analysis_run_id, case_id,
    (SELECT session_id FROM analysis_runs WHERE id = analysis_run_id),
    'structured-info-flow', 'structured-info-job', 'Assess the case.', 8
  )->>'coordinator_run_id')::uuid;
  request_payload := jsonb_build_object(
    'schema_version', '1.0', 'checkpoint_id', gen_random_uuid(),
    'request_id', request_id, 'checkpoint_version', 1,
    'parent_checkpoint_id', NULL, 'parent_request_id', NULL,
    'originating_task_id', NULL, 'originating_context_id', NULL,
    'checkpoint_kind', 'information_request', 'title', 'Provide Missing Evidence',
    'explanation', 'Supply both independent sources.',
    'allowed_actions', ' ["submit_clarification","reject","skip_for_now"]'::jsonb,
    'payload', jsonb_build_object(
      'question', 'Provide the remaining Identity and Ownership evidence.',
      'questions', jsonb_build_array(
        jsonb_build_object('id', 'entity:registry', 'specialty', 'entity',
                           'field', 'source_authenticity', 'question', 'Provide an official registry record.'),
        jsonb_build_object('id', 'ownership:register', 'specialty', 'ownership',
                           'field', 'source_authenticity', 'question', 'Provide an independent shareholder register.')
      )
    )
  );
  PERFORM create_simple_coordinator_v3_checkpoint(
    coordinator_id, request_payload, request_id || ':checkpoint'
  );
  SELECT id, expected_state_version INTO checkpoint_id, expected_version
  FROM coordinator_v3_checkpoints checkpoint
  WHERE checkpoint.analysis_run_id = fixture.analysis_run_id
    AND checkpoint.request_id = fixture.request_id;
  IF checkpoint_id IS NULL THEN RAISE EXCEPTION 'structured checkpoint missing'; END IF;

  BEGIN
    PERFORM apply_simple_coordinator_v3_checkpoint_decision(
      analysis_run_id, request_id, expected_version, 'submit_clarification',
      '{"answers":{"entity:registry":"Official registry record supplied"}}'::jsonb,
      'test-analyst', request_id || ':incomplete'
    );
    RAISE EXCEPTION 'incomplete answers were accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  IF EXISTS (SELECT 1 FROM coordinator_v3_human_decisions WHERE run_id = coordinator_id) THEN
    RAISE EXCEPTION 'incomplete submission was persisted';
  END IF;

  PERFORM apply_simple_coordinator_v3_checkpoint_decision(
    analysis_run_id, request_id, expected_version, 'submit_clarification',
    answers, 'test-analyst', request_id || ':complete'
  );
  IF NOT EXISTS (
    SELECT 1 FROM coordinator_v3_human_decisions decision
    WHERE decision.run_id = coordinator_id AND decision.request_id = fixture.request_id
      AND decision.values = answers
  ) OR NOT EXISTS (
    SELECT 1 FROM coordinator_v3_checkpoints checkpoint
    WHERE checkpoint.id = checkpoint_id AND checkpoint.status = 'submitted'
      AND checkpoint.values = answers AND checkpoint.decided_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'answers did not persist or checkpoint did not resolve';
  END IF;
  IF (SELECT count(*) FROM human_input_requests input
      WHERE input.analysis_run_id = fixture.analysis_run_id AND input.status = 'answered'
        AND input.checkpoint_id = fixture.checkpoint_id::text
        AND input.response->>'answer' = answers->'answers'->>(input.response->>'question_id')
        AND input.question IN ('Provide an official registry record.',
                               'Provide an independent shareholder register.')) <> 2 THEN
    RAISE EXCEPTION 'each answer was not recorded as a citable human input';
  END IF;

  BEGIN
    INSERT INTO coordinator_v3_checkpoints (
      analysis_run_id, case_id, langflow_job_id, checkpoint_kind, request_id,
      prompt, request_payload, schema_version, checkpoint_version,
      expected_state_version, created_at
    )
    SELECT checkpoint.analysis_run_id, checkpoint.case_id, checkpoint.langflow_job_id,
           checkpoint.checkpoint_kind, fixture.request_id || ':repeat', checkpoint.prompt,
           jsonb_set(checkpoint.request_payload, '{request_id}',
                     to_jsonb(fixture.request_id || ':repeat')), checkpoint.schema_version,
           checkpoint.checkpoint_version + 1, checkpoint.expected_state_version,
           clock_timestamp()
    FROM coordinator_v3_checkpoints checkpoint WHERE checkpoint.id = checkpoint_id;
    RAISE EXCEPTION 'answered question was requested again';
  EXCEPTION WHEN SQLSTATE '23P01' THEN NULL;
  END;
END $$;

ROLLBACK;
