\echo 'Verifying data foundation...'

BEGIN;

DO $$
BEGIN
  IF (SELECT count(*) FROM onboarding_cases WHERE reference LIKE 'KYB-DEMO-%') <> 4 THEN
    RAISE EXCEPTION 'expected exactly four demo cases';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM document_chunks chunk
    JOIN case_documents document ON document.id = chunk.document_id
    WHERE chunk.case_id <> document.case_id
      OR chunk.applicant_id <> document.applicant_id
      OR chunk.evidence_submission_id <> document.evidence_submission_id
  ) THEN
    RAISE EXCEPTION 'case chunk metadata crosses an evidence boundary';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_extension
    WHERE extname = 'vector'
  ) THEN
    RAISE EXCEPTION 'pgvector extension is unavailable';
  END IF;
END;
$$;

-- Keep this transaction-scoped verification independent from whichever
-- synthetic Step 10 state is currently visible in the dashboard.
UPDATE analysis_runs
SET status = 'cancelled', finished_at = now()
WHERE id = (
  SELECT active_analysis_run_id FROM onboarding_cases
  WHERE id = '30000000-0000-0000-0000-000000000002'
)
AND status IN ('queued', 'running', 'suspended');

UPDATE onboarding_cases
SET active_analysis_run_id = NULL, status = 'draft'
WHERE id = '30000000-0000-0000-0000-000000000002';

DO $$
BEGIN
  PERFORM start_analysis_run(
    '30000000-0000-0000-0000-000000000002',
    'verify-interrupted-run',
    'Focus on ownership completeness and address conflicts.',
    '1.1',
    DATE '2026-09-18'
  );
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM onboarding_cases
    WHERE id = '30000000-0000-0000-0000-000000000001'
      AND active_analysis_run_id IS NOT NULL
  ) THEN
    PERFORM start_analysis_run(
      '30000000-0000-0000-0000-000000000001',
      'verify-rag-straight-run',
      'Verify standard KYB requirements.',
      '1.1',
      DATE '2026-09-18'
    );
  END IF;
END;
$$;

DO $$
DECLARE
  run_id uuid := (SELECT id FROM analysis_runs WHERE session_id = 'verify-interrupted-run');
  citation_id uuid := 'c0000000-0000-4000-8000-000000000005';
  action_id uuid := 'c0000000-0000-4000-8000-000000000001';
  review_id uuid := 'c0000000-0000-4000-8000-000000000002';
  execution_id uuid := 'c0000000-0000-4000-8000-000000000003';
  result_review_id uuid;
  payload jsonb := jsonb_build_object(
    'query', 'Mercado Bridge Ltd money transmitter license',
    'reason', 'The claimed license is not supported by submitted evidence.',
    'allowed_domains', jsonb_build_array('regulator.example.gov'),
    'max_results', 5,
    'intended_use', 'Locate an official public source for the license claim.',
    'external_disclosure', jsonb_build_array('legal_name', 'claimed_license_type')
  );
  evidence jsonb;
  outcome text;
  unapproved_blocked boolean := false;
  changed_scope_blocked boolean := false;
