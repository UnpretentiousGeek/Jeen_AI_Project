BEGIN;

-- The durable coordinator records per-result decisions, but Public Research
-- analysis requires the review itself to be decided and the approved search
-- action to be executed. Close both once every fetched result has a decision.
CREATE OR REPLACE FUNCTION complete_coordinator_v3_web_result_review(
  p_analysis_run_id uuid,
  p_result_ids jsonb,
  p_reviewer text,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  execution_ids uuid[];
  execution web_search_executions%ROWTYPE;
  review web_result_reviews%ROWTYPE;
  accepted_count integer;
BEGIN
  IF jsonb_typeof(p_result_ids) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_result_ids) = 0
     OR NULLIF(trim(p_reviewer), '') IS NULL
     OR NULLIF(trim(p_idempotency_key), '') IS NULL THEN
    RAISE EXCEPTION 'web result review completion is invalid' USING ERRCODE = '22023';
  END IF;
  SELECT array_agg(DISTINCT item.search_execution_id) INTO execution_ids
  FROM web_result_review_items item
  WHERE item.analysis_run_id = p_analysis_run_id
    AND item.external_web_evidence_id::text IN (SELECT jsonb_array_elements_text(p_result_ids));
  IF execution_ids IS NULL OR array_length(execution_ids, 1) <> 1 THEN
    RAISE EXCEPTION 'web result review completion must cover exactly one search execution' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO execution FROM web_search_executions WHERE id = execution_ids[1] FOR UPDATE;
  SELECT * INTO review FROM web_result_reviews WHERE search_execution_id = execution.id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'web result review is unavailable' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM web_result_review_items item
    WHERE item.review_id = review.id AND item.review_state = 'pending_review'
  ) THEN
    RAISE EXCEPTION 'every fetched web result needs a decision before the review completes' USING ERRCODE = '22023';
  END IF;
  SELECT count(*) INTO accepted_count FROM web_result_review_items item
  WHERE item.review_id = review.id AND item.review_state = 'accepted';
  IF review.status = 'decided' THEN
    IF review.idempotency_key = p_idempotency_key THEN
      RETURN jsonb_build_object('status', 'duplicate_suppressed', 'search_execution_id', execution.id,
                                'accepted_count', accepted_count);
    END IF;
    RAISE EXCEPTION 'web result review was already completed' USING ERRCODE = '23P01';
  END IF;
  UPDATE web_result_reviews
  SET status = 'decided', decided_by = p_reviewer,
      rationale = 'Analyst recorded a decision for every fetched result.',
      decided_at = clock_timestamp(), idempotency_key = p_idempotency_key
  WHERE id = review.id;
  UPDATE proposed_actions SET status = 'executed'
  WHERE id = execution.proposed_action_id AND status = 'approved';
  RETURN jsonb_build_object('status', 'completed', 'search_execution_id', execution.id,
                            'accepted_count', accepted_count);
END;
$$;

COMMIT;
