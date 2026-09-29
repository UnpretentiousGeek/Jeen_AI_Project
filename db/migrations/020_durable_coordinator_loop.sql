BEGIN;

-- The coordinator v3 tables already contain useful Langflow history.  Durable
-- execution is additive: old rows are marked as legacy and remain readable,
-- while newly-created runs use the durable engine defaults.
ALTER TABLE coordinator_v3_runs
  ADD COLUMN IF NOT EXISTS engine_version text,
  ADD COLUMN IF NOT EXISTS state_version bigint,
  ADD COLUMN IF NOT EXISTS phase text,
  ADD COLUMN IF NOT EXISTS current_iteration integer,
  ADD COLUMN IF NOT EXISTS max_iterations integer,
  ADD COLUMN IF NOT EXISTS finalized_at timestamptz,
  ADD COLUMN IF NOT EXISTS stop_reason text;

UPDATE coordinator_v3_runs
SET engine_version = COALESCE(engine_version, 'legacy-v3'),
    state_version = COALESCE(state_version, 0),
    phase = COALESCE(phase, CASE WHEN COALESCE((state ->> 'terminal')::boolean, false)
                                 THEN 'finalized' ELSE 'running' END),
    current_iteration = COALESCE(current_iteration, GREATEST(0, COALESCE((state ->> 'iteration')::integer, 0))),
    max_iterations = COALESCE(max_iterations, 12);

ALTER TABLE coordinator_v3_runs
  ALTER COLUMN engine_version SET DEFAULT 'durable-loop-v1',
  ALTER COLUMN engine_version SET NOT NULL,
  ALTER COLUMN state_version SET DEFAULT 0,
  ALTER COLUMN state_version SET NOT NULL,
  ALTER COLUMN phase SET DEFAULT 'running',
  ALTER COLUMN phase SET NOT NULL,
  ALTER COLUMN current_iteration SET DEFAULT 0,
  ALTER COLUMN current_iteration SET NOT NULL,
  ALTER COLUMN max_iterations SET DEFAULT 12,
  ALTER COLUMN max_iterations SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'coordinator_v3_runs_state_version_nonnegative') THEN
    ALTER TABLE coordinator_v3_runs
      ADD CONSTRAINT coordinator_v3_runs_state_version_nonnegative CHECK (state_version >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'coordinator_v3_runs_iteration_nonnegative') THEN
    ALTER TABLE coordinator_v3_runs
      ADD CONSTRAINT coordinator_v3_runs_iteration_nonnegative CHECK (current_iteration >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'coordinator_v3_runs_max_iterations_positive') THEN
    ALTER TABLE coordinator_v3_runs
      ADD CONSTRAINT coordinator_v3_runs_max_iterations_positive CHECK (max_iterations > 0);
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS coordinator_v3_one_active_durable_run
  ON coordinator_v3_runs (analysis_run_id)
  WHERE engine_version = 'durable-loop-v1' AND finalized_at IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'coordinator_v3_runs_identity_unique'
  ) THEN
    ALTER TABLE coordinator_v3_runs
      ADD CONSTRAINT coordinator_v3_runs_identity_unique UNIQUE (id, analysis_run_id, case_id);
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS coordinator_v3_iterations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES coordinator_v3_runs(id),
  iteration_no integer NOT NULL CHECK (iteration_no > 0),
  state_hash text NOT NULL CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  supervisor_output jsonb NOT NULL CHECK (jsonb_typeof(supervisor_output) = 'object'),
  directive jsonb NOT NULL CHECK (jsonb_typeof(directive) = 'object'),
  directive_hash text NOT NULL CHECK (directive_hash ~ '^[0-9a-f]{64}$'),
  outcome text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (run_id, iteration_no)
);
CREATE UNIQUE INDEX IF NOT EXISTS coordinator_v3_iteration_directive_unique
  ON coordinator_v3_iterations (run_id, directive_hash);

