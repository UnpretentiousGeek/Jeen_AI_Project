BEGIN;

ALTER TABLE langflow_checkpoint_intents
  DROP CONSTRAINT IF EXISTS langflow_checkpoint_intents_analysis_run_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS one_pending_langflow_checkpoint_intent_per_run_idx
  ON langflow_checkpoint_intents(analysis_run_id)
  WHERE status = 'pending';

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
  WHERE id = p_request_id;

  IF FOUND THEN
    IF existing_intent.analysis_run_id = p_analysis_run_id
      AND existing_intent.originating_task_id = p_originating_task_id
      AND existing_intent.question = p_question
      AND existing_intent.reason = p_reason THEN
      RETURN 'duplicate';
    END IF;
    RAISE EXCEPTION 'checkpoint intent identifier conflicts with an existing intent';
  END IF;

  IF EXISTS (
    SELECT 1 FROM langflow_checkpoint_intents
    WHERE analysis_run_id = p_analysis_run_id
      AND status = 'pending'
  ) THEN
    RAISE EXCEPTION 'analysis run already has a pending Langflow checkpoint intent';
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
    AND status = 'pending'
  FOR UPDATE;

  IF NOT FOUND THEN
    IF EXISTS (
      SELECT 1 FROM langflow_checkpoint_intents
      WHERE analysis_run_id = p_analysis_run_id
        AND status = 'attached'
        AND checkpoint_id = p_checkpoint_id
    ) THEN
      RETURN 'duplicate';
    END IF;
    RAISE EXCEPTION 'analysis run has no pending Langflow checkpoint intent';
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
