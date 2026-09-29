BEGIN;

ALTER TABLE analysis_runs
  ADD COLUMN IF NOT EXISTS retry_of_analysis_run_id uuid REFERENCES analysis_runs(id),
  ADD COLUMN IF NOT EXISTS retry_idempotency_key text UNIQUE,
  ADD COLUMN IF NOT EXISTS retry_rationale text,
  ADD COLUMN IF NOT EXISTS retried_by text;

ALTER TABLE analysis_runs DROP CONSTRAINT IF EXISTS analysis_runs_retry_metadata_check;
ALTER TABLE analysis_runs
  ADD CONSTRAINT analysis_runs_retry_metadata_check CHECK (
    (retry_of_analysis_run_id IS NULL
      AND retry_idempotency_key IS NULL
      AND retry_rationale IS NULL
      AND retried_by IS NULL)
    OR
    (retry_of_analysis_run_id IS NOT NULL
      AND retry_idempotency_key IS NOT NULL
      AND length(btrim(retry_rationale)) BETWEEN 10 AND 1000
      AND length(btrim(retried_by)) BETWEEN 1 AND 200)
  );

CREATE INDEX IF NOT EXISTS analysis_runs_retry_source_idx
  ON analysis_runs(retry_of_analysis_run_id)
  WHERE retry_of_analysis_run_id IS NOT NULL;

CREATE OR REPLACE FUNCTION protect_analysis_run_inputs()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.case_id IS DISTINCT FROM OLD.case_id
    OR NEW.session_id IS DISTINCT FROM OLD.session_id
    OR NEW.output_schema_version IS DISTINCT FROM OLD.output_schema_version
    OR NEW.analyst_instructions IS DISTINCT FROM OLD.analyst_instructions
    OR NEW.policy_effective_on IS DISTINCT FROM OLD.policy_effective_on
    OR NEW.case_snapshot IS DISTINCT FROM OLD.case_snapshot
    OR NEW.retry_of_analysis_run_id IS DISTINCT FROM OLD.retry_of_analysis_run_id
    OR NEW.retry_idempotency_key IS DISTINCT FROM OLD.retry_idempotency_key
    OR NEW.retry_rationale IS DISTINCT FROM OLD.retry_rationale
    OR NEW.retried_by IS DISTINCT FROM OLD.retried_by
  THEN
    RAISE EXCEPTION 'analysis run inputs are immutable';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION retry_attention_required_run(
  p_case_id uuid,
  p_failed_analysis_run_id uuid,
  p_retried_by text,
  p_actor_roles text[],
  p_rationale text,
  p_idempotency_key text
)
RETURNS TABLE(outcome text, analysis_run_id uuid, session_id text)
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  selected_case onboarding_cases%ROWTYPE;
  failed_run analysis_runs%ROWTYPE;
  existing_run analysis_runs%ROWTYPE;
  created_run analysis_runs%ROWTYPE;
  source_document_count integer;
  copied_document_count integer;
  source_policy_count integer;
  copied_policy_count integer;
  retry_session_id text;
