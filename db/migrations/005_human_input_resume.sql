BEGIN;

ALTER TABLE analysis_runs
  ADD COLUMN IF NOT EXISTS langflow_job_id text,
  ADD COLUMN IF NOT EXISTS checkpoint_id text;

ALTER TABLE human_input_requests
  ADD COLUMN IF NOT EXISTS originating_task_id text REFERENCES a2a_tasks(task_id),
  ADD COLUMN IF NOT EXISTS originating_context_id text,
  ADD COLUMN IF NOT EXISTS correlation_id text,
  ADD COLUMN IF NOT EXISTS langflow_job_id text,
  ADD COLUMN IF NOT EXISTS checkpoint_id text,
  ADD COLUMN IF NOT EXISTS submitted_by text,
  ADD COLUMN IF NOT EXISTS response_idempotency_key text UNIQUE,
  ADD COLUMN IF NOT EXISTS replacement_task_id text REFERENCES a2a_tasks(task_id);

CREATE UNIQUE INDEX IF NOT EXISTS one_pending_clarification_per_run_idx
  ON human_input_requests(analysis_run_id)
  WHERE request_type = 'clarification' AND status = 'pending';

CREATE TABLE IF NOT EXISTS workflow_events (
  event_id text PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES onboarding_cases(id),
  analysis_run_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN (
    'run.status_changed', 'agent.task.updated', 'agent.artifact.available',
    'human.input.requested', 'human.input.submitted', 'human.input.resumed',
    'human.review.requested', 'human.review.decided',
    'action.executed', 'action.failed'
  )),
  correlation_id text NOT NULL,
  causation_id text,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (analysis_run_id, case_id) REFERENCES analysis_runs(id, case_id)
);

ALTER TABLE citations
  ADD COLUMN IF NOT EXISTS human_input_request_id uuid REFERENCES human_input_requests(id);

ALTER TABLE citations DROP CONSTRAINT IF EXISTS citations_source_kind_check;
ALTER TABLE citations DROP CONSTRAINT IF EXISTS citations_check;

ALTER TABLE citations
  ADD CONSTRAINT citations_source_kind_check
    CHECK (source_kind IN ('case_document', 'policy', 'human_input')),
  ADD CONSTRAINT citations_source_reference_check CHECK (
    (source_kind = 'case_document'
      AND document_chunk_id IS NOT NULL
      AND policy_chunk_id IS NULL
      AND human_input_request_id IS NULL)
    OR
    (source_kind = 'policy'
      AND policy_chunk_id IS NOT NULL
      AND document_chunk_id IS NULL
      AND human_input_request_id IS NULL)
    OR
    (source_kind = 'human_input'
      AND human_input_request_id IS NOT NULL
      AND document_chunk_id IS NULL
      AND policy_chunk_id IS NULL)
  );

CREATE OR REPLACE FUNCTION suspend_analysis_run_for_input(
  p_request_id uuid,
  p_analysis_run_id uuid,
  p_originating_task_id text,
  p_question text,
  p_reason text,
  p_input_type text,
  p_allowed_choices jsonb,
  p_langflow_job_id text,
  p_checkpoint_id text,
  p_correlation_id text
)
RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  target_run analysis_runs%ROWTYPE;
  target_task a2a_tasks%ROWTYPE;
  existing_request human_input_requests%ROWTYPE;
