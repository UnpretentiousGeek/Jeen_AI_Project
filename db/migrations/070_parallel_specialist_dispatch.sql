BEGIN;

-- Entity and Ownership are independent, so the coordinator may dispatch their first
-- attempts together as one 'dispatch_specialists' action. Each saved contribution
-- narrows the pending action; the last specialist left is an ordinary single dispatch.

CREATE OR REPLACE FUNCTION commit_simple_coordinator_v3_directive(
  p_run_id uuid,
  p_expected_state_version bigint,
  p_directive jsonb,
  p_directive_hash text
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  coordinator coordinator_v3_runs%ROWTYPE;
  prior coordinator_v3_iterations%ROWTYPE;
  action text;
  next_iteration integer;
  actual_hash text := encode(digest(COALESCE(p_directive, '{}'::jsonb)::text, 'sha256'), 'hex');
  state_hash text;
  iteration_id uuid;
BEGIN
  IF p_directive IS NULL
     OR jsonb_typeof(p_directive) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_directive->'schema_version') IS DISTINCT FROM 'string'
     OR p_directive->>'schema_version' <> '1.0'
     OR jsonb_typeof(p_directive->'analysis_run_id') IS DISTINCT FROM 'string'
     OR NOT COALESCE((p_directive->>'analysis_run_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$', false)
     OR jsonb_typeof(p_directive->'expected_state_version') IS DISTINCT FROM 'number'
     OR NOT COALESCE((p_directive->>'expected_state_version') ~ '^[0-9]+$', false)
     OR (CASE WHEN (p_directive->>'expected_state_version') ~ '^[0-9]+$'
              THEN (p_directive->>'expected_state_version')::numeric ELSE 0 END > 9223372036854775807)
     OR jsonb_typeof(p_directive->'iteration') IS DISTINCT FROM 'number'
     OR NOT COALESCE((p_directive->>'iteration') ~ '^[0-9]+$', false)
     OR (CASE WHEN (p_directive->>'iteration') ~ '^[0-9]+$'
              THEN (p_directive->>'iteration')::numeric ELSE 0 END > 2147483647)
     OR jsonb_typeof(p_directive->'plan') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_directive->'rationale_summary') IS DISTINCT FROM 'string'
     OR NULLIF(trim(p_directive->>'rationale_summary'), '') IS NULL
     OR jsonb_typeof(p_directive->'next_action') IS DISTINCT FROM 'string'
     OR p_directive->>'next_action' NOT IN (
       'dispatch_specialist', 'dispatch_specialists', 'request_checkpoint', 'save_final_findings',
       'propose_action', 'stop'
     )
     OR NULLIF(trim(p_directive_hash), '') IS NULL
     OR p_directive_hash <> actual_hash THEN
    RAISE EXCEPTION 'simple coordinator directive is invalid' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
       SELECT 1 FROM jsonb_object_keys(p_directive) field
       WHERE field <> ALL (ARRAY[
         'schema_version','analysis_run_id','expected_state_version','iteration','plan','next_action',
         'target_specialty','target_specialties','attempt','parent_task_id','checkpoint_kind','checkpoint_request_key',
         'checkpoint_title','checkpoint_explanation','allowed_actions','checkpoint_payload',
         'final_payload','proposed_action_type','proposed_action_summary','rationale_summary','terminal_reason'
       ])
     )
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_directive->'plan') item
       WHERE jsonb_typeof(item) IS DISTINCT FROM 'object'
          OR EXISTS (
            SELECT 1 FROM jsonb_object_keys(item) item_field
            WHERE item_field <> ALL (ARRAY['specialty','reason','task_objective','required'])
          )
          OR jsonb_typeof(item->'specialty') IS DISTINCT FROM 'string'
          OR item->>'specialty' NOT IN ('entity','ownership','policy','public_research')
          OR jsonb_typeof(item->'reason') IS DISTINCT FROM 'string'
          OR NULLIF(trim(item->>'reason'), '') IS NULL
          OR jsonb_typeof(item->'task_objective') IS DISTINCT FROM 'string'
          OR NULLIF(trim(item->>'task_objective'), '') IS NULL
          OR jsonb_typeof(item->'required') IS DISTINCT FROM 'boolean'
          OR EXISTS (
            SELECT 1 FROM jsonb_object_keys(item) item_field
            WHERE item_field <> ALL (ARRAY['specialty','reason','task_objective','required'])
          )
     ) THEN
    RAISE EXCEPTION 'simple coordinator directive structure is invalid' USING ERRCODE = '22023';
  END IF;
  action := p_directive->>'next_action';
  IF (action = 'dispatch_specialist' AND (
        jsonb_typeof(p_directive->'target_specialty') IS DISTINCT FROM 'string'
        OR p_directive->>'target_specialty' NOT IN ('entity','ownership','policy','public_research')
        OR jsonb_typeof(p_directive->'attempt') IS DISTINCT FROM 'number'
        OR NOT COALESCE((p_directive->>'attempt') ~ '^[0-9]+$', false)
        OR (CASE WHEN (p_directive->>'attempt') ~ '^[0-9]+$'
                THEN (p_directive->>'attempt')::integer ELSE 0 END) NOT BETWEEN 1 AND 3
        OR NOT (p_directive ? 'parent_task_id')
        OR jsonb_typeof(p_directive->'parent_task_id') NOT IN ('string', 'null')
        OR (jsonb_typeof(p_directive->'parent_task_id') = 'string'
            AND NULLIF(trim(p_directive->>'parent_task_id'), '') IS NULL)
        OR ((CASE WHEN (p_directive->>'attempt') ~ '^[0-9]+$'
                  THEN (p_directive->>'attempt')::integer ELSE 0 END) = 1
            AND jsonb_typeof(p_directive->'parent_task_id') IS DISTINCT FROM 'null')
        OR ((CASE WHEN (p_directive->>'attempt') ~ '^[0-9]+$'
                  THEN (p_directive->>'attempt')::integer ELSE 0 END) > 1
            AND jsonb_typeof(p_directive->'parent_task_id') IS DISTINCT FROM 'string')
        OR NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(p_directive->'plan') item
          WHERE item->>'specialty' = p_directive->>'target_specialty'
        )
        OR p_directive ?| ARRAY['target_specialties','checkpoint_kind','checkpoint_request_key','checkpoint_title',
                                'checkpoint_explanation','allowed_actions','checkpoint_payload',
                                'final_payload','proposed_action_type','proposed_action_summary','terminal_reason']
      ))
     -- Entity and Ownership first attempts may run together; retries stay single.
     OR (action = 'dispatch_specialists' AND (
        jsonb_typeof(p_directive->'target_specialties') IS DISTINCT FROM 'array'
        OR jsonb_array_length(p_directive->'target_specialties') < 2
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(p_directive->'target_specialties') target
          WHERE jsonb_typeof(target) IS DISTINCT FROM 'string'
             OR target #>> '{}' NOT IN ('entity','ownership')
             OR NOT EXISTS (
               SELECT 1 FROM jsonb_array_elements(p_directive->'plan') item
               WHERE item->>'specialty' = target #>> '{}'
             )
        )
        OR (SELECT count(DISTINCT target) FROM jsonb_array_elements_text(p_directive->'target_specialties') target)
           <> jsonb_array_length(p_directive->'target_specialties')
        OR p_directive->'attempt' IS DISTINCT FROM '1'::jsonb
        OR p_directive->'parent_task_id' IS DISTINCT FROM 'null'::jsonb
        OR p_directive ?| ARRAY['target_specialty','checkpoint_kind','checkpoint_request_key','checkpoint_title',
                                'checkpoint_explanation','allowed_actions','checkpoint_payload',
                                'final_payload','proposed_action_type','proposed_action_summary','terminal_reason']
      ))
     OR (action = 'request_checkpoint' AND (
        jsonb_typeof(p_directive->'checkpoint_kind') IS DISTINCT FROM 'string'
        OR p_directive->>'checkpoint_kind' NOT IN ('information_request','conflict_review','specialist_recovery',
          'search_execution_approval','web_result_review','analyst_approval')
        OR jsonb_typeof(p_directive->'checkpoint_request_key') IS DISTINCT FROM 'string'
        OR NULLIF(trim(p_directive->>'checkpoint_request_key'), '') IS NULL
        OR jsonb_typeof(p_directive->'checkpoint_title') IS DISTINCT FROM 'string'
        OR NULLIF(trim(p_directive->>'checkpoint_title'), '') IS NULL
        OR jsonb_typeof(p_directive->'checkpoint_explanation') IS DISTINCT FROM 'string'
        OR NULLIF(trim(p_directive->>'checkpoint_explanation'), '') IS NULL
        OR jsonb_typeof(p_directive->'allowed_actions') IS DISTINCT FROM 'array'
        OR jsonb_array_length(p_directive->'allowed_actions') = 0
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(p_directive->'allowed_actions') allowed_action
          WHERE jsonb_typeof(allowed_action) IS DISTINCT FROM 'string'
             OR NULLIF(trim(allowed_action #>> '{}'), '') IS NULL
        )
        OR p_directive->'allowed_actions' <> CASE p_directive->>'checkpoint_kind'
          WHEN 'information_request' THEN '["submit_clarification","reject","skip_for_now"]'::jsonb
          WHEN 'conflict_review' THEN '["escalate","reject","skip_for_now"]'::jsonb
          WHEN 'specialist_recovery' THEN '["retry","abort","skip_for_now"]'::jsonb
          WHEN 'search_execution_approval' THEN '["approve","changes_requested","reject","skip_for_now"]'::jsonb
          WHEN 'web_result_review' THEN '["accept","reject","skip_for_now"]'::jsonb
          WHEN 'analyst_approval' THEN '["approve","changes_requested","reject","skip_for_now"]'::jsonb
          ELSE '[]'::jsonb END
        OR jsonb_typeof(p_directive->'checkpoint_payload') IS DISTINCT FROM 'object'
        OR p_directive->'checkpoint_payload' = '{}'::jsonb
        OR NOT (p_directive ? 'checkpoint_payload')
        OR p_directive ?| ARRAY['target_specialty','target_specialties','attempt','parent_task_id','final_payload',
                                'proposed_action_type','proposed_action_summary','terminal_reason']
      ))
     OR (action = 'save_final_findings' AND (
        jsonb_typeof(p_directive->'final_payload') IS DISTINCT FROM 'object'
        OR NOT (p_directive ? 'final_payload')
        OR EXISTS (
          SELECT 1 FROM jsonb_object_keys(p_directive->'final_payload') field
          WHERE field <> ALL (ARRAY['findings','evidence_gaps','conflicts'])
        )
        OR jsonb_typeof(p_directive->'final_payload'->'findings') IS DISTINCT FROM 'array'
        OR jsonb_array_length(p_directive->'final_payload'->'findings') = 0
        OR jsonb_typeof(p_directive->'final_payload'->'evidence_gaps') IS DISTINCT FROM 'array'
        OR jsonb_typeof(p_directive->'final_payload'->'conflicts') IS DISTINCT FROM 'array'
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements(p_directive->'final_payload'->'findings') finding
          WHERE jsonb_typeof(finding) IS DISTINCT FROM 'object'
             OR EXISTS (
               SELECT 1 FROM jsonb_object_keys(finding) field
               WHERE field <> ALL (ARRAY['requirement_code','outcome','summary','rationale','confidence','citations'])
             )
             OR jsonb_typeof(finding->'requirement_code') IS DISTINCT FROM 'string'
             OR NULLIF(trim(finding->>'requirement_code'), '') IS NULL
             OR jsonb_typeof(finding->'outcome') IS DISTINCT FROM 'string'
             OR finding->>'outcome' NOT IN ('met','not_met','uncertain')
             OR jsonb_typeof(finding->'summary') IS DISTINCT FROM 'string'
             OR NULLIF(trim(finding->>'summary'), '') IS NULL
             OR jsonb_typeof(finding->'rationale') IS DISTINCT FROM 'string'
             OR NULLIF(trim(finding->>'rationale'), '') IS NULL
             OR (finding ? 'confidence' AND jsonb_typeof(finding->'confidence') NOT IN ('number','null'))
             OR (finding ? 'confidence' AND jsonb_typeof(finding->'confidence') = 'number'
                 AND (finding->>'confidence')::numeric NOT BETWEEN 0 AND 1)
             OR jsonb_typeof(finding->'citations') IS DISTINCT FROM 'array'
             OR jsonb_array_length(finding->'citations') = 0
             OR EXISTS (
               SELECT 1
               FROM jsonb_array_elements(finding->'citations') citation
               WHERE jsonb_typeof(citation) IS DISTINCT FROM 'object'
                  OR jsonb_typeof(citation->'source_kind') IS DISTINCT FROM 'string'
                  OR citation->>'source_kind' NOT IN ('case_document','policy','human_input','external_web')
                  OR (citation->>'source_kind' = 'case_document' AND (
                    EXISTS (SELECT 1 FROM jsonb_object_keys(citation) field WHERE field <> ALL (ARRAY['source_kind','document_chunk_id','locator','excerpt']))
                    OR jsonb_typeof(citation->'document_chunk_id') IS DISTINCT FROM 'string'
                    OR NOT COALESCE((citation->>'document_chunk_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$', false)
                    OR jsonb_typeof(citation->'locator') IS DISTINCT FROM 'string' OR NULLIF(trim(citation->>'locator'), '') IS NULL
                    OR jsonb_typeof(citation->'excerpt') IS DISTINCT FROM 'string' OR NULLIF(trim(citation->>'excerpt'), '') IS NULL
                  ))
                  OR (citation->>'source_kind' = 'policy' AND (
                    EXISTS (SELECT 1 FROM jsonb_object_keys(citation) field WHERE field <> ALL (ARRAY['source_kind','policy_chunk_id','locator','excerpt']))
                    OR jsonb_typeof(citation->'policy_chunk_id') IS DISTINCT FROM 'string'
                    OR NOT COALESCE((citation->>'policy_chunk_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$', false)
                    OR jsonb_typeof(citation->'locator') IS DISTINCT FROM 'string' OR NULLIF(trim(citation->>'locator'), '') IS NULL
                    OR jsonb_typeof(citation->'excerpt') IS DISTINCT FROM 'string' OR NULLIF(trim(citation->>'excerpt'), '') IS NULL
                  ))
                  OR (citation->>'source_kind' = 'human_input' AND (
                    EXISTS (SELECT 1 FROM jsonb_object_keys(citation) field WHERE field <> ALL (ARRAY['source_kind','human_input_request_id','locator','excerpt']))
                    OR jsonb_typeof(citation->'human_input_request_id') IS DISTINCT FROM 'string'
                    OR NOT COALESCE((citation->>'human_input_request_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$', false)
                    OR jsonb_typeof(citation->'locator') IS DISTINCT FROM 'string' OR NULLIF(trim(citation->>'locator'), '') IS NULL
                    OR jsonb_typeof(citation->'excerpt') IS DISTINCT FROM 'string' OR NULLIF(trim(citation->>'excerpt'), '') IS NULL
                  ))
                  OR (citation->>'source_kind' = 'external_web' AND (
                    EXISTS (SELECT 1 FROM jsonb_object_keys(citation) field WHERE field <> ALL (ARRAY['source_kind','external_web_evidence_id','agent_task_id','agent_artifact_id','locator','excerpt']))
                    OR jsonb_typeof(citation->'external_web_evidence_id') IS DISTINCT FROM 'string'
                    OR NOT COALESCE((citation->>'external_web_evidence_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$', false)
                    OR jsonb_typeof(citation->'agent_task_id') IS DISTINCT FROM 'string' OR NULLIF(trim(citation->>'agent_task_id'), '') IS NULL
                    OR jsonb_typeof(citation->'agent_artifact_id') IS DISTINCT FROM 'string' OR NULLIF(trim(citation->>'agent_artifact_id'), '') IS NULL
                    OR jsonb_typeof(citation->'locator') IS DISTINCT FROM 'string' OR NULLIF(trim(citation->>'locator'), '') IS NULL
                    OR jsonb_typeof(citation->'excerpt') IS DISTINCT FROM 'string' OR NULLIF(trim(citation->>'excerpt'), '') IS NULL
                  ))
             )
        )
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements(p_directive->'final_payload'->'evidence_gaps') gap
          WHERE jsonb_typeof(gap) IS DISTINCT FROM 'object'
             OR EXISTS (SELECT 1 FROM jsonb_object_keys(gap) field WHERE field <> ALL (ARRAY['requirement_code','description','requested_evidence']))
             OR jsonb_typeof(gap->'requirement_code') IS DISTINCT FROM 'string' OR NULLIF(trim(gap->>'requirement_code'), '') IS NULL
             OR jsonb_typeof(gap->'description') IS DISTINCT FROM 'string' OR NULLIF(trim(gap->>'description'), '') IS NULL
             OR jsonb_typeof(gap->'requested_evidence') IS DISTINCT FROM 'string' OR NULLIF(trim(gap->>'requested_evidence'), '') IS NULL
        )
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements(p_directive->'final_payload'->'conflicts') conflict
          WHERE jsonb_typeof(conflict) IS DISTINCT FROM 'object'
             OR EXISTS (SELECT 1 FROM jsonb_object_keys(conflict) field WHERE field <> ALL (ARRAY['subject','description']))
             OR jsonb_typeof(conflict->'subject') IS DISTINCT FROM 'string' OR NULLIF(trim(conflict->>'subject'), '') IS NULL
             OR jsonb_typeof(conflict->'description') IS DISTINCT FROM 'string' OR NULLIF(trim(conflict->>'description'), '') IS NULL
        )
        OR p_directive ?| ARRAY['target_specialty','target_specialties','attempt','parent_task_id','checkpoint_kind',
                                'checkpoint_request_key','checkpoint_title','checkpoint_explanation',
                                'allowed_actions','checkpoint_payload','proposed_action_type',
                                'proposed_action_summary','terminal_reason']
      ))
     OR (action = 'propose_action' AND (
        jsonb_typeof(p_directive->'proposed_action_type') IS DISTINCT FROM 'string'
        OR p_directive->>'proposed_action_type' <> 'mark_ready_for_review'
        OR jsonb_typeof(p_directive->'proposed_action_summary') IS DISTINCT FROM 'string'
        OR NULLIF(trim(p_directive->>'proposed_action_summary'), '') IS NULL
        OR p_directive ?| ARRAY['target_specialty','target_specialties','attempt','parent_task_id','checkpoint_kind',
                                'checkpoint_request_key','checkpoint_title','checkpoint_explanation',
                                'allowed_actions','checkpoint_payload','final_payload','terminal_reason']
      ))
     OR (action = 'stop' AND (
        jsonb_typeof(p_directive->'terminal_reason') IS DISTINCT FROM 'string'
        OR NULLIF(trim(p_directive->>'terminal_reason'), '') IS NULL
        OR p_directive ?| ARRAY['target_specialty','target_specialties','attempt','parent_task_id','checkpoint_kind',
                                'checkpoint_request_key','checkpoint_title','checkpoint_explanation',
                                'allowed_actions','checkpoint_payload','final_payload',
                                'proposed_action_type','proposed_action_summary']
      )) THEN
    RAISE EXCEPTION 'simple coordinator directive violates action semantics' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO coordinator
  FROM coordinator_v3_runs
  WHERE id = p_run_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'simple coordinator run does not exist' USING ERRCODE = '23503';
  END IF;
  IF (p_directive->>'expected_state_version')::bigint <> p_expected_state_version THEN
    RAISE EXCEPTION 'directive expected_state_version does not match the function argument' USING ERRCODE = '40001';
  END IF;

  SELECT * INTO prior
  FROM coordinator_v3_iterations
  WHERE run_id = p_run_id
    AND directive_hash = p_directive_hash;
  IF FOUND THEN
    IF prior.directive = p_directive THEN
      RETURN jsonb_build_object(
        'status', 'duplicate_suppressed',
        'iteration_no', prior.iteration_no,
        'state_version', coordinator.state_version
      );
    END IF;
    RAISE EXCEPTION 'directive replay conflicts with persisted iteration' USING ERRCODE = '23P01';
  END IF;

  IF coordinator.phase <> 'running'
     OR coordinator.state_version <> p_expected_state_version
     OR (p_directive->>'expected_state_version')::bigint <> p_expected_state_version
     OR coordinator.state->>'next_action' IS NOT NULL THEN
    RAISE EXCEPTION 'simple coordinator directive is stale or another action is pending' USING ERRCODE = '40001';
  END IF;
  next_iteration := coordinator.current_iteration + 1;
  IF next_iteration > coordinator.max_iterations
     OR (p_directive->>'iteration')::integer <> next_iteration
     OR p_directive->>'analysis_run_id' <> coordinator.analysis_run_id::text THEN
    RAISE EXCEPTION 'simple coordinator iteration is invalid or exhausted' USING ERRCODE = '54000';
  END IF;

  state_hash := encode(digest(coordinator.state::text, 'sha256'), 'hex');
  INSERT INTO coordinator_v3_iterations(
    run_id, iteration_no, state_hash, supervisor_output,
    directive, directive_hash, outcome
  ) VALUES (
    coordinator.id, next_iteration, state_hash, p_directive,
    p_directive, p_directive_hash, 'pending_operation'
  ) RETURNING id INTO iteration_id;

  UPDATE coordinator_v3_runs
  SET current_iteration = next_iteration,
      state_version = state_version + 1,
      state = state || jsonb_build_object(
        'iteration', next_iteration,
        'next_action', p_directive,
        'updated_at', clock_timestamp()
      ),
      updated_at = clock_timestamp()
  WHERE id = coordinator.id;

  RETURN jsonb_build_object(
    'status', 'committed',
    'iteration_id', iteration_id,
    'iteration_no', next_iteration,
    'state_version', coordinator.state_version + 1
  );
END;
$$;


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
  remaining jsonb;
  next_action_value jsonb;
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
       OR (persisted_action->>'next_action' = 'dispatch_specialists'
           AND persisted_action->'target_specialties' ? specialty_value)
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
  -- A parallel dispatch narrows to the specialists still running. Once one is left it
  -- becomes an ordinary single dispatch, so its save, recovery, and failure paths are unchanged.
  next_action_value := NULL;
  IF persisted_action->>'next_action' = 'dispatch_specialists' THEN
    SELECT COALESCE(jsonb_agg(target), '[]'::jsonb) INTO remaining
    FROM jsonb_array_elements_text(persisted_action->'target_specialties') target
    WHERE NOT EXISTS (
      SELECT 1 FROM coordinator_v3_contributions saved
      WHERE saved.analysis_run_id = coordinator.analysis_run_id
        AND saved.langflow_job_id = coordinator.langflow_job_id
        AND saved.specialty = target
        AND saved.attempt = 1
    );
    IF jsonb_array_length(remaining) = 1 THEN
      next_action_value := (persisted_action - 'target_specialties')
        || jsonb_build_object('next_action', 'dispatch_specialist', 'target_specialty', remaining->>0);
    ELSIF jsonb_array_length(remaining) > 1 THEN
      next_action_value := persisted_action || jsonb_build_object('target_specialties', remaining);
    END IF;
  END IF;
  UPDATE coordinator_v3_runs
  SET state = state || jsonb_build_object(
        'completed_specialists', completed,
        'next_action', next_action_value,
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
