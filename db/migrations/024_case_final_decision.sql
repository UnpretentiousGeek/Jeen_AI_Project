BEGIN;

-- Preserve the exact case/run pairing used by a final human decision.
ALTER TABLE onboarding_cases
  ADD CONSTRAINT onboarding_cases_active_run_pair_unique
  UNIQUE (id, active_analysis_run_id);

CREATE TABLE case_final_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL,
  analysis_run_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  actor text NOT NULL CHECK (btrim(actor) <> ''),
  rationale text NOT NULL CHECK (btrim(rationale) <> ''),
  idempotency_key text NOT NULL CHECK (btrim(idempotency_key) <> ''),
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (case_id),
  UNIQUE (idempotency_key),
  FOREIGN KEY (case_id, analysis_run_id)
    REFERENCES onboarding_cases(id, active_analysis_run_id),
  FOREIGN KEY (analysis_run_id, case_id)
    REFERENCES analysis_runs(id, case_id)
);

CREATE OR REPLACE FUNCTION reject_case_final_decision_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'case final decisions are immutable' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER case_final_decisions_immutable
BEFORE UPDATE OR DELETE ON case_final_decisions
FOR EACH ROW EXECUTE FUNCTION reject_case_final_decision_mutation();

CREATE OR REPLACE FUNCTION record_case_final_decision(
  case_uuid uuid,
  analysis_run_uuid uuid,
  decision_text text,
  actor_text text,
  rationale_text text,
  idempotency_key_text text
)
RETURNS case_final_decisions
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  selected_case onboarding_cases%ROWTYPE;
  existing_decision case_final_decisions%ROWTYPE;
  recorded_decision case_final_decisions%ROWTYPE;
BEGIN
  IF decision_text NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'decision must be approved or rejected' USING ERRCODE = '22023';
  END IF;
  IF actor_text IS NULL OR btrim(actor_text) = ''
     OR rationale_text IS NULL OR btrim(rationale_text) = ''
     OR idempotency_key_text IS NULL OR btrim(idempotency_key_text) = '' THEN
    RAISE EXCEPTION 'actor, rationale, and idempotency key are required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO selected_case
  FROM onboarding_cases
  WHERE id = case_uuid
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'case % does not exist', case_uuid USING ERRCODE = '23503';
  END IF;

  SELECT * INTO existing_decision
  FROM case_final_decisions
  WHERE case_id = case_uuid OR idempotency_key = idempotency_key_text;
  IF FOUND THEN
    IF existing_decision.case_id = case_uuid
       AND existing_decision.analysis_run_id = analysis_run_uuid
       AND existing_decision.decision = decision_text
       AND existing_decision.actor = actor_text
       AND existing_decision.rationale = rationale_text
       AND existing_decision.idempotency_key = idempotency_key_text THEN
      RETURN existing_decision;
    END IF;
    RAISE EXCEPTION 'conflicting final decision or idempotency replay' USING ERRCODE = '23P01';
  END IF;

  IF selected_case.status <> 'ready_for_review'
     OR selected_case.active_analysis_run_id IS DISTINCT FROM analysis_run_uuid THEN
    RAISE EXCEPTION 'case is not ready for this active analysis run' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM analysis_runs run
    WHERE run.id = analysis_run_uuid
      AND run.case_id = case_uuid
      AND run.status = 'succeeded'
  ) THEN
    RAISE EXCEPTION 'analysis run must have succeeded for this case' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM coordinator_v3_runs coordinator
    WHERE coordinator.analysis_run_id = analysis_run_uuid
      AND coordinator.case_id = case_uuid
      AND coordinator.engine_version = 'durable-loop-v1'
      AND coordinator.phase = 'ready_for_review'
  ) OR EXISTS (
    SELECT 1
    FROM coordinator_v3_checkpoints checkpoint
    JOIN coordinator_v3_runs coordinator
      ON coordinator.analysis_run_id = checkpoint.analysis_run_id
     AND coordinator.case_id = checkpoint.case_id
     AND coordinator.langflow_job_id = checkpoint.langflow_job_id
    WHERE checkpoint.analysis_run_id = analysis_run_uuid
      AND checkpoint.case_id = case_uuid
      AND coordinator.engine_version = 'durable-loop-v1'
      AND checkpoint.status = 'pending'
  ) THEN
    RAISE EXCEPTION 'durable coordinator is not ready for final review' USING ERRCODE = '55000';
  END IF;

  BEGIN
    INSERT INTO case_final_decisions (
      case_id, analysis_run_id, decision, actor, rationale, idempotency_key
    ) VALUES (
      case_uuid, analysis_run_uuid, decision_text, actor_text,
      rationale_text, idempotency_key_text
    ) RETURNING * INTO recorded_decision;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'conflicting final decision or idempotency replay' USING ERRCODE = '23P01';
  END;

  UPDATE onboarding_cases
  SET status = 'completed', updated_at = clock_timestamp()
  WHERE id = case_uuid;

  INSERT INTO audit_events (
    case_id, analysis_run_id, event_type, actor_type, actor_id, payload
  ) VALUES (
    case_uuid, analysis_run_uuid, 'case.final_decision_recorded', 'analyst', actor_text,
    jsonb_build_object(
      'decision_id', recorded_decision.id,
      'decision', decision_text,
      'rationale', rationale_text,
      'idempotency_key', idempotency_key_text
    )
  );

  RETURN recorded_decision;
END;
$$;

COMMIT;