CREATE TABLE IF NOT EXISTS coordinator_v3_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES coordinator_v3_runs(id),
  operation_key text NOT NULL UNIQUE,
  kind text NOT NULL,
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('reserved', 'in_progress', 'succeeded', 'failed', 'uncertain')),
  output jsonb,
  error text,
  provider_request_id text,
  lease_token text,
  lease_owner text,
  lease_expires_at timestamptz,
  reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE UNIQUE INDEX IF NOT EXISTS coordinator_v3_one_active_operation_per_run
  ON coordinator_v3_operations (run_id)
  WHERE status IN ('reserved', 'in_progress');

-- The legacy checkpoint table is retained.  A trigger, rather than a global
-- unique index, lets old non-durable runs keep their historical pending rows.
CREATE OR REPLACE FUNCTION coordinator_v3_one_pending_durable_checkpoint()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  durable boolean;
BEGIN
  IF NEW.status = 'pending' THEN
    SELECT (engine_version = 'durable-loop-v1') INTO durable
    FROM coordinator_v3_runs
    WHERE analysis_run_id = NEW.analysis_run_id
      AND langflow_job_id = NEW.langflow_job_id;
    IF COALESCE(durable, false) THEN
      IF jsonb_typeof(NEW.request_payload) <> 'object'
         OR NOT (NEW.request_payload ? 'request_id')
         OR NOT (NEW.request_payload ? 'kind')
         OR NOT (NEW.request_payload ? 'allowed_actions')
         OR NOT (NEW.request_payload ? 'expected_state_version') THEN
        RAISE EXCEPTION 'durable checkpoint request_payload is incomplete' USING ERRCODE = '22023';
      END IF;
      PERFORM pg_advisory_xact_lock(hashtextextended(NEW.analysis_run_id::text, 0));
      IF EXISTS (
        SELECT 1
        FROM coordinator_v3_checkpoints checkpoint
        JOIN coordinator_v3_runs run ON run.analysis_run_id = checkpoint.analysis_run_id
                                       AND run.langflow_job_id = checkpoint.langflow_job_id
        WHERE checkpoint.analysis_run_id = NEW.analysis_run_id
          AND checkpoint.status = 'pending'
          AND run.engine_version = 'durable-loop-v1'
          AND NOT (TG_OP = 'UPDATE' AND checkpoint.id = NEW.id)
      ) THEN
        RAISE EXCEPTION 'one pending checkpoint is allowed per durable coordinator run'
          USING ERRCODE = '23505';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS coordinator_v3_one_pending_durable_checkpoint_trigger
  ON coordinator_v3_checkpoints;
CREATE TRIGGER coordinator_v3_one_pending_durable_checkpoint_trigger
BEFORE INSERT OR UPDATE OF status ON coordinator_v3_checkpoints
FOR EACH ROW EXECUTE FUNCTION coordinator_v3_one_pending_durable_checkpoint();

ALTER TABLE coordinator_v3_checkpoints
  ADD COLUMN IF NOT EXISTS request_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS schema_version text NOT NULL DEFAULT '1.0',
  ADD COLUMN IF NOT EXISTS checkpoint_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS expected_state_version bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS parent_checkpoint_id uuid;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'coordinator_v3_checkpoint_payload_object') THEN
    ALTER TABLE coordinator_v3_checkpoints ADD CONSTRAINT coordinator_v3_checkpoint_payload_object
      CHECK (jsonb_typeof(request_payload) = 'object');
  END IF;
END;
$$;

ALTER TABLE external_web_evidence
  ADD COLUMN IF NOT EXISTS approval_id uuid REFERENCES approvals(id),
  ADD COLUMN IF NOT EXISTS approved_scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS query text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS content text,
  ADD COLUMN IF NOT EXISTS storage_locator text,
  ADD COLUMN IF NOT EXISTS payload_hash text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'external_web_evidence_payload_hash_check') THEN
    ALTER TABLE external_web_evidence ADD CONSTRAINT external_web_evidence_payload_hash_check
      CHECK (payload_hash ~ '^[0-9a-f]{64}$');
  END IF;
END;
$$;

ALTER TABLE web_result_review_items
  ADD COLUMN IF NOT EXISTS decided_by text,
  ADD COLUMN IF NOT EXISTS rationale text;
