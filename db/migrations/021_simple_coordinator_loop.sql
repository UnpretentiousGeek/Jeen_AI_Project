BEGIN;

-- Context-only extension point for the future case assistant. Coordinator
-- execution and replay decisions never depend on these rows.
CREATE TABLE IF NOT EXISTS coordinator_v3_chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_run_id uuid NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  message_key text NOT NULL,
  role text NOT NULL CHECK (role IN ('human', 'ai', 'system')),
  content text NOT NULL CHECK (length(trim(content)) > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (analysis_run_id, message_key)
);

CREATE INDEX IF NOT EXISTS coordinator_v3_chat_messages_run_created_idx
  ON coordinator_v3_chat_messages (analysis_run_id, created_at, id);

CREATE TABLE IF NOT EXISTS coordinator_v3_checkpoint_skips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES coordinator_v3_runs(id) ON DELETE CASCADE,
  request_id text NOT NULL,
  actor_id text NOT NULL,
  values jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text NOT NULL,
  skipped_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (run_id, idempotency_key)
);

-- A small, database-owned logical loop. Langflow invocation/job ids are
-- observations only; analysis_run_id is the resume key.
CREATE OR REPLACE FUNCTION start_or_resume_simple_coordinator_v3(
  p_analysis_run_id uuid,
  p_case_id uuid,
  p_session_id text,
  p_flow_id text,
  p_invocation_job_id text,
  p_task_objective text,
  p_max_iterations integer DEFAULT 8
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  analysis analysis_runs%ROWTYPE;
  coordinator coordinator_v3_runs%ROWTYPE;
  next_state jsonb;
  logical_job_id text := 'simple-coordinator:' || p_analysis_run_id::text;
  logical_session_id text := p_session_id || ':simple-coordinator:' || p_analysis_run_id::text;
BEGIN
  IF NULLIF(trim(p_session_id), '') IS NULL
     OR NULLIF(trim(p_flow_id), '') IS NULL
     OR NULLIF(trim(p_invocation_job_id), '') IS NULL
     OR NULLIF(trim(p_task_objective), '') IS NULL
     OR p_max_iterations NOT BETWEEN 1 AND 12 THEN
    RAISE EXCEPTION 'simple coordinator start parameters are invalid' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO analysis
  FROM analysis_runs
  WHERE id = p_analysis_run_id
    AND case_id = p_case_id
    AND session_id = p_session_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'analysis run does not match the case and session' USING ERRCODE = '42501';
  END IF;
  IF analysis.status NOT IN ('queued', 'running', 'suspended', 'succeeded', 'failed') THEN
    RAISE EXCEPTION 'analysis run is not resumable' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM onboarding_cases onboarding_case
    WHERE onboarding_case.id = p_case_id
      AND onboarding_case.active_analysis_run_id = p_analysis_run_id
  ) THEN
    RAISE EXCEPTION 'analysis run is not active for the onboarding case' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO coordinator
  FROM coordinator_v3_runs
  WHERE analysis_run_id = p_analysis_run_id
    AND engine_version = 'durable-loop-v1'
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    IF coordinator.case_id <> p_case_id THEN
      RAISE EXCEPTION 'persisted coordinator belongs to another case' USING ERRCODE = '42501';
    END IF;
    IF coordinator.phase = 'waiting_for_human' THEN
      IF analysis.status <> 'suspended'
         OR coordinator.state->>'status' <> 'waiting_for_human'
         OR jsonb_typeof(coordinator.state->'pending_checkpoint') IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'waiting coordinator has inconsistent persisted status' USING ERRCODE = '55000';
      END IF;
      -- A poll while waiting is a read.  It must not advance the optimistic
      -- version or overwrite the suspended analysis/case status.
    ELSIF coordinator.phase IN ('ready_for_review', 'stopped', 'finalized') THEN
      -- Terminal runs are safely readable and never resumed or rewritten.
      NULL;
    ELSIF coordinator.phase = 'running' THEN
      IF analysis.status IN ('succeeded', 'failed')
         OR coordinator.state->>'status' <> 'running' THEN
        RAISE EXCEPTION 'running coordinator has terminal analysis status' USING ERRCODE = '55000';
      END IF;
      next_state := coordinator.state || jsonb_build_object(
        'last_invocation_job_id', p_invocation_job_id,
        'flow_id', p_flow_id,
        'updated_at', clock_timestamp()
      );
      UPDATE coordinator_v3_runs
      SET state = next_state,
          state_version = state_version + 1,
          updated_at = clock_timestamp()
      WHERE id = coordinator.id
      RETURNING * INTO coordinator;
    ELSE
      RAISE EXCEPTION 'simple coordinator run is not resumable' USING ERRCODE = '55000';
    END IF;
  ELSE
    IF analysis.status IN ('succeeded', 'failed') THEN
      RAISE EXCEPTION 'terminal analysis run has no persisted coordinator to resume' USING ERRCODE = '55000';
    END IF;
    next_state := jsonb_build_object(
      'schema_version', '2.0',
      'analysis_run_id', p_analysis_run_id,
      'case_id', p_case_id,
      'status', 'running',
      'iteration', 0,
      'completed_specialists', '[]'::jsonb,
      'pending_checkpoint', NULL,
      'accepted_evidence_ids', '[]'::jsonb,
      'latest_findings', '[]'::jsonb,
      'next_action', NULL,
      'task_objective', p_task_objective,
      'flow_id', p_flow_id,
      'last_invocation_job_id', p_invocation_job_id,
      'updated_at', clock_timestamp()
    );
    INSERT INTO coordinator_v3_runs(
      analysis_run_id, case_id, langflow_job_id, session_id, scenario, state,
      engine_version, state_version, phase, current_iteration, max_iterations
    ) VALUES (
      p_analysis_run_id, p_case_id, logical_job_id, logical_session_id, 'supervisor', next_state,
      'durable-loop-v1', 0, 'running', 0, p_max_iterations
    ) RETURNING * INTO coordinator;
  END IF;

  IF coordinator.phase = 'running' THEN
    UPDATE analysis_runs
    SET status = CASE
          WHEN status IN ('queued', 'suspended') THEN 'running'
          ELSE status
        END,
        started_at = COALESCE(started_at, clock_timestamp())
    WHERE id = p_analysis_run_id;
    UPDATE onboarding_cases
    SET status = CASE WHEN status IN ('draft', 'awaiting_information', 'awaiting_approval') THEN 'processing' ELSE status END,
        updated_at = clock_timestamp()
    WHERE id = p_case_id;
  END IF;

  RETURN jsonb_build_object(
    'coordinator_run_id', coordinator.id,
    'analysis_run_id', coordinator.analysis_run_id,
    'case_id', coordinator.case_id,
    'state_version', coordinator.state_version,
    'iteration', coordinator.current_iteration,
    'max_iterations', coordinator.max_iterations,
    'phase', coordinator.phase,
    'state', coordinator.state
  );
