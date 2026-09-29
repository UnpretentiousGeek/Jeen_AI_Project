\set ON_ERROR_STOP on

DO $$
DECLARE
  resumed analysis_runs%ROWTYPE;
  ownership_request human_input_requests%ROWTYPE;
  entity_request human_input_requests%ROWTYPE;
  current_entity_finding findings%ROWTYPE;
  current_ownership_finding findings%ROWTYPE;
BEGIN
  SELECT run.* INTO resumed
  FROM analysis_runs run
  JOIN onboarding_cases onboarding_case ON onboarding_case.active_analysis_run_id = run.id
  WHERE onboarding_case.reference = 'KYB-LF-002'
    AND onboarding_case.status = 'ready_for_review';

  IF resumed.id IS NULL OR resumed.status <> 'succeeded' OR resumed.finished_at IS NULL THEN
    RAISE EXCEPTION 'entity-resumed Langflow run did not finish successfully';
  END IF;

  SELECT request.* INTO ownership_request
  FROM human_input_requests request
  JOIN a2a_tasks task ON task.task_id = request.originating_task_id
  WHERE request.analysis_run_id = resumed.id AND task.specialty = 'ownership';

  SELECT request.* INTO entity_request
  FROM human_input_requests request
  JOIN a2a_tasks task ON task.task_id = request.originating_task_id
  WHERE request.analysis_run_id = resumed.id AND task.specialty = 'entity';

  IF ownership_request.status <> 'answered' OR ownership_request.replacement_task_id IS NULL
    OR entity_request.status <> 'answered' OR entity_request.replacement_task_id IS NULL
    OR ownership_request.checkpoint_id = entity_request.checkpoint_id THEN
    RAISE EXCEPTION 'sequential clarification checkpoints were not answered and linked independently';
  END IF;

  IF (SELECT count(*) FROM langflow_checkpoint_intents WHERE analysis_run_id = resumed.id) <> 2
    OR (SELECT count(*) FROM langflow_checkpoint_intents WHERE analysis_run_id = resumed.id AND status = 'attached') <> 2 THEN
    RAISE EXCEPTION 'sequential checkpoint intents were not retained as attached history';
  END IF;

  IF (SELECT count(*) FROM a2a_tasks WHERE analysis_run_id = resumed.id) <> 5
    OR (SELECT count(*) FROM a2a_tasks WHERE analysis_run_id = resumed.id AND specialty = 'ownership') <> 2
    OR (SELECT count(*) FROM a2a_tasks WHERE analysis_run_id = resumed.id AND specialty = 'entity') <> 2
    OR (SELECT count(*) FROM a2a_tasks WHERE analysis_run_id = resumed.id AND specialty = 'policy') <> 1 THEN
    RAISE EXCEPTION 'ownership and entity were not selectively rerun exactly once';
  END IF;

  SELECT finding.* INTO current_ownership_finding
  FROM findings finding
  WHERE finding.analysis_run_id = resumed.id AND finding.requirement_code = 'KYB-1.2'
  ORDER BY finding.created_at DESC, finding.id DESC LIMIT 1;

  SELECT finding.* INTO current_entity_finding
  FROM findings finding
  WHERE finding.analysis_run_id = resumed.id AND finding.requirement_code = 'KYB-1.1'
  ORDER BY finding.created_at DESC, finding.id DESC LIMIT 1;

  IF current_ownership_finding.outcome <> 'met' OR current_entity_finding.outcome <> 'met'
    OR EXISTS (SELECT 1 FROM evidence_gaps WHERE analysis_run_id = resumed.id)
    OR EXISTS (SELECT 1 FROM conflicts WHERE analysis_run_id = resumed.id) THEN
    RAISE EXCEPTION 'sequential resume did not resolve both targeted issues';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM citations citation
    WHERE citation.finding_id = current_ownership_finding.id
      AND citation.source_kind = 'human_input'
      AND citation.human_input_request_id = ownership_request.id
  ) OR NOT EXISTS (
    SELECT 1 FROM citations citation
    WHERE citation.finding_id = current_entity_finding.id
      AND citation.source_kind = 'human_input'
      AND citation.human_input_request_id = entity_request.id
  ) THEN
    RAISE EXCEPTION 'final findings do not cite both analyst statements';
  END IF;

  IF EXISTS (
    SELECT 1 FROM web_search_executions execution
    WHERE execution.analysis_run_id = resumed.id
  ) THEN
    RAISE EXCEPTION 'sequential clarification unexpectedly executed web search';
  END IF;
END;
$$;

SELECT 'Langflow selective entity resume verification passed' AS result;