BEGIN
  INSERT INTO findings (
    id, analysis_run_id, requirement_code, outcome, summary, rationale, confidence
  ) VALUES (
    'f0000000-0000-0000-0000-000000000002', run_id,
    'LIC-1.1', 'uncertain', 'The claimed license lacks supporting evidence.',
    'A narrow public-record search may locate an authoritative source.', 0.7
  );
  INSERT INTO citations (
    id, analysis_run_id, finding_id, source_kind, document_chunk_id,
    locator, excerpt
  ) VALUES (
    citation_id, run_id, 'f0000000-0000-0000-0000-000000000002',
    'case_document', '60000000-0000-0000-0000-000000000002',
    'Ownership declaration', 'The applicant makes an unsupported licensing claim.'
  );

  SELECT propose_web_search_action(
    action_id, review_id, run_id,
    '30000000-0000-0000-0000-000000000002',
    'Search for an official license record.', payload,
    ARRAY['f0000000-0000-0000-0000-000000000002'::uuid],
    ARRAY[citation_id],
    'verify:web-search-license', 'correlation-web-verification'
  ) INTO outcome;
  IF outcome <> 'stored'
    OR (SELECT status FROM analysis_runs WHERE id = run_id) <> 'suspended'
  THEN
    RAISE EXCEPTION 'web-search proposal was not stored and suspended atomically';
  END IF;

  BEGIN
    PERFORM claim_web_search_execution(
      execution_id, action_id, run_id,
      '30000000-0000-0000-0000-000000000002',
      payload ->> 'query', ARRAY['regulator.example.gov'], 5,
      payload ->> 'intended_use', ARRAY['legal_name', 'claimed_license_type'],
      '2026-09-19T17:01:00.000Z'
    );
  EXCEPTION WHEN raise_exception THEN
    unapproved_blocked := position('no analyst approval' IN SQLERRM) > 0;
  END;
  IF NOT unapproved_blocked THEN
    RAISE EXCEPTION 'web search could be claimed without analyst approval';
  END IF;

  SELECT decide_web_search_action(
    review_id, action_id, run_id,
    '30000000-0000-0000-0000-000000000002',
    'approved', 'analyst-42',
    'The exact official-domain search and limited disclosure are proportionate.',
    '2026-09-19T17:00:00.000Z', 'verify-web-review:approved',
    execution_id, '2026-09-19T17:10:00.000Z'
  ) INTO outcome;
  IF outcome <> 'approved'
    OR (SELECT status FROM analysis_runs WHERE id = run_id) <> 'running'
    OR (SELECT status FROM web_search_executions WHERE id = execution_id) <> 'approved'
  THEN
    RAISE EXCEPTION 'approved web-search scope was not minted correctly';
  END IF;

  BEGIN
    PERFORM claim_web_search_execution(
      execution_id, action_id, run_id,
      '30000000-0000-0000-0000-000000000002',
      'broader query', ARRAY['regulator.example.gov'], 5,
      payload ->> 'intended_use', ARRAY['legal_name', 'claimed_license_type'],
      '2026-09-19T17:05:00.000Z'
    );
  EXCEPTION WHEN raise_exception THEN
    changed_scope_blocked := position('differs from the analyst-approved scope' IN SQLERRM) > 0;
  END;
  IF NOT changed_scope_blocked THEN
    RAISE EXCEPTION 'changed web-search scope was accepted';
  END IF;

  SELECT claim_web_search_execution(
    execution_id, action_id, run_id,
    '30000000-0000-0000-0000-000000000002',
    payload ->> 'query', ARRAY['regulator.example.gov'], 5,
    payload ->> 'intended_use', ARRAY['legal_name', 'claimed_license_type'],
    '2026-09-19T17:05:00.000Z'
  ) INTO outcome;
  IF outcome <> 'claimed' THEN
    RAISE EXCEPTION 'exact approved web-search scope was not claimable';
  END IF;

  evidence := jsonb_build_array(jsonb_build_object(
    'id', 'c0000000-0000-4000-8000-000000000004',
    'searchExecutionId', execution_id,
    'url', 'https://regulator.example.gov/licenses/mercado-bridge',
    'canonicalUrl', 'https://regulator.example.gov/licenses/mercado-bridge',
    'title', 'License record: Mercado Bridge Ltd',
    'publisher', 'regulator.example.gov',
    'publishedAt', NULL,
    'retrievedAt', '2026-09-19T17:05:01.000Z',
    'excerpt', 'Mercado Bridge Ltd holds license MT-1234.',
    'contentHash', 'sha256:' || repeat('a', 64)
  ));
  SELECT complete_web_search_execution(
    execution_id, action_id, run_id,
    '30000000-0000-0000-0000-000000000002',
    'firecrawl-request-verification', evidence,
    '2026-09-19T17:05:02.000Z'
  ) INTO outcome;
  IF outcome <> 'stored'
    OR (SELECT status FROM web_search_executions WHERE id = execution_id) <> 'succeeded'
    OR (SELECT status FROM proposed_actions WHERE id = action_id) <> 'executed'
    OR (SELECT count(*) FROM external_web_evidence
        WHERE search_execution_id = execution_id) <> 1
  THEN
    RAISE EXCEPTION 'approved web-search result was not stored with provenance';
  END IF;

  SELECT id INTO result_review_id
  FROM web_result_reviews WHERE search_execution_id = execution_id;
  SELECT decide_web_result_review_authorized(
    result_review_id, execution_id, run_id,
    '30000000-0000-0000-0000-000000000002',
    jsonb_build_array(jsonb_build_object(
      'evidence_id', 'c0000000-0000-4000-8000-000000000004',
      'content_hash', 'sha256:' || repeat('a', 64),
      'decision', 'accepted'
    )),
    'analyst-42', 'The official-domain result may be used for this verification.',
    '2026-09-19T17:05:03.000Z', 'verify-web-review:result-accepted',
    ARRAY['compliance_analyst']
  ) INTO outcome;
  IF outcome <> 'accepted'
    OR (SELECT status FROM analysis_runs WHERE id = run_id) <> 'running'
  THEN
    RAISE EXCEPTION 'accepted web result did not selectively resume the run';
  END IF;

  SELECT claim_web_search_execution(
    execution_id, action_id, run_id,
    '30000000-0000-0000-0000-000000000002',
    payload ->> 'query', ARRAY['regulator.example.gov'], 5,
    payload ->> 'intended_use', ARRAY['legal_name', 'claimed_license_type'],
    '2026-09-19T17:06:00.000Z'
  ) INTO outcome;
  IF outcome <> 'duplicate'
    OR (SELECT count(*) FROM audit_events
        WHERE analysis_run_id = run_id AND event_type = 'web_search.completed') <> 1
  THEN
    RAISE EXCEPTION 'web-search replay was not idempotent';
  END IF;
