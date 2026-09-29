BEGIN;

CREATE OR REPLACE FUNCTION policy_scope_array_status(required text[], actual jsonb)
RETURNS text LANGUAGE plpgsql STABLE SET search_path = public AS $$
BEGIN
  IF cardinality(required) = 0 THEN
    RETURN 'applies';
  END IF;
  IF jsonb_typeof(actual) IS DISTINCT FROM 'array' THEN
    RETURN 'needs_information';
  END IF;
  IF jsonb_array_length(actual) = 0 THEN
    RETURN 'needs_information';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(actual) AS item(value)
    WHERE item.value = ANY(required)
      OR ('US' = ANY(required) AND item.value LIKE 'US-%')
  ) THEN
    RETURN 'applies';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(actual) AS item(value)
    WHERE item.value = 'US'
  ) AND EXISTS (SELECT 1 FROM unnest(required) AS value WHERE value LIKE 'US-%') THEN
    RETURN 'needs_information';
  END IF;
  RETURN 'does_not_apply';
END;
$$;

CREATE OR REPLACE FUNCTION policy_scope_value_status(required text[], actual text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE
    WHEN cardinality(required) = 0 THEN 'applies'
    WHEN actual IS NULL OR btrim(actual) = '' OR actual = 'unknown' THEN 'needs_information'
    WHEN actual = ANY(required) THEN 'applies'
    ELSE 'does_not_apply'
  END;
$$;

CREATE OR REPLACE FUNCTION policy_rule_scope_status_for_run(p_run_id uuid, p_rule_id uuid)
RETURNS text LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT CASE
    WHEN 'does_not_apply' = ANY(statuses.values) THEN 'does_not_apply'
    WHEN 'needs_information' = ANY(statuses.values) THEN 'needs_information'
    ELSE 'applies'
  END
  FROM analysis_runs run
  JOIN policy_rule_scopes rule ON rule.id = p_rule_id
  CROSS JOIN LATERAL (
    SELECT ARRAY[
      policy_scope_array_status(rule.provider_roles,
        run.case_snapshot #> '{provider,regulated_roles}'),
      policy_scope_array_status(rule.provider_jurisdictions,
        run.case_snapshot #> '{provider,service_jurisdictions}'),
      policy_scope_value_status(rule.applicant_payment_activities,
        run.case_snapshot #>> '{submitted_payload,activity_declaration,payment_activity}'),
      policy_scope_array_status(rule.operating_jurisdictions,
        run.case_snapshot #> '{submitted_payload,activity_declaration,operating_jurisdictions}'),
      policy_scope_value_status(
        CASE WHEN rule.funds_handling IS NULL THEN '{}'::text[] ELSE ARRAY[rule.funds_handling] END,
        run.case_snapshot #>> '{submitted_payload,activity_declaration,handles_customer_funds}')
    ] AS values
  ) statuses
  WHERE run.id = p_run_id;
$$;

CREATE OR REPLACE FUNCTION policy_rule_applies_to_run(p_run_id uuid, p_rule_id uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT policy_rule_scope_status_for_run(p_run_id, p_rule_id) = 'applies';
$$;

CREATE OR REPLACE FUNCTION policy_chunk_scope_eligible(p_run_id uuid, p_chunk_id uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT NOT EXISTS (
    SELECT 1
    FROM analysis_runs run
    JOIN policy_rule_scopes rule ON rule.policy_chunk_id = p_chunk_id
      AND rule.created_at <= run.created_at
    WHERE run.id = p_run_id
      AND (rule.review_state <> 'approved'
        OR rule.approved_at > run.created_at
        OR policy_rule_scope_status_for_run(run.id, rule.id) = 'does_not_apply')
  );
$$;

COMMENT ON FUNCTION policy_chunk_scope_eligible(uuid, uuid) IS
  'Includes approved scoped rules with unknown trigger facts so reviewers can see a needs_information prompt; excludes explicit scope mismatches.';

COMMIT;
