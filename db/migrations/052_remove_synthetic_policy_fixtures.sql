\set ON_ERROR_STOP on

BEGIN;

-- Fixture policy versions are not institutional rules. The affected cases are
-- synthetic test data and may be purged with their pinned analysis history.
CREATE TEMP TABLE fixture_policy_versions ON COMMIT DROP AS
SELECT version.id, version.policy_document_id
FROM policy_versions version
JOIN policy_documents document ON document.id = version.policy_document_id
WHERE version.source_path LIKE 'fixtures/policies/%'
   OR document.code = 'TEST-KYB-POLICY';

CREATE TEMP TABLE fixture_policy_cases ON COMMIT DROP AS
SELECT DISTINCT onboarding_case.id, onboarding_case.application_id,
       onboarding_case.applicant_id
FROM onboarding_cases onboarding_case
JOIN analysis_runs run ON run.case_id = onboarding_case.id
JOIN analysis_run_policy_versions pinned ON pinned.analysis_run_id = run.id
JOIN fixture_policy_versions fixture ON fixture.id = pinned.policy_version_id;

DO $$
DECLARE
  selected_case record;
  run_ids text[];
  coordinator_ids text[];
BEGIN
  IF EXISTS (
    SELECT 1 FROM analysis_runs run
    JOIN fixture_policy_cases affected ON affected.id = run.case_id
    WHERE NOT EXISTS (
      SELECT 1 FROM analysis_run_policy_versions pinned
      JOIN fixture_policy_versions fixture ON fixture.id = pinned.policy_version_id
      WHERE pinned.analysis_run_id = run.id
    )
  ) THEN
    RAISE EXCEPTION 'an affected case has a non-fixture analysis run';
  END IF;

  FOR selected_case IN SELECT * FROM fixture_policy_cases ORDER BY id LOOP
    SELECT COALESCE(array_agg(id::text), ARRAY[]::text[])
    INTO run_ids FROM analysis_runs WHERE case_id = selected_case.id;
    SELECT COALESCE(array_agg(id::text), ARRAY[]::text[])
    INTO coordinator_ids FROM coordinator_v3_runs WHERE case_id = selected_case.id;

    -- Legacy synthetic runs may still carry stale running states despite having
    -- no active invocation. Close them before using the established case purge.
    UPDATE analysis_runs SET status = 'cancelled', finished_at = now()
    WHERE case_id = selected_case.id AND status IN ('queued', 'running');
    UPDATE coordinator_v3_runs
    SET phase = 'stopped', stop_reason = 'synthetic policy fixture removed',
        finalized_at = COALESCE(finalized_at, now())
    WHERE case_id = selected_case.id AND phase = 'running';
    UPDATE onboarding_cases
    SET archived_at = COALESCE(archived_at, now()),
        archived_by = COALESCE(archived_by, 'synthetic-policy-purge')
    WHERE id = selected_case.id;

    PERFORM set_config('jeen.case_purge_id', selected_case.id::text, true);
    PERFORM set_config('jeen.case_purge_analysis_run_ids', to_jsonb(run_ids)::text, true);
    PERFORM set_config('jeen.case_purge_coordinator_run_ids', to_jsonb(coordinator_ids)::text, true);
    DELETE FROM case_final_decisions WHERE case_id = selected_case.id;
    UPDATE onboarding_cases SET active_analysis_run_id = NULL
    WHERE id = selected_case.id;
    DELETE FROM onboarding_cases WHERE id = selected_case.id;
  END LOOP;
END $$;

DELETE FROM applications application
USING fixture_policy_cases affected
WHERE application.id = affected.application_id
  AND NOT EXISTS (
    SELECT 1 FROM onboarding_cases retained
    WHERE retained.application_id = application.id
  );

DELETE FROM applicants applicant
USING fixture_policy_cases affected
WHERE applicant.id = affected.applicant_id
  AND NOT EXISTS (
    SELECT 1 FROM applications application WHERE application.applicant_id = applicant.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM onboarding_cases retained WHERE retained.applicant_id = applicant.id
  );

DELETE FROM policy_new_run_exclusions exclusion
USING fixture_policy_versions fixture
WHERE exclusion.policy_version_id = fixture.id;

DELETE FROM policy_chunks chunk
USING fixture_policy_versions fixture
WHERE chunk.policy_version_id = fixture.id;

DELETE FROM policy_versions version
USING fixture_policy_versions fixture
WHERE version.id = fixture.id;

DELETE FROM policy_documents document
WHERE document.id IN (
  SELECT DISTINCT policy_document_id FROM fixture_policy_versions
)
AND NOT EXISTS (
  SELECT 1 FROM policy_versions retained
  WHERE retained.policy_document_id = document.id
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM policy_versions version
    JOIN policy_documents document ON document.id = version.policy_document_id
    WHERE version.source_path LIKE 'fixtures/policies/%'
       OR document.code = 'TEST-KYB-POLICY'
  ) THEN
    RAISE EXCEPTION 'synthetic policy versions remain';
  END IF;
END $$;

COMMIT;
