BEGIN;

-- A policy assessment may flag case-form answers that its cited document facts contradict.
-- Each flag must name an activity declaration question the applicant answered, repeat that
-- answer exactly as it stands in the run's case snapshot, and point only at facts the proposal
-- cites (whose excerpts check_policy_assessment_sources verifies against the document).
CREATE OR REPLACE FUNCTION check_policy_assessment_declaration_conflicts()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  declaration jsonb;
  conflict jsonb;
  fact_count int;
  seen text[] := '{}';
BEGIN
  IF NOT NEW.proposal ? 'declaration_conflicts' THEN
    RETURN NEW;
  END IF;
  IF jsonb_typeof(NEW.proposal -> 'declaration_conflicts') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'policy assessment declaration conflicts must be an array' USING ERRCODE = '23514';
  END IF;
  SELECT run.case_snapshot #> '{submitted_payload,activity_declaration}' INTO declaration
  FROM analysis_runs run
  WHERE run.id = NEW.analysis_run_id AND run.case_id = NEW.case_id;
  fact_count := jsonb_array_length(NEW.proposal -> 'facts');
  FOR conflict IN SELECT value FROM jsonb_array_elements(NEW.proposal -> 'declaration_conflicts') LOOP
    IF jsonb_typeof(conflict) IS DISTINCT FROM 'object'
      OR COALESCE(conflict ->> 'field', '') NOT IN
        ('payment_activity', 'handles_customer_funds', 'licensing_basis', 'operating_jurisdictions')
      OR (conflict ->> 'field') = ANY(seen)
      OR declaration -> (conflict ->> 'field') IS NULL
      OR declaration -> (conflict ->> 'field') IN ('"unknown"'::jsonb, '[]'::jsonb)
      OR conflict -> 'declared_value' IS DISTINCT FROM declaration -> (conflict ->> 'field')
      OR length(btrim(COALESCE(conflict ->> 'explanation', ''))) = 0
      OR jsonb_typeof(conflict -> 'fact_indexes') IS DISTINCT FROM 'array'
      OR jsonb_array_length(conflict -> 'fact_indexes') = 0
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(conflict -> 'fact_indexes') AS item(value)
        WHERE jsonb_typeof(item.value) IS DISTINCT FROM 'number'
          OR item.value::text !~ '^[0-9]+$'
          OR item.value::text::int >= fact_count
      ) THEN
      RAISE EXCEPTION 'policy assessment declaration conflict is not grounded in the case declaration and cited facts'
        USING ERRCODE = '23514';
    END IF;
    seen := seen || (conflict ->> 'field');
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE TRIGGER policy_assessment_declaration_conflict_guard
BEFORE INSERT ON policy_assessment_proposals
FOR EACH ROW EXECUTE FUNCTION check_policy_assessment_declaration_conflicts();

COMMIT;
