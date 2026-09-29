BEGIN;

INSERT INTO applicants (id, legal_name, jurisdiction, business_type, product) VALUES
  ('12000000-0000-0000-0000-000000000051','Coordinator Complete LLC','US-CA','software','domestic_payments'),
  ('12000000-0000-0000-0000-000000000052','Coordinator Interrupted Ltd','GB','marketplace','cross_border_payouts'),
  ('12000000-0000-0000-0000-000000000053','Coordinator Conflict Ltd','GB','marketplace','cross_border_payouts'),
  ('12000000-0000-0000-0000-000000000054','Coordinator Recovery LLC','US-DE','software','domestic_payments'),
  ('12000000-0000-0000-0000-000000000055','Coordinator Research Ltd','GB','money_services','cross_border_payments')
ON CONFLICT (id) DO NOTHING;

INSERT INTO applications (id, applicant_id, submitted_payload) VALUES
  ('22000000-0000-0000-0000-000000000051','12000000-0000-0000-0000-000000000051',
   '{"fixture":"coordinator_complete","entity_declaration":{"legal_name":"Coordinator Complete LLC","jurisdiction":"US-CA","identifiers":[{"type":"registration_number","value":"CA-COORD-51","jurisdiction":"US-CA"}],"addresses":{"registered":"51 Market Street, San Francisco, CA","operating":"51 Market Street, San Francisco, CA","mailing":"51 Market Street, San Francisco, CA"}}}'),
  ('22000000-0000-0000-0000-000000000052','12000000-0000-0000-0000-000000000052',
   '{"fixture":"coordinator_interrupted","entity_declaration":{"legal_name":"Coordinator Interrupted Ltd","jurisdiction":"GB","identifiers":[{"type":"registration_number","value":"GB-COORD-52","jurisdiction":"GB"}],"addresses":{"registered":"52 Threadneedle Street, London","operating":"52 Threadneedle Street, London","mailing":"52 Threadneedle Street, London"}}}'),
  ('22000000-0000-0000-0000-000000000053','12000000-0000-0000-0000-000000000053',
   '{"fixture":"coordinator_conflict","entity_declaration":{"legal_name":"Coordinator Conflict Ltd","jurisdiction":"GB","identifiers":[{"type":"registration_number","value":"GB-COORD-53","jurisdiction":"GB"}],"addresses":{"registered":"53 King Street, London","operating":"53 King Street, London","mailing":"53 King Street, London"}}}'),
  ('22000000-0000-0000-0000-000000000054','12000000-0000-0000-0000-000000000054',
   '{"fixture":"coordinator_required_failure","entity_declaration":{"legal_name":"Coordinator Recovery LLC","jurisdiction":"US-DE","identifiers":[{"type":"registration_number","value":"DE-COORD-54","jurisdiction":"US-DE"}],"addresses":{"registered":"54 Recovery Way, Wilmington, DE","operating":"54 Recovery Way, Wilmington, DE","mailing":"54 Recovery Way, Wilmington, DE"}}}'),
  ('22000000-0000-0000-0000-000000000055','12000000-0000-0000-0000-000000000055',
   '{"fixture":"coordinator_public_research","claimed_exception":"LIC-EX-REFERRAL","entity_declaration":{"legal_name":"Coordinator Research Ltd","jurisdiction":"GB","identifiers":[{"type":"registration_number","value":"GB-COORD-55","jurisdiction":"GB"}],"addresses":{"registered":"55 Research Lane, London","operating":"55 Research Lane, London","mailing":"55 Research Lane, London"}},"public_research":{"applicant_match":{"registration_numbers":["GB-COORD-55"],"official_domains":["docs.tinyfish.ai"],"addresses":["55 Research Lane, London"],"other_evidence":["COORD-55"]},"claims":[{"requirement_code":"LIC-MS-1","claim_id":"tinyfish-documentation","claim":"TinyFish publishes API documentation for bounded search and fetch operations.","query":"site:docs.tinyfish.ai TinyFish search API fetch API","allowed_domains":["docs.tinyfish.ai"],"disclosed_applicant_fields":["legal_name","jurisdiction","product","registration_number","official_domain"],"result_limit":3,"rationale":"Resolve the documented external-source gap using one bounded official-domain query.","requested_evidence":"An accepted immutable result from docs.tinyfish.ai that directly addresses the claim."}]}}')
