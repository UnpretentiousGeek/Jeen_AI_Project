BEGIN;

-- Ownership edges record the date the holding applied, so conflicting percentages for one
-- relationship can be shown with their dates and the latest dated figure suggested.
--   as_of: YYYY-MM-DD as the document states it (an "at" date, a transfer's effective date, or the
--   date of the filing the figure comes from); NULL when the document gives none. Edges extracted
--   before this migration keep NULL.
ALTER TABLE case_ownership_edges
  ADD COLUMN as_of text CHECK (as_of IS NULL OR as_of ~ '^\d{4}-\d{2}-\d{2}$');

COMMIT;
