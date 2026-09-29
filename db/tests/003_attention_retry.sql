BEGIN;

DO $$
DECLARE
  case_id uuid := '30000000-0000-0000-0000-000000000001';
  failed_run_id uuid;
  retry_run_id uuid;
  duplicate_run_id uuid;
  retry_outcome text;
  role_blocked boolean := false;
BEGIN
  SELECT id INTO failed_run_id
  FROM start_analysis_run(
    case_id,
    'verify:attention-retry:failed-source',
    'Create a transaction-local failed run for attention retry verification.',
    '1.1',
    DATE '2026-09-18'
  );
  UPDATE analysis_runs
  SET status = 'failed', finished_at = now()
  WHERE id = failed_run_id;
  UPDATE onboarding_cases
  SET status = 'attention_required', updated_at = now()
  WHERE id = case_id AND active_analysis_run_id = failed_run_id;

  BEGIN
    PERFORM retry_attention_required_run(
      case_id,
      failed_run_id,
      'viewer_demo',
      ARRAY['case_viewer'],
      'Inspect a retry without the required analyst authorization.',
      'verify:attention-retry:unauthorized'
    );
  EXCEPTION WHEN raise_exception THEN
    role_blocked := position('compliance_analyst role' IN SQLERRM) > 0;
  END;

  IF NOT role_blocked THEN
    RAISE EXCEPTION 'retry was not blocked for an unauthorized role';
  END IF;

  SELECT result.outcome, result.analysis_run_id
  INTO retry_outcome, retry_run_id
  FROM retry_attention_required_run(
    case_id,
    failed_run_id,
    'analyst_demo',
    ARRAY['compliance_analyst'],
    'The transient policy specialist failure has cleared; rerun the exact frozen inputs.',
    'verify:attention-retry:v1'
  ) result;

  IF retry_outcome <> 'stored'
    OR (SELECT status FROM analysis_runs WHERE id = retry_run_id) <> 'running'
    OR (SELECT status FROM onboarding_cases WHERE id = case_id) <> 'processing'
    OR (SELECT active_analysis_run_id FROM onboarding_cases WHERE id = case_id) <> retry_run_id
    OR (SELECT status FROM analysis_runs WHERE id = failed_run_id) <> 'failed'
  THEN
    RAISE EXCEPTION 'authorized retry did not atomically create and activate a linked run';
  END IF;

  IF (SELECT case_snapshot FROM analysis_runs WHERE id = retry_run_id)
       <> (SELECT case_snapshot FROM analysis_runs WHERE id = failed_run_id)
    OR (SELECT policy_effective_on FROM analysis_runs WHERE id = retry_run_id)
       <> (SELECT policy_effective_on FROM analysis_runs WHERE id = failed_run_id)
    OR (SELECT count(*) FROM analysis_run_documents WHERE analysis_run_id = retry_run_id)
       <> (SELECT count(*) FROM analysis_run_documents WHERE analysis_run_id = failed_run_id)
    OR (SELECT count(*) FROM analysis_run_policy_versions WHERE analysis_run_id = retry_run_id)
       <> (SELECT count(*) FROM analysis_run_policy_versions WHERE analysis_run_id = failed_run_id)
  THEN
    RAISE EXCEPTION 'retry did not preserve the failed run input snapshots exactly';
  END IF;

  SELECT result.outcome, result.analysis_run_id
  INTO retry_outcome, duplicate_run_id
  FROM retry_attention_required_run(
    case_id,
    failed_run_id,
    'analyst_demo',
    ARRAY['compliance_analyst'],
    'The transient policy specialist failure has cleared; rerun the exact frozen inputs.',
    'verify:attention-retry:v1'
  ) result;

  IF retry_outcome <> 'duplicate' OR duplicate_run_id <> retry_run_id THEN
    RAISE EXCEPTION 'retry replay was not idempotent';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM audit_events
    WHERE analysis_run_id = failed_run_id
      AND event_type = 'analysis.retry_requested'
      AND actor_type = 'analyst'
      AND actor_id = 'analyst_demo'
  ) OR NOT EXISTS (
    SELECT 1 FROM audit_events
    WHERE analysis_run_id = retry_run_id
      AND event_type = 'analysis.retry_started'
      AND payload ->> 'retry_of_analysis_run_id' = failed_run_id::text
  ) THEN
    RAISE EXCEPTION 'retry audit linkage is incomplete';
  END IF;
END;
$$;

ROLLBACK;
