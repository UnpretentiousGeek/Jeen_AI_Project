BEGIN;

ALTER TABLE a2a_agent_assignments
  DROP CONSTRAINT a2a_agent_assignments_specialty_check,
  ADD CONSTRAINT a2a_agent_assignments_specialty_check
    CHECK (specialty IN ('entity', 'ownership', 'policy', 'public_research'));

ALTER TABLE a2a_tasks
  ADD CONSTRAINT a2a_tasks_specialty_check
    CHECK (specialty IN ('entity', 'ownership', 'policy', 'public_research'));

CREATE TABLE web_search_executions (
  id uuid PRIMARY KEY,
  proposed_action_id uuid NOT NULL UNIQUE REFERENCES proposed_actions(id),
  approval_id uuid NOT NULL UNIQUE REFERENCES approvals(id),
  analysis_run_id uuid NOT NULL,
  case_id uuid NOT NULL,
  query text NOT NULL,
  allowed_domains text[] NOT NULL,
  max_results integer NOT NULL CHECK (max_results BETWEEN 1 AND 10),
  intended_use text NOT NULL,
  external_disclosure text[] NOT NULL,
  scope_hash text NOT NULL CHECK (scope_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'approved' CHECK (status IN (
    'approved', 'running', 'succeeded', 'failed', 'expired'
  )),
  expires_at timestamptz NOT NULL,
  claimed_at timestamptz,
  completed_at timestamptz,
  provider_request_id text,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (proposed_action_id, analysis_run_id, case_id)
    REFERENCES proposed_actions(id, analysis_run_id, case_id),
  UNIQUE (id, analysis_run_id, case_id),
  CHECK ((status IN ('running', 'succeeded', 'failed')) = (claimed_at IS NOT NULL)),
  CHECK ((status IN ('succeeded', 'failed')) = (completed_at IS NOT NULL)),
  CHECK ((status = 'failed') = (error_code IS NOT NULL AND error_message IS NOT NULL))
);

CREATE TABLE external_web_evidence (
  id uuid PRIMARY KEY,
  search_execution_id uuid NOT NULL,
  analysis_run_id uuid NOT NULL REFERENCES analysis_runs(id),
  case_id uuid NOT NULL REFERENCES onboarding_cases(id),
  url text NOT NULL CHECK (url ~ '^https?://'),
  canonical_url text NOT NULL CHECK (canonical_url ~ '^https?://'),
  title text NOT NULL,
  publisher text NOT NULL,
  published_at timestamptz,
  retrieved_at timestamptz NOT NULL,
  excerpt text NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  retrieval_method text NOT NULL CHECK (retrieval_method = 'firecrawl_search'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (search_execution_id, analysis_run_id, case_id)
    REFERENCES web_search_executions(id, analysis_run_id, case_id),
  UNIQUE (search_execution_id, canonical_url)
);

CREATE TRIGGER immutable_external_web_evidence
BEFORE UPDATE OR DELETE ON external_web_evidence
FOR EACH ROW EXECUTE FUNCTION reject_snapshot_row_mutation();

CREATE OR REPLACE FUNCTION propose_web_search_action(
  p_action_id uuid,
  p_review_request_id uuid,
  p_analysis_run_id uuid,
  p_case_id uuid,
  p_summary text,
  p_payload jsonb,
  p_finding_ids uuid[],
  p_citation_ids uuid[],
  p_idempotency_key text,
  p_correlation_id text
)
RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  target_run analysis_runs%ROWTYPE;
  existing_action proposed_actions%ROWTYPE;
BEGIN
  SELECT * INTO existing_action
  FROM proposed_actions
  WHERE id = p_action_id OR idempotency_key = p_idempotency_key;

  IF FOUND THEN
    IF existing_action.id = p_action_id
      AND existing_action.analysis_run_id = p_analysis_run_id
      AND existing_action.case_id = p_case_id
      AND existing_action.action_type = 'run_web_search'
      AND existing_action.summary = p_summary
      AND existing_action.payload = p_payload
      AND existing_action.idempotency_key = p_idempotency_key
      AND EXISTS (
        SELECT 1 FROM review_requests review
        WHERE review.id = p_review_request_id
          AND review.proposed_action_id = p_action_id
      )
    THEN
      RETURN 'duplicate';
    END IF;
    RAISE EXCEPTION 'web-search action identity conflicts with an existing action';
  END IF;

  SELECT * INTO target_run
  FROM analysis_runs
  WHERE id = p_analysis_run_id AND case_id = p_case_id
  FOR UPDATE;

  IF NOT FOUND OR target_run.status <> 'running' THEN
    RAISE EXCEPTION 'analysis run must be running before web search is proposed';
  END IF;
  IF NULLIF(btrim(p_summary), '') IS NULL
    OR NULLIF(btrim(p_payload ->> 'query'), '') IS NULL
    OR NULLIF(btrim(p_payload ->> 'reason'), '') IS NULL
    OR NULLIF(btrim(p_payload ->> 'intended_use'), '') IS NULL
    OR jsonb_typeof(p_payload -> 'allowed_domains') <> 'array'
    OR jsonb_typeof(p_payload -> 'external_disclosure') <> 'array'
    OR jsonb_typeof(p_payload -> 'max_results') <> 'number'
    OR (p_payload ->> 'max_results')::integer NOT BETWEEN 1 AND 10
  THEN
    RAISE EXCEPTION 'web-search proposal payload is invalid';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(p_payload -> 'allowed_domains') domain
    WHERE domain !~ '^[a-z0-9.-]+$' OR domain LIKE '.%' OR domain LIKE '%.'
  ) THEN
    RAISE EXCEPTION 'web-search allowed domains must be lowercase hostnames';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(p_payload -> 'external_disclosure') disclosure
    WHERE disclosure NOT IN ('legal_name', 'claimed_license_type', 'jurisdiction', 'product')
  ) THEN
    RAISE EXCEPTION 'web-search proposal discloses a field outside the approved public-data allowlist';
  END IF;
  IF cardinality(p_finding_ids) = 0 OR cardinality(p_citation_ids) = 0 THEN
    RAISE EXCEPTION 'web-search proposal requires findings and citations';
  END IF;
  IF (SELECT count(*) FROM findings
      WHERE analysis_run_id = p_analysis_run_id AND id = ANY(p_finding_ids))
      <> cardinality(p_finding_ids)
    OR (SELECT count(*) FROM citations
        WHERE analysis_run_id = p_analysis_run_id AND id = ANY(p_citation_ids))
      <> cardinality(p_citation_ids)
  THEN
    RAISE EXCEPTION 'web-search proposal references findings or citations outside the analysis run';
  END IF;

  INSERT INTO proposed_actions (
    id, analysis_run_id, case_id, action_type, summary, payload,
    status, idempotency_key
  ) VALUES (
    p_action_id, p_analysis_run_id, p_case_id, 'run_web_search',
    p_summary, p_payload, 'pending', p_idempotency_key
  );

  INSERT INTO proposed_action_findings (proposed_action_id, analysis_run_id, finding_id)
  SELECT p_action_id, p_analysis_run_id, item.finding_id
  FROM unnest(p_finding_ids) AS item(finding_id);

  INSERT INTO proposed_action_citations (proposed_action_id, analysis_run_id, citation_id)
  SELECT p_action_id, p_analysis_run_id, item.citation_id
  FROM unnest(p_citation_ids) AS item(citation_id);

  INSERT INTO review_requests (
    id, proposed_action_id, analysis_run_id, case_id, correlation_id
  ) VALUES (
    p_review_request_id, p_action_id, p_analysis_run_id, p_case_id, p_correlation_id
  );

  UPDATE analysis_runs SET status = 'suspended' WHERE id = p_analysis_run_id;
  UPDATE onboarding_cases
  SET status = 'awaiting_approval', updated_at = now()
  WHERE id = p_case_id;

  INSERT INTO workflow_events (
    event_id, case_id, analysis_run_id, event_type,
    correlation_id, causation_id, payload
  ) VALUES
  (
    gen_random_uuid()::text, p_case_id, p_analysis_run_id,
    'human.review.requested', p_correlation_id, p_action_id::text,
    jsonb_build_object('request_id', p_review_request_id, 'proposed_action_id', p_action_id)
  ),
  (
    gen_random_uuid()::text, p_case_id, p_analysis_run_id,
    'run.status_changed', p_correlation_id, p_action_id::text,
    jsonb_build_object('from', 'running', 'to', 'suspended', 'reason', 'web search approval required')
  );

  INSERT INTO audit_events (
    case_id, analysis_run_id, event_type, actor_type, payload
  ) VALUES (
    p_case_id, p_analysis_run_id, 'web_search.proposed', 'workflow',
    jsonb_build_object(
      'proposed_action_id', p_action_id,
      'review_request_id', p_review_request_id,
      'query', p_payload ->> 'query',
      'allowed_domains', p_payload -> 'allowed_domains',
      'max_results', p_payload -> 'max_results',
      'intended_use', p_payload ->> 'intended_use',
      'external_disclosure', p_payload -> 'external_disclosure'
    )
  );

  RETURN 'stored';
