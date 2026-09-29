BEGIN;

INSERT INTO applicants (id, legal_name, jurisdiction, business_type, product) VALUES
  ('10000000-0000-0000-0000-000000000001', 'Acme Analytics LLC', 'US', 'software', 'domestic_payments'),
  ('10000000-0000-0000-0000-000000000002', 'Mercado Bridge Ltd', 'GB', 'marketplace', 'cross_border_payouts'),
  ('10000000-0000-0000-0000-000000000003', 'Northstar Remittance LLC', 'US', 'money_services', 'cross_border_payments'),
  ('10000000-0000-0000-0000-000000000004', 'Cascade Goods Inc', 'US', 'software', 'domestic_payments')
ON CONFLICT (id) DO NOTHING;

INSERT INTO applications (id, applicant_id, submitted_payload) VALUES
  (
    '20000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    '{"declared_ownership_total": 100}'
  ),
  (
    '20000000-0000-0000-0000-000000000002',
    '10000000-0000-0000-0000-000000000002',
    '{"declared_ownership_total": 82, "address_conflict": true}'
  ),
  (
    '20000000-0000-0000-0000-000000000003',
    '10000000-0000-0000-0000-000000000003',
    '{"declared_ownership_total": 100, "claimed_license": "California money transmitter license"}'
  ),
  (
    '20000000-0000-0000-0000-000000000004',
    '10000000-0000-0000-0000-000000000004',
    '{"declared_ownership_total": 100, "test_condition": "required policy specialist failure"}'
  )
ON CONFLICT (id) DO NOTHING;

INSERT INTO onboarding_cases (id, application_id, applicant_id, reference) VALUES
  ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'KYB-DEMO-001'),
  ('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', 'KYB-DEMO-002'),
  ('30000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000003', 'KYB-DEMO-003'),
  ('30000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000004', 'KYB-DEMO-004')
ON CONFLICT (id) DO NOTHING;

