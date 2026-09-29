\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
  applicant_id uuid;
  application_id uuid;
  case_id uuid;
  other_case_id uuid;
  other_application_id uuid;
  submission_id uuid;
  document_id uuid;
  chunk_id uuid;
  policy_document_id uuid;
  version_id uuid;
  policy_chunk_id uuid;
  run_id uuid;
  assessment_id uuid;
  facts jsonb;
  result jsonb;
  contribution_payload jsonb;
  blocked boolean;
BEGIN
  INSERT INTO applicants (legal_name, jurisdiction, business_type, product)
  VALUES ('Fact Fixture Ltd', 'US-CA', 'software', 'domestic_payments')
  RETURNING id INTO applicant_id;
  INSERT INTO applications (applicant_id) VALUES (applicant_id)
  RETURNING id INTO application_id;
  INSERT INTO onboarding_cases (application_id, applicant_id, reference)
  VALUES (application_id, applicant_id, 'FACT-' || gen_random_uuid())
  RETURNING id INTO case_id;
  INSERT INTO applications (applicant_id) VALUES (applicant_id)
  RETURNING id INTO other_application_id;
  INSERT INTO onboarding_cases (application_id, applicant_id, reference)
  VALUES (other_application_id, applicant_id, 'FACT-OTHER-' || gen_random_uuid())
  RETURNING id INTO other_case_id;
  INSERT INTO evidence_submissions (case_id, submission_number, submitted_by)
  VALUES (case_id, 1, 'db-test') RETURNING id INTO submission_id;
  INSERT INTO case_documents (
    evidence_submission_id, case_id, applicant_id, document_type,
    original_filename, mime_type, checksum_sha256, storage_path, ingestion_status
  ) VALUES (
    submission_id, case_id, applicant_id, 'bank_statement',
    'statement.txt', 'text/plain', repeat('a', 64), '/tmp/statement.txt', 'ready'
  ) RETURNING id INTO document_id;
  INSERT INTO document_chunks (
    document_id, case_id, applicant_id, evidence_submission_id,
    chunk_index, content, section_locator
  ) VALUES (
    document_id, case_id, applicant_id, submission_id, 0,
    'Account holder: Fact Fixture Ltd. Statement date: 2026-09-01.', 'Page 1'
  ) RETURNING id INTO chunk_id;
  facts := jsonb_build_array(jsonb_build_object(
    'chunk_id', chunk_id::text, 'subject', 'Fact Fixture Ltd',
    'predicate', 'account holder', 'value', 'Fact Fixture Ltd',
    'excerpt', 'Account holder: Fact Fixture Ltd'
  ));
  result := save_case_document_facts(case_id, document_id, 'test-model', facts);
  IF result->>'inserted_count' <> '1' THEN RAISE EXCEPTION 'fact did not save'; END IF;
  result := save_case_document_facts(case_id, document_id, 'test-model', facts);
  IF result->>'duplicate_count' <> '1' THEN RAISE EXCEPTION 'retry duplicated a fact'; END IF;

  blocked := false;
  BEGIN
    PERFORM save_case_document_facts(other_case_id, document_id, 'test-model', facts);
  EXCEPTION WHEN OTHERS THEN blocked := true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'cross-case fact write succeeded'; END IF;

  blocked := false;
  BEGIN
    PERFORM save_case_document_facts(case_id, document_id, 'test-model',
      jsonb_set(facts, '{0,excerpt}', '"Invented quotation"'));
  EXCEPTION WHEN OTHERS THEN blocked := true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'invented quotation was saved'; END IF;

  INSERT INTO policy_documents (code, title)
  VALUES ('FACT-' || gen_random_uuid(), 'Fact test policy')
  RETURNING id INTO policy_document_id;
  INSERT INTO policy_versions (
    policy_document_id, version, approved_at, effective_from, source_path, checksum_sha256
  ) VALUES (policy_document_id, '1', CURRENT_DATE, CURRENT_DATE,
    '/tmp/fact-policy.txt', repeat('b', 64)) RETURNING id INTO version_id;
  INSERT INTO policy_chunks (
    policy_version_id, chunk_index, content, section_locator, jurisdictions
  ) VALUES (version_id, 0,
    'Verify the account holder name against the business legal name.',
    'KYB-1', ARRAY['US-CA']) RETURNING id INTO policy_chunk_id;
  INSERT INTO analysis_runs (case_id, session_id, policy_effective_on, case_snapshot)
  VALUES (case_id, 'fact-' || gen_random_uuid(), CURRENT_DATE,
    jsonb_build_object('applicant', jsonb_build_object(
      'jurisdiction', 'US-CA', 'product', 'domestic_payments', 'business_type', 'software'
    ))) RETURNING id INTO run_id;
  INSERT INTO analysis_run_documents (analysis_run_id, case_id, document_id)
  VALUES (run_id, case_id, document_id);
  INSERT INTO analysis_run_policy_versions (analysis_run_id, policy_version_id)
  VALUES (run_id, version_id);
  INSERT INTO policy_assessment_proposals (
    analysis_run_id, case_id, policy_chunk_id, document_id, model, proposal
  ) VALUES (run_id, case_id, policy_chunk_id, document_id, 'test-model',
    jsonb_build_object(
      'requirement', jsonb_build_object(
        'statement', 'Verify account holder name.',
        'excerpt', 'Verify the account holder name against the business legal name',
        'required_evidence', jsonb_build_array('bank statement')
      ),
      'facts', jsonb_build_array(jsonb_build_object(
        'chunk_id', chunk_id::text, 'fact', 'Fact Fixture Ltd is the account holder.',
        'excerpt', 'Account holder: Fact Fixture Ltd'
      )),
      'outcome', 'supports', 'rationale', 'The cited statement names the account holder.'
    )) RETURNING id INTO assessment_id;
  IF NOT EXISTS (
    SELECT 1 FROM policy_assessment_proposals assessment
    WHERE assessment.analysis_run_id=run_id
  ) THEN RAISE EXCEPTION 'non-certificate assessment was rejected'; END IF;
  UPDATE policy_assessment_proposals
  SET review_state='accepted', reviewed_by='test-analyst',
    review_rationale='Synthetic source checked', reviewed_at=now()
  WHERE analysis_run_id=run_id;
  IF (SELECT count(*) FROM accepted_policy_assessments_for_run(run_id)) <> 1 THEN
    RAISE EXCEPTION 'accepted non-certificate assessment was omitted';
  END IF;
  contribution_payload := jsonb_build_object(
    'specialty', 'policy', 'status', 'partial',
    'reviewed_assessment_ids', jsonb_build_array(assessment_id::text),
    'policy_conflicts', '[]'::jsonb,
    'requirement_evidence_matrix', jsonb_build_array(jsonb_build_object(
      'assessment_proposal_id', assessment_id::text,
      'assessment_reviewed_by', 'test-analyst',
      'status', 'supported',
      'description', 'Verify account holder name.',
      'required_evidence', jsonb_build_array('bank statement'),
      'policy_citation_ids', jsonb_build_array('policy-' || assessment_id::text),
      'available_evidence_references', jsonb_build_array(jsonb_build_object(
        'evidence_type', 'bank_statement',
        'reference', document_id::text, 'status', 'present',
        'value', 'Fact Fixture Ltd is the account holder.',
        'citation_id', 'case-' || assessment_id::text || '-1'
      ))
    )),
    'citations', jsonb_build_array(
      jsonb_build_object(
        'id', 'policy-' || assessment_id::text, 'source_kind', 'policy',
        'source_id', version_id::text, 'chunk_id', policy_chunk_id::text,
        'locator', 'KYB-1',
        'excerpt', 'Verify the account holder name against the business legal name'
      ),
      jsonb_build_object(
        'id', 'case-' || assessment_id::text || '-1',
        'source_kind', 'case_document', 'source_id', document_id::text,
        'chunk_id', chunk_id::text, 'locator', 'Page 1',
        'excerpt', 'Account holder: Fact Fixture Ltd'
      )
    )
  );
  INSERT INTO coordinator_v3_contributions (
    analysis_run_id, case_id, langflow_job_id, specialty, task_id, context_id,
    agent_name, agent_version, status, source_scope, citations, payload,
    payload_hash, started_at, completed_at, attempt
  ) VALUES (
    run_id, case_id, 'fact-reviewed-' || gen_random_uuid()::text,
    'policy', 'fact-reviewed-' || gen_random_uuid()::text, 'test-context',
    'kyb-policy-agent', '3.3.0-reviewed-pilot', 'partial', '{}'::jsonb,
    contribution_payload->'citations', contribution_payload, repeat('c', 64),
    now(), now(), 1
  );

END;
$$;

ROLLBACK;