END;
$$;

CREATE OR REPLACE FUNCTION decide_web_search_action(
  p_review_request_id uuid,
  p_action_id uuid,
  p_analysis_run_id uuid,
  p_case_id uuid,
  p_decision text,
  p_decided_by text,
  p_rationale text,
  p_decided_at timestamptz,
  p_idempotency_key text,
  p_execution_id uuid,
  p_expires_at timestamptz
)
RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  review review_requests%ROWTYPE;
  action proposed_actions%ROWTYPE;
  stored_approval approvals%ROWTYPE;
BEGIN
  SELECT * INTO review FROM review_requests WHERE id = p_review_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'review request does not exist'; END IF;
  SELECT * INTO action FROM proposed_actions WHERE id = review.proposed_action_id FOR UPDATE;

  SELECT * INTO stored_approval
  FROM approvals
  WHERE proposed_action_id = p_action_id OR idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF stored_approval.proposed_action_id = p_action_id
      AND stored_approval.review_request_id = p_review_request_id
      AND stored_approval.decision = p_decision
      AND stored_approval.decided_by = p_decided_by
      AND stored_approval.rationale = p_rationale
      AND stored_approval.decided_at = p_decided_at
      AND stored_approval.idempotency_key = p_idempotency_key
      AND (p_decision <> 'approved' OR EXISTS (
        SELECT 1 FROM web_search_executions execution
        WHERE execution.id = p_execution_id
          AND execution.proposed_action_id = p_action_id
          AND execution.expires_at = p_expires_at
      ))
    THEN
      RETURN 'duplicate';
    END IF;
    RAISE EXCEPTION 'web-search action has already received a different decision';
  END IF;

  IF review.proposed_action_id <> p_action_id
    OR review.analysis_run_id <> p_analysis_run_id
    OR review.case_id <> p_case_id
    OR action.analysis_run_id <> p_analysis_run_id
    OR action.case_id <> p_case_id
    OR action.action_type <> 'run_web_search'
  THEN
    RAISE EXCEPTION 'review decision does not match the web-search action scope';
  END IF;
  IF review.status <> 'pending' OR action.status <> 'pending' THEN
    RAISE EXCEPTION 'web-search action is no longer pending approval';
  END IF;
  IF p_decision NOT IN ('approved', 'rejected', 'changes_requested')
    OR NULLIF(btrim(p_decided_by), '') IS NULL
    OR NULLIF(btrim(p_rationale), '') IS NULL
  THEN
    RAISE EXCEPTION 'web-search review decision is invalid';
  END IF;
  IF p_decision = 'approved'
    AND (p_expires_at <= p_decided_at OR p_expires_at > p_decided_at + interval '30 minutes')
  THEN
    RAISE EXCEPTION 'web-search approval expiry must be within 30 minutes of approval';
  END IF;

  INSERT INTO approvals (
    proposed_action_id, review_request_id, decision, decided_by,
    rationale, decided_at, idempotency_key
  ) VALUES (
    p_action_id, p_review_request_id, p_decision, p_decided_by,
    p_rationale, p_decided_at, p_idempotency_key
  ) RETURNING * INTO stored_approval;

  UPDATE review_requests
  SET status = 'decided', decided_at = p_decided_at
  WHERE id = p_review_request_id;

  INSERT INTO workflow_events (
    event_id, case_id, analysis_run_id, event_type,
    correlation_id, causation_id, payload, occurred_at
  ) VALUES (
    gen_random_uuid()::text, p_case_id, p_analysis_run_id,
    'human.review.decided', review.correlation_id, p_review_request_id::text,
    jsonb_build_object(
      'request_id', p_review_request_id,
      'proposed_action_id', p_action_id,
      'decision', p_decision,
      'decided_by', p_decided_by
    ),
    p_decided_at
  );

  INSERT INTO audit_events (
    case_id, analysis_run_id, event_type, actor_type, actor_id, payload, created_at
  ) VALUES (
    p_case_id, p_analysis_run_id, 'web_search.reviewed', 'analyst', p_decided_by,
    jsonb_build_object(
      'review_request_id', p_review_request_id,
      'proposed_action_id', p_action_id,
      'decision', p_decision,
      'rationale', p_rationale,
      'query', action.payload ->> 'query',
      'external_disclosure', action.payload -> 'external_disclosure'
    ),
    p_decided_at
  );

  UPDATE analysis_runs SET status = 'running' WHERE id = p_analysis_run_id;
  UPDATE onboarding_cases SET status = 'processing', updated_at = p_decided_at WHERE id = p_case_id;

  IF p_decision = 'approved' THEN
    UPDATE proposed_actions SET status = 'approved' WHERE id = p_action_id;
    INSERT INTO web_search_executions (
      id, proposed_action_id, approval_id, analysis_run_id, case_id,
      query, allowed_domains, max_results, intended_use, external_disclosure,
      scope_hash, expires_at, created_at
    ) VALUES (
      p_execution_id, p_action_id, stored_approval.id, p_analysis_run_id, p_case_id,
      action.payload ->> 'query',
      ARRAY(SELECT value FROM jsonb_array_elements_text(action.payload -> 'allowed_domains')),
      (action.payload ->> 'max_results')::integer,
      action.payload ->> 'intended_use',
      ARRAY(SELECT value FROM jsonb_array_elements_text(action.payload -> 'external_disclosure')),
      encode(digest(jsonb_build_object(
        'action_id', p_action_id,
        'case_id', p_case_id,
        'analysis_run_id', p_analysis_run_id,
        'query', action.payload ->> 'query',
        'allowed_domains', action.payload -> 'allowed_domains',
        'max_results', action.payload -> 'max_results',
        'intended_use', action.payload ->> 'intended_use',
        'external_disclosure', action.payload -> 'external_disclosure'
      )::text, 'sha256'), 'hex'),
      p_expires_at, p_decided_at
    );
    RETURN 'approved';
  END IF;

  UPDATE proposed_actions SET status = p_decision WHERE id = p_action_id;
  INSERT INTO audit_events (
    case_id, analysis_run_id, event_type, actor_type, actor_id, payload, created_at
  ) VALUES (
    p_case_id, p_analysis_run_id, 'web_search_not_performed', 'system', NULL,
    jsonb_build_object('proposed_action_id', p_action_id, 'reason', p_decision),
    p_decided_at
  );
  RETURN p_decision;
