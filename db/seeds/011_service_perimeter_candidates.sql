BEGIN;

-- Additional activity-perimeter research from official sources. These rows
-- remain pending research candidates and are never pinned into analysis runs.
WITH researched AS (
  SELECT * FROM jsonb_to_recordset($rules$[
    {
      "code":"US-05",
      "title":"U.S. Convertible Virtual Currency Business Models",
      "jurisdiction":"US",
      "rule_kind":"applicant_license",
      "source_authority":"FinCEN",
      "source_url":"https://www.fincen.gov/resources/statutes-regulations/guidance/application-fincens-regulations-certain-business-models",
      "source_locator":"FIN-2019-G001, Application of FinCEN's Regulations to Certain Business Models Involving Convertible Virtual Currencies",
      "rule_summary":"Certain businesses exchanging, administering, accepting, or transmitting convertible virtual currency may be money services businesses under the Bank Secrecy Act.",
      "legal_trigger":"The applicant itself conducts a covered business model involving convertible virtual currency with a U.S. nexus, subject to the precise definition and any applicable limitation or exemption.",
      "evidence_to_review":"Actual business model, whether it accepts/transmits or exchanges value, customer and transaction roles, U.S. nexus, FinCEN registration, AML program, and any functional-regulator status.",
      "exceptions_to_review":"A user acting on its own behalf, excluded or functionally regulated entities, and limitations or exemptions from the money-transmitter definition; state licensing is a separate question.",
      "provider_roles":[],
      "payment_activities":["receives_or_transmits"],
      "operating_jurisdictions":["US"]
    },
    {
      "code":"CA-DFA-01",
      "title":"California Digital Financial Asset Business Activity",
      "jurisdiction":"US-CA",
      "rule_kind":"applicant_license",
      "source_authority":"California Department of Financial Protection and Innovation",
      "source_url":"https://dfpi.ca.gov/regulated-industries/digital-financial-assets/digital-financial-assets-law-frequently-asked-questions/",
      "source_locator":"California Financial Code sections 3103, 3201, and 3203; DFAL FAQs on covered activities, exemptions, and the July 1, 2026 effective date",
      "rule_summary":"Since July 1, 2026, a person generally may not conduct covered digital financial asset business activity with or on behalf of a California resident unless licensed, timely applied and awaiting a decision, or exempt.",
      "legal_trigger":"The applicant itself engages in covered digital financial asset business activity with or on behalf of a California resident, and no statutory exemption applies.",
      "evidence_to_review":"Specific asset and service, customer/resident nexus, custody and control, exchange or transfer flow, California DFPI license or timely application status, and any claimed exemption.",
      "exceptions_to_review":"Financial Code definitions and section 3103 exemptions; not every digital asset or software activity is covered, and other California licenses may also apply.",
      "provider_roles":[],
      "payment_activities":["receives_or_transmits"],
      "operating_jurisdictions":["US-CA"]
    },
    {
      "code":"NY-02",
      "title":"New York Virtual Currency Business Activity Authorization",
      "jurisdiction":"US-NY",
      "rule_kind":"applicant_license",
      "source_authority":"New York State Department of Financial Services",
      "source_url":"https://www.dfs.ny.gov/virtual_currency_businesses",
      "source_locator":"23 NYCRR Part 200, sections 200.2(q) and 200.3(a); DFS BitLicense FAQs",
      "rule_summary":"A person conducting defined virtual currency business activity involving New York or a New York resident generally needs a BitLicense or an appropriately approved New York banking charter.",
      "legal_trigger":"The applicant itself performs one of the defined virtual currency business activities involving New York or a New York resident.",
      "evidence_to_review":"Whether it receives or transmits virtual currency, holds or controls it for others, exchanges it as a customer business, or administers/issues it; New York nexus and DFS authorization.",
      "exceptions_to_review":"Part 200 exclusions and exemptions, including specified consumer/merchant use and purely technical software; an approved New York banking charter may be an alternative, while federal MSB registration does not replace New York authorization.",
      "provider_roles":[],
      "payment_activities":["receives_or_transmits"],
      "operating_jurisdictions":["US-NY"]
    },
    {
      "code":"TX-02",
      "title":"Texas Currency Exchange Licensing",
      "jurisdiction":"US-TX",
      "rule_kind":"applicant_license",
      "source_authority":"Texas Department of Banking",
      "source_url":"https://dob.texas.gov/money-services-businesses/faqs",
      "source_locator":"Texas Finance Code Chapter 152; Department of Banking Money Services Businesses FAQs, currency exchange",
      "rule_summary":"A business conducting currency exchange as defined by Texas Finance Code Chapter 152 may need a Texas money transmission license.",
      "legal_trigger":"The applicant itself conducts covered currency exchange activity in or involving Texas.",
      "evidence_to_review":"Currencies exchanged, transaction structure, customer and location nexus, whether activity fits the statutory definition, license status, and any delegate or exemption basis.",
      "exceptions_to_review":"Chapter 152 definitions and exclusions, covered financial-institution status, agency/delegate conditions, and other service-specific exceptions; confirm current Texas law.",
      "provider_roles":[],
      "payment_activities":["receives_or_transmits"],
      "operating_jurisdictions":["US-TX"]
    },
    {
      "code":"SG-03",
      "title":"Singapore Digital Payment Token Services",
      "jurisdiction":"SG",
      "rule_kind":"applicant_license",
      "source_authority":"Monetary Authority of Singapore / Singapore Statutes Online",
      "source_url":"https://sso.agc.gov.sg/Act/PSA2019?ProvIds=Sc1-",
      "source_locator":"Payment Services Act 2019, section 5 and First Schedule, Part 3, digital payment token service",
      "rule_summary":"Providing a regulated digital payment token service as a business in Singapore may require the relevant Payment Services Act licence or exemption.",
      "legal_trigger":"The applicant itself provides a defined digital payment token service in Singapore, including dealing, exchange facilitation, transfer arrangements, or custody/control services covered by the Act.",
      "evidence_to_review":"Token and service classification, customer role, control/custody, transfer and exchange flows, Singapore nexus, licence category, and any exemption.",
      "exceptions_to_review":"The Act's precise definitions, exclusions, exempt-provider rules, and subsidiary legislation; do not equate generic software or a token label with a regulated service.",
      "provider_roles":[],
      "payment_activities":["facilitates","receives_or_transmits"],
      "operating_jurisdictions":["SG"]
    },
    {
      "code":"AU-03",
      "title":"Australia Registrable Virtual Asset Services",
      "jurisdiction":"AU",
      "rule_kind":"applicant_license",
      "source_authority":"AUSTRAC",
      "source_url":"https://www.austrac.gov.au/new-austrac/register-us/register-us-remittance-or-virtual-asset-service-provider",
      "source_locator":"AML/CTF Act and Rules: new registrable virtual asset services; AUSTRAC registration guidance and 2026 transitional rules",
      "rule_summary":"A provider of a registrable virtual asset service in Australia may need AUSTRAC enrolment and registration; the transitional application date of July 29, 2026 has passed.",
      "legal_trigger":"The applicant itself provides a service that is a registrable virtual asset designated service with the required Australian nexus.",
      "evidence_to_review":"Exact designated-service category, Australian nexus, customer and asset flow, AUSTRAC enrolment/registration status, application dates, and AML/CTF transition requirements.",
      "exceptions_to_review":"Incidental transfers generally do not require registration; existing registered providers may not need to reapply; verify current service definitions and transitional status before any conclusion.",
      "provider_roles":[],
      "payment_activities":["receives_or_transmits"],
      "operating_jurisdictions":["AU"]
    }
  ]$rules$::jsonb) AS x(
    code text, title text, jurisdiction text, rule_kind text,
    source_authority text, source_url text, source_locator text,
    rule_summary text, legal_trigger text, evidence_to_review text,
    exceptions_to_review text, provider_roles text[],
    payment_activities text[], operating_jurisdictions text[]
  )
)
INSERT INTO policy_research_candidates (
  code, title, jurisdiction, rule_kind, source_authority, source_url,
  source_locator, rule_summary, legal_trigger, evidence_to_review,
  exceptions_to_review, provider_roles, payment_activities,
  operating_jurisdictions, business_types, products, researched_on,
  review_state
)
SELECT code, title, jurisdiction, rule_kind, source_authority, source_url,
  source_locator, rule_summary, legal_trigger, evidence_to_review,
  exceptions_to_review, provider_roles, payment_activities,
  operating_jurisdictions, ARRAY['*']::text[], ARRAY['*']::text[],
  CURRENT_DATE, 'pending_review'
