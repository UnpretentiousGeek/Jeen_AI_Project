BEGIN;

INSERT INTO applicants (id, legal_name, jurisdiction, business_type, product)
VALUES (
  '10000000-0000-0000-0000-000000000005',
  'Harborline Review Sandbox LLC', 'US', 'money_services', 'cross_border_payments'
) ON CONFLICT (id) DO NOTHING;

INSERT INTO applications (id, applicant_id, submitted_payload)
VALUES (
  '20000000-0000-0000-0000-000000000005',
  '10000000-0000-0000-0000-000000000005',
  '{"declared_ownership_total": 100, "claimed_license": "California money transmitter license", "fixture": "web_result_review"}'
) ON CONFLICT (id) DO NOTHING;

INSERT INTO onboarding_cases (id, application_id, applicant_id, reference)
VALUES (
  '30000000-0000-0000-0000-000000000005',
  '20000000-0000-0000-0000-000000000005',
  '10000000-0000-0000-0000-000000000005',
  'KYB-REVIEW-001'
) ON CONFLICT (id) DO NOTHING;

INSERT INTO evidence_submissions (id, case_id, submission_number, submitted_by)
VALUES (
  '40000000-0000-0000-0000-000000000005',
  '30000000-0000-0000-0000-000000000005', 1, 'synthetic_fixture'
) ON CONFLICT (id) DO NOTHING;

INSERT INTO case_documents (
  id, evidence_submission_id, case_id, applicant_id, document_type,
  original_filename, mime_type, checksum_sha256, storage_path,
  ingestion_status, parsed_text
) VALUES (
  '50000000-0000-0000-0000-000000000005',
  '40000000-0000-0000-0000-000000000005',
  '30000000-0000-0000-0000-000000000005',
  '10000000-0000-0000-0000-000000000005',
  'application_summary', 'web-result-review-sandbox.md', 'text/markdown',
  encode(digest('Harborline Review Sandbox claims an unsupported California license.', 'sha256'), 'hex'),
  'fixtures/cases/unsupported-license.md', 'ready',
  'Harborline Review Sandbox LLC claims a California money transmitter license, but supplied no license document, license number, or registry extract.'
) ON CONFLICT (id) DO NOTHING;

INSERT INTO document_chunks (
  id, document_id, case_id, applicant_id, evidence_submission_id,
  chunk_index, content, section_locator
) VALUES (
  '60000000-0000-0000-0000-000000000006',
  '50000000-0000-0000-0000-000000000005',
  '30000000-0000-0000-0000-000000000005',
  '10000000-0000-0000-0000-000000000005',
  '40000000-0000-0000-0000-000000000005', 0,
  'The applicant states that it holds a California money transmitter license. No supporting license evidence was supplied.',
  'License claim'
) ON CONFLICT (id) DO NOTHING;

DO $$
DECLARE
  run_id uuid;
  artifact jsonb;
