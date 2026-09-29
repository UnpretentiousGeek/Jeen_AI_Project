\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
  applicant_id uuid;
  application_id uuid;
  v_case_id uuid;
  source_run record;
  started jsonb;
  coordinator_id uuid;
  checkpoint_request jsonb;
  expected_version bigint;
  applied jsonb;
  replay jsonb;
  gap_id uuid := gen_random_uuid();
  revision_gap_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO applicants (legal_name, jurisdiction, business_type, product)
  VALUES ('Rejected Search Test Ltd', 'GB', 'software', 'payments')
  RETURNING id INTO applicant_id;
  INSERT INTO applications (applicant_id, submitted_payload)
  VALUES (applicant_id, '{}'::jsonb) RETURNING id INTO application_id;
  INSERT INTO onboarding_cases (application_id, applicant_id, reference)
  VALUES (application_id, applicant_id, 'KYB-REJECT-SEARCH-' || left(gen_random_uuid()::text, 8))
  RETURNING id INTO v_case_id;
  INSERT INTO analysis_runs (
    case_id, session_id, status, output_schema_version, policy_effective_on, case_snapshot
  ) VALUES (
    v_case_id, 'rejected-search-test-' || gen_random_uuid()::text, 'queued',
    '3.4.0', CURRENT_DATE, '{}'::jsonb
  ) RETURNING id, case_id, session_id INTO source_run;
  UPDATE onboarding_cases SET active_analysis_run_id = source_run.id WHERE id = v_case_id;
  INSERT INTO evidence_gaps (id, analysis_run_id, requirement_code, description, requested_evidence)
  VALUES (gap_id, source_run.id, 'LIC-SEARCH-1',
          'The claimed license has not been independently verified.',
          'An official registry record or equivalent evidence.');

  started := start_or_resume_simple_coordinator_v3(
    source_run.id, source_run.case_id, source_run.session_id,
    'rejected-search-test-flow', 'rejected-search-test-job',
    'Assess the applicant using the available evidence.', 8
  );
  coordinator_id := (started->>'coordinator_run_id')::uuid;
  checkpoint_request := jsonb_build_object(
    'schema_version', '1.0',
    'checkpoint_id', gen_random_uuid(),
    'request_id', 'rejected-search-test-request',
    'checkpoint_version', 1,
    'parent_checkpoint_id', NULL,
    'parent_request_id', NULL,
    'originating_task_id', NULL,
    'originating_context_id', NULL,
    'checkpoint_kind', 'search_execution_approval',
    'title', 'Review proposed web search',
    'explanation', 'This search would address the documented licensing gap.',
    'allowed_actions', jsonb_build_array('approve', 'changes_requested', 'reject', 'skip_for_now'),
    'payload', jsonb_build_object(
      'approved_scope', jsonb_build_object(
        'evidence_gap_id', gap_id,
        'claim_id', 'licensing-claim',
        'claim', 'The applicant holds the claimed license.',
        'query', 'Applicant license registry',
        'allowed_domains', jsonb_build_array('regulator.example'),
        'disclosed_applicant_fields', jsonb_build_array('legal_name'),
        'result_limit', 1,
        'rationale', 'Resolve the licensing gap.'
      ),
      'scope_hash', repeat('a', 64),
      'operation_key', 'rejected-search-test-operation'
    )
  );
  PERFORM create_simple_coordinator_v3_checkpoint(
    coordinator_id, checkpoint_request, 'rejected-search-test-checkpoint'
  );
  SELECT checkpoint.expected_state_version INTO expected_version
  FROM coordinator_v3_checkpoints checkpoint
  WHERE checkpoint.analysis_run_id = source_run.id
    AND checkpoint.request_id = 'rejected-search-test-request';

  applied := apply_simple_coordinator_v3_checkpoint_decision(
    source_run.id, 'rejected-search-test-request', expected_version,
    'reject', '{"comment":"Use the submitted documents."}'::jsonb,
    'test-analyst', 'rejected-search-test-decision'
  );
  IF applied->>'status' <> 'applied'
     OR (SELECT phase FROM coordinator_v3_runs WHERE id = coordinator_id) <> 'running'
     OR (SELECT status FROM analysis_runs WHERE id = source_run.id) <> 'running'
     OR (SELECT status FROM onboarding_cases WHERE id = source_run.case_id) <> 'processing'
     OR (SELECT status FROM coordinator_v3_checkpoints
         WHERE analysis_run_id = source_run.id AND request_id = 'rejected-search-test-request') <> 'rejected'
     OR (SELECT state->'rejected_searches'->0->>'evidence_gap_id'
         FROM coordinator_v3_runs WHERE id = coordinator_id) <> gap_id::text
     OR (SELECT state->'rejected_searches'->0->>'outcome'
         FROM coordinator_v3_runs WHERE id = coordinator_id) <> 'web_search_not_performed'
     OR NOT EXISTS (SELECT 1 FROM evidence_gaps WHERE id = gap_id AND analysis_run_id = source_run.id)
     OR EXISTS (SELECT 1 FROM web_search_executions WHERE analysis_run_id = source_run.id) THEN
    RAISE EXCEPTION 'rejecting a search did not continue safely with a visible evidence gap';
  END IF;

  replay := apply_simple_coordinator_v3_checkpoint_decision(
    source_run.id, 'rejected-search-test-request', expected_version,
    'reject', '{"comment":"Use the submitted documents."}'::jsonb,
    'test-analyst', 'rejected-search-test-decision'
  );
  IF replay->>'status' <> 'duplicate_suppressed'
     OR (SELECT jsonb_array_length(state->'rejected_searches')
         FROM coordinator_v3_runs WHERE id = coordinator_id) <> 1 THEN
    RAISE EXCEPTION 'replaying a rejected search changed the coordinator state';
  END IF;

  INSERT INTO evidence_gaps (id, analysis_run_id, requirement_code, description, requested_evidence)
  VALUES (revision_gap_id, source_run.id, 'REVISION-1',
          'A second claim needs a better search scope.', 'A relevant source for the second claim.');
  checkpoint_request := checkpoint_request || jsonb_build_object(
    'checkpoint_id', gen_random_uuid(),
    'request_id', 'revised-search-test-request',
    'payload', checkpoint_request->'payload' || jsonb_build_object(
      'approved_scope', checkpoint_request->'payload'->'approved_scope' ||
        jsonb_build_object('evidence_gap_id', revision_gap_id)
    )
  );
  PERFORM create_simple_coordinator_v3_checkpoint(
    coordinator_id, checkpoint_request, 'revised-search-test-checkpoint'
  );
  SELECT checkpoint.expected_state_version INTO expected_version
  FROM coordinator_v3_checkpoints checkpoint
  WHERE checkpoint.analysis_run_id = source_run.id
    AND checkpoint.request_id = 'revised-search-test-request';
  applied := apply_simple_coordinator_v3_checkpoint_decision(
    source_run.id, 'revised-search-test-request', expected_version,
    'changes_requested', '{"requested_changes":{"comment":"Narrow the query."}}'::jsonb,
    'test-analyst', 'revised-search-test-decision'
  );
  IF applied->>'status' <> 'applied'
     OR (SELECT phase FROM coordinator_v3_runs WHERE id = coordinator_id) <> 'running'
     OR (SELECT state->'search_revision_request'->>'evidence_gap_id'
         FROM coordinator_v3_runs WHERE id = coordinator_id) <> revision_gap_id::text
     OR EXISTS (
       SELECT 1 FROM coordinator_v3_checkpoints
       WHERE analysis_run_id = source_run.id
         AND request_id LIKE 'revised-search-test-request:v%'
     ) THEN
    RAISE EXCEPTION 'request changes did not return control for a new search proposal';
  END IF;
END;
$$;

ROLLBACK;

SELECT 'rejected search continues without execution and preserves the gap' AS result;