BEGIN
  SELECT * INTO existing_request
  FROM human_input_requests
  WHERE id = p_request_id;

  IF FOUND THEN
    IF existing_request.analysis_run_id = p_analysis_run_id
      AND existing_request.originating_task_id = p_originating_task_id
      AND existing_request.question = p_question
      AND existing_request.reason = p_reason
      AND existing_request.input_type = p_input_type
      AND existing_request.allowed_choices IS NOT DISTINCT FROM p_allowed_choices
      AND existing_request.langflow_job_id = p_langflow_job_id
      AND existing_request.checkpoint_id = p_checkpoint_id
      AND existing_request.correlation_id = p_correlation_id
    THEN
      RETURN 'duplicate';
    END IF;
    RAISE EXCEPTION 'human-input request identifier conflicts with existing request';
  END IF;

  SELECT * INTO target_run
  FROM analysis_runs
  WHERE id = p_analysis_run_id
  FOR UPDATE;

  IF NOT FOUND OR target_run.status <> 'running' THEN
    RAISE EXCEPTION 'analysis run must be running before it can be suspended';
  END IF;

  SELECT * INTO target_task
  FROM a2a_tasks
  WHERE task_id = p_originating_task_id
    AND analysis_run_id = p_analysis_run_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'originating A2A task does not belong to the analysis run';
  END IF;
  IF p_input_type NOT IN ('text', 'choice', 'document')
    OR ((p_input_type = 'choice') <> (p_allowed_choices IS NOT NULL))
  THEN
    RAISE EXCEPTION 'invalid human-input request shape';
  END IF;

  INSERT INTO human_input_requests (
    id, analysis_run_id, request_type, question, reason, input_type,
    allowed_choices, originating_task_id, originating_context_id,
    correlation_id, langflow_job_id, checkpoint_id
  ) VALUES (
    p_request_id, p_analysis_run_id, 'clarification', p_question, p_reason,
    p_input_type, p_allowed_choices, p_originating_task_id,
    target_task.context_id, p_correlation_id, p_langflow_job_id, p_checkpoint_id
  );

  UPDATE analysis_runs
  SET status = 'suspended',
      langflow_job_id = p_langflow_job_id,
      checkpoint_id = p_checkpoint_id
  WHERE id = p_analysis_run_id;

  UPDATE onboarding_cases
  SET status = 'awaiting_information', updated_at = now()
  WHERE id = target_run.case_id;

  INSERT INTO workflow_events (
    event_id, case_id, analysis_run_id, event_type,
    correlation_id, causation_id, payload
  ) VALUES
  (
    gen_random_uuid()::text, target_run.case_id, p_analysis_run_id,
    'run.status_changed', p_correlation_id, p_originating_task_id,
    jsonb_build_object('from', 'running', 'to', 'suspended', 'reason', p_reason)
  ),
  (
    gen_random_uuid()::text, target_run.case_id, p_analysis_run_id,
    'human.input.requested', p_correlation_id, p_originating_task_id,
    jsonb_build_object(
      'request_id', p_request_id,
      'originating_task_id', p_originating_task_id,
      'input_type', p_input_type
    )
  );

  RETURN 'stored';
END;
$$;

CREATE OR REPLACE FUNCTION submit_human_input_response(
  p_request_id uuid,
  p_case_id uuid,
  p_analysis_run_id uuid,
  p_response jsonb,
  p_submitted_by text,
  p_submitted_at timestamptz,
  p_idempotency_key text
)
RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  request human_input_requests%ROWTYPE;
  run_case_id uuid;
