BEGIN;

CREATE OR REPLACE FUNCTION decide_web_search_action_authorized(
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
  p_expires_at timestamptz,
  p_actor_roles text[]
)
RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT ('compliance_analyst' = ANY(COALESCE(p_actor_roles, ARRAY[]::text[]))) THEN
    RAISE EXCEPTION 'compliance analyst role is required to approve web search';
  END IF;

  IF NULLIF(btrim(p_decided_by), '') IS NULL THEN
    RAISE EXCEPTION 'authenticated analyst identity is required';
  END IF;

  RETURN decide_web_search_action(
    p_review_request_id,
    p_action_id,
    p_analysis_run_id,
    p_case_id,
    p_decision,
    p_decided_by,
    p_rationale,
    p_decided_at,
    p_idempotency_key,
    p_execution_id,
    p_expires_at
  );
END;
$$;

COMMIT;