END;
$$;

DO $$
DECLARE
  interrupted_run_id uuid := (SELECT id FROM analysis_runs WHERE session_id = 'verify-interrupted-run');
  straight_run_id uuid := (
    SELECT active_analysis_run_id
    FROM onboarding_cases
    WHERE id = '30000000-0000-0000-0000-000000000001'
  );
  retrieved_record record;
BEGIN
  SELECT * INTO retrieved_record
  FROM retrieve_case_evidence(interrupted_run_id, 'address', NULL, 5)
  LIMIT 1;

  IF retrieved_record.source_id <> '50000000-0000-0000-0000-000000000002'::uuid
    OR retrieved_record.chunk_id <> '60000000-0000-0000-0000-000000000003'::uuid
    OR retrieved_record.locator <> 'Registered address'
  THEN
    RAISE EXCEPTION 'case retrieval escaped or omitted the pinned run evidence';
  END IF;

  SELECT * INTO retrieved_record
  FROM retrieve_policy_evidence(interrupted_run_id, 'marketplace', NULL, 5)
  LIMIT 1;

  IF retrieved_record.source_id <> '80000000-0000-0000-0000-000000000002'::uuid
    OR retrieved_record.chunk_id <> '90000000-0000-0000-0000-000000000003'::uuid
    OR retrieved_record.locator <> 'MRKT-2.1'
  THEN
    RAISE EXCEPTION 'policy retrieval omitted the context-specific pinned policy';
  END IF;

  IF EXISTS (
    SELECT 1 FROM retrieve_policy_evidence(straight_run_id, 'marketplace', NULL, 5)
    WHERE source_id = '80000000-0000-0000-0000-000000000002'::uuid
  ) THEN
    RAISE EXCEPTION 'policy retrieval crossed into a version not pinned to the run';
  END IF;
END;
$$;

DO $$
DECLARE
  run_id uuid := (SELECT id FROM analysis_runs WHERE session_id = 'verify-interrupted-run');
  artifact jsonb;
  first_outcome text;
  duplicate_outcome text;
  conflict_blocked boolean := false;