UPDATE web_result_review_items
SET decided_by = COALESCE(decided_by, 'legacy-review'),
    rationale = COALESCE(rationale, 'Historical review decision preserved by durable-loop migration')
WHERE review_state <> 'pending_review';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'web_result_review_items_decision_audit_check') THEN
    ALTER TABLE web_result_review_items ADD CONSTRAINT web_result_review_items_decision_audit_check
      CHECK (review_state = 'pending_review' OR (decided_at IS NOT NULL AND decided_by IS NOT NULL AND rationale IS NOT NULL));
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS coordinator_v3_human_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES coordinator_v3_runs(id),
  request_id text NOT NULL,
  decision text NOT NULL,
  values jsonb NOT NULL DEFAULT '{}'::jsonb,
  decision_hash text NOT NULL CHECK (decision_hash ~ '^[0-9a-f]{64}$'),
  checkpoint_version integer NOT NULL DEFAULT 1,
  expected_state_version bigint NOT NULL DEFAULT 0,
  actor_id text NOT NULL DEFAULT 'legacy-system',
  idempotency_key text NOT NULL DEFAULT gen_random_uuid()::text,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (run_id, request_id),
  UNIQUE (run_id, idempotency_key)
);

CREATE OR REPLACE FUNCTION coordinator_v3_commit_directive_impl(
  p_run_id uuid,
  p_expected_state_version bigint,
  p_directive jsonb,
  p_supervisor_output jsonb,
  p_state_hash text,
  p_directive_hash text,
  p_outcome text
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  run coordinator_v3_runs%ROWTYPE;
  next_iteration integer;
  inserted_id uuid;
  prior_iteration coordinator_v3_iterations%ROWTYPE;
  actual_state_hash text := COALESCE(p_state_hash, encode(digest(COALESCE(p_directive, '{}'::jsonb)::text, 'sha256'), 'hex'));
  actual_directive_hash text := COALESCE(p_directive_hash, encode(digest(COALESCE(p_directive, '{}'::jsonb)::text, 'sha256'), 'hex'));
BEGIN
  IF p_directive IS NULL OR jsonb_typeof(p_directive) <> 'object'
     OR p_supervisor_output IS NULL OR jsonb_typeof(p_supervisor_output) <> 'object' THEN
    RAISE EXCEPTION 'directive and strict supervisor output must be JSON objects' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO run FROM coordinator_v3_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'durable coordinator run does not exist' USING ERRCODE = '23503';
  END IF;
  SELECT * INTO prior_iteration FROM coordinator_v3_iterations
  WHERE run_id = p_run_id AND directive_hash = actual_directive_hash;
  IF FOUND THEN
    IF prior_iteration.directive = p_directive AND prior_iteration.supervisor_output = p_supervisor_output THEN
      RETURN jsonb_build_object('status', 'duplicate_suppressed', 'run_id', run.id,
        'iteration_id', prior_iteration.id, 'iteration_no', prior_iteration.iteration_no,
        'state_version', run.state_version);
    END IF;
    RAISE EXCEPTION 'directive hash conflicts with a different directive' USING ERRCODE = '23P01';
  END IF;
  IF run.finalized_at IS NOT NULL THEN
    RAISE EXCEPTION 'durable coordinator run is finalized' USING ERRCODE = '55000';
  END IF;
  IF run.state_version <> p_expected_state_version THEN
    RAISE EXCEPTION 'expected state_version %, actual %', p_expected_state_version, run.state_version
      USING ERRCODE = '40001';
  END IF;
  IF run.current_iteration >= run.max_iterations THEN
    RAISE EXCEPTION 'maximum coordinator iterations reached' USING ERRCODE = '54000';
  END IF;
  next_iteration := run.current_iteration + 1;
  INSERT INTO coordinator_v3_iterations(
    run_id, iteration_no, state_hash, supervisor_output, directive, directive_hash, outcome
  ) VALUES (
    run.id, next_iteration, actual_state_hash, p_supervisor_output,
    p_directive, actual_directive_hash, COALESCE(p_outcome, 'committed')
  ) RETURNING id INTO inserted_id;

  UPDATE coordinator_v3_runs
  SET state = CASE WHEN p_directive ? 'state' AND jsonb_typeof(p_directive->'state') = 'object'
                   THEN p_directive->'state' ELSE state END,
      state_version = run.state_version + 1,
      current_iteration = next_iteration,
      updated_at = clock_timestamp()
  WHERE id = run.id;

  RETURN jsonb_build_object(
    'status', 'committed', 'run_id', run.id,
    'iteration_id', inserted_id, 'iteration_no', next_iteration,
    'state_version', run.state_version + 1
  );
END;
$$;

CREATE OR REPLACE FUNCTION commit_coordinator_v3_directive(
  p_run_id uuid,
  p_expected_state_version bigint,
  p_directive jsonb,
  p_supervisor_output jsonb,
  p_state_hash text,
  p_directive_hash text,
  p_outcome text
) RETURNS jsonb
LANGUAGE sql
AS $$
  SELECT coordinator_v3_commit_directive_impl($1, $2, $3, $4, $5, $6, $7);
$$;

CREATE OR REPLACE FUNCTION commit_coordinator_v3_directive(
  p_run_id uuid,
  p_expected_state_version bigint,
  p_state_hash text,
  p_supervisor_output jsonb,
  p_directive jsonb,
  p_directive_hash text,
  p_outcome text
) RETURNS jsonb
LANGUAGE sql
AS $$
  SELECT coordinator_v3_commit_directive_impl($1, $2, $5, $4, $3, $6, $7);
$$;

CREATE OR REPLACE FUNCTION apply_coordinator_v3_human_decision(
  p_run_id uuid,
  p_request_id text,
  p_checkpoint_version integer,
  p_expected_state_version bigint,
  p_decision text,
  p_values jsonb,
  p_actor_id text,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  run coordinator_v3_runs%ROWTYPE;
  prior coordinator_v3_human_decisions%ROWTYPE;
  decision_hash text := encode(
    digest(jsonb_build_object('decision', p_decision, 'values', COALESCE(p_values, '{}'::jsonb))::text, 'sha256'), 'hex'
  );
  inserted_id uuid;
  checkpoint coordinator_v3_checkpoints%ROWTYPE;
  revised_id uuid;
BEGIN
  IF NULLIF(trim(p_request_id), '') IS NULL OR NULLIF(trim(p_actor_id), '') IS NULL
     OR NULLIF(trim(p_idempotency_key), '') IS NULL THEN
    RAISE EXCEPTION 'request_id, authenticated actor_id, and idempotency_key are required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO run FROM coordinator_v3_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'durable coordinator run does not exist' USING ERRCODE = '23503';
  END IF;
  SELECT * INTO prior FROM coordinator_v3_human_decisions
  WHERE run_id = p_run_id AND request_id = p_request_id;
  IF FOUND THEN
    IF prior.decision_hash = decision_hash THEN
      RETURN jsonb_build_object('status', 'duplicate_suppressed', 'decision_id', prior.id,
                                'request_id', p_request_id, 'state_version', run.state_version,
                                'current_iteration', run.current_iteration);
    END IF;
    RAISE EXCEPTION 'conflicting replay for human request %', p_request_id USING ERRCODE = '23P01';
  END IF;
  IF run.state_version <> p_expected_state_version THEN
    RAISE EXCEPTION 'stale human decision state_version' USING ERRCODE = '40001';
  END IF;
  SELECT * INTO checkpoint FROM coordinator_v3_checkpoints
  WHERE analysis_run_id = run.analysis_run_id AND langflow_job_id = run.langflow_job_id
    AND request_id = p_request_id AND status = 'pending' FOR UPDATE;
  IF NOT FOUND OR checkpoint.checkpoint_version <> p_checkpoint_version
     OR checkpoint.expected_state_version <> p_expected_state_version THEN
    RAISE EXCEPTION
      'human decision does not match pending checkpoint version (checkpoint_version=%, expected_state_version=%, requested_version=%, requested_state_version=%)',
      checkpoint.checkpoint_version, checkpoint.expected_state_version,
      p_checkpoint_version, p_expected_state_version
      USING ERRCODE = '40001';
  END IF;
  INSERT INTO coordinator_v3_human_decisions(
    run_id, request_id, decision, values, decision_hash, checkpoint_version,
    expected_state_version, actor_id, idempotency_key
  ) VALUES (
    p_run_id, p_request_id, p_decision, COALESCE(p_values, '{}'::jsonb), decision_hash,
    p_checkpoint_version, p_expected_state_version, p_actor_id, p_idempotency_key
  )
  RETURNING id INTO inserted_id;
  IF p_decision = 'skip_for_now' THEN
    RETURN jsonb_build_object('status', 'pending', 'decision_id', inserted_id,
      'request_id', p_request_id, 'state_version', run.state_version,
      'current_iteration', run.current_iteration);
  END IF;
  UPDATE coordinator_v3_checkpoints
  SET status = 'submitted', decision = p_decision,
      values = COALESCE(p_values, '{}'::jsonb), decided_at = clock_timestamp()
  WHERE analysis_run_id = run.analysis_run_id
    AND langflow_job_id = run.langflow_job_id
    AND request_id = p_request_id
    AND status = 'pending';
  IF p_decision = 'changes_requested' THEN
    INSERT INTO coordinator_v3_checkpoints(
      analysis_run_id, case_id, langflow_job_id, checkpoint_kind, request_id,
      prompt, status, request_payload, schema_version, checkpoint_version,
      expected_state_version, parent_checkpoint_id, created_at
    ) VALUES (
      checkpoint.analysis_run_id, checkpoint.case_id, checkpoint.langflow_job_id,
      checkpoint.checkpoint_kind, p_request_id || ':v' || (p_checkpoint_version + 1),
      checkpoint.prompt, 'pending', checkpoint.request_payload, checkpoint.schema_version,
      p_checkpoint_version + 1, run.state_version, checkpoint.id, clock_timestamp()
    ) RETURNING id INTO revised_id;
  END IF;
  RETURN jsonb_build_object('status', 'applied', 'decision_id', inserted_id,
                            'request_id', p_request_id, 'revised_checkpoint_id', revised_id,
                            'state_version', run.state_version,
                            'current_iteration', run.current_iteration);
END;
$$;

-- Durable fetch admission into the existing immutable external-evidence model.
CREATE OR REPLACE FUNCTION record_coordinator_v3_web_result(
  p_execution_id uuid,
  p_approval_id uuid,
  p_analysis_run_id uuid,
  p_case_id uuid,
  p_result_id uuid,
  p_result jsonb
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  execution web_search_executions%ROWTYPE;
  existing external_web_evidence%ROWTYPE;
  review_id uuid;
  incoming_hash text := encode(digest(p_result::text, 'sha256'), 'hex');
  scope jsonb := COALESCE(p_result->'approved_scope', '{}'::jsonb);
BEGIN
  SELECT * INTO execution FROM web_search_executions WHERE id = p_execution_id FOR UPDATE;
  IF NOT FOUND OR execution.analysis_run_id <> p_analysis_run_id OR execution.case_id <> p_case_id
     OR execution.approval_id <> p_approval_id OR execution.status NOT IN ('approved', 'running', 'succeeded') THEN
    RAISE EXCEPTION 'web result execution, approval, or run identity is invalid' USING ERRCODE = '42501';
  END IF;
  IF p_result->>'query' IS DISTINCT FROM execution.query
     OR scope->>'query' IS DISTINCT FROM execution.query
     OR scope->'allowed_domains' IS DISTINCT FROM to_jsonb(execution.allowed_domains)
     OR (scope ? 'max_results' AND (scope->>'max_results')::integer <> execution.max_results) THEN
    RAISE EXCEPTION 'web result is outside the exact approved query or scope' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO existing FROM external_web_evidence WHERE id = p_result_id;
  IF FOUND THEN
    IF existing.analysis_run_id = p_analysis_run_id AND existing.payload_hash = incoming_hash THEN
      RETURN jsonb_build_object('status', 'duplicate_suppressed', 'result_id', p_result_id);
    END IF;
    RAISE EXCEPTION 'web result identity conflicts with a different checksum or scope' USING ERRCODE = '23P01';
  END IF;
  SELECT id INTO review_id FROM web_result_reviews WHERE search_execution_id = p_execution_id;
  IF review_id IS NULL THEN
    INSERT INTO web_result_reviews(search_execution_id, analysis_run_id, case_id, checkpoint_id)
    VALUES (p_execution_id, p_analysis_run_id, p_case_id, 'web-result-review:' || p_execution_id::text)
    RETURNING id INTO review_id;
  END IF;
  INSERT INTO external_web_evidence(
    id, search_execution_id, analysis_run_id, case_id, approval_id, approved_scope, query,
    url, canonical_url, title, publisher, retrieved_at, excerpt, content, storage_locator,
    content_hash, payload_hash, retrieval_method
  ) VALUES (
    p_result_id, p_execution_id, p_analysis_run_id, p_case_id, p_approval_id, scope, execution.query,
    p_result->>'url', p_result->>'canonical_url', p_result->>'title', p_result->>'publisher',
    (p_result->>'retrieved_at')::timestamptz, COALESCE(p_result->>'excerpt', ''),
    p_result->>'content', p_result->>'storage_locator', p_result->>'checksum', incoming_hash, 'tinyfish_fetch'
  );
  INSERT INTO web_result_review_items(
    review_id, external_web_evidence_id, search_execution_id, analysis_run_id, case_id, content_hash
  ) VALUES (review_id, p_result_id, p_execution_id, p_analysis_run_id, p_case_id, p_result->>'checksum');
  RETURN jsonb_build_object('status', 'stored', 'result_id', p_result_id, 'review_id', review_id);
END;
$$;

CREATE OR REPLACE FUNCTION review_coordinator_v3_web_result(
  p_result_id uuid,
  p_analysis_run_id uuid,
  p_review_status text,
  p_reviewer text,
  p_rationale text
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  item web_result_review_items%ROWTYPE;
BEGIN
  SELECT * INTO item FROM web_result_review_items
  WHERE external_web_evidence_id = p_result_id AND analysis_run_id = p_analysis_run_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'web result is outside the requested analysis run' USING ERRCODE = '42501'; END IF;
  IF p_review_status NOT IN ('accepted', 'rejected') OR NULLIF(trim(p_reviewer), '') IS NULL
     OR NULLIF(trim(p_rationale), '') IS NULL THEN
    RAISE EXCEPTION 'web result review requires status, reviewer, and rationale' USING ERRCODE = '22023';
  END IF;
  IF item.review_state = p_review_status AND item.decided_by = p_reviewer AND item.rationale = p_rationale THEN
    RETURN jsonb_build_object('status', 'duplicate_suppressed', 'result_id', p_result_id);
  END IF;
  IF item.review_state <> 'pending_review' THEN
    RAISE EXCEPTION 'web result review conflicts with an existing decision' USING ERRCODE = '23P01';
  END IF;
  UPDATE web_result_review_items
  SET review_state = p_review_status, decided_by = p_reviewer,
      rationale = p_rationale, decided_at = clock_timestamp()
  WHERE review_id = item.review_id AND external_web_evidence_id = p_result_id;
  RETURN jsonb_build_object('status', p_review_status, 'result_id', p_result_id);
END;
$$;

CREATE OR REPLACE FUNCTION get_coordinator_v3_accepted_web_evidence(
  p_analysis_run_id uuid,
  p_result_ids uuid[]
) RETURNS SETOF external_web_evidence
LANGUAGE plpgsql
AS $$
DECLARE result_id uuid;
BEGIN
  IF p_result_ids IS NULL OR cardinality(p_result_ids) = 0 THEN
    RAISE EXCEPTION 'an explicit permitted result-id set is required' USING ERRCODE = '42501';
  END IF;
  FOREACH result_id IN ARRAY p_result_ids LOOP
    IF NOT EXISTS (SELECT 1 FROM external_web_evidence WHERE id = result_id AND analysis_run_id = p_analysis_run_id) THEN
      RAISE EXCEPTION 'web result is outside the requested analysis run' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM web_result_review_items WHERE external_web_evidence_id = result_id
                   AND analysis_run_id = p_analysis_run_id AND review_state = 'accepted') THEN
      RAISE EXCEPTION 'web result is not accepted' USING ERRCODE = '42501';
    END IF;
  END LOOP;
  RETURN QUERY SELECT evidence.* FROM external_web_evidence evidence
  JOIN web_result_review_items item ON item.external_web_evidence_id = evidence.id
  WHERE evidence.analysis_run_id = p_analysis_run_id AND evidence.id = ANY(p_result_ids)
    AND item.review_state = 'accepted';
END;
$$;

CREATE TABLE IF NOT EXISTS coordinator_v3_events (
  event_id uuid PRIMARY KEY,
  cursor bigserial UNIQUE NOT NULL,
  run_id uuid NOT NULL REFERENCES coordinator_v3_runs(id),
  analysis_run_id uuid NOT NULL,
  case_id uuid NOT NULL,
  iteration_no integer,
  event_type text NOT NULL,
  correlation_id text NOT NULL,
  causation_id text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (analysis_run_id, case_id) REFERENCES analysis_runs(id, case_id)
);

CREATE OR REPLACE FUNCTION record_coordinator_v3_event(
  p_event_id uuid, p_run_id uuid, p_event_type text, p_correlation_id text,
  p_causation_id text, p_payload jsonb, p_iteration_no integer DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE existing coordinator_v3_events%ROWTYPE; run coordinator_v3_runs%ROWTYPE; inserted coordinator_v3_events%ROWTYPE;
BEGIN
  SELECT * INTO run FROM coordinator_v3_runs WHERE id = p_run_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'event run does not exist' USING ERRCODE = '23503'; END IF;
  SELECT * INTO existing FROM coordinator_v3_events WHERE event_id = p_event_id;
  IF FOUND THEN
    IF existing.run_id = p_run_id AND existing.event_type = p_event_type AND existing.payload = COALESCE(p_payload, '{}'::jsonb) THEN
      RETURN jsonb_build_object('status', 'duplicate_suppressed', 'event_id', p_event_id, 'cursor', existing.cursor);
    END IF;
    RAISE EXCEPTION 'event identity conflicts with an existing event' USING ERRCODE = '23P01';
  END IF;
  INSERT INTO coordinator_v3_events(event_id, run_id, analysis_run_id, case_id, iteration_no,
    event_type, correlation_id, causation_id, payload)
  VALUES (p_event_id, run.id, run.analysis_run_id, run.case_id, p_iteration_no,
    p_event_type, p_correlation_id, p_causation_id, COALESCE(p_payload, '{}'::jsonb))
  RETURNING * INTO inserted;
  RETURN jsonb_build_object('status', 'stored', 'event_id', inserted.event_id, 'cursor', inserted.cursor);
END;
$$;

CREATE OR REPLACE VIEW coordinator_v3_progress AS
SELECT run.id AS run_id, run.analysis_run_id, run.case_id, run.phase,
  run.current_iteration, run.max_iterations,
  COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'id', iteration.id, 'iteration_no', iteration.iteration_no, 'status', iteration.outcome,
    'state_hash', iteration.state_hash, 'directive_hash', iteration.directive_hash,
    'created_at', iteration.created_at) ORDER BY iteration.iteration_no)
    FROM coordinator_v3_iterations iteration WHERE iteration.run_id = run.id), '[]'::jsonb) AS iterations,
  COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'id', operation.id, 'operation_key', operation.operation_key, 'kind', operation.kind,
    'status', operation.status, 'attempt', 1, 'updated_at', operation.updated_at)
    ORDER BY operation.created_at, operation.id)
    FROM coordinator_v3_operations operation WHERE operation.run_id = run.id), '[]'::jsonb) AS operations,
  COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'id', checkpoint.id, 'request_id', checkpoint.request_id, 'status', checkpoint.status,
    'checkpoint_version', checkpoint.checkpoint_version, 'expected_state_version', checkpoint.expected_state_version,
    'created_at', checkpoint.created_at) ORDER BY checkpoint.created_at, checkpoint.id)
    FROM coordinator_v3_checkpoints checkpoint
    WHERE checkpoint.analysis_run_id = run.analysis_run_id AND checkpoint.langflow_job_id = run.langflow_job_id), '[]'::jsonb) AS checkpoints,
  run.updated_at
