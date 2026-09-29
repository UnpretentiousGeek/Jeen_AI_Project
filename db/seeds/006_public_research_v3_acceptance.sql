BEGIN;

INSERT INTO applicants (id, legal_name, jurisdiction, business_type, product)
SELECT ('12000000-0000-0000-0000-0000000000' || n)::uuid,
       'Public Research Example ' || n || ' Ltd', 'GB', 'money_services', 'cross_border_payments'
FROM (VALUES ('41'),('42'),('43'),('44'),('45'),('46'),('47'),('48'),('49')) AS ids(n)
ON CONFLICT (id) DO NOTHING;

INSERT INTO applications (id, applicant_id, submitted_payload)
SELECT ('22000000-0000-0000-0000-0000000000' || n)::uuid,
       ('12000000-0000-0000-0000-0000000000' || n)::uuid,
       jsonb_build_object(
         'fixture', 'public_research_v3_' || n,
         'claimed_license_type', 'money_transmitter',
         'public_research', jsonb_build_object(
           'applicant_match', jsonb_build_object(
             'registration_numbers', jsonb_build_array('GB-PR-00' || n),
             'addresses', jsonb_build_array(n || ' Registry Lane London'),
             'official_domains', jsonb_build_array('app' || n || '.example'),
             'other_evidence', jsonb_build_array('LEI-PR-' || n)
           ),
           'claims', jsonb_build_array(jsonb_build_object(
             'claim_id', 'licensing',
             'requirement_code', 'LIC-PUBLIC-' || n,
             'claim', 'Public Research Example ' || n || ' Ltd holds money transmitter license MT-' || n || '.',
             'query', '"Public Research Example ' || n || ' Ltd" "MT-' || n || '"',
             'allowed_domains', CASE WHEN n = '44'
               THEN jsonb_build_array('regulator.example.gov', 'registry.example.gov')
               ELSE jsonb_build_array('regulator.example.gov') END,
             'disclosed_applicant_fields', jsonb_build_array('legal_name', 'claimed_license_type', 'jurisdiction'),
             'result_limit', 5,
             'rationale', 'Resolve the documented licensing evidence gap using bounded official-domain research.',
             'requested_evidence', 'An authoritative public record that directly supports or contradicts license MT-' || n || '.',
             'follow_up_proposal', jsonb_build_object(
               'claim_id', 'licensing',
               'claim', 'Public Research Example ' || n || ' Ltd holds money transmitter license MT-' || n || '.',
               'query', 'site:regulator.example.gov "GB-PR-00' || n || '" "MT-' || n || '"',
               'allowed_domains', jsonb_build_array('regulator.example.gov'),
               'disclosed_applicant_fields', jsonb_build_array('registration_number', 'claimed_license_type'),
               'result_limit', 3,
               'rationale', 'A second identifier-specific official-regulator query may resolve the remaining gap.'
             )
           ))
         )
       )
FROM (VALUES ('41'),('42'),('43'),('44'),('45'),('46'),('47'),('48'),('49')) AS ids(n)
ON CONFLICT (id) DO NOTHING;

INSERT INTO onboarding_cases (id, application_id, applicant_id, reference)
SELECT ('32000000-0000-0000-0000-0000000000' || n)::uuid,
       ('22000000-0000-0000-0000-0000000000' || n)::uuid,
       ('12000000-0000-0000-0000-0000000000' || n)::uuid,
       'KYB-PUBLIC-RESEARCH-V3-' || n
FROM (VALUES ('41'),('42'),('43'),('44'),('45'),('46'),('47'),('48'),('49')) AS ids(n)
ON CONFLICT (id) DO NOTHING;

INSERT INTO analysis_runs (
  id, case_id, session_id, status, output_schema_version,
  policy_effective_on, case_snapshot, started_at, finished_at
)
SELECT ('a3000000-0000-4000-8000-0000000000' || n)::uuid,
       ('32000000-0000-0000-0000-0000000000' || n)::uuid,
       'public-research-v3-' || n, 'succeeded', '3.3.0', DATE '2026-09-20',
       jsonb_build_object('fixture', 'public_research_v3_' || n), now(), now()
FROM (VALUES ('41'),('42'),('43'),('44'),('45'),('46'),('47'),('48'),('49')) AS ids(n)
ON CONFLICT (id) DO NOTHING;

