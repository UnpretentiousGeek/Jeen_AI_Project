BEGIN;

-- The user approved GB-01 for the fictional UK payment institution demo.
-- Existing runs keep their pinned fixture versions; only future run selection
-- changes. These exact fixture sources are not institutional policies.
INSERT INTO policy_new_run_exclusions (policy_version_id, reason, excluded_by)
SELECT version.id, 'Historical demo or test fixture; excluded from future demo analyses',
  'User-approved GB-01 demo cutover in Codex task 01a0d2a8-bca3-7621-9937-39fdad2494f9'
FROM policy_versions version
JOIN policy_documents document ON document.id = version.policy_document_id
WHERE version.source_path LIKE 'fixtures/policies/%'
   OR document.code = 'TEST-KYB-POLICY'
ON CONFLICT (policy_version_id) DO NOTHING;

INSERT INTO policy_documents (code, title)
VALUES ('GB-01', 'UK Customer Due Diligence for Business Relationships')
ON CONFLICT (code) DO NOTHING;

WITH source AS (
  SELECT $policy$
GB-01 — UK Customer Due Diligence for a Corporate Business Relationship
Official sources, checked against legislation.gov.uk as in force on 24 September 2026:
Regulation 8: https://www.legislation.gov.uk/uksi/2017/692/regulation/8/2026-09-24/data.xml
Regulation 27: https://www.legislation.gov.uk/uksi/2017/692/regulation/27/2026-09-24/data.xml
Regulation 28: https://www.legislation.gov.uk/uksi/2017/692/regulation/28/2026-09-24/data.xml

Regulation 8(1)-(2): Relevant persons acting in the course of business carried on in the United Kingdom include financial institutions, subject to regulation 15 exclusions. Regulation 10 defines financial institution; the provider's status must be established from its actual activity, not its form label alone.

Regulation 27(1)(a): A relevant person must apply customer due diligence measures if the person— (a) establishes a business relationship;

Regulation 28(2): The relevant person must identify the customer unless the identity is already known and verified; verify the customer's identity unless it has already been verified; and assess, and where appropriate obtain information on, the purpose and intended nature of the business relationship.

Regulation 28(3)(a): For a body corporate, obtain and verify its name, company or other registration number, registered office address, and principal place of business if different. Regulation 28(3)(b) also calls for reasonable measures concerning governing law, constitution, directors, and senior persons, subject to paragraph (5).

Regulation 28(3A) and (4): Take reasonable measures to understand the ownership and control structure. Where another person beneficially owns the customer, identify that beneficial owner and take reasonable measures to verify identity and, where applicable, understand the owner entity's ownership and control structure.

Regulation 28(5), (12), and (18): Check the listed-company exception for specified ownership measures. The extent of CDD measures reflects the provider's risk assessment. Except for paragraph (10), identity verification uses documents or information from a reliable source independent of the person being verified; official-body documents can qualify even when supplied by the customer.

Approved review control: Where the UK onboarding provider is a relevant person and establishes a business relationship with a corporate applicant, assess the customer identity, beneficial ownership and control, and relationship purpose under these provisions. Record the evidence and any exception. Missing independent verification or unresolved ownership must be reported as an evidence gap or uncertainty, not an automatic adverse finding. A synthetic document that disclaims official status does not by itself verify the company's legal identity.
$policy$::text AS content
), created_version AS (
  INSERT INTO policy_versions (
    policy_document_id, version, approved_at, effective_from, source_path,
    checksum_sha256
  )
  SELECT document.id, '2026-09-25', DATE '2026-09-25', DATE '2026-09-25',
    'https://www.legislation.gov.uk/uksi/2017/692/regulation/27/2026-09-24/data.xml',
    encode(digest(source.content, 'sha256'), 'hex')
  FROM policy_documents document CROSS JOIN source
  WHERE document.code = 'GB-01'
  ON CONFLICT (policy_document_id, version) DO NOTHING
  RETURNING id
), selected_version AS (
  SELECT id FROM created_version
  UNION ALL
  SELECT version.id
  FROM policy_versions version
  JOIN policy_documents document ON document.id = version.policy_document_id
  WHERE document.code = 'GB-01' AND version.version = '2026-09-25'
    AND NOT EXISTS (SELECT 1 FROM created_version)
)
INSERT INTO policy_chunks (
  policy_version_id, chunk_index, content, section_locator,
  jurisdictions, products, business_types
)
SELECT version.id, 0, source.content, 'MLR 2017 regs. 8, 27(1)(a), 28(2)-(5), 28(12), 28(18)',
  ARRAY['*']::text[], ARRAY['*']::text[], ARRAY['*']::text[]
