\set ON_ERROR_STOP on
BEGIN;

DO $$
<<fixture>>
DECLARE
  applicant_id uuid;
  application_id uuid;
  case_id uuid;
  other_case_id uuid;
  other_application_id uuid;
  submission_id uuid;
  document_id uuid;
  chunk_id uuid;
  blocked boolean;
BEGIN
  INSERT INTO applicants (legal_name, jurisdiction, business_type, product)
  VALUES ('Typed Fixture Ltd', 'US-CA', 'software', 'domestic_payments')
  RETURNING id INTO applicant_id;
  INSERT INTO applications (applicant_id) VALUES (applicant_id)
  RETURNING id INTO application_id;
  INSERT INTO onboarding_cases (application_id, applicant_id, reference)
  VALUES (application_id, applicant_id, 'TYPED-' || gen_random_uuid())
  RETURNING id INTO case_id;
  INSERT INTO applications (applicant_id) VALUES (applicant_id)
  RETURNING id INTO other_application_id;
  INSERT INTO onboarding_cases (application_id, applicant_id, reference)
  VALUES (other_application_id, applicant_id, 'TYPED-OTHER-' || gen_random_uuid())
  RETURNING id INTO other_case_id;
  INSERT INTO evidence_submissions (case_id, submission_number, submitted_by)
  VALUES (case_id, 1, 'db-test') RETURNING id INTO submission_id;
  INSERT INTO case_documents (
    evidence_submission_id, case_id, applicant_id, document_type,
    original_filename, mime_type, checksum_sha256, storage_path, ingestion_status
  ) VALUES (
    submission_id, case_id, applicant_id, 'certificate_of_incorporation',
    'certificate.txt', 'text/plain', repeat('d', 64), '/tmp/certificate.txt', 'ready'
  ) RETURNING id INTO document_id;
  INSERT INTO document_chunks (
    document_id, case_id, applicant_id, evidence_submission_id,
    chunk_index, content, section_locator
  ) VALUES (
    document_id, case_id, applicant_id, submission_id, 0,
    'Registered name: Typed Fixture Ltd. Ada Example owns 60% of Typed Fixture Ltd.',
    'Page 1'
  ) RETURNING id INTO chunk_id;

  INSERT INTO case_entity_attributes (
    case_id, document_id, chunk_id, model, field, value, excerpt, claim_hash
  ) VALUES (
    case_id, document_id, chunk_id, 'test-model', 'legal_name',
    'Typed Fixture Ltd', 'Registered name: Typed Fixture Ltd', ''
  );
  INSERT INTO case_ownership_edges (
    case_id, document_id, chunk_id, model, owner, owner_type,
    owned, percentage, excerpt, claim_hash
  ) VALUES (
    case_id, document_id, chunk_id, 'test-model', 'Ada Example', 'person',
    'Typed Fixture Ltd', 60, 'Ada Example owns 60% of Typed Fixture Ltd', ''
  );
  IF (SELECT count(*) FROM case_entity_attributes fact
      WHERE fact.document_id=fixture.document_id) < 1
     OR (SELECT count(*) FROM case_ownership_edges edge
      WHERE edge.document_id=fixture.document_id) < 1 THEN
    RAISE EXCEPTION 'typed claims were not saved';
  END IF;

  blocked := false;
  BEGIN
    INSERT INTO case_entity_attributes (
      case_id, document_id, chunk_id, model, field, value, excerpt, claim_hash
    ) VALUES (
      other_case_id, document_id, chunk_id, 'test-model', 'legal_name',
      'Typed Fixture Ltd', 'Registered name: Typed Fixture Ltd', ''
    );
  EXCEPTION WHEN OTHERS THEN blocked := true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'cross-case entity claim succeeded'; END IF;

  blocked := false;
  BEGIN
    INSERT INTO case_ownership_edges (
      case_id, document_id, chunk_id, model, owner, owner_type,
      owned, percentage, excerpt, claim_hash
    ) VALUES (
      case_id, document_id, chunk_id, 'test-model', 'Ada Example', 'person',
      'Typed Fixture Ltd', 60, 'Invented ownership quotation', ''
    );
  EXCEPTION WHEN OTHERS THEN blocked := true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'invented ownership quote succeeded'; END IF;

  blocked := false;
  BEGIN
    INSERT INTO case_ownership_edges (
      case_id, document_id, chunk_id, model, owner, owner_type,
      owned, percentage, excerpt, claim_hash
    ) VALUES (
      case_id, document_id, chunk_id, 'test-model', 'Ada Example', 'person',
      'Typed Fixture Ltd', 160, 'Ada Example owns 60% of Typed Fixture Ltd', ''
    );
  EXCEPTION WHEN OTHERS THEN blocked := true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'out-of-range ownership percentage succeeded'; END IF;

  INSERT INTO case_entity_attributes (
    case_id, document_id, chunk_id, model, field, value, excerpt, claim_hash,
    subject, describes_document_subject
  ) VALUES (
    case_id, document_id, chunk_id, 'test-model', 'legal_name',
    'Typed Fixture Ltd', 'Registered name: Typed Fixture Ltd', '',
    'Typed Fixture Ltd', true
  );
  IF (SELECT count(*) FROM case_entity_attributes fact
      WHERE fact.document_id=fixture.document_id AND fact.field='legal_name') <> 2 THEN
    RAISE EXCEPTION 'a subject-attributed claim was merged with the unattributed claim';
  END IF;

  blocked := false;
  BEGIN
    INSERT INTO case_entity_attributes (
      case_id, document_id, chunk_id, model, field, value, excerpt, claim_hash,
      subject, describes_document_subject
    ) VALUES (
      case_id, document_id, chunk_id, 'test-model', 'legal_name',
      'Typed Fixture Ltd', 'Registered name: Typed Fixture Ltd', '', '  ', false
    );
  EXCEPTION WHEN OTHERS THEN blocked := true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'blank entity attribute subject succeeded'; END IF;
END;
$$;

ROLLBACK;