BEGIN
  artifact := jsonb_build_object(
    'schema_version', '1.0',
    'artifact_id', 'artifact-db-verification',
    'analysis_run_id', run_id::text,
    'task_id', 'task-db-verification',
    'context_id', 'context-db-verification',
    'agent', jsonb_build_object('name', 'jeen-entity-agent', 'version', '1.0.0'),
    'specialty', 'entity',
    'status', 'completed',
    'confidence', 1,
    'observations', '[]'::jsonb,
    'evidence_gaps', '[]'::jsonb,
    'conflicts', '[]'::jsonb,
    'citations', '[]'::jsonb,
    'error', NULL,
    'created_at', '2026-09-18T20:00:00.000Z'
  );

  SELECT record_a2a_specialist_result(
    run_id, 'entity', 'jeen-entity-agent', '1.0.0',
    'http://entity/.well-known/agent-card.json', 'http://entity/a2a', 'resolve_entity',
    'task-db-verification', 'context-db-verification', 'message-db-verification',
    'correlation-db-verification', 1, 25, artifact, '2026-09-18T20:00:01.000Z'
  ) INTO first_outcome;

  SELECT record_a2a_specialist_result(
    run_id, 'entity', 'jeen-entity-agent', '1.0.0',
    'http://entity/.well-known/agent-card.json', 'http://entity/a2a', 'resolve_entity',
    'task-db-verification', 'context-db-verification', 'message-db-verification',
    'correlation-db-verification', 1, 25, artifact, '2026-09-18T20:00:01.000Z'
  ) INTO duplicate_outcome;

  IF first_outcome <> 'stored' OR duplicate_outcome <> 'duplicate' THEN
    RAISE EXCEPTION 'A2A provenance persistence is not idempotent';
  END IF;

  IF (SELECT count(*) FROM a2a_agent_assignments WHERE analysis_run_id = run_id) <> 1
    OR (SELECT count(*) FROM a2a_tasks WHERE analysis_run_id = run_id) <> 1
    OR (SELECT count(*) FROM specialist_artifacts WHERE analysis_run_id = run_id) <> 1
  THEN
    RAISE EXCEPTION 'A2A provenance rows were not stored exactly once';
  END IF;

  BEGIN
    PERFORM record_a2a_specialist_result(
      run_id, 'entity', 'jeen-entity-agent', '1.0.0',
      'http://entity/.well-known/agent-card.json', 'http://entity/a2a', 'resolve_entity',
      'task-db-verification', 'context-db-verification', 'message-db-verification',
      'correlation-db-verification', 1, 25,
      jsonb_set(artifact, '{confidence}', '0.5'::jsonb),
      '2026-09-18T20:00:01.000Z'
    );
  EXCEPTION WHEN raise_exception THEN
    conflict_blocked := position('conflicts with existing payload' IN SQLERRM) > 0;
  END;

  IF NOT conflict_blocked THEN
    RAISE EXCEPTION 'conflicting A2A artifact payload was accepted';
  END IF;
END;
$$;

DO $$
DECLARE
  run_id uuid := (SELECT id FROM analysis_runs WHERE session_id = 'verify-interrupted-run');
  request_id uuid := 'a0000000-0000-4000-8000-000000000001';
  response jsonb := jsonb_build_object(
    'input_type', 'text',
    'value', 'Priya Shah owns the remaining 18%.'
  );
  replacement_artifact jsonb;
  outcome text;
  mismatch_blocked boolean := false;