FROM selected_version version CROSS JOIN source
WHERE NOT EXISTS (
  SELECT 1 FROM policy_chunks existing
  WHERE existing.policy_version_id = version.id AND existing.chunk_index = 0
)
ON CONFLICT (policy_version_id, chunk_index) DO NOTHING;

INSERT INTO policy_rule_scopes (
  policy_chunk_id, code, statement, source_excerpt, rule_kind,
  provider_roles, provider_jurisdictions, review_state, approved_by, approved_at
)
SELECT chunk.id, 'GB-01/2026-09-25',
  'When a UK payment institution acting as a relevant person establishes a corporate customer relationship, identify and verify the customer, assess the relationship purpose, and take reasonable measures to understand ownership and identify and verify beneficial owners, using reliable independent sources where required and considering statutory exceptions.',
  'A relevant person must apply customer due diligence measures if the person— (a) establishes a business relationship;',
  'operator_cdd', ARRAY['payment_institution']::text[], ARRAY['GB']::text[],
  'approved', 'User approval in Codex task 01a0d2a8-bca3-7621-9937-39fdad2494f9', now()
FROM policy_documents document
JOIN policy_versions version ON version.policy_document_id = document.id
JOIN policy_chunks chunk ON chunk.policy_version_id = version.id
WHERE document.code = 'GB-01' AND version.version = '2026-09-25'
  AND chunk.chunk_index = 0
ON CONFLICT (code) DO NOTHING;

UPDATE policy_research_candidates candidate
SET review_state = 'promoted',
    promoted_policy_rule_scope_id = rule.id,
    reviewed_by = rule.approved_by,
    reviewed_at = rule.approved_at,
    review_note = 'User confirmed Example Payments Ltd directly onboards Northbridge Market Ltd as a fictional UK payment institution and approved GB-01 for the demo.'
FROM policy_rule_scopes rule
WHERE candidate.code = 'GB-01' AND rule.code = 'GB-01/2026-09-25'
  AND candidate.review_state = 'pending_review';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM policy_research_candidates candidate
    JOIN policy_rule_scopes rule ON rule.id = candidate.promoted_policy_rule_scope_id
    JOIN policy_chunks chunk ON chunk.id = rule.policy_chunk_id
    JOIN policy_versions version ON version.id = chunk.policy_version_id
    WHERE candidate.code = 'GB-01' AND candidate.review_state = 'promoted'
      AND rule.review_state = 'approved'
      AND NOT EXISTS (
        SELECT 1 FROM policy_new_run_exclusions exclusion
        WHERE exclusion.policy_version_id = version.id
      )
      AND version.checksum_sha256 = encode(digest(chunk.content, 'sha256'), 'hex')
  ) THEN
    RAISE EXCEPTION 'GB-01 approval or source checksum is incomplete';
  END IF;
  IF EXISTS (
    SELECT 1 FROM policy_versions version
    JOIN policy_documents document ON document.id = version.policy_document_id
    WHERE (version.source_path LIKE 'fixtures/policies/%'
      OR document.code = 'TEST-KYB-POLICY')
      AND NOT EXISTS (
        SELECT 1 FROM policy_new_run_exclusions exclusion
        WHERE exclusion.policy_version_id = version.id
      )
  ) THEN
    RAISE EXCEPTION 'demo or test policy is still eligible for a new run';
  END IF;
END $$;

COMMIT;
