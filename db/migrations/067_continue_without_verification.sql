BEGIN;

-- A registry search that completed with no results may be continued past without evidence,
-- keeping its gap open. Only the search-recovery checkpoint (which names its search execution)
-- may offer continue_without_evidence; every other checkpoint keeps its exact action list.
CREATE OR REPLACE FUNCTION public.create_simple_coordinator_v3_checkpoint(p_run_id uuid, p_request jsonb, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
  coordinator coordinator_v3_runs%ROWTYPE;
  existing coordinator_v3_checkpoints%ROWTYPE;
  request_id_value text := p_request->>'request_id';
  kind text := p_request->>'checkpoint_kind';
  checkpoint_id_value uuid;
  checkpoint_version_value integer;
  stored_request jsonb;
BEGIN
  IF jsonb_typeof(p_request) <> 'object'
     OR EXISTS (
       SELECT 1 FROM jsonb_object_keys(p_request) field
       WHERE field <> ALL (ARRAY[
         'schema_version','checkpoint_id','request_id','checkpoint_version',
         'parent_checkpoint_id','parent_request_id','originating_task_id',
         'originating_context_id','checkpoint_kind','title','explanation',
         'allowed_actions','expires_at','payload'
       ])
     )
     OR p_request->>'schema_version' <> '1.0'
     OR jsonb_typeof(p_request->'schema_version') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_request->'checkpoint_id') IS DISTINCT FROM 'string'
     OR NOT COALESCE((p_request->>'checkpoint_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$', false)
     OR NULLIF(request_id_value, '') IS NULL
     OR jsonb_typeof(p_request->'checkpoint_version') IS DISTINCT FROM 'number'
     OR NOT COALESCE((p_request->>'checkpoint_version') ~ '^[0-9]+$', false)
     OR (CASE WHEN (p_request->>'checkpoint_version') ~ '^[0-9]+$'
              THEN (p_request->>'checkpoint_version')::numeric ELSE 0 END) <= 0
     OR jsonb_typeof(p_request->'parent_checkpoint_id') NOT IN ('string', 'null')
     OR jsonb_typeof(p_request->'parent_request_id') NOT IN ('string', 'null')
     OR jsonb_typeof(p_request->'originating_task_id') NOT IN ('string', 'null')
     OR jsonb_typeof(p_request->'originating_context_id') NOT IN ('string', 'null')
     OR kind NOT IN ('information_request', 'conflict_review', 'specialist_recovery',
                     'search_execution_approval', 'web_result_review', 'analyst_approval')
     OR jsonb_typeof(p_request->'title') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_request->'explanation') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_request->'allowed_actions') <> 'array'
     OR jsonb_array_length(p_request->'allowed_actions') = 0
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_request->'allowed_actions') action
       WHERE jsonb_typeof(action) IS DISTINCT FROM 'string'
          OR NULLIF(trim(action #>> '{}'), '') IS NULL
     )
     OR NULLIF(trim(p_request->>'title'), '') IS NULL
     OR NULLIF(trim(p_request->>'explanation'), '') IS NULL
     OR jsonb_typeof(p_request->'payload') IS DISTINCT FROM 'object'
     OR p_request->'payload' = '{}'::jsonb
     OR NULLIF(trim(p_idempotency_key), '') IS NULL THEN
    RAISE EXCEPTION 'human checkpoint request is invalid' USING ERRCODE = '22023';
  END IF;
  checkpoint_version_value := (p_request->>'checkpoint_version')::integer;
  checkpoint_id_value := (p_request->>'checkpoint_id')::uuid;
  IF (kind = 'information_request' AND p_request->'allowed_actions' <> '["submit_clarification","reject","skip_for_now"]'::jsonb)
     OR (kind = 'conflict_review' AND p_request->'allowed_actions' <> '["escalate","reject","skip_for_now"]'::jsonb
         -- An empty approved search may be continued past; only its recovery checkpoint offers that.
         AND NOT (p_request->'allowed_actions' = '["continue_without_evidence","escalate","reject","skip_for_now"]'::jsonb
                  AND NULLIF(trim(p_request->'payload'->>'search_execution_id'), '') IS NOT NULL))
     OR (kind = 'specialist_recovery' AND p_request->'allowed_actions' <> '["retry","abort","skip_for_now"]'::jsonb)
     OR (kind = 'search_execution_approval' AND p_request->'allowed_actions' <> '["approve","changes_requested","reject","skip_for_now"]'::jsonb)
     OR (kind = 'web_result_review' AND p_request->'allowed_actions' <> '["accept","reject","skip_for_now"]'::jsonb)
     OR (kind = 'analyst_approval' AND p_request->'allowed_actions' <> '["approve","changes_requested","reject","skip_for_now"]'::jsonb) THEN
    RAISE EXCEPTION 'human checkpoint allowed_actions do not match checkpoint_kind' USING ERRCODE = '22023';
  END IF;
  IF (kind = 'information_request'
      AND (jsonb_typeof(p_request->'payload'->'question') IS DISTINCT FROM 'string'
           OR NULLIF(trim(p_request->'payload'->>'question'), '') IS NULL))
     OR (kind = 'conflict_review'
         AND NULLIF(trim(COALESCE(p_request->'payload'->>'reason', p_request->'payload'->>'search_execution_id', '')), '') IS NULL
         AND jsonb_typeof(p_request->'payload'->'conflicts') IS DISTINCT FROM 'array')
     OR (kind = 'specialist_recovery'
         AND (p_request->'payload'->>'specialty' NOT IN ('entity','ownership','policy','public_research')
              OR NULLIF(trim(p_request->'payload'->>'task_id'), '') IS NULL
              OR NOT COALESCE((p_request->'payload'->>'attempt') ~ '^[0-9]+$', false)
              OR (p_request->'payload'->>'attempt')::integer NOT BETWEEN 1 AND 3))
     OR (kind = 'search_execution_approval'
         AND (jsonb_typeof(p_request->'payload'->'approved_scope') IS DISTINCT FROM 'object'
              OR p_request->'payload'->'approved_scope' = '{}'::jsonb
              OR NOT COALESCE((p_request->'payload'->>'scope_hash') ~ '^[0-9a-f]{64}$', false)
              OR NULLIF(trim(p_request->'payload'->>'operation_key'), '') IS NULL))
     OR (kind = 'web_result_review'
         AND NOT (
           (jsonb_typeof(p_request->'payload'->'pending_web_result_ids') = 'array'
            AND jsonb_array_length(p_request->'payload'->'pending_web_result_ids') > 0)
           OR (jsonb_typeof(p_request->'payload'->'pending_results') = 'array'
               AND jsonb_array_length(p_request->'payload'->'pending_results') > 0)
           OR (jsonb_typeof(p_request->'payload'->'results') = 'array'
               AND jsonb_array_length(p_request->'payload'->'results') > 0)
         ))
     OR (kind = 'analyst_approval'
         AND (jsonb_typeof(p_request->'payload'->'proposal') IS DISTINCT FROM 'object'
              OR p_request->'payload'->'proposal' = '{}'::jsonb
              OR NOT COALESCE((p_request->'payload'->>'proposal_hash') ~ '^[0-9a-f]{64}$', false)
              OR NULLIF(trim(p_request->'payload'->>'operation_key'), '') IS NULL)) THEN
    RAISE EXCEPTION 'human checkpoint payload does not match checkpoint_kind' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO coordinator FROM coordinator_v3_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND OR coordinator.phase <> 'running' THEN
    RAISE EXCEPTION 'coordinator run cannot create a checkpoint' USING ERRCODE = '55000';
  END IF;
  stored_request := p_request || jsonb_build_object(
    'kind', kind,
    'expected_state_version', coordinator.state_version
  );
  SELECT * INTO existing
  FROM coordinator_v3_checkpoints
  WHERE analysis_run_id = coordinator.analysis_run_id
    AND request_id = request_id_value;
  IF FOUND THEN
    IF existing.id = checkpoint_id_value
       AND existing.request_payload - 'kind' - 'expected_state_version'
           = p_request - 'kind' - 'expected_state_version' THEN
      RETURN jsonb_build_object('status', 'duplicate_suppressed', 'request_id', request_id_value);
    END IF;
    RAISE EXCEPTION 'checkpoint request replay conflicts with persistence' USING ERRCODE = '23P01';
  END IF;
  IF EXISTS (
    SELECT 1 FROM coordinator_v3_checkpoints checkpoint
    WHERE checkpoint.analysis_run_id = coordinator.analysis_run_id
      AND checkpoint.langflow_job_id = coordinator.langflow_job_id
      AND checkpoint.status = 'pending'
  ) THEN
    RAISE EXCEPTION 'coordinator run already has a pending checkpoint' USING ERRCODE = '23505';
  END IF;

  INSERT INTO coordinator_v3_checkpoints(
    id, analysis_run_id, case_id, langflow_job_id, checkpoint_kind,
    request_id, prompt, status, request_payload, schema_version,
    checkpoint_version, expected_state_version
  ) VALUES (
    checkpoint_id_value, coordinator.analysis_run_id, coordinator.case_id,
    coordinator.langflow_job_id, kind, request_id_value,
    stored_request::text, 'pending', stored_request,
    p_request->>'schema_version', checkpoint_version_value, coordinator.state_version
  );
  UPDATE coordinator_v3_runs
  SET phase = 'waiting_for_human',
      state_version = state_version + 1,
      state = state || jsonb_build_object(
        'status', 'waiting_for_human',
        'pending_checkpoint', stored_request,
        'checkpoint_idempotency_key', p_idempotency_key,
        'next_action', NULL,
        'next_action_idempotency_key', NULL,
        'updated_at', clock_timestamp()
      ),
      updated_at = clock_timestamp()
  WHERE id = coordinator.id;
  UPDATE analysis_runs SET status = 'suspended' WHERE id = coordinator.analysis_run_id;
  UPDATE onboarding_cases
  SET status = CASE WHEN kind = 'information_request' THEN 'awaiting_information' ELSE 'awaiting_approval' END,
      updated_at = clock_timestamp()
  WHERE id = coordinator.case_id;
  RETURN jsonb_build_object('status', 'waiting_for_human', 'request', stored_request);
END;
$function$;

COMMIT;
