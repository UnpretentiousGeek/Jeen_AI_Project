BEGIN;

CREATE TABLE IF NOT EXISTS web_result_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  search_execution_id uuid NOT NULL UNIQUE,
  analysis_run_id uuid NOT NULL,
  case_id uuid NOT NULL,
  checkpoint_id text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'decided', 'empty')),
  decided_by text,
  rationale text,
  decided_at timestamptz,
  idempotency_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (search_execution_id, analysis_run_id, case_id)
    REFERENCES web_search_executions(id, analysis_run_id, case_id),
  UNIQUE (id, search_execution_id, analysis_run_id, case_id),
  CHECK (
    (status = 'decided') = (
      decided_by IS NOT NULL AND rationale IS NOT NULL
      AND decided_at IS NOT NULL AND idempotency_key IS NOT NULL
    )
  )
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'external_web_evidence_result_review_identity_unique'
  ) THEN
    ALTER TABLE external_web_evidence
      ADD CONSTRAINT external_web_evidence_result_review_identity_unique
      UNIQUE (id, search_execution_id, analysis_run_id, case_id, content_hash);
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS web_result_review_items (
  review_id uuid NOT NULL,
  external_web_evidence_id uuid NOT NULL,
  search_execution_id uuid NOT NULL,
  analysis_run_id uuid NOT NULL,
  case_id uuid NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  review_state text NOT NULL DEFAULT 'pending_review' CHECK (
    review_state IN ('pending_review', 'accepted', 'rejected')
  ),
  decided_at timestamptz,
  PRIMARY KEY (review_id, external_web_evidence_id),
  UNIQUE (external_web_evidence_id),
  FOREIGN KEY (review_id, search_execution_id, analysis_run_id, case_id)
    REFERENCES web_result_reviews(id, search_execution_id, analysis_run_id, case_id),
  CONSTRAINT web_result_review_items_evidence_scope_fk
    FOREIGN KEY (
      external_web_evidence_id, search_execution_id,
      analysis_run_id, case_id, content_hash
    ) REFERENCES external_web_evidence(
      id, search_execution_id, analysis_run_id, case_id, content_hash
    ),
  CHECK ((review_state = 'pending_review') = (decided_at IS NULL))
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'web_result_review_items_evidence_scope_fk'
  ) THEN
    ALTER TABLE web_result_review_items
      ADD CONSTRAINT web_result_review_items_evidence_scope_fk
      FOREIGN KEY (
        external_web_evidence_id, search_execution_id,
        analysis_run_id, case_id, content_hash
      ) REFERENCES external_web_evidence(
        id, search_execution_id, analysis_run_id, case_id, content_hash
      );
  END IF;
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
  result_review_id uuid := gen_random_uuid();
  followup_request_id uuid := gen_random_uuid();
  result_count integer;
  review_correlation_id text;
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

  result_count := jsonb_array_length(p_evidence);
  SELECT correlation_id INTO review_correlation_id
  FROM review_requests WHERE proposed_action_id = p_action_id;

  UPDATE web_search_executions
  SET status = 'succeeded', completed_at = p_completed_at,
      provider_request_id = p_provider_request_id
  WHERE id = p_execution_id;
  UPDATE proposed_actions
  SET status = 'executed', execution_result = jsonb_build_object(
    'search_execution_id', p_execution_id,
    'provider_request_id', p_provider_request_id,
    'result_count', result_count
  )
  WHERE id = p_action_id;

  INSERT INTO web_result_reviews (
    id, search_execution_id, analysis_run_id, case_id, checkpoint_id, status, created_at
  ) VALUES (
    result_review_id, p_execution_id, p_analysis_run_id, p_case_id,
    'web-result-review:' || p_execution_id::text,
    CASE WHEN result_count = 0 THEN 'empty' ELSE 'pending' END,
    p_completed_at
  );

  INSERT INTO web_result_review_items (
    review_id, external_web_evidence_id, search_execution_id,
    analysis_run_id, case_id, content_hash
  )
  SELECT result_review_id, evidence.id, p_execution_id,
         p_analysis_run_id, p_case_id, evidence.content_hash
  FROM external_web_evidence evidence
  WHERE evidence.search_execution_id = p_execution_id;

  UPDATE analysis_runs
  SET status = 'suspended', checkpoint_id = 'web-result-review:' || p_execution_id::text
  WHERE id = p_analysis_run_id AND status = 'running';
  UPDATE onboarding_cases
  SET status = CASE WHEN result_count = 0 THEN 'awaiting_information' ELSE 'awaiting_approval' END,
      updated_at = p_completed_at
  WHERE id = p_case_id AND active_analysis_run_id = p_analysis_run_id;

  IF result_count = 0 THEN
    INSERT INTO human_input_requests (
      id, analysis_run_id, request_type, question, reason, input_type,
      originating_context_id, correlation_id, langflow_job_id, checkpoint_id
    )
    SELECT followup_request_id, p_analysis_run_id, 'clarification',
           'What additional evidence or source should be used to resolve this unsupported claim?',
           'The approved search returned no usable results. No absence claim was made.',
           'text', 'web-result-review', review_correlation_id,
           COALESCE(run.langflow_job_id, 'database-only:web-result-review:' || p_execution_id::text),
           'web-result-followup:' || p_execution_id::text
    FROM analysis_runs run WHERE run.id = p_analysis_run_id
    ON CONFLICT DO NOTHING;
  END IF;

  INSERT INTO workflow_events (
    event_id, case_id, analysis_run_id, event_type,
    correlation_id, causation_id, payload, occurred_at
  ) VALUES (
    gen_random_uuid()::text, p_case_id, p_analysis_run_id,
    'action.executed', review_correlation_id, p_action_id::text,
    jsonb_build_object('proposed_action_id', p_action_id, 'idempotency_key', action.idempotency_key),
    p_completed_at
  );

  IF result_count > 0 THEN
    INSERT INTO workflow_events (
      event_id, case_id, analysis_run_id, event_type,
      correlation_id, causation_id, payload, occurred_at
    ) VALUES (
      gen_random_uuid()::text, p_case_id, p_analysis_run_id,
      'human.review.requested', review_correlation_id, p_execution_id::text,
      jsonb_build_object(
        'review_id', result_review_id,
        'checkpoint_kind', 'web_result_review',
        'checkpoint_id', 'web-result-review:' || p_execution_id::text,
        'search_execution_id', p_execution_id,
        'result_count', result_count
      ), p_completed_at
    );
  ELSE
    INSERT INTO workflow_events (
      event_id, case_id, analysis_run_id, event_type,
      correlation_id, causation_id, payload, occurred_at
    ) VALUES (
      gen_random_uuid()::text, p_case_id, p_analysis_run_id,
      'human.input.requested', review_correlation_id, p_execution_id::text,
      jsonb_build_object(
        'request_id', followup_request_id,
        'checkpoint_kind', 'web_result_followup',
        'search_execution_id', p_execution_id,
        'reason', 'empty_result_batch'
      ), p_completed_at
    );
  END IF;

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
        'result_id', evidence.id,
        'url', evidence.canonical_url,
        'retrieved_at', evidence.retrieved_at,
        'content_hash', evidence.content_hash,
        'review_state', 'pending_review'
      )), '[]'::jsonb) FROM external_web_evidence evidence
        WHERE evidence.search_execution_id = p_execution_id)
    ), p_completed_at
  );

  INSERT INTO audit_events (
    case_id, analysis_run_id, event_type, actor_type, payload, created_at
  ) VALUES (
    p_case_id, p_analysis_run_id,
    CASE WHEN result_count = 0 THEN 'web_result_review.empty' ELSE 'web_result_review.requested' END,
    'system',
    jsonb_build_object(
      'review_id', result_review_id,
      'search_execution_id', p_execution_id,
      'checkpoint_kind', 'web_result_review',
      'result_count', result_count,
      'next_state', CASE WHEN result_count = 0 THEN 'awaiting_information' ELSE 'awaiting_approval' END
    ), p_completed_at
  );
  RETURN 'stored';