BEGIN
  IF NOT ('compliance_analyst' = ANY(COALESCE(p_actor_roles, ARRAY[]::text[]))) THEN
    RAISE EXCEPTION 'retry requires the compliance_analyst role';
  END IF;
  IF length(btrim(COALESCE(p_retried_by, ''))) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'retry requires an authenticated analyst identity';
  END IF;
  IF length(btrim(COALESCE(p_rationale, ''))) NOT BETWEEN 10 AND 1000 THEN
    RAISE EXCEPTION 'retry rationale must be between 10 and 1000 characters';
  END IF;
  IF length(btrim(COALESCE(p_idempotency_key, ''))) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'retry idempotency key must be between 1 and 200 characters';
  END IF;

  SELECT * INTO existing_run
  FROM analysis_runs
  WHERE retry_idempotency_key = p_idempotency_key;

  IF FOUND THEN
    IF existing_run.case_id <> p_case_id
      OR existing_run.retry_of_analysis_run_id <> p_failed_analysis_run_id
      OR existing_run.retried_by <> btrim(p_retried_by)
      OR existing_run.retry_rationale <> btrim(p_rationale)
    THEN
      RAISE EXCEPTION 'retry idempotency key conflicts with an existing request';
    END IF;

    RETURN QUERY SELECT 'duplicate'::text, existing_run.id, existing_run.session_id;
    RETURN;
  END IF;

  SELECT * INTO selected_case
  FROM onboarding_cases
  WHERE id = p_case_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'onboarding case % does not exist', p_case_id;
  END IF;

  -- A concurrent request with the same key may have committed while this
  -- transaction waited for the case lock. Recheck before evaluating state.
  SELECT * INTO existing_run
  FROM analysis_runs
  WHERE retry_idempotency_key = p_idempotency_key;

  IF FOUND THEN
    IF existing_run.case_id <> p_case_id
      OR existing_run.retry_of_analysis_run_id <> p_failed_analysis_run_id
      OR existing_run.retried_by <> btrim(p_retried_by)
      OR existing_run.retry_rationale <> btrim(p_rationale)
    THEN
      RAISE EXCEPTION 'retry idempotency key conflicts with an existing request';
    END IF;

    RETURN QUERY SELECT 'duplicate'::text, existing_run.id, existing_run.session_id;
    RETURN;
  END IF;

  IF selected_case.status <> 'attention_required'
    OR selected_case.active_analysis_run_id <> p_failed_analysis_run_id
  THEN
    RAISE EXCEPTION 'case is no longer retryable from analysis run %', p_failed_analysis_run_id;
  END IF;

  SELECT * INTO failed_run
  FROM analysis_runs
  WHERE id = p_failed_analysis_run_id
    AND case_id = p_case_id
  FOR UPDATE;

  IF NOT FOUND OR failed_run.status <> 'failed' THEN
    RAISE EXCEPTION 'analysis run % is not the failed active run for this case', p_failed_analysis_run_id;
  END IF;

  retry_session_id := 'retry:' || p_failed_analysis_run_id::text || ':' || btrim(p_idempotency_key);

  INSERT INTO analysis_runs (
    case_id, session_id, status, output_schema_version, analyst_instructions,
    policy_effective_on, case_snapshot, started_at, retry_of_analysis_run_id,
    retry_idempotency_key, retry_rationale, retried_by
  ) VALUES (
    failed_run.case_id, retry_session_id, 'queued', failed_run.output_schema_version,
    failed_run.analyst_instructions, failed_run.policy_effective_on,
    failed_run.case_snapshot, NULL, failed_run.id, btrim(p_idempotency_key),
    btrim(p_rationale), btrim(p_retried_by)
  )
  RETURNING * INTO created_run;

  SELECT count(*) INTO source_document_count
  FROM analysis_run_documents source_snapshot
  WHERE source_snapshot.analysis_run_id = failed_run.id;

  INSERT INTO analysis_run_documents (analysis_run_id, case_id, document_id)
  SELECT created_run.id, case_id, document_id
  FROM analysis_run_documents source_snapshot
  WHERE source_snapshot.analysis_run_id = failed_run.id;
  GET DIAGNOSTICS copied_document_count = ROW_COUNT;

  SELECT count(*) INTO source_policy_count
  FROM analysis_run_policy_versions source_snapshot
  WHERE source_snapshot.analysis_run_id = failed_run.id;

  INSERT INTO analysis_run_policy_versions (analysis_run_id, policy_version_id)
  SELECT created_run.id, policy_version_id
  FROM analysis_run_policy_versions source_snapshot
  WHERE source_snapshot.analysis_run_id = failed_run.id;
  GET DIAGNOSTICS copied_policy_count = ROW_COUNT;

  IF source_document_count = 0 OR copied_document_count <> source_document_count
    OR source_policy_count = 0 OR copied_policy_count <> source_policy_count
  THEN
    RAISE EXCEPTION 'failed run immutable inputs could not be copied exactly';
  END IF;

  UPDATE analysis_runs
  SET status = 'running', started_at = now()
  WHERE id = created_run.id
  RETURNING * INTO created_run;

  UPDATE onboarding_cases
  SET active_analysis_run_id = created_run.id,
      status = 'processing',
      updated_at = now()
  WHERE id = p_case_id;

  INSERT INTO workflow_events (
    event_id, case_id, analysis_run_id, event_type,
    correlation_id, causation_id, payload
  ) VALUES (
    gen_random_uuid()::text, p_case_id, created_run.id, 'run.status_changed',
    created_run.session_id, failed_run.id::text,
    jsonb_build_object(
      'from', 'queued',
      'to', 'running',
      'reason', 'analyst requested retry',
      'retry_of_analysis_run_id', failed_run.id
    )
  );

  INSERT INTO audit_events (
    case_id, analysis_run_id, event_type, actor_type, actor_id, payload
  ) VALUES
  (
    p_case_id, failed_run.id, 'analysis.retry_requested', 'analyst', btrim(p_retried_by),
    jsonb_build_object(
      'replacement_analysis_run_id', created_run.id,
      'rationale', btrim(p_rationale),
      'roles', p_actor_roles
    )
  ),
  (
    p_case_id, created_run.id, 'analysis.retry_started', 'analyst', btrim(p_retried_by),
    jsonb_build_object(
      'retry_of_analysis_run_id', failed_run.id,
      'rationale', btrim(p_rationale),
      'roles', p_actor_roles
    )
  );

  RETURN QUERY SELECT 'stored'::text, created_run.id, created_run.session_id;
END;
$$;

COMMIT;
