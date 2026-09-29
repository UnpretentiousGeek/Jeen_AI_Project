BEGIN;

ALTER TABLE web_search_executions
  ADD COLUMN research_status text NOT NULL DEFAULT 'pending' CHECK (
    research_status IN ('pending', 'running', 'succeeded', 'failed')
  ),
  ADD COLUMN research_started_at timestamptz,
  ADD COLUMN research_completed_at timestamptz,
  ADD COLUMN research_error_code text,
  ADD COLUMN research_error_message text,
  ADD CONSTRAINT web_search_research_state_check CHECK (
    (research_status IN ('running', 'succeeded', 'failed')) = (research_started_at IS NOT NULL)
    AND (research_status IN ('succeeded', 'failed')) = (research_completed_at IS NOT NULL)
    AND (research_status = 'failed') = (
      research_error_code IS NOT NULL AND research_error_message IS NOT NULL
    )
  );

ALTER TABLE external_web_evidence
  ADD CONSTRAINT external_web_evidence_run_identity_unique
    UNIQUE (id, analysis_run_id);

ALTER TABLE citations
  ADD COLUMN external_web_evidence_id uuid,
  ADD COLUMN agent_task_id text,
  ADD COLUMN agent_artifact_id text,
  ADD CONSTRAINT citations_external_evidence_run_fk
    FOREIGN KEY (external_web_evidence_id, analysis_run_id)
    REFERENCES external_web_evidence(id, analysis_run_id),
  ADD CONSTRAINT citations_public_research_artifact_fk
    FOREIGN KEY (agent_task_id, agent_artifact_id)
    REFERENCES specialist_artifacts(task_id, artifact_id);

ALTER TABLE citations DROP CONSTRAINT citations_source_kind_check;
ALTER TABLE citations DROP CONSTRAINT citations_source_reference_check;

ALTER TABLE citations
  ADD CONSTRAINT citations_source_kind_check
    CHECK (source_kind IN ('case_document', 'policy', 'human_input', 'external_web')),
  ADD CONSTRAINT citations_source_reference_check CHECK (
    (source_kind = 'case_document'
      AND document_chunk_id IS NOT NULL
      AND policy_chunk_id IS NULL
      AND human_input_request_id IS NULL
      AND external_web_evidence_id IS NULL
      AND agent_task_id IS NULL
      AND agent_artifact_id IS NULL)
    OR
    (source_kind = 'policy'
      AND policy_chunk_id IS NOT NULL
      AND document_chunk_id IS NULL
      AND human_input_request_id IS NULL
      AND external_web_evidence_id IS NULL
      AND agent_task_id IS NULL
      AND agent_artifact_id IS NULL)
    OR
    (source_kind = 'human_input'
      AND human_input_request_id IS NOT NULL
      AND document_chunk_id IS NULL
      AND policy_chunk_id IS NULL
      AND external_web_evidence_id IS NULL
      AND agent_task_id IS NULL
      AND agent_artifact_id IS NULL)
    OR
    (source_kind = 'external_web'
      AND external_web_evidence_id IS NOT NULL
      AND agent_task_id IS NOT NULL
      AND agent_artifact_id IS NOT NULL
      AND document_chunk_id IS NULL
      AND policy_chunk_id IS NULL
      AND human_input_request_id IS NULL)
  );

CREATE OR REPLACE FUNCTION claim_public_research_completion(
  p_execution_id uuid,
  p_claimed_at timestamptz
)
RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  execution web_search_executions%ROWTYPE;
  target_run analysis_runs%ROWTYPE;
BEGIN
  SELECT * INTO execution
  FROM web_search_executions
  WHERE id = p_execution_id
  FOR UPDATE;

  IF NOT FOUND OR execution.status <> 'succeeded' THEN
    RAISE EXCEPTION 'public research requires one successfully stored web-search execution';
  END IF;
  IF execution.research_status <> 'pending' THEN
    RETURN execution.research_status;
  END IF;

  SELECT * INTO target_run
  FROM analysis_runs
  WHERE id = execution.analysis_run_id
    AND case_id = execution.case_id
  FOR UPDATE;

  IF NOT FOUND OR target_run.status <> 'running' OR target_run.langflow_job_id IS NOT NULL THEN
    RAISE EXCEPTION 'database-only public research requires an active run without a Langflow job';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM onboarding_cases onboarding_case
    WHERE onboarding_case.id = execution.case_id
      AND onboarding_case.active_analysis_run_id = execution.analysis_run_id
      AND onboarding_case.status = 'processing'
  ) THEN
    RAISE EXCEPTION 'public research run is no longer active for its case';
  END IF;

  UPDATE web_search_executions
  SET research_status = 'running', research_started_at = p_claimed_at
  WHERE id = p_execution_id;

  INSERT INTO audit_events (
    case_id, analysis_run_id, event_type, actor_type, actor_id, payload, created_at
  ) VALUES (
    execution.case_id, execution.analysis_run_id,
    'public_research.started', 'workflow', 'public-research-coordinator',
    jsonb_build_object('search_execution_id', p_execution_id), p_claimed_at
  );

  RETURN 'claimed';
