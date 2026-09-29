BEGIN;

ALTER TABLE human_input_requests
  ADD COLUMN submission_rationale text;

CREATE OR REPLACE FUNCTION submit_human_input_response_authorized(
  p_request_id uuid,
  p_case_id uuid,
  p_analysis_run_id uuid,
  p_response jsonb,
  p_submitted_by text,
  p_submitted_at timestamptz,
  p_idempotency_key text,
  p_rationale text,
  p_actor_roles text[]
)
RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  outcome text;
  stored_rationale text;
BEGIN
  IF NOT ('compliance_analyst' = ANY(COALESCE(p_actor_roles, ARRAY[]::text[]))) THEN
    RAISE EXCEPTION 'compliance analyst role is required to submit clarification';
  END IF;
  IF NULLIF(btrim(p_submitted_by), '') IS NULL THEN
    RAISE EXCEPTION 'authenticated analyst identity is required';
  END IF;
  IF length(btrim(COALESCE(p_rationale, ''))) NOT BETWEEN 10 AND 1000 THEN
    RAISE EXCEPTION 'clarification rationale must be between 10 and 1000 characters';
  END IF;

  SELECT submit_human_input_response(
    p_request_id, p_case_id, p_analysis_run_id, p_response,
    p_submitted_by, p_submitted_at, p_idempotency_key
  ) INTO outcome;

  IF outcome = 'stored' THEN
    UPDATE human_input_requests
    SET submission_rationale = btrim(p_rationale)
    WHERE id = p_request_id;

    INSERT INTO audit_events (
      case_id, analysis_run_id, event_type, actor_type, actor_id, payload, created_at
    ) VALUES (
      p_case_id, p_analysis_run_id, 'human_input.response_submitted',
      'analyst', p_submitted_by,
      jsonb_build_object(
        'request_id', p_request_id,
        'input_type', p_response ->> 'input_type',
        'rationale', btrim(p_rationale)
      ), p_submitted_at
    );
    RETURN outcome;
  END IF;

  SELECT submission_rationale INTO stored_rationale
  FROM human_input_requests
  WHERE id = p_request_id;
  IF stored_rationale IS DISTINCT FROM btrim(p_rationale) THEN
    RAISE EXCEPTION 'clarification idempotency key is already associated with another rationale';
  END IF;
  RETURN outcome;
END;
$$;

COMMIT;
