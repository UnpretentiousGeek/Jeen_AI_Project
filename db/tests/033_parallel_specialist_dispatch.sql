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
  plan jsonb := jsonb_build_array(
    jsonb_build_object('specialty', 'entity', 'reason', 'Identity.', 'task_objective', 'Validate identity.', 'required', true),
    jsonb_build_object('specialty', 'ownership', 'reason', 'Ownership.', 'task_objective', 'Validate ownership.', 'required', true),
    jsonb_build_object('specialty', 'policy', 'reason', 'Policy.', 'task_objective', 'Apply policy.', 'required', true)
  );
  directive jsonb;
  specialty text;
  blocked boolean;
  pending jsonb;
BEGIN
  INSERT INTO applicants (legal_name, jurisdiction, business_type, product)
  VALUES ('Synthetic Parallel Test Ltd', 'US-CA', 'software', 'domestic_payments')
  RETURNING id INTO applicant_id;
  INSERT INTO applications (applicant_id) VALUES (applicant_id)
  RETURNING id INTO application_id;
  INSERT INTO onboarding_cases (application_id, applicant_id, reference, status)
  VALUES (application_id, applicant_id, 'SYNTHETIC-PARALLEL-' || gen_random_uuid()::text, 'processing')
  RETURNING id INTO case_id;
  INSERT INTO analysis_runs (
    case_id, session_id, status, policy_effective_on, case_snapshot, started_at
  ) VALUES (
    case_id, 'synthetic-parallel-' || gen_random_uuid()::text, 'running', CURRENT_DATE,
    jsonb_build_object('applicant', jsonb_build_object(
      'jurisdiction', 'US-CA', 'product', 'domestic_payments', 'business_type', 'software'
    )), now()
  ) RETURNING id INTO analysis_run_id;
  UPDATE onboarding_cases SET active_analysis_run_id = analysis_run_id WHERE id = case_id;
  SELECT (start_or_resume_simple_coordinator_v3(
    analysis_run_id, case_id,
    (SELECT session_id FROM analysis_runs WHERE id = analysis_run_id),
    'synthetic-flow', 'synthetic-job', 'Test parallel dispatch.', 8
  )->>'coordinator_run_id')::uuid INTO coordinator_id;
  SELECT langflow_job_id INTO coordinator_job FROM coordinator_v3_runs WHERE id = coordinator_id;

  directive := jsonb_build_object(
    'schema_version', '1.0', 'analysis_run_id', analysis_run_id,
    'expected_state_version', (SELECT state_version FROM coordinator_v3_runs WHERE id = coordinator_id),
    'iteration', 1, 'plan', plan, 'next_action', 'dispatch_specialists',
    'target_specialties', jsonb_build_array('entity', 'ownership'),
    'attempt', 1, 'parent_task_id', NULL,
    'rationale_summary', 'Entity and Ownership are independent, so they run together.'
  );

  -- Only distinct Entity and Ownership first attempts may run together.
  FOREACH specialty IN ARRAY ARRAY['policy', 'retry', 'duplicate', 'single'] LOOP
    blocked := false;
    BEGIN
      PERFORM commit_simple_coordinator_v3_directive_with_activity(
        coordinator_id, (directive->>'expected_state_version')::bigint,
        CASE specialty
          WHEN 'policy' THEN directive || jsonb_build_object('target_specialties', jsonb_build_array('entity', 'policy'))
          WHEN 'retry' THEN directive || jsonb_build_object('attempt', 2, 'parent_task_id', 'old-task')
          WHEN 'duplicate' THEN directive || jsonb_build_object('target_specialties', jsonb_build_array('entity', 'entity'))
          ELSE directive || jsonb_build_object('target_specialties', jsonb_build_array('entity'))
        END
      );
    EXCEPTION WHEN invalid_parameter_value THEN
      blocked := position('violates action semantics' IN SQLERRM) > 0;
    END;
    IF NOT blocked THEN
      RAISE EXCEPTION 'invalid parallel dispatch (%) was accepted', specialty;
    END IF;
  END LOOP;
  blocked := false;
  BEGIN
    PERFORM commit_simple_coordinator_v3_directive_with_activity(
      coordinator_id, (directive->>'expected_state_version')::bigint,
      directive || jsonb_build_object('next_action', 'dispatch_specialist', 'target_specialty', 'entity')
    );
  EXCEPTION WHEN invalid_parameter_value THEN
    blocked := position('violates action semantics' IN SQLERRM) > 0;
  END;
  IF NOT blocked THEN
    RAISE EXCEPTION 'single dispatch carrying target_specialties was accepted';
  END IF;

  PERFORM commit_simple_coordinator_v3_directive_with_activity(
    coordinator_id, (directive->>'expected_state_version')::bigint, directive
  );

  FOREACH specialty IN ARRAY ARRAY['entity', 'ownership'] LOOP
    INSERT INTO coordinator_v3_task_events (
      analysis_run_id, langflow_job_id, specialty, task_id, context_id,
      attempt, event_type, details
    ) VALUES (
      analysis_run_id, coordinator_job, specialty, 'parallel-task-' || specialty,
      'parallel-context-' || specialty, 1, 'dispatched',
      jsonb_build_object(
        'analysis_run_id', analysis_run_id, 'coordinator_run_id', coordinator_id,
        'case_id', case_id, 'specialty', specialty,
        'task_id', 'parallel-task-' || specialty, 'context_id', 'parallel-context-' || specialty,
        'attempt', 1, 'parent_task_id', NULL, 'operation_key', 'parallel-operation'
      )
    );
  END LOOP;

  -- Policy is not part of the pending parallel dispatch.
  blocked := false;
  BEGIN
    PERFORM save_simple_coordinator_v3_contribution(
      coordinator_id,
      jsonb_build_object(
        'analysis_run_id', analysis_run_id, 'coordinator_run_id', coordinator_id,
        'case_id', case_id, 'specialty', 'policy',
        'task_id', 'parallel-task-policy', 'context_id', 'parallel-context-policy',
        'status', 'partial', 'citations', '[]'::jsonb,
        'evidence_scope', jsonb_build_object(
          'permitted_document_ids', '[]'::jsonb,
          'permitted_policy_version_ids', '[]'::jsonb,
          'permitted_web_result_ids', '[]'::jsonb
        )
      ),
      1, NULL
    );
  EXCEPTION WHEN serialization_failure THEN
    blocked := position('not the persisted dispatch' IN SQLERRM) > 0;
  END;
  IF NOT blocked THEN
    RAISE EXCEPTION 'policy contribution was accepted under the parallel dispatch';
  END IF;

  -- Ownership finishing first leaves Entity as an ordinary single dispatch.
  FOREACH specialty IN ARRAY ARRAY['ownership', 'entity'] LOOP
    PERFORM save_simple_coordinator_v3_contribution(
      coordinator_id,
      jsonb_build_object(
        'analysis_run_id', analysis_run_id, 'coordinator_run_id', coordinator_id,
        'case_id', case_id, 'specialty', specialty,
        'task_id', 'parallel-task-' || specialty, 'context_id', 'parallel-context-' || specialty,
        'status', 'completed', 'citations', '[]'::jsonb,
        'evidence_scope', jsonb_build_object(
          'permitted_document_ids', '[]'::jsonb,
          'permitted_policy_version_ids', '[]'::jsonb,
          'permitted_web_result_ids', '[]'::jsonb
        )
      ),
      1, NULL
    );
    SELECT state->'next_action' INTO pending FROM coordinator_v3_runs WHERE id = coordinator_id;
    IF specialty = 'ownership' AND (
      pending->>'next_action' IS DISTINCT FROM 'dispatch_specialist'
      OR pending->>'target_specialty' IS DISTINCT FROM 'entity'
      OR pending ? 'target_specialties'
      OR pending->'attempt' IS DISTINCT FROM '1'::jsonb
      OR pending->'parent_task_id' IS DISTINCT FROM 'null'::jsonb
    ) THEN
      RAISE EXCEPTION 'parallel dispatch did not narrow to Entity: %', pending;
    END IF;
    IF specialty = 'entity' AND jsonb_typeof(pending) IS DISTINCT FROM 'null' THEN
      RAISE EXCEPTION 'parallel dispatch stayed pending after both contributions: %', pending;
    END IF;
  END LOOP;
  IF (SELECT state->'completed_specialists' FROM coordinator_v3_runs WHERE id = coordinator_id)
     IS DISTINCT FROM '["ownership", "entity"]'::jsonb THEN
    RAISE EXCEPTION 'parallel contributions were not both marked complete';
  END IF;
END $$;

ROLLBACK;
