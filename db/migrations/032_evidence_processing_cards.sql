BEGIN;

ALTER TABLE api_langflow_invocations
  ADD COLUMN IF NOT EXISTS evidence_original_filename text,
  ADD COLUMN IF NOT EXISTS evidence_document_type text;

COMMIT;