INSERT INTO evidence_gaps (id, analysis_run_id, requirement_code, description, requested_evidence)
VALUES (
  'b3000000-0000-4000-8000-000000000041',
  'a3000000-0000-4000-8000-000000000041',
  'LIC-PUBLIC-41',
  'The applicant claims money transmitter license MT-41, but the pinned case evidence contains no authoritative license record.',
  'An authoritative public record that directly supports or contradicts license MT-41.'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO proposed_actions (
  id, analysis_run_id, case_id, action_type, summary, payload,
  status, idempotency_key, execution_result
)
SELECT ('b3000000-0000-4000-8000-0000000000' || n)::uuid,
       ('a3000000-0000-4000-8000-0000000000' || n)::uuid,
       ('32000000-0000-0000-0000-0000000000' || n)::uuid,
       'run_web_search', 'Run one exact bounded licensing search.',
       jsonb_build_object(
         'query', '"Public Research Example ' || n || ' Ltd" "MT-' || n || '"',
         'reason', 'Resolve the documented licensing evidence gap using bounded official-domain research.',
         'allowed_domains', CASE WHEN n = '44'
           THEN jsonb_build_array('regulator.example.gov', 'registry.example.gov')
           ELSE jsonb_build_array('regulator.example.gov') END,
         'max_results', 5,
         'intended_use', 'Assess the specific licensing claim for the applicant.',
         'external_disclosure', jsonb_build_array('legal_name', 'claimed_license_type', 'jurisdiction'),
         'claim_id', 'licensing',
         'claim', 'Public Research Example ' || n || ' Ltd holds money transmitter license MT-' || n || '.'
       ),
       'executed', 'public-research-v3-action-' || n,
       jsonb_build_object('synthetic_fixture', true)
FROM (VALUES ('42'),('43'),('44'),('45'),('46'),('47'),('48')) AS ids(n)
ON CONFLICT (id) DO NOTHING;

INSERT INTO review_requests (
  id, proposed_action_id, analysis_run_id, case_id, correlation_id,
  status, decided_at
)
SELECT ('c3000000-0000-4000-8000-0000000000' || n)::uuid,
       ('b3000000-0000-4000-8000-0000000000' || n)::uuid,
       ('a3000000-0000-4000-8000-0000000000' || n)::uuid,
       ('32000000-0000-0000-0000-0000000000' || n)::uuid,
       'public-research-v3-search-approval-' || n, 'decided', '2026-09-20T12:00:00Z'
FROM (VALUES ('42'),('43'),('44'),('45'),('46'),('47'),('48')) AS ids(n)
ON CONFLICT (id) DO NOTHING;

INSERT INTO approvals (
  id, proposed_action_id, decision, decided_by, rationale,
  decided_at, review_request_id, idempotency_key
)
SELECT ('d3000000-0000-4000-8000-0000000000' || n)::uuid,
       ('b3000000-0000-4000-8000-0000000000' || n)::uuid,
       'approved', 'analyst_fixture', 'Approved only this exact search execution scope.',
       '2026-09-20T12:00:00Z',
       ('c3000000-0000-4000-8000-0000000000' || n)::uuid,
       'public-research-v3-approval-' || n
FROM (VALUES ('42'),('43'),('44'),('45'),('46'),('47'),('48')) AS ids(n)
ON CONFLICT (id) DO NOTHING;

INSERT INTO web_search_executions (
  id, proposed_action_id, approval_id, analysis_run_id, case_id,
  query, allowed_domains, max_results, intended_use, external_disclosure,
  scope_hash, status, expires_at, claimed_at, completed_at,
  provider_request_id, research_status
)
SELECT ('e3000000-0000-4000-8000-0000000000' || n)::uuid,
       action.id, ('d3000000-0000-4000-8000-0000000000' || n)::uuid,
       action.analysis_run_id, action.case_id,
       action.payload ->> 'query',
       ARRAY(SELECT value FROM jsonb_array_elements_text(action.payload -> 'allowed_domains')),
       (action.payload ->> 'max_results')::integer,
       action.payload ->> 'intended_use',
       ARRAY(SELECT value FROM jsonb_array_elements_text(action.payload -> 'external_disclosure')),
       encode(digest(jsonb_build_object(
         'action_id', action.id,
         'case_id', action.case_id,
         'analysis_run_id', action.analysis_run_id,
         'query', action.payload ->> 'query',
         'allowed_domains', action.payload -> 'allowed_domains',
         'max_results', action.payload -> 'max_results',
         'intended_use', action.payload ->> 'intended_use',
         'external_disclosure', action.payload -> 'external_disclosure'
       )::text, 'sha256'), 'hex'),
       'succeeded', '2026-09-21T12:00:00Z', '2026-09-20T12:01:00Z', '2026-09-20T12:02:00Z',
       'synthetic-tinyfish-' || n, 'pending'
FROM (VALUES ('42'),('43'),('44'),('45'),('46'),('47'),('48')) AS ids(n)
JOIN proposed_actions action ON action.id = ('b3000000-0000-4000-8000-0000000000' || n)::uuid
ON CONFLICT (id) DO NOTHING;

INSERT INTO web_result_reviews (
  id, search_execution_id, analysis_run_id, case_id, checkpoint_id,
  status, decided_by, rationale, decided_at, idempotency_key
)
SELECT ('f3000000-0000-4000-8000-0000000000' || n)::uuid,
       ('e3000000-0000-4000-8000-0000000000' || n)::uuid,
       ('a3000000-0000-4000-8000-0000000000' || n)::uuid,
       ('32000000-0000-0000-0000-0000000000' || n)::uuid,
       'public-research-v3-result-review-' || n,
       'decided', 'analyst_fixture', 'Each immutable result was reviewed separately from search approval.',
       '2026-09-20T12:03:00Z', 'public-research-v3-result-decision-' || n
FROM (VALUES ('42'),('43'),('44'),('45'),('46'),('47'),('48')) AS ids(n)
ON CONFLICT (id) DO NOTHING;

WITH evidence(id, run_n, url, title, publisher, published_at, excerpt) AS (VALUES
  ('72000000-0000-4000-8000-000000000421','42','https://regulator.example.gov/entities/unrelated-42','Public Research Example 42 Ltd registration','Example Regulator','2026-08-01T00:00:00Z'::timestamptz,
   'Entity record. Public Research Example 42 Ltd, a New York corporation (registration number US-OTHER-999, LEI LEI-OTHER-42). Principal office: 999 Other Street New York. Website: unrelated42.example. The company is authorised by the state regulator and holds money transmitter license MT-42.'),
  ('72000000-0000-4000-8000-000000000431','43','https://regulator.example.gov/companies/gb-pr-0043','Company registration GB-PR-0043','Example Companies Registry','2026-07-01T00:00:00Z'::timestamptz,
   'Company registration details. Public Research Example 43 Ltd, company number GB-PR-0043, incorporated in GB. Registered office address: 43 Registry Lane London. Company status: active. Website: app43.example. This record shows registration details only.'),
  ('72000000-0000-4000-8000-000000000441','44','https://regulator.example.gov/licenses/mt-44','License MT-44 active','Example Financial Regulator','2026-08-10T00:00:00Z'::timestamptz,
   'Licence register entry. Public Research Example 44 Ltd (company number GB-PR-0044, LEI LEI-PR-44), 44 Registry Lane London, holds money transmitter license MT-44. Licence status: active. Website: app44.example.'),
  ('72000000-0000-4000-8000-000000000442','44','https://registry.example.gov/notices/mt-44-revoked','License MT-44 revocation notice','Example License Registry','2026-09-01T00:00:00Z'::timestamptz,
   'Notice of revocation. Public Research Example 44 Ltd (company number GB-PR-0044), registered office 44 Registry Lane London. The money transmitter license MT-44 held by the company was revoked with effect from 1 September 2026.'),
  ('72000000-0000-4000-8000-000000000451','45','https://regulator.example.gov/companies/gb-pr-0045','Company registration GB-PR-0045','Example Companies Registry',NULL,
   'Company registration details. Public Research Example 45 Ltd, company number GB-PR-0045, incorporated in GB. Registered office address: 45 Registry Lane London. Company status: active. Website: app45.example.'),
  ('72000000-0000-4000-8000-000000000461','46','https://regulator.example.gov/licenses/mt-46','License MT-46 active','Example Financial Regulator','2026-08-12T00:00:00Z'::timestamptz,
   'Licence register entry. Public Research Example 46 Ltd (company number GB-PR-0046), 46 Registry Lane London, holds money transmitter license MT-46. Licence status: active.'),
  ('72000000-0000-4000-8000-000000000462','46','https://regulator.example.gov/notices/mt-46-pending','Unreviewed MT-46 notice','Example Financial Regulator','2026-09-02T00:00:00Z'::timestamptz,
   'Draft notice. The money transmitter license MT-46 held by Public Research Example 46 Ltd (company number GB-PR-0046) has been suspended pending review.'),
  ('72000000-0000-4000-8000-000000000463','46','https://regulator.example.gov/notices/mt-46-rejected','Rejected MT-46 blog notice','Example Financial Regulator','2026-09-03T00:00:00Z'::timestamptz,
   'Blog post. Public Research Example 46 Ltd (company number GB-PR-0046) no longer holds money transmitter license MT-46, according to a former employee.'),
  ('72000000-0000-4000-8000-000000000464','46','https://regulator.example.gov/notices/mt-46-unapproved','Unapproved MT-46 notice','Example Financial Regulator','2026-09-04T00:00:00Z'::timestamptz,
   'Notice. The money transmitter license MT-46 of Public Research Example 46 Ltd (company number GB-PR-0046) was cancelled.'),
  ('72000000-0000-4000-8000-000000000471','47','https://news.example.com/licenses/mt-47','Out-of-scope license claim','Example News','2026-09-04T00:00:00Z'::timestamptz,
   'News report. Public Research Example 47 Ltd (company number GB-PR-0047), 47 Registry Lane London, says it holds money transmitter license MT-47.'),
  ('72000000-0000-4000-8000-000000000481','48','https://regulator.example.gov/licenses/mt-48','License MT-48 active','Example Financial Regulator','2026-08-15T00:00:00Z'::timestamptz,
   'Licence register entry. Public Research Example 48 Ltd (company number GB-PR-0048, LEI LEI-PR-48), 48 Registry Lane London, holds money transmitter license MT-48. Licence status: active. Website: app48.example.')
)
INSERT INTO external_web_evidence (
  id, search_execution_id, analysis_run_id, case_id, url, canonical_url,
  title, publisher, published_at, retrieved_at, excerpt, content_hash,
  retrieval_method
)
SELECT evidence.id::uuid,
       ('e3000000-0000-4000-8000-0000000000' || evidence.run_n)::uuid,
       ('a3000000-0000-4000-8000-0000000000' || evidence.run_n)::uuid,
       ('32000000-0000-0000-0000-0000000000' || evidence.run_n)::uuid,
       evidence.url, evidence.url, evidence.title, evidence.publisher,
       evidence.published_at, '2026-09-20T12:02:00Z', evidence.excerpt,
       'sha256:' || encode(digest(evidence.excerpt, 'sha256'), 'hex'),
       'tinyfish_fetch'
FROM evidence
ON CONFLICT (id) DO NOTHING;

WITH decisions(result_id, run_n, state) AS (VALUES
  ('72000000-0000-4000-8000-000000000421','42','accepted'),
  ('72000000-0000-4000-8000-000000000431','43','accepted'),
  ('72000000-0000-4000-8000-000000000441','44','accepted'),
  ('72000000-0000-4000-8000-000000000442','44','accepted'),
  ('72000000-0000-4000-8000-000000000451','45','accepted'),
  ('72000000-0000-4000-8000-000000000461','46','accepted'),
  ('72000000-0000-4000-8000-000000000462','46','pending_review'),
  ('72000000-0000-4000-8000-000000000463','46','rejected'),
  ('72000000-0000-4000-8000-000000000471','47','accepted'),
  ('72000000-0000-4000-8000-000000000481','48','accepted')
)
INSERT INTO web_result_review_items (
  review_id, external_web_evidence_id, search_execution_id,
  analysis_run_id, case_id, content_hash, review_state, decided_at,
  decided_by, rationale
)
SELECT ('f3000000-0000-4000-8000-0000000000' || decisions.run_n)::uuid,
       evidence.id,
       evidence.search_execution_id,
       evidence.analysis_run_id,
       evidence.case_id,
       evidence.content_hash,
       decisions.state,
       CASE WHEN decisions.state = 'pending_review' THEN NULL ELSE '2026-09-20T12:03:00Z'::timestamptz END,
       CASE WHEN decisions.state = 'pending_review' THEN NULL ELSE 'analyst_fixture' END,
       CASE WHEN decisions.state = 'pending_review' THEN NULL ELSE 'Reviewed this immutable result separately from search approval.' END
FROM decisions
JOIN external_web_evidence evidence ON evidence.id = decisions.result_id::uuid
ON CONFLICT (external_web_evidence_id) DO NOTHING;

COMMIT;
