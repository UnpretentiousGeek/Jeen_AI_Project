\set ON_ERROR_STOP on

BEGIN;

-- The 2026-09-24-demo versions quote official sources but carry demo labels and
-- demo wording in their review controls. Pinned versions and approved rules are
-- immutable, so publish a 2026-09-25 version of each policy with the same source
-- passage, move the promoted candidate to the new rule, and exclude the demo
-- version from future runs only. Existing runs keep their pinned demo versions.
-- Rule codes are unique, so each new rule carries its version as a suffix.
CREATE TEMP TABLE demo_policy_sources ON COMMIT DROP AS
SELECT document.id AS policy_document_id, document.code,
  version.id AS demo_version_id, version.source_path,
  chunk.section_locator, chunk.jurisdictions, chunk.products, chunk.business_types,
  replace(replace(chunk.content,
    'Approved demo control:', 'Approved review control:'),
    'Demo decision rule:', 'Decision rule:') AS content,
  rule.id AS demo_rule_id, rule.statement, rule.source_excerpt, rule.rule_kind,
  rule.provider_roles, rule.provider_jurisdictions,
  rule.applicant_payment_activities, rule.operating_jurisdictions,
  rule.funds_handling
FROM policy_versions version
JOIN policy_documents document ON document.id = version.policy_document_id
JOIN policy_chunks chunk ON chunk.policy_version_id = version.id AND chunk.chunk_index = 0
JOIN policy_rule_scopes rule ON rule.policy_chunk_id = chunk.id
  AND rule.code = document.code AND rule.review_state = 'approved'
WHERE version.version = '2026-09-24-demo';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM policy_versions version
    WHERE version.version = '2026-09-24-demo'
      AND NOT EXISTS (
        SELECT 1 FROM demo_policy_sources source
        WHERE source.demo_version_id = version.id
      )
  ) OR EXISTS (
    SELECT 1 FROM policy_chunks chunk
    JOIN demo_policy_sources source ON source.demo_version_id = chunk.policy_version_id
    WHERE chunk.chunk_index <> 0
  ) THEN
    RAISE EXCEPTION 'demo policy version does not have exactly one approved source passage';
  END IF;
  IF EXISTS (SELECT 1 FROM demo_policy_sources WHERE content ~* 'demo') THEN
    RAISE EXCEPTION 'demo wording remains in a published policy passage';
  END IF;
END $$;

INSERT INTO policy_versions (
  policy_document_id, version, approved_at, effective_from, source_path, checksum_sha256
)
SELECT source.policy_document_id, '2026-09-25', DATE '2026-09-25', DATE '2026-09-25',
  source.source_path, encode(digest(source.content, 'sha256'), 'hex')
FROM demo_policy_sources source
ON CONFLICT (policy_document_id, version) DO NOTHING;

INSERT INTO policy_chunks (
  policy_version_id, chunk_index, content, section_locator,
  jurisdictions, products, business_types
)
SELECT version.id, 0, source.content, source.section_locator,
  source.jurisdictions, source.products, source.business_types
FROM demo_policy_sources source
JOIN policy_versions version ON version.policy_document_id = source.policy_document_id
  AND version.version = '2026-09-25'
ON CONFLICT (policy_version_id, chunk_index) DO NOTHING;

INSERT INTO policy_rule_scopes (
  policy_chunk_id, code, statement, source_excerpt, rule_kind,
  provider_roles, provider_jurisdictions, applicant_payment_activities,
  operating_jurisdictions, funds_handling, review_state, approved_by, approved_at
)
SELECT chunk.id, source.code || '/2026-09-25', source.statement,
  source.source_excerpt, source.rule_kind, source.provider_roles,
  source.provider_jurisdictions, source.applicant_payment_activities,
  source.operating_jurisdictions, source.funds_handling, 'approved',
  'User request to publish the reviewed policies without demo labels (2026-09-25)', now()
FROM demo_policy_sources source
JOIN policy_versions version ON version.policy_document_id = source.policy_document_id
  AND version.version = '2026-09-25'
JOIN policy_chunks chunk ON chunk.policy_version_id = version.id AND chunk.chunk_index = 0
ON CONFLICT (code) DO NOTHING;

UPDATE policy_research_candidates candidate
SET promoted_policy_rule_scope_id = rule.id,
    reviewed_by = rule.approved_by,
    reviewed_at = rule.approved_at
FROM demo_policy_sources source
JOIN policy_rule_scopes rule ON rule.code = source.code || '/2026-09-25'
WHERE candidate.promoted_policy_rule_scope_id = source.demo_rule_id;

INSERT INTO policy_new_run_exclusions (policy_version_id, reason, excluded_by)
SELECT source.demo_version_id,
  'Replaced by the 2026-09-25 version without demo labels; existing runs keep this pinned version',
  'User request to publish the reviewed policies without demo labels (2026-09-25)'
FROM demo_policy_sources source
ON CONFLICT (policy_version_id) DO NOTHING;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM demo_policy_sources source
    LEFT JOIN policy_research_candidates candidate
      ON candidate.code = source.code AND candidate.review_state = 'promoted'
    LEFT JOIN policy_rule_scopes rule ON rule.id = candidate.promoted_policy_rule_scope_id
    LEFT JOIN policy_chunks chunk ON chunk.id = rule.policy_chunk_id
    LEFT JOIN policy_versions version ON version.id = chunk.policy_version_id
    WHERE rule.code IS DISTINCT FROM source.code || '/2026-09-25'
      OR rule.review_state IS DISTINCT FROM 'approved'
      OR version.version IS DISTINCT FROM '2026-09-25'
      OR chunk.content IS DISTINCT FROM source.content
      OR version.checksum_sha256 IS DISTINCT FROM encode(digest(chunk.content, 'sha256'), 'hex')
      OR EXISTS (
        SELECT 1 FROM policy_new_run_exclusions exclusion
        WHERE exclusion.policy_version_id = version.id
      )
      OR NOT EXISTS (
        SELECT 1 FROM policy_new_run_exclusions exclusion
        WHERE exclusion.policy_version_id = source.demo_version_id
      )
  ) THEN
    RAISE EXCEPTION 'reviewed policy publication is incomplete';
  END IF;
END $$;

COMMIT;
