\set ON_ERROR_STOP on

BEGIN;

-- These are source-backed demo review controls. A matched licensing control
-- asks for a perimeter assessment; it does not decide that a licence is due.
UPDATE policy_research_candidates
SET source_url = CASE code
  WHEN 'CA-01' THEN 'https://dfpi.ca.gov/rules-enforcement/laws-and-regulations/opinion-letters-by-law-subject/opinion-letters-archives/ca-money-transmission-act-2013-commissioners-opinion-no-002/'
  WHEN 'CA-FED-02' THEN 'https://fintrac-canafe.canada.ca/msb-esm/register-inscrire/reg-ins-eng'
  WHEN 'SG-02' THEN 'https://sso.agc.gov.sg/Act/PSA2019?ProvIds=pr5-&ViewType=Advance&WiAl=1'
  ELSE source_url END
WHERE code IN ('CA-01', 'CA-FED-02', 'SG-02')
  AND source_url IS DISTINCT FROM CASE code
    WHEN 'CA-01' THEN 'https://dfpi.ca.gov/rules-enforcement/laws-and-regulations/opinion-letters-by-law-subject/opinion-letters-archives/ca-money-transmission-act-2013-commissioners-opinion-no-002/'
    WHEN 'CA-FED-02' THEN 'https://fintrac-canafe.canada.ca/msb-esm/register-inscrire/reg-ins-eng'
    WHEN 'SG-02' THEN 'https://sso.agc.gov.sg/Act/PSA2019?ProvIds=pr5-&ViewType=Advance&WiAl=1'
    ELSE source_url END;

CREATE TEMP TABLE reviewed_demo_rules ON COMMIT DROP AS
SELECT candidate.*,
  excerpt.source_excerpt,
  concat_ws(E'\n',
    candidate.code || ' — ' || candidate.title,
    'Official authority: ' || candidate.source_authority,
    'Source: ' || candidate.source_url,
    'Locator: ' || candidate.source_locator,
    'Official source passage: ' || excerpt.source_excerpt,
    CASE WHEN candidate.code = 'US-02' THEN
      'Current FinCEN relief: https://www.fincen.gov/news/news-releases/fincen-issues-exceptive-relief-streamline-customer-due-diligence-requirements'
      ELSE NULL END,
    'Review control: ' || candidate.rule_summary,
    'Trigger to confirm: ' || candidate.legal_trigger,
    'Evidence to review: ' || candidate.evidence_to_review,
    'Exceptions to review: ' || candidate.exceptions_to_review,
    'Decision rule: A matching scope starts a review. Record supported, contradicted, missing, or uncertain evidence with citations. Do not infer a licence breach or sanctions violation from a form choice, missing record, or possible name match alone.'
  ) AS content
FROM policy_research_candidates candidate
JOIN (VALUES
  ('US-01', 'The CIP must include risk-based procedures for verifying the identity of each customer'),
  ('US-02', 'Covered financial institutions are required to establish and maintain written procedures'),
  ('US-03', 'each money services business (MSB) must register with the Department of the Treasury'),
  ('US-04', 'A fundamental element of a sound SCP is the assessment of specific clients, products, services, and geographic locations'),
  ('CA-01', 'A person shall not engage in the business of money transmission in this state'),
  ('DE-01', 'A person may not engage in the business of money transmission'),
  ('NY-01', 'No person shall engage in the business of selling or issuing checks'),
  ('TX-01', 'A money services business that conducts currency exchange or money transmission activities'),
  ('WA-01', 'A person may not engage in the business of money transmission'),
  ('GB-02', 'If you provide payment services as a regular occupation or business activity in the UK, you need to apply to us'),
  ('CA-FED-01', 'Beneficial owners are the individuals who directly or indirectly own or control at least 25%'),
  ('CA-FED-02', 'Money services businesses operating in Canada must register with FINTRAC before they begin to operate'),
  ('CA-FED-03', 'must register with the Bank before it performs any retail payment activities'),
  ('SG-01', 'Payment service providers are required to put in place robust controls to detect and deter the flow of illicit funds'),
  ('SG-02', 'A person must not carry on a business of providing any type of payment service in Singapore'),
  ('AU-01', 'You must complete initial CDD before you start providing a customer with a designated service'),
  ('AU-02', 'You must both enrol and register with us if you’re a remittance or virtual asset service provider'),
  ('IE-01', 'Payment institutions must obtain authorisation from the Central Bank in order to provide payment services'),
  ('DE-BUND-01', 'Wer im Inland gewerbsmäßig oder in einem Umfang, der einen in kaufmännischer Weise eingerichteten Geschäftsbetrieb erfordert, Zahlungsdienste erbringen will')
) AS excerpt(code, source_excerpt) ON excerpt.code = candidate.code
WHERE candidate.review_state IN ('pending_review', 'promoted');

DO $$
BEGIN
  IF (SELECT count(*) FROM reviewed_demo_rules) <> 19 THEN
    RAISE EXCEPTION 'expected 19 source-backed rules besides GB-01';
  END IF;
END $$;

INSERT INTO policy_documents (code, title)
SELECT code, title FROM reviewed_demo_rules
ON CONFLICT (code) DO NOTHING;

