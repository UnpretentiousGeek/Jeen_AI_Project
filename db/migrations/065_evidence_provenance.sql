BEGIN;

-- Trust in evidence comes from how it was obtained, never from what its text says.
-- Every uploaded document is the applicant's copy of a claim; an official registry
-- result, analyzed by Public Research, is what verifies it independently.
ALTER TABLE case_documents
  ADD COLUMN provenance text NOT NULL DEFAULT 'applicant_supplied'
    CHECK (provenance IN ('applicant_supplied', 'registry_retrieved'));

-- Official sources that can independently verify a registered identity. A host matches
-- itself and its subdomains; jurisdiction '*' is global, 'US' also covers 'US-DE' and so on.
CREATE TABLE official_registry_sources (
  host text PRIMARY KEY CHECK (host ~ '^[a-z0-9.-]+\.[a-z]{2,}$'),
  jurisdiction text NOT NULL CHECK (jurisdiction ~ '^(\*|[A-Z]{2}(-[A-Z]{2})?)$'),
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 120)
);

INSERT INTO official_registry_sources (host, jurisdiction, label) VALUES
  ('company-information.service.gov.uk', 'GB', 'Companies House'),
  ('gleif.org', '*', 'GLEIF Legal Entity Identifier Register'),
  ('sec.gov', 'US', 'SEC EDGAR'),
  ('icis.corp.delaware.gov', 'US-DE', 'Delaware Division of Corporations'),
  ('bizfile.gov.sg', 'SG', 'ACRA Bizfile'),
  ('abr.business.gov.au', 'AU', 'Australian Business Register');

CREATE OR REPLACE FUNCTION official_registry_hosts(p_jurisdiction text)
RETURNS TABLE (host text, label text)
LANGUAGE sql STABLE AS $$
  SELECT source.host, source.label
  FROM official_registry_sources source
  WHERE source.jurisdiction IN ('*', p_jurisdiction, split_part(COALESCE(p_jurisdiction, ''), '-', 1))
  ORDER BY source.jurisdiction = '*', source.host;
$$;

-- The one definition of "registered identity is independently verified" for a run,
-- shared by the coordinator and the case API. Verified means a registry-retrieved
-- document is pinned, or Public Research found the identity claim supported by an
-- accepted result from an official registry for the applicant's jurisdiction.
CREATE OR REPLACE FUNCTION coordinator_v3_identity_verification(p_analysis_run_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE AS $$
  WITH run AS (
    SELECT id, case_id, case_snapshot #>> '{applicant,jurisdiction}' AS jurisdiction
    FROM analysis_runs WHERE id = p_analysis_run_id
  ),
  registries AS (
    SELECT hosts.host, hosts.label FROM run, official_registry_hosts(run.jurisdiction) hosts
  ),
  supporting AS (
    SELECT DISTINCT evidence.id, evidence.canonical_url, registry.label
    FROM run
    JOIN coordinator_v3_contributions contribution
      ON contribution.analysis_run_id = run.id AND contribution.specialty = 'public_research'
     AND contribution.status IN ('completed', 'partial')
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(contribution.payload->'claim_assessments') = 'array'
        THEN contribution.payload->'claim_assessments' ELSE '[]'::jsonb END) assessment
    CROSS JOIN LATERAL jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(assessment->'supporting_citation_ids') = 'array'
        THEN assessment->'supporting_citation_ids' ELSE '[]'::jsonb END) supporting_id
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(contribution.payload->'citations') = 'array'
        THEN contribution.payload->'citations' ELSE '[]'::jsonb END) citation
    JOIN external_web_evidence evidence
      ON evidence.id::text = citation->>'immutable_result_id' AND evidence.analysis_run_id = run.id
    JOIN registries registry
      ON lower(substring(evidence.canonical_url FROM '^https?://([^/:?#]+)')) = registry.host
      OR lower(substring(evidence.canonical_url FROM '^https?://([^/:?#]+)')) LIKE '%.' || registry.host
    WHERE assessment->>'claim_id' = 'verify:registered_identity'
      AND assessment->>'outcome' = 'supported'
      AND citation->>'id' = supporting_id
      AND coordinator_v3_web_citation_permitted(
        run.id, run.case_id, evidence.id, contribution.task_id, contribution.payload->>'contribution_id')
  ),
  retrieved AS (
    SELECT document.id, document.original_filename
    FROM run
    JOIN analysis_run_documents snapshot ON snapshot.analysis_run_id = run.id
    JOIN case_documents document ON document.id = snapshot.document_id
    WHERE document.provenance = 'registry_retrieved'
  )
  SELECT jsonb_build_object(
    'requirement', 'registered_identity',
    'status', CASE WHEN EXISTS (SELECT 1 FROM supporting) OR EXISTS (SELECT 1 FROM retrieved)
      THEN 'verified' ELSE 'unverified' END,
    'registries', COALESCE((SELECT jsonb_agg(jsonb_build_object('host', host, 'label', label)) FROM registries), '[]'::jsonb),
    'verified_by', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'external_web_evidence_id', id::text, 'url', canonical_url, 'label', label)) FROM supporting), '[]'::jsonb)
      || COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'document_id', id::text, 'label', original_filename)) FROM retrieved), '[]'::jsonb)
  )
  FROM run;
