\set ON_ERROR_STOP on

BEGIN;

-- 1. Straight-through analysis stores cited findings and reaches ready_for_review.
DO $$
DECLARE
  source_run record;
  document_chunk uuid;
  coordinator jsonb;
  final_payload jsonb;
  v_finding_id uuid := gen_random_uuid();
  v_citation_id uuid := gen_random_uuid();
BEGIN
  SELECT run.id, run.case_id, run.session_id
  INTO source_run
  FROM analysis_runs run
  JOIN onboarding_cases onboarding_case
    ON onboarding_case.id = run.case_id
   AND onboarding_case.active_analysis_run_id = run.id
  WHERE run.status IN ('queued', 'running', 'suspended')
    AND NOT EXISTS (
      SELECT 1 FROM coordinator_v3_runs coordinator
      WHERE coordinator.analysis_run_id = run.id
        AND coordinator.engine_version = 'durable-loop-v1'
    )
    AND EXISTS (
    SELECT 1
    FROM analysis_run_documents snapshot
    JOIN document_chunks chunk ON chunk.document_id = snapshot.document_id
    WHERE snapshot.analysis_run_id = run.id
  )
  ORDER BY run.created_at
  LIMIT 1;
  IF source_run.id IS NULL THEN
    RAISE EXCEPTION 'acceptance test requires an analysis run with a document chunk';
  END IF;

  SELECT chunk.id
  INTO document_chunk
  FROM analysis_run_documents snapshot
  JOIN document_chunks chunk ON chunk.document_id = snapshot.document_id
  WHERE snapshot.analysis_run_id = source_run.id
  ORDER BY chunk.id
  LIMIT 1;

  coordinator := start_or_resume_simple_coordinator_v3(
    source_run.id,
    source_run.case_id,
    source_run.session_id,
    'simple-acceptance-flow',
    'simple-acceptance-job-1',
    'Assess the applicant from scoped evidence.',
    8
  );

  final_payload := jsonb_build_object(
    'findings', jsonb_build_array(jsonb_build_object(
      'id', v_finding_id,
      'requirement_code', 'IDENTITY-1',
      'outcome', 'met',
      'summary', 'Applicant identity is supported.',
      'rationale', 'The cited document supports the legal identity.',
      'confidence', 0.950,
      'citations', jsonb_build_array(jsonb_build_object(
        'id', v_citation_id,
        'source_kind', 'case_document',
        'document_chunk_id', document_chunk,
        'locator', 'page 1',
        'excerpt', 'Legal entity name'
      ))
    )),
    'evidence_gaps', '[]'::jsonb,
    'conflicts', '[]'::jsonb
  );

  PERFORM save_simple_coordinator_v3_findings(
    (coordinator ->> 'coordinator_run_id')::uuid,
    final_payload,
    'simple-final:straight-through'
  );
  PERFORM mark_simple_coordinator_v3_ready(
    (coordinator ->> 'coordinator_run_id')::uuid,
    'simple-ready:straight-through'
  );

  IF NOT EXISTS (
    SELECT 1
    FROM findings finding
    JOIN citations citation
      ON citation.finding_id = finding.id
     AND citation.analysis_run_id = finding.analysis_run_id
    WHERE finding.id = v_finding_id
      AND finding.analysis_run_id = source_run.id
      AND citation.id = v_citation_id
      AND citation.document_chunk_id = document_chunk
  ) THEN
    RAISE EXCEPTION 'straight-through finding or citation was not stored';
  END IF;
  IF (SELECT status FROM analysis_runs WHERE id = source_run.id) <> 'succeeded'
    OR (SELECT status FROM onboarding_cases WHERE id = source_run.case_id) <> 'ready_for_review'
    OR (SELECT phase FROM coordinator_v3_runs WHERE id = (coordinator ->> 'coordinator_run_id')::uuid) <> 'ready_for_review' THEN
    RAISE EXCEPTION 'straight-through run did not reach ready_for_review';
  END IF;
END;
$$;

-- 2. A human question returns normally, then a later invocation resumes the
-- same logical run without repeating a completed specialist.
DO $$
DECLARE
  source_run record;
  first_start jsonb;
  resumed jsonb;
  run_id uuid;
  v_task_id text := 'simple-human-entity-task';
  checkpoint_id uuid := gen_random_uuid();
  checkpoint_payload jsonb;
  checkpoint_state_version bigint;
  waiting_state_version bigint;
  skip_result jsonb;
  contribution jsonb;
  directive jsonb;
  directive_result jsonb;
