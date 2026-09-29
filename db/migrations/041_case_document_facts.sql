BEGIN;

CREATE TABLE case_document_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL,
  document_id uuid NOT NULL,
  chunk_id uuid NOT NULL REFERENCES document_chunks(id) ON DELETE CASCADE,
  model text NOT NULL CHECK (length(btrim(model)) BETWEEN 1 AND 120),
  subject text NOT NULL CHECK (length(btrim(subject)) BETWEEN 1 AND 300),
  predicate text NOT NULL CHECK (length(btrim(predicate)) BETWEEN 1 AND 300),
  value text NOT NULL CHECK (length(btrim(value)) BETWEEN 1 AND 2000),
  excerpt text NOT NULL CHECK (length(btrim(excerpt)) BETWEEN 8 AND 4000),
  fact_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (document_id, case_id) REFERENCES case_documents(id, case_id) ON DELETE CASCADE,
  UNIQUE (document_id, chunk_id, fact_hash)
);

CREATE INDEX case_document_facts_case_document_idx
  ON case_document_facts (case_id, document_id, created_at);

CREATE OR REPLACE FUNCTION validate_case_document_fact()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  source_text text;
BEGIN
  SELECT chunk.content INTO source_text
  FROM document_chunks chunk
  JOIN case_documents document
    ON document.id = chunk.document_id AND document.case_id = chunk.case_id
  WHERE chunk.id = NEW.chunk_id
    AND chunk.document_id = NEW.document_id
    AND chunk.case_id = NEW.case_id
    AND document.ingestion_status = 'ready';
  IF source_text IS NULL OR strpos(source_text, NEW.excerpt) = 0 THEN
    RAISE EXCEPTION 'document fact must quote a ready document chunk in the same case'
      USING ERRCODE = '23514';
  END IF;
  NEW.fact_hash := md5(NEW.subject || chr(31) || NEW.predicate || chr(31)
    || NEW.value || chr(31) || NEW.excerpt);
  RETURN NEW;
END;
$$;

CREATE TRIGGER case_document_fact_source_guard
BEFORE INSERT ON case_document_facts
FOR EACH ROW EXECUTE FUNCTION validate_case_document_fact();

CREATE OR REPLACE FUNCTION save_case_document_facts(
  p_case_id uuid,
  p_document_id uuid,
  p_model text,
  p_facts jsonb
) RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  item jsonb;
  inserted_count integer := 0;
  requested_count integer;
  row_count integer;
BEGIN
  IF NULLIF(btrim(p_model), '') IS NULL OR length(p_model) > 120
    OR jsonb_typeof(p_facts) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'document fact request is invalid' USING ERRCODE = '22023';
  END IF;
  requested_count := jsonb_array_length(p_facts);
  IF requested_count > 100 THEN
    RAISE EXCEPTION 'document fact request exceeds 100 facts' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM case_documents
    WHERE id = p_document_id AND case_id = p_case_id AND ingestion_status = 'ready'
  ) THEN
    RAISE EXCEPTION 'ready document does not belong to this case' USING ERRCODE = '23503';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(p_facts) LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object'
      OR (SELECT count(*) FROM jsonb_object_keys(item)) <> 5
      OR NOT (item ?& ARRAY['chunk_id','subject','predicate','value','excerpt'])
      OR jsonb_typeof(item->'chunk_id') IS DISTINCT FROM 'string'
      OR jsonb_typeof(item->'subject') IS DISTINCT FROM 'string'
      OR jsonb_typeof(item->'predicate') IS DISTINCT FROM 'string'
      OR jsonb_typeof(item->'value') IS DISTINCT FROM 'string'
      OR jsonb_typeof(item->'excerpt') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'document fact shape is invalid' USING ERRCODE = '22023';
    END IF;
    INSERT INTO case_document_facts (
      case_id, document_id, chunk_id, model, subject, predicate, value, excerpt, fact_hash
    ) VALUES (
      p_case_id, p_document_id, (item->>'chunk_id')::uuid, p_model,
      item->>'subject', item->>'predicate', item->>'value', item->>'excerpt', ''
    ) ON CONFLICT (document_id, chunk_id, fact_hash) DO NOTHING;
    GET DIAGNOSTICS row_count = ROW_COUNT;
    inserted_count := inserted_count + row_count;
  END LOOP;
  RETURN jsonb_build_object(
    'case_id', p_case_id, 'document_id', p_document_id,
    'requested_count', requested_count, 'inserted_count', inserted_count,
    'duplicate_count', requested_count - inserted_count
  );
END;
$$;

COMMIT;
