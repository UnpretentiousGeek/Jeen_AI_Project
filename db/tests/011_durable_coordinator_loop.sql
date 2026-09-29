\set ON_ERROR_STOP on

-- Durable coordinator-loop seam tests.  The surrounding test runner applies this
-- file in a transaction, so all rows created here are disposable.
BEGIN;

DO $$
DECLARE
  source_run analysis_runs%ROWTYPE;
  v_run_id uuid := gen_random_uuid();
  job_id text := 'durable-loop-test-' || replace(v_run_id::text, '-', '');
  first jsonb;
  replay jsonb;
  before_iteration integer;
  before_version bigint;
  action_id uuid := gen_random_uuid();
  review_id uuid := gen_random_uuid();
  approval_id uuid := gen_random_uuid();
  execution_id uuid := gen_random_uuid();
  result_id uuid := gen_random_uuid();
  rejected_result_id uuid := gen_random_uuid();
  result jsonb;
  web_payload jsonb;
BEGIN
  SELECT * INTO source_run FROM analysis_runs LIMIT 1;
  IF source_run.id IS NULL THEN
    RAISE EXCEPTION 'durable loop test requires an analysis_runs fixture';
  END IF;

  INSERT INTO coordinator_v3_runs(
    id, analysis_run_id, case_id, langflow_job_id, session_id, scenario,
    engine_version, max_iterations
  ) VALUES (
    v_run_id, source_run.id, source_run.case_id, job_id, job_id || '-session',
    'complete', 'durable-loop-v1', 2
  );

  INSERT INTO proposed_actions(
    id, analysis_run_id, case_id, action_type, payload, status, idempotency_key, summary
  ) VALUES (
    action_id, source_run.id, source_run.case_id, 'run_web_search', '{}', 'approved',
    'durable-loop-test-action-' || action_id, 'Durable-loop test search'
  );
  INSERT INTO review_requests(
    id, proposed_action_id, analysis_run_id, case_id, correlation_id, status, decided_at
  ) VALUES (
    review_id, action_id, source_run.id, source_run.case_id,
    'durable-loop-test-review-' || action_id, 'decided', clock_timestamp()
  );
  INSERT INTO approvals(
    id, proposed_action_id, decision, decided_by, rationale, review_request_id, idempotency_key
  ) VALUES (
    approval_id, action_id, 'approved', 'durable-loop-test', 'Approved for seam test',
    review_id, 'durable-loop-test-approval-' || approval_id
  );
  INSERT INTO web_search_executions(
    id, proposed_action_id, approval_id, analysis_run_id, case_id, query,
    allowed_domains, max_results, intended_use, external_disclosure,
    scope_hash, status, expires_at
  ) VALUES (
    execution_id, action_id, approval_id, source_run.id, source_run.case_id,
    'durable loop test query', ARRAY['example.test'], 1, 'seam test', ARRAY['legal_name'],
    repeat('a', 64), 'approved', clock_timestamp() + interval '1 hour'
  );
  INSERT INTO coordinator_v3_checkpoints(
    analysis_run_id, case_id, langflow_job_id, checkpoint_kind, request_id,
    prompt, status, request_payload, checkpoint_version, expected_state_version
  ) VALUES (
    source_run.id, source_run.case_id, job_id, 'analyst_approval', 'review-1',
    'Durable loop seam review', 'pending',
    '{"request_id":"review-1","kind":"analyst_approval","allowed_actions":["approve","reject","skip_for_now"],"expected_state_version":2}'::jsonb,
    1, 2
  );

  IF (SELECT state_version FROM coordinator_v3_runs WHERE id = v_run_id) <> 0
    OR (SELECT current_iteration FROM coordinator_v3_runs WHERE id = v_run_id) <> 0
    OR (SELECT phase FROM coordinator_v3_runs WHERE id = v_run_id) <> 'running' THEN
    RAISE EXCEPTION 'durable run defaults were not applied';
  END IF;

  first := commit_coordinator_v3_directive(
    v_run_id, 0,
    '{"state":{"step":"one"}}'::jsonb,
    '{"schema_version":"1.0","route":"CONTINUE"}'::jsonb,
    encode(digest('{"state":{"step":"one"}}', 'sha256'), 'hex'),
    encode(digest('{"state":{"step":"one"}}', 'sha256'), 'hex'),
    'committed'
  );
  IF first->>'status' <> 'committed'
    OR (first->>'iteration_no')::integer <> 1
    OR (first->>'state_version')::bigint <> 1 THEN
    RAISE EXCEPTION 'first directive did not atomically advance the durable run';
  END IF;
  IF (commit_coordinator_v3_directive(
        v_run_id, 0, '{"state":{"step":"one"}}'::jsonb,
        '{"schema_version":"1.0","route":"CONTINUE"}'::jsonb,
        encode(digest('{"state":{"step":"one"}}', 'sha256'), 'hex'),
        encode(digest('{"state":{"step":"one"}}', 'sha256'), 'hex'), 'committed'
      )->>'status') <> 'duplicate_suppressed' THEN
    RAISE EXCEPTION 'identical directive replay was not deduplicated';
  END IF;

  before_iteration := (SELECT current_iteration FROM coordinator_v3_runs WHERE id = v_run_id);
  before_version := (SELECT state_version FROM coordinator_v3_runs WHERE id = v_run_id);
  BEGIN
    PERFORM commit_coordinator_v3_directive(
      v_run_id, 0, '{}'::jsonb, '{"schema_version":"1.0"}'::jsonb,
      repeat('0', 64), repeat('1', 64), 'committed'
    );
    RAISE EXCEPTION 'stale state_version was accepted';
  EXCEPTION WHEN SQLSTATE '40001' THEN NULL;
  END;
  IF (SELECT current_iteration FROM coordinator_v3_runs WHERE id = v_run_id) <> before_iteration
    OR (SELECT state_version FROM coordinator_v3_runs WHERE id = v_run_id) <> before_version THEN
    RAISE EXCEPTION 'stale directive changed durable state';
  END IF;

  PERFORM commit_coordinator_v3_directive(
    v_run_id, 1, '{}'::jsonb, '{"schema_version":"1.0"}'::jsonb,
    repeat('0', 64), repeat('1', 64), 'committed'
  );
  BEGIN
    INSERT INTO coordinator_v3_checkpoints(
      analysis_run_id, case_id, langflow_job_id, checkpoint_kind, request_id,
      prompt, status, request_payload
    ) VALUES (
      source_run.id, source_run.case_id, job_id, 'analyst_approval', 'review-2',
      'Second pending checkpoint', 'pending',
      '{"request_id":"review-2","kind":"analyst_approval","allowed_actions":[],"expected_state_version":2}'::jsonb
    );
    RAISE EXCEPTION 'multiple pending durable checkpoints were accepted';
  EXCEPTION WHEN SQLSTATE '23505' THEN NULL;
  END;
  BEGIN
    PERFORM commit_coordinator_v3_directive(
      v_run_id, 2, '{}'::jsonb, '{"schema_version":"1.0"}'::jsonb,
      repeat('2', 64), repeat('3', 64), 'committed'
    );
    RAISE EXCEPTION 'max_iterations was not enforced';
  EXCEPTION WHEN SQLSTATE '54000' THEN NULL;
  END;

  IF NOT EXISTS (
    SELECT 1 FROM coordinator_v3_checkpoints checkpoint
    WHERE checkpoint.analysis_run_id = source_run.id
      AND checkpoint.langflow_job_id = job_id
      AND checkpoint.request_id = 'review-1'
      AND checkpoint.status = 'pending'
      AND checkpoint.checkpoint_version = 1
      AND checkpoint.expected_state_version = 2
  ) THEN
    RAISE EXCEPTION 'durable checkpoint fixture did not remain pending at version 2';
  END IF;

  replay := apply_coordinator_v3_human_decision(
    v_run_id, 'review-1', 1, 2, 'reject', '{"reason":"test"}'::jsonb,
    'tester', 'durable-loop-test-decision-1'
  );
  IF replay->>'status' <> 'applied'
    OR (SELECT current_iteration FROM coordinator_v3_runs WHERE id = v_run_id) <> 2 THEN
    RAISE EXCEPTION 'human decision unexpectedly advanced the loop';
  END IF;

  replay := apply_coordinator_v3_human_decision(
    v_run_id, 'review-1', 1, 2, 'reject', '{"reason":"test"}'::jsonb,
    'tester', 'durable-loop-test-decision-1'
  );
  IF replay->>'status' <> 'duplicate_suppressed'
    OR (SELECT count(*) FROM coordinator_v3_human_decisions decisions WHERE decisions.run_id = v_run_id) <> 1 THEN
    RAISE EXCEPTION 'identical human replay was not deduplicated';
  END IF;
  INSERT INTO coordinator_v3_checkpoints(
    analysis_run_id, case_id, langflow_job_id, checkpoint_kind, request_id,
    prompt, status, request_payload, checkpoint_version, expected_state_version
  ) VALUES (
    source_run.id, source_run.case_id, job_id, 'analyst_approval', 'review-stale',
    'Stale review', 'pending', '{"request_id":"review-stale","kind":"analyst_approval","allowed_actions":[],"expected_state_version":1}'::jsonb, 1, 1
  );
  BEGIN
    PERFORM apply_coordinator_v3_human_decision(
      v_run_id, 'review-stale', 1, 1, 'approve', '{}'::jsonb,
      'tester', 'durable-loop-test-stale'
    );
    RAISE EXCEPTION 'stale human decision was accepted';
  EXCEPTION WHEN SQLSTATE '40001' THEN NULL;
  END;

  BEGIN
    PERFORM apply_coordinator_v3_human_decision(
      v_run_id, 'review-1', 1, 2, 'approve', '{"reason":"test"}'::jsonb,
      'tester', 'durable-loop-test-decision-2'
    );
    RAISE EXCEPTION 'conflicting human replay was accepted';
  EXCEPTION WHEN SQLSTATE '23P01' THEN NULL;
  END;

  web_payload := jsonb_build_object(
      'search_execution_id', execution_id, 'approval_id', approval_id,
      'approved_scope', jsonb_build_object('query', 'durable loop test query', 'allowed_domains', jsonb_build_array('example.test'), 'max_results', 1),
      'query', 'durable loop test query', 'url', 'https://example.test/a',
      'canonical_url', 'https://example.test/a', 'title', 'Test result',
      'publisher', 'Example', 'retrieved_at', '2026-09-20T00:00:00Z',
      'excerpt', 'Durable loop result', 'checksum', 'sha256:' || repeat('b', 64)
  );
  result := record_coordinator_v3_web_result(
    execution_id, approval_id, source_run.id, source_run.case_id, result_id, web_payload
  );
  IF result->>'status' <> 'stored' THEN RAISE EXCEPTION 'web result was not stored'; END IF;
  IF (SELECT retrieval_method FROM external_web_evidence WHERE id = result_id) <> 'tinyfish_fetch' THEN
    RAISE EXCEPTION 'a fetched page without a retrieval method was not recorded as tinyfish_fetch';
  END IF;
  result := record_coordinator_v3_web_result(
    execution_id, approval_id, source_run.id, source_run.case_id, result_id, web_payload
  );
  IF result->>'status' <> 'duplicate_suppressed' THEN RAISE EXCEPTION 'same web result was not deduplicated'; END IF;
  BEGIN
    PERFORM record_coordinator_v3_web_result(
      execution_id, approval_id, source_run.id, source_run.case_id, result_id,
      jsonb_set(web_payload, '{checksum}', to_jsonb('sha256:' || repeat('c', 64)))
    );
    RAISE EXCEPTION 'altered web result payload was accepted';
  EXCEPTION WHEN SQLSTATE '23P01' THEN NULL;
  END;
  PERFORM review_coordinator_v3_web_result(result_id, source_run.id, 'accepted', 'tester', 'Accepted seam result');
  IF (SELECT count(*) FROM get_coordinator_v3_accepted_web_evidence(source_run.id, ARRAY[result_id])) <> 1 THEN
    RAISE EXCEPTION 'accepted-only web evidence retrieval failed';
  END IF;
  BEGIN
    PERFORM get_coordinator_v3_accepted_web_evidence(gen_random_uuid(), ARRAY[result_id]);
    RAISE EXCEPTION 'out-of-scope web result was returned';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;
  web_payload := jsonb_set(web_payload, '{url}', to_jsonb('https://example.test/b'::text));
  web_payload := jsonb_set(web_payload, '{canonical_url}', to_jsonb('https://example.test/b'::text));
  BEGIN
    PERFORM record_coordinator_v3_web_result(
      execution_id, approval_id, source_run.id, source_run.case_id, rejected_result_id,
      web_payload || '{"retrieval_method":"firecrawl_search"}'::jsonb
    );
    RAISE EXCEPTION 'a search retrieval method was accepted for a fetched result';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  web_payload := web_payload || '{"retrieval_method":"registry_api"}'::jsonb;
  result := record_coordinator_v3_web_result(
    execution_id, approval_id, source_run.id, source_run.case_id, rejected_result_id, web_payload
  );
  IF (SELECT retrieval_method FROM external_web_evidence WHERE id = rejected_result_id) <> 'registry_api' THEN
    RAISE EXCEPTION 'a registry API read was not recorded as registry_api';
  END IF;
  PERFORM review_coordinator_v3_web_result(rejected_result_id, source_run.id, 'rejected', 'tester', 'Rejected seam result');
  BEGIN
    PERFORM get_coordinator_v3_accepted_web_evidence(source_run.id, ARRAY[rejected_result_id]);
    RAISE EXCEPTION 'rejected result was returned by accepted-only retrieval';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;
  BEGIN
    UPDATE external_web_evidence SET content = 'tampered' WHERE id = result_id;
    RAISE EXCEPTION 'immutable web evidence was mutable';
  EXCEPTION WHEN SQLSTATE '55000' OR SQLSTATE 'P0001' THEN NULL;
  END;
  result := record_coordinator_v3_event(
    gen_random_uuid(), v_run_id, 'final_snapshot', 'durable-loop-test', NULL, '{"ok":true}'::jsonb, 2
  );
  IF result->>'status' <> 'stored' OR (SELECT count(*) FROM coordinator_v3_progress WHERE run_id = v_run_id) <> 1 THEN
    RAISE EXCEPTION 'event/progress projection was not persisted';
  END IF;
  UPDATE coordinator_v3_runs SET finalized_at = clock_timestamp(), stop_reason = 'test' WHERE id = v_run_id;
  PERFORM materialize_coordinator_v3_final_snapshot(v_run_id);
END;
$$;

ROLLBACK;

SELECT 'durable coordinator loop seam verification passed' AS result;
