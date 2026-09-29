\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
  policy_document_id uuid;
  policy_version_id uuid;
  ca_chunk_id uuid;
  ny_chunk_id uuid;
  global_chunk_id uuid;
  ca_run_id uuid;
  ny_run_id uuid;
  applicant_id uuid;
  application_id uuid;
  case_id uuid;
  jurisdiction_code text;
  search_mode text;
  run_id uuid;
  expected_chunk_id uuid;
  found_count integer;
  found_local boolean;
  found_global boolean;
BEGIN
  INSERT INTO policy_documents (code, title)
  VALUES ('SCOPE-' || gen_random_uuid()::text, 'Mixed jurisdiction search test')
  RETURNING id INTO policy_document_id;

  INSERT INTO policy_versions (
    policy_document_id, version, approved_at, effective_from,
    source_path, checksum_sha256
  ) VALUES (
    policy_document_id, '1.0', CURRENT_DATE, CURRENT_DATE,
    '/tmp/mixed-jurisdiction-policy.txt', repeat('a', 64)
  ) RETURNING id INTO policy_version_id;

  INSERT INTO policy_chunks (
    policy_version_id, chunk_index, content, section_locator,
    jurisdictions, products, business_types, embedding
  ) VALUES (
    policy_version_id, 0, 'scopeeligible California requirement', 'CA',
    ARRAY['US-CA'], ARRAY['domestic_payments'], ARRAY['software'], '[1,0,0]'::vector
  ) RETURNING id INTO ca_chunk_id;
  INSERT INTO policy_chunks (
    policy_version_id, chunk_index, content, section_locator,
    jurisdictions, products, business_types, embedding
  ) VALUES (
    policy_version_id, 1, 'scopeeligible New York requirement', 'NY',
    ARRAY['US-NY'], ARRAY['domestic_payments'], ARRAY['software'], '[1,0,0]'::vector
  ) RETURNING id INTO ny_chunk_id;
  INSERT INTO policy_chunks (
    policy_version_id, chunk_index, content, section_locator,
    jurisdictions, products, business_types, embedding
  ) VALUES (
    policy_version_id, 2, 'scopeeligible universal requirement', 'GLOBAL',
    ARRAY['*'], ARRAY['*'], ARRAY['*'], '[1,0,0]'::vector
  ) RETURNING id INTO global_chunk_id;
  INSERT INTO policy_chunks (
    policy_version_id, chunk_index, content, section_locator,
    jurisdictions, products, business_types, embedding
  ) VALUES
    (policy_version_id, 3, 'scopeeligible US country tag', 'US',
      ARRAY['US'], ARRAY['*'], ARRAY['*'], '[1,0,0]'::vector),
    (policy_version_id, 4, 'scopeeligible other product', 'PRODUCT',
      ARRAY['US-CA', 'US-NY'], ARRAY['cross_border_payments'], ARRAY['software'], '[1,0,0]'::vector),
    (policy_version_id, 5, 'scopeeligible other business type', 'BUSINESS',
      ARRAY['US-CA', 'US-NY'], ARRAY['domestic_payments'], ARRAY['marketplace'], '[1,0,0]'::vector);

  FOREACH jurisdiction_code IN ARRAY ARRAY['US-CA', 'US-NY'] LOOP
    INSERT INTO applicants (legal_name, jurisdiction, business_type, product)
    VALUES ('Policy scope test ' || jurisdiction_code, jurisdiction_code, 'software', 'domestic_payments')
    RETURNING id INTO applicant_id;
    INSERT INTO applications (applicant_id) VALUES (applicant_id)
    RETURNING id INTO application_id;
    INSERT INTO onboarding_cases (application_id, applicant_id, reference)
    VALUES (application_id, applicant_id, 'SCOPE-' || gen_random_uuid()::text)
    RETURNING id INTO case_id;
    INSERT INTO analysis_runs (
      case_id, session_id, policy_effective_on, case_snapshot
    ) VALUES (
      case_id, 'policy-scope-' || gen_random_uuid()::text, CURRENT_DATE,
      jsonb_build_object('applicant', jsonb_build_object(
        'jurisdiction', jurisdiction_code,
        'product', 'domestic_payments',
        'business_type', 'software'
      ))
    ) RETURNING id INTO run_id;
    INSERT INTO analysis_run_policy_versions (analysis_run_id, policy_version_id)
    VALUES (run_id, policy_version_id);
    IF jurisdiction_code = 'US-CA' THEN
      ca_run_id := run_id;
    ELSE
      ny_run_id := run_id;
    END IF;
  END LOOP;

  FOREACH search_mode IN ARRAY ARRAY['lexical', 'semantic'] LOOP
    FOR run_id, expected_chunk_id IN
      SELECT ca_run_id, ca_chunk_id UNION ALL SELECT ny_run_id, ny_chunk_id
    LOOP
      SELECT count(*), bool_or(chunk_id = expected_chunk_id), bool_or(chunk_id = global_chunk_id)
      INTO found_count, found_local, found_global
      FROM retrieve_policy_evidence(
        run_id,
        CASE WHEN search_mode = 'semantic' THEN 'nomatchterm' ELSE 'scopeeligible' END,
        CASE WHEN search_mode = 'semantic' THEN '[1,0,0]'::vector ELSE NULL::vector END,
        20
      );
      IF found_count <> 2 OR NOT coalesce(found_local, false) OR NOT coalesce(found_global, false) THEN
        RAISE EXCEPTION '% search returned inapplicable policy passages for run %', search_mode, run_id;
      END IF;
    END LOOP;
  END LOOP;
END;
$$;

ROLLBACK;
