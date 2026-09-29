BEGIN;

-- Research is deliberately separate from policy_versions: those versions are
-- treated as approved and can be pinned automatically when an analysis starts.
CREATE TABLE policy_research_candidates (
  code text PRIMARY KEY CHECK (length(btrim(code)) BETWEEN 3 AND 100),
  title text NOT NULL,
  jurisdiction text NOT NULL,
  rule_kind text NOT NULL CHECK (rule_kind IN ('operator_cdd', 'applicant_license', 'risk_guidance')),
  source_authority text NOT NULL,
  source_url text NOT NULL CHECK (source_url ~ '^https://'),
  source_locator text NOT NULL,
  rule_summary text NOT NULL,
  legal_trigger text NOT NULL,
  evidence_to_review text NOT NULL,
  exceptions_to_review text NOT NULL,
  provider_roles text[] NOT NULL DEFAULT '{}'::text[],
  payment_activities text[] NOT NULL DEFAULT '{}'::text[],
  operating_jurisdictions text[] NOT NULL DEFAULT '{}'::text[],
  business_types text[] NOT NULL DEFAULT ARRAY['*']::text[],
  products text[] NOT NULL DEFAULT ARRAY['*']::text[],
  researched_on date NOT NULL,
  review_state text NOT NULL DEFAULT 'pending_review'
    CHECK (review_state = 'pending_review'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (provider_roles <@ ARRAY['bank', 'payment_institution', 'money_transmitter', 'marketplace']::text[]),
  CHECK (payment_activities <@ ARRAY['none', 'facilitates', 'receives_or_transmits']::text[]),
  CHECK (cardinality(business_types) > 0 AND cardinality(products) > 0)
);

COMMENT ON TABLE policy_research_candidates IS
  'Official-source rule research awaiting source-passage and institution review; never queried by analysis or policy pinning.';
COMMENT ON COLUMN policy_research_candidates.business_types IS
  'Discovery tags only. A matching tag does not establish that a legal trigger is met.';
COMMENT ON COLUMN policy_research_candidates.products IS
  'Discovery tags only. A requested product does not establish the regulated activity.';

COMMIT;
