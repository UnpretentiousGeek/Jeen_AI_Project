BEGIN;

DO $$
DECLARE
  target_case_id uuid := '30000000-0000-0000-0000-000000000002';
  run_id uuid;
  request_id uuid;
  outcome text;
  role_blocked boolean := false;
BEGIN
  SELECT onboarding_case.active_analysis_run_id INTO run_id
  FROM onboarding_cases onboarding_case
  WHERE onboarding_case.id = target_case_id;

  SELECT input_request.id INTO request_id
  FROM human_input_requests input_request
  WHERE input_request.analysis_run_id = run_id
    AND input_request.request_type = 'clarification'
    AND input_request.status = 'pending'
  ORDER BY input_request.created_at DESC
  LIMIT 1;

  IF run_id IS NULL OR request_id IS NULL THEN
    RAISE EXCEPTION 'synthetic interrupted case is missing its pending clarification';
  END IF;

  BEGIN
    PERFORM submit_human_input_response_authorized(
      request_id, target_case_id, run_id,
      '{"input_type":"text","value":"14 King Street is current."}'::jsonb,
      'viewer_demo', now(), 'verify:clarification:blocked',
      'Attempt without the required analyst role.', ARRAY['case_viewer']
    );
  EXCEPTION WHEN raise_exception THEN
    role_blocked := position('compliance analyst role' IN SQLERRM) > 0;
  END;

  IF NOT role_blocked
    OR (SELECT status FROM human_input_requests WHERE id = request_id) <> 'pending'
  THEN
    RAISE EXCEPTION 'unauthorized clarification response was not blocked';
  END IF;

  SELECT submit_human_input_response_authorized(
    request_id, target_case_id, run_id,
    '{"input_type":"text","value":"14 King Street is current."}'::jsonb,
    'analyst_demo', '2026-09-19T22:00:00.000Z',
    'verify:clarification:authorized',
    'Confirmed against the applicant signed clarification.',
    ARRAY['compliance_analyst']
  ) INTO outcome;

  IF outcome <> 'stored'
    OR (SELECT status FROM human_input_requests WHERE id = request_id) <> 'answered'
    OR (SELECT submission_rationale FROM human_input_requests WHERE id = request_id)
      <> 'Confirmed against the applicant signed clarification.'
    OR (SELECT status FROM analysis_runs WHERE id = run_id) <> 'running'
    OR (SELECT status FROM onboarding_cases WHERE id = target_case_id) <> 'processing'
    OR NOT EXISTS (
      SELECT 1 FROM audit_events
      WHERE analysis_run_id = run_id
        AND event_type = 'human_input.response_submitted'
        AND actor_id = 'analyst_demo'
        AND payload ->> 'rationale' = 'Confirmed against the applicant signed clarification.'
    )
  THEN
    RAISE EXCEPTION 'authorized clarification response was not stored atomically';
  END IF;

  SELECT submit_human_input_response_authorized(
    request_id, target_case_id, run_id,
    '{"input_type":"text","value":"14 King Street is current."}'::jsonb,
    'analyst_demo', '2026-09-19T22:00:00.000Z',
    'verify:clarification:authorized',
    'Confirmed against the applicant signed clarification.',
    ARRAY['compliance_analyst']
  ) INTO outcome;
  IF outcome <> 'duplicate' THEN
    RAISE EXCEPTION 'identical clarification retry was not idempotent';
  END IF;
END;
$$;

ROLLBACK;

\echo 'Authorized clarification submission checks passed.'
