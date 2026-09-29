BEGIN;

CREATE TABLE onboarding_provider_profile (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  legal_name text NOT NULL CHECK (length(btrim(legal_name)) BETWEEN 1 AND 200),
  regulated_roles text[] NOT NULL,
  service_jurisdictions text[] NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (cardinality(regulated_roles) > 0),
  CHECK (cardinality(service_jurisdictions) > 0),
  CHECK (regulated_roles <@ ARRAY['bank','payment_institution','money_transmitter','marketplace']::text[])
);

CREATE OR REPLACE FUNCTION snapshot_onboarding_provider()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE profile onboarding_provider_profile%ROWTYPE;
BEGIN
  SELECT * INTO profile FROM onboarding_provider_profile WHERE id = 1;
  NEW.case_snapshot := jsonb_set(
    COALESCE(NEW.case_snapshot, '{}'::jsonb), '{provider}',
    CASE WHEN FOUND THEN jsonb_build_object(
      'legal_name', profile.legal_name,
      'regulated_roles', to_jsonb(profile.regulated_roles),
      'service_jurisdictions', to_jsonb(profile.service_jurisdictions),
      'profile_updated_at', profile.updated_at
    ) ELSE 'null'::jsonb END,
    true
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER analysis_run_provider_snapshot
BEFORE INSERT ON analysis_runs
FOR EACH ROW EXECUTE FUNCTION snapshot_onboarding_provider();

CREATE TABLE policy_rule_scopes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_chunk_id uuid NOT NULL REFERENCES policy_chunks(id) ON DELETE CASCADE,
  code text NOT NULL UNIQUE CHECK (length(btrim(code)) BETWEEN 1 AND 100),
  statement text NOT NULL CHECK (length(btrim(statement)) BETWEEN 8 AND 2000),
  source_excerpt text NOT NULL CHECK (length(btrim(source_excerpt)) BETWEEN 8 AND 4000),
  rule_kind text NOT NULL CHECK (rule_kind IN ('operator_cdd','applicant_license','risk_guidance')),
  provider_roles text[] NOT NULL DEFAULT '{}'::text[],
  provider_jurisdictions text[] NOT NULL DEFAULT '{}'::text[],
  applicant_payment_activities text[] NOT NULL DEFAULT '{}'::text[],
  operating_jurisdictions text[] NOT NULL DEFAULT '{}'::text[],
  funds_handling text CHECK (funds_handling IN ('yes','no')),
  review_state text NOT NULL DEFAULT 'draft' CHECK (review_state IN ('draft','approved')),
  approved_by text,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (provider_roles <@ ARRAY['bank','payment_institution','money_transmitter','marketplace']::text[]),
  CHECK (applicant_payment_activities <@ ARRAY['none','facilitates','receives_or_transmits']::text[]),
  CHECK ((review_state = 'draft' AND approved_by IS NULL AND approved_at IS NULL)
      OR (review_state = 'approved' AND approved_by IS NOT NULL
        AND length(btrim(approved_by)) > 0 AND approved_at IS NOT NULL))
);

CREATE INDEX policy_rule_scopes_chunk_idx ON policy_rule_scopes(policy_chunk_id, review_state);

CREATE OR REPLACE FUNCTION guard_policy_rule_scope()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE source_text text;
BEGIN
  SELECT content INTO source_text FROM policy_chunks WHERE id = NEW.policy_chunk_id;
  IF source_text IS NULL OR strpos(source_text, NEW.source_excerpt) = 0 THEN
    RAISE EXCEPTION 'policy rule must quote its source passage' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    OLD.review_state = 'approved'
    OR NEW.policy_chunk_id IS DISTINCT FROM OLD.policy_chunk_id
    OR NEW.code IS DISTINCT FROM OLD.code
    OR NEW.source_excerpt IS DISTINCT FROM OLD.source_excerpt
  ) THEN
    RAISE EXCEPTION 'approved policy rules and source references are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER policy_rule_scope_guard
BEFORE INSERT OR UPDATE ON policy_rule_scopes
FOR EACH ROW EXECUTE FUNCTION guard_policy_rule_scope();

COMMIT;
