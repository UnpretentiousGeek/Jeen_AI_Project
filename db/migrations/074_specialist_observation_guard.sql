BEGIN;

-- Advisory observations from the Entity and Ownership agents ride inside the contribution payload.
-- They never change the deterministic rows; this guard only keeps their shape bounded and every
-- citation pinned to the contribution's own citations. Contributions without the field (3.1.0)
-- pass through unchanged.
CREATE OR REPLACE FUNCTION validate_specialist_observations()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  observation jsonb;
  citation_id text;
  allowed_kinds text[];
  cited_ids text[];
BEGIN
  IF NEW.specialty NOT IN ('entity', 'ownership') OR NOT (NEW.payload ? 'observations') THEN
    RETURN NEW;
  END IF;
  allowed_kinds := CASE NEW.specialty
    WHEN 'entity' THEN ARRAY[
      'near_miss_equivalence', 'date_explanation', 'visual_check',
      'internal_consistency', 'analyst_question']
    ELSE ARRAY[
      'unexplained_remainder', 'control_beyond_shareholding', 'incomplete_chain',
      'percentage_conflict_explanation', 'person_name_match', 'risk_pattern']
  END;
  IF jsonb_typeof(NEW.payload->'observations') IS DISTINCT FROM 'array'
     OR jsonb_array_length(NEW.payload->'observations') > 8 THEN
    RAISE EXCEPTION 'specialist observations must be an array of at most 8 items' USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(array_agg(item->>'id'), ARRAY[]::text[]) INTO cited_ids
  FROM jsonb_array_elements(COALESCE(NEW.citations, '[]'::jsonb)) item;

  FOR observation IN SELECT value FROM jsonb_array_elements(NEW.payload->'observations') LOOP
    IF jsonb_typeof(observation) IS DISTINCT FROM 'object'
       OR EXISTS (
         SELECT 1 FROM jsonb_object_keys(observation) field
         WHERE field <> ALL(ARRAY['id', 'kind', 'about', 'statement', 'confidence', 'citations']))
       OR (observation ? 'id' AND (jsonb_typeof(observation->'id') IS DISTINCT FROM 'string'
           OR length(observation->>'id') NOT BETWEEN 1 AND 64))
       OR jsonb_typeof(observation->'kind') IS DISTINCT FROM 'string'
       OR NOT (observation->>'kind' = ANY(allowed_kinds))
       OR jsonb_typeof(observation->'about') IS DISTINCT FROM 'string'
       OR length(observation->>'about') NOT BETWEEN 1 AND 120
       OR jsonb_typeof(observation->'statement') IS DISTINCT FROM 'string'
       OR length(observation->>'statement') NOT BETWEEN 1 AND 600
       OR observation->>'confidence' IS DISTINCT FROM 'low'
          AND observation->>'confidence' IS DISTINCT FROM 'medium'
          AND observation->>'confidence' IS DISTINCT FROM 'high'
       OR jsonb_typeof(observation->'citations') IS DISTINCT FROM 'array'
       OR jsonb_array_length(observation->'citations') NOT BETWEEN 1 AND 5 THEN
      RAISE EXCEPTION 'specialist observation has an invalid shape' USING ERRCODE = '22023';
    END IF;
    FOR citation_id IN SELECT value FROM jsonb_array_elements_text(observation->'citations') LOOP
      IF NOT (citation_id = ANY(cited_ids)) THEN
        RAISE EXCEPTION 'specialist observation cites a source outside the contribution' USING ERRCODE = '42501';
      END IF;
    END LOOP;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.payload->'observations') item
    GROUP BY item->>'about' HAVING count(*) > 2
  ) THEN
    RAISE EXCEPTION 'at most 2 specialist observations may target the same row' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS specialist_observation_guard ON coordinator_v3_contributions;
CREATE TRIGGER specialist_observation_guard
BEFORE INSERT ON coordinator_v3_contributions
FOR EACH ROW EXECUTE FUNCTION validate_specialist_observations();

COMMIT;
