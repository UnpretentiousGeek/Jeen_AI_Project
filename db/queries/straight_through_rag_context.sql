WITH selected_run AS (
  SELECT id, case_id, case_snapshot
  FROM analysis_runs
  WHERE session_id = 'langflow-rag-demo-straight-through'
),
case_passages AS (
  SELECT jsonb_agg(
    jsonb_build_object(
      'source_kind', passage.source_kind,
      'source_id', passage.source_id::text,
      'chunk_id', passage.chunk_id::text,
      'locator', passage.locator,
      'excerpt', passage.excerpt,
      'retrieval_score', passage.retrieval_score,
      'retrieval_mode', passage.retrieval_mode
    ) ORDER BY passage.retrieval_score DESC
  ) AS passages
  FROM selected_run run
  CROSS JOIN LATERAL retrieve_case_evidence(
    run.id,
    'ownership OR address OR license',
    NULL,
    5
  ) passage
),
policy_passages AS (
  SELECT jsonb_agg(
    jsonb_build_object(
      'source_kind', passage.source_kind,
      'source_id', passage.source_id::text,
      'chunk_id', passage.chunk_id::text,
      'locator', passage.locator,
      'excerpt', passage.excerpt,
      'retrieval_score', passage.retrieval_score,
      'retrieval_mode', passage.retrieval_mode
    ) ORDER BY passage.retrieval_score DESC
  ) AS passages
  FROM selected_run run
  CROSS JOIN LATERAL retrieve_policy_evidence(
    run.id,
    'ownership OR address OR evidence',
    NULL,
    5
  ) passage
)
SELECT jsonb_build_object(
  'schema_version', '1.0',
  'case_id', run.case_id::text,
  'analysis_run_id', run.id::text,
  'applicant', run.case_snapshot -> 'applicant',
  'ownership_total', (run.case_snapshot #>> '{submitted_payload,declared_ownership_total}')::numeric,
  'case_evidence', COALESCE(case_passages.passages, '[]'::jsonb),
  'applicable_policy', COALESCE(policy_passages.passages, '[]'::jsonb)
)::text AS analysis_context
FROM selected_run run
CROSS JOIN case_passages
CROSS JOIN policy_passages;
