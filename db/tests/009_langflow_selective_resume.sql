\set ON_ERROR_STOP on

DO $$
DECLARE
  resumed analysis_runs%ROWTYPE;
  request human_input_requests%ROWTYPE;
  current_ownership_finding findings%ROWTYPE;
BEGIN
  SELECT run.* INTO resumed
  FROM onboarding_cases onboarding_case
  JOIN analysis_runs run ON run.id = onboarding_case.active_analysis_run_id
  WHERE onboarding_case.reference = 'KYB-LF-003'
    AND onboarding_case.status = 'ready_for_review';

  IF resumed.id IS NULL
    OR resumed.status <> 'succeeded'
    OR resumed.finished_at IS NULL
    OR resumed.langflow_job_id IS NULL
    OR resumed.checkpoint_id IS NULL THEN
    RAISE EXCEPTION 'selectively resumed Langflow run did not finish with its checkpoint identity';
  END IF;

  SELECT input_request.* INTO request
  FROM human_input_requests input_request
  WHERE input_request.analysis_run_id = resumed.id
  ORDER BY input_request.created_at DESC
  LIMIT 1;

  IF request.status <> 'answered'
    OR request.replacement_task_id IS NULL
    OR request.response ->> 'value' <> 'Northbridge Nominees Ltd holds the remaining 18%.' THEN
    RAISE EXCEPTION 'ownership clarification is not linked to its replacement task';
  END IF;

  IF (SELECT count(*) FROM a2a_tasks WHERE analysis_run_id = resumed.id) <> 4
    OR (SELECT count(*) FROM a2a_tasks WHERE analysis_run_id = resumed.id AND specialty = 'ownership') <> 2
    OR (SELECT count(*) FROM a2a_tasks WHERE analysis_run_id = resumed.id AND specialty = 'entity') <> 1
    OR (SELECT count(*) FROM a2a_tasks WHERE analysis_run_id = resumed.id AND specialty = 'policy') <> 1 THEN
    RAISE EXCEPTION 'selective resume did not rerun ownership alone';
  END IF;

  SELECT finding.* INTO current_ownership_finding
  FROM findings finding
  WHERE finding.analysis_run_id = resumed.id
    AND finding.requirement_code = 'KYB-1.2'
  ORDER BY finding.created_at DESC, finding.id DESC
  LIMIT 1;

  IF current_ownership_finding.outcome <> 'met'
    OR current_ownership_finding.summary NOT LIKE 'Declared ownership totals 100%.%' THEN
    RAISE EXCEPTION 'reconsolidated ownership finding is not satisfied';
  END IF;

  IF EXISTS (SELECT 1 FROM evidence_gaps WHERE analysis_run_id = resumed.id)
    OR EXISTS (SELECT 1 FROM conflicts WHERE analysis_run_id = resumed.id) THEN
    RAISE EXCEPTION 'resolved ownership run retained an active gap or conflict';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM citations citation
    WHERE citation.finding_id = current_ownership_finding.id
      AND citation.source_kind = 'human_input'
      AND citation.human_input_request_id = request.id
  ) THEN
    RAISE EXCEPTION 'analyst clarification is not cited by the final ownership finding';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM audit_events event
    WHERE event.analysis_run_id = resumed.id
      AND event.event_type = 'workflow.clarification_resume.completed'
      AND event.payload ->> 'replacement_task_id' = request.replacement_task_id
      AND event.payload -> 'reused_specialties' = '["entity", "policy"]'::jsonb
  ) THEN
    RAISE EXCEPTION 'selective resume completion audit is missing';
  END IF;

  IF EXISTS (
    SELECT 1 FROM web_search_executions execution
    WHERE execution.analysis_run_id = resumed.id
  ) THEN
    RAISE EXCEPTION 'ownership clarification unexpectedly executed web search';
  END IF;
END;
$$;

SELECT 'Langflow selective ownership resume verification passed' AS result;