BEGIN
  SELECT suspend_analysis_run_for_input(
    request_id, run_id, 'task-db-verification',
    'Who owns the remaining 18%?',
    'The submitted ownership declaration accounts for only 82%.',
    'text', NULL, 'langflow-job-verification', 'checkpoint-verification',
    'correlation-db-verification'
  ) INTO outcome;

  IF outcome <> 'stored'
    OR (SELECT status FROM analysis_runs WHERE id = run_id) <> 'suspended'
    OR (SELECT status FROM onboarding_cases WHERE id = '30000000-0000-0000-0000-000000000002')
      <> 'awaiting_information'
    OR (SELECT count(*) FROM human_input_requests
        WHERE analysis_run_id = run_id AND status = 'pending') <> 1
  THEN
    RAISE EXCEPTION 'human-input suspension was not stored atomically';
  END IF;

  SELECT suspend_analysis_run_for_input(
    request_id, run_id, 'task-db-verification',
    'Who owns the remaining 18%?',
    'The submitted ownership declaration accounts for only 82%.',
    'text', NULL, 'langflow-job-verification', 'checkpoint-verification',
    'correlation-db-verification'
  ) INTO outcome;
  IF outcome <> 'duplicate' THEN
    RAISE EXCEPTION 'duplicate human-input suspension was not idempotent';
  END IF;

  BEGIN
    PERFORM submit_human_input_response(
      request_id,
      '30000000-0000-0000-0000-000000000001',
      run_id, response, 'analyst@example.test',
      '2026-09-19T15:00:00.000Z', 'response-verification'
    );
  EXCEPTION WHEN raise_exception THEN
    mismatch_blocked := position('does not match' IN SQLERRM) > 0;
  END;
  IF NOT mismatch_blocked THEN
    RAISE EXCEPTION 'mismatched human-input response was accepted';
  END IF;

  SELECT submit_human_input_response(
    request_id,
    '30000000-0000-0000-0000-000000000002',
    run_id, response, 'analyst@example.test',
    '2026-09-19T15:00:00.000Z', 'response-verification'
  ) INTO outcome;
  IF outcome <> 'stored'
    OR (SELECT status FROM analysis_runs WHERE id = run_id) <> 'running'
    OR (SELECT status FROM onboarding_cases WHERE id = '30000000-0000-0000-0000-000000000002')
      <> 'processing'
  THEN
    RAISE EXCEPTION 'human-input response did not resume the run atomically';
  END IF;

  SELECT submit_human_input_response(
    request_id,
    '30000000-0000-0000-0000-000000000002',
    run_id, response, 'analyst@example.test',
    '2026-09-19T15:00:00.000Z', 'response-verification'
  ) INTO outcome;
  IF outcome <> 'duplicate' THEN
    RAISE EXCEPTION 'duplicate human-input response was not idempotent';
  END IF;

  replacement_artifact := jsonb_build_object(
    'schema_version', '1.0',
    'artifact_id', 'artifact-db-verification-resumed',
    'analysis_run_id', run_id::text,
    'task_id', 'task-db-verification-resumed',
    'context_id', 'context-db-verification-resumed',
    'agent', jsonb_build_object('name', 'jeen-entity-agent', 'version', '1.0.0'),
    'specialty', 'entity',
    'status', 'completed',
    'confidence', 1,
    'observations', '[]'::jsonb,
    'evidence_gaps', '[]'::jsonb,
    'conflicts', '[]'::jsonb,
    'citations', '[]'::jsonb,
    'error', NULL,
    'created_at', '2026-09-19T15:00:01.000Z'
  );

  PERFORM record_a2a_specialist_result(
    run_id, 'entity', 'jeen-entity-agent', '1.0.0',
    'http://entity/.well-known/agent-card.json', 'http://entity/a2a', 'resolve_entity',
    'task-db-verification-resumed', 'context-db-verification-resumed',
    'message-db-verification-resumed', 'correlation-db-verification',
    1, 20, replacement_artifact, '2026-09-19T15:00:02.000Z'
  );

  SELECT link_human_input_resume(request_id, 'task-db-verification-resumed') INTO outcome;
  IF outcome <> 'stored' THEN
    RAISE EXCEPTION 'replacement specialist task was not linked';
  END IF;
  SELECT link_human_input_resume(request_id, 'task-db-verification-resumed') INTO outcome;
  IF outcome <> 'duplicate' THEN
    RAISE EXCEPTION 'duplicate resume link was not idempotent';
  END IF;

  IF (SELECT replacement_task_id FROM human_input_requests WHERE id = request_id)
      <> 'task-db-verification-resumed'
    OR (SELECT count(*) FROM workflow_events
        WHERE analysis_run_id = run_id
          AND event_type IN (
            'human.input.requested', 'human.input.submitted', 'human.input.resumed'
          )) <> 3
  THEN
    RAISE EXCEPTION 'clarification provenance chain is incomplete';
  END IF;
END;
$$;

DO $$
DECLARE
  run_id uuid := (SELECT id FROM analysis_runs WHERE session_id = 'verify-interrupted-run');