BEGIN
  SELECT id INTO run_id
  FROM analysis_runs
  WHERE session_id = 'dashboard-web-result-review';

  IF run_id IS NULL THEN
    SELECT id INTO run_id
    FROM start_analysis_run(
      '30000000-0000-0000-0000-000000000005',
      'dashboard-web-result-review',
      'Verify the claimed California money transmitter license.',
      '1.1',
      DATE '2026-09-18'
    );
  END IF;

  artifact := jsonb_build_object(
    'schema_version', '1.0', 'artifact_id', 'artifact-result-review-entity',
    'analysis_run_id', run_id::text, 'task_id', 'task-result-review-entity',
    'context_id', 'context-result-review',
    'agent', jsonb_build_object('name', 'jeen-entity-agent', 'version', '1.0.0'),
    'specialty', 'entity', 'status', 'completed', 'confidence', 0.98,
    'observations', jsonb_build_array(jsonb_build_object(
      'id', 'observation-dashboard-entity', 'requirement_code', 'KYB-1.1',
      'summary', 'The declared legal name is consistent with the submitted case summary.',
      'rationale_summary', 'The normalized legal name matches the supplied entity evidence.',
      'confidence', 0.98, 'citation_ids', jsonb_build_array('case-dashboard-license')
    )),
    'evidence_gaps', '[]'::jsonb, 'conflicts', '[]'::jsonb,
    'citations', jsonb_build_array(jsonb_build_object(
      'id', 'case-dashboard-license', 'source_kind', 'case_document',
      'source_id', '50000000-0000-0000-0000-000000000005',
      'chunk_id', '60000000-0000-0000-0000-000000000006',
      'locator', 'License claim',
      'excerpt', 'The applicant states that it holds a California money transmitter license.'
    )),
    'error', NULL, 'created_at', '2026-09-19T19:00:00.000Z'
  );
  PERFORM record_a2a_specialist_result(
    run_id, 'entity', 'jeen-entity-agent', '1.0.0',
    'http://entity/.well-known/agent-card.json', 'http://entity/a2a', 'resolve_entity',
    'task-result-review-entity', 'context-result-review', 'message-result-review-entity',
    'correlation-result-review', 1, 84, artifact, '2026-09-19T19:00:01.000Z'
  );

  artifact := jsonb_build_object(
    'schema_version', '1.0', 'artifact_id', 'artifact-result-review-ownership',
    'analysis_run_id', run_id::text, 'task_id', 'task-result-review-ownership',
    'context_id', 'context-result-review',
    'agent', jsonb_build_object('name', 'jeen-ownership-agent', 'version', '1.0.0'),
    'specialty', 'ownership', 'status', 'completed', 'confidence', 0.99,
    'observations', jsonb_build_array(jsonb_build_object(
      'id', 'observation-dashboard-ownership', 'requirement_code', 'KYB-1.2',
      'summary', 'The declared ownership total is complete.',
      'rationale_summary', 'The structured ownership interests total 100 percent.',
      'confidence', 0.99, 'citation_ids', jsonb_build_array('case-dashboard-ownership')
    )),
    'evidence_gaps', '[]'::jsonb, 'conflicts', '[]'::jsonb,
    'citations', jsonb_build_array(jsonb_build_object(
      'id', 'case-dashboard-ownership', 'source_kind', 'case_document',
      'source_id', '50000000-0000-0000-0000-000000000005',
      'chunk_id', '60000000-0000-0000-0000-000000000006',
      'locator', 'Application summary', 'excerpt', 'Declared ownership total: 100%.'
    )),
    'error', NULL, 'created_at', '2026-09-19T19:00:00.100Z'
  );
  PERFORM record_a2a_specialist_result(
    run_id, 'ownership', 'jeen-ownership-agent', '1.0.0',
    'http://ownership/.well-known/agent-card.json', 'http://ownership/a2a', 'analyze_ownership',
    'task-result-review-ownership', 'context-result-review', 'message-result-review-ownership',
    'correlation-result-review', 1, 61, artifact, '2026-09-19T19:00:01.100Z'
  );

  artifact := jsonb_build_object(
    'schema_version', '1.0', 'artifact_id', 'artifact-result-review-policy',
    'analysis_run_id', run_id::text, 'task_id', 'task-result-review-policy',
    'context_id', 'context-result-review',
    'agent', jsonb_build_object('name', 'jeen-policy-agent', 'version', '1.0.0'),
    'specialty', 'policy', 'status', 'completed', 'confidence', 0.96,
    'observations', jsonb_build_array(jsonb_build_object(
      'id', 'observation-dashboard-policy', 'requirement_code', 'LIC-3.1',
      'summary', 'The claimed license requires documentary or authoritative registry support.',
      'rationale_summary', 'The pinned licensing policy does not permit an unsupported license claim.',
      'confidence', 0.96, 'citation_ids', jsonb_build_array('policy-dashboard-license')
    )),
    'evidence_gaps', jsonb_build_array(jsonb_build_object(
      'id', 'gap-dashboard-license', 'requirement_code', 'LIC-3.1',
      'description', 'No license document, number, or registry extract was supplied.',
      'requested_evidence', 'An authoritative registry record or current license document.',
      'citation_ids', jsonb_build_array('policy-dashboard-license')
    )),
    'conflicts', '[]'::jsonb,
    'citations', jsonb_build_array(jsonb_build_object(
      'id', 'policy-dashboard-license', 'source_kind', 'policy',
      'source_id', '80000000-0000-0000-0000-000000000003',
      'chunk_id', '90000000-0000-0000-0000-000000000004',
      'locator', 'LIC-3.1',
      'excerpt', 'Every claimed financial-services license must be supported by a license document or authoritative registry record.'
    )),
    'error', NULL, 'created_at', '2026-09-19T19:00:00.200Z'
  );
  PERFORM record_a2a_specialist_result(
    run_id, 'policy', 'jeen-policy-agent', '1.0.0',
    'http://policy/.well-known/agent-card.json', 'http://policy/a2a', 'retrieve_policy',
    'task-result-review-policy', 'context-result-review', 'message-result-review-policy',
    'correlation-result-review', 1, 112, artifact, '2026-09-19T19:00:01.200Z'
  );

  INSERT INTO findings (
    id, analysis_run_id, requirement_code, outcome, summary, rationale, confidence
  ) VALUES (
    'b1000000-0000-4000-8000-000000000001', run_id, 'LIC-3.1', 'uncertain',
    'The claimed California money transmitter license is unsupported.',
    'The applicant supplied no license document, license number, or registry extract. The pinned licensing policy requires documentary or authoritative registry evidence.',
    0.96
  ) ON CONFLICT (id) DO NOTHING;

  INSERT INTO finding_specialist_artifacts (
    finding_id, analysis_run_id, task_id, artifact_id
  ) VALUES (
    'b1000000-0000-4000-8000-000000000001', run_id,
    'task-result-review-policy', 'artifact-result-review-policy'
  ) ON CONFLICT DO NOTHING;

  INSERT INTO citations (
    id, analysis_run_id, finding_id, source_kind, document_chunk_id,
    locator, excerpt
  ) VALUES (
    'b1000000-0000-4000-8000-000000000002', run_id,
    'b1000000-0000-4000-8000-000000000001', 'case_document',
    '60000000-0000-0000-0000-000000000006', 'License claim',
    'The applicant states that it holds a California money transmitter license. No supporting license evidence was supplied.'
  ) ON CONFLICT (id) DO NOTHING;

  INSERT INTO citations (
    id, analysis_run_id, finding_id, source_kind, policy_chunk_id,
    locator, excerpt
  ) VALUES (
    'b1000000-0000-4000-8000-000000000003', run_id,
    'b1000000-0000-4000-8000-000000000001', 'policy',
    '90000000-0000-0000-0000-000000000004', 'LIC-3.1',
    'Every claimed financial-services license must be supported by a license document or authoritative registry record.'
  ) ON CONFLICT (id) DO NOTHING;

  IF NOT EXISTS (
    SELECT 1 FROM proposed_actions
    WHERE id = 'b1000000-0000-4000-8000-000000000010'
  ) THEN
    PERFORM propose_web_search_action(
      'b1000000-0000-4000-8000-000000000010',
      'b1000000-0000-4000-8000-000000000011',
      run_id,
      '30000000-0000-0000-0000-000000000005',
      'Search the official California regulator for the claimed license.',
      jsonb_build_object(
        'query', 'Harborline Review Sandbox LLC California money transmitter license',
        'reason', 'The applicant claims a license but supplied no supporting evidence.',
        'allowed_domains', jsonb_build_array('dfpi.ca.gov'),
        'max_results', 5,
        'intended_use', 'Locate an authoritative public record supporting the license claim.',
        'external_disclosure', jsonb_build_array('legal_name', 'claimed_license_type')
      ),
      ARRAY['b1000000-0000-4000-8000-000000000001'::uuid],
      ARRAY[
        'b1000000-0000-4000-8000-000000000002'::uuid,
        'b1000000-0000-4000-8000-000000000003'::uuid
      ],
      'dashboard-web-result-review:web-search-v1',
      'correlation-result-review'
    );
  END IF;

