\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
  applicant_id uuid;
  application_id uuid;
  target_case_id uuid;
  first_turn uuid;
BEGIN
  INSERT INTO applicants (legal_name, jurisdiction, business_type, product)
  VALUES ('Assistant Test Ltd', 'GB', 'software', 'payments')
  RETURNING id INTO applicant_id;
  INSERT INTO applications (applicant_id, submitted_payload)
  VALUES (applicant_id, '{}'::jsonb)
  RETURNING id INTO application_id;
  INSERT INTO onboarding_cases (application_id, applicant_id, reference)
  VALUES (application_id, applicant_id, 'KYB-ASSISTANT-' || left(gen_random_uuid()::text, 8))
  RETURNING id INTO target_case_id;

  INSERT INTO case_assistant_conversations (case_id) VALUES (target_case_id);
  BEGIN
    INSERT INTO case_assistant_conversations (case_id) VALUES (target_case_id);
    RAISE EXCEPTION 'second conversation for the same case was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  INSERT INTO case_assistant_turns (case_id, actor_id, idempotency_key, question)
  VALUES (target_case_id, 'analyst-1', 'question-1', 'What is the status?')
  RETURNING id INTO first_turn;
  BEGIN
    INSERT INTO case_assistant_turns (case_id, actor_id, idempotency_key, question)
    VALUES (target_case_id, 'analyst-1', 'question-2', 'What evidence exists?');
    RAISE EXCEPTION 'second pending turn for the same case was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  UPDATE case_assistant_turns SET status = 'completed', answer = 'The case is a draft.'
  WHERE id = first_turn;
  INSERT INTO case_assistant_turns (case_id, actor_id, idempotency_key, question)
  VALUES (target_case_id, 'analyst-1', 'question-2', 'What evidence exists?');
  IF (SELECT count(*) FROM case_assistant_turns WHERE case_assistant_turns.case_id = target_case_id) <> 2 THEN
    RAISE EXCEPTION 'completed turn did not free the case for a new question';
  END IF;
END;
$$;

ROLLBACK;
