BEGIN;

-- Ownership charts often state look-through interests ("A holds 44% of the applicant through
-- B and C") beside the direct holdings they are calculated from. Counting both as direct
-- holdings double-counts ownership. Each edge records which it is:
--   direct: shares the owner holds in the owned entity itself.
--   indirect: a calculated or look-through interest held through intermediate entities.
-- The ownership graph is built from direct edges only; it derives indirect interests itself.
-- Edges extracted before this migration are treated as direct, as they always were.
ALTER TABLE case_ownership_edges
  ADD COLUMN holding text NOT NULL DEFAULT 'direct' CHECK (holding IN ('direct', 'indirect'));

COMMIT;