END;
$$;

DO $$
DECLARE
  active_run_id uuid;
  action_id uuid;
  search_review_id uuid;
  action_payload jsonb;
  execution_id uuid := 'b1000000-0000-4000-8000-000000000012';
BEGIN
  SELECT action.analysis_run_id, action.id, review.id, action.payload
  INTO active_run_id, action_id, search_review_id, action_payload
  FROM onboarding_cases onboarding_case
  JOIN proposed_actions action
    ON action.analysis_run_id = onboarding_case.active_analysis_run_id
   AND action.action_type = 'run_web_search'
   AND action.status = 'pending'
  JOIN review_requests review ON review.proposed_action_id = action.id
  WHERE onboarding_case.id = '30000000-0000-0000-0000-000000000005'
  ORDER BY review.created_at DESC
  LIMIT 1;

  IF action_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM web_search_executions WHERE proposed_action_id = action_id)
  THEN
    PERFORM decide_web_search_action_authorized(
      search_review_id, action_id, active_run_id,
      '30000000-0000-0000-0000-000000000005',
      'approved', 'analyst_seed',
      'The exact official-regulator query is narrow and appropriate for this synthetic review case.',
      '2026-09-19T19:10:00.000Z',
      'dashboard-result-review:' || action_id::text,
      execution_id, '2026-09-19T19:20:00.000Z', ARRAY['compliance_analyst']
    );
    PERFORM claim_web_search_execution(
      execution_id, action_id, active_run_id,
      '30000000-0000-0000-0000-000000000005',
      action_payload ->> 'query',
      ARRAY(SELECT jsonb_array_elements_text(action_payload -> 'allowed_domains')),
      (action_payload ->> 'max_results')::integer,
      action_payload ->> 'intended_use',
      ARRAY(SELECT jsonb_array_elements_text(action_payload -> 'external_disclosure')),
      '2026-09-19T19:11:00.000Z'
    );
    PERFORM complete_web_search_execution(
      execution_id, action_id, active_run_id,
      '30000000-0000-0000-0000-000000000005',
      'synthetic-firecrawl-dashboard-review',
      jsonb_build_array(
        jsonb_build_object(
          'id', 'b1000000-0000-4000-8000-000000000020',
          'searchExecutionId', execution_id::text,
          'url', 'https://dfpi.ca.gov/regulated-industries/licensees/northstar-remittance',
          'canonicalUrl', 'https://dfpi.ca.gov/regulated-industries/licensees/northstar-remittance',
          'title', 'Harborline Review Sandbox LLC — licensee record',
          'publisher', 'dfpi.ca.gov', 'publishedAt', NULL,
          'retrievedAt', '2026-09-19T19:12:00.000Z',
          'excerpt', 'Synthetic test result: Harborline Review Sandbox LLC appears in the licensee directory with license number 246810.',
          'contentHash', 'sha256:' || repeat('a', 64)
        ),
        jsonb_build_object(
          'id', 'b1000000-0000-4000-8000-000000000021',
          'searchExecutionId', execution_id::text,
          'url', 'https://dfpi.ca.gov/regulated-industries/archive/northstar-remittance',
          'canonicalUrl', 'https://dfpi.ca.gov/regulated-industries/archive/northstar-remittance',
          'title', 'Archived Harborline Review Sandbox listing',
          'publisher', 'dfpi.ca.gov', 'publishedAt', NULL,
          'retrievedAt', '2026-09-19T19:12:00.000Z',
          'excerpt', 'Synthetic test result: an archived directory entry references Harborline Review Sandbox LLC without a current status.',
          'contentHash', 'sha256:' || repeat('b', 64)
        )
      ), '2026-09-19T19:12:01.000Z'
    );
  END IF;
END;
$$;

COMMIT;