ON CONFLICT (id) DO NOTHING;

INSERT INTO onboarding_cases (id, application_id, applicant_id, reference)
SELECT ('32000000-0000-0000-0000-0000000000' || n)::uuid,
       ('22000000-0000-0000-0000-0000000000' || n)::uuid,
       ('12000000-0000-0000-0000-0000000000' || n)::uuid,
       'KYB-COORD-V3-' || n
FROM (VALUES ('51'),('52'),('53'),('54'),('55')) ids(n)
ON CONFLICT (id) DO NOTHING;

INSERT INTO evidence_submissions (id, case_id, submission_number, submitted_by)
SELECT ('42000000-0000-0000-0000-0000000000' || n)::uuid,
       ('32000000-0000-0000-0000-0000000000' || n)::uuid, 1, 'coordinator_v3_fixture'
FROM (VALUES ('51'),('52'),('53'),('54'),('55')) ids(n)
ON CONFLICT (id) DO NOTHING;

INSERT INTO case_documents (
  id, evidence_submission_id, case_id, applicant_id, document_type,
  original_filename, mime_type, checksum_sha256, storage_path, ingestion_status, parsed_text
)
SELECT ('52000000-0000-0000-0000-0000000000' || n)::uuid,
       ('42000000-0000-0000-0000-0000000000' || n)::uuid,
       ('32000000-0000-0000-0000-0000000000' || n)::uuid,
       ('12000000-0000-0000-0000-0000000000' || n)::uuid,
       'coordinator_v3_evidence', 'coordinator-v3-' || n || '.txt', 'text/plain',
       encode(digest('coordinator-v3-' || n, 'sha256'), 'hex'),
       'fixtures/coordinator-v3/' || n || '.txt', 'ready', 'Coordinator V3 deterministic acceptance evidence.'
FROM (VALUES ('51'),('52'),('53'),('54'),('55')) ids(n)
ON CONFLICT (id) DO NOTHING;