BEGIN
  SELECT * INTO request
  FROM human_input_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'human-input request does not exist';
  END IF;

  SELECT case_id INTO STRICT run_case_id
  FROM analysis_runs
  WHERE id = request.analysis_run_id
  FOR UPDATE;
  IF request.analysis_run_id <> p_analysis_run_id OR run_case_id <> p_case_id THEN
    RAISE EXCEPTION 'human-input response does not match its case and analysis run';
  END IF;
  IF request.status = 'answered' THEN
    IF request.response_idempotency_key = p_idempotency_key
      AND request.response = p_response
      AND request.submitted_by = p_submitted_by
      AND request.responded_at = p_submitted_at
    THEN
      RETURN 'duplicate';
    END IF;
    RAISE EXCEPTION 'human-input request has already been answered';
  END IF;
  IF request.status <> 'pending' THEN
    RAISE EXCEPTION 'human-input request is no longer pending';
  END IF;
  IF p_response ->> 'input_type' <> request.input_type THEN
    RAISE EXCEPTION 'human-input response type does not match the request';
  END IF;
  IF request.input_type IN ('text', 'choice')
    AND NULLIF(btrim(p_response ->> 'value'), '') IS NULL
  THEN
    RAISE EXCEPTION 'human-input response value is required';
  END IF;
  IF request.input_type = 'choice'
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(request.allowed_choices) choice(value)
      WHERE choice.value = p_response ->> 'value'
    )
  THEN
    RAISE EXCEPTION 'human-input response is not an allowed choice';
  END IF;
  IF request.input_type = 'document'
    AND (jsonb_typeof(p_response -> 'document_ids') <> 'array'
      OR jsonb_array_length(p_response -> 'document_ids') = 0)
  THEN
    RAISE EXCEPTION 'document response requires at least one document identifier';
  END IF;

  UPDATE human_input_requests
  SET status = 'answered', response = p_response, responded_at = p_submitted_at,
      submitted_by = p_submitted_by,
      response_idempotency_key = p_idempotency_key
  WHERE id = p_request_id;

  UPDATE analysis_runs
  SET status = 'running'
  WHERE id = p_analysis_run_id AND status = 'suspended';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'analysis run is not suspended at response time';
  END IF;

  UPDATE onboarding_cases
  SET status = 'processing', updated_at = now()
  WHERE id = p_case_id;

  INSERT INTO workflow_events (
    event_id, case_id, analysis_run_id, event_type,
    correlation_id, causation_id, payload, occurred_at
  ) VALUES
  (
    gen_random_uuid()::text, p_case_id, p_analysis_run_id,
    'human.input.submitted', request.correlation_id, p_request_id::text,
    jsonb_build_object('request_id', p_request_id, 'submitted_by', p_submitted_by),
    p_submitted_at
  ),
  (
    gen_random_uuid()::text, p_case_id, p_analysis_run_id,
    'run.status_changed', request.correlation_id, p_request_id::text,
    jsonb_build_object('from', 'suspended', 'to', 'running', 'reason', 'human input submitted'),
    p_submitted_at
  );

  RETURN 'stored';
END;
$$;

CREATE OR REPLACE FUNCTION link_human_input_resume(
  p_request_id uuid,
  p_replacement_task_id text
)
RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  request human_input_requests%ROWTYPE;
  replacement a2a_tasks%ROWTYPE;
  case_id uuid;
BEGIN
  SELECT * INTO request
  FROM human_input_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF NOT FOUND OR request.status <> 'answered' THEN
    RAISE EXCEPTION 'clarification must be answered before a resume task is linked';
  END IF;
  IF request.replacement_task_id IS NOT NULL THEN
    IF request.replacement_task_id = p_replacement_task_id THEN
      RETURN 'duplicate';
    END IF;
    RAISE EXCEPTION 'clarification is already linked to another replacement task';
  END IF;

  SELECT * INTO replacement
  FROM a2a_tasks
  WHERE task_id = p_replacement_task_id
    AND analysis_run_id = request.analysis_run_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'replacement A2A task does not belong to the analysis run';
  END IF;
  IF replacement.specialty <> (
    SELECT specialty FROM a2a_tasks WHERE task_id = request.originating_task_id
  ) THEN
    RAISE EXCEPTION 'replacement A2A task has a different specialty';
  END IF;

  UPDATE human_input_requests
  SET replacement_task_id = p_replacement_task_id
  WHERE id = p_request_id;

  SELECT analysis_run.case_id INTO STRICT case_id
  FROM analysis_runs analysis_run
  WHERE analysis_run.id = request.analysis_run_id;

  INSERT INTO workflow_events (
    event_id, case_id, analysis_run_id, event_type,
    correlation_id, causation_id, payload
  ) VALUES (
    gen_random_uuid()::text, case_id, request.analysis_run_id,
    'human.input.resumed', request.correlation_id, p_request_id::text,
    jsonb_build_object(
      'request_id', p_request_id,
      'originating_task_id', request.originating_task_id,
      'replacement_task_id', p_replacement_task_id
    )
  );

  RETURN 'stored';
END;
$$;

COMMIT;
