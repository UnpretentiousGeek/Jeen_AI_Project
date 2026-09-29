BEGIN;

-- Entity attributes record which entity they describe, so a parent company's number or
-- address in an ownership document is not reconciled as the applicant's.
--   subject: the entity's name as the document states it; NULL when the document does not name it.
--   describes_document_subject: whether the attribute describes the entity the document is about.
-- Rows extracted before this migration keep NULL in both columns and are still read as the
-- applicant's, because no subject was ever recorded for them.
ALTER TABLE case_entity_attributes
  ADD COLUMN subject text CHECK (subject IS NULL OR length(btrim(subject)) BETWEEN 1 AND 300),
  ADD COLUMN describes_document_subject boolean;

COMMIT;