END;
$$;

CREATE OR REPLACE FUNCTION complete_public_research_completion(
  p_execution_id uuid,
  p_task_id text,
  p_artifact_id text,
  p_completed_at timestamptz
)
RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  execution web_search_executions%ROWTYPE;
  artifact specialist_artifacts%ROWTYPE;
  artifact_citation_count integer;
  stored_evidence_count integer;
BEGIN
  SELECT * INTO execution
  FROM web_search_executions
  WHERE id = p_execution_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'web-search execution does not exist'; END IF;
  IF execution.research_status = 'succeeded' THEN RETURN 'succeeded'; END IF;
  IF execution.research_status <> 'running' THEN
    RAISE EXCEPTION 'public research completion is not running';
  END IF;

  SELECT * INTO artifact
  FROM specialist_artifacts
  WHERE analysis_run_id = execution.analysis_run_id
    AND specialty = 'public_research'
    AND task_id = p_task_id
    AND artifact_id = p_artifact_id;

  IF NOT FOUND
    OR artifact.payload ->> 'analysis_run_id' <> execution.analysis_run_id::text
    OR artifact.payload ->> 'specialty' <> 'public_research'
    OR artifact.payload ->> 'status' NOT IN ('completed', 'partial')
  THEN
    RAISE EXCEPTION 'public-research artifact does not match the approved run';
  END IF;

  SELECT jsonb_array_length(artifact.payload -> 'citations') INTO artifact_citation_count;
  SELECT count(*) INTO stored_evidence_count
  FROM external_web_evidence evidence
  WHERE evidence.search_execution_id = p_execution_id;

  IF artifact_citation_count <> stored_evidence_count
    OR (
      SELECT count(DISTINCT citation ->> 'canonical_url')
      FROM jsonb_array_elements(artifact.payload -> 'citations') citation
    ) <> stored_evidence_count
    OR (stored_evidence_count = 0
      AND jsonb_array_length(artifact.payload -> 'evidence_gaps') = 0)
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(artifact.payload -> 'citations') citation
      LEFT JOIN external_web_evidence evidence
        ON evidence.search_execution_id = p_execution_id
       AND evidence.canonical_url = citation ->> 'canonical_url'
       AND evidence.content_hash = citation ->> 'content_hash'
      WHERE citation ->> 'source_kind' <> 'external_web'
        OR citation ->> 'search_execution_id' <> p_execution_id::text
        OR citation ->> 'agent_task_id' <> p_task_id
        OR citation ->> 'agent_artifact_id' <> p_artifact_id
        OR evidence.id IS NULL
    )
  THEN
    RAISE EXCEPTION 'public-research citations differ from the stored approved evidence';
  END IF;

  INSERT INTO finding_specialist_artifacts (
    finding_id, analysis_run_id, task_id, artifact_id
  )
  SELECT link.finding_id, link.analysis_run_id, p_task_id, p_artifact_id
  FROM proposed_action_findings link
  WHERE link.proposed_action_id = execution.proposed_action_id
  ON CONFLICT DO NOTHING;

  INSERT INTO citations (
    analysis_run_id, finding_id, source_kind, external_web_evidence_id,
    agent_task_id, agent_artifact_id, locator, excerpt
  )
  SELECT
    execution.analysis_run_id, link.finding_id, 'external_web', evidence.id,
    p_task_id, p_artifact_id,
    evidence.title || ' — ' || evidence.publisher, evidence.excerpt
  FROM proposed_action_findings link
  JOIN external_web_evidence evidence
    ON evidence.search_execution_id = p_execution_id
  WHERE link.proposed_action_id = execution.proposed_action_id;

  IF stored_evidence_count = 0 THEN
    INSERT INTO evidence_gaps (
      analysis_run_id, requirement_code, description, requested_evidence
    )
    SELECT
      execution.analysis_run_id, finding.requirement_code,
      gap ->> 'description', gap ->> 'requested_evidence'
    FROM proposed_action_findings link
    JOIN findings finding
      ON finding.id = link.finding_id
     AND finding.analysis_run_id = link.analysis_run_id
    CROSS JOIN LATERAL jsonb_array_elements(artifact.payload -> 'evidence_gaps') gap
    WHERE link.proposed_action_id = execution.proposed_action_id;
  END IF;

  UPDATE web_search_executions
  SET research_status = 'succeeded', research_completed_at = p_completed_at
  WHERE id = p_execution_id;

  UPDATE analysis_runs
  SET status = 'succeeded', finished_at = p_completed_at
  WHERE id = execution.analysis_run_id AND status = 'running';

  UPDATE onboarding_cases
  SET status = 'ready_for_review', updated_at = p_completed_at
  WHERE id = execution.case_id
    AND active_analysis_run_id = execution.analysis_run_id;

  INSERT INTO workflow_events (
    event_id, case_id, analysis_run_id, event_type,
    correlation_id, causation_id, payload, occurred_at
  )
  SELECT
    gen_random_uuid()::text, execution.case_id, execution.analysis_run_id,
    'agent.artifact.available', task.correlation_id, p_task_id,
    jsonb_build_object(
      'specialty', 'public_research',
      'artifact_id', p_artifact_id,
      'search_execution_id', p_execution_id
    ), p_completed_at
  FROM a2a_tasks task
  WHERE task.task_id = p_task_id;

  INSERT INTO workflow_events (
    event_id, case_id, analysis_run_id, event_type,
    correlation_id, causation_id, payload, occurred_at
  )
  SELECT
    gen_random_uuid()::text, execution.case_id, execution.analysis_run_id,
    'run.status_changed', task.correlation_id, p_task_id,
    jsonb_build_object(
      'from', 'running', 'to', 'succeeded',
      'reason', 'approved public evidence analyzed and linked'
    ), p_completed_at
  FROM a2a_tasks task
  WHERE task.task_id = p_task_id;

  INSERT INTO audit_events (
    case_id, analysis_run_id, event_type, actor_type, actor_id, payload, created_at
  ) VALUES (
    execution.case_id, execution.analysis_run_id,
    'public_research.completed', 'workflow', 'public-research-coordinator',
    jsonb_build_object(
      'search_execution_id', p_execution_id,
      'task_id', p_task_id,
      'artifact_id', p_artifact_id,
      'citation_count', artifact_citation_count,
      'case_status', 'ready_for_review'
    ), p_completed_at
  );

  RETURN 'succeeded';
