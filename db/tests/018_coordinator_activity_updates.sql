\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
  source_run record;
  started jsonb;
  coordinator_run_id uuid;
  directive jsonb;
  output_with_copy jsonb;
  result jsonb;
BEGIN
  SELECT run.id, run.case_id, run.session_id INTO source_run
  FROM analysis_runs run
  JOIN onboarding_cases case_row
    ON case_row.id = run.case_id AND case_row.active_analysis_run_id = run.id
  WHERE run.status IN ('queued', 'running', 'suspended')
    AND NOT EXISTS (
      SELECT 1 FROM coordinator_v3_runs coordinator
      WHERE coordinator.analysis_run_id = run.id
        AND coordinator.engine_version = 'durable-loop-v1'
    )
  ORDER BY run.created_at LIMIT 1;
  IF source_run.id IS NULL THEN
    RAISE EXCEPTION 'activity test requires an unused active analysis run';
  END IF;

  started := start_or_resume_simple_coordinator_v3(
    source_run.id, source_run.case_id, source_run.session_id,
    'activity-test-flow', 'activity-test-job', 'Review the pinned case evidence.', 8
  );
  coordinator_run_id := (started->>'coordinator_run_id')::uuid;
  directive := jsonb_build_object(
    'schema_version', '1.0',
    'analysis_run_id', source_run.id,
    'expected_state_version', (started->>'state_version')::bigint,
    'iteration', 1,
    'plan', jsonb_build_array(jsonb_build_object(
      'specialty', 'entity', 'reason', 'Verify identity.',
      'task_objective', 'Compare pinned identity evidence.', 'required', true
    )),
    'next_action', 'dispatch_specialist',
    'target_specialty', 'entity', 'attempt', 1, 'parent_task_id', NULL,
    'rationale_summary', 'Entity review is the next bounded operation.'
  );
  output_with_copy := directive || jsonb_build_object('activity_updates', jsonb_build_array(
    jsonb_build_object(
      'subject_key', 'specialist:entity',
      'current_summary', 'Comparing cited identity evidence'
    ),
    jsonb_build_object(
      'subject_key', 'coordinator',
      'next_summary', 'Assess the entity result when it returns'
    )
  ));

  result := commit_simple_coordinator_v3_directive_with_activity(
    coordinator_run_id, (started->>'state_version')::bigint, output_with_copy
  );
  IF result->>'status' <> 'committed'
     OR (SELECT count(*) FROM coordinator_v3_activity_updates
         WHERE run_id = coordinator_run_id AND iteration_no = 1) <> 2
     OR (SELECT iteration.directive ? 'activity_updates'
         FROM coordinator_v3_iterations iteration
         WHERE iteration.run_id = coordinator_run_id AND iteration.iteration_no = 1) THEN
    RAISE EXCEPTION 'activity copy was not separated from the executable directive';
  END IF;

  result := commit_simple_coordinator_v3_directive_with_activity(
    coordinator_run_id, (started->>'state_version')::bigint, output_with_copy
  );
  IF result->>'status' <> 'duplicate_suppressed' THEN
    RAISE EXCEPTION 'same activity output was not idempotent';
  END IF;

  BEGIN
    PERFORM commit_simple_coordinator_v3_directive_with_activity(
      coordinator_run_id, (started->>'state_version')::bigint,
      directive || jsonb_build_object('activity_updates', jsonb_build_array(
        jsonb_build_object('subject_key', 'coordinator', 'next_summary', 'Different text')
      ))
    );
    RAISE EXCEPTION 'changed activity copy was accepted for an existing iteration';
  EXCEPTION WHEN SQLSTATE '23P01' THEN
    NULL;
  END;

  BEGIN
    PERFORM commit_simple_coordinator_v3_directive_with_activity(
      coordinator_run_id, (started->>'state_version')::bigint,
      directive || jsonb_build_object('activity_updates', jsonb_build_array(
        jsonb_build_object('subject_key', 'specialist:entity',
                           'completed_summary', 'Finished the identity review')
      ))
    );
    RAISE EXCEPTION 'specialist completed copy was accepted without a task ID';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    NULL;
  END;
END;
$$;

ROLLBACK;
