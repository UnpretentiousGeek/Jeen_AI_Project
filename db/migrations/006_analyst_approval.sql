BEGIN;

ALTER TABLE proposed_actions
  ADD COLUMN IF NOT EXISTS summary text;

ALTER TABLE proposed_actions DROP CONSTRAINT IF EXISTS proposed_actions_action_type_check;
ALTER TABLE proposed_actions DROP CONSTRAINT IF EXISTS proposed_actions_status_check;

ALTER TABLE proposed_actions
  ADD CONSTRAINT proposed_actions_action_type_check CHECK (action_type IN (
    'record_information_request', 'mark_ready_for_review',
    'create_enhanced_review_task', 'close_case', 'run_web_search'
  )),
  ADD CONSTRAINT proposed_actions_status_check CHECK (status IN (
    'pending', 'approved', 'rejected', 'changes_requested', 'executed', 'failed'
  )),
  ADD CONSTRAINT proposed_actions_run_identity_unique
    UNIQUE (id, analysis_run_id),
  ADD CONSTRAINT proposed_actions_identity_unique
    UNIQUE (id, analysis_run_id, case_id);

ALTER TABLE citations
  ADD CONSTRAINT citations_run_identity_unique UNIQUE (id, analysis_run_id);

CREATE TABLE review_requests (
  id uuid PRIMARY KEY,
  proposed_action_id uuid NOT NULL,
  analysis_run_id uuid NOT NULL,
  case_id uuid NOT NULL,
  correlation_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'decided', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  FOREIGN KEY (proposed_action_id, analysis_run_id, case_id)
    REFERENCES proposed_actions(id, analysis_run_id, case_id),
  UNIQUE (proposed_action_id),
  CHECK ((status = 'decided') = (decided_at IS NOT NULL))
);

CREATE TABLE proposed_action_findings (
  proposed_action_id uuid NOT NULL,
  analysis_run_id uuid NOT NULL,
  finding_id uuid NOT NULL,
  PRIMARY KEY (proposed_action_id, finding_id),
  FOREIGN KEY (proposed_action_id, analysis_run_id)
    REFERENCES proposed_actions(id, analysis_run_id),
  FOREIGN KEY (finding_id, analysis_run_id)
    REFERENCES findings(id, analysis_run_id)
);

CREATE TABLE proposed_action_citations (
  proposed_action_id uuid NOT NULL,
  analysis_run_id uuid NOT NULL,
  citation_id uuid NOT NULL,
  PRIMARY KEY (proposed_action_id, citation_id),
  FOREIGN KEY (proposed_action_id, analysis_run_id)
    REFERENCES proposed_actions(id, analysis_run_id),
  FOREIGN KEY (citation_id, analysis_run_id)
    REFERENCES citations(id, analysis_run_id)
);

ALTER TABLE approvals
  ADD COLUMN review_request_id uuid UNIQUE REFERENCES review_requests(id),
  ADD COLUMN idempotency_key text UNIQUE;

ALTER TABLE approvals
  ALTER COLUMN rationale SET NOT NULL,
  ALTER COLUMN review_request_id SET NOT NULL,
  ALTER COLUMN idempotency_key SET NOT NULL;

CREATE TABLE information_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposed_action_id uuid NOT NULL UNIQUE REFERENCES proposed_actions(id),
  analysis_run_id uuid NOT NULL,
  case_id uuid NOT NULL REFERENCES onboarding_cases(id),
  recipient text NOT NULL,
  subject text NOT NULL,
  requested_items jsonb NOT NULL,
  delivery_channel text NOT NULL CHECK (delivery_channel = 'case_portal'),
  status text NOT NULL DEFAULT 'recorded' CHECK (status = 'recorded'),
  idempotency_key text NOT NULL UNIQUE,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (analysis_run_id, case_id) REFERENCES analysis_runs(id, case_id),
  CHECK (jsonb_typeof(requested_items) = 'array' AND jsonb_array_length(requested_items) > 0)
);

