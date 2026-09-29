\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
  applicant_id uuid;
  application_id uuid;
  case_id uuid;
  run_id uuid;
  citation jsonb := jsonb_build_object(
    'id', 'case-fixture-1', 'source_kind', 'case_document', 'source_id', 'doc-1',
    'chunk_id', 'chunk-1', 'locator', 'Page 1', 'excerpt', 'Holder A: 80%');
  valid_observation jsonb := jsonb_build_object(
    'id', 'obs-1', 'kind', 'unexplained_remainder', 'about', 'run',
    'statement', 'Listed holders account for 80%; the register does not name the remaining 20%.',
    'confidence', 'high', 'citations', jsonb_build_array('case-fixture-1'));
  bad jsonb;
  blocked boolean;
BEGIN
  INSERT INTO applicants (legal_name, jurisdiction, business_type, product)
  VALUES ('Observation Guard Ltd', 'US-CA', 'software', 'domestic_payments')
  RETURNING id INTO applicant_id;
  INSERT INTO applications (applicant_id) VALUES (applicant_id)
  RETURNING id INTO application_id;
  INSERT INTO onboarding_cases (application_id, applicant_id, reference)
  VALUES (application_id, applicant_id, 'OBSERVATION-' || gen_random_uuid()::text)
  RETURNING id INTO case_id;
  INSERT INTO analysis_runs (case_id, session_id, policy_effective_on, case_snapshot)
  VALUES (case_id, 'observation-' || gen_random_uuid(), CURRENT_DATE, '{}'::jsonb)
  RETURNING id INTO run_id;

  CREATE TEMP TABLE observation_cases (label text, specialty text, payload jsonb, should_pass boolean) ON COMMIT DROP;
  INSERT INTO observation_cases VALUES
    ('3.1.0 without observations', 'ownership', jsonb_build_object('specialty', 'ownership'), true),
    ('empty observations', 'entity', jsonb_build_object('observations', '[]'::jsonb), true),
    ('valid ownership observation', 'ownership', jsonb_build_object('observations', jsonb_build_array(valid_observation)), true),
    ('policy is ignored', 'policy', jsonb_build_object('observations', 'not-an-array'::text), true),
    ('not an array', 'ownership', jsonb_build_object('observations', jsonb_build_object()), false),
    ('entity kind on ownership', 'ownership', jsonb_build_object('observations', jsonb_build_array(
      valid_observation || jsonb_build_object('kind', 'near_miss_equivalence'))), false),
    ('unknown key', 'ownership', jsonb_build_object('observations', jsonb_build_array(
      valid_observation || jsonb_build_object('verdict', 'approve'))), false),
    ('bad confidence', 'ownership', jsonb_build_object('observations', jsonb_build_array(
      valid_observation || jsonb_build_object('confidence', 'certain'))), false),
    ('uncited', 'ownership', jsonb_build_object('observations', jsonb_build_array(
      valid_observation || jsonb_build_object('citations', '[]'::jsonb))), false),
    ('foreign citation', 'ownership', jsonb_build_object('observations', jsonb_build_array(
      valid_observation || jsonb_build_object('citations', jsonb_build_array('case-not-pinned')))), false),
    ('statement too long', 'ownership', jsonb_build_object('observations', jsonb_build_array(
      valid_observation || jsonb_build_object('statement', repeat('x', 601)))), false),
    ('three on one row', 'ownership', jsonb_build_object('observations', jsonb_build_array(
      valid_observation, valid_observation, valid_observation)), false),
    ('over cap', 'ownership', jsonb_build_object('observations', (
      SELECT jsonb_agg(valid_observation || jsonb_build_object('about', 'chain:' || n))
      FROM generate_series(1, 9) n)), false);

  FOR bad IN SELECT to_jsonb(item) FROM observation_cases item LOOP
    blocked := false;
    BEGIN
      INSERT INTO coordinator_v3_contributions (
        analysis_run_id, case_id, langflow_job_id, specialty, task_id, context_id,
        agent_name, agent_version, status, source_scope, citations, payload,
        payload_hash, started_at, completed_at, attempt
      ) VALUES (
        run_id, case_id, 'observation-' || gen_random_uuid()::text,
        bad->>'specialty', 'observation-' || gen_random_uuid()::text, 'test-context',
        'kyb-test-agent', '3.2.0', 'partial', '{}'::jsonb,
        jsonb_build_array(citation), bad->'payload', repeat('c', 64), now(), now(), 1
      );
    EXCEPTION WHEN OTHERS THEN
      blocked := true;
    END;
    IF blocked = (bad->>'should_pass')::boolean THEN
      RAISE EXCEPTION 'observation guard case "%" expected pass=%', bad->>'label', bad->>'should_pass';
    END IF;
  END LOOP;
END;
$$;

ROLLBACK;