END;
$$;

CREATE OR REPLACE FUNCTION fail_public_research_completion(
  p_execution_id uuid,
  p_error_code text,
  p_error_message text,
  p_failed_at timestamptz
)
RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  execution web_search_executions%ROWTYPE;
BEGIN
  SELECT * INTO execution
  FROM web_search_executions
  WHERE id = p_execution_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'web-search execution does not exist'; END IF;
  IF execution.research_status = 'failed' THEN RETURN 'failed'; END IF;
  IF execution.research_status <> 'running'
    OR NULLIF(btrim(p_error_code), '') IS NULL
    OR NULLIF(btrim(p_error_message), '') IS NULL
  THEN
    RAISE EXCEPTION 'public research failure is invalid';
  END IF;

  UPDATE web_search_executions
  SET research_status = 'failed', research_completed_at = p_failed_at,
      research_error_code = p_error_code,
      research_error_message = left(p_error_message, 500)
  WHERE id = p_execution_id;

  UPDATE analysis_runs
  SET status = 'failed', finished_at = p_failed_at
  WHERE id = execution.analysis_run_id AND status = 'running';

  UPDATE onboarding_cases
  SET status = 'attention_required', updated_at = p_failed_at
  WHERE id = execution.case_id
    AND active_analysis_run_id = execution.analysis_run_id;

  INSERT INTO workflow_events (
    event_id, case_id, analysis_run_id, event_type,
    correlation_id, causation_id, payload, occurred_at
  ) VALUES (
    gen_random_uuid()::text, execution.case_id, execution.analysis_run_id,
    'run.status_changed', 'public-research:' || p_execution_id::text, p_execution_id::text,
    jsonb_build_object(
      'from', 'running', 'to', 'failed',
      'reason', 'public-research specialist failed after bounded retries'
    ), p_failed_at
  );

  INSERT INTO audit_events (
    case_id, analysis_run_id, event_type, actor_type, actor_id, payload, created_at
  ) VALUES (
    execution.case_id, execution.analysis_run_id,
    'public_research.failed', 'workflow', 'public-research-coordinator',
    jsonb_build_object(
      'search_execution_id', p_execution_id,
      'error_code', p_error_code,
      'error_message', left(p_error_message, 500),
      'case_status', 'attention_required'
    ), p_failed_at
  );

  RETURN 'failed';
