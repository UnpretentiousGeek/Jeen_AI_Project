\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
  target record;
  first_decision case_final_decisions%ROWTYPE;
  replayed_decision case_final_decisions%ROWTYPE;
  audit_count integer;
BEGIN
  SELECT onboarding_case.id AS case_id, run.id AS analysis_run_id
  INTO target
  FROM onboarding_cases onboarding_case
  JOIN analysis_runs run
    ON run.id = onboarding_case.active_analysis_run_id
   AND run.case_id = onboarding_case.id
  JOIN coordinator_v3_runs coordinator
    ON coordinator.analysis_run_id = run.id
   AND coordinator.case_id = onboarding_case.id
   AND coordinator.engine_version = 'durable-loop-v1'
   AND coordinator.phase = 'ready_for_review'
  WHERE onboarding_case.status = 'ready_for_review'
    AND run.status = 'succeeded'
    AND NOT EXISTS (
      SELECT 1 FROM coordinator_v3_checkpoints checkpoint
      JOIN coordinator_v3_runs checkpoint_run
        ON checkpoint_run.analysis_run_id = checkpoint.analysis_run_id
       AND checkpoint_run.case_id = checkpoint.case_id
       AND checkpoint_run.langflow_job_id = checkpoint.langflow_job_id
      WHERE checkpoint.analysis_run_id = run.id
        AND checkpoint.case_id = onboarding_case.id
        AND checkpoint_run.engine_version = 'durable-loop-v1'
        AND checkpoint.status = 'pending'
    )
    AND NOT EXISTS (
      SELECT 1 FROM case_final_decisions decision
      WHERE decision.case_id = onboarding_case.id
    )
  ORDER BY run.finished_at DESC NULLS LAST
  LIMIT 1;

  IF target.case_id IS NULL THEN
    RAISE EXCEPTION 'test requires a succeeded active durable run ready for review';
  END IF;

  first_decision := record_case_final_decision(
    target.case_id, target.analysis_run_id, 'approved',
    'db-test-analyst', 'Rollback-only final-decision acceptance test.',
    'test:case-final-decision:approval'
  );
  replayed_decision := record_case_final_decision(
    target.case_id, target.analysis_run_id, 'approved',
    'db-test-analyst', 'Rollback-only final-decision acceptance test.',
    'test:case-final-decision:approval'
  );

  IF first_decision.id IS DISTINCT FROM replayed_decision.id THEN
    RAISE EXCEPTION 'idempotent replay did not return the original decision';
  END IF;
  IF (SELECT status FROM onboarding_cases WHERE id = target.case_id) <> 'completed' THEN
    RAISE EXCEPTION 'final decision did not complete the case';
  END IF;
  SELECT count(*) INTO audit_count
  FROM audit_events
  WHERE case_id = target.case_id
    AND analysis_run_id = target.analysis_run_id
    AND event_type = 'case.final_decision_recorded'
    AND actor_type = 'analyst'
    AND actor_id = 'db-test-analyst';
  IF audit_count <> 1 THEN
    RAISE EXCEPTION 'expected exactly one analyst audit event, found %', audit_count;
  END IF;

  BEGIN
    PERFORM record_case_final_decision(
      target.case_id, target.analysis_run_id, 'rejected',
      'db-test-analyst', 'Conflicting decision attempt.',
      'test:case-final-decision:conflict'
    );
    RAISE EXCEPTION 'conflicting second decision unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '23P01' THEN
    NULL;
  END;
END;
$$;

ROLLBACK;

BEGIN;

DO $$
DECLARE
  target record;
  rejected case_final_decisions%ROWTYPE;
BEGIN
  SELECT onboarding_case.id AS case_id, run.id AS analysis_run_id
  INTO target
  FROM onboarding_cases onboarding_case
  JOIN analysis_runs run ON run.id = onboarding_case.active_analysis_run_id
  JOIN coordinator_v3_runs coordinator
    ON coordinator.analysis_run_id = run.id
   AND coordinator.case_id = onboarding_case.id
   AND coordinator.engine_version = 'durable-loop-v1'
   AND coordinator.phase = 'ready_for_review'
  WHERE onboarding_case.status = 'ready_for_review'
    AND run.status = 'succeeded'
    AND NOT EXISTS (
      SELECT 1 FROM coordinator_v3_checkpoints checkpoint
      WHERE checkpoint.analysis_run_id = run.id AND checkpoint.status = 'pending'
    )
  LIMIT 1;
  IF target.case_id IS NULL THEN
    RAISE EXCEPTION 'test requires a succeeded active durable run ready for review';
  END IF;

  rejected := record_case_final_decision(
    target.case_id, target.analysis_run_id, 'rejected',
    'db-test-analyst', 'Ownership could not be verified.',
    'test:case-final-decision:rejection'
  );
  IF rejected.decision <> 'rejected'
     OR (SELECT status FROM onboarding_cases WHERE id = target.case_id) <> 'completed' THEN
    RAISE EXCEPTION 'rejected final decision was not persisted as a completed case';
  END IF;
END;
$$;

ROLLBACK;