END;
$$;

CREATE OR REPLACE FUNCTION decide_web_result_review_authorized(
  p_review_id uuid,
  p_execution_id uuid,
  p_analysis_run_id uuid,
  p_case_id uuid,
  p_decisions jsonb,
  p_decided_by text,
  p_rationale text,
  p_decided_at timestamptz,
  p_idempotency_key text,
  p_actor_roles text[]
)
RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  target_review web_result_reviews%ROWTYPE;
  item_count integer;
  accepted_count integer;
  normalized_input jsonb;
  normalized_stored jsonb;
  followup_request_id uuid := gen_random_uuid();
BEGIN
  IF NOT ('compliance_analyst' = ANY(COALESCE(p_actor_roles, ARRAY[]::text[]))) THEN
    RAISE EXCEPTION 'web-result review requires the compliance analyst role';
  END IF;
  IF NULLIF(btrim(p_decided_by), '') IS NULL
    OR NULLIF(btrim(p_rationale), '') IS NULL
    OR length(btrim(p_rationale)) < 10
    OR length(p_rationale) > 1000
    OR NULLIF(btrim(p_idempotency_key), '') IS NULL
    OR p_decided_at IS NULL
    OR jsonb_typeof(p_decisions) <> 'array'
  THEN
    RAISE EXCEPTION 'web-result review decision is invalid';
  END IF;

  SELECT * INTO target_review
  FROM web_result_reviews
  WHERE id = p_review_id
  FOR UPDATE;
  IF NOT FOUND
    OR target_review.search_execution_id <> p_execution_id
    OR target_review.analysis_run_id <> p_analysis_run_id
    OR target_review.case_id <> p_case_id
  THEN
    RAISE EXCEPTION 'web-result review does not match the case, run, and execution';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'evidence_id', item ->> 'evidence_id',
    'content_hash', item ->> 'content_hash',
    'decision', item ->> 'decision'
  ) ORDER BY item ->> 'evidence_id'), '[]'::jsonb)
  INTO normalized_input
  FROM jsonb_array_elements(p_decisions) item;

  IF target_review.status = 'decided' THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'evidence_id', review_item.external_web_evidence_id::text,
      'content_hash', review_item.content_hash,
      'decision', review_item.review_state
    ) ORDER BY review_item.external_web_evidence_id::text), '[]'::jsonb)
    INTO normalized_stored
    FROM web_result_review_items review_item
    WHERE review_item.review_id = p_review_id;
    IF target_review.idempotency_key = p_idempotency_key
      AND target_review.decided_by = p_decided_by
      AND target_review.rationale = btrim(p_rationale)
      AND normalized_stored = normalized_input
    THEN
      RETURN 'duplicate';
    END IF;
    RAISE EXCEPTION 'web-result review is no longer pending';
  END IF;
  IF target_review.status <> 'pending' THEN
    RAISE EXCEPTION 'empty web-search results cannot be accepted as evidence';
  END IF;

  SELECT count(*) INTO item_count
  FROM web_result_review_items WHERE review_id = p_review_id;
  IF jsonb_array_length(p_decisions) <> item_count
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_decisions) item
      WHERE item ->> 'decision' NOT IN ('accepted', 'rejected')
        OR NULLIF(item ->> 'evidence_id', '') IS NULL
        OR NULLIF(item ->> 'content_hash', '') IS NULL
    )
    OR (SELECT count(DISTINCT item ->> 'evidence_id') FROM jsonb_array_elements(p_decisions) item) <> item_count
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(p_decisions) item
      LEFT JOIN web_result_review_items review_item
        ON review_item.review_id = p_review_id
       AND review_item.external_web_evidence_id::text = item ->> 'evidence_id'
       AND review_item.content_hash = item ->> 'content_hash'
      LEFT JOIN external_web_evidence evidence
        ON evidence.id = review_item.external_web_evidence_id
       AND evidence.content_hash = review_item.content_hash
      WHERE review_item.external_web_evidence_id IS NULL OR evidence.id IS NULL
    )
  THEN
    RAISE EXCEPTION 'every unchanged web result requires one accept or reject decision';
  END IF;

  UPDATE web_result_review_items review_item
  SET review_state = decision_item.decision,
      decided_at = p_decided_at
  FROM jsonb_to_recordset(p_decisions) AS decision_item(
    evidence_id uuid, content_hash text, decision text
  )
  WHERE review_item.review_id = p_review_id
    AND review_item.external_web_evidence_id = decision_item.evidence_id
    AND review_item.content_hash = decision_item.content_hash;

  SELECT count(*) INTO accepted_count
  FROM web_result_review_items
  WHERE review_id = p_review_id AND review_state = 'accepted';

  UPDATE web_result_reviews
  SET status = 'decided', decided_by = p_decided_by,
      rationale = btrim(p_rationale), decided_at = p_decided_at,
      idempotency_key = p_idempotency_key
  WHERE id = p_review_id;

  IF accepted_count > 0 THEN
    UPDATE analysis_runs
    SET status = 'running'
    WHERE id = p_analysis_run_id AND status = 'suspended';
    UPDATE onboarding_cases
    SET status = 'processing', updated_at = p_decided_at
    WHERE id = p_case_id AND active_analysis_run_id = p_analysis_run_id;
  ELSE
    UPDATE onboarding_cases
    SET status = 'awaiting_information', updated_at = p_decided_at
    WHERE id = p_case_id AND active_analysis_run_id = p_analysis_run_id;

    INSERT INTO human_input_requests (
      id, analysis_run_id, request_type, question, reason, input_type,
      originating_context_id, correlation_id, langflow_job_id, checkpoint_id
    )
    SELECT followup_request_id, p_analysis_run_id, 'clarification',
           'What additional evidence or source should be used to resolve this unsupported claim?',
           'Every retrieved web result was rejected. No rejected result will be sent to an agent.',
           'text', 'web-result-review', review.correlation_id,
           COALESCE(run.langflow_job_id, 'database-only:web-result-review:' || p_execution_id::text),
           'web-result-followup:' || p_execution_id::text
    FROM analysis_runs run
    JOIN web_search_executions execution ON execution.analysis_run_id = run.id
    JOIN review_requests review ON review.proposed_action_id = execution.proposed_action_id
    WHERE run.id = p_analysis_run_id AND execution.id = p_execution_id
    ON CONFLICT DO NOTHING;

    INSERT INTO workflow_events (
      event_id, case_id, analysis_run_id, event_type,
      correlation_id, causation_id, payload, occurred_at
    )
    SELECT gen_random_uuid()::text, p_case_id, p_analysis_run_id,
           'human.input.requested', review.correlation_id, p_review_id::text,
           jsonb_build_object(
             'request_id', followup_request_id,
             'checkpoint_kind', 'web_result_followup',
             'search_execution_id', p_execution_id,
             'reason', 'all_results_rejected'
           ), p_decided_at
    FROM review_requests review
    JOIN web_search_executions execution
      ON execution.proposed_action_id = review.proposed_action_id
    WHERE execution.id = p_execution_id;
  END IF;

  INSERT INTO workflow_events (
    event_id, case_id, analysis_run_id, event_type,
    correlation_id, causation_id, payload, occurred_at
  )
  SELECT gen_random_uuid()::text, p_case_id, p_analysis_run_id,
         'human.review.decided', review.correlation_id, p_review_id::text,
         jsonb_build_object(
           'review_id', p_review_id,
           'checkpoint_kind', 'web_result_review',
           'search_execution_id', p_execution_id,
           'accepted_count', accepted_count,
           'rejected_count', item_count - accepted_count,
           'idempotency_key', p_idempotency_key
         ), p_decided_at
  FROM review_requests review
  JOIN web_search_executions execution
    ON execution.proposed_action_id = review.proposed_action_id
  WHERE execution.id = p_execution_id;

  INSERT INTO audit_events (
    case_id, analysis_run_id, event_type, actor_type, actor_id, payload, created_at
  ) VALUES (
    p_case_id, p_analysis_run_id, 'web_result_review.decided', 'analyst', p_decided_by,
    jsonb_build_object(
      'review_id', p_review_id,
      'search_execution_id', p_execution_id,
      'accepted_count', accepted_count,
      'rejected_count', item_count - accepted_count,
      'rationale', btrim(p_rationale),
      'idempotency_key', p_idempotency_key,
      'next_state', CASE WHEN accepted_count > 0 THEN 'public_research' ELSE 'awaiting_information' END
    ), p_decided_at
  );

  RETURN CASE WHEN accepted_count > 0 THEN 'accepted' ELSE 'rejected_all' END;