BEGIN
  SELECT run.id, run.case_id, run.session_id
  INTO source_run
  FROM analysis_runs run
  JOIN onboarding_cases onboarding_case
    ON onboarding_case.id = run.case_id
   AND onboarding_case.active_analysis_run_id = run.id
  WHERE run.status IN ('queued', 'running', 'suspended')
    AND NOT EXISTS (
      SELECT 1 FROM coordinator_v3_runs coordinator
      WHERE coordinator.analysis_run_id = run.id
        AND coordinator.engine_version = 'durable-loop-v1'
    )
  ORDER BY run.created_at
  LIMIT 1;

  first_start := start_or_resume_simple_coordinator_v3(
    source_run.id, source_run.case_id, source_run.session_id,
    'simple-acceptance-flow', 'simple-human-job-1',
    'Assess the applicant and request missing information.', 8
  );
  run_id := (first_start->>'coordinator_run_id')::uuid;
  directive := jsonb_build_object(
    'schema_version', '1.0',
    'analysis_run_id', source_run.id,
    'expected_state_version', (first_start->>'state_version')::bigint,
    'iteration', 1,
    'plan', jsonb_build_array(jsonb_build_object(
      'specialty', 'entity',
      'reason', 'Verify legal identity.',
      'task_objective', 'Review pinned identity evidence.',
      'required', true
    )),
    'next_action', 'dispatch_specialist',
    'target_specialty', 'entity',
    'attempt', 1,
    'parent_task_id', NULL,
    'rationale_summary', 'Entity is the next bounded operation.'
  );
  directive_result := commit_simple_coordinator_v3_directive(
    run_id,
    (first_start->>'state_version')::bigint,
    directive,
    encode(digest(directive::text, 'sha256'), 'hex')
  );
  IF directive_result->>'status' <> 'committed'
     OR (SELECT state->'next_action'->>'next_action' FROM coordinator_v3_runs WHERE id = run_id) <> 'dispatch_specialist' THEN
    RAISE EXCEPTION 'Supervisor directive was not durably committed before execution';
  END IF;
  INSERT INTO coordinator_v3_task_events(
    analysis_run_id, langflow_job_id, specialty, task_id, context_id,
    attempt, event_type, details
  ) VALUES (
    source_run.id, 'simple-coordinator:' || source_run.id::text, 'entity',
    v_task_id, 'simple-human-entity-context', 1, 'dispatched',
    jsonb_build_object(
      'schema_version', '3.0',
      'analysis_run_id', source_run.id,
      'coordinator_run_id', run_id,
      'case_id', source_run.case_id,
      'task_id', v_task_id,
      'context_id', 'simple-human-entity-context',
      'specialty', 'entity',
      'attempt', 1,
      'parent_task_id', NULL,
      'operation_key', 'coord:test:entity:1'
    )
  );
  contribution := jsonb_build_object(
    'schema_version', '3.0',
    'analysis_run_id', source_run.id,
    'coordinator_run_id', run_id,
    'case_id', source_run.case_id,
    'task_id', v_task_id,
    'context_id', 'simple-human-entity-context',
    'specialty', 'entity',
    'status', 'completed',
    'evidence_scope', jsonb_build_object(
      'permitted_document_ids', COALESCE((
        SELECT jsonb_agg(document_id::text ORDER BY document_id)
        FROM analysis_run_documents WHERE analysis_run_id = source_run.id
      ), '[]'::jsonb),
      'permitted_policy_version_ids', COALESCE((
        SELECT jsonb_agg(policy_version_id::text ORDER BY policy_version_id)
        FROM analysis_run_policy_versions WHERE analysis_run_id = source_run.id
      ), '[]'::jsonb),
      'permitted_web_result_ids', '[]'::jsonb
    ),
    'citations', '[]'::jsonb,
    'result', jsonb_build_object('summary', 'Entity review completed.')
  );
  PERFORM save_simple_coordinator_v3_contribution(run_id, contribution, 1, NULL);

  checkpoint_payload := jsonb_build_object(
    'schema_version', '1.0',
    'checkpoint_id', checkpoint_id,
    'request_id', 'simple-human-question-1',
    'checkpoint_version', 1,
    'parent_checkpoint_id', NULL,
    'parent_request_id', NULL,
    'originating_task_id', v_task_id,
    'originating_context_id', 'simple-human-entity-context',
    'checkpoint_kind', 'information_request',
    'title', 'Missing ownership detail',
    'explanation', 'Provide the missing ownership percentage.',
    'allowed_actions', jsonb_build_array('submit_clarification', 'reject', 'skip_for_now'),
    'payload', jsonb_build_object('question', 'What percentage does the owner hold?', 'choices', jsonb_build_array('25%', '50%'))
  );
  PERFORM create_simple_coordinator_v3_checkpoint(run_id, checkpoint_payload, 'checkpoint:simple-human-question-1');
  SELECT expected_state_version INTO checkpoint_state_version
  FROM coordinator_v3_checkpoints
  WHERE analysis_run_id = source_run.id
    AND request_id = 'simple-human-question-1';
  SELECT state_version INTO waiting_state_version
  FROM coordinator_v3_runs WHERE id = run_id;

  BEGIN
    PERFORM apply_simple_coordinator_v3_checkpoint_decision(
      source_run.id, 'simple-human-question-1', checkpoint_state_version + 1,
      'submit_clarification', '{"answer":"50%"}'::jsonb,
      'analyst-acceptance', 'decision:simple-human-question-stale'
    );
    RAISE EXCEPTION 'stale checkpoint state version was accepted';
  EXCEPTION WHEN SQLSTATE '40001' THEN NULL;
  END;

  resumed := start_or_resume_simple_coordinator_v3(
    source_run.id, source_run.case_id, source_run.session_id,
    'simple-acceptance-flow', 'simple-human-job-2',
    'Assess the applicant and request missing information.', 8
  );
  IF resumed->>'coordinator_run_id' <> run_id::text
     OR resumed->'state'->'pending_checkpoint'->>'request_id' <> 'simple-human-question-1'
     OR (resumed->>'state_version')::bigint <> waiting_state_version
     OR (SELECT status FROM analysis_runs WHERE id = source_run.id) <> 'suspended' THEN
    RAISE EXCEPTION 'later invocation did not resume the same pending logical run';
  END IF;

  PERFORM apply_simple_coordinator_v3_checkpoint_decision(
    source_run.id,
    'simple-human-question-1',
    checkpoint_state_version,
    'submit_clarification',
    '{"answer":"50%"}'::jsonb,
    'analyst-acceptance',
    'decision:simple-human-question-1'
  );
  resumed := start_or_resume_simple_coordinator_v3(
    source_run.id, source_run.case_id, source_run.session_id,
    'simple-acceptance-flow', 'simple-human-job-3',
    'Assess the applicant and request missing information.', 8
  );
  IF resumed->>'coordinator_run_id' <> run_id::text
     OR resumed->'state'->>'status' <> 'running'
     OR COALESCE(resumed->'state'->>'pending_checkpoint', '') <> ''
     OR NOT (resumed->'state'->'completed_specialists' ? 'entity')
     OR COALESCE(resumed->'state'->>'next_action', '') <> ''
     OR (resumed->>'iteration')::integer <> 1
     OR (SELECT count(*) FROM coordinator_v3_contributions contribution WHERE contribution.task_id = v_task_id) <> 1 THEN
    RAISE EXCEPTION 'human resume repeated completed work or lost logical state';
  END IF;

  checkpoint_id := gen_random_uuid();
  checkpoint_payload := jsonb_build_object(
    'schema_version', '1.0',
    'checkpoint_id', checkpoint_id,
    'request_id', 'simple-human-skip-1',
    'checkpoint_version', 1,
    'parent_checkpoint_id', NULL,
    'parent_request_id', NULL,
    'originating_task_id', NULL,
    'originating_context_id', NULL,
    'checkpoint_kind', 'information_request',
    'title', 'Optional ownership detail',
    'explanation', 'Provide the optional ownership detail when available.',
    'allowed_actions', jsonb_build_array('submit_clarification', 'reject', 'skip_for_now'),
    'payload', jsonb_build_object('question', 'Provide the optional detail.')
  );
  PERFORM create_simple_coordinator_v3_checkpoint(run_id, checkpoint_payload, 'checkpoint:simple-human-skip-1');
  SELECT expected_state_version INTO checkpoint_state_version
  FROM coordinator_v3_checkpoints
  WHERE analysis_run_id = source_run.id
    AND request_id = 'simple-human-skip-1';
  IF (SELECT status FROM analysis_runs WHERE id = source_run.id) <> 'suspended' THEN
    RAISE EXCEPTION 'checkpoint creation did not suspend the analysis run';
  END IF;
  skip_result := apply_simple_coordinator_v3_checkpoint_decision(
        source_run.id, 'simple-human-skip-1', checkpoint_state_version,
        'skip_for_now', '{}'::jsonb, 'analyst-acceptance', 'decision:simple-human-skip-1'
      );
  IF skip_result->>'outcome' <> 'applied'
     OR (SELECT status FROM coordinator_v3_checkpoints
         WHERE analysis_run_id = source_run.id AND request_id = 'simple-human-skip-1') <> 'pending'
     OR (SELECT count(*) FROM coordinator_v3_checkpoint_skips skip
         WHERE skip.run_id = (SELECT run.id FROM coordinator_v3_runs run
                              WHERE run.analysis_run_id = source_run.id
                                AND run.engine_version = 'durable-loop-v1')
           AND skip.request_id = 'simple-human-skip-1') <> 1
     OR (SELECT status FROM analysis_runs WHERE id = source_run.id) <> 'suspended' THEN
    RAISE EXCEPTION 'skip_for_now did not audit without resolving the checkpoint';
  END IF;
  IF apply_simple_coordinator_v3_checkpoint_decision(
       source_run.id, 'simple-human-skip-1', checkpoint_state_version,
       'skip_for_now', '{}'::jsonb, 'analyst-acceptance', 'decision:simple-human-skip-1'
     )->>'outcome' <> 'replay' THEN
    RAISE EXCEPTION 'exact skip replay was not idempotent';
  END IF;
  BEGIN
    PERFORM apply_simple_coordinator_v3_checkpoint_decision(
      source_run.id, 'simple-human-skip-1', checkpoint_state_version,
      'skip_for_now', '{"different":true}'::jsonb, 'analyst-acceptance', 'decision:simple-human-skip-2'
    );
    RAISE EXCEPTION 'conflicting skip replay was accepted';
  EXCEPTION WHEN SQLSTATE '23P01' THEN NULL;
  END;
  PERFORM apply_simple_coordinator_v3_checkpoint_decision(
    source_run.id, 'simple-human-skip-1', checkpoint_state_version,
    'submit_clarification', '{"answer":"later"}'::jsonb,
    'analyst-acceptance', 'decision:simple-human-skip-resolve'
  );