END;
$$;

CREATE OR REPLACE FUNCTION claim_web_search_execution(
  p_execution_id uuid,
  p_action_id uuid,
  p_analysis_run_id uuid,
  p_case_id uuid,
  p_query text,
  p_allowed_domains text[],
  p_max_results integer,
  p_intended_use text,
  p_external_disclosure text[],
  p_claimed_at timestamptz
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

  IF NOT FOUND THEN RAISE EXCEPTION 'web search has no analyst approval'; END IF;
  IF execution.proposed_action_id <> p_action_id
    OR execution.analysis_run_id <> p_analysis_run_id
    OR execution.case_id <> p_case_id
    OR execution.query <> p_query
    OR execution.allowed_domains <> p_allowed_domains
    OR execution.max_results <> p_max_results
    OR execution.intended_use <> p_intended_use
    OR execution.external_disclosure <> p_external_disclosure
  THEN
    RAISE EXCEPTION 'web-search execution scope differs from the analyst-approved scope';
  END IF;
  IF execution.status <> 'approved' THEN RETURN 'duplicate'; END IF;
  IF p_claimed_at >= execution.expires_at THEN
    UPDATE web_search_executions SET status = 'expired' WHERE id = p_execution_id;
    UPDATE proposed_actions SET status = 'failed' WHERE id = p_action_id;
    INSERT INTO audit_events (
      case_id, analysis_run_id, event_type, actor_type, payload, created_at
    ) VALUES (
      p_case_id, p_analysis_run_id, 'web_search_not_performed', 'system',
      jsonb_build_object('proposed_action_id', p_action_id, 'reason', 'approval_expired'),
      p_claimed_at
    );
    RETURN 'expired';
  END IF;

  UPDATE web_search_executions
  SET status = 'running', claimed_at = p_claimed_at
  WHERE id = p_execution_id;
  INSERT INTO audit_events (
    case_id, analysis_run_id, event_type, actor_type, payload, created_at
  ) VALUES (
    p_case_id, p_analysis_run_id, 'web_search.started', 'system',
    jsonb_build_object(
      'search_execution_id', p_execution_id,
      'query', p_query,
      'allowed_domains', p_allowed_domains,
      'max_results', p_max_results,
      'external_disclosure', p_external_disclosure
    ),
    p_claimed_at
  );
  RETURN 'claimed';
END;
$$;

CREATE OR REPLACE FUNCTION complete_web_search_execution(
  p_execution_id uuid,
  p_action_id uuid,
  p_analysis_run_id uuid,
  p_case_id uuid,
  p_provider_request_id text,
  p_evidence jsonb,
  p_completed_at timestamptz
)
RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  execution web_search_executions%ROWTYPE;
  action proposed_actions%ROWTYPE;
BEGIN
  SELECT * INTO execution FROM web_search_executions WHERE id = p_execution_id FOR UPDATE;
  SELECT * INTO action FROM proposed_actions WHERE id = p_action_id FOR UPDATE;
  IF execution.id IS NULL OR action.id IS NULL OR execution.proposed_action_id <> p_action_id
    OR execution.analysis_run_id <> p_analysis_run_id
    OR execution.case_id <> p_case_id
  THEN
    RAISE EXCEPTION 'web-search completion does not match the approved execution';
  END IF;
  IF execution.status <> 'running' OR action.status <> 'approved' THEN
    RAISE EXCEPTION 'web-search execution is not running';
  END IF;
  IF jsonb_typeof(p_evidence) <> 'array'
    OR jsonb_array_length(p_evidence) > execution.max_results
  THEN
    RAISE EXCEPTION 'web-search evidence payload exceeds the approved result limit';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_evidence) item
    WHERE item ->> 'searchExecutionId' <> p_execution_id::text
  ) THEN
    RAISE EXCEPTION 'web-search evidence references a different execution';
  END IF;

  INSERT INTO external_web_evidence (
    id, search_execution_id, analysis_run_id, case_id, url, canonical_url,
    title, publisher, published_at, retrieved_at, excerpt, content_hash,
    retrieval_method
  )
  SELECT
    item.id, p_execution_id, p_analysis_run_id, p_case_id,
    item.url, item."canonicalUrl", item.title, item.publisher,
    item."publishedAt", item."retrievedAt", item.excerpt, item."contentHash",
    'firecrawl_search'
  FROM jsonb_to_recordset(p_evidence) AS item(
    id uuid,
    "searchExecutionId" text,
    url text,
    "canonicalUrl" text,
    title text,
    publisher text,
    "publishedAt" timestamptz,
    "retrievedAt" timestamptz,
    excerpt text,
    "contentHash" text
  );

  UPDATE web_search_executions
  SET status = 'succeeded', completed_at = p_completed_at,
      provider_request_id = p_provider_request_id
  WHERE id = p_execution_id;
  UPDATE proposed_actions
  SET status = 'executed', execution_result = jsonb_build_object(
    'search_execution_id', p_execution_id,
    'provider_request_id', p_provider_request_id,
    'result_count', jsonb_array_length(p_evidence)
  )
  WHERE id = p_action_id;

  INSERT INTO workflow_events (
    event_id, case_id, analysis_run_id, event_type,
    correlation_id, causation_id, payload, occurred_at
  )
  SELECT
    gen_random_uuid()::text, p_case_id, p_analysis_run_id,
    'action.executed', review.correlation_id, review.id::text,
    jsonb_build_object('proposed_action_id', p_action_id, 'idempotency_key', action.idempotency_key),
    p_completed_at
  FROM review_requests review
  WHERE review.proposed_action_id = p_action_id;

  INSERT INTO audit_events (
    case_id, analysis_run_id, event_type, actor_type, payload, created_at
  ) VALUES (
    p_case_id, p_analysis_run_id, 'web_search.completed', 'system',
    jsonb_build_object(
      'search_execution_id', p_execution_id,
      'provider_request_id', p_provider_request_id,
      'query', execution.query,
      'external_disclosure', execution.external_disclosure,
      'results', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'url', evidence.canonical_url,
        'retrieved_at', evidence.retrieved_at,
        'content_hash', evidence.content_hash
      )), '[]'::jsonb) FROM external_web_evidence evidence
        WHERE evidence.search_execution_id = p_execution_id)
    ),
    p_completed_at
  );
  RETURN 'stored';