BEGIN
  INSERT INTO findings (
    id, analysis_run_id, requirement_code, outcome, summary, rationale, confidence
  ) VALUES (
    'f0000000-0000-0000-0000-000000000001', run_id,
    'KYB-1.1', 'uncertain', 'Registration evidence requires attention.',
    'The entity specialist contribution must remain traceable.', 0.9
  );

  INSERT INTO finding_specialist_artifacts (
    finding_id, analysis_run_id, task_id, artifact_id
  ) VALUES (
    'f0000000-0000-0000-0000-000000000001', run_id,
    'task-db-verification', 'artifact-db-verification'
  );

  INSERT INTO citations (
    analysis_run_id, finding_id, source_kind, human_input_request_id,
    locator, excerpt
  ) VALUES (
    run_id, 'f0000000-0000-0000-0000-000000000001', 'human_input',
    'a0000000-0000-4000-8000-000000000001',
    'Reviewer clarification', 'Priya Shah owns the remaining 18%.'
  );

  IF NOT EXISTS (
    SELECT 1
    FROM finding_specialist_artifacts provenance
    JOIN specialist_artifacts artifact
      ON artifact.task_id = provenance.task_id
      AND artifact.artifact_id = provenance.artifact_id
      AND artifact.analysis_run_id = provenance.analysis_run_id
    WHERE provenance.finding_id = 'f0000000-0000-0000-0000-000000000001'
      AND artifact.specialty = 'entity'
  ) THEN
    RAISE EXCEPTION 'finding did not preserve specialist artifact provenance';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM citations
    WHERE human_input_request_id = 'a0000000-0000-4000-8000-000000000001'
      AND source_kind = 'human_input'
  ) THEN
    RAISE EXCEPTION 'finding did not preserve human-input evidence provenance';
  END IF;
END;
$$;

DO $$
DECLARE
  active_run_blocked boolean := false;
  isolation_blocked boolean := false;
  mutation_blocked boolean := false;
  chunk_mutation_blocked boolean := false;
  policy_mutation_blocked boolean := false;
  snapshot_mutation_blocked boolean := false;
  late_snapshot_blocked boolean := false;
  run_input_mutation_blocked boolean := false;