END;
$$;

-- 3. The database boundary enforces the complete directive contract, not only
-- the fields needed by the happy path.
DO $$
DECLARE
  source_run record;
  started jsonb;
  directive jsonb;
  invalid jsonb;
  run_id uuid;
  expected_version bigint;
BEGIN
  SELECT run.id, run.case_id, run.session_id
  INTO source_run
  FROM analysis_runs run
  JOIN onboarding_cases onboarding_case
    ON onboarding_case.id = run.case_id
   AND onboarding_case.active_analysis_run_id = run.id
  WHERE run.status IN ('queued', 'running', 'suspended')
    AND NOT EXISTS (
      SELECT 1 FROM coordinator_v3_runs coordinator
      WHERE coordinator.analysis_run_id = run.id
        AND coordinator.engine_version = 'durable-loop-v1'
    )
  ORDER BY run.created_at DESC
  LIMIT 1;
  started := start_or_resume_simple_coordinator_v3(
    source_run.id, source_run.case_id, source_run.session_id,
    'simple-contract-flow', 'simple-contract-job', 'Validate the directive contract.', 8
  );
  run_id := (started->>'coordinator_run_id')::uuid;
  expected_version := (started->>'state_version')::bigint;
  directive := jsonb_build_object(
    'schema_version', '1.0',
    'analysis_run_id', source_run.id,
    'expected_state_version', expected_version,
    'iteration', 1,
    'plan', jsonb_build_array(jsonb_build_object(
      'specialty', 'entity', 'reason', 'Reconcile identity.',
      'task_objective', 'Verify the legal name.', 'required', true
    )),
    'next_action', 'dispatch_specialist',
    'target_specialty', 'entity', 'attempt', 1, 'parent_task_id', NULL,
    'rationale_summary', 'Dispatch the bounded identity check.'
  );

  invalid := jsonb_set(directive, '{schema_version}', '1.1'::jsonb);
  BEGIN
    PERFORM commit_simple_coordinator_v3_directive(run_id, expected_version, invalid, encode(digest(invalid::text, 'sha256'), 'hex'));
    RAISE EXCEPTION 'invalid schema version was accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  invalid := jsonb_set(directive, '{attempt}', '1.5'::jsonb);
  BEGIN
    PERFORM commit_simple_coordinator_v3_directive(run_id, expected_version, invalid, encode(digest(invalid::text, 'sha256'), 'hex'));
    RAISE EXCEPTION 'non-integer attempt was accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  invalid := directive || jsonb_build_object('checkpoint_kind', 'information_request');
  BEGIN
    PERFORM commit_simple_coordinator_v3_directive(run_id, expected_version, invalid, encode(digest(invalid::text, 'sha256'), 'hex'));
    RAISE EXCEPTION 'forbidden action field was accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  invalid := jsonb_set(directive, '{plan,0,required}', '"yes"'::jsonb);
  BEGIN
    PERFORM commit_simple_coordinator_v3_directive(run_id, expected_version, invalid, encode(digest(invalid::text, 'sha256'), 'hex'));
    RAISE EXCEPTION 'wrongly typed plan field was accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  invalid := jsonb_set(directive, '{expected_state_version}', to_jsonb(expected_version + 1));
  BEGIN
    PERFORM commit_simple_coordinator_v3_directive(run_id, expected_version, invalid, encode(digest(invalid::text, 'sha256'), 'hex'));
    RAISE EXCEPTION 'embedded expected state version mismatch was accepted';
  EXCEPTION WHEN SQLSTATE '40001' THEN NULL;
  END;
