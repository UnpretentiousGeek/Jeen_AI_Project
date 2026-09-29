BEGIN;

DO $$
DECLARE
  target_case_id uuid := '30000000-0000-0000-0000-000000000001';
  run_id uuid;
  finding_id uuid := gen_random_uuid();
  citation_id uuid := gen_random_uuid();
  action_id uuid := gen_random_uuid();
  search_review_id uuid := gen_random_uuid();
  execution_id uuid := gen_random_uuid();
  accepted_evidence_id uuid := gen_random_uuid();
  rejected_evidence_id uuid := gen_random_uuid();
  result_review_id uuid;
  document_chunk_id uuid;
  outcome text;
  gate_blocked boolean := false;
  incomplete_blocked boolean := false;
BEGIN
  UPDATE analysis_runs
  SET status = 'cancelled', finished_at = now()
  WHERE id = (SELECT active_analysis_run_id FROM onboarding_cases WHERE id = target_case_id)
    AND status IN ('queued', 'running', 'suspended');
  UPDATE onboarding_cases SET active_analysis_run_id = NULL, status = 'draft'
  WHERE id = target_case_id;

  SELECT id INTO run_id FROM start_analysis_run(
    target_case_id, 'verify:web-result-review',
    'Verify that only analyst-accepted web results reach agents.', '1.1', DATE '2026-09-18'
  );
  UPDATE analysis_runs SET status = 'running' WHERE id = run_id;
  SELECT chunk.id INTO document_chunk_id
  FROM analysis_run_documents snapshot
  JOIN document_chunks chunk ON chunk.document_id = snapshot.document_id
  WHERE snapshot.analysis_run_id = run_id ORDER BY chunk.chunk_index LIMIT 1;

  INSERT INTO findings (id, analysis_run_id, requirement_code, outcome, summary, rationale, confidence)
  VALUES (finding_id, run_id, 'LIC-3.1', 'uncertain',
          'The license claim requires authoritative evidence.',
          'The application does not include a registry record.', 0.9);
  INSERT INTO citations (
    id, analysis_run_id, finding_id, source_kind, document_chunk_id, locator, excerpt
  ) VALUES (
    citation_id, run_id, finding_id, 'case_document', document_chunk_id,
    'License claim', 'The applicant claims a regulated license.'
  );

  PERFORM propose_web_search_action(
    action_id, search_review_id, run_id, target_case_id,
    'Search the official regulator for the claimed license.',
    jsonb_build_object(
      'query', 'Example Payments official license',
      'reason', 'The claim lacks authoritative support.',
      'allowed_domains', jsonb_build_array('regulator.example.gov'),
      'max_results', 2,
      'intended_use', 'Verify the claimed license.',
      'external_disclosure', jsonb_build_array('legal_name')
    ), ARRAY[finding_id], ARRAY[citation_id],
    'verify:web-result-review:proposal', 'verify:web-result-review:correlation'
  );
  PERFORM decide_web_search_action_authorized(
    search_review_id, action_id, run_id, target_case_id,
    'approved', 'analyst_demo', 'The exact official-registry query is proportionate.',
    now(), 'verify:web-result-review:search-approval', execution_id,
    now() + interval '10 minutes', ARRAY['compliance_analyst']
  );
  PERFORM claim_web_search_execution(
    execution_id, action_id, run_id, target_case_id,
    'Example Payments official license', ARRAY['regulator.example.gov'], 2,
    'Verify the claimed license.', ARRAY['legal_name'], now()
  );
  PERFORM complete_web_search_execution(
    execution_id, action_id, run_id, target_case_id, 'provider-result-review',
    jsonb_build_array(
      jsonb_build_object(
        'id', accepted_evidence_id, 'searchExecutionId', execution_id::text,
        'url', 'https://regulator.example.gov/license/example',
        'canonicalUrl', 'https://regulator.example.gov/license/example',
        'title', 'Official license record', 'publisher', 'regulator.example.gov',
        'publishedAt', NULL, 'retrievedAt', now(),
        'excerpt', 'Example Payments holds license MT-1234.',
        'contentHash', 'sha256:' || repeat('a', 64)
      ),
      jsonb_build_object(
        'id', rejected_evidence_id, 'searchExecutionId', execution_id::text,
        'url', 'https://regulator.example.gov/archive/example',
        'canonicalUrl', 'https://regulator.example.gov/archive/example',
        'title', 'Outdated archive entry', 'publisher', 'regulator.example.gov',
        'publishedAt', NULL, 'retrievedAt', now(),
        'excerpt', 'An outdated archived entry.',
        'contentHash', 'sha256:' || repeat('b', 64)
      )
    ), now()
  );

  SELECT id INTO result_review_id
  FROM web_result_reviews WHERE search_execution_id = execution_id;
  IF result_review_id IS NULL
    OR (SELECT status FROM analysis_runs WHERE id = run_id) <> 'suspended'
    OR (SELECT status FROM onboarding_cases WHERE id = target_case_id) <> 'awaiting_approval'
    OR (SELECT count(*) FROM web_result_review_items
        WHERE review_id = result_review_id AND review_state = 'pending_review') <> 2
  THEN
    RAISE EXCEPTION 'retrieval did not create a complete pending result review';
  END IF;

  BEGIN
    PERFORM claim_public_research_completion(execution_id, now());
  EXCEPTION WHEN raise_exception THEN
    gate_blocked := position('analyst acceptance' IN SQLERRM) > 0;
  END;
  IF NOT gate_blocked THEN
    RAISE EXCEPTION 'public research bypassed the result-review gate';
  END IF;

  BEGIN
    PERFORM decide_web_result_review_authorized(
      result_review_id, execution_id, run_id, target_case_id,
      jsonb_build_array(jsonb_build_object(
        'evidence_id', accepted_evidence_id,
        'content_hash', 'sha256:' || repeat('a', 64), 'decision', 'accepted'
      )),
      'analyst_demo', 'Only the current official record should be analyzed.',
      now(), 'verify:web-result-review:incomplete', ARRAY['compliance_analyst']
    );
  EXCEPTION WHEN raise_exception THEN
    incomplete_blocked := position('every unchanged web result' IN SQLERRM) > 0;
  END;
  IF NOT incomplete_blocked THEN
    RAISE EXCEPTION 'incomplete result review was accepted';
  END IF;

  BEGIN
    SELECT decide_web_result_review_authorized(
      result_review_id, execution_id, run_id, target_case_id,
      jsonb_build_array(
        jsonb_build_object(
          'evidence_id', accepted_evidence_id,
          'content_hash', 'sha256:' || repeat('a', 64), 'decision', 'rejected'
        ),
        jsonb_build_object(
          'evidence_id', rejected_evidence_id,
          'content_hash', 'sha256:' || repeat('b', 64), 'decision', 'rejected'
        )
      ),
      'analyst_demo', 'Neither result is reliable enough for specialist analysis.',
      now(), 'verify:web-result-review:rejected-all', ARRAY['compliance_analyst']
    ) INTO outcome;
    IF outcome <> 'rejected_all'
      OR (SELECT status FROM analysis_runs WHERE id = run_id) <> 'suspended'
      OR (SELECT status FROM onboarding_cases WHERE id = target_case_id) <> 'awaiting_information'
      OR NOT EXISTS (
        SELECT 1 FROM human_input_requests
        WHERE analysis_run_id = run_id
          AND request_type = 'clarification'
          AND status = 'pending'
          AND checkpoint_id = 'web-result-followup:' || execution_id::text
      )
    THEN
      RAISE EXCEPTION 'rejecting all results did not return to targeted analyst input';
    END IF;
    RAISE EXCEPTION 'rollback verified rejected-all branch' USING ERRCODE = 'unique_violation';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  SELECT decide_web_result_review_authorized(
    result_review_id, execution_id, run_id, target_case_id,
    jsonb_build_array(
      jsonb_build_object(
        'evidence_id', accepted_evidence_id,
        'content_hash', 'sha256:' || repeat('a', 64), 'decision', 'accepted'
      ),
      jsonb_build_object(
        'evidence_id', rejected_evidence_id,
        'content_hash', 'sha256:' || repeat('b', 64), 'decision', 'rejected'
      )
    ),
    'analyst_demo', 'Only the current official record should be analyzed.',
    now(), 'verify:web-result-review:complete', ARRAY['compliance_analyst']
  ) INTO outcome;

  IF outcome <> 'accepted'
    OR (SELECT status FROM analysis_runs WHERE id = run_id) <> 'running'
    OR (SELECT status FROM onboarding_cases WHERE id = target_case_id) <> 'processing'
    OR (SELECT review_state FROM web_result_review_items
        WHERE external_web_evidence_id = rejected_evidence_id) <> 'rejected'
    OR NOT EXISTS (
      SELECT 1 FROM audit_events
      WHERE analysis_run_id = run_id AND event_type = 'web_result_review.decided'
    )
  THEN
    RAISE EXCEPTION 'result decisions were not stored and resumed atomically';
  END IF;

  SELECT claim_public_research_completion(execution_id, now()) INTO outcome;
  IF outcome <> 'claimed' THEN
    RAISE EXCEPTION 'accepted evidence was not released for public research';
  END IF;
END;
$$;

ROLLBACK;

\echo 'Web-result review checks passed.'
