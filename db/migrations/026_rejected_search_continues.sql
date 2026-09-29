BEGIN;

-- Rejecting a proposed search resumes the run without network access.
CREATE OR REPLACE FUNCTION apply_simple_coordinator_v3_checkpoint_decision(
  p_analysis_run_id uuid,
  p_request_id text,
  p_expected_state_version bigint,
  p_action text,
  p_values jsonb,
  p_actor_id text,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  coordinator coordinator_v3_runs%ROWTYPE;
  checkpoint coordinator_v3_checkpoints%ROWTYPE;
  prior coordinator_v3_human_decisions%ROWTYPE;
  prior_skip coordinator_v3_checkpoint_skips%ROWTYPE;
  decision_hash_value text := encode(digest(jsonb_build_object(
    'action', p_action, 'values', COALESCE(p_values, '{}'::jsonb), 'actor_id', p_actor_id
  )::text, 'sha256'), 'hex');
  next_status text;
  skip_id uuid;
  search_rejected boolean;
  search_revision_requested boolean;
  stop_run boolean;
  search_scope jsonb;
BEGIN
  IF NULLIF(trim(p_request_id), '') IS NULL
     OR p_expected_state_version < 0
     OR NULLIF(trim(p_action), '') IS NULL
     OR NULLIF(trim(p_actor_id), '') IS NULL
     OR NULLIF(trim(p_idempotency_key), '') IS NULL
     OR jsonb_typeof(COALESCE(p_values, '{}'::jsonb)) <> 'object' THEN
    RAISE EXCEPTION 'human checkpoint decision is invalid' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO coordinator
  FROM coordinator_v3_runs
  WHERE analysis_run_id = p_analysis_run_id
    AND engine_version = 'durable-loop-v1'
  ORDER BY created_at DESC LIMIT 1
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'persisted coordinator run is unavailable' USING ERRCODE = '23503';
  END IF;
  SELECT * INTO prior
  FROM coordinator_v3_human_decisions
  WHERE run_id = coordinator.id
    AND (request_id = p_request_id OR idempotency_key = p_idempotency_key);
  IF FOUND THEN
    IF prior.request_id = p_request_id
       AND prior.decision = p_action
       AND prior.values = COALESCE(p_values, '{}'::jsonb)
       AND prior.actor_id = p_actor_id
       AND prior.expected_state_version = p_expected_state_version
       AND prior.idempotency_key = p_idempotency_key THEN
      RETURN jsonb_build_object('status', 'duplicate_suppressed', 'outcome', 'replay', 'applied', false,
                                'request_id', p_request_id);
    END IF;
    RAISE EXCEPTION 'human decision replay conflicts with persistence' USING ERRCODE = '23P01';
  END IF;
  SELECT * INTO checkpoint
  FROM coordinator_v3_checkpoints
  WHERE analysis_run_id = coordinator.analysis_run_id
    AND langflow_job_id = coordinator.langflow_job_id
    AND request_id = p_request_id
    AND status = 'pending'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pending checkpoint is unavailable' USING ERRCODE = '40001';
  END IF;
  IF checkpoint.expected_state_version <> p_expected_state_version
     OR coordinator.phase <> 'waiting_for_human'
     OR coordinator.state->>'status' <> 'waiting_for_human' THEN
    RAISE EXCEPTION 'human checkpoint decision is stale or coordinator is not waiting' USING ERRCODE = '40001';
  END IF;
  IF NOT (checkpoint.request_payload->'allowed_actions' ? p_action) THEN
    RAISE EXCEPTION 'human checkpoint action is not allowed' USING ERRCODE = '42501';
  END IF;
  IF (p_action = 'changes_requested' AND (
        jsonb_typeof(p_values->'requested_changes') <> 'object'
        OR p_values->'requested_changes' = '{}'::jsonb
      ))
     OR (checkpoint.checkpoint_kind = 'information_request'
         AND p_action = 'submit_clarification'
         AND p_values = '{}'::jsonb)
     OR (checkpoint.checkpoint_kind = 'specialist_recovery'
         AND p_action = 'retry'
         AND (checkpoint.request_payload->'payload'->>'specialty' NOT IN ('entity','ownership','policy','public_research')
              OR NULLIF(checkpoint.request_payload->'payload'->>'task_id', '') IS NULL
              OR COALESCE((checkpoint.request_payload->'payload'->>'attempt')::integer, 0) NOT BETWEEN 1 AND 2))
     OR (checkpoint.checkpoint_kind = 'search_execution_approval'
         AND p_action = 'approve'
         AND (NULLIF(checkpoint.request_payload->'payload'->>'operation_key', '') IS NULL
              OR NULLIF(checkpoint.request_payload->'payload'->>'scope_hash', '') IS NULL
              OR p_values->>'scope_hash' IS DISTINCT FROM checkpoint.request_payload->'payload'->>'scope_hash'))
     OR (checkpoint.checkpoint_kind = 'analyst_approval'
         AND p_action = 'approve'
         AND (NULLIF(checkpoint.request_payload->'payload'->>'operation_key', '') IS NULL
              OR NULLIF(checkpoint.request_payload->'payload'->>'proposal_hash', '') IS NULL
              OR p_values->>'proposal_hash' IS DISTINCT FROM checkpoint.request_payload->'payload'->>'proposal_hash'))
     OR (checkpoint.checkpoint_kind = 'web_result_review'
         AND p_action = 'accept'
         AND (jsonb_typeof(p_values->'result_decisions') <> 'array'
              OR jsonb_array_length(p_values->'result_decisions') = 0)) THEN
    RAISE EXCEPTION 'human checkpoint decision payload does not match its typed request' USING ERRCODE = '22023';
  END IF;
  IF p_action = 'skip_for_now' THEN
    SELECT * INTO prior_skip
    FROM coordinator_v3_checkpoint_skips
    WHERE run_id = coordinator.id
      AND request_id = p_request_id
    ORDER BY skipped_at DESC
    LIMIT 1;
    IF FOUND THEN
      IF prior_skip.actor_id = p_actor_id
         AND prior_skip.values = COALESCE(p_values, '{}'::jsonb)
         AND prior_skip.idempotency_key = p_idempotency_key THEN
        RETURN jsonb_build_object('status', 'duplicate_suppressed', 'outcome', 'replay', 'applied', false,
                                  'request_id', p_request_id);
      END IF;
      RAISE EXCEPTION 'checkpoint skip replay conflicts with persistence' USING ERRCODE = '23P01';
    END IF;
    INSERT INTO coordinator_v3_checkpoint_skips(
      run_id, request_id, actor_id, values, idempotency_key
    ) VALUES (
      coordinator.id, p_request_id, p_actor_id, COALESCE(p_values, '{}'::jsonb), p_idempotency_key
    ) ON CONFLICT (run_id, idempotency_key) DO NOTHING
    RETURNING id INTO skip_id;
    IF skip_id IS NULL THEN
      RETURN jsonb_build_object('status', 'duplicate_suppressed', 'outcome', 'replay', 'applied', false,
                                'request_id', p_request_id);
    END IF;
    UPDATE coordinator_v3_runs
    SET state_version = state_version + 1,
        state = state || jsonb_build_object(
          'last_checkpoint_skip', jsonb_build_object(
            'request_id', p_request_id,
            'actor_id', p_actor_id,
            'values', COALESCE(p_values, '{}'::jsonb),
            'idempotency_key', p_idempotency_key
          ),
          'updated_at', clock_timestamp()
        ),
        updated_at = clock_timestamp()
    WHERE id = coordinator.id;
    RETURN jsonb_build_object('status', 'waiting_for_human', 'outcome', 'applied', 'applied', true,
                              'request_id', p_request_id,
                              'expected_state_version', p_expected_state_version);
  END IF;

  search_rejected := checkpoint.checkpoint_kind = 'search_execution_approval' AND p_action = 'reject';
  search_revision_requested := checkpoint.checkpoint_kind = 'search_execution_approval'
    AND p_action = 'changes_requested';
  stop_run := p_action IN ('reject', 'abort') AND NOT search_rejected;
  IF search_rejected OR search_revision_requested THEN
    search_scope := checkpoint.request_payload->'payload'->'approved_scope';
    IF jsonb_typeof(search_scope) IS DISTINCT FROM 'object'
       OR NOT COALESCE((search_scope->>'evidence_gap_id') ~
         '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$', false)
       OR NULLIF(trim(search_scope->>'claim_id'), '') IS NULL
       OR NULLIF(trim(search_scope->>'claim'), '') IS NULL THEN
      RAISE EXCEPTION 'rejected search requires a documented claim and evidence gap' USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM evidence_gaps gap
      WHERE gap.id = (search_scope->>'evidence_gap_id')::uuid
        AND gap.analysis_run_id = coordinator.analysis_run_id
    ) THEN
      RAISE EXCEPTION 'rejected search evidence gap is not part of this analysis run' USING ERRCODE = '42501';
    END IF;
  END IF;

  INSERT INTO coordinator_v3_human_decisions(
    run_id, request_id, decision, values, decision_hash,
    checkpoint_version, expected_state_version, actor_id, idempotency_key
  ) VALUES (
    coordinator.id, p_request_id, p_action, COALESCE(p_values, '{}'::jsonb), decision_hash_value,
    checkpoint.checkpoint_version, checkpoint.expected_state_version, p_actor_id, p_idempotency_key
  );
  next_status := CASE
    WHEN p_action IN ('approve', 'accept') THEN 'approved'
    WHEN p_action IN ('reject', 'abort') THEN 'rejected'
    ELSE 'submitted'
  END;
  UPDATE coordinator_v3_checkpoints
  SET status = next_status, decision = p_action, values = COALESCE(p_values, '{}'::jsonb),
      decided_at = clock_timestamp()
  WHERE id = checkpoint.id;
  UPDATE coordinator_v3_runs
  SET phase = CASE WHEN stop_run THEN 'stopped' ELSE 'running' END,
      state_version = state_version + 1,
      state = state || jsonb_build_object(
        'status', CASE WHEN stop_run THEN 'stopped' ELSE 'running' END,
        'pending_checkpoint', NULL,
        'last_checkpoint_result', jsonb_build_object(
          'request_id', p_request_id,
          'checkpoint_kind', checkpoint.checkpoint_kind,
          'action', p_action,
          'values', COALESCE(p_values, '{}'::jsonb),
          'actor_id', p_actor_id
        ),
        'updated_at', clock_timestamp()
      ) || CASE WHEN search_rejected THEN jsonb_build_object(
        'rejected_searches', COALESCE(coordinator.state->'rejected_searches', '[]'::jsonb) ||
          jsonb_build_array(jsonb_build_object(
            'request_id', p_request_id,
            'evidence_gap_id', search_scope->>'evidence_gap_id',
            'claim_id', search_scope->>'claim_id',
            'claim', search_scope->>'claim',
            'outcome', 'web_search_not_performed',
            'scope_hash', checkpoint.request_payload->'payload'->>'scope_hash',
            'actor_id', p_actor_id,
            'rationale', NULLIF(trim(p_values->>'comment'), ''),
            'rejected_at', clock_timestamp()
          ))
      ) ELSE '{}'::jsonb END || CASE WHEN search_revision_requested THEN jsonb_build_object(
        'search_revision_request', jsonb_build_object(
          'request_id', p_request_id,
          'evidence_gap_id', search_scope->>'evidence_gap_id',
          'original_scope_hash', checkpoint.request_payload->'payload'->>'scope_hash',
          'requested_changes', p_values->'requested_changes',
          'actor_id', p_actor_id
        )
      ) ELSE '{}'::jsonb END,
      updated_at = clock_timestamp()
  WHERE id = coordinator.id;
  IF NOT stop_run THEN
    UPDATE analysis_runs SET status = 'running' WHERE id = coordinator.analysis_run_id;
    UPDATE onboarding_cases SET status = 'processing', updated_at = clock_timestamp() WHERE id = coordinator.case_id;
  END IF;
  IF stop_run THEN
    UPDATE analysis_runs
    SET status = 'failed', finished_at = COALESCE(finished_at, clock_timestamp())
    WHERE id = coordinator.analysis_run_id;
  END IF;
  RETURN jsonb_build_object('status', 'applied', 'outcome', 'applied', 'applied', true,
                            'request_id', p_request_id,
                            'checkpoint_kind', checkpoint.checkpoint_kind, 'action', p_action,
                            'values', COALESCE(p_values, '{}'::jsonb),
                            'expected_state_version', p_expected_state_version);
END;
$$;

COMMIT;