END;
$$;

-- 4. TinyFish execution cannot be claimed before exact approval and can be
-- claimed once the approved execution exists.
DO $$
DECLARE
  source_run record;
  action_id uuid := gen_random_uuid();
  review_id uuid := gen_random_uuid();
  approval_id uuid := gen_random_uuid();
  execution_id uuid := gen_random_uuid();
  outcome text;
BEGIN
  SELECT run.id, run.case_id
  INTO source_run
  FROM analysis_runs run
  JOIN onboarding_cases onboarding_case
    ON onboarding_case.id = run.case_id
   AND onboarding_case.active_analysis_run_id = run.id
  WHERE run.status IN ('queued', 'running', 'suspended', 'succeeded')
  ORDER BY run.created_at
  LIMIT 1;
  UPDATE analysis_runs SET status = 'running', finished_at = NULL WHERE id = source_run.id;
  UPDATE onboarding_cases SET status = 'processing' WHERE id = source_run.case_id;

  BEGIN
    PERFORM claim_web_search_execution(
      execution_id, action_id, source_run.id, source_run.case_id,
      'simple-acceptance-exact-approved-query', ARRAY['registry.example'], 2,
      'Resolve a cited evidence gap', ARRAY['legal_name'], clock_timestamp()
    );
    RAISE EXCEPTION 'TinyFish execution was claimable without approval';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'TinyFish execution was claimable without approval' THEN RAISE; END IF;
  END;

  INSERT INTO proposed_actions(
    id, analysis_run_id, case_id, action_type, payload, status, idempotency_key, summary
  ) VALUES (
    action_id, source_run.id, source_run.case_id, 'run_web_search', '{}'::jsonb,
    'approved', 'simple-search-action:' || action_id, 'Run exact approved query'
  );
  INSERT INTO review_requests(
    id, proposed_action_id, analysis_run_id, case_id, correlation_id, status, decided_at
  ) VALUES (
    review_id, action_id, source_run.id, source_run.case_id,
    'simple-search-review:' || review_id, 'decided', clock_timestamp()
  );
  INSERT INTO approvals(
    id, proposed_action_id, decision, decided_by, rationale,
    review_request_id, idempotency_key
  ) VALUES (
    approval_id, action_id, 'approved', 'analyst-acceptance', 'Exact search scope approved.',
    review_id, 'simple-search-approval:' || approval_id
  );
  INSERT INTO web_search_executions(
    id, proposed_action_id, approval_id, analysis_run_id, case_id,
    query, allowed_domains, max_results, intended_use, external_disclosure,
    scope_hash, status, expires_at
  ) VALUES (
    execution_id, action_id, approval_id, source_run.id, source_run.case_id,
    'simple-acceptance-exact-approved-query', ARRAY['registry.example'], 2,
    'Resolve a cited evidence gap', ARRAY['legal_name'], repeat('a', 64),
    'approved', clock_timestamp() + interval '30 minutes'
  );
  outcome := claim_web_search_execution(
    execution_id, action_id, source_run.id, source_run.case_id,
    'simple-acceptance-exact-approved-query', ARRAY['registry.example'], 2,
    'Resolve a cited evidence gap', ARRAY['legal_name'], clock_timestamp()
  );
  IF outcome <> 'claimed' THEN
    RAISE EXCEPTION 'approved TinyFish execution was not claimed';
  END IF;
