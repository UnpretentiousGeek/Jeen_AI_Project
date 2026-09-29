BEGIN;

ALTER TABLE onboarding_cases
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_by text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'onboarding_cases_archive_actor_consistency'
  ) THEN
    ALTER TABLE onboarding_cases
      ADD CONSTRAINT onboarding_cases_archive_actor_consistency
      CHECK ((archived_at IS NULL) = (archived_by IS NULL));
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS onboarding_cases_archived_updated_idx
  ON onboarding_cases (archived_at, updated_at DESC, id DESC);

COMMIT;