INSERT INTO document_chunks (
  id, document_id, case_id, applicant_id, evidence_submission_id, chunk_index, content, section_locator
) SELECT id::uuid, document_id::uuid, case_id::uuid, applicant_id::uuid, submission_id::uuid, 0, content, locator
FROM (VALUES
 ('62000000-0000-0000-0000-000000000051','52000000-0000-0000-0000-000000000051','32000000-0000-0000-0000-000000000051','12000000-0000-0000-0000-000000000051','42000000-0000-0000-0000-000000000051',E'ENTITY_FACT|field=legal_name|value=COORDINATOR COMPLETE LLC|observed_at=2026-09-20\nENTITY_FACT|field=jurisdiction|value=US-CA|observed_at=2026-09-20\nENTITY_FACT|field=identifier|identifier_type=registration_number|value=CA-COORD-51|jurisdiction=US-CA|observed_at=2026-09-20\nENTITY_FACT|field=address|address_type=registered|value=51 Market Street San Francisco CA|observed_at=2026-09-20\nENTITY_FACT|field=address|address_type=operating|value=51 Market Street San Francisco CA|observed_at=2026-09-20\nENTITY_FACT|field=address|address_type=mailing|value=51 Market Street San Francisco CA|observed_at=2026-09-20\nOWNERSHIP_EDGE|owner=Aria Chen|owner_type=person|owned=Coordinator Complete LLC|percentage=60\nOWNERSHIP_EDGE|owner=Noah Reed|owner_type=person|owned=Coordinator Complete LLC|percentage=40\nCASE_EVIDENCE|type=incorporation_record|reference=California formation certificate|status=supported|value=current','Complete entity, ownership, and policy evidence'),
 ('62000000-0000-0000-0000-000000000052','52000000-0000-0000-0000-000000000052','32000000-0000-0000-0000-000000000052','12000000-0000-0000-0000-000000000052','42000000-0000-0000-0000-000000000052',E'ENTITY_FACT|field=legal_name|value=COORDINATOR INTERRUPTED LTD\nENTITY_FACT|field=jurisdiction|value=GB\nENTITY_FACT|field=identifier|identifier_type=registration_number|value=GB-COORD-52|jurisdiction=GB\nENTITY_FACT|field=address|address_type=registered|value=52 Threadneedle Street London\nENTITY_FACT|field=address|address_type=operating|value=52 Threadneedle Street London\nENTITY_FACT|field=address|address_type=mailing|value=52 Threadneedle Street London\nOWNERSHIP_EDGE|owner=Iris Bell|owner_type=person|owned=Coordinator Interrupted Ltd|percentage=52\nOWNERSHIP_EDGE|owner=Omar Khan|owner_type=person|owned=Coordinator Interrupted Ltd|percentage=30\nCASE_EVIDENCE|type=incorporation_record|reference=Companies House extract|status=supported|value=current\nCASE_EVIDENCE|type=operating_countries|reference=Country schedule|status=supported|value=GB;FR\nCASE_EVIDENCE|type=seller_screening_controls|reference=Screening procedure|status=supported|value=documented\nCASE_EVIDENCE|type=funds_flow|reference=Funds-flow diagram|status=supported|value=documented\nCASE_EVIDENCE|type=marketplace_license|reference=Marketplace license|status=supported|value=valid','Ownership evidence incomplete by 18 percent'),
 ('62000000-0000-0000-0000-000000000053','52000000-0000-0000-0000-000000000053','32000000-0000-0000-0000-000000000053','12000000-0000-0000-0000-000000000053','42000000-0000-0000-0000-000000000053',E'ENTITY_FACT|field=legal_name|value=COORDINATOR CONFLICT LTD\nENTITY_FACT|field=jurisdiction|value=GB\nENTITY_FACT|field=identifier|identifier_type=registration_number|value=GB-COORD-53|jurisdiction=GB\nENTITY_FACT|field=address|address_type=registered|value=53 King Street London\nENTITY_FACT|field=address|address_type=registered|value=99 Bishopsgate London\nENTITY_FACT|field=address|address_type=operating|value=53 King Street London\nENTITY_FACT|field=address|address_type=mailing|value=53 King Street London\nOWNERSHIP_EDGE|owner=Mae Silva|owner_type=person|owned=Coordinator Conflict Ltd|percentage=70\nOWNERSHIP_EDGE|owner=Eli Price|owner_type=person|owned=Coordinator Conflict Ltd|percentage=30\nCASE_EVIDENCE|type=incorporation_record|reference=Companies House extract|status=supported|value=current\nCASE_EVIDENCE|type=operating_countries|reference=Country schedule|status=supported|value=GB;DE\nCASE_EVIDENCE|type=seller_screening_controls|reference=Screening procedure|status=supported|value=documented\nCASE_EVIDENCE|type=funds_flow|reference=Funds-flow diagram|status=supported|value=documented\nCASE_EVIDENCE|type=marketplace_license|reference=Marketplace license|status=supported|value=valid','Unresolved registered-address conflict'),
 ('62000000-0000-0000-0000-000000000054','52000000-0000-0000-0000-000000000054','32000000-0000-0000-0000-000000000054','12000000-0000-0000-0000-000000000054','42000000-0000-0000-0000-000000000054',E'ENTITY_FACT|field=legal_name|value=COORDINATOR RECOVERY LLC\nENTITY_FACT|field=jurisdiction|value=US-DE\nENTITY_FACT|field=identifier|identifier_type=registration_number|value=DE-COORD-54|jurisdiction=US-DE\nENTITY_FACT|field=address|address_type=registered|value=54 Recovery Way Wilmington DE\nENTITY_FACT|field=address|address_type=operating|value=54 Recovery Way Wilmington DE\nENTITY_FACT|field=address|address_type=mailing|value=54 Recovery Way Wilmington DE\nOWNERSHIP_EDGE|owner=Zoe Hart|owner_type=person|owned=Coordinator Recovery LLC|percentage=55\nOWNERSHIP_EDGE|owner=Leo Park|owner_type=person|owned=Coordinator Recovery LLC|percentage=45\nCASE_EVIDENCE|type=incorporation_record|reference=Delaware formation certificate|status=supported|value=current','Valid evidence with deterministic first-attempt integration failure'),
 ('62000000-0000-0000-0000-000000000055','52000000-0000-0000-0000-000000000055','32000000-0000-0000-0000-000000000055','12000000-0000-0000-0000-000000000055','42000000-0000-0000-0000-000000000055',E'ENTITY_FACT|field=legal_name|value=COORDINATOR RESEARCH LTD\nENTITY_FACT|field=jurisdiction|value=GB\nENTITY_FACT|field=identifier|identifier_type=registration_number|value=GB-COORD-55|jurisdiction=GB\nENTITY_FACT|field=address|address_type=registered|value=55 Research Lane London\nENTITY_FACT|field=address|address_type=operating|value=55 Research Lane London\nENTITY_FACT|field=address|address_type=mailing|value=55 Research Lane London\nOWNERSHIP_EDGE|owner=Mina Ford|owner_type=person|owned=Coordinator Research Ltd|percentage=75\nOWNERSHIP_EDGE|owner=Kai West|owner_type=person|owned=Coordinator Research Ltd|percentage=25\nCASE_EVIDENCE|type=incorporation_record|reference=Companies House extract|status=supported|value=current','Documented licensing gap requiring bounded public research')
) rows(id, document_id, case_id, applicant_id, submission_id, content, locator)
WHERE NOT EXISTS (SELECT 1 FROM document_chunks c WHERE c.id = rows.id::uuid);