END;
$$;

-- 5. Only accepted immutable web results are readable by Public Research;
-- rejected results remain auditable but unusable.
DO $$
DECLARE
  execution web_search_executions%ROWTYPE;
  accepted_id uuid := gen_random_uuid();
  rejected_id uuid := gen_random_uuid();
  accepted_checksum text := 'sha256:' || repeat('b', 64);
  rejected_checksum text := 'sha256:' || repeat('c', 64);
  accepted_payload jsonb;
  rejected_payload jsonb;
BEGIN
  SELECT * INTO execution
  FROM web_search_executions
  WHERE query = 'simple-acceptance-exact-approved-query'
  ORDER BY created_at DESC
  LIMIT 1;
  accepted_payload := jsonb_build_object(
    'query', execution.query,
    'approved_scope', jsonb_build_object(
      'query', execution.query,
      'allowed_domains', to_jsonb(execution.allowed_domains),
      'max_results', execution.max_results
    ),
    'url', 'https://registry.example/accepted',
    'canonical_url', 'https://registry.example/accepted',
    'title', 'Accepted registry result',
    'publisher', 'Registry',
    'retrieved_at', '2026-09-20T00:00:00Z',
    'excerpt', 'Official matching record.',
    'checksum', accepted_checksum
  );
  rejected_payload := jsonb_set(
    jsonb_set(accepted_payload, '{url}', '"https://registry.example/rejected"'::jsonb),
    '{canonical_url}', '"https://registry.example/rejected"'::jsonb
  ) || jsonb_build_object('title', 'Rejected registry result', 'checksum', rejected_checksum);

  PERFORM record_coordinator_v3_web_result(
    execution.id, execution.approval_id, execution.analysis_run_id,
    execution.case_id, accepted_id, accepted_payload
  );
  PERFORM record_coordinator_v3_web_result(
    execution.id, execution.approval_id, execution.analysis_run_id,
    execution.case_id, rejected_id, rejected_payload
  );
  PERFORM review_coordinator_v3_web_result(
    accepted_id, execution.analysis_run_id, 'accepted',
    'analyst-acceptance', 'Official record matches the applicant.'
  );
  PERFORM review_coordinator_v3_web_result(
    rejected_id, execution.analysis_run_id, 'rejected',
    'analyst-acceptance', 'Result refers to a different organization.'
  );

  IF (SELECT count(*) FROM get_coordinator_v3_accepted_web_evidence(
        execution.analysis_run_id, ARRAY[accepted_id]
      )) <> 1 THEN
    RAISE EXCEPTION 'accepted web result was not released to Public Research';
  END IF;
  BEGIN
    PERFORM get_coordinator_v3_accepted_web_evidence(
      execution.analysis_run_id, ARRAY[rejected_id]
    );
    RAISE EXCEPTION 'rejected web result was released to Public Research';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;
  IF NOT EXISTS (
    SELECT 1 FROM web_result_review_items item
    WHERE item.external_web_evidence_id = rejected_id
      AND item.review_state = 'rejected'
      AND item.decided_by = 'analyst-acceptance'
      AND item.rationale = 'Result refers to a different organization.'
  ) THEN
    RAISE EXCEPTION 'rejected web result did not remain auditable';
  END IF;