END;
$$;

CREATE OR REPLACE FUNCTION record_a2a_specialist_failure(
  p_analysis_run_id uuid,
  p_specialty text,
  p_agent_name text,
  p_agent_version text,
  p_card_url text,
  p_endpoint_url text,
  p_skill_id text,
  p_task_id text,
  p_context_id text,
  p_message_id text,
  p_correlation_id text,
  p_attempts integer,
  p_latency_ms integer,
  p_error_code text,
  p_error_message text,
  p_completed_at timestamptz
)
RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  inserted_task_count integer;
BEGIN
  IF p_specialty NOT IN ('entity', 'ownership', 'policy', 'public_research') THEN
    RAISE EXCEPTION 'unsupported A2A specialty %', p_specialty;
  END IF;
  IF p_attempts NOT BETWEEN 1 AND 3
    OR p_latency_ms < 0
    OR NULLIF(btrim(p_error_code), '') IS NULL
    OR NULLIF(btrim(p_error_message), '') IS NULL
  THEN
    RAISE EXCEPTION 'failed A2A task provenance is invalid';
  END IF;

  INSERT INTO a2a_agent_assignments (
    analysis_run_id, specialty, agent_name, agent_version,
    card_url, endpoint_url, skill_id
  ) VALUES (
    p_analysis_run_id, p_specialty, p_agent_name, p_agent_version,
    p_card_url, p_endpoint_url, p_skill_id
  ) ON CONFLICT (analysis_run_id, specialty) DO NOTHING;

  IF NOT EXISTS (
    SELECT 1 FROM a2a_agent_assignments assignment
    WHERE assignment.analysis_run_id = p_analysis_run_id
      AND assignment.specialty = p_specialty
      AND assignment.agent_name = p_agent_name
      AND assignment.agent_version = p_agent_version
      AND assignment.card_url = p_card_url
      AND assignment.endpoint_url = p_endpoint_url
      AND assignment.skill_id = p_skill_id
  ) THEN
    RAISE EXCEPTION 'analysis run specialty is already pinned to a different A2A agent';
  END IF;

  INSERT INTO a2a_tasks (
    analysis_run_id, specialty, task_id, context_id, message_id,
    correlation_id, agent_name, agent_version, status, attempts,
    latency_ms, completed_at, error_code, error_message
  ) VALUES (
    p_analysis_run_id, p_specialty, p_task_id, p_context_id, p_message_id,
    p_correlation_id, p_agent_name, p_agent_version, 'failed', p_attempts,
    p_latency_ms, p_completed_at, p_error_code, p_error_message
  ) ON CONFLICT (task_id) DO NOTHING;

  GET DIAGNOSTICS inserted_task_count = ROW_COUNT;

  IF NOT EXISTS (
    SELECT 1 FROM a2a_tasks task
    WHERE task.analysis_run_id = p_analysis_run_id
      AND task.specialty = p_specialty
      AND task.task_id = p_task_id
      AND task.context_id = p_context_id
      AND task.message_id = p_message_id
      AND task.correlation_id = p_correlation_id
      AND task.agent_name = p_agent_name
      AND task.agent_version = p_agent_version
      AND task.status = 'failed'
      AND task.attempts = p_attempts
      AND task.error_code = p_error_code
      AND task.error_message = p_error_message
  ) THEN
    RAISE EXCEPTION 'failed A2A task identifier conflicts with existing provenance';
  END IF;

  RETURN CASE WHEN inserted_task_count = 1 THEN 'stored' ELSE 'duplicate' END;
END;
$$;

COMMIT;
