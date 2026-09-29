BEGIN;

CREATE TABLE a2a_agent_assignments (
  analysis_run_id uuid NOT NULL REFERENCES analysis_runs(id),
  specialty text NOT NULL CHECK (specialty IN ('entity', 'ownership', 'policy')),
  agent_name text NOT NULL,
  agent_version text NOT NULL,
  card_url text NOT NULL,
  endpoint_url text NOT NULL,
  skill_id text NOT NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (analysis_run_id, specialty),
  UNIQUE (analysis_run_id, specialty, agent_name, agent_version)
);

CREATE TABLE a2a_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_run_id uuid NOT NULL,
  specialty text NOT NULL,
  task_id text NOT NULL UNIQUE,
  context_id text NOT NULL,
  message_id text NOT NULL,
  correlation_id text NOT NULL,
  agent_name text NOT NULL,
  agent_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('completed', 'failed')),
  attempts integer NOT NULL CHECK (attempts BETWEEN 1 AND 3),
  latency_ms integer NOT NULL CHECK (latency_ms >= 0),
  completed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (analysis_run_id, specialty, agent_name, agent_version)
    REFERENCES a2a_agent_assignments(analysis_run_id, specialty, agent_name, agent_version),
  UNIQUE (analysis_run_id, specialty, message_id),
  UNIQUE (task_id, analysis_run_id, specialty)
);

CREATE TABLE specialist_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_run_id uuid NOT NULL,
  specialty text NOT NULL,
  task_id text NOT NULL,
  artifact_id text NOT NULL,
  schema_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('completed', 'partial', 'failed')),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  FOREIGN KEY (task_id, analysis_run_id, specialty)
    REFERENCES a2a_tasks(task_id, analysis_run_id, specialty),
  UNIQUE (task_id, artifact_id)
);

CREATE TRIGGER immutable_a2a_agent_assignments
BEFORE UPDATE OR DELETE ON a2a_agent_assignments
FOR EACH ROW EXECUTE FUNCTION reject_snapshot_row_mutation();

CREATE TRIGGER immutable_specialist_artifacts
BEFORE UPDATE OR DELETE ON specialist_artifacts
FOR EACH ROW EXECUTE FUNCTION reject_snapshot_row_mutation();

CREATE OR REPLACE FUNCTION record_a2a_specialist_result(
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
  p_artifact jsonb,
  p_completed_at timestamptz
)
RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  inserted_artifact_count integer;
BEGIN
  IF p_specialty NOT IN ('entity', 'ownership', 'policy') THEN
    RAISE EXCEPTION 'unsupported A2A specialty %', p_specialty;
  END IF;

  IF p_artifact ->> 'analysis_run_id' <> p_analysis_run_id::text
    OR p_artifact ->> 'specialty' <> p_specialty
    OR p_artifact ->> 'task_id' <> p_task_id
    OR p_artifact #>> '{agent,name}' <> p_agent_name
    OR p_artifact #>> '{agent,version}' <> p_agent_version
  THEN
    RAISE EXCEPTION 'A2A artifact provenance does not match the dispatch record';
  END IF;

  INSERT INTO a2a_agent_assignments (
    analysis_run_id, specialty, agent_name, agent_version,
    card_url, endpoint_url, skill_id
  ) VALUES (
    p_analysis_run_id, p_specialty, p_agent_name, p_agent_version,
    p_card_url, p_endpoint_url, p_skill_id
  )
  ON CONFLICT (analysis_run_id, specialty) DO NOTHING;

  IF NOT EXISTS (
    SELECT 1
    FROM a2a_agent_assignments assignment
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
    latency_ms, completed_at
  ) VALUES (
    p_analysis_run_id, p_specialty, p_task_id, p_context_id, p_message_id,
    p_correlation_id, p_agent_name, p_agent_version, 'completed', p_attempts,
    p_latency_ms, p_completed_at
  )
  ON CONFLICT (task_id) DO NOTHING;

  IF NOT EXISTS (
    SELECT 1
    FROM a2a_tasks task
    WHERE task.analysis_run_id = p_analysis_run_id
      AND task.specialty = p_specialty
      AND task.task_id = p_task_id
      AND task.context_id = p_context_id
      AND task.message_id = p_message_id
      AND task.correlation_id = p_correlation_id
      AND task.agent_name = p_agent_name
      AND task.agent_version = p_agent_version
      AND task.attempts = p_attempts
  ) THEN
    RAISE EXCEPTION 'A2A task identifier conflicts with existing provenance';
  END IF;

  INSERT INTO specialist_artifacts (
    analysis_run_id, specialty, task_id, artifact_id,
    schema_version, status, payload, created_at
  ) VALUES (
    p_analysis_run_id, p_specialty, p_task_id, p_artifact ->> 'artifact_id',
    p_artifact ->> 'schema_version', p_artifact ->> 'status', p_artifact,
    (p_artifact ->> 'created_at')::timestamptz
  )
  ON CONFLICT (task_id, artifact_id) DO NOTHING;

  GET DIAGNOSTICS inserted_artifact_count = ROW_COUNT;

  IF NOT EXISTS (
    SELECT 1
    FROM specialist_artifacts artifact
    WHERE artifact.task_id = p_task_id
      AND artifact.artifact_id = p_artifact ->> 'artifact_id'
      AND artifact.payload = p_artifact
  ) THEN
    RAISE EXCEPTION 'A2A artifact identifier conflicts with existing payload';
  END IF;

  RETURN CASE WHEN inserted_artifact_count = 1 THEN 'stored' ELSE 'duplicate' END;
END;
$$;

COMMIT;