END;
$$;

-- 6. Replaying the same checkpoint decision, approved search, or final action
-- is a no-op and does not create a second execution.
DO $$
DECLARE
  execution web_search_executions%ROWTYPE;
  checkpoint coordinator_v3_checkpoints%ROWTYPE;
  coordinator coordinator_v3_runs%ROWTYPE;
  result jsonb;
  outcome text;
  before_version bigint;
BEGIN
  SELECT * INTO checkpoint
  FROM coordinator_v3_checkpoints
  WHERE request_id = 'simple-human-question-1';
  SELECT * INTO coordinator
  FROM coordinator_v3_runs
  WHERE analysis_run_id = checkpoint.analysis_run_id
    AND engine_version = 'durable-loop-v1';
  result := create_simple_coordinator_v3_checkpoint(
    coordinator.id,
    checkpoint.request_payload - 'kind' - 'expected_state_version',
    'checkpoint:simple-human-question-1'
  );
  IF result->>'status' <> 'duplicate_suppressed' THEN
    RAISE EXCEPTION 'checkpoint request replay was not suppressed';
  END IF;
  result := apply_simple_coordinator_v3_checkpoint_decision(
    checkpoint.analysis_run_id,
    'simple-human-question-1',
    checkpoint.expected_state_version,
    'submit_clarification',
    '{"answer":"50%"}'::jsonb,
    'analyst-acceptance',
    'decision:simple-human-question-1'
  );
  IF result->>'status' <> 'duplicate_suppressed'
     OR result->>'outcome' <> 'replay'
     OR (SELECT count(*) FROM coordinator_v3_human_decisions decision
         WHERE decision.run_id = coordinator.id
           AND decision.request_id = 'simple-human-question-1') <> 1 THEN
    RAISE EXCEPTION 'human decision replay was not suppressed';
  END IF;

  SELECT * INTO execution
  FROM web_search_executions
  WHERE query = 'simple-acceptance-exact-approved-query'
  ORDER BY created_at DESC
  LIMIT 1;
  outcome := claim_web_search_execution(
    execution.id, execution.proposed_action_id, execution.analysis_run_id,
    execution.case_id, execution.query, execution.allowed_domains,
    execution.max_results, execution.intended_use,
    execution.external_disclosure, clock_timestamp()
  );
  IF outcome <> 'duplicate'
     OR (SELECT count(*) FROM web_search_executions item WHERE item.id = execution.id) <> 1 THEN
    RAISE EXCEPTION 'approved search replay was not suppressed';
  END IF;

  SELECT * INTO coordinator
  FROM coordinator_v3_runs
  WHERE phase = 'ready_for_review'
    AND state->>'ready_idempotency_key' = 'simple-ready:straight-through';
  before_version := coordinator.state_version;
  result := mark_simple_coordinator_v3_ready(
    coordinator.id, 'simple-ready:straight-through'
  );
  IF result->>'status' <> 'duplicate_suppressed'
     OR (SELECT state_version FROM coordinator_v3_runs WHERE id = coordinator.id) <> before_version THEN
    RAISE EXCEPTION 'final action replay was not suppressed';
  END IF;
END;
$$;

-- 7. Evidence from one analysis run cannot be retrieved through another run.
DO $$
DECLARE
  accepted_result record;
  other_run uuid;
BEGIN
  SELECT evidence.id, evidence.analysis_run_id
  INTO accepted_result
  FROM external_web_evidence evidence
  JOIN web_result_review_items item
    ON item.external_web_evidence_id = evidence.id
   AND item.review_state = 'accepted'
  WHERE evidence.canonical_url = 'https://registry.example/accepted'
  ORDER BY evidence.created_at DESC
  LIMIT 1;
  SELECT run.id INTO other_run
  FROM analysis_runs run
  WHERE run.id <> accepted_result.analysis_run_id
  ORDER BY run.created_at
  LIMIT 1;
  IF other_run IS NULL THEN
    RAISE EXCEPTION 'cross-run acceptance test requires a second analysis run';
  END IF;
  BEGIN
    PERFORM get_coordinator_v3_accepted_web_evidence(
      other_run, ARRAY[accepted_result.id]
    );
    RAISE EXCEPTION 'cross-case accepted evidence retrieval was allowed';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;