BEGIN
  IF (
    SELECT count(*)
    FROM analysis_run_documents
    WHERE analysis_run_id = (
      SELECT id FROM analysis_runs WHERE session_id = 'verify-interrupted-run'
    )
  ) <> 1 THEN
    RAISE EXCEPTION 'analysis run did not pin the interrupted case evidence';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM analysis_runs run
    JOIN onboarding_cases onboarding_case
      ON onboarding_case.active_analysis_run_id = run.id
    WHERE run.session_id = 'verify-interrupted-run'
      AND run.output_schema_version = '1.1'
      AND run.policy_effective_on = DATE '2026-09-18'
      AND run.case_snapshot #>> '{applicant,legal_name}' = 'Mercado Bridge Ltd'
      AND run.case_snapshot #>> '{submitted_payload,declared_ownership_total}' = '82'
      AND onboarding_case.status = 'processing'
  ) THEN
    RAISE EXCEPTION 'analysis run did not capture and activate its case snapshot';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM analysis_run_policy_versions snapshot
    JOIN policy_versions version ON version.id = snapshot.policy_version_id
    JOIN policy_documents policy ON policy.id = version.policy_document_id
    WHERE snapshot.analysis_run_id = (
      SELECT id FROM analysis_runs WHERE session_id = 'verify-interrupted-run'
    )
      AND policy.code = 'MRKT'
  ) THEN
    RAISE EXCEPTION 'marketplace case did not pin the marketplace policy';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM policy_chunks chunk
    JOIN applicants applicant ON applicant.id = '10000000-0000-0000-0000-000000000001'
    JOIN policy_versions version ON version.id = chunk.policy_version_id
    JOIN policy_documents policy ON policy.id = version.policy_document_id
    WHERE policy.code = 'MRKT'
      AND ('*' = ANY(chunk.products) OR applicant.product = ANY(chunk.products))
      AND ('*' = ANY(chunk.business_types) OR applicant.business_type = ANY(chunk.business_types))
  ) THEN
    RAISE EXCEPTION 'domestic software case incorrectly matched marketplace policy';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM policy_chunks chunk
    JOIN applicants applicant ON applicant.id = '10000000-0000-0000-0000-000000000003'
    JOIN policy_versions version ON version.id = chunk.policy_version_id
    JOIN policy_documents policy ON policy.id = version.policy_document_id
    WHERE policy.code = 'LIC'
      AND ('*' = ANY(chunk.products) OR applicant.product = ANY(chunk.products))
      AND ('*' = ANY(chunk.business_types) OR applicant.business_type = ANY(chunk.business_types))
  ) THEN
    RAISE EXCEPTION 'money-services case did not match licensing policy';
  END IF;

  BEGIN
    PERFORM start_analysis_run(
      '30000000-0000-0000-0000-000000000002',
      'verify-second-active-run'
    );
  EXCEPTION WHEN unique_violation THEN
    active_run_blocked := true;
  END;

  IF NOT active_run_blocked THEN
    RAISE EXCEPTION 'a second active run was allowed for the same case';
  END IF;

  BEGIN
    UPDATE case_documents
    SET applicant_id = '10000000-0000-0000-0000-000000000001'
    WHERE id = '50000000-0000-0000-0000-000000000003';
  EXCEPTION WHEN foreign_key_violation THEN
    isolation_blocked := true;
  WHEN raise_exception THEN
    isolation_blocked := position('immutable' IN SQLERRM) > 0;
  END;

  IF NOT isolation_blocked THEN
    RAISE EXCEPTION 'a document was allowed to cross applicant and case boundaries';
  END IF;

  BEGIN
    UPDATE case_documents
    SET checksum_sha256 = repeat('a', 64)
    WHERE id = '50000000-0000-0000-0000-000000000002';
  EXCEPTION WHEN raise_exception THEN
    mutation_blocked := position('immutable' IN SQLERRM) > 0;
  END;

  IF NOT mutation_blocked THEN
    RAISE EXCEPTION 'a pinned source document was mutable';
  END IF;

  BEGIN
    UPDATE document_chunks
    SET content = 'Rewritten ownership evidence.'
    WHERE id = '60000000-0000-0000-0000-000000000002';
  EXCEPTION WHEN raise_exception THEN
    chunk_mutation_blocked := position('immutable' IN SQLERRM) > 0;
  END;

  IF NOT chunk_mutation_blocked THEN
    RAISE EXCEPTION 'a chunk belonging to pinned evidence was mutable';
  END IF;

  BEGIN
    UPDATE policy_chunks
    SET content = 'Rewritten policy requirement.'
    WHERE id = '90000000-0000-0000-0000-000000000003';
  EXCEPTION WHEN raise_exception THEN
    policy_mutation_blocked := position('immutable' IN SQLERRM) > 0;
  END;

  IF NOT policy_mutation_blocked THEN
    RAISE EXCEPTION 'a chunk belonging to a pinned policy was mutable';
  END IF;

  BEGIN
    DELETE FROM analysis_run_documents
    WHERE analysis_run_id = (
      SELECT id FROM analysis_runs WHERE session_id = 'verify-interrupted-run'
    );
  EXCEPTION WHEN raise_exception THEN
    snapshot_mutation_blocked := position('immutable' IN SQLERRM) > 0;
  END;

  IF NOT snapshot_mutation_blocked THEN
    RAISE EXCEPTION 'an evidence snapshot row was removable';
  END IF;

  BEGIN
    INSERT INTO analysis_run_documents (analysis_run_id, case_id, document_id)
    VALUES (
      (SELECT id FROM analysis_runs WHERE session_id = 'verify-interrupted-run'),
      '30000000-0000-0000-0000-000000000002',
      '50000000-0000-0000-0000-000000000002'
    );
  EXCEPTION WHEN raise_exception THEN
    late_snapshot_blocked := position('after an analysis run starts' IN SQLERRM) > 0;
  END;

  IF NOT late_snapshot_blocked THEN
    RAISE EXCEPTION 'evidence could be added after an analysis run started';
  END IF;

  BEGIN
    UPDATE analysis_runs
    SET case_snapshot = jsonb_set(case_snapshot, '{case_reference}', '"rewritten"')
    WHERE session_id = 'verify-interrupted-run';
  EXCEPTION WHEN raise_exception THEN
    run_input_mutation_blocked := position('immutable' IN SQLERRM) > 0;
  END;

  IF NOT run_input_mutation_blocked THEN
    RAISE EXCEPTION 'captured analysis run inputs were mutable';
  END IF;
END;
$$;

DO $$
DECLARE
  run_id uuid := (SELECT id FROM analysis_runs WHERE session_id = 'verify-interrupted-run');
  citation_id uuid := (
    SELECT id FROM citations
    WHERE analysis_run_id = (SELECT id FROM analysis_runs WHERE session_id = 'verify-interrupted-run')
    ORDER BY created_at, id
    LIMIT 1
  );
  action_id uuid := 'b0000000-0000-4000-8000-000000000001';
  review_id uuid := 'b0000000-0000-4000-8000-000000000002';
  payload jsonb := jsonb_build_object(
    'recipient', 'applicant',
    'subject', 'Complete ownership information required',
    'requested_items', jsonb_build_array('Identify the owner of the remaining 18% interest.'),
    'delivery_channel', 'case_portal'
  );
  outcome text;
  mismatch_blocked boolean := false;
