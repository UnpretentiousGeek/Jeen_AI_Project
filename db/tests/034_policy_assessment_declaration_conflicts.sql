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
  run_id uuid;
  proposal_id uuid;
  proposal jsonb;
  blocked boolean;
  bad jsonb;
BEGIN
  INSERT INTO applicants (legal_name, jurisdiction, business_type, product)
  VALUES ('Declaration Conflict Test Ltd', 'US-CA', 'software', 'domestic_payments')
  RETURNING id INTO applicant_id;
  INSERT INTO applications (applicant_id) VALUES (applicant_id)
  RETURNING id INTO application_id;
  INSERT INTO onboarding_cases (application_id, applicant_id, reference)
  VALUES (application_id, applicant_id, 'DECLARATION-' || gen_random_uuid()::text)
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
    'Certificate of Incorporation. Legal name: Declaration Conflict Test Ltd. Customer money is held in a client bank account in the Company name.',
    'Page 1'
  ) RETURNING id INTO document_chunk_id;

  INSERT INTO policy_documents (code, title)
  VALUES ('DECLARATION-' || gen_random_uuid()::text, 'Dynamic evidence test policy')
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

  INSERT INTO analysis_runs (case_id, session_id, policy_effective_on, case_snapshot)
  VALUES (
    case_id, 'declaration-' || gen_random_uuid()::text, CURRENT_DATE,
    jsonb_build_object('applicant', jsonb_build_object(
      'jurisdiction', 'US-CA', 'product', 'domestic_payments', 'business_type', 'software'
    ), 'submitted_payload', jsonb_build_object('activity_declaration', jsonb_build_object(
      'payment_activity', 'facilitates', 'handles_customer_funds', 'no',
      'licensing_basis', 'unknown', 'operating_jurisdictions', jsonb_build_array('US-CA')
    )))
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
      'fact', 'The applicant holds customer money.',
      'excerpt', 'Customer money is held in a client bank account'
    )),
    'outcome', 'uncertain',
    'rationale', 'The certificate names the applicant.'
  );

  -- Proposals stored before conflicts were reported, and those without any, are accepted.
  INSERT INTO policy_assessment_proposals (analysis_run_id, case_id, policy_chunk_id, document_id, model, proposal)
  VALUES (run_id, case_id, policy_chunk_id, document_id, 'test-model', proposal);
  INSERT INTO policy_assessment_proposals (analysis_run_id, case_id, policy_chunk_id, document_id, model, proposal)
  VALUES (run_id, case_id, policy_chunk_id, document_id, 'test-model',
    proposal || '{"declaration_conflicts": []}'::jsonb);
  -- A grounded conflict repeats the declared answer and cites a fact the proposal carries.
  INSERT INTO policy_assessment_proposals (analysis_run_id, case_id, policy_chunk_id, document_id, model, proposal)
  VALUES (run_id, case_id, policy_chunk_id, document_id, 'test-model',
    proposal || jsonb_build_object('declaration_conflicts', jsonb_build_array(
      jsonb_build_object('field', 'handles_customer_funds', 'declared_value', 'no',
        'fact_indexes', jsonb_build_array(0), 'explanation', 'It holds customer money.'),
      jsonb_build_object('field', 'operating_jurisdictions', 'declared_value', jsonb_build_array('US-CA'),
        'fact_indexes', jsonb_build_array(0), 'explanation', 'Illustrative.')
    )));

  FOREACH bad IN ARRAY ARRAY[
    '{"field": "handles_customer_funds", "declared_value": "yes", "fact_indexes": [0], "explanation": "Misstated answer."}',
    '{"field": "licensing_basis", "declared_value": "unknown", "fact_indexes": [0], "explanation": "Unanswered question."}',
    '{"field": "handles_customer_funds", "declared_value": "no", "fact_indexes": [1], "explanation": "Uncited fact."}',
    '{"field": "handles_customer_funds", "declared_value": "no", "fact_indexes": [], "explanation": "No facts."}',
    '{"field": "handles_customer_funds", "declared_value": "no", "fact_indexes": [0], "explanation": " "}',
    '{"field": "legal_name", "declared_value": "no", "fact_indexes": [0], "explanation": "Unknown field."}'
  ]::jsonb[] LOOP
    blocked := false;
    BEGIN
      INSERT INTO policy_assessment_proposals (analysis_run_id, case_id, policy_chunk_id, document_id, model, proposal)
      VALUES (run_id, case_id, policy_chunk_id, document_id, 'test-model',
        proposal || jsonb_build_object('declaration_conflicts', jsonb_build_array(bad)));
    EXCEPTION WHEN check_violation THEN
      blocked := true;
    END;
    IF NOT blocked THEN
      RAISE EXCEPTION 'ungrounded declaration conflict was stored: %', bad;
    END IF;
  END LOOP;
  blocked := false;
  BEGIN
    INSERT INTO policy_assessment_proposals (analysis_run_id, case_id, policy_chunk_id, document_id, model, proposal)
    VALUES (run_id, case_id, policy_chunk_id, document_id, 'test-model',
      proposal || jsonb_build_object('declaration_conflicts', jsonb_build_array(
        jsonb_build_object('field', 'handles_customer_funds', 'declared_value', 'no', 'fact_indexes', jsonb_build_array(0), 'explanation', 'One.'),
        jsonb_build_object('field', 'handles_customer_funds', 'declared_value', 'no', 'fact_indexes', jsonb_build_array(0), 'explanation', 'Two.')
      )));
  EXCEPTION WHEN check_violation THEN
    blocked := true;
  END;
  IF NOT blocked THEN
    RAISE EXCEPTION 'a repeated declaration conflict field was stored';
  END IF;
END;
$$;

ROLLBACK;