END;
$$;

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
  SELECT * INTO execution FROM web_search_executions WHERE id = p_execution_id FOR UPDATE;
  IF NOT FOUND OR execution.status <> 'succeeded' THEN
    RAISE EXCEPTION 'public research requires one successfully stored web-search execution';
  END IF;
  IF execution.research_status <> 'pending' THEN RETURN execution.research_status; END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM web_result_reviews review
    JOIN web_result_review_items item ON item.review_id = review.id
    WHERE review.search_execution_id = p_execution_id
      AND review.status = 'decided'
      AND item.review_state = 'accepted'
  ) THEN
    RAISE EXCEPTION 'public research requires completed analyst acceptance of at least one result';
  END IF;

  SELECT * INTO target_run
  FROM analysis_runs
  WHERE id = execution.analysis_run_id AND case_id = execution.case_id
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
  accepted_evidence_count integer;
BEGIN
  SELECT * INTO execution FROM web_search_executions WHERE id = p_execution_id FOR UPDATE;
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
  SELECT count(*) INTO accepted_evidence_count
  FROM external_web_evidence evidence
  JOIN web_result_review_items review_item
    ON review_item.external_web_evidence_id = evidence.id
   AND review_item.search_execution_id = evidence.search_execution_id
  WHERE evidence.search_execution_id = p_execution_id
    AND review_item.review_state = 'accepted';

  IF artifact_citation_count <> accepted_evidence_count
    OR (SELECT count(DISTINCT citation ->> 'canonical_url')
        FROM jsonb_array_elements(artifact.payload -> 'citations') citation) <> accepted_evidence_count
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(artifact.payload -> 'citations') citation
      LEFT JOIN external_web_evidence evidence
        ON evidence.search_execution_id = p_execution_id
       AND evidence.canonical_url = citation ->> 'canonical_url'
       AND evidence.content_hash = citation ->> 'content_hash'
      LEFT JOIN web_result_review_items review_item
        ON review_item.external_web_evidence_id = evidence.id
       AND review_item.review_state = 'accepted'
      WHERE citation ->> 'source_kind' <> 'external_web'
        OR citation ->> 'search_execution_id' <> p_execution_id::text
        OR citation ->> 'agent_task_id' <> p_task_id
        OR citation ->> 'agent_artifact_id' <> p_artifact_id
        OR review_item.external_web_evidence_id IS NULL
    )
  THEN
    RAISE EXCEPTION 'public-research citations differ from analyst-accepted evidence';
  END IF;

  INSERT INTO finding_specialist_artifacts (finding_id, analysis_run_id, task_id, artifact_id)
  SELECT link.finding_id, link.analysis_run_id, p_task_id, p_artifact_id
  FROM proposed_action_findings link
  WHERE link.proposed_action_id = execution.proposed_action_id
  ON CONFLICT DO NOTHING;

  INSERT INTO citations (
    analysis_run_id, finding_id, source_kind, external_web_evidence_id,
    agent_task_id, agent_artifact_id, locator, excerpt
  )
  SELECT execution.analysis_run_id, link.finding_id, 'external_web', evidence.id,
         p_task_id, p_artifact_id,
         evidence.title || ' — ' || evidence.publisher, evidence.excerpt
  FROM proposed_action_findings link
  JOIN external_web_evidence evidence ON evidence.search_execution_id = p_execution_id
  JOIN web_result_review_items review_item
    ON review_item.external_web_evidence_id = evidence.id
   AND review_item.review_state = 'accepted'
  WHERE link.proposed_action_id = execution.proposed_action_id;

  UPDATE web_search_executions
  SET research_status = 'succeeded', research_completed_at = p_completed_at
  WHERE id = p_execution_id;
  UPDATE analysis_runs
  SET status = 'succeeded', finished_at = p_completed_at
  WHERE id = execution.analysis_run_id AND status = 'running';
  UPDATE onboarding_cases
  SET status = 'ready_for_review', updated_at = p_completed_at
  WHERE id = execution.case_id AND active_analysis_run_id = execution.analysis_run_id;

  INSERT INTO workflow_events (
    event_id, case_id, analysis_run_id, event_type,
    correlation_id, causation_id, payload, occurred_at
  )
  SELECT gen_random_uuid()::text, execution.case_id, execution.analysis_run_id,
         'agent.artifact.available', task.correlation_id, p_task_id,
         jsonb_build_object(
           'specialty', 'public_research', 'artifact_id', p_artifact_id,
           'search_execution_id', p_execution_id
         ), p_completed_at
  FROM a2a_tasks task WHERE task.task_id = p_task_id;
  INSERT INTO workflow_events (
    event_id, case_id, analysis_run_id, event_type,
    correlation_id, causation_id, payload, occurred_at
  )
  SELECT gen_random_uuid()::text, execution.case_id, execution.analysis_run_id,
         'run.status_changed', task.correlation_id, p_task_id,
         jsonb_build_object(
           'from', 'running', 'to', 'succeeded',
           'reason', 'analyst-accepted public evidence analyzed and linked'
         ), p_completed_at
  FROM a2a_tasks task WHERE task.task_id = p_task_id;
  INSERT INTO audit_events (
    case_id, analysis_run_id, event_type, actor_type, actor_id, payload, created_at
  ) VALUES (
    execution.case_id, execution.analysis_run_id,
    'public_research.completed', 'workflow', 'public-research-coordinator',
    jsonb_build_object(
      'search_execution_id', p_execution_id, 'task_id', p_task_id,
      'artifact_id', p_artifact_id, 'citation_count', artifact_citation_count,
      'case_status', 'ready_for_review'
    ), p_completed_at
  );
  RETURN 'succeeded';
END;
$$;

COMMIT;
