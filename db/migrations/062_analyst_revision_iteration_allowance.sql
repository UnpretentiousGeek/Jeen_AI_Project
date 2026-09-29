BEGIN;

-- Each analyst revision may need up to 3 search approvals, 3 Public Research
-- analyses, a re-synthesis, and a new handoff. Grant those steps with the plan
-- so the revision cannot exhaust the budget sized for the initial analysis.
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
      max_iterations = max_iterations + 8,
      state = state || jsonb_build_object(
        'analyst_iteration_allowance', COALESCE((state->>'analyst_iteration_allowance')::integer, 0) + 8,
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
