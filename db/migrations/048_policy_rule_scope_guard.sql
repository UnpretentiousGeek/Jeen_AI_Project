BEGIN;

CREATE FUNCTION policy_scope_array_matches(required text[], actual jsonb)
RETURNS boolean LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT cardinality(required) = 0 OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(actual) = 'array' THEN actual ELSE '[]'::jsonb END
    ) AS item(value)
    WHERE item.value = ANY(required)
      OR ('US' = ANY(required) AND item.value LIKE 'US-%')
  );
$$;

CREATE FUNCTION policy_rule_applies_to_run(p_run_id uuid, p_rule_id uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT COALESCE(
    policy_scope_array_matches(rule.provider_roles,
      run.case_snapshot #> '{provider,regulated_roles}')
    AND policy_scope_array_matches(rule.provider_jurisdictions,
      run.case_snapshot #> '{provider,service_jurisdictions}')
    AND (cardinality(rule.applicant_payment_activities) = 0
      OR run.case_snapshot #>> '{submitted_payload,activity_declaration,payment_activity}'
        = ANY(rule.applicant_payment_activities))
    AND policy_scope_array_matches(rule.operating_jurisdictions,
      run.case_snapshot #> '{submitted_payload,activity_declaration,operating_jurisdictions}')
    AND (rule.funds_handling IS NULL
      OR run.case_snapshot #>> '{submitted_payload,activity_declaration,handles_customer_funds}'
        = rule.funds_handling),
    false
  )
  FROM analysis_runs run
  JOIN policy_rule_scopes rule ON rule.id = p_rule_id
  WHERE run.id = p_run_id;
$$;

CREATE FUNCTION policy_chunk_scope_eligible(p_run_id uuid, p_chunk_id uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT NOT EXISTS (
    SELECT 1
    FROM analysis_runs run
    JOIN policy_rule_scopes rule ON rule.policy_chunk_id = p_chunk_id
      AND rule.created_at <= run.created_at
    WHERE run.id = p_run_id
      AND (rule.review_state <> 'approved'
        OR rule.approved_at > run.created_at
        OR NOT COALESCE(policy_rule_applies_to_run(p_run_id, rule.id), false))
  );
$$;

CREATE FUNCTION guard_policy_assessment_rule_scope()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NOT policy_chunk_scope_eligible(NEW.analysis_run_id, NEW.policy_chunk_id) THEN
    RAISE EXCEPTION 'policy rule scope is not approved or applicable to this run'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER policy_assessment_rule_scope_guard
BEFORE INSERT ON policy_assessment_proposals
FOR EACH ROW EXECUTE FUNCTION guard_policy_assessment_rule_scope();

COMMIT;
