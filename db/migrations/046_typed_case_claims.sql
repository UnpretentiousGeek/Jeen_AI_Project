BEGIN;

CREATE TABLE case_entity_attributes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL,
  document_id uuid NOT NULL,
  chunk_id uuid NOT NULL REFERENCES document_chunks(id) ON DELETE CASCADE,
  model text NOT NULL CHECK (length(btrim(model)) BETWEEN 1 AND 120),
  field text NOT NULL CHECK (field IN ('legal_name','identifier','jurisdiction','address')),
  address_type text CHECK (address_type IN ('registered','operating','mailing')),
  identifier_type text,
  identifier_jurisdiction text,
  value text NOT NULL CHECK (length(btrim(value)) BETWEEN 1 AND 2000),
  excerpt text NOT NULL CHECK (length(btrim(excerpt)) BETWEEN 8 AND 4000),
  observed_at text,
  claim_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (document_id, case_id) REFERENCES case_documents(id, case_id) ON DELETE CASCADE,
  UNIQUE (document_id, chunk_id, claim_hash),
  CHECK ((field = 'address' AND address_type IS NOT NULL AND identifier_type IS NULL
          AND identifier_jurisdiction IS NULL)
    OR (field = 'identifier' AND address_type IS NULL
          AND identifier_type IS NOT NULL
          AND length(btrim(identifier_type)) BETWEEN 1 AND 80)
    OR (field IN ('legal_name','jurisdiction') AND address_type IS NULL
          AND identifier_type IS NULL AND identifier_jurisdiction IS NULL))
);

CREATE TABLE case_ownership_edges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL,
  document_id uuid NOT NULL,
  chunk_id uuid NOT NULL REFERENCES document_chunks(id) ON DELETE CASCADE,
  model text NOT NULL CHECK (length(btrim(model)) BETWEEN 1 AND 120),
  owner text NOT NULL CHECK (length(btrim(owner)) BETWEEN 1 AND 300),
  owner_type text NOT NULL CHECK (owner_type IN ('person','entity')),
  owned text NOT NULL CHECK (length(btrim(owned)) BETWEEN 1 AND 300),
  percentage numeric(7,4) NOT NULL CHECK (percentage BETWEEN 0 AND 100),
  excerpt text NOT NULL CHECK (length(btrim(excerpt)) BETWEEN 8 AND 4000),
  claim_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (document_id, case_id) REFERENCES case_documents(id, case_id) ON DELETE CASCADE,
  UNIQUE (document_id, chunk_id, claim_hash)
);

CREATE INDEX case_entity_attributes_case_document_idx
  ON case_entity_attributes (case_id, document_id, created_at);
CREATE INDEX case_ownership_edges_case_document_idx
  ON case_ownership_edges (case_id, document_id, created_at);

CREATE OR REPLACE FUNCTION validate_typed_case_claim()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE source_text text;
BEGIN
  SELECT chunk.content INTO source_text
  FROM document_chunks chunk
  JOIN case_documents document
    ON document.id=chunk.document_id AND document.case_id=chunk.case_id
  WHERE chunk.id=NEW.chunk_id AND chunk.document_id=NEW.document_id
    AND chunk.case_id=NEW.case_id AND document.ingestion_status='ready';
  IF source_text IS NULL OR strpos(source_text, NEW.excerpt)=0 THEN
    RAISE EXCEPTION 'typed claim must quote a ready document chunk in the same case'
      USING ERRCODE='23514';
  END IF;
  NEW.claim_hash := md5((to_jsonb(NEW)-'id'-'created_at'-'claim_hash'-'model')::text);
  RETURN NEW;
END;
$$;

CREATE TRIGGER case_entity_attribute_source_guard
BEFORE INSERT ON case_entity_attributes
FOR EACH ROW EXECUTE FUNCTION validate_typed_case_claim();
CREATE TRIGGER case_ownership_edge_source_guard
BEFORE INSERT ON case_ownership_edges
FOR EACH ROW EXECUTE FUNCTION validate_typed_case_claim();

COMMIT;