INSERT INTO analysis_runs (
  id, case_id, session_id, status, output_schema_version, policy_effective_on, case_snapshot, started_at
)
SELECT ('a4000000-0000-4000-8000-0000000000' || n)::uuid, c.id,
       'coordinator-v3-fixture-' || n, 'queued', '3.4.0', DATE '2026-09-20',
       jsonb_build_object(
         'case_reference', c.reference,
         'application_id', a.id,
         'applicant', jsonb_build_object('id', p.id, 'legal_name', p.legal_name, 'jurisdiction', p.jurisdiction, 'business_type', p.business_type, 'product', p.product),
         'submitted_payload', a.submitted_payload
       ), clock_timestamp()
FROM (VALUES ('51'),('52'),('53'),('54'),('55')) ids(n)
JOIN onboarding_cases c ON c.id = ('32000000-0000-0000-0000-0000000000' || n)::uuid
JOIN applications a ON a.id = c.application_id
JOIN applicants p ON p.id = c.applicant_id
WHERE NOT EXISTS (SELECT 1 FROM analysis_runs r WHERE r.id = ('a4000000-0000-4000-8000-0000000000' || n)::uuid);

INSERT INTO analysis_run_documents (analysis_run_id, case_id, document_id)
SELECT ('a4000000-0000-4000-8000-0000000000' || n)::uuid,
       ('32000000-0000-0000-0000-0000000000' || n)::uuid,
       ('52000000-0000-0000-0000-0000000000' || n)::uuid
FROM (VALUES ('51'),('52'),('53'),('54'),('55')) ids(n)
ON CONFLICT DO NOTHING;

INSERT INTO analysis_run_policy_versions (analysis_run_id, policy_version_id)
SELECT ('a4000000-0000-4000-8000-0000000000' || n)::uuid, version_id::uuid
FROM (VALUES
  ('51','81000000-0000-0000-0000-000000000012'),
  ('52','81000000-0000-0000-0000-000000000012'),
  ('52','81000000-0000-0000-0000-000000000013'),
  ('53','81000000-0000-0000-0000-000000000012'),
  ('53','81000000-0000-0000-0000-000000000013'),
  ('54','81000000-0000-0000-0000-000000000012'),
  ('55','81000000-0000-0000-0000-000000000012'),
  ('55','81000000-0000-0000-0000-000000000014')
) pins(n, version_id)
ON CONFLICT DO NOTHING;

INSERT INTO evidence_gaps (id, analysis_run_id, requirement_code, description, requested_evidence)
VALUES (
  'b4000000-0000-4000-8000-000000000055',
  'a4000000-0000-4000-8000-000000000055',
  'LIC-MS-1',
  'The submitted packet contains no independently accepted public source addressing the bounded TinyFish documentation claim.',
  'An accepted immutable result from docs.tinyfish.ai that directly addresses the claim.'
)
ON CONFLICT (id) DO NOTHING;

COMMIT;
