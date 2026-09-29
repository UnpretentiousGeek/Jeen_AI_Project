BEGIN;

-- Allow a persisted, checkpoint-authorized retry to save its reserved specialist result.
CREATE OR REPLACE FUNCTION save_simple_coordinator_v3_contribution(
  p_run_id uuid,
  p_payload jsonb,
  p_attempt integer,
  p_parent_task_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  coordinator coordinator_v3_runs%ROWTYPE;
  existing coordinator_v3_contributions%ROWTYPE;
  persisted_action jsonb;
  specialty_value text := p_payload->>'specialty';
  task_id_value text := p_payload->>'task_id';
  context_id_value text := p_payload->>'context_id';
  payload_hash_value text := encode(digest(COALESCE(p_payload, '{}'::jsonb)::text, 'sha256'), 'hex');
  completed jsonb;
BEGIN
  IF jsonb_typeof(p_payload) <> 'object'
     OR specialty_value NOT IN ('entity', 'ownership', 'policy', 'public_research')
     OR NULLIF(task_id_value, '') IS NULL
     OR NULLIF(context_id_value, '') IS NULL
     OR p_attempt NOT BETWEEN 1 AND 3
     OR (p_attempt = 1 AND p_parent_task_id IS NOT NULL)
     OR (p_attempt > 1 AND NULLIF(p_parent_task_id, '') IS NULL) THEN
    RAISE EXCEPTION 'specialist contribution envelope is invalid' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO coordinator FROM coordinator_v3_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND
     OR p_payload->>'analysis_run_id' <> coordinator.analysis_run_id::text
     OR p_payload->>'coordinator_run_id' <> coordinator.id::text
     OR p_payload->>'case_id' <> coordinator.case_id::text THEN
    RAISE EXCEPTION 'specialist contribution does not belong to the coordinator run' USING ERRCODE = '42501';
  END IF;
  persisted_action := coordinator.state->'next_action';
  IF coordinator.phase <> 'running'
     OR coordinator.state->>'status' <> 'running'
     OR jsonb_typeof(persisted_action) IS DISTINCT FROM 'object'
     OR (
       (persisted_action->>'next_action' = 'dispatch_specialist'
        AND persisted_action->>'target_specialty' = specialty_value)
       OR (persisted_action->>'route' = 'retry_specialist'
           AND persisted_action->>'specialty' = specialty_value
           AND p_attempt > 1)
     ) IS NOT TRUE
     OR (CASE WHEN (persisted_action->>'attempt') ~ '^[0-9]+$'
              THEN (persisted_action->>'attempt')::integer ELSE 0 END) <> p_attempt
     OR ((p_parent_task_id IS NULL AND jsonb_typeof(persisted_action->'parent_task_id') IS DISTINCT FROM 'null')
         OR (p_parent_task_id IS NOT NULL AND persisted_action->>'parent_task_id' IS DISTINCT FROM p_parent_task_id)) THEN
    RAISE EXCEPTION 'specialist contribution is not the persisted dispatch' USING ERRCODE = '40001';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM coordinator_v3_task_events reservation
    WHERE reservation.analysis_run_id = coordinator.analysis_run_id
      AND reservation.langflow_job_id = coordinator.langflow_job_id
      AND reservation.specialty = specialty_value
      AND reservation.task_id = task_id_value
      AND reservation.context_id = context_id_value
      AND reservation.attempt = p_attempt
      AND reservation.event_type = 'dispatched'
      AND reservation.details->>'coordinator_run_id' = coordinator.id::text
      AND reservation.details->>'task_id' = task_id_value
      AND reservation.details->>'context_id' = context_id_value
      AND reservation.details->>'specialty' = specialty_value
      AND (reservation.details->>'attempt') ~ '^[0-9]+$'
      AND (reservation.details->>'attempt')::integer = p_attempt
      AND ((p_parent_task_id IS NULL AND jsonb_typeof(reservation.details->'parent_task_id') = 'null')
           OR (p_parent_task_id IS NOT NULL AND reservation.details->>'parent_task_id' = p_parent_task_id))
      AND NULLIF(trim(reservation.details->>'operation_key'), '') IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'specialist contribution has no matching durable dispatch reservation' USING ERRCODE = '40001';
  END IF;
  IF jsonb_typeof(p_payload->'evidence_scope') <> 'object'
     OR jsonb_typeof(p_payload->'evidence_scope'->'permitted_document_ids') <> 'array'
     OR jsonb_typeof(p_payload->'evidence_scope'->'permitted_policy_version_ids') <> 'array'
     OR jsonb_typeof(p_payload->'evidence_scope'->'permitted_web_result_ids') <> 'array'
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements_text(p_payload->'evidence_scope'->'permitted_document_ids') submitted(id)
       WHERE NOT EXISTS (
         SELECT 1 FROM analysis_run_documents pinned
         WHERE pinned.analysis_run_id = coordinator.analysis_run_id
           AND pinned.document_id::text = submitted.id
       )
     )
     OR EXISTS (
       SELECT 1 FROM analysis_run_documents pinned
       WHERE pinned.analysis_run_id = coordinator.analysis_run_id
         AND NOT (p_payload->'evidence_scope'->'permitted_document_ids' ? pinned.document_id::text)
     )
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements_text(p_payload->'evidence_scope'->'permitted_policy_version_ids') submitted(id)
       WHERE NOT EXISTS (
         SELECT 1 FROM analysis_run_policy_versions pinned
         WHERE pinned.analysis_run_id = coordinator.analysis_run_id
           AND pinned.policy_version_id::text = submitted.id
       )
     )
     OR EXISTS (
       SELECT 1 FROM analysis_run_policy_versions pinned
       WHERE pinned.analysis_run_id = coordinator.analysis_run_id
         AND NOT (p_payload->'evidence_scope'->'permitted_policy_version_ids' ? pinned.policy_version_id::text)
     )
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements_text(p_payload->'evidence_scope'->'permitted_web_result_ids') submitted(id)
       WHERE NOT EXISTS (
         SELECT 1 FROM external_web_evidence evidence
         JOIN web_result_review_items review_item
           ON review_item.external_web_evidence_id = evidence.id
          AND review_item.review_state = 'accepted'
         WHERE evidence.analysis_run_id = coordinator.analysis_run_id
           AND evidence.id::text = submitted.id
       )
     )
     OR EXISTS (
       SELECT 1 FROM external_web_evidence evidence
       JOIN web_result_review_items review_item
         ON review_item.external_web_evidence_id = evidence.id
        AND review_item.review_state = 'accepted'
       WHERE evidence.analysis_run_id = coordinator.analysis_run_id
         AND NOT (p_payload->'evidence_scope'->'permitted_web_result_ids' ? evidence.id::text)
     ) THEN
    RAISE EXCEPTION 'specialist contribution evidence scope drifted from persisted scope' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO existing FROM coordinator_v3_contributions WHERE task_id = task_id_value;
  IF FOUND THEN
    IF existing.analysis_run_id = coordinator.analysis_run_id
       AND existing.payload_hash = payload_hash_value THEN
      RETURN jsonb_build_object('status', 'duplicate_suppressed', 'task_id', task_id_value);
    END IF;
    RAISE EXCEPTION 'specialist task replay conflicts with persisted contribution' USING ERRCODE = '23P01';
  END IF;

  INSERT INTO coordinator_v3_contributions(
    analysis_run_id, case_id, langflow_job_id, specialty, task_id, context_id,
    agent_name, agent_version, status, source_scope, citations, payload,
    payload_hash, started_at, completed_at, attempt
  ) VALUES (
    coordinator.analysis_run_id, coordinator.case_id, coordinator.langflow_job_id,
    specialty_value, task_id_value, context_id_value,
    COALESCE(p_payload->'specialist'->>'name', 'kyb-' || replace(specialty_value, '_', '-') || '-agent'),
    COALESCE(p_payload->'specialist'->>'version', '3.0.0'),
    CASE WHEN p_payload->>'status' IN ('completed', 'partial', 'failed')
         THEN p_payload->>'status' ELSE 'completed' END,
    COALESCE(p_payload->'evidence_scope', '{}'::jsonb),
    COALESCE(p_payload->'citations', '[]'::jsonb),
    p_payload, payload_hash_value, clock_timestamp(), clock_timestamp(), p_attempt
  );
  INSERT INTO coordinator_v3_task_events(
    analysis_run_id, langflow_job_id, specialty, task_id, context_id,
    attempt, event_type, details
  ) VALUES (
    coordinator.analysis_run_id, coordinator.langflow_job_id, specialty_value,
    task_id_value, context_id_value, p_attempt,
    CASE WHEN p_payload->>'status' = 'failed' THEN 'failed' ELSE 'validated' END,
    jsonb_build_object('parent_task_id', p_parent_task_id, 'payload_hash', payload_hash_value)
  ) ON CONFLICT DO NOTHING;

  completed := COALESCE(coordinator.state->'completed_specialists', '[]'::jsonb);
  IF p_payload->>'status' IN ('completed', 'partial') AND NOT completed ? specialty_value THEN
    completed := completed || jsonb_build_array(specialty_value);
  END IF;
  UPDATE coordinator_v3_runs
  SET state = state || jsonb_build_object(
        'completed_specialists', completed,
        'next_action', NULL,
        'next_action_idempotency_key', NULL,
        'updated_at', clock_timestamp()
      ),
      state_version = state_version + 1,
      updated_at = clock_timestamp()
  WHERE id = coordinator.id;
  RETURN jsonb_build_object('status', 'stored', 'task_id', task_id_value, 'payload_hash', payload_hash_value);
END;
$$;

COMMIT;