FROM researched
ON CONFLICT (code) DO UPDATE SET
  title = EXCLUDED.title,
  jurisdiction = EXCLUDED.jurisdiction,
  rule_kind = EXCLUDED.rule_kind,
  source_authority = EXCLUDED.source_authority,
  source_url = EXCLUDED.source_url,
  source_locator = EXCLUDED.source_locator,
  rule_summary = EXCLUDED.rule_summary,
  legal_trigger = EXCLUDED.legal_trigger,
  evidence_to_review = EXCLUDED.evidence_to_review,
  exceptions_to_review = EXCLUDED.exceptions_to_review,
  provider_roles = EXCLUDED.provider_roles,
  payment_activities = EXCLUDED.payment_activities,
  operating_jurisdictions = EXCLUDED.operating_jurisdictions,
  business_types = EXCLUDED.business_types,
  products = EXCLUDED.products,
  researched_on = EXCLUDED.researched_on
WHERE policy_research_candidates.title IS DISTINCT FROM EXCLUDED.title
   OR policy_research_candidates.jurisdiction IS DISTINCT FROM EXCLUDED.jurisdiction
   OR policy_research_candidates.rule_kind IS DISTINCT FROM EXCLUDED.rule_kind
   OR policy_research_candidates.source_authority IS DISTINCT FROM EXCLUDED.source_authority
   OR policy_research_candidates.source_url IS DISTINCT FROM EXCLUDED.source_url
   OR policy_research_candidates.source_locator IS DISTINCT FROM EXCLUDED.source_locator
   OR policy_research_candidates.rule_summary IS DISTINCT FROM EXCLUDED.rule_summary
   OR policy_research_candidates.legal_trigger IS DISTINCT FROM EXCLUDED.legal_trigger
   OR policy_research_candidates.evidence_to_review IS DISTINCT FROM EXCLUDED.evidence_to_review
   OR policy_research_candidates.exceptions_to_review IS DISTINCT FROM EXCLUDED.exceptions_to_review
   OR policy_research_candidates.provider_roles IS DISTINCT FROM EXCLUDED.provider_roles
   OR policy_research_candidates.payment_activities IS DISTINCT FROM EXCLUDED.payment_activities
   OR policy_research_candidates.operating_jurisdictions IS DISTINCT FROM EXCLUDED.operating_jurisdictions
   OR policy_research_candidates.business_types IS DISTINCT FROM EXCLUDED.business_types
   OR policy_research_candidates.products IS DISTINCT FROM EXCLUDED.products;

DO $$
BEGIN
  IF (SELECT count(*) FROM policy_research_candidates WHERE code IN (
    'US-05', 'CA-DFA-01', 'NY-02', 'TX-02', 'SG-03', 'AU-03'
  ) AND review_state = 'pending_review') <> 6 THEN
    RAISE EXCEPTION 'expected six pending service-perimeter research candidates';
  END IF;
END $$;

COMMIT;
