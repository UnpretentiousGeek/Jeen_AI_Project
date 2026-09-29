BEGIN;

CREATE OR REPLACE FUNCTION retrieve_policy_evidence(
  p_analysis_run_id uuid,
  p_query text,
  p_query_embedding vector DEFAULT NULL,
  p_limit integer DEFAULT 5
)
RETURNS TABLE (
  source_kind text,
  source_id uuid,
  chunk_id uuid,
  locator text,
  excerpt text,
  retrieval_score double precision,
  retrieval_mode text
)
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
BEGIN
  IF btrim(p_query) = '' THEN
    RAISE EXCEPTION 'retrieval query cannot be empty';
  END IF;
  IF p_limit < 1 OR p_limit > 20 THEN
    RAISE EXCEPTION 'retrieval limit must be between 1 and 20';
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT
      version.id AS source_id,
      chunk.id AS chunk_id,
      chunk.section_locator AS locator,
      chunk.content AS excerpt,
      ts_rank_cd(chunk.search_vector, websearch_to_tsquery('english', p_query))::double precision AS lexical_score,
      CASE
        WHEN p_query_embedding IS NOT NULL AND chunk.embedding IS NOT NULL
          THEN (1 - (chunk.embedding <=> p_query_embedding))::double precision
        ELSE 0::double precision
      END AS semantic_score,
      p_query_embedding IS NOT NULL AND chunk.embedding IS NOT NULL AS has_semantic_score
    FROM analysis_run_policy_versions snapshot
    JOIN analysis_runs run ON run.id = snapshot.analysis_run_id
    JOIN policy_versions version ON version.id = snapshot.policy_version_id
    JOIN policy_chunks chunk ON chunk.policy_version_id = version.id
    WHERE snapshot.analysis_run_id = p_analysis_run_id
      AND ('*' = ANY(chunk.jurisdictions)
        OR run.case_snapshot #>> '{applicant,jurisdiction}' = ANY(chunk.jurisdictions))
      AND ('*' = ANY(chunk.products)
        OR run.case_snapshot #>> '{applicant,product}' = ANY(chunk.products))
      AND ('*' = ANY(chunk.business_types)
        OR run.case_snapshot #>> '{applicant,business_type}' = ANY(chunk.business_types))
      AND (
        chunk.search_vector @@ websearch_to_tsquery('english', p_query)
        OR (p_query_embedding IS NOT NULL AND chunk.embedding IS NOT NULL)
      )
  )
  SELECT
    'policy'::text,
    candidate.source_id,
    candidate.chunk_id,
    candidate.locator,
    candidate.excerpt,
    CASE
      WHEN candidate.has_semantic_score
        THEN (0.4 * candidate.lexical_score) + (0.6 * candidate.semantic_score)
      ELSE candidate.lexical_score
    END,
    CASE WHEN candidate.has_semantic_score THEN 'hybrid' ELSE 'lexical' END
  FROM candidates candidate
  ORDER BY 6 DESC, candidate.chunk_id
  LIMIT p_limit;
END;
$$;

COMMIT;
