BEGIN;

ALTER TABLE a2a_tasks
  ADD COLUMN IF NOT EXISTS error_code text,
  ADD COLUMN IF NOT EXISTS error_message text,
  ADD CONSTRAINT a2a_tasks_failure_details_check CHECK (
    (status = 'failed') = (error_code IS NOT NULL AND error_message IS NOT NULL)
  );

CREATE OR REPLACE FUNCTION record_a2a_specialist_failure(
  p_analysis_run_id uuid,
  p_specialty text,
  p_agent_name text,
  p_agent_version text,
  p_card_url text,
  p_endpoint_url text,
  p_skill_id text,
  p_task_id text,
  p_context_id text,
  p_message_id text,
  p_correlation_id text,
  p_attempts integer,
  p_latency_ms integer,
  p_error_code text,
  p_error_message text,
  p_completed_at timestamptz
)
RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  inserted_task_count integer;
BEGIN
  IF p_specialty NOT IN ('entity', 'ownership', 'policy') THEN
    RAISE EXCEPTION 'unsupported required A2A specialty %', p_specialty;
  END IF;
  IF p_attempts NOT BETWEEN 1 AND 3
    OR p_latency_ms < 0
    OR NULLIF(btrim(p_error_code), '') IS NULL
    OR NULLIF(btrim(p_error_message), '') IS NULL
  THEN
    RAISE EXCEPTION 'failed A2A task provenance is invalid';
  END IF;

  INSERT INTO a2a_agent_assignments (
    analysis_run_id, specialty, agent_name, agent_version,
    card_url, endpoint_url, skill_id
  ) VALUES (
    p_analysis_run_id, p_specialty, p_agent_name, p_agent_version,
    p_card_url, p_endpoint_url, p_skill_id
  ) ON CONFLICT (analysis_run_id, specialty) DO NOTHING;

  IF NOT EXISTS (
    SELECT 1 FROM a2a_agent_assignments assignment
    WHERE assignment.analysis_run_id = p_analysis_run_id
      AND assignment.specialty = p_specialty
      AND assignment.agent_name = p_agent_name
      AND assignment.agent_version = p_agent_version
      AND assignment.card_url = p_card_url
      AND assignment.endpoint_url = p_endpoint_url
      AND assignment.skill_id = p_skill_id
  ) THEN
    RAISE EXCEPTION 'analysis run specialty is already pinned to a different A2A agent';
  END IF;

  INSERT INTO a2a_tasks (
    analysis_run_id, specialty, task_id, context_id, message_id,
    correlation_id, agent_name, agent_version, status, attempts,
    latency_ms, completed_at, error_code, error_message
  ) VALUES (
    p_analysis_run_id, p_specialty, p_task_id, p_context_id, p_message_id,
    p_correlation_id, p_agent_name, p_agent_version, 'failed', p_attempts,
    p_latency_ms, p_completed_at, p_error_code, p_error_message
  ) ON CONFLICT (task_id) DO NOTHING;

  GET DIAGNOSTICS inserted_task_count = ROW_COUNT;

  IF NOT EXISTS (
    SELECT 1 FROM a2a_tasks task
    WHERE task.analysis_run_id = p_analysis_run_id
      AND task.specialty = p_specialty
      AND task.task_id = p_task_id
      AND task.context_id = p_context_id
      AND task.message_id = p_message_id
      AND task.correlation_id = p_correlation_id
      AND task.agent_name = p_agent_name
      AND task.agent_version = p_agent_version
      AND task.status = 'failed'
      AND task.attempts = p_attempts
      AND task.error_code = p_error_code
      AND task.error_message = p_error_message
  ) THEN
    RAISE EXCEPTION 'failed A2A task identifier conflicts with existing provenance';
  END IF;

  RETURN CASE WHEN inserted_task_count = 1 THEN 'stored' ELSE 'duplicate' END;
END;
$$;

COMMIT;
