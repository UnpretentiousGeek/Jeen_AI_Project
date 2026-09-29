BEGIN;

INSERT INTO applicants (id, legal_name, jurisdiction, business_type, product) VALUES
  ('10000000-0000-0000-0000-000000000011', 'Brightpath Systems LLC', 'US', 'software', 'domestic_payments'),
  ('10000000-0000-0000-0000-000000000012', 'Atlas Market Network Ltd', 'GB', 'marketplace', 'cross_border_payouts'),
  ('10000000-0000-0000-0000-000000000013', 'Orchid Commerce Ltd', 'GB', 'marketplace', 'cross_border_payouts')
ON CONFLICT (id) DO NOTHING;

INSERT INTO applications (id, applicant_id, submitted_payload) VALUES
  (
    '20000000-0000-0000-0000-000000000011',
    '10000000-0000-0000-0000-000000000011',
    '{"fixture":"langflow_straight_through","declared_address":"210 King Street, San Francisco, CA 94107","registered_address":"210 King Street, San Francisco, CA 94107","declared_ownership_total":100,"owners":[{"owner_name":"Rina Shah","percentage":65},{"owner_name":"Owen Brooks","percentage":35}]}'
  ),
  (
    '20000000-0000-0000-0000-000000000012',
    '10000000-0000-0000-0000-000000000012',
    '{"fixture":"langflow_interrupted","declared_address":"20 Finsbury Square, London","registered_address":"41 Threadneedle Street, London","declared_ownership_total":82,"owners":[{"owner_name":"Elena Petrov","percentage":50},{"owner_name":"Theo Martin","percentage":32}]}'
  ),
  (
    '20000000-0000-0000-0000-000000000013',
    '10000000-0000-0000-0000-000000000013',
    '{"fixture":"langflow_interrupted","declared_address":"8 Bishopsgate, London","registered_address":"8 Bishopsgate, London","declared_ownership_total":82,"owners":[{"owner_name":"Amina Yusuf","percentage":55},{"owner_name":"Lucas Meyer","percentage":27}]}'
  )
ON CONFLICT (id) DO NOTHING;

INSERT INTO onboarding_cases (id, application_id, applicant_id, reference) VALUES
  ('30000000-0000-0000-0000-000000000011', '20000000-0000-0000-0000-000000000011', '10000000-0000-0000-0000-000000000011', 'KYB-LF-001'),
  ('30000000-0000-0000-0000-000000000012', '20000000-0000-0000-0000-000000000012', '10000000-0000-0000-0000-000000000012', 'KYB-LF-002'),
  ('30000000-0000-0000-0000-000000000013', '20000000-0000-0000-0000-000000000013', '10000000-0000-0000-0000-000000000013', 'KYB-LF-003')
ON CONFLICT (id) DO NOTHING;

INSERT INTO evidence_submissions (id, case_id, submission_number, submitted_by) VALUES
  ('40000000-0000-0000-0000-000000000011', '30000000-0000-0000-0000-000000000011', 1, 'synthetic_applicant'),
  ('40000000-0000-0000-0000-000000000012', '30000000-0000-0000-0000-000000000012', 1, 'synthetic_applicant'),
  ('40000000-0000-0000-0000-000000000013', '30000000-0000-0000-0000-000000000013', 1, 'synthetic_applicant')
ON CONFLICT (id) DO NOTHING;

INSERT INTO case_documents (
  id, evidence_submission_id, case_id, applicant_id, document_type,
  original_filename, mime_type, checksum_sha256, storage_path,
  ingestion_status, parsed_text
) VALUES
  (
    '50000000-0000-0000-0000-000000000011',
    '40000000-0000-0000-0000-000000000011',
    '30000000-0000-0000-0000-000000000011',
    '10000000-0000-0000-0000-000000000011',
    'application_summary', 'langflow-straight-through.md', 'text/markdown',
    encode(digest('Brightpath Systems LLC synthetic Langflow straight-through evidence.', 'sha256'), 'hex'),
    'fixtures/cases/langflow-straight-through.md', 'ready',
    'Brightpath Systems LLC is registered at 210 King Street, San Francisco, CA 94107. Rina Shah owns 65% and Owen Brooks owns 35%, for a total of 100%.'
  ),
  (
    '50000000-0000-0000-0000-000000000012',
    '40000000-0000-0000-0000-000000000012',
    '30000000-0000-0000-0000-000000000012',
    '10000000-0000-0000-0000-000000000012',
    'application_summary', 'langflow-interrupted.md', 'text/markdown',
    encode(digest('Atlas Market Network Ltd synthetic Langflow interrupted evidence.', 'sha256'), 'hex'),
    'fixtures/cases/langflow-interrupted.md', 'ready',
    'Atlas Market Network Ltd declares 82% ownership. Elena Petrov owns 50% and Theo Martin owns 32%; 18% remains unidentified. The application and incorporation evidence show different registered addresses.'
  ),
  (
    '50000000-0000-0000-0000-000000000013',
    '40000000-0000-0000-0000-000000000013',
    '30000000-0000-0000-0000-000000000013',
    '10000000-0000-0000-0000-000000000013',
    'application_summary', 'langflow-selective-resume.md', 'text/markdown',
    encode(digest('Orchid Commerce Ltd synthetic Langflow selective-resume evidence.', 'sha256'), 'hex'),
    'fixtures/cases/langflow-selective-resume.md', 'ready',
    'Orchid Commerce Ltd is registered at 8 Bishopsgate, London. Amina Yusuf owns 55% and Lucas Meyer owns 27%; 18% remains unidentified.'
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
    '60000000-0000-0000-0000-000000000011',
    '50000000-0000-0000-0000-000000000011',
    '30000000-0000-0000-0000-000000000011',
    '10000000-0000-0000-0000-000000000011',
    '40000000-0000-0000-0000-000000000011', 0,
    'Brightpath Systems LLC is registered at 210 King Street, San Francisco, CA 94107. Rina Shah owns 65% and Owen Brooks owns 35%.',
    'Entity and ownership summary'
  ),
  (
    '60000000-0000-0000-0000-000000000012',
    '50000000-0000-0000-0000-000000000012',
    '30000000-0000-0000-0000-000000000012',
    '10000000-0000-0000-0000-000000000012',
    '40000000-0000-0000-0000-000000000012', 0,
    'Elena Petrov owns 50% and Theo Martin owns 32%. The remaining 18% is not identified.',
    'Ownership'
  ),
  (
    '60000000-0000-0000-0000-000000000013',
    '50000000-0000-0000-0000-000000000012',
    '30000000-0000-0000-0000-000000000012',
    '10000000-0000-0000-0000-000000000012',
    '40000000-0000-0000-0000-000000000012', 1,
    'Application address: 20 Finsbury Square, London. Incorporation-document address: 41 Threadneedle Street, London.',
    'Registered address'
  ),
  (
    '60000000-0000-0000-0000-000000000014',
    '50000000-0000-0000-0000-000000000013',
    '30000000-0000-0000-0000-000000000013',
    '10000000-0000-0000-0000-000000000013',
    '40000000-0000-0000-0000-000000000013', 0,
    'Orchid Commerce Ltd is registered at 8 Bishopsgate, London. Amina Yusuf owns 55% and Lucas Meyer owns 27%. The remaining 18% is not identified.',
    'Entity and ownership summary'
  )
) AS seed(
  id, document_id, case_id, applicant_id, evidence_submission_id,
  chunk_index, content, section_locator
)
WHERE NOT EXISTS (
  SELECT 1 FROM document_chunks existing WHERE existing.id = seed.id::uuid
);

COMMIT;
