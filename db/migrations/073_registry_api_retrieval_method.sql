BEGIN;

-- A registry record (GLEIF, Companies House) is read from the registry's own API, not scraped
-- from a page. The fetch step says which it did, so a reviewer can tell official registry data
-- from a fetched web page.
ALTER TABLE external_web_evidence
  DROP CONSTRAINT IF EXISTS external_web_evidence_retrieval_method_check;

ALTER TABLE external_web_evidence
  ADD CONSTRAINT external_web_evidence_retrieval_method_check
  CHECK (retrieval_method IN ('firecrawl_search', 'tinyfish_search', 'tinyfish_fetch', 'registry_api'));

CREATE OR REPLACE FUNCTION record_coordinator_v3_web_result(
  p_execution_id uuid,
  p_approval_id uuid,
  p_analysis_run_id uuid,
  p_case_id uuid,
  p_result_id uuid,
  p_result jsonb
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  execution web_search_executions%ROWTYPE;
  existing external_web_evidence%ROWTYPE;
  review_id uuid;
  incoming_hash text := encode(digest(p_result::text, 'sha256'), 'hex');
  scope jsonb := COALESCE(p_result->'approved_scope', '{}'::jsonb);
  method text := COALESCE(p_result->>'retrieval_method', 'tinyfish_fetch');
BEGIN
  IF method NOT IN ('tinyfish_fetch', 'registry_api') THEN
    RAISE EXCEPTION 'web result retrieval method is not a fetch method' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO execution FROM web_search_executions WHERE id = p_execution_id FOR UPDATE;
  IF NOT FOUND OR execution.analysis_run_id <> p_analysis_run_id OR execution.case_id <> p_case_id
     OR execution.approval_id <> p_approval_id OR execution.status NOT IN ('approved', 'running', 'succeeded') THEN
    RAISE EXCEPTION 'web result execution, approval, or run identity is invalid' USING ERRCODE = '42501';
  END IF;
  IF p_result->>'query' IS DISTINCT FROM execution.query
     OR scope->>'query' IS DISTINCT FROM execution.query
     OR scope->'allowed_domains' IS DISTINCT FROM to_jsonb(execution.allowed_domains)
     OR (scope ? 'max_results' AND (scope->>'max_results')::integer <> execution.max_results) THEN
    RAISE EXCEPTION 'web result is outside the exact approved query or scope' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO existing FROM external_web_evidence WHERE id = p_result_id;
  IF FOUND THEN
    IF existing.analysis_run_id = p_analysis_run_id AND existing.payload_hash = incoming_hash THEN
      RETURN jsonb_build_object('status', 'duplicate_suppressed', 'result_id', p_result_id);
    END IF;
    RAISE EXCEPTION 'web result identity conflicts with a different checksum or scope' USING ERRCODE = '23P01';
  END IF;
  SELECT id INTO review_id FROM web_result_reviews WHERE search_execution_id = p_execution_id;
  IF review_id IS NULL THEN
    INSERT INTO web_result_reviews(search_execution_id, analysis_run_id, case_id, checkpoint_id)
    VALUES (p_execution_id, p_analysis_run_id, p_case_id, 'web-result-review:' || p_execution_id::text)
    RETURNING id INTO review_id;
  END IF;
  INSERT INTO external_web_evidence(
    id, search_execution_id, analysis_run_id, case_id, approval_id, approved_scope, query,
    url, canonical_url, title, publisher, retrieved_at, excerpt, content, storage_locator,
    content_hash, payload_hash, retrieval_method
  ) VALUES (
    p_result_id, p_execution_id, p_analysis_run_id, p_case_id, p_approval_id, scope, execution.query,
    p_result->>'url', p_result->>'canonical_url', p_result->>'title', p_result->>'publisher',
    (p_result->>'retrieved_at')::timestamptz, COALESCE(p_result->>'excerpt', ''),
    p_result->>'content', p_result->>'storage_locator', p_result->>'checksum', incoming_hash, method
  );
  INSERT INTO web_result_review_items(
    review_id, external_web_evidence_id, search_execution_id, analysis_run_id, case_id, content_hash
  ) VALUES (review_id, p_result_id, p_execution_id, p_analysis_run_id, p_case_id, p_result->>'checksum');
  RETURN jsonb_build_object('status', 'stored', 'result_id', p_result_id, 'review_id', review_id);
END;
$$;

COMMIT;