FROM coordinator_v3_runs run;

CREATE TABLE IF NOT EXISTS coordinator_v3_final_snapshots (
  run_id uuid PRIMARY KEY REFERENCES coordinator_v3_runs(id),
  analysis_run_id uuid NOT NULL REFERENCES analysis_runs(id),
  case_id uuid NOT NULL REFERENCES onboarding_cases(id),
  findings jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence_gaps jsonb NOT NULL DEFAULT '[]'::jsonb,
  conflicts jsonb NOT NULL DEFAULT '[]'::jsonb,
  citations jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE OR REPLACE FUNCTION immutable_coordinator_v3_final_snapshot()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'coordinator v3 final snapshots are immutable' USING ERRCODE = '55000';
END;
$$;
DROP TRIGGER IF EXISTS immutable_coordinator_v3_final_snapshot_trigger ON coordinator_v3_final_snapshots;
CREATE TRIGGER immutable_coordinator_v3_final_snapshot_trigger
BEFORE UPDATE OR DELETE ON coordinator_v3_final_snapshots
FOR EACH ROW EXECUTE FUNCTION immutable_coordinator_v3_final_snapshot();
CREATE OR REPLACE FUNCTION materialize_coordinator_v3_final_snapshot(p_run_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE run coordinator_v3_runs%ROWTYPE; snapshot coordinator_v3_final_snapshots%ROWTYPE;
BEGIN
  SELECT * INTO run FROM coordinator_v3_runs WHERE id = p_run_id;
  IF NOT FOUND OR run.finalized_at IS NULL THEN RAISE EXCEPTION 'final snapshot requires a finalized run' USING ERRCODE = '55000'; END IF;
  INSERT INTO coordinator_v3_final_snapshots(run_id, analysis_run_id, case_id, findings, evidence_gaps, conflicts, citations)
  VALUES (run.id, run.analysis_run_id, run.case_id,
    COALESCE((SELECT jsonb_agg(to_jsonb(finding) ORDER BY finding.created_at, finding.id)
      FROM findings finding WHERE finding.analysis_run_id = run.analysis_run_id), '[]'::jsonb),
    COALESCE((SELECT jsonb_agg(to_jsonb(gap) ORDER BY gap.created_at, gap.id)
      FROM evidence_gaps gap WHERE gap.analysis_run_id = run.analysis_run_id), '[]'::jsonb),
    COALESCE((SELECT jsonb_agg(to_jsonb(conflict) ORDER BY conflict.created_at, conflict.id)
      FROM conflicts conflict WHERE conflict.analysis_run_id = run.analysis_run_id), '[]'::jsonb),
    COALESCE((SELECT jsonb_agg(to_jsonb(citation) ORDER BY citation.created_at, citation.id)
      FROM citations citation WHERE citation.analysis_run_id = run.analysis_run_id), '[]'::jsonb))
  ON CONFLICT (run_id) DO NOTHING
  RETURNING * INTO snapshot;
  IF snapshot.run_id IS NULL THEN SELECT * INTO snapshot FROM coordinator_v3_final_snapshots WHERE run_id = p_run_id; END IF;
  RETURN jsonb_build_object('run_id', snapshot.run_id, 'analysis_run_id', snapshot.analysis_run_id,
    'case_id', snapshot.case_id, 'findings', snapshot.findings, 'evidence_gaps', snapshot.evidence_gaps,
    'conflicts', snapshot.conflicts, 'citations', snapshot.citations);
END;
$$;

COMMIT;