BEGIN
  SELECT propose_information_request_action(
    action_id, review_id, run_id,
    '30000000-0000-0000-0000-000000000002',
    'Request the missing beneficial-owner declaration.', payload,
    ARRAY['f0000000-0000-0000-0000-000000000001'::uuid],
    ARRAY[citation_id],
    'verify:ownership-information-request', 'correlation-db-verification'
  ) INTO outcome;

  IF outcome <> 'stored'
    OR (SELECT status FROM proposed_actions WHERE id = action_id) <> 'pending'
    OR (SELECT status FROM analysis_runs WHERE id = run_id) <> 'suspended'
    OR (SELECT status FROM onboarding_cases
        WHERE id = '30000000-0000-0000-0000-000000000002') <> 'awaiting_approval'
  THEN
    RAISE EXCEPTION 'approval proposal was not stored atomically';
  END IF;

  SELECT propose_information_request_action(
    action_id, review_id, run_id,
    '30000000-0000-0000-0000-000000000002',
    'Request the missing beneficial-owner declaration.', payload,
    ARRAY['f0000000-0000-0000-0000-000000000001'::uuid],
    ARRAY[citation_id],
    'verify:ownership-information-request', 'correlation-db-verification'
  ) INTO outcome;
  IF outcome <> 'duplicate' THEN
    RAISE EXCEPTION 'duplicate action proposal was not idempotent';
  END IF;

  BEGIN
    PERFORM decide_information_request_action(
      review_id, action_id, run_id,
      '30000000-0000-0000-0000-000000000001',
      'approved', 'analyst-42',
      'The cited ownership gap supports a targeted information request.',
      '2026-09-19T18:00:00.000Z', 'verify-review:approved'
    );
  EXCEPTION WHEN raise_exception THEN
    mismatch_blocked := position('does not match' IN SQLERRM) > 0;
  END;
  IF NOT mismatch_blocked THEN
    RAISE EXCEPTION 'out-of-scope analyst decision was accepted';
  END IF;

  SELECT decide_information_request_action(
    review_id, action_id, run_id,
    '30000000-0000-0000-0000-000000000002',
    'approved', 'analyst-42',
    'The cited ownership gap supports a targeted information request.',
    '2026-09-19T18:00:00.000Z', 'verify-review:approved'
  ) INTO outcome;

  IF outcome <> 'executed'
    OR (SELECT status FROM proposed_actions WHERE id = action_id) <> 'executed'
    OR (SELECT count(*) FROM information_requests WHERE proposed_action_id = action_id) <> 1
    OR (SELECT count(*) FROM approvals WHERE proposed_action_id = action_id) <> 1
    OR (SELECT status FROM analysis_runs WHERE id = run_id) <> 'succeeded'
    OR (SELECT status FROM onboarding_cases
        WHERE id = '30000000-0000-0000-0000-000000000002') <> 'awaiting_information'
  THEN
    RAISE EXCEPTION 'approved information-request action was not executed atomically';
  END IF;

  SELECT decide_information_request_action(
    review_id, action_id, run_id,
    '30000000-0000-0000-0000-000000000002',
    'approved', 'analyst-42',
    'The cited ownership gap supports a targeted information request.',
    '2026-09-19T18:00:00.000Z', 'verify-review:approved'
  ) INTO outcome;

  IF outcome <> 'duplicate'
    OR (SELECT count(*) FROM information_requests WHERE proposed_action_id = action_id) <> 1
    OR (SELECT count(*) FROM audit_events event
        WHERE event.analysis_run_id = run_id AND event.event_type = 'action.executed'
          AND event.payload ->> 'proposed_action_id' = action_id::text) <> 1
    OR (SELECT count(*) FROM workflow_events event
        WHERE event.analysis_run_id = run_id AND event.event_type = 'action.executed'
          AND event.payload ->> 'proposed_action_id' = action_id::text) <> 1
  THEN
    RAISE EXCEPTION 'approved action retry created duplicate side effects';
  END IF;
END;
$$;

ROLLBACK;

\echo 'Data foundation checks passed.'