END;
$$;

CREATE OR REPLACE FUNCTION fail_web_search_execution(
  p_execution_id uuid,
  p_action_id uuid,
  p_analysis_run_id uuid,
  p_case_id uuid,
  p_error_code text,
  p_error_message text,
  p_failed_at timestamptz
)
RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM web_search_executions
    WHERE id = p_execution_id
      AND proposed_action_id = p_action_id
      AND analysis_run_id = p_analysis_run_id
      AND case_id = p_case_id
      AND status = 'running'
    FOR UPDATE
  ) THEN
    RAISE EXCEPTION 'web-search execution is not running';
  END IF;
  UPDATE web_search_executions
  SET status = 'failed', completed_at = p_failed_at,
      error_code = p_error_code, error_message = p_error_message
  WHERE id = p_execution_id;
  UPDATE proposed_actions
  SET status = 'failed', execution_result = jsonb_build_object(
    'search_execution_id', p_execution_id,
    'error_code', p_error_code,
    'error_message', p_error_message
  )
  WHERE id = p_action_id;
  INSERT INTO audit_events (
    case_id, analysis_run_id, event_type, actor_type, payload, created_at
  ) VALUES (
    p_case_id, p_analysis_run_id, 'web_search.failed', 'system',
    jsonb_build_object(
      'search_execution_id', p_execution_id,
      'error_code', p_error_code,
      'error_message', p_error_message
    ),
    p_failed_at
  );
  RETURN 'stored';
