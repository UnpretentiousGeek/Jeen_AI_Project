BEGIN;

CREATE OR REPLACE FUNCTION validate_structured_information_checkpoint()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  questions jsonb := NEW.request_payload->'payload'->'questions';
  question jsonb;
  question_id text;
BEGIN
  IF NEW.checkpoint_kind <> 'information_request' OR questions IS NULL THEN
    RETURN NEW;
  END IF;
  IF jsonb_typeof(questions) <> 'array' OR jsonb_array_length(questions) = 0 THEN
    RAISE EXCEPTION 'structured information request requires questions' USING ERRCODE='22023';
  END IF;
  FOR question IN SELECT value FROM jsonb_array_elements(questions) LOOP
    question_id := question->>'id';
    IF jsonb_typeof(question) <> 'object'
       OR NULLIF(trim(question_id), '') IS NULL
       OR question->>'specialty' NOT IN ('entity', 'ownership')
       OR NULLIF(trim(question->>'field'), '') IS NULL
       OR NULLIF(trim(question->>'question'), '') IS NULL
       OR (SELECT count(*) FROM jsonb_array_elements(questions) item
           WHERE item->>'id' = question_id) <> 1 THEN
      RAISE EXCEPTION 'structured information question is invalid' USING ERRCODE='22023';
    END IF;
    IF EXISTS (
      SELECT 1 FROM coordinator_v3_human_decisions decision
      JOIN coordinator_v3_runs coordinator ON coordinator.id = decision.run_id
      WHERE coordinator.analysis_run_id = NEW.analysis_run_id
        AND decision.decision = 'submit_clarification'
        AND decision.values->'answers' ? question_id
    ) THEN
      RAISE EXCEPTION 'answered information question cannot be requested again' USING ERRCODE='23P01';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE TRIGGER structured_information_checkpoint_guard
BEFORE INSERT ON coordinator_v3_checkpoints
FOR EACH ROW EXECUTE FUNCTION validate_structured_information_checkpoint();

CREATE OR REPLACE FUNCTION validate_structured_information_answers()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  questions jsonb;
  answers jsonb := NEW.values->'answers';
  question jsonb;
BEGIN
  IF NEW.decision <> 'submit_clarification' THEN RETURN NEW; END IF;
  SELECT checkpoint.request_payload->'payload'->'questions' INTO questions
  FROM coordinator_v3_checkpoints checkpoint
  JOIN coordinator_v3_runs coordinator
    ON coordinator.analysis_run_id = checkpoint.analysis_run_id
  WHERE coordinator.id = NEW.run_id AND checkpoint.request_id = NEW.request_id
    AND checkpoint.checkpoint_kind = 'information_request';
  IF questions IS NULL THEN RETURN NEW; END IF;
  IF jsonb_typeof(answers) <> 'object'
     OR (SELECT count(*) FROM jsonb_object_keys(answers)) <> jsonb_array_length(questions) THEN
    RAISE EXCEPTION 'every information question requires one answer' USING ERRCODE='22023';
  END IF;
  FOR question IN SELECT value FROM jsonb_array_elements(questions) LOOP
    IF jsonb_typeof(answers->(question->>'id')) <> 'string'
       OR NULLIF(trim(answers->>(question->>'id')), '') IS NULL THEN
      RAISE EXCEPTION 'every information question requires one answer' USING ERRCODE='22023';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE TRIGGER structured_information_answers_guard
BEFORE INSERT ON coordinator_v3_human_decisions
FOR EACH ROW EXECUTE FUNCTION validate_structured_information_answers();

COMMIT;
