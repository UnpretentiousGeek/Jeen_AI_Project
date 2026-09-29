BEGIN;

ALTER TABLE analysis_runs
  ADD COLUMN IF NOT EXISTS langflow_flow_id text;

CREATE UNIQUE INDEX IF NOT EXISTS analysis_runs_langflow_job_id_idx
  ON analysis_runs(langflow_job_id)
  WHERE langflow_job_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS langflow_checkpoint_intents (
  id uuid PRIMARY KEY,
  analysis_run_id uuid NOT NULL UNIQUE REFERENCES analysis_runs(id),
  originating_task_id text NOT NULL,
  question text NOT NULL,
  reason text NOT NULL,
  input_type text NOT NULL DEFAULT 'text' CHECK (input_type IN ('text', 'choice', 'document')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'attached')),
  checkpoint_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  attached_at timestamptz,
  CHECK (
    (status = 'pending' AND checkpoint_id IS NULL AND attached_at IS NULL)
    OR (status = 'attached' AND checkpoint_id IS NOT NULL AND attached_at IS NOT NULL)
  )
);

CREATE OR REPLACE FUNCTION attach_langflow_job(
  p_analysis_run_id uuid,
  p_case_id uuid,
  p_session_id text,
  p_flow_id text,
  p_job_id text
) RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  target_run analysis_runs%ROWTYPE;
BEGIN
  IF btrim(p_flow_id) = '' OR btrim(p_job_id) = '' THEN
    RAISE EXCEPTION 'Langflow flow and job identifiers are required';
  END IF;

  SELECT * INTO target_run
  FROM analysis_runs
  WHERE id = p_analysis_run_id
    AND case_id = p_case_id
    AND session_id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'analysis run does not match the case and session';
  END IF;
  IF target_run.status NOT IN ('queued', 'running', 'suspended') THEN
    RAISE EXCEPTION 'Langflow job can only be attached to an active analysis run';
  END IF;
  IF target_run.langflow_job_id IS NOT NULL THEN
    IF target_run.langflow_job_id = p_job_id
      AND target_run.langflow_flow_id = p_flow_id THEN
      RETURN 'duplicate';
    END IF;
    RAISE EXCEPTION 'analysis run is already attached to a different Langflow job';
  END IF;

  UPDATE analysis_runs
  SET langflow_flow_id = p_flow_id,
      langflow_job_id = p_job_id
  WHERE id = p_analysis_run_id;

  INSERT INTO audit_events (
    case_id, analysis_run_id, event_type, actor_type, actor_id, payload
  ) VALUES (
    p_case_id,
    p_analysis_run_id,
    'workflow.langflow_job.attached',
    'workflow',
    'langflow-launcher',
    jsonb_build_object(
      'flow_id', p_flow_id,
      'job_id', p_job_id,
      'session_id', p_session_id
    )
  );

  RETURN 'stored';
END;
$$;

CREATE OR REPLACE FUNCTION record_langflow_checkpoint_intent(
  p_request_id uuid,
  p_analysis_run_id uuid,
  p_originating_task_id text,
  p_question text,
  p_reason text
) RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  target_run analysis_runs%ROWTYPE;
  existing_intent langflow_checkpoint_intents%ROWTYPE;
BEGIN
  SELECT * INTO target_run
  FROM analysis_runs
  WHERE id = p_analysis_run_id
  FOR UPDATE;

  IF NOT FOUND OR target_run.status <> 'running' THEN
    RAISE EXCEPTION 'checkpoint intent requires a running analysis run';
  END IF;
  IF target_run.langflow_job_id IS NULL OR target_run.langflow_flow_id IS NULL THEN
    RAISE EXCEPTION 'checkpoint intent requires an attached Langflow job';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM a2a_tasks
    WHERE analysis_run_id = p_analysis_run_id
      AND task_id = p_originating_task_id
      AND status = 'completed'
  ) THEN
    RAISE EXCEPTION 'checkpoint intent must reference a completed specialist task';
  END IF;

  SELECT * INTO existing_intent
  FROM langflow_checkpoint_intents
  WHERE analysis_run_id = p_analysis_run_id;

  IF FOUND THEN
    IF existing_intent.id = p_request_id
      AND existing_intent.originating_task_id = p_originating_task_id
      AND existing_intent.question = p_question
      AND existing_intent.reason = p_reason THEN
      RETURN 'duplicate';
    END IF;
    RAISE EXCEPTION 'analysis run already has a different Langflow checkpoint intent';
  END IF;

  INSERT INTO langflow_checkpoint_intents (
    id, analysis_run_id, originating_task_id, question, reason
  ) VALUES (
    p_request_id, p_analysis_run_id, p_originating_task_id, p_question, p_reason
  );

  INSERT INTO audit_events (
    case_id, analysis_run_id, event_type, actor_type, actor_id, payload
  ) VALUES (
    target_run.case_id,
    p_analysis_run_id,
    'workflow.checkpoint.intent_recorded',
    'workflow',
    'langflow-collector',
    jsonb_build_object(
      'request_id', p_request_id,
      'originating_task_id', p_originating_task_id
    )
  );

  RETURN 'stored';
END;
$$;

CREATE OR REPLACE FUNCTION attach_langflow_checkpoint(
  p_analysis_run_id uuid,
  p_job_id text,
  p_checkpoint_id text,
  p_correlation_id text
) RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  target_run analysis_runs%ROWTYPE;
  target_intent langflow_checkpoint_intents%ROWTYPE;
  suspend_outcome text;
BEGIN
  SELECT * INTO target_run
  FROM analysis_runs
  WHERE id = p_analysis_run_id
  FOR UPDATE;

  IF NOT FOUND OR target_run.status <> 'running' THEN
    RAISE EXCEPTION 'checkpoint can only attach to a running analysis run';
  END IF;
  IF target_run.langflow_job_id <> p_job_id THEN
    RAISE EXCEPTION 'checkpoint job does not match the attached Langflow job';
  END IF;

  SELECT * INTO target_intent
  FROM langflow_checkpoint_intents
  WHERE analysis_run_id = p_analysis_run_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'analysis run has no pending Langflow checkpoint intent';
  END IF;
  IF target_intent.status = 'attached' THEN
    IF target_intent.checkpoint_id = p_checkpoint_id THEN
      RETURN 'duplicate';
    END IF;
    RAISE EXCEPTION 'checkpoint intent is already attached to another checkpoint';
  END IF;

  SELECT suspend_analysis_run_for_input(
    target_intent.id,
    p_analysis_run_id,
    target_intent.originating_task_id,
    target_intent.question,
    target_intent.reason,
    target_intent.input_type,
    NULL,
    p_job_id,
    p_checkpoint_id,
    p_correlation_id
  ) INTO suspend_outcome;

  UPDATE langflow_checkpoint_intents
  SET status = 'attached',
      checkpoint_id = p_checkpoint_id,
      attached_at = now()
  WHERE id = target_intent.id;

  INSERT INTO audit_events (
    case_id, analysis_run_id, event_type, actor_type, actor_id, payload
  ) VALUES (
    target_run.case_id,
    p_analysis_run_id,
    'workflow.checkpoint.attached',
    'workflow',
    'langflow-launcher',
    jsonb_build_object(
      'request_id', target_intent.id,
      'job_id', p_job_id,
      'checkpoint_id', p_checkpoint_id,
      'suspend_outcome', suspend_outcome
    )
  );

  RETURN 'stored';
END;
$$;

COMMIT;