END;
$$;

-- Persist the Supervisor's one semantic choice before executing it.  This is
-- the crash/replay boundary: a later workflow invocation sees next_action and
-- finishes that exact operation instead of asking the model again.
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
       'dispatch_specialist', 'request_checkpoint', 'save_final_findings',
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
         'target_specialty','attempt','parent_task_id','checkpoint_kind','checkpoint_request_key',
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
        OR p_directive ?| ARRAY['checkpoint_kind','checkpoint_request_key','checkpoint_title',
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
        OR p_directive ?| ARRAY['target_specialty','attempt','parent_task_id','final_payload',
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
        OR p_directive ?| ARRAY['target_specialty','attempt','parent_task_id','checkpoint_kind',
                                'checkpoint_request_key','checkpoint_title','checkpoint_explanation',
                                'allowed_actions','checkpoint_payload','proposed_action_type',
                                'proposed_action_summary','terminal_reason']
      ))
     OR (action = 'propose_action' AND (
        jsonb_typeof(p_directive->'proposed_action_type') IS DISTINCT FROM 'string'
        OR p_directive->>'proposed_action_type' <> 'mark_ready_for_review'
        OR jsonb_typeof(p_directive->'proposed_action_summary') IS DISTINCT FROM 'string'
        OR NULLIF(trim(p_directive->>'proposed_action_summary'), '') IS NULL
        OR p_directive ?| ARRAY['target_specialty','attempt','parent_task_id','checkpoint_kind',
                                'checkpoint_request_key','checkpoint_title','checkpoint_explanation',
                                'allowed_actions','checkpoint_payload','final_payload','terminal_reason']
      ))
     OR (action = 'stop' AND (
        jsonb_typeof(p_directive->'terminal_reason') IS DISTINCT FROM 'string'
        OR NULLIF(trim(p_directive->>'terminal_reason'), '') IS NULL
        OR p_directive ?| ARRAY['target_specialty','attempt','parent_task_id','checkpoint_kind',
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

CREATE OR REPLACE FUNCTION save_simple_coordinator_v3_findings(
  p_run_id uuid,
  p_payload jsonb,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  coordinator coordinator_v3_runs%ROWTYPE;
  payload_hash text := encode(digest(COALESCE(p_payload, '{}'::jsonb)::text, 'sha256'), 'hex');
  item jsonb;
  citation jsonb;
  finding_ids jsonb := '[]'::jsonb;
BEGIN
  IF jsonb_typeof(p_payload) <> 'object'
     OR jsonb_typeof(p_payload->'findings') <> 'array'
     OR jsonb_typeof(p_payload->'evidence_gaps') <> 'array'
     OR jsonb_typeof(p_payload->'conflicts') <> 'array'
     OR NULLIF(trim(p_idempotency_key), '') IS NULL THEN
    RAISE EXCEPTION 'final findings payload is invalid' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO coordinator FROM coordinator_v3_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND OR coordinator.phase NOT IN ('running', 'ready_for_review') THEN
    RAISE EXCEPTION 'coordinator run cannot accept final findings' USING ERRCODE = '55000';
  END IF;
  IF coordinator.state->>'final_findings_idempotency_key' IS NOT NULL THEN
    IF coordinator.state->>'final_findings_idempotency_key' = p_idempotency_key
       AND coordinator.state->>'final_findings_payload_hash' = payload_hash THEN
      RETURN jsonb_build_object('status', 'duplicate_suppressed', 'payload_hash', payload_hash);
    END IF;
    RAISE EXCEPTION 'final findings replay conflicts with persisted output' USING ERRCODE = '23P01';
  END IF;

  FOR item IN SELECT value FROM jsonb_array_elements(p_payload->'findings') LOOP
    IF NULLIF(item->>'id', '') IS NULL
       OR NULLIF(trim(item->>'requirement_code'), '') IS NULL
       OR item->>'outcome' NOT IN ('met', 'not_met', 'uncertain')
       OR NULLIF(trim(item->>'summary'), '') IS NULL
       OR NULLIF(trim(item->>'rationale'), '') IS NULL
       OR jsonb_typeof(item->'citations') <> 'array'
       OR jsonb_array_length(item->'citations') = 0 THEN
      RAISE EXCEPTION 'each final finding requires identity, assessment, and citations' USING ERRCODE = '22023';
    END IF;
    INSERT INTO findings(id, analysis_run_id, requirement_code, outcome, summary, rationale, confidence)
    VALUES (
      (item->>'id')::uuid, coordinator.analysis_run_id, item->>'requirement_code', item->>'outcome',
      item->>'summary', item->>'rationale', NULLIF(item->>'confidence', '')::numeric
    );
    finding_ids := finding_ids || jsonb_build_array(item->>'id');

    FOR citation IN SELECT value FROM jsonb_array_elements(item->'citations') LOOP
      IF citation->>'source_kind' = 'case_document' THEN
        IF NOT EXISTS (
          SELECT 1
          FROM analysis_run_documents snapshot
          JOIN document_chunks chunk ON chunk.document_id = snapshot.document_id
          WHERE snapshot.analysis_run_id = coordinator.analysis_run_id
            AND chunk.id = (citation->>'document_chunk_id')::uuid
        ) THEN
          RAISE EXCEPTION 'citation references case evidence outside the analysis run' USING ERRCODE = '42501';
        END IF;
        INSERT INTO citations(
          id, analysis_run_id, finding_id, source_kind, document_chunk_id, locator, excerpt
        ) VALUES (
          (citation->>'id')::uuid, coordinator.analysis_run_id, (item->>'id')::uuid,
          'case_document', (citation->>'document_chunk_id')::uuid,
          citation->>'locator', citation->>'excerpt'
        );
      ELSIF citation->>'source_kind' = 'policy' THEN
        IF NOT EXISTS (
          SELECT 1
          FROM analysis_run_policy_versions snapshot
          JOIN policy_chunks chunk ON chunk.policy_version_id = snapshot.policy_version_id
          WHERE snapshot.analysis_run_id = coordinator.analysis_run_id
            AND chunk.id = (citation->>'policy_chunk_id')::uuid
        ) THEN
          RAISE EXCEPTION 'citation references policy evidence outside the analysis run' USING ERRCODE = '42501';
        END IF;
        INSERT INTO citations(
          id, analysis_run_id, finding_id, source_kind, policy_chunk_id, locator, excerpt
        ) VALUES (
          (citation->>'id')::uuid, coordinator.analysis_run_id, (item->>'id')::uuid,
          'policy', (citation->>'policy_chunk_id')::uuid,
          citation->>'locator', citation->>'excerpt'
        );
      ELSIF citation->>'source_kind' = 'human_input' THEN
        IF NOT EXISTS (
          SELECT 1
          FROM human_input_requests request
          WHERE request.id = (citation->>'human_input_request_id')::uuid
            AND request.analysis_run_id = coordinator.analysis_run_id
            AND request.status = 'answered'
        ) THEN
          RAISE EXCEPTION 'citation references unavailable human input' USING ERRCODE = '42501';
        END IF;
        INSERT INTO citations(
          id, analysis_run_id, finding_id, source_kind, human_input_request_id, locator, excerpt
        ) VALUES (
          (citation->>'id')::uuid, coordinator.analysis_run_id, (item->>'id')::uuid,
          'human_input', (citation->>'human_input_request_id')::uuid,
          citation->>'locator', citation->>'excerpt'
        );
      ELSIF citation->>'source_kind' = 'external_web' THEN
        IF NOT EXISTS (
          SELECT 1
          FROM external_web_evidence evidence
          JOIN web_result_review_items review_item
            ON review_item.external_web_evidence_id = evidence.id
           AND review_item.review_state = 'accepted'
          JOIN specialist_artifacts artifact
            ON artifact.task_id = citation->>'agent_task_id'
           AND artifact.artifact_id = citation->>'agent_artifact_id'
           AND artifact.analysis_run_id = coordinator.analysis_run_id
           AND artifact.specialty = 'public_research'
          WHERE evidence.id = (citation->>'external_web_evidence_id')::uuid
            AND evidence.analysis_run_id = coordinator.analysis_run_id
            AND evidence.case_id = coordinator.case_id
        ) THEN
          RAISE EXCEPTION 'citation references unaccepted or unscoped web evidence' USING ERRCODE = '42501';
        END IF;
        INSERT INTO citations(
          id, analysis_run_id, finding_id, source_kind, external_web_evidence_id,
          agent_task_id, agent_artifact_id, locator, excerpt
        ) VALUES (
          (citation->>'id')::uuid, coordinator.analysis_run_id, (item->>'id')::uuid,
          'external_web', (citation->>'external_web_evidence_id')::uuid,
          citation->>'agent_task_id', citation->>'agent_artifact_id',
          citation->>'locator', citation->>'excerpt'
        );
      ELSE
        RAISE EXCEPTION 'unsupported final citation source_kind' USING ERRCODE = '22023';
      END IF;
    END LOOP;
  END LOOP;

  FOR item IN SELECT value FROM jsonb_array_elements(p_payload->'evidence_gaps') LOOP
    INSERT INTO evidence_gaps(id, analysis_run_id, requirement_code, description, requested_evidence)
    VALUES ((item->>'id')::uuid, coordinator.analysis_run_id, item->>'requirement_code',
            item->>'description', item->>'requested_evidence');
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(p_payload->'conflicts') LOOP
    INSERT INTO conflicts(id, analysis_run_id, subject, description)
    VALUES ((item->>'id')::uuid, coordinator.analysis_run_id, item->>'subject', item->>'description');
  END LOOP;

  UPDATE coordinator_v3_runs
  SET state = state || jsonb_build_object(
        'latest_findings', finding_ids,
        'final_findings_idempotency_key', p_idempotency_key,
        'final_findings_payload_hash', payload_hash,
        'next_action', NULL,
        'next_action_idempotency_key', NULL,
        'updated_at', clock_timestamp()
      ),
      state_version = state_version + 1,
      updated_at = clock_timestamp()
  WHERE id = coordinator.id;
  RETURN jsonb_build_object('status', 'stored', 'payload_hash', payload_hash, 'finding_ids', finding_ids);
END;
$$;

CREATE OR REPLACE FUNCTION stop_simple_coordinator_v3(
  p_run_id uuid,
  p_reason text,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  coordinator coordinator_v3_runs%ROWTYPE;
BEGIN
  IF NULLIF(trim(p_reason), '') IS NULL OR NULLIF(trim(p_idempotency_key), '') IS NULL THEN
    RAISE EXCEPTION 'stop reason and idempotency key are required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO coordinator FROM coordinator_v3_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'simple coordinator run does not exist' USING ERRCODE = '23503';
  END IF;
  IF coordinator.state->>'stop_idempotency_key' IS NOT NULL THEN
    IF coordinator.state->>'stop_idempotency_key' = p_idempotency_key
       AND coordinator.stop_reason = p_reason THEN
      RETURN jsonb_build_object('status', 'duplicate_suppressed', 'phase', coordinator.phase);
    END IF;
    RAISE EXCEPTION 'stop replay conflicts with persisted stop' USING ERRCODE = '23P01';
  END IF;
  UPDATE coordinator_v3_runs
  SET phase = 'stopped', stop_reason = p_reason,
      state_version = state_version + 1,
      state = state || jsonb_build_object(
        'status', 'stopped', 'next_action', NULL,
        'next_action_idempotency_key', NULL,
        'stop_idempotency_key', p_idempotency_key,
        'updated_at', clock_timestamp()
      ),
      updated_at = clock_timestamp()
  WHERE id = p_run_id;
  UPDATE analysis_runs SET status = 'failed', finished_at = COALESCE(finished_at, clock_timestamp())
  WHERE id = coordinator.analysis_run_id;
  RETURN jsonb_build_object('status', 'stopped', 'reason', p_reason);
END;
$$;

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
  IF p_next_action->>'route' NOT IN ('retry_specialist', 'execute_search', 'execute_action') THEN
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
     OR persisted_action->>'next_action' <> 'dispatch_specialist'
     OR persisted_action->>'target_specialty' IS DISTINCT FROM specialty_value
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

CREATE OR REPLACE FUNCTION create_simple_coordinator_v3_checkpoint(
  p_run_id uuid,
  p_request jsonb,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
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
     OR (kind = 'conflict_review' AND p_request->'allowed_actions' <> '["escalate","reject","skip_for_now"]'::jsonb)
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
$$;

DROP FUNCTION IF EXISTS apply_simple_coordinator_v3_checkpoint_decision(uuid, text, text, jsonb, text, text);

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
  SET phase = CASE WHEN p_action IN ('reject', 'abort') THEN 'stopped' ELSE 'running' END,
      state_version = state_version + 1,
      state = state || jsonb_build_object(
        'status', CASE WHEN p_action IN ('reject', 'abort') THEN 'stopped' ELSE 'running' END,
        'pending_checkpoint', NULL,
        'last_checkpoint_result', jsonb_build_object(
          'request_id', p_request_id,
          'checkpoint_kind', checkpoint.checkpoint_kind,
          'action', p_action,
          'values', COALESCE(p_values, '{}'::jsonb),
          'actor_id', p_actor_id
        ),
        'updated_at', clock_timestamp()
      ),
      updated_at = clock_timestamp()
  WHERE id = coordinator.id;
  IF p_action NOT IN ('reject', 'abort') THEN
    UPDATE analysis_runs SET status = 'running' WHERE id = coordinator.analysis_run_id;
    UPDATE onboarding_cases SET status = 'processing', updated_at = clock_timestamp() WHERE id = coordinator.case_id;
  END IF;
  IF p_action IN ('reject', 'abort') THEN
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

CREATE OR REPLACE FUNCTION mark_simple_coordinator_v3_ready(
  p_run_id uuid,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  coordinator coordinator_v3_runs%ROWTYPE;
BEGIN
  IF NULLIF(trim(p_idempotency_key), '') IS NULL THEN
    RAISE EXCEPTION 'ready idempotency key is required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO coordinator FROM coordinator_v3_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'coordinator run does not exist' USING ERRCODE = '23503';
  END IF;
  IF coordinator.state->>'ready_idempotency_key' IS NOT NULL THEN
    IF coordinator.state->>'ready_idempotency_key' = p_idempotency_key THEN
      RETURN jsonb_build_object('status', 'duplicate_suppressed', 'phase', coordinator.phase);
    END IF;
    RAISE EXCEPTION 'ready action conflicts with persisted action' USING ERRCODE = '23P01';
  END IF;
  IF coordinator.phase <> 'running'
     OR coordinator.state->>'status' <> 'running'
     OR NOT EXISTS (
       SELECT 1 FROM analysis_runs
       WHERE id = coordinator.analysis_run_id
         AND status = 'running'
     )
     OR jsonb_array_length(COALESCE(coordinator.state->'latest_findings', '[]'::jsonb)) = 0
     OR jsonb_typeof(coordinator.state->'pending_checkpoint') = 'object'
     OR jsonb_typeof(coordinator.state->'next_action') = 'object'
     OR EXISTS (
       SELECT 1 FROM coordinator_v3_checkpoints checkpoint
       WHERE checkpoint.analysis_run_id = coordinator.analysis_run_id
         AND checkpoint.langflow_job_id = coordinator.langflow_job_id
         AND checkpoint.status = 'pending'
     ) THEN
    RAISE EXCEPTION 'ready_for_review requires persisted findings and no pending checkpoint' USING ERRCODE = '55000';
  END IF;

  UPDATE analysis_runs
  SET status = 'succeeded', finished_at = COALESCE(finished_at, clock_timestamp())
  WHERE id = coordinator.analysis_run_id;
  UPDATE onboarding_cases
  SET status = 'ready_for_review', updated_at = clock_timestamp()
  WHERE id = coordinator.case_id;
  UPDATE coordinator_v3_runs
  SET phase = 'ready_for_review', finalized_at = COALESCE(finalized_at, clock_timestamp()),
      state_version = state_version + 1,
      state = state || jsonb_build_object(
        'status', 'ready_for_review',
        'next_action', NULL,
        'next_action_idempotency_key', NULL,
        'ready_idempotency_key', p_idempotency_key,
        'updated_at', clock_timestamp()
      ),
      updated_at = clock_timestamp()
  WHERE id = coordinator.id;
  RETURN jsonb_build_object('status', 'ready_for_review', 'coordinator_run_id', coordinator.id);
END;
$$;

COMMIT;