END;
$$;

CREATE OR REPLACE FUNCTION record_a2a_specialist_result(
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
  p_artifact jsonb,
  p_completed_at timestamptz
)
RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  inserted_artifact_count integer;
BEGIN
  IF p_specialty NOT IN ('entity', 'ownership', 'policy', 'public_research') THEN
    RAISE EXCEPTION 'unsupported A2A specialty %', p_specialty;
  END IF;
  IF p_artifact ->> 'analysis_run_id' <> p_analysis_run_id::text
    OR p_artifact ->> 'specialty' <> p_specialty
    OR p_artifact ->> 'task_id' <> p_task_id
    OR p_artifact #>> '{agent,name}' <> p_agent_name
    OR p_artifact #>> '{agent,version}' <> p_agent_version
  THEN
    RAISE EXCEPTION 'A2A artifact provenance does not match the dispatch record';
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
    latency_ms, completed_at
  ) VALUES (
    p_analysis_run_id, p_specialty, p_task_id, p_context_id, p_message_id,
    p_correlation_id, p_agent_name, p_agent_version, 'completed', p_attempts,
    p_latency_ms, p_completed_at
  ) ON CONFLICT (task_id) DO NOTHING;
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
      AND task.attempts = p_attempts
  ) THEN
    RAISE EXCEPTION 'A2A task identifier conflicts with existing provenance';
  END IF;

  INSERT INTO specialist_artifacts (
    analysis_run_id, specialty, task_id, artifact_id,
    schema_version, status, payload, created_at
  ) VALUES (
    p_analysis_run_id, p_specialty, p_task_id, p_artifact ->> 'artifact_id',
    p_artifact ->> 'schema_version', p_artifact ->> 'status', p_artifact,
    (p_artifact ->> 'created_at')::timestamptz
  ) ON CONFLICT (task_id, artifact_id) DO NOTHING;
  GET DIAGNOSTICS inserted_artifact_count = ROW_COUNT;
  IF NOT EXISTS (
    SELECT 1 FROM specialist_artifacts artifact
    WHERE artifact.task_id = p_task_id
      AND artifact.artifact_id = p_artifact ->> 'artifact_id'
      AND artifact.payload = p_artifact
  ) THEN
    RAISE EXCEPTION 'A2A artifact identifier conflicts with existing payload';
  END IF;
  RETURN CASE WHEN inserted_artifact_count = 1 THEN 'stored' ELSE 'duplicate' END;
END;
$$;

COMMIT;
