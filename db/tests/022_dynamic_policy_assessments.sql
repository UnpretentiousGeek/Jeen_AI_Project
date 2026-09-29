\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
  applicant_id uuid;
  application_id uuid;
  case_id uuid;
  submission_id uuid;
  document_id uuid;
  document_chunk_id uuid;
  policy_document_id uuid;
  policy_version_id uuid;
  policy_chunk_id uuid;
  other_policy_chunk_id uuid;
  run_id uuid;
  proposal_id uuid;
  proposal jsonb;
  contribution_payload jsonb;
  blocked boolean;
BEGIN
  INSERT INTO applicants (legal_name, jurisdiction, business_type, product)
  VALUES ('Dynamic Evidence Test Ltd', 'US-CA', 'software', 'domestic_payments')
  RETURNING id INTO applicant_id;
  INSERT INTO applications (applicant_id) VALUES (applicant_id)
  RETURNING id INTO application_id;
  INSERT INTO onboarding_cases (application_id, applicant_id, reference)
  VALUES (application_id, applicant_id, 'DYNAMIC-' || gen_random_uuid()::text)
  RETURNING id INTO case_id;
  INSERT INTO evidence_submissions (case_id, submission_number, submitted_by)
  VALUES (case_id, 1, 'db-test') RETURNING id INTO submission_id;
  INSERT INTO case_documents (
    evidence_submission_id, case_id, applicant_id, document_type,
    original_filename, mime_type, checksum_sha256, storage_path, ingestion_status
  ) VALUES (
    submission_id, case_id, applicant_id, 'formation_certificate',
    'certificate.txt', 'text/plain', repeat('a', 64), '/tmp/certificate.txt', 'ready'
  ) RETURNING id INTO document_id;
  INSERT INTO document_chunks (
    document_id, case_id, applicant_id, evidence_submission_id,
    chunk_index, content, section_locator
  ) VALUES (
    document_id, case_id, applicant_id, submission_id, 0,
    'Certificate of Incorporation. Legal name: Dynamic Evidence Test Ltd.',
    'Page 1'
  ) RETURNING id INTO document_chunk_id;

  INSERT INTO policy_documents (code, title)
  VALUES ('DYNAMIC-' || gen_random_uuid()::text, 'Dynamic evidence test policy')
  RETURNING id INTO policy_document_id;
  INSERT INTO policy_versions (
    policy_document_id, version, approved_at, effective_from,
    source_path, checksum_sha256
  ) VALUES (
    policy_document_id, '1.0', CURRENT_DATE, CURRENT_DATE,
    '/tmp/policy.txt', repeat('b', 64)
  ) RETURNING id INTO policy_version_id;
  INSERT INTO policy_chunks (
    policy_version_id, chunk_index, content, section_locator, jurisdictions
  ) VALUES (
    policy_version_id, 0,
    'The applicant legal name must be supported by incorporation evidence.',
    'KYB-1.1', ARRAY['US-CA']
  ) RETURNING id INTO policy_chunk_id;
  INSERT INTO policy_chunks (
    policy_version_id, chunk_index, content, section_locator, jurisdictions
  ) VALUES (
    policy_version_id, 1,
    'New York applicants must submit a New York registration certificate.',
    'NY-1.1', ARRAY['US-NY']
  ) RETURNING id INTO other_policy_chunk_id;

  INSERT INTO analysis_runs (case_id, session_id, policy_effective_on, case_snapshot)
  VALUES (
    case_id, 'dynamic-' || gen_random_uuid()::text, CURRENT_DATE,
    jsonb_build_object('applicant', jsonb_build_object(
      'jurisdiction', 'US-CA', 'product', 'domestic_payments', 'business_type', 'software'
    ))
  ) RETURNING id INTO run_id;
  INSERT INTO analysis_run_documents (analysis_run_id, case_id, document_id)
  VALUES (run_id, case_id, document_id);
  INSERT INTO analysis_run_policy_versions (analysis_run_id, policy_version_id)
  VALUES (run_id, policy_version_id);

  proposal := jsonb_build_object(
    'requirement', jsonb_build_object(
      'statement', 'Support legal name with incorporation evidence.',
      'excerpt', 'legal name must be supported by incorporation evidence',
      'required_evidence', jsonb_build_array('incorporation evidence')
    ),
    'facts', jsonb_build_array(jsonb_build_object(
      'chunk_id', document_chunk_id::text,
      'fact', 'The certificate names the applicant.',
      'excerpt', 'Legal name: Dynamic Evidence Test Ltd'
    )),
    'outcome', 'supports',
    'rationale', 'The certificate names the applicant.'
  );
  INSERT INTO policy_assessment_proposals (
    analysis_run_id, case_id, policy_chunk_id, document_id, model, proposal
  ) VALUES (run_id, case_id, policy_chunk_id, document_id, 'test-model', proposal)
  RETURNING id INTO proposal_id;
  UPDATE policy_assessment_proposals
  SET review_state = 'accepted', reviewed_by = 'analyst', review_rationale = 'Source checked.',
      reviewed_at = now()
  WHERE id = proposal_id;
  IF (SELECT review_state FROM policy_assessment_proposals WHERE id = proposal_id) <> 'accepted' THEN
    RAISE EXCEPTION 'review did not persist';
  END IF;
  IF (SELECT count(*) FROM accepted_policy_assessments_for_run(run_id)) <> 1 THEN
    RAISE EXCEPTION 'accepted assessment feed did not return the reviewed proposal';
  END IF;
  IF (SELECT count(*) FROM accepted_policy_assessments_for_run(gen_random_uuid())) <> 0 THEN
    RAISE EXCEPTION 'accepted assessment feed crossed the run boundary';
  END IF;

  contribution_payload := jsonb_build_object(
    'specialty', 'policy', 'status', 'partial',
    'reviewed_assessment_ids', jsonb_build_array(proposal_id::text),
    'policy_conflicts', '[]'::jsonb,
    'requirement_evidence_matrix', jsonb_build_array(jsonb_build_object(
      'assessment_proposal_id', proposal_id::text,
      'assessment_reviewed_by', 'analyst',
      'status', 'supported',
      'description', proposal #>> '{requirement,statement}',
      'required_evidence', proposal #> '{requirement,required_evidence}',
      'policy_citation_ids', jsonb_build_array('policy-' || proposal_id::text),
      'available_evidence_references', jsonb_build_array(jsonb_build_object(
        'evidence_type', 'formation_certificate',
        'reference', document_id::text,
        'status', 'present',
        'value', proposal #>> '{facts,0,fact}',
        'citation_id', 'case-' || proposal_id::text || '-1'
      ))
    )),
    'citations', jsonb_build_array(
      jsonb_build_object(
        'id', 'policy-' || proposal_id::text,
        'source_kind', 'policy', 'source_id', policy_version_id::text,
        'chunk_id', policy_chunk_id::text, 'locator', 'KYB-1.1',
        'excerpt', proposal #>> '{requirement,excerpt}'
      ),
      jsonb_build_object(
        'id', 'case-' || proposal_id::text || '-1',
        'source_kind', 'case_document', 'source_id', document_id::text,
        'chunk_id', document_chunk_id::text, 'locator', 'Page 1',
        'excerpt', proposal #>> '{facts,0,excerpt}'
      )
    )
  );
  INSERT INTO coordinator_v3_contributions (
    analysis_run_id, case_id, langflow_job_id, specialty, task_id, context_id,
    agent_name, agent_version, status, source_scope, citations, payload,
    payload_hash, started_at, completed_at, attempt
  ) VALUES (
    run_id, case_id, 'dynamic-reviewed-' || gen_random_uuid()::text,
    'policy', 'dynamic-reviewed-' || gen_random_uuid()::text, 'test-context',
    'kyb-policy-agent', '3.3.0-reviewed-pilot', 'partial', '{}'::jsonb,
    contribution_payload->'citations', contribution_payload, repeat('a', 64),
    now(), now(), 1
  );
  blocked := false;
  BEGIN
    INSERT INTO coordinator_v3_contributions (
      analysis_run_id, case_id, langflow_job_id, specialty, task_id, context_id,
      agent_name, agent_version, status, source_scope, citations, payload,
      payload_hash, started_at, completed_at, attempt
    ) VALUES (
      run_id, case_id, 'dynamic-tamper-' || gen_random_uuid()::text,
      'policy', 'dynamic-tamper-' || gen_random_uuid()::text, 'test-context',
      'kyb-policy-agent', '3.3.0-reviewed-pilot', 'partial', '{}'::jsonb,
      contribution_payload->'citations',
      jsonb_set(contribution_payload, '{requirement_evidence_matrix,0,status}', '"conflicting"'),
      repeat('b', 64), now(), now(), 1
    );
  EXCEPTION WHEN OTHERS THEN
    blocked := position('differs from accepted proposal' IN SQLERRM) > 0;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'altered reviewed outcome was accepted'; END IF;

  INSERT INTO policy_assessment_proposals (
    analysis_run_id, case_id, policy_chunk_id, document_id, model, proposal
  ) VALUES (run_id, case_id, policy_chunk_id, document_id, 'test-model', proposal);
  IF (SELECT count(*) FROM accepted_policy_assessments_for_run(run_id)) <> 1 THEN
    RAISE EXCEPTION 'pending proposal leaked into accepted assessment feed';
  END IF;

  blocked := false;
  BEGIN
    INSERT INTO policy_assessment_proposals (
      analysis_run_id, case_id, policy_chunk_id, document_id, model, proposal
    ) VALUES (run_id, case_id, other_policy_chunk_id, document_id, 'test-model', proposal);
  EXCEPTION WHEN raise_exception THEN
    blocked := position('not active, applicable and pinned' IN SQLERRM) > 0;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'cross-jurisdiction policy passage was accepted'; END IF;

  blocked := false;
  BEGIN
    INSERT INTO policy_assessment_proposals (
      analysis_run_id, case_id, policy_chunk_id, document_id, model, proposal
    ) VALUES (
      run_id, case_id, policy_chunk_id, document_id, 'test-model',
      jsonb_set(proposal, '{facts,0,excerpt}', '"Fabricated document text"')
    );
  EXCEPTION WHEN raise_exception THEN
    blocked := position('fact excerpt is not present' IN SQLERRM) > 0;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'fabricated document quotation was accepted'; END IF;

  blocked := false;
  BEGIN
    UPDATE policy_assessment_proposals SET proposal = '{}'::jsonb WHERE id = proposal_id;
  EXCEPTION WHEN raise_exception THEN
    blocked := position('proposal is immutable' IN SQLERRM) > 0;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'reviewed proposal could be rewritten'; END IF;
END;
$$;

ROLLBACK;
