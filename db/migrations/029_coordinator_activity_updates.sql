BEGIN;

-- Display copy is a sidecar to the strict, executable coordinator directive.
-- The directive is still validated by the existing durable-loop function.
CREATE TABLE IF NOT EXISTS coordinator_v3_activity_updates (
  id bigserial PRIMARY KEY,
  run_id uuid NOT NULL,
  analysis_run_id uuid NOT NULL REFERENCES analysis_runs(id),
  iteration_no integer NOT NULL CHECK (iteration_no > 0),
  subject_key text NOT NULL CHECK (subject_key IN (
    'coordinator', 'specialist:entity', 'specialist:ownership',
    'specialist:policy', 'specialist:public_research'
  )),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (run_id, iteration_no) REFERENCES coordinator_v3_iterations(run_id, iteration_no),
  UNIQUE (run_id, iteration_no, subject_key)
);

CREATE INDEX IF NOT EXISTS coordinator_v3_activity_updates_run_order_idx
  ON coordinator_v3_activity_updates(run_id, iteration_no DESC, id DESC);

DROP TRIGGER IF EXISTS immutable_coordinator_v3_activity_updates ON coordinator_v3_activity_updates;
CREATE TRIGGER immutable_coordinator_v3_activity_updates
BEFORE UPDATE OR DELETE ON coordinator_v3_activity_updates
FOR EACH ROW EXECUTE FUNCTION reject_snapshot_row_mutation();

CREATE OR REPLACE FUNCTION commit_simple_coordinator_v3_directive_with_activity(
  p_run_id uuid,
  p_expected_state_version bigint,
  p_output jsonb
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  directive jsonb;
  updates jsonb;
  item jsonb;
  committed jsonb;
  owner_run coordinator_v3_runs%ROWTYPE;
  persisted jsonb;
  subject text;
  iteration_number integer;
BEGIN
  IF jsonb_typeof(p_output) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'coordinator output must be an object' USING ERRCODE = '22023';
  END IF;
  updates := COALESCE(p_output->'activity_updates', '[]'::jsonb);
  IF jsonb_typeof(updates) IS DISTINCT FROM 'array'
     OR jsonb_array_length(updates) > 5 THEN
    RAISE EXCEPTION 'activity_updates must be an array of at most five records' USING ERRCODE = '22023';
  END IF;

  FOR item IN SELECT value FROM jsonb_array_elements(updates) AS entries(value) LOOP
    subject := item->>'subject_key';
    IF jsonb_typeof(item) IS DISTINCT FROM 'object'
       OR subject IS NULL
       OR subject NOT IN (
         'coordinator', 'specialist:entity', 'specialist:ownership',
         'specialist:policy', 'specialist:public_research'
       )
       OR EXISTS (
         SELECT 1 FROM jsonb_object_keys(item) field
         WHERE field <> ALL (ARRAY[
           'subject_key', 'task_id', 'completed_summary', 'current_summary',
           'waiting_for', 'next_summary'
         ])
       )
       OR ((item ? 'task_id') AND (
         jsonb_typeof(item->'task_id') NOT IN ('string', 'null')
         OR (jsonb_typeof(item->'task_id') = 'string'
             AND length(trim(item->>'task_id')) NOT BETWEEN 1 AND 500)
       ))
       OR (subject = 'coordinator' AND jsonb_typeof(item->'task_id') = 'string')
       OR (subject <> 'coordinator'
           AND jsonb_typeof(item->'completed_summary') = 'string'
           AND jsonb_typeof(item->'task_id') IS DISTINCT FROM 'string')
       OR EXISTS (
         SELECT 1 FROM unnest(ARRAY[
           'completed_summary', 'current_summary', 'waiting_for', 'next_summary'
         ]) field
         WHERE (item ? field)
           AND (jsonb_typeof(item->field) NOT IN ('string', 'null')
            OR (jsonb_typeof(item->field) = 'string'
                AND (length(trim(item->>field)) NOT BETWEEN 1 AND 240)))
       )
       OR NOT (item ? 'subject_key')
       OR NOT EXISTS (
         SELECT 1 FROM unnest(ARRAY[
           'completed_summary', 'current_summary', 'waiting_for', 'next_summary'
         ]) field WHERE jsonb_typeof(item->field) = 'string'
       ) THEN
      RAISE EXCEPTION 'activity update shape is invalid' USING ERRCODE = '22023';
    END IF;
    IF subject <> 'coordinator' AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(p_output->'plan', '[]'::jsonb)) AS plan_item(value)
      WHERE plan_item.value->>'specialty' = split_part(subject, ':', 2)
    ) THEN
      RAISE EXCEPTION 'activity update specialist is absent from the plan' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(updates) AS entries(value)
    GROUP BY value->>'subject_key' HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'activity update subjects must be unique per directive' USING ERRCODE = '22023';
  END IF;

  directive := p_output - 'activity_updates';
  committed := commit_simple_coordinator_v3_directive(
    p_run_id,
    p_expected_state_version,
    directive,
    encode(digest(directive::text, 'sha256'), 'hex')
  );
  IF jsonb_array_length(updates) = 0 THEN
    RETURN committed;
  END IF;

  SELECT * INTO owner_run FROM coordinator_v3_runs WHERE id = p_run_id;
  iteration_number := (committed->>'iteration_no')::integer;
  IF iteration_number IS NULL THEN
    RAISE EXCEPTION 'committed directive has no iteration' USING ERRCODE = '55000';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(updates) AS entries(value) LOOP
    subject := item->>'subject_key';
    IF committed->>'status' = 'committed' THEN
      INSERT INTO coordinator_v3_activity_updates(
        run_id, analysis_run_id, iteration_no, subject_key, payload, payload_hash
      ) VALUES (
        p_run_id, owner_run.analysis_run_id, iteration_number, subject, item,
        encode(digest(item::text, 'sha256'), 'hex')
      );
    END IF;
    SELECT payload INTO persisted FROM coordinator_v3_activity_updates
    WHERE run_id = p_run_id AND iteration_no = iteration_number AND subject_key = subject;
    IF persisted IS DISTINCT FROM item THEN
      RAISE EXCEPTION 'activity update replay conflicts with persisted copy' USING ERRCODE = '23P01';
    END IF;
  END LOOP;
  RETURN committed;
END;
$$;

COMMIT;
