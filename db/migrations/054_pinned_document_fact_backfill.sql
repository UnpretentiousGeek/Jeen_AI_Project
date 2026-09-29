BEGIN;

CREATE OR REPLACE FUNCTION protect_pinned_document()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_document_id uuid := COALESCE(OLD.id, NEW.id);
BEGIN
  IF TG_OP = 'DELETE' AND case_purge_row_is_scoped(to_jsonb(OLD), TG_RELID) THEN
    RETURN OLD;
  END IF;
  IF EXISTS (
    SELECT 1 FROM analysis_run_documents snapshot
    WHERE snapshot.document_id = target_document_id
  ) THEN
    IF TG_OP = 'UPDATE'
      AND (to_jsonb(NEW) - 'source_metadata') = (to_jsonb(OLD) - 'source_metadata')
      AND (NEW.source_metadata - 'fact_extraction') =
          (OLD.source_metadata - 'fact_extraction')
      AND NEW.source_metadata ? 'fact_extraction'
    THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'pinned document % is immutable', target_document_id;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

COMMIT;
