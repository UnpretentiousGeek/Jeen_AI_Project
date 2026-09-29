BEGIN;

DO $$
DECLARE
  target_case_id uuid := '30000000-0000-0000-0000-000000000001';
  run_id uuid;
  finding_id uuid := gen_random_uuid();
  citation_id uuid := gen_random_uuid();
  action_id uuid := gen_random_uuid();
  review_id uuid := gen_random_uuid();
  execution_id uuid := gen_random_uuid();
  document_chunk_id uuid;
  outcome text;
  role_blocked boolean := false;
BEGIN
  UPDATE analysis_runs
  SET status = 'cancelled', finished_at = now()
  WHERE id = (
    SELECT active_analysis_run_id FROM onboarding_cases WHERE id = target_case_id
  ) AND status IN ('queued', 'running', 'suspended');

  UPDATE onboarding_cases
  SET active_analysis_run_id = NULL, status = 'draft'
  WHERE id = target_case_id;

  SELECT id INTO run_id
  FROM start_analysis_run(
    target_case_id,
    'verify:authorized-web-review',
    'Verify the dashboard web-search authorization boundary.',
    '1.1',
    DATE '2026-09-18'
  );

  UPDATE analysis_runs SET status = 'running' WHERE id = run_id;
  SELECT chunk.id INTO document_chunk_id
  FROM analysis_run_documents snapshot
  JOIN document_chunks chunk ON chunk.document_id = snapshot.document_id
  WHERE snapshot.analysis_run_id = run_id
  ORDER BY chunk.chunk_index
  LIMIT 1;

  INSERT INTO findings (
    id, analysis_run_id, requirement_code, outcome, summary, rationale, confidence
  ) VALUES (
    finding_id, run_id, 'LIC-3.1', 'uncertain',
    'The license claim needs an authoritative source.',
    'Applicant evidence does not contain a registry record.', 0.9
  );

  INSERT INTO citations (
    id, analysis_run_id, finding_id, source_kind, document_chunk_id, locator, excerpt
  ) VALUES (
    citation_id, run_id, finding_id, 'case_document', document_chunk_id,
    'License claim', 'The applicant claims a regulated financial-services license.'
  );

  PERFORM propose_web_search_action(
    action_id, review_id, run_id, target_case_id,
    'Search an official regulator for the claimed license.',
    jsonb_build_object(
      'query', 'Example Payments official license',
      'reason', 'The claim lacks authoritative support.',
      'allowed_domains', jsonb_build_array('regulator.example.gov'),
      'max_results', 3,
      'intended_use', 'Verify the claimed license.',
      'external_disclosure', jsonb_build_array('legal_name', 'claimed_license_type')
    ),
    ARRAY[finding_id], ARRAY[citation_id],
    'verify:authorized-web-review:proposal',
    'verify:authorized-web-review:correlation'
  );

  BEGIN
    PERFORM decide_web_search_action_authorized(
      review_id, action_id, run_id, target_case_id,
      'approved', 'viewer_demo',
      'Attempt a decision without the compliance analyst role.',
      now(), 'verify:authorized-web-review:blocked', execution_id,
      now() + interval '10 minutes', ARRAY['case_viewer']
    );
  EXCEPTION WHEN raise_exception THEN
    role_blocked := position('compliance analyst role' IN SQLERRM) > 0;
  END;

  IF NOT role_blocked
    OR EXISTS (SELECT 1 FROM approvals WHERE proposed_action_id = action_id)
  THEN
    RAISE EXCEPTION 'unauthorized web-search decision was not blocked before persistence';
  END IF;

  SELECT decide_web_search_action_authorized(
    review_id, action_id, run_id, target_case_id,
    'approved', 'analyst_demo',
    'The exact regulator query is necessary and proportionate.',
    now(), 'verify:authorized-web-review:approved', execution_id,
    now() + interval '10 minutes', ARRAY['compliance_analyst']
  ) INTO outcome;

  IF outcome <> 'approved'
    OR (SELECT status FROM proposed_actions WHERE id = action_id) <> 'approved'
    OR (SELECT status FROM web_search_executions WHERE id = execution_id) <> 'approved'
    OR NOT EXISTS (
      SELECT 1 FROM audit_events
      WHERE analysis_run_id = run_id
        AND event_type = 'web_search.reviewed'
        AND actor_id = 'analyst_demo'
    )
  THEN
    RAISE EXCEPTION 'authorized web-search decision was not stored atomically';
  END IF;
END;
$$;

ROLLBACK;

\echo 'Authorized web-search decision checks passed.'
