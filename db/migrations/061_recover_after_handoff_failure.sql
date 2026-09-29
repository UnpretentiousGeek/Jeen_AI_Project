BEGIN;

-- A workflow failure after the coordinator has produced findings (or while it
-- acts on an analyst's requested changes) returns the case to the handoff
-- instead of discarding the finished analysis. Recovery is bounded; beyond it,
-- the caller stops the run as before.
CREATE OR REPLACE FUNCTION recover_coordinator_v3_after_failure(
  p_analysis_run_id uuid,
  p_job_id text,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  coordinator coordinator_v3_runs%ROWTYPE;
  recoveries integer;
  failure jsonb;
BEGIN
  IF NULLIF(trim(p_job_id), '') IS NULL THEN
    RAISE EXCEPTION 'failure recovery requires the failed job' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM analysis_runs WHERE id = p_analysis_run_id FOR UPDATE;
  SELECT * INTO coordinator FROM coordinator_v3_runs
  WHERE analysis_run_id = p_analysis_run_id AND engine_version = 'durable-loop-v1'
  ORDER BY created_at DESC LIMIT 1
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_recoverable', 'reason', 'no_durable_coordinator');
  END IF;
  IF coordinator.state->'last_failure'->>'job_id' = p_job_id THEN
    RETURN jsonb_build_object('status', 'already_recovered');
  END IF;
  recoveries := COALESCE((coordinator.state->>'failure_recoveries')::integer, 0);
  IF coordinator.phase <> 'running'
     OR recoveries >= 2
     OR NOT (
       (jsonb_typeof(coordinator.state->'latest_findings') = 'array'
        AND jsonb_array_length(coordinator.state->'latest_findings') > 0)
       OR jsonb_typeof(coordinator.state->'analyst_research') = 'object'
     ) THEN
    RETURN jsonb_build_object('status', 'not_recoverable');
  END IF;
  failure := jsonb_build_object(
    'job_id', p_job_id,
    'reason', COALESCE(NULLIF(trim(p_reason), ''), 'Langflow workflow execution failed.'),
    'failed_action', coordinator.state->'next_action',
    'at', clock_timestamp()
  );
  UPDATE coordinator_v3_runs
  SET state_version = state_version + 1,
      state = state || jsonb_build_object(
        'next_action', NULL,
        'next_action_idempotency_key', NULL,
        'failure_recoveries', recoveries + 1,
        'last_failure', failure,
        'updated_at', clock_timestamp()
      ) || CASE WHEN jsonb_typeof(state->'analyst_research') = 'object'
                 THEN jsonb_build_object('analyst_research', state->'analyst_research' || jsonb_build_object('failed', failure))
                 ELSE '{}'::jsonb END,
      updated_at = clock_timestamp()
  WHERE id = coordinator.id;
  INSERT INTO audit_events (case_id, analysis_run_id, event_type, actor_type, actor_id, payload)
  VALUES (coordinator.case_id, p_analysis_run_id, 'coordinator_failure_recovered', 'workflow',
          'coordinator-v3', failure);
  RETURN jsonb_build_object('status', 'recovered', 'failure', failure);
END;
$$;

COMMIT;