$$;

-- The coordinator's own research plan for an unmet verification requirement. It uses the
-- same state slot as an analyst's requested research, so approval, search, result review,
-- Public Research analysis, and re-synthesis all run through the existing path. It may be
-- stored once per run, only after findings exist, and only for official registry domains.
CREATE OR REPLACE FUNCTION store_coordinator_v3_verification_research_plan(
  p_run_id uuid,
  p_plan jsonb,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  coordinator coordinator_v3_runs%ROWTYPE;
  item jsonb;
  domain text;
  request_id text;
  stored jsonb;
BEGIN
  IF NULLIF(trim(p_idempotency_key), '') IS NULL
     OR jsonb_typeof(p_plan) IS DISTINCT FROM 'object'
     OR EXISTS (
       SELECT 1 FROM jsonb_object_keys(p_plan) field
       WHERE field <> ALL (ARRAY['requested_changes','response_summary','research'])
     )
     OR jsonb_typeof(p_plan->'requested_changes') IS DISTINCT FROM 'object'
     OR NULLIF(trim(p_plan->>'response_summary'), '') IS NULL
     OR jsonb_typeof(p_plan->'research') IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_plan->'research') NOT BETWEEN 1 AND 3 THEN
    RAISE EXCEPTION 'verification research plan is invalid' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO coordinator FROM coordinator_v3_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'simple coordinator run does not exist' USING ERRCODE = '23503';
  END IF;
  IF coordinator.state->>'verification_research_idempotency_key' = p_idempotency_key THEN
    RETURN jsonb_build_object('status', 'duplicate_suppressed', 'plan', coordinator.state->'analyst_research');
  END IF;
  IF coordinator.phase <> 'running'
     OR COALESCE(coordinator.state->'next_action', 'null'::jsonb) <> 'null'::jsonb
     OR jsonb_typeof(coordinator.state->'latest_findings') IS DISTINCT FROM 'array'
     OR COALESCE((coordinator.state->>'verification_research_planned')::boolean, false) THEN
    RAISE EXCEPTION 'verification research is not due for this run' USING ERRCODE = '40001';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(p_plan->'research') LOOP
    IF jsonb_typeof(item->'approved_scope') IS DISTINCT FROM 'object'
       OR NOT COALESCE((item->>'scope_hash') ~ '^[0-9a-f]{64}$', false)
       OR NOT COALESCE((item->>'operation_key') ~ '^coord:[0-9a-fA-F-]{36}:iter:[0-9]+:[a-z_]+:[0-9a-f]{64}$', false)
       OR NOT EXISTS (
         SELECT 1 FROM evidence_gaps gap
         WHERE gap.analysis_run_id = coordinator.analysis_run_id
           AND gap.id::text = item->'approved_scope'->>'evidence_gap_id'
       ) THEN
      RAISE EXCEPTION 'verification research scope is outside this analysis run' USING ERRCODE = '42501';
    END IF;
    FOR domain IN SELECT value FROM jsonb_array_elements_text(item->'approved_scope'->'allowed_domains') LOOP
      IF NOT EXISTS (
        SELECT 1 FROM official_registry_sources source
        WHERE domain = source.host OR domain LIKE '%.' || source.host
      ) THEN
        RAISE EXCEPTION 'verification research may only search official registries' USING ERRCODE = '42501';
      END IF;
    END LOOP;
  END LOOP;
  request_id := 'verification:' || coordinator.analysis_run_id::text;
  stored := p_plan || jsonb_build_object('request_id', request_id, 'planned_at', clock_timestamp());
  UPDATE coordinator_v3_runs
  SET state_version = state_version + 1,
      max_iterations = max_iterations + 8,
      state = state || jsonb_build_object(
        'analyst_iteration_allowance', COALESCE((state->>'analyst_iteration_allowance')::integer, 0) + 8,
        'analyst_research', stored,
        'analyst_research_history', COALESCE(state->'analyst_research_history', '[]'::jsonb)
          || jsonb_build_array(stored),
        'verification_research_planned', true,
        'verification_research_idempotency_key', p_idempotency_key,
        'updated_at', clock_timestamp()
      ),
      updated_at = clock_timestamp()
  WHERE id = p_run_id;
  RETURN jsonb_build_object('status', 'stored', 'plan', stored);
END;
$$;

COMMIT;