INSERT INTO policy_versions (
  policy_document_id, version, approved_at, effective_from, source_path, checksum_sha256
)
SELECT document.id, '2026-09-25', DATE '2026-09-25', DATE '2026-09-25',
  reviewed.source_url, encode(digest(reviewed.content, 'sha256'), 'hex')
FROM reviewed_demo_rules reviewed
JOIN policy_documents document ON document.code = reviewed.code
ON CONFLICT (policy_document_id, version) DO UPDATE
SET source_path = EXCLUDED.source_path,
    checksum_sha256 = EXCLUDED.checksum_sha256
WHERE policy_versions.source_path IS DISTINCT FROM EXCLUDED.source_path
  OR policy_versions.checksum_sha256 IS DISTINCT FROM EXCLUDED.checksum_sha256;

INSERT INTO policy_chunks (
  policy_version_id, chunk_index, content, section_locator,
  jurisdictions, products, business_types
)
SELECT version.id, 0, reviewed.content, reviewed.source_locator,
  ARRAY['*']::text[], reviewed.products, reviewed.business_types
FROM reviewed_demo_rules reviewed
JOIN policy_documents document ON document.code = reviewed.code
JOIN policy_versions version ON version.policy_document_id = document.id
  AND version.version = '2026-09-25'
WHERE NOT EXISTS (
  SELECT 1 FROM policy_chunks existing
  WHERE existing.policy_version_id = version.id AND existing.chunk_index = 0
)
ON CONFLICT (policy_version_id, chunk_index) DO NOTHING;

UPDATE policy_chunks chunk
SET content = reviewed.content, embedding = NULL
FROM reviewed_demo_rules reviewed
JOIN policy_documents document ON document.code = reviewed.code
JOIN policy_versions version ON version.policy_document_id = document.id
  AND version.version = '2026-09-25'
WHERE chunk.policy_version_id = version.id AND chunk.chunk_index = 0
  AND chunk.content IS DISTINCT FROM reviewed.content;

INSERT INTO policy_rule_scopes (
  policy_chunk_id, code, statement, source_excerpt, rule_kind,
  provider_roles, provider_jurisdictions, applicant_payment_activities,
  operating_jurisdictions, review_state, approved_by, approved_at
)
SELECT chunk.id, reviewed.code || '/2026-09-25',
  'Assess whether ' || reviewed.legal_trigger || ' Review ' || reviewed.evidence_to_review ||
  ' Consider ' || reviewed.exceptions_to_review ||
  ' Record uncertainty where the legal perimeter or evidence is unresolved.',
  reviewed.source_excerpt, reviewed.rule_kind,
  reviewed.provider_roles,
  CASE WHEN reviewed.rule_kind = 'operator_cdd' OR reviewed.code = 'US-04'
    THEN ARRAY[reviewed.jurisdiction]::text[] ELSE '{}'::text[] END,
  reviewed.payment_activities,
  CASE WHEN reviewed.code = 'US-04' THEN '{}'::text[]
    ELSE reviewed.operating_jurisdictions END,
  'approved', 'User request for batch demo activation in Codex task 01a0d2a8-bca3-7621-9937-39fdad2494f9', now()
FROM reviewed_demo_rules reviewed
JOIN policy_documents document ON document.code = reviewed.code
JOIN policy_versions version ON version.policy_document_id = document.id
  AND version.version = '2026-09-25'
JOIN policy_chunks chunk ON chunk.policy_version_id = version.id AND chunk.chunk_index = 0
ON CONFLICT (code) DO NOTHING;

UPDATE policy_research_candidates candidate
SET review_state = 'promoted',
    promoted_policy_rule_scope_id = rule.id,
    reviewed_by = rule.approved_by,
    reviewed_at = rule.approved_at,
    review_note = 'Batch demo review control. Source, activity, location, provider role, and exceptions remain explicit assessment conditions.'
FROM policy_rule_scopes rule
JOIN reviewed_demo_rules reviewed ON rule.code = reviewed.code || '/2026-09-25'
WHERE candidate.code = reviewed.code AND candidate.review_state = 'pending_review';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM reviewed_demo_rules reviewed
    LEFT JOIN policy_research_candidates candidate ON candidate.code = reviewed.code
    LEFT JOIN policy_rule_scopes rule ON rule.id = candidate.promoted_policy_rule_scope_id
    LEFT JOIN policy_chunks chunk ON chunk.id = rule.policy_chunk_id
    LEFT JOIN policy_versions version ON version.id = chunk.policy_version_id
    WHERE candidate.review_state IS DISTINCT FROM 'promoted'
      OR rule.review_state IS DISTINCT FROM 'approved'
      OR rule.source_excerpt IS DISTINCT FROM reviewed.source_excerpt
      OR chunk.content IS DISTINCT FROM reviewed.content
      OR version.source_path IS DISTINCT FROM reviewed.source_url
      OR version.checksum_sha256 IS DISTINCT FROM encode(digest(chunk.content, 'sha256'), 'hex')
      OR EXISTS (
        SELECT 1 FROM policy_new_run_exclusions exclusion
        WHERE exclusion.policy_version_id = version.id
      )
  ) THEN
    RAISE EXCEPTION 'reviewed demo policy activation is incomplete';
  END IF;
END $$;

COMMIT;