INSERT INTO evidence_submissions (id, case_id, submission_number, submitted_by) VALUES
  ('40000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 1, 'demo_applicant'),
  ('40000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000002', 1, 'demo_applicant'),
  ('40000000-0000-0000-0000-000000000003', '30000000-0000-0000-0000-000000000003', 1, 'demo_applicant'),
  ('40000000-0000-0000-0000-000000000004', '30000000-0000-0000-0000-000000000004', 1, 'demo_applicant')
ON CONFLICT (id) DO NOTHING;

INSERT INTO case_documents (
  id, evidence_submission_id, case_id, applicant_id, document_type,
  original_filename, mime_type, checksum_sha256, storage_path,
  ingestion_status, parsed_text
) VALUES
  (
    '50000000-0000-0000-0000-000000000001',
    '40000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    'application_summary', 'straight-through.md', 'text/markdown',
    encode(digest('Acme Analytics LLC owns 60/40 and declares 100% ownership.', 'sha256'), 'hex'),
    'fixtures/cases/straight-through.md', 'ready',
    'Acme Analytics LLC is a US software company. Its registered address is 100 Market Street, San Francisco, CA 94105. Maya Chen owns 60% and Daniel Ortiz owns 40%, for a declared total of 100%.'
  ),
  (
    '50000000-0000-0000-0000-000000000002',
    '40000000-0000-0000-0000-000000000002',
    '30000000-0000-0000-0000-000000000002',
    '10000000-0000-0000-0000-000000000002',
    'application_summary', 'interrupted.md', 'text/markdown',
    encode(digest('Mercado Bridge Ltd declares 82% ownership and conflicting addresses.', 'sha256'), 'hex'),
    'fixtures/cases/interrupted.md', 'ready',
    'Mercado Bridge Ltd is a UK cross-border marketplace. Amira Rahman owns 52% and Luca Bianchi owns 30%; 18% is unidentified. The application and incorporation document contain different registered addresses.'
  ),
  (
    '50000000-0000-0000-0000-000000000003',
    '40000000-0000-0000-0000-000000000003',
    '30000000-0000-0000-0000-000000000003',
    '10000000-0000-0000-0000-000000000003',
    'application_summary', 'unsupported-license.md', 'text/markdown',
    encode(digest('Northstar Remittance claims an unsupported California license.', 'sha256'), 'hex'),
    'fixtures/cases/unsupported-license.md', 'ready',
    'Northstar Remittance LLC claims a California money transmitter license, but supplied no license document, license number, or registry extract.'
  ),
  (
    '50000000-0000-0000-0000-000000000004',
    '40000000-0000-0000-0000-000000000004',
    '30000000-0000-0000-0000-000000000004',
    '10000000-0000-0000-0000-000000000004',
    'application_summary', 'agent-failure.md', 'text/markdown',
    encode(digest('Cascade Goods supplies consistent entity and ownership evidence for the agent failure scenario.', 'sha256'), 'hex'),
    'fixtures/cases/agent-failure.md', 'ready',
    'Cascade Goods Inc is a US software company registered at 425 Pine Street, Seattle, WA 98101. Jordan Lee owns 55% and Morgan Reed owns 45%, for a declared total of 100%.'
  )
ON CONFLICT (id) DO NOTHING;

INSERT INTO document_chunks (
  id, document_id, case_id, applicant_id, evidence_submission_id,
  chunk_index, content, section_locator
) SELECT
  seed.id::uuid, seed.document_id::uuid, seed.case_id::uuid,
  seed.applicant_id::uuid, seed.evidence_submission_id::uuid,
  seed.chunk_index, seed.content, seed.section_locator
FROM (VALUES
  (
    '60000000-0000-0000-0000-000000000001',
    '50000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    '40000000-0000-0000-0000-000000000001', 0,
    'Maya Chen owns 60% and Daniel Ortiz owns 40%. Total ownership declared: 100%.',
    'Ownership'
  ),
  (
    '60000000-0000-0000-0000-000000000002',
    '50000000-0000-0000-0000-000000000002',
    '30000000-0000-0000-0000-000000000002',
    '10000000-0000-0000-0000-000000000002',
    '40000000-0000-0000-0000-000000000002', 0,
    'Amira Rahman owns 52% and Luca Bianchi owns 30%. The remaining 18% is not identified.',
    'Ownership'
  ),
  (
    '60000000-0000-0000-0000-000000000003',
    '50000000-0000-0000-0000-000000000002',
    '30000000-0000-0000-0000-000000000002',
    '10000000-0000-0000-0000-000000000002',
    '40000000-0000-0000-0000-000000000002', 1,
    'Application address: 8 Bishopsgate. Incorporation-document address: 14 King Street.',
    'Registered address'
  ),
  (
    '60000000-0000-0000-0000-000000000004',
    '50000000-0000-0000-0000-000000000003',
    '30000000-0000-0000-0000-000000000003',
    '10000000-0000-0000-0000-000000000003',
    '40000000-0000-0000-0000-000000000003', 0,
    'The applicant states that it holds a California money transmitter license. No supporting license evidence was supplied.',
    'License claim'
  ),
  (
    '60000000-0000-0000-0000-000000000005',
    '50000000-0000-0000-0000-000000000004',
    '30000000-0000-0000-0000-000000000004',
    '10000000-0000-0000-0000-000000000004',
    '40000000-0000-0000-0000-000000000004', 0,
    'Cascade Goods Inc is registered at 425 Pine Street. Jordan Lee owns 55% and Morgan Reed owns 45%.',
    'Entity and ownership summary'
  )
) AS seed(
  id, document_id, case_id, applicant_id, evidence_submission_id,
  chunk_index, content, section_locator
)
WHERE NOT EXISTS (
  SELECT 1 FROM document_chunks existing WHERE existing.id = seed.id::uuid
);

INSERT INTO policy_documents (id, code, title) VALUES
  ('70000000-0000-0000-0000-000000000001', 'KYB', 'KYB Onboarding Policy'),
  ('70000000-0000-0000-0000-000000000002', 'MRKT', 'Marketplace and Cross-Border Policy'),
  ('70000000-0000-0000-0000-000000000003', 'LIC', 'Licensing Evidence Policy'),
  ('70000000-0000-0000-0000-000000000004', 'DOC', 'Document Acceptance Standard')
ON CONFLICT (id) DO NOTHING;

INSERT INTO policy_versions (
  id, policy_document_id, version, approved_at, effective_from,
  source_path, checksum_sha256
) VALUES
  (
    '80000000-0000-0000-0000-000000000001',
    '70000000-0000-0000-0000-000000000001', '1.0', '2026-01-15', '2026-02-01',
    'fixtures/policies/kyb-baseline-v1.md',
    encode(digest('KYB Onboarding Policy Version 1.0', 'sha256'), 'hex')
  ),
  (
    '80000000-0000-0000-0000-000000000002',
    '70000000-0000-0000-0000-000000000002', '1.0', '2026-01-15', '2026-02-01',
    'fixtures/policies/marketplace-escalation-v1.md',
    encode(digest('Marketplace and Cross-Border Policy Version 1.0', 'sha256'), 'hex')
  ),
  (
    '80000000-0000-0000-0000-000000000003',
    '70000000-0000-0000-0000-000000000003', '1.0', '2026-01-15', '2026-02-01',
    'fixtures/policies/licensing-v1.md',
    encode(digest('Licensing Evidence Policy Version 1.0', 'sha256'), 'hex')
  ),
  (
    '80000000-0000-0000-0000-000000000004',
    '70000000-0000-0000-0000-000000000004', '1.0', '2026-01-15', '2026-02-01',
    'fixtures/policies/document-acceptance-v1.md',
    encode(digest('Document Acceptance Standard Version 1.0', 'sha256'), 'hex')
  )
ON CONFLICT (id) DO NOTHING;

INSERT INTO policy_chunks (
  id, policy_version_id, chunk_index, content, section_locator,
  jurisdictions, products, business_types
) SELECT
  seed.id::uuid, seed.policy_version_id::uuid, seed.chunk_index,
  seed.content, seed.section_locator, seed.jurisdictions,
  seed.products, seed.business_types
FROM (VALUES
  (
    '90000000-0000-0000-0000-000000000001',
    '80000000-0000-0000-0000-000000000001', 0,
    'The legal name, registration number, jurisdiction, and registered address must be supported by current incorporation evidence. Material conflicts must be resolved before the case is marked ready for review.',
    'KYB-1.1', ARRAY['*'], ARRAY['*'], ARRAY['*']
  ),
  (
    '90000000-0000-0000-0000-000000000002',
    '80000000-0000-0000-0000-000000000001', 1,
    'Identify every natural person who owns or controls 25% or more. The ownership chain must account for 100% or explain the remainder with supporting evidence.',
    'KYB-1.2', ARRAY['*'], ARRAY['*'], ARRAY['*']
  ),
  (
    '90000000-0000-0000-0000-000000000003',
    '80000000-0000-0000-0000-000000000002', 0,
    'A marketplace offering cross-border payouts must provide operating countries, seller-screening controls, funds flow, and applicable licenses. Unresolved conflicts require enhanced review.',
    'MRKT-2.1', ARRAY['*'], ARRAY['cross_border_payouts'], ARRAY['marketplace']
  ),
  (
    '90000000-0000-0000-0000-000000000004',
    '80000000-0000-0000-0000-000000000003', 0,
    'Every claimed financial-services license must be supported by a license document or authoritative registry record. An unsupported claim is an evidence gap.',
    'LIC-3.1', ARRAY['*'], ARRAY['cross_border_payments'], ARRAY['money_services']
  ),
  (
    '90000000-0000-0000-0000-000000000005',
    '80000000-0000-0000-0000-000000000004', 0,
    'Evidence used in a finding must retain the source document identifier and a stable page or section locator.',
    'DOC-4.1', ARRAY['*'], ARRAY['*'], ARRAY['*']
  )
) AS seed(
  id, policy_version_id, chunk_index, content, section_locator,
  jurisdictions, products, business_types
)
WHERE NOT EXISTS (
  SELECT 1 FROM policy_chunks existing WHERE existing.id = seed.id::uuid
);

COMMIT;