END;
$$;

-- 8. A contribution from a terminal coordinator is rejected, even when its
-- envelope otherwise looks valid.
DO $$
DECLARE
  source_run record;
  started jsonb;
  run_id uuid;
  payload jsonb;
BEGIN
  SELECT run.id, run.case_id, run.session_id
  INTO source_run
  FROM analysis_runs run
  JOIN onboarding_cases onboarding_case
    ON onboarding_case.id = run.case_id
   AND onboarding_case.active_analysis_run_id = run.id
  WHERE run.status IN ('queued', 'running', 'suspended')
    AND NOT EXISTS (
      SELECT 1 FROM coordinator_v3_runs coordinator
      WHERE coordinator.analysis_run_id = run.id
        AND coordinator.engine_version = 'durable-loop-v1'
    )
  ORDER BY run.created_at
  LIMIT 1;
  started := start_or_resume_simple_coordinator_v3(
    source_run.id, source_run.case_id, source_run.session_id,
    'simple-regression-flow', 'simple-regression-terminal', 'Reject stale contribution.', 8
  );
  run_id := (started->>'coordinator_run_id')::uuid;
  UPDATE coordinator_v3_runs
  SET phase = 'stopped', state = state || jsonb_build_object('status', 'stopped')
  WHERE id = run_id;
  payload := jsonb_build_object(
    'analysis_run_id', source_run.id, 'coordinator_run_id', run_id,
    'case_id', source_run.case_id, 'task_id', 'regression-terminal-task',
    'context_id', 'regression-terminal-context', 'specialty', 'entity',
    'status', 'completed', 'evidence_scope', jsonb_build_object(
      'permitted_document_ids', COALESCE((SELECT jsonb_agg(document_id::text ORDER BY document_id) FROM analysis_run_documents WHERE analysis_run_id = source_run.id), '[]'::jsonb),
      'permitted_policy_version_ids', COALESCE((SELECT jsonb_agg(policy_version_id::text ORDER BY policy_version_id) FROM analysis_run_policy_versions WHERE analysis_run_id = source_run.id), '[]'::jsonb),
      'permitted_web_result_ids', '[]'::jsonb
    ), 'citations', '[]'::jsonb
  );
  BEGIN
    PERFORM save_simple_coordinator_v3_contribution(run_id, payload, 1, NULL);
    RAISE EXCEPTION 'terminal coordinator accepted a contribution';
  EXCEPTION WHEN SQLSTATE '40001' THEN NULL;
  END;
END;
$$;

-- 9. A contribution is rejected when the persisted dispatch reservation is
-- missing or belongs to a different task identity.
DO $$
DECLARE
  source_run record;
  started jsonb;
  run_id uuid;
  payload jsonb;
BEGIN
  SELECT run.id, run.case_id, run.session_id
  INTO source_run
  FROM analysis_runs run
  JOIN onboarding_cases onboarding_case
    ON onboarding_case.id = run.case_id
   AND onboarding_case.active_analysis_run_id = run.id
  WHERE run.status IN ('queued', 'running', 'suspended')
    AND NOT EXISTS (
      SELECT 1 FROM coordinator_v3_runs coordinator
      WHERE coordinator.analysis_run_id = run.id
        AND coordinator.engine_version = 'durable-loop-v1'
    )
  ORDER BY run.created_at
  LIMIT 1;
  started := start_or_resume_simple_coordinator_v3(
    source_run.id, source_run.case_id, source_run.session_id,
    'simple-regression-flow', 'simple-regression-unreserved', 'Reject unreserved contribution.', 8
  );
  run_id := (started->>'coordinator_run_id')::uuid;
  UPDATE coordinator_v3_runs
  SET state = state || jsonb_build_object(
    'next_action', jsonb_build_object(
      'next_action', 'dispatch_specialist', 'target_specialty', 'entity',
      'attempt', 1, 'parent_task_id', NULL
    )
  )
  WHERE id = run_id;
  INSERT INTO coordinator_v3_task_events(
    analysis_run_id, langflow_job_id, specialty, task_id, context_id,
    attempt, event_type, details
  ) VALUES (
    source_run.id, 'simple-coordinator:' || source_run.id::text, 'entity',
    'regression-other-task', 'regression-other-context', 1, 'dispatched',
    jsonb_build_object('coordinator_run_id', run_id, 'task_id', 'regression-other-task',
                       'context_id', 'regression-other-context', 'specialty', 'entity',
                       'attempt', 1, 'parent_task_id', NULL, 'operation_key', 'coord:test:other')
  );
  payload := jsonb_build_object(
    'analysis_run_id', source_run.id, 'coordinator_run_id', run_id,
    'case_id', source_run.case_id, 'task_id', 'regression-unreserved-task',
    'context_id', 'regression-unreserved-context', 'specialty', 'entity',
    'status', 'completed', 'evidence_scope', jsonb_build_object(
      'permitted_document_ids', COALESCE((SELECT jsonb_agg(document_id::text ORDER BY document_id) FROM analysis_run_documents WHERE analysis_run_id = source_run.id), '[]'::jsonb),
      'permitted_policy_version_ids', COALESCE((SELECT jsonb_agg(policy_version_id::text ORDER BY policy_version_id) FROM analysis_run_policy_versions WHERE analysis_run_id = source_run.id), '[]'::jsonb),
      'permitted_web_result_ids', '[]'::jsonb
    ), 'citations', '[]'::jsonb
  );
  BEGIN
    PERFORM save_simple_coordinator_v3_contribution(run_id, payload, 1, NULL);
    RAISE EXCEPTION 'unreserved or mismatched contribution was accepted';
  EXCEPTION WHEN SQLSTATE '40001' THEN NULL;
  END;
