BEGIN;

-- Record each answer to a structured identity/ownership question as an answered human input,
-- so final findings can cite what the analyst said and the case view can show it next to the
-- evidence. The decision row stays the source of truth; these rows are derived from it.
CREATE OR REPLACE FUNCTION record_structured_information_answers(decision coordinator_v3_human_decisions)
RETURNS void LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  checkpoint coordinator_v3_checkpoints;
  item jsonb;
BEGIN
  IF decision.decision <> 'submit_clarification' THEN RETURN; END IF;
  SELECT candidate.* INTO checkpoint
  FROM coordinator_v3_checkpoints candidate
  JOIN coordinator_v3_runs coordinator
    ON coordinator.analysis_run_id = candidate.analysis_run_id
  WHERE coordinator.id = decision.run_id AND candidate.request_id = decision.request_id
    AND candidate.checkpoint_kind = 'information_request';
  IF checkpoint.id IS NULL
     OR jsonb_typeof(checkpoint.request_payload->'payload'->'questions') IS DISTINCT FROM 'array' THEN
    RETURN;
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(checkpoint.request_payload->'payload'->'questions') LOOP
    CONTINUE WHEN NULLIF(btrim(decision.values->'answers'->>(item->>'id')), '') IS NULL;
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM human_input_requests existing
      WHERE existing.checkpoint_id = checkpoint.id::text
        AND existing.correlation_id = item->>'id'
    );
    INSERT INTO human_input_requests (
      analysis_run_id, request_type, question, reason, input_type, allowed_choices,
      status, response, responded_at, checkpoint_id, correlation_id, submitted_by
    ) VALUES (
      checkpoint.analysis_run_id, 'clarification', item->>'question',
      COALESCE(NULLIF(checkpoint.request_payload->>'title', ''), 'Identity and ownership evidence gap'),
      CASE WHEN jsonb_array_length(COALESCE(item->'choices', '[]'::jsonb)) > 0 THEN 'choice' ELSE 'text' END,
      CASE WHEN jsonb_array_length(COALESCE(item->'choices', '[]'::jsonb)) > 0 THEN item->'choices' END,
      'answered',
      jsonb_strip_nulls(jsonb_build_object(
        'question_id', item->>'id',
        'specialty', item->>'specialty',
        'field', item->>'field',
        'subject', item->>'subject',
        'answer', btrim(decision.values->'answers'->>(item->>'id'))
      )),
      decision.applied_at, checkpoint.id::text, item->>'id', decision.actor_id
    );
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION record_structured_information_answers_trigger()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  PERFORM record_structured_information_answers(NEW);
  RETURN NULL;
END;
$$;

CREATE TRIGGER structured_information_answers_record
AFTER INSERT ON coordinator_v3_human_decisions
FOR EACH ROW EXECUTE FUNCTION record_structured_information_answers_trigger();

-- Answers submitted before this migration.
SELECT record_structured_information_answers(submitted)
FROM coordinator_v3_human_decisions submitted
WHERE submitted.decision = 'submit_clarification';

COMMIT;
