BEGIN;

-- Analyst "Request changes" on the ready-for-review handoff resumes the
-- coordinator instead of re-issuing the same handoff. The coordinator drafts
-- bounded research scopes that each still require a search execution approval.
CREATE OR REPLACE FUNCTION set_simple_coordinator_v3_next_action(
  p_run_id uuid,
  p_request_id text,
  p_next_action jsonb,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  coordinator coordinator_v3_runs%ROWTYPE;
  last_request_id text;
BEGIN
  IF NULLIF(trim(p_request_id), '') IS NULL
     OR jsonb_typeof(p_next_action) <> 'object'
     OR NULLIF(trim(p_next_action->>'route'), '') IS NULL
     OR NULLIF(trim(p_idempotency_key), '') IS NULL THEN
    RAISE EXCEPTION 'deterministic continuation is invalid' USING ERRCODE = '22023';
  END IF;
  IF p_next_action->>'route' NOT IN ('retry_specialist', 'execute_search', 'execute_action', 'analyst_revision') THEN
    RAISE EXCEPTION 'deterministic continuation route is unsupported' USING ERRCODE = '22023';
  END IF;
  IF (p_next_action->>'route' = 'retry_specialist' AND (
        EXISTS (
          SELECT 1 FROM jsonb_object_keys(p_next_action) field
          WHERE field <> ALL (ARRAY['route','specialty','attempt','parent_task_id','response_values'])
        )
        OR p_next_action->>'specialty' NOT IN ('entity','ownership','policy','public_research')
        OR jsonb_typeof(p_next_action->'attempt') IS DISTINCT FROM 'number'
        OR NOT COALESCE((p_next_action->>'attempt') ~ '^[0-9]+$', false)
        OR (p_next_action->>'attempt')::integer NOT BETWEEN 2 AND 3
        OR jsonb_typeof(p_next_action->'parent_task_id') IS DISTINCT FROM 'string'
        OR NULLIF(trim(p_next_action->>'parent_task_id'), '') IS NULL
        OR (p_next_action ? 'response_values' AND jsonb_typeof(p_next_action->'response_values') IS DISTINCT FROM 'object')
      ))
     OR (p_next_action->>'route' = 'execute_search' AND (
        EXISTS (
          SELECT 1 FROM jsonb_object_keys(p_next_action) field
          WHERE field <> ALL (ARRAY['route','operation_key','scope_hash'])
        )
        OR jsonb_typeof(p_next_action->'operation_key') IS DISTINCT FROM 'string'
        OR NULLIF(trim(p_next_action->>'operation_key'), '') IS NULL
        OR NOT (p_next_action->>'operation_key' ~ '^coord:[0-9a-fA-F-]{36}:iter:[0-9]+:[a-z_]+:[0-9a-f]{64}$')
        OR jsonb_typeof(p_next_action->'scope_hash') IS DISTINCT FROM 'string'
        OR NOT COALESCE((p_next_action->>'scope_hash') ~ '^[0-9a-f]{64}$', false)
      ))
     OR (p_next_action->>'route' = 'execute_action' AND (
        EXISTS (
          SELECT 1 FROM jsonb_object_keys(p_next_action) field
          WHERE field <> ALL (ARRAY['route','operation_key','proposal_hash'])
        )
        OR jsonb_typeof(p_next_action->'operation_key') IS DISTINCT FROM 'string'
        OR NULLIF(trim(p_next_action->>'operation_key'), '') IS NULL
        OR NOT (p_next_action->>'operation_key' ~ '^coord:[0-9a-fA-F-]{36}:iter:[0-9]+:[a-z_]+:[0-9a-f]{64}$')
        OR jsonb_typeof(p_next_action->'proposal_hash') IS DISTINCT FROM 'string'
        OR NOT COALESCE((p_next_action->>'proposal_hash') ~ '^[0-9a-f]{64}$', false)
      ))
     OR (p_next_action->>'route' = 'analyst_revision' AND (
        EXISTS (
          SELECT 1 FROM jsonb_object_keys(p_next_action) field
          WHERE field <> ALL (ARRAY['route','requested_changes'])
        )
        OR jsonb_typeof(p_next_action->'requested_changes') IS DISTINCT FROM 'object'
        OR p_next_action->'requested_changes' = '{}'::jsonb
      )) THEN
    RAISE EXCEPTION 'deterministic continuation violates route semantics' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO coordinator FROM coordinator_v3_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'simple coordinator run does not exist' USING ERRCODE = '23503';
  END IF;
  last_request_id := coordinator.state->'last_checkpoint_result'->>'request_id';
  IF last_request_id IS DISTINCT FROM p_request_id THEN
    RAISE EXCEPTION 'deterministic continuation does not match the last checkpoint' USING ERRCODE = '40001';
  END IF;
  IF coordinator.state->>'next_action_idempotency_key' IS NOT NULL THEN
    IF coordinator.state->>'next_action_idempotency_key' = p_idempotency_key
       AND coordinator.state->'next_action' = p_next_action THEN
      RETURN jsonb_build_object('status', 'duplicate_suppressed', 'next_action', p_next_action);
    END IF;
    RAISE EXCEPTION 'deterministic continuation conflicts with persisted state' USING ERRCODE = '23P01';
  END IF;
  IF coordinator.phase <> 'running' THEN
    RAISE EXCEPTION 'simple coordinator cannot accept a continuation' USING ERRCODE = '55000';
  END IF;
  UPDATE coordinator_v3_runs
  SET state_version = state_version + 1,
      state = state || jsonb_build_object(
        'next_action', p_next_action,
        'next_action_idempotency_key', p_idempotency_key,
        'updated_at', clock_timestamp()
      ),
      updated_at = clock_timestamp()
  WHERE id = p_run_id;
  RETURN jsonb_build_object('status', 'stored', 'next_action', p_next_action);
END;
$$;

CREATE OR REPLACE FUNCTION store_coordinator_v3_analyst_research_plan(
  p_run_id uuid,
  p_request_id text,
  p_plan jsonb,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  coordinator coordinator_v3_runs%ROWTYPE;
  item jsonb;
  stored jsonb;
BEGIN
  IF NULLIF(trim(p_request_id), '') IS NULL
     OR NULLIF(trim(p_idempotency_key), '') IS NULL
     OR jsonb_typeof(p_plan) IS DISTINCT FROM 'object'
     OR EXISTS (
       SELECT 1 FROM jsonb_object_keys(p_plan) field
       WHERE field <> ALL (ARRAY['requested_changes','response_summary','research'])
     )
     OR jsonb_typeof(p_plan->'requested_changes') IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_plan->'response_summary') IS DISTINCT FROM 'string'
     OR NULLIF(trim(p_plan->>'response_summary'), '') IS NULL
     OR jsonb_typeof(p_plan->'research') IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_plan->'research') > 3 THEN
    RAISE EXCEPTION 'analyst research plan is invalid' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO coordinator FROM coordinator_v3_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'simple coordinator run does not exist' USING ERRCODE = '23503';
  END IF;
  IF coordinator.state->>'analyst_research_idempotency_key' = p_idempotency_key THEN
    RETURN jsonb_build_object('status', 'duplicate_suppressed', 'plan', coordinator.state->'analyst_research');
  END IF;
  IF coordinator.phase <> 'running'
     OR coordinator.state->'next_action'->>'route' IS DISTINCT FROM 'analyst_revision'
     OR coordinator.state->'last_checkpoint_result'->>'request_id' IS DISTINCT FROM p_request_id THEN
    RAISE EXCEPTION 'analyst research plan does not match the pending revision' USING ERRCODE = '40001';
  END IF;
  -- Every drafted scope must target a documented gap of this run; the search
  -- approval checkpoint and TinyFish re-validate domains, disclosure, and limits.
  FOR item IN SELECT value FROM jsonb_array_elements(p_plan->'research') LOOP
    IF jsonb_typeof(item->'approved_scope') IS DISTINCT FROM 'object'
       OR NOT COALESCE((item->>'scope_hash') ~ '^[0-9a-f]{64}$', false)
       OR NOT COALESCE((item->>'operation_key') ~ '^coord:[0-9a-fA-F-]{36}:iter:[0-9]+:[a-z_]+:[0-9a-f]{64}$', false)
       OR NOT EXISTS (
         SELECT 1 FROM evidence_gaps gap
         WHERE gap.analysis_run_id = coordinator.analysis_run_id
           AND gap.id::text = item->'approved_scope'->>'evidence_gap_id'
       ) THEN
      RAISE EXCEPTION 'analyst research scope is outside this analysis run' USING ERRCODE = '42501';
    END IF;
  END LOOP;
  stored := p_plan || jsonb_build_object('request_id', p_request_id, 'planned_at', clock_timestamp());
  UPDATE coordinator_v3_runs
  SET state_version = state_version + 1,
      state = state || jsonb_build_object(
        'analyst_research', stored,
        'analyst_research_history', COALESCE(state->'analyst_research_history', '[]'::jsonb)
          || jsonb_build_array(stored),
        'analyst_research_idempotency_key', p_idempotency_key,
        'next_action', NULL,
        'next_action_idempotency_key', NULL,
        'updated_at', clock_timestamp()
      ),
      updated_at = clock_timestamp()
  WHERE id = p_run_id;
  RETURN jsonb_build_object('status', 'stored', 'plan', stored);
END;
$$;

COMMIT;
