\set ON_ERROR_STOP on

DO $$
DECLARE
  straight analysis_runs%ROWTYPE;
  interrupted analysis_runs%ROWTYPE;
  started_count integer;
  completed_count integer;
  last_started timestamptz;
  first_completed timestamptz;
BEGIN
  SELECT run.* INTO straight
  FROM onboarding_cases onboarding_case
  JOIN analysis_runs run ON run.id = onboarding_case.active_analysis_run_id
  WHERE onboarding_case.reference = 'KYB-LF-001';

  SELECT run.* INTO interrupted
  FROM onboarding_cases onboarding_case
  JOIN analysis_runs run ON run.id = onboarding_case.active_analysis_run_id
  WHERE onboarding_case.reference = 'KYB-LF-003';

  IF straight.status <> 'succeeded'
    OR straight.langflow_flow_id <> 'd979c3d6-2b22-451f-afb9-7b6744407589'
    OR straight.langflow_job_id IS NULL
    OR straight.checkpoint_id IS NOT NULL THEN
    RAISE EXCEPTION 'straight-through Langflow run is incomplete or incorrectly correlated';
  END IF;

  IF interrupted.status NOT IN ('suspended', 'succeeded')
    OR interrupted.langflow_flow_id <> 'd979c3d6-2b22-451f-afb9-7b6744407589'
    OR interrupted.langflow_job_id IS NULL
    OR interrupted.checkpoint_id NOT LIKE 'HumanInput-%:%' THEN
    RAISE EXCEPTION 'interrupted Langflow run is not attached to its native checkpoint';
  END IF;

  IF straight.langflow_job_id = interrupted.langflow_job_id
    OR straight.session_id = interrupted.session_id THEN
    RAISE EXCEPTION 'concurrent cases reused a Langflow job or session';
  END IF;

  IF (SELECT count(*) FROM a2a_tasks WHERE analysis_run_id = straight.id) <> 3
    OR (SELECT count(*) FROM a2a_tasks WHERE analysis_run_id = interrupted.id)
       <> (CASE WHEN interrupted.status = 'suspended' THEN 3 ELSE 4 END) THEN
    RAISE EXCEPTION 'Langflow runs do not have the expected specialist task counts';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM specialist_artifacts artifact
    JOIN a2a_tasks task ON task.task_id = artifact.task_id
    WHERE artifact.analysis_run_id <> task.analysis_run_id
  ) THEN
    RAISE EXCEPTION 'specialist artifact crossed an analysis-run boundary';
  END IF;

  SELECT
    count(*) FILTER (WHERE event_type = 'workflow.specialist.started'),
    count(*) FILTER (WHERE event_type = 'workflow.specialist.completed'),
    max(created_at) FILTER (WHERE event_type = 'workflow.specialist.started'),
    min(created_at) FILTER (WHERE event_type = 'workflow.specialist.completed')
  INTO started_count, completed_count, last_started, first_completed
  FROM audit_events
  WHERE analysis_run_id = straight.id
    AND event_type IN ('workflow.specialist.started', 'workflow.specialist.completed');

  IF started_count <> 3 OR completed_count <> 3 OR last_started >= first_completed THEN
    RAISE EXCEPTION 'straight-through specialist branches did not overlap';
  END IF;

  SELECT
    count(*) FILTER (WHERE event_type = 'workflow.specialist.started'),
    count(*) FILTER (WHERE event_type = 'workflow.specialist.completed'),
    max(created_at) FILTER (WHERE event_type = 'workflow.specialist.started'),
    min(created_at) FILTER (WHERE event_type = 'workflow.specialist.completed')
  INTO started_count, completed_count, last_started, first_completed
  FROM audit_events
  WHERE analysis_run_id = interrupted.id
    AND event_type IN ('workflow.specialist.started', 'workflow.specialist.completed')
    AND NOT (payload ? 'phase');

  IF started_count <> 3 OR completed_count <> 3 OR last_started >= first_completed THEN
    RAISE EXCEPTION 'interrupted specialist branches did not overlap';
  END IF;

  IF interrupted.status = 'suspended' AND NOT EXISTS (
    SELECT 1
    FROM human_input_requests request
    WHERE request.analysis_run_id = interrupted.id
      AND request.status = 'pending'
      AND request.langflow_job_id = interrupted.langflow_job_id
      AND request.checkpoint_id = interrupted.checkpoint_id
  ) THEN
    RAISE EXCEPTION 'native Langflow checkpoint is not persisted on the human-input request';
  END IF;
END;
$$;

SELECT 'langflow orchestration verification passed' AS result;
