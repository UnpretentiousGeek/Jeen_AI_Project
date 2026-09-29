BEGIN;

CREATE OR REPLACE FUNCTION validate_reviewed_policy_contribution()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  assessment_id_text text;
  assessment policy_assessment_proposals%ROWTYPE;
  matrix_item jsonb;
  fact jsonb;
  reference jsonb;
  citation jsonb;
  policy_source record;
  case_source record;
  expected_status text;
  seen_ids uuid[] := ARRAY[]::uuid[];
  expected_citations integer := 0;
  fact_index integer;
BEGIN
  IF NEW.specialty <> 'policy' OR NOT (NEW.payload ? 'reviewed_assessment_ids') THEN
    RETURN NEW;
  END IF;
  IF NEW.payload->>'specialty' IS DISTINCT FROM 'policy'
     OR NEW.payload->>'status' IS DISTINCT FROM 'partial'
     OR jsonb_typeof(NEW.payload->'reviewed_assessment_ids') IS DISTINCT FROM 'array'
     OR jsonb_typeof(NEW.payload->'requirement_evidence_matrix') IS DISTINCT FROM 'array'
     OR jsonb_typeof(NEW.payload->'citations') IS DISTINCT FROM 'array'
     OR NEW.payload->'policy_conflicts' IS DISTINCT FROM '[]'::jsonb
     OR jsonb_array_length(NEW.payload->'reviewed_assessment_ids') NOT BETWEEN 1 AND 25
     OR jsonb_array_length(NEW.payload->'requirement_evidence_matrix')
          <> jsonb_array_length(NEW.payload->'reviewed_assessment_ids') THEN
    RAISE EXCEPTION 'reviewed policy contribution has an invalid shape' USING ERRCODE = '22023';
  END IF;

  FOR assessment_id_text IN
    SELECT value FROM jsonb_array_elements_text(NEW.payload->'reviewed_assessment_ids')
  LOOP
    IF assessment_id_text::uuid = ANY(seen_ids) THEN
      RAISE EXCEPTION 'reviewed policy assessment is duplicated' USING ERRCODE = '22023';
    END IF;
    seen_ids := array_append(seen_ids, assessment_id_text::uuid);
    SELECT * INTO assessment
    FROM accepted_policy_assessments_for_run(NEW.analysis_run_id)
    WHERE id = assessment_id_text::uuid;
    IF NOT FOUND OR assessment.case_id IS DISTINCT FROM NEW.case_id THEN
      RAISE EXCEPTION 'reviewed policy assessment is not accepted and in scope' USING ERRCODE = '42501';
    END IF;

    SELECT value INTO matrix_item
    FROM jsonb_array_elements(NEW.payload->'requirement_evidence_matrix')
    WHERE value->>'assessment_proposal_id' = assessment_id_text;
    IF NOT FOUND OR (
      SELECT count(*) FROM jsonb_array_elements(NEW.payload->'requirement_evidence_matrix')
      WHERE value->>'assessment_proposal_id' = assessment_id_text
    ) <> 1 THEN
      RAISE EXCEPTION 'reviewed policy matrix does not match accepted assessments' USING ERRCODE = '22023';
    END IF;

    expected_status := CASE assessment.proposal->>'outcome'
      WHEN 'supports' THEN 'supported'
      WHEN 'contradicts' THEN 'conflicting'
      WHEN 'not_addressed' THEN 'unsupported'
      WHEN 'uncertain' THEN 'unsupported'
      ELSE NULL
    END;
    IF expected_status IS NULL
       OR matrix_item->>'status' IS DISTINCT FROM expected_status
       OR matrix_item->>'description' IS DISTINCT FROM assessment.proposal #>> '{requirement,statement}'
       OR matrix_item->'required_evidence' IS DISTINCT FROM assessment.proposal #> '{requirement,required_evidence}'
       OR matrix_item->>'assessment_reviewed_by' IS DISTINCT FROM assessment.reviewed_by
       OR matrix_item->'policy_citation_ids' IS DISTINCT FROM jsonb_build_array('policy-' || assessment_id_text)
       OR jsonb_typeof(matrix_item->'available_evidence_references') IS DISTINCT FROM 'array'
       OR jsonb_array_length(matrix_item->'available_evidence_references')
            <> jsonb_array_length(assessment.proposal->'facts') THEN
      RAISE EXCEPTION 'reviewed policy matrix differs from accepted proposal' USING ERRCODE = '22023';
    END IF;

    SELECT chunk.content, chunk.section_locator, version.id::text AS version_id
    INTO policy_source
    FROM policy_chunks chunk
    JOIN policy_versions version ON version.id = chunk.policy_version_id
    WHERE chunk.id = assessment.policy_chunk_id;
    IF NOT FOUND OR strpos(policy_source.content,
      COALESCE(assessment.proposal #>> '{requirement,excerpt}', '')) = 0 THEN
      RAISE EXCEPTION 'reviewed policy citation source is invalid' USING ERRCODE = '22023';
    END IF;
    SELECT value INTO citation FROM jsonb_array_elements(NEW.payload->'citations')
    WHERE value->>'id' = 'policy-' || assessment_id_text;
    IF NOT FOUND OR citation IS DISTINCT FROM jsonb_build_object(
      'id', 'policy-' || assessment_id_text,
      'source_kind', 'policy',
      'source_id', policy_source.version_id,
      'chunk_id', assessment.policy_chunk_id::text,
      'locator', policy_source.section_locator,
      'excerpt', assessment.proposal #>> '{requirement,excerpt}'
    ) THEN
      RAISE EXCEPTION 'reviewed policy citation differs from accepted source' USING ERRCODE = '22023';
    END IF;
    expected_citations := expected_citations + 1;

    FOR fact_index IN 0..jsonb_array_length(assessment.proposal->'facts') - 1 LOOP
      fact := assessment.proposal->'facts'->fact_index;
      reference := matrix_item->'available_evidence_references'->fact_index;
      SELECT chunk.content, chunk.section_locator INTO case_source
      FROM document_chunks chunk
      WHERE chunk.id = (fact->>'chunk_id')::uuid
        AND chunk.document_id = assessment.document_id
        AND chunk.case_id = NEW.case_id;
      IF NOT FOUND OR strpos(case_source.content, COALESCE(fact->>'excerpt', '')) = 0 THEN
        RAISE EXCEPTION 'reviewed case citation source is invalid' USING ERRCODE = '22023';
      END IF;
      IF reference IS DISTINCT FROM jsonb_build_object(
        'evidence_type', 'formation_certificate',
        'reference', assessment.document_id::text,
        'status', 'present',
        'value', fact->>'fact',
        'citation_id', 'case-' || assessment_id_text || '-' || (fact_index + 1)::text
      ) THEN
        RAISE EXCEPTION 'reviewed case reference differs from accepted proposal' USING ERRCODE = '22023';
      END IF;
      SELECT value INTO citation FROM jsonb_array_elements(NEW.payload->'citations')
      WHERE value->>'id' = 'case-' || assessment_id_text || '-' || (fact_index + 1)::text;
      IF NOT FOUND OR citation IS DISTINCT FROM jsonb_build_object(
        'id', 'case-' || assessment_id_text || '-' || (fact_index + 1)::text,
        'source_kind', 'case_document',
        'source_id', assessment.document_id::text,
        'chunk_id', fact->>'chunk_id',
        'locator', case_source.section_locator,
        'excerpt', fact->>'excerpt'
      ) THEN
        RAISE EXCEPTION 'reviewed case citation differs from accepted source' USING ERRCODE = '22023';
      END IF;
      expected_citations := expected_citations + 1;
    END LOOP;
  END LOOP;
  IF jsonb_array_length(NEW.payload->'citations') <> expected_citations THEN
    RAISE EXCEPTION 'reviewed policy contribution has extra citations' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER reviewed_policy_contribution_guard
BEFORE INSERT ON coordinator_v3_contributions
FOR EACH ROW EXECUTE FUNCTION validate_reviewed_policy_contribution();

COMMIT;
