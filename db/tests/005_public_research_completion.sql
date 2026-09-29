BEGIN;

DO $$
DECLARE
  target_case_id uuid := '30000000-0000-0000-0000-000000000001';
  run_id uuid;
  target_finding_id uuid := 'e0000000-0000-4000-8000-000000000001';
  citation_id uuid := 'e0000000-0000-4000-8000-000000000002';
  action_id uuid := 'e0000000-0000-4000-8000-000000000003';
  review_id uuid := 'e0000000-0000-4000-8000-000000000004';
  execution_id uuid := 'e0000000-0000-4000-8000-000000000005';
  evidence_id uuid := 'e0000000-0000-4000-8000-000000000006';
  result_review_id uuid;
  document_chunk_id uuid;
  artifact jsonb;
  outcome text;
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
    'verify:public-research-completion',
    'Verify approved public evidence completion.',
    '1.1', DATE '2026-09-18'
  );
  UPDATE analysis_runs SET status = 'running' WHERE id = run_id;

  SELECT chunk.id INTO document_chunk_id
  FROM analysis_run_documents snapshot
  JOIN document_chunks chunk ON chunk.document_id = snapshot.document_id
  WHERE snapshot.analysis_run_id = run_id
  ORDER BY chunk.chunk_index LIMIT 1;

  INSERT INTO findings (
    id, analysis_run_id, requirement_code, outcome, summary, rationale, confidence
  ) VALUES (
    target_finding_id, run_id, 'LIC-3.1', 'uncertain',
    'The license claim requires authoritative evidence.',
    'The submitted evidence does not contain a registry record.', 0.9
  );
  INSERT INTO citations (
    id, analysis_run_id, finding_id, source_kind, document_chunk_id, locator, excerpt
  ) VALUES (
    citation_id, run_id, target_finding_id, 'case_document', document_chunk_id,
    'License claim', 'The applicant claims a regulated license.'
  );

  PERFORM propose_web_search_action(
    action_id, review_id, run_id, target_case_id,
    'Search the official regulator for the claimed license.',
    jsonb_build_object(
      'query', 'Example Payments official license',
      'reason', 'The claim lacks authoritative support.',
      'allowed_domains', jsonb_build_array('regulator.example.gov'),
      'max_results', 1,
      'intended_use', 'Verify the claimed license.',
      'external_disclosure', jsonb_build_array('legal_name', 'claimed_license_type')
    ), ARRAY[target_finding_id], ARRAY[citation_id],
    'verify:public-research:proposal', 'verify:public-research:correlation'
  );
  PERFORM decide_web_search_action_authorized(
    review_id, action_id, run_id, target_case_id,
    'approved', 'analyst_demo',
    'The exact official-registry query is necessary and proportionate.',
    now(), 'verify:public-research:approval', execution_id,
    now() + interval '10 minutes', ARRAY['compliance_analyst']
  );
  PERFORM claim_web_search_execution(
    execution_id, action_id, run_id, target_case_id,
    'Example Payments official license', ARRAY['regulator.example.gov'], 1,
    'Verify the claimed license.', ARRAY['legal_name', 'claimed_license_type'], now()
  );
  PERFORM complete_web_search_execution(
    execution_id, action_id, run_id, target_case_id, 'provider-request-1',
    jsonb_build_array(jsonb_build_object(
      'id', evidence_id,
      'searchExecutionId', execution_id::text,
      'url', 'https://regulator.example.gov/license/example',
      'canonicalUrl', 'https://regulator.example.gov/license/example',
      'title', 'Example Payments license',
      'publisher', 'regulator.example.gov',
      'publishedAt', NULL,
      'retrievedAt', now(),
      'excerpt', 'Example Payments holds license MT-1234.',
      'contentHash', 'sha256:' || repeat('a', 64)
    )), now()
  );

  SELECT id INTO result_review_id
  FROM web_result_reviews WHERE search_execution_id = execution_id;
  SELECT decide_web_result_review_authorized(
    result_review_id, execution_id, run_id, target_case_id,
    jsonb_build_array(jsonb_build_object(
      'evidence_id', evidence_id,
      'content_hash', 'sha256:' || repeat('a', 64),
      'decision', 'accepted'
    )),
    'analyst_demo', 'The official registry result is relevant and may be analyzed.',
    now(), 'verify:public-research:result-review', ARRAY['compliance_analyst']
  ) INTO outcome;
  IF outcome <> 'accepted' THEN
    RAISE EXCEPTION 'accepted web result did not release the run';
  END IF;

  SELECT claim_public_research_completion(execution_id, now()) INTO outcome;
  IF outcome <> 'claimed' THEN
    RAISE EXCEPTION 'successful web evidence was not claimed for public research';
  END IF;

  BEGIN
    PERFORM record_a2a_specialist_failure(
      run_id, 'public_research', 'jeen-public-research-agent', '1.0.0',
      'http://failed-public-research/.well-known/agent-card.json',
      'http://failed-public-research/a2a', 'analyze_approved_public_evidence',
      'failed-dispatch:public-research-db-check',
      'failed-context:public-research-db-check',
      'failed-message-public-research-db-check',
      'verify:public-research:failure', 2, 75,
      'public_research_dispatch_failed',
      'public_research specialist failed after 2 attempts', now()
    );
    PERFORM fail_public_research_completion(
      execution_id, 'public_research_dispatch_failed',
      'public_research specialist failed after 2 attempts', now()
    );

    IF (SELECT research_status FROM web_search_executions WHERE id = execution_id) <> 'failed'
      OR (SELECT status FROM analysis_runs WHERE id = run_id) <> 'failed'
      OR (SELECT status FROM onboarding_cases WHERE id = target_case_id) <> 'attention_required'
      OR NOT EXISTS (
        SELECT 1 FROM a2a_tasks
        WHERE analysis_run_id = run_id
          AND specialty = 'public_research'
          AND status = 'failed'
          AND attempts = 2
      )
      OR NOT EXISTS (
        SELECT 1 FROM audit_events
        WHERE analysis_run_id = run_id
          AND event_type = 'public_research.failed'
      )
    THEN
      RAISE EXCEPTION 'public-research failure did not require attention atomically';
    END IF;

    RAISE EXCEPTION 'rollback verified failure branch' USING ERRCODE = 'unique_violation';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  artifact := jsonb_build_object(
    'schema_version', '1.0',
    'artifact_id', 'artifact-public-research-db-check',
    'analysis_run_id', run_id::text,
    'task_id', 'task-public-research-db-check',
    'context_id', 'context-public-research-db-check',
    'agent', jsonb_build_object(
      'name', 'jeen-public-research-agent', 'version', '1.0.0'
    ),
    'specialty', 'public_research', 'status', 'completed', 'confidence', 0.7,
    'observations', jsonb_build_array(jsonb_build_object(
      'id', 'public-result-db-check',
      'summary', 'The approved search returned one citable source.',
      'rationale_summary', 'Stored public evidence only.',
      'confidence', 0.7,
      'citation_ids', jsonb_build_array('web-' || evidence_id::text)
    )),
    'evidence_gaps', '[]'::jsonb,
    'conflicts', '[]'::jsonb,
    'citations', jsonb_build_array(jsonb_build_object(
      'id', 'web-' || evidence_id::text,
      'source_kind', 'external_web',
      'url', 'https://regulator.example.gov/license/example',
      'canonical_url', 'https://regulator.example.gov/license/example',
      'title', 'Example Payments license',
      'publisher', 'regulator.example.gov',
      'published_at', NULL,
      'retrieved_at', (SELECT retrieved_at FROM external_web_evidence WHERE id = evidence_id),
      'excerpt', 'Example Payments holds license MT-1234.',
      'content_hash', 'sha256:' || repeat('a', 64),
      'retrieval_method', 'firecrawl_search',
      'search_execution_id', execution_id::text,
      'agent_task_id', 'task-public-research-db-check',
      'agent_artifact_id', 'artifact-public-research-db-check'
    )),
    'error', NULL, 'created_at', now()
  );

  PERFORM record_a2a_specialist_result(
    run_id, 'public_research', 'jeen-public-research-agent', '1.0.0',
    'http://public-research/.well-known/agent-card.json',
    'http://public-research/a2a', 'analyze_approved_public_evidence',
    'task-public-research-db-check', 'context-public-research-db-check',
    'message-public-research-db-check', 'verify:public-research:correlation',
    1, 50, artifact, now()
  );
  SELECT complete_public_research_completion(
    execution_id, 'task-public-research-db-check',
    'artifact-public-research-db-check', now()
  ) INTO outcome;

  IF outcome <> 'succeeded'
    OR (SELECT research_status FROM web_search_executions WHERE id = execution_id) <> 'succeeded'
    OR (SELECT status FROM analysis_runs WHERE id = run_id) <> 'succeeded'
    OR (SELECT status FROM onboarding_cases WHERE id = target_case_id) <> 'ready_for_review'
    OR NOT EXISTS (
      SELECT 1 FROM citations
      WHERE analysis_run_id = run_id
        AND finding_id = target_finding_id
        AND source_kind = 'external_web'
        AND external_web_evidence_id = evidence_id
        AND agent_task_id = 'task-public-research-db-check'
    )
    OR NOT EXISTS (
      SELECT 1 FROM finding_specialist_artifacts
      WHERE finding_id = target_finding_id
        AND task_id = 'task-public-research-db-check'
    )
    OR NOT EXISTS (
      SELECT 1 FROM audit_events
      WHERE analysis_run_id = run_id
        AND event_type = 'public_research.completed'
    )
  THEN
    RAISE EXCEPTION 'public-research success was not persisted atomically';
  END IF;

  SELECT claim_public_research_completion(execution_id, now()) INTO outcome;
  IF outcome <> 'succeeded' THEN
    RAISE EXCEPTION 'completed public research was not idempotent';
  END IF;
END;
$$;

ROLLBACK;

\echo 'Public-research completion checks passed.'