CREATE OR REPLACE FUNCTION propose_information_request_action(
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
      AND existing_action.action_type = 'record_information_request'
      AND existing_action.summary = p_summary
      AND existing_action.payload = p_payload
      AND existing_action.idempotency_key = p_idempotency_key
      AND (
        SELECT array_agg(link.finding_id ORDER BY link.finding_id)
        FROM proposed_action_findings link
        WHERE link.proposed_action_id = p_action_id
      ) IS NOT DISTINCT FROM (
        SELECT array_agg(item.finding_id ORDER BY item.finding_id)
        FROM unnest(p_finding_ids) AS item(finding_id)
      )
      AND (
        SELECT array_agg(link.citation_id ORDER BY link.citation_id)
        FROM proposed_action_citations link
        WHERE link.proposed_action_id = p_action_id
      ) IS NOT DISTINCT FROM (
        SELECT array_agg(item.citation_id ORDER BY item.citation_id)
        FROM unnest(p_citation_ids) AS item(citation_id)
      )
      AND EXISTS (
        SELECT 1 FROM review_requests review
        WHERE review.id = p_review_request_id
          AND review.proposed_action_id = p_action_id
      )
    THEN
      RETURN 'duplicate';
    END IF;
    RAISE EXCEPTION 'proposed action identity conflicts with an existing action';
  END IF;

  SELECT * INTO target_run
  FROM analysis_runs
  WHERE id = p_analysis_run_id AND case_id = p_case_id
  FOR UPDATE;

  IF NOT FOUND OR target_run.status <> 'running' THEN
    RAISE EXCEPTION 'analysis run must be running before an action is proposed';
  END IF;
  IF NULLIF(btrim(p_summary), '') IS NULL
    OR p_payload ->> 'delivery_channel' <> 'case_portal'
    OR NULLIF(btrim(p_payload ->> 'recipient'), '') IS NULL
    OR NULLIF(btrim(p_payload ->> 'subject'), '') IS NULL
    OR jsonb_typeof(p_payload -> 'requested_items') <> 'array'
    OR jsonb_array_length(p_payload -> 'requested_items') = 0
  THEN
    RAISE EXCEPTION 'information-request proposal payload is invalid';
  END IF;
  IF cardinality(p_finding_ids) = 0 OR cardinality(p_citation_ids) = 0 THEN
    RAISE EXCEPTION 'information-request proposal requires findings and citations';
  END IF;
  IF (SELECT count(*) FROM findings
      WHERE analysis_run_id = p_analysis_run_id AND id = ANY(p_finding_ids))
      <> cardinality(p_finding_ids)
    OR (SELECT count(*) FROM citations
        WHERE analysis_run_id = p_analysis_run_id AND id = ANY(p_citation_ids))
      <> cardinality(p_citation_ids)
  THEN
    RAISE EXCEPTION 'proposal references findings or citations outside the analysis run';
  END IF;

  INSERT INTO proposed_actions (
    id, analysis_run_id, case_id, action_type, summary, payload,
    status, idempotency_key
  ) VALUES (
    p_action_id, p_analysis_run_id, p_case_id, 'record_information_request',
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
    jsonb_build_object(
      'request_id', p_review_request_id,
      'proposed_action_id', p_action_id
    )
  ),
  (
    gen_random_uuid()::text, p_case_id, p_analysis_run_id,
    'run.status_changed', p_correlation_id, p_action_id::text,
    jsonb_build_object(
      'from', 'running', 'to', 'suspended', 'reason', 'analyst approval required'
    )
  );

  INSERT INTO audit_events (
    case_id, analysis_run_id, event_type, actor_type, payload
  ) VALUES (
    p_case_id, p_analysis_run_id, 'proposed_action.created', 'workflow',
    jsonb_build_object('proposed_action_id', p_action_id, 'review_request_id', p_review_request_id)
  );

  RETURN 'stored';
END;
$$;

CREATE OR REPLACE FUNCTION decide_information_request_action(
  p_review_request_id uuid,
  p_action_id uuid,
  p_analysis_run_id uuid,
  p_case_id uuid,
  p_decision text,
  p_decided_by text,
  p_rationale text,
  p_decided_at timestamptz,
  p_idempotency_key text
)
RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  review review_requests%ROWTYPE;
  action proposed_actions%ROWTYPE;
  existing_approval approvals%ROWTYPE;
BEGIN
  SELECT * INTO review
  FROM review_requests
  WHERE id = p_review_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'review request does not exist';
  END IF;

  SELECT * INTO action
  FROM proposed_actions
  WHERE id = review.proposed_action_id
  FOR UPDATE;

  SELECT * INTO existing_approval
  FROM approvals
  WHERE proposed_action_id = p_action_id OR idempotency_key = p_idempotency_key;

  IF FOUND THEN
    IF existing_approval.proposed_action_id = p_action_id
      AND existing_approval.review_request_id = p_review_request_id
      AND existing_approval.decision = p_decision
      AND existing_approval.decided_by = p_decided_by
      AND existing_approval.rationale = p_rationale
      AND existing_approval.decided_at = p_decided_at
      AND existing_approval.idempotency_key = p_idempotency_key
    THEN
      RETURN 'duplicate';
    END IF;
    RAISE EXCEPTION 'proposed action has already received a different decision';
  END IF;

  IF review.proposed_action_id <> p_action_id
    OR review.analysis_run_id <> p_analysis_run_id
    OR review.case_id <> p_case_id
    OR action.analysis_run_id <> p_analysis_run_id
    OR action.case_id <> p_case_id
  THEN
    RAISE EXCEPTION 'review decision does not match the proposed action scope';
  END IF;
  IF review.status <> 'pending' OR action.status <> 'pending' THEN
    RAISE EXCEPTION 'proposed action is no longer pending approval';
  END IF;
  IF p_decision NOT IN ('approved', 'rejected', 'changes_requested')
    OR NULLIF(btrim(p_decided_by), '') IS NULL
    OR NULLIF(btrim(p_rationale), '') IS NULL
  THEN
    RAISE EXCEPTION 'review decision is invalid';
  END IF;

  INSERT INTO approvals (
    proposed_action_id, review_request_id, decision, decided_by,
    rationale, decided_at, idempotency_key
  ) VALUES (
    p_action_id, p_review_request_id, p_decision, p_decided_by,
    p_rationale, p_decided_at, p_idempotency_key
  );

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
    p_case_id, p_analysis_run_id, 'human.review.decided', 'analyst', p_decided_by,
    jsonb_build_object(
      'review_request_id', p_review_request_id,
      'proposed_action_id', p_action_id,
      'decision', p_decision,
      'rationale', p_rationale,
      'idempotency_key', p_idempotency_key
    ),
    p_decided_at
  );

  IF p_decision = 'approved' THEN
    UPDATE proposed_actions SET status = 'approved' WHERE id = p_action_id;

    INSERT INTO information_requests (
      proposed_action_id, analysis_run_id, case_id, recipient, subject,
      requested_items, delivery_channel, idempotency_key, recorded_at
    ) VALUES (
      p_action_id, p_analysis_run_id, p_case_id,
      action.payload ->> 'recipient', action.payload ->> 'subject',
      action.payload -> 'requested_items', action.payload ->> 'delivery_channel',
      action.idempotency_key, p_decided_at
    );

    UPDATE proposed_actions
    SET status = 'executed',
        execution_result = jsonb_build_object(
          'information_request_id', (
            SELECT id FROM information_requests WHERE proposed_action_id = p_action_id
          ),
          'status', 'recorded'
        )
    WHERE id = p_action_id;

    UPDATE analysis_runs
    SET status = 'succeeded', finished_at = p_decided_at
    WHERE id = p_analysis_run_id AND status = 'suspended';

    UPDATE onboarding_cases
    SET status = 'awaiting_information', updated_at = p_decided_at
    WHERE id = p_case_id;

    INSERT INTO workflow_events (
      event_id, case_id, analysis_run_id, event_type,
      correlation_id, causation_id, payload, occurred_at
    ) VALUES
    (
      gen_random_uuid()::text, p_case_id, p_analysis_run_id,
      'action.executed', review.correlation_id, p_review_request_id::text,
      jsonb_build_object(
        'proposed_action_id', p_action_id,
        'idempotency_key', action.idempotency_key
      ),
      p_decided_at
    ),
    (
      gen_random_uuid()::text, p_case_id, p_analysis_run_id,
      'run.status_changed', review.correlation_id, p_action_id::text,
      jsonb_build_object(
        'from', 'suspended', 'to', 'succeeded', 'reason', 'approved action recorded'
      ),
      p_decided_at
    );

    INSERT INTO audit_events (
      case_id, analysis_run_id, event_type, actor_type, actor_id, payload, created_at
    ) VALUES (
      p_case_id, p_analysis_run_id, 'action.executed', 'system', NULL,
      jsonb_build_object(
        'proposed_action_id', p_action_id,
        'action_type', 'record_information_request',
        'idempotency_key', action.idempotency_key
      ),
      p_decided_at
    );

    RETURN 'executed';
  END IF;

  UPDATE proposed_actions SET status = p_decision WHERE id = p_action_id;
  UPDATE analysis_runs SET status = 'running' WHERE id = p_analysis_run_id;
  UPDATE onboarding_cases
  SET status = 'processing', updated_at = p_decided_at
  WHERE id = p_case_id;

  INSERT INTO workflow_events (
    event_id, case_id, analysis_run_id, event_type,
    correlation_id, causation_id, payload, occurred_at
  ) VALUES (
    gen_random_uuid()::text, p_case_id, p_analysis_run_id,
    'run.status_changed', review.correlation_id, p_action_id::text,
    jsonb_build_object(
      'from', 'suspended', 'to', 'running', 'reason', 'proposed action was not approved'
    ),
    p_decided_at
  );

  RETURN p_decision;
END;
$$;

COMMIT;
