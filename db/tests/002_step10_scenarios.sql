BEGIN;

DO $$
DECLARE
  straight_run uuid;
  interrupted_run uuid;
  unsupported_run uuid;
  failure_run uuid;
BEGIN
  SELECT id INTO straight_run FROM analysis_runs WHERE session_id = 'step10:straight-through:v1';
  SELECT id INTO interrupted_run FROM analysis_runs WHERE session_id = 'step10:interrupted:v1';
  SELECT id INTO unsupported_run FROM analysis_runs WHERE session_id = 'step10:unsupported-evidence:v1';
  SELECT id INTO failure_run FROM analysis_runs WHERE session_id = 'step10:agent-failure:v1';

  IF num_nonnulls(straight_run, interrupted_run, unsupported_run, failure_run) <> 4 THEN
    RAISE EXCEPTION 'all four Step 10 analysis runs must exist';
  END IF;
  IF cardinality(ARRAY[straight_run, interrupted_run, unsupported_run, failure_run]) <> 4
    OR (SELECT count(DISTINCT run_id) FROM unnest(ARRAY[
      straight_run, interrupted_run, unsupported_run, failure_run
    ]) run_id) <> 4
  THEN
    RAISE EXCEPTION 'Step 10 cases must have isolated analysis-run identities';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM analysis_runs run
    JOIN onboarding_cases onboarding_case ON onboarding_case.active_analysis_run_id = run.id
    WHERE run.id = straight_run AND run.status = 'succeeded'
      AND onboarding_case.status = 'ready_for_review'
  ) THEN
    RAISE EXCEPTION 'straight-through case did not reach ready for review';
  END IF;
  IF (SELECT count(*) FROM a2a_tasks WHERE analysis_run_id = straight_run AND status = 'completed') <> 3
    OR (SELECT count(*) FROM findings WHERE analysis_run_id = straight_run) = 0
    OR (SELECT count(*) FROM citations WHERE analysis_run_id = straight_run) = 0
  THEN
    RAISE EXCEPTION 'straight-through case is missing persisted specialist or finding provenance';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM analysis_runs run
    JOIN onboarding_cases onboarding_case ON onboarding_case.active_analysis_run_id = run.id
    WHERE run.id = interrupted_run AND run.status = 'suspended'
      AND onboarding_case.status = 'awaiting_information'
  ) THEN
    RAISE EXCEPTION 'interrupted case must remain suspended on its second clarification';
  END IF;
  IF (SELECT count(*) FROM human_input_requests
      WHERE analysis_run_id = interrupted_run AND status = 'answered'
        AND replacement_task_id IS NOT NULL) <> 1
    OR (SELECT count(*) FROM human_input_requests
        WHERE analysis_run_id = interrupted_run AND status = 'pending') <> 1
    OR (SELECT count(*) FROM a2a_tasks
        WHERE analysis_run_id = interrupted_run AND specialty = 'ownership') <> 2
    OR (SELECT count(*) FROM a2a_tasks
        WHERE analysis_run_id = interrupted_run AND specialty IN ('entity', 'policy')) <> 2
  THEN
    RAISE EXCEPTION 'interrupted case did not resume selectively and preserve completed tasks';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM analysis_runs run
    JOIN onboarding_cases onboarding_case ON onboarding_case.active_analysis_run_id = run.id
    WHERE run.id = unsupported_run AND run.status = 'suspended'
      AND onboarding_case.status = 'awaiting_approval'
  ) THEN
    RAISE EXCEPTION 'unsupported-evidence case must wait for web-search approval';
  END IF;
  IF NOT (
    (
      EXISTS (
        SELECT 1 FROM proposed_actions action
        JOIN review_requests review ON review.proposed_action_id = action.id
        WHERE action.analysis_run_id = unsupported_run
          AND action.action_type = 'run_web_search'
          AND action.status = 'pending'
          AND review.status = 'pending'
          AND action.payload ->> 'query' = 'Northstar Remittance LLC California money transmitter license'
          AND action.payload -> 'allowed_domains' = '["dfpi.ca.gov"]'::jsonb
          AND action.payload ->> 'max_results' = '5'
      )
      AND NOT EXISTS (
        SELECT 1 FROM web_search_executions WHERE analysis_run_id = unsupported_run
      )
      AND NOT EXISTS (
        SELECT 1 FROM external_web_evidence WHERE analysis_run_id = unsupported_run
      )
    )
    OR
    (
      EXISTS (
        SELECT 1
        FROM proposed_actions action
        JOIN web_search_executions execution ON execution.proposed_action_id = action.id
        JOIN web_result_reviews result_review
          ON result_review.search_execution_id = execution.id
        WHERE action.analysis_run_id = unsupported_run
          AND action.action_type = 'run_web_search'
          AND action.status = 'executed'
          AND action.payload ->> 'query' = 'Northstar Remittance LLC California money transmitter license'
          AND action.payload -> 'allowed_domains' = '["dfpi.ca.gov"]'::jsonb
          AND action.payload ->> 'max_results' = '5'
          AND execution.status = 'succeeded'
          AND execution.research_status = 'pending'
          AND result_review.status = 'pending'
          AND EXISTS (
            SELECT 1 FROM web_result_review_items item
            WHERE item.review_id = result_review.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM web_result_review_items item
            WHERE item.review_id = result_review.id
              AND item.review_state <> 'pending_review'
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM citations
        WHERE analysis_run_id = unsupported_run AND source_kind = 'external_web'
      )
    )
  ) THEN
    RAISE EXCEPTION 'web research must remain at an exact-scope analyst gate';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM analysis_runs run
    WHERE run.id = failure_run AND run.status = 'failed'
  ) OR NOT EXISTS (
    SELECT 1
    FROM onboarding_cases onboarding_case
    JOIN analysis_runs active_run ON active_run.id = onboarding_case.active_analysis_run_id
    WHERE onboarding_case.id = '30000000-0000-0000-0000-000000000004'
      AND (
        (active_run.id = failure_run
          AND active_run.status = 'failed'
          AND onboarding_case.status = 'attention_required')
        OR
        (active_run.retry_of_analysis_run_id = failure_run
          AND active_run.status = 'succeeded'
          AND onboarding_case.status = 'ready_for_review')
      )
  ) THEN
    RAISE EXCEPTION 'required specialist failure or its linked retry state is invalid';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM a2a_tasks
    WHERE analysis_run_id = failure_run AND specialty = 'policy'
      AND status = 'failed' AND attempts = 2
      AND error_code = 'specialist_retry_exhausted'
  ) OR (SELECT count(*) FROM specialist_artifacts WHERE analysis_run_id = failure_run) <> 2
    OR EXISTS (
      SELECT 1 FROM specialist_artifacts
      WHERE analysis_run_id = failure_run AND specialty = 'policy'
    )
  THEN
    RAISE EXCEPTION 'agent-failure retry trace or partial-artifact preservation is invalid';
  END IF;

  IF EXISTS (
    SELECT 1 FROM a2a_tasks task
    JOIN analysis_runs run ON run.id = task.analysis_run_id
    WHERE task.correlation_id <> run.session_id
      AND run.session_id LIKE 'step10:%:v1'
  ) THEN
    RAISE EXCEPTION 'a specialist task escaped its owning Step 10 correlation scope';
  END IF;
  IF EXISTS (
    SELECT 1 FROM findings finding
    JOIN analysis_runs run ON run.id = finding.analysis_run_id
    JOIN onboarding_cases onboarding_case ON onboarding_case.active_analysis_run_id = run.id
    WHERE run.session_id LIKE 'step10:%:v1'
      AND run.case_id <> onboarding_case.id
  ) THEN
    RAISE EXCEPTION 'a persisted finding escaped its owning case';
  END IF;
  IF EXISTS (
    SELECT run.id FROM analysis_runs run
    WHERE run.session_id LIKE 'step10:%:v1'
      AND NOT EXISTS (
        SELECT 1 FROM audit_events audit WHERE audit.analysis_run_id = run.id
      )
  ) THEN
    RAISE EXCEPTION 'every Step 10 run must have an audit trail';
  END IF;
END;
$$;

ROLLBACK;