END;
$$;

-- 10. Checkpoint requests reject contradictory action arrays and malformed
-- typed payloads before any suspension is persisted.
DO $$
DECLARE
  source_run record;
  started jsonb;
  run_id uuid;
  request jsonb;
BEGIN
  SELECT run.id, run.case_id, run.session_id
  INTO source_run
  FROM analysis_runs run
  JOIN onboarding_cases onboarding_case
    ON onboarding_case.id = run.case_id
   AND onboarding_case.active_analysis_run_id = run.id
  WHERE run.status IN ('queued', 'running', 'suspended')
    AND NOT EXISTS (
      SELECT 1 FROM coordinator_v3_runs coordinator
      WHERE coordinator.analysis_run_id = run.id
        AND coordinator.engine_version = 'durable-loop-v1'
    )
  ORDER BY run.created_at
  LIMIT 1;
  started := start_or_resume_simple_coordinator_v3(
    source_run.id, source_run.case_id, source_run.session_id,
    'simple-regression-flow', 'simple-regression-checkpoint', 'Reject malformed checkpoints.', 8
  );
  run_id := (started->>'coordinator_run_id')::uuid;
  request := jsonb_build_object(
    'schema_version', '1.0', 'checkpoint_id', gen_random_uuid(),
    'request_id', 'regression-malformed-checkpoint', 'checkpoint_version', 1,
    'parent_checkpoint_id', NULL, 'parent_request_id', NULL,
    'originating_task_id', NULL, 'originating_context_id', NULL,
    'checkpoint_kind', 'information_request', 'title', 'Question',
    'explanation', 'Answer the question.',
    'allowed_actions', jsonb_build_array('approve'),
    'payload', jsonb_build_object('question', 'What is the answer?')
  );
  BEGIN
    PERFORM create_simple_coordinator_v3_checkpoint(run_id, request, 'regression:malformed-checkpoint');
    RAISE EXCEPTION 'malformed checkpoint semantics were accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
END;
$$;

-- 11. Continuation routes reject unknown fields, invalid retry lineage, and
-- malformed operation/hash identities.
DO $$
DECLARE
  source_run record;
  started jsonb;
  run_id uuid;
BEGIN
  SELECT run.id, run.case_id, run.session_id
  INTO source_run
  FROM analysis_runs run
  JOIN onboarding_cases onboarding_case
    ON onboarding_case.id = run.case_id
   AND onboarding_case.active_analysis_run_id = run.id
  WHERE run.status IN ('queued', 'running', 'suspended')
    AND NOT EXISTS (
      SELECT 1 FROM coordinator_v3_runs coordinator
      WHERE coordinator.analysis_run_id = run.id
        AND coordinator.engine_version = 'durable-loop-v1'
    )
  ORDER BY run.created_at
  LIMIT 1;
  started := start_or_resume_simple_coordinator_v3(
    source_run.id, source_run.case_id, source_run.session_id,
    'simple-regression-flow', 'simple-regression-continuation', 'Reject malformed continuation.', 8
  );
  run_id := (started->>'coordinator_run_id')::uuid;
  UPDATE coordinator_v3_runs
  SET state = state || jsonb_build_object(
    'last_checkpoint_result', jsonb_build_object('request_id', 'regression-continuation-checkpoint')
  )
  WHERE id = run_id;
  BEGIN
    PERFORM set_simple_coordinator_v3_next_action(
      run_id, 'regression-continuation-checkpoint',
      '{"route":"execute_search","operation_key":"not-a-coordinator-operation","scope_hash":"bad"}'::jsonb,
      'regression:continuation'
    );
    RAISE EXCEPTION 'malformed continuation was accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
END;
$$;

ROLLBACK;

SELECT 'all 11 simple coordinator acceptance tests passed' AS result;
