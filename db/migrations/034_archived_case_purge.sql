BEGIN;

-- Deleting a case owns and removes every row reachable through its case data
-- foreign keys. Ancestor rows such as applications and applicants are cleaned
-- up separately by the API so shared applicant records remain intact.
DO $$
DECLARE
  selected_constraint record;
BEGIN
  FOR selected_constraint IN
    WITH RECURSIVE case_owned_tables(table_id) AS (
      SELECT 'public.onboarding_cases'::regclass::oid
      UNION
      SELECT constraint_row.conrelid
      FROM pg_constraint constraint_row
      JOIN case_owned_tables parent_table ON parent_table.table_id = constraint_row.confrelid
      WHERE constraint_row.contype = 'f'
    )
    SELECT child_table.table_id::regclass AS child_table,
           constraint_row.conname,
           pg_get_constraintdef(constraint_row.oid) AS definition
    FROM pg_constraint constraint_row
    JOIN case_owned_tables child_table ON child_table.table_id = constraint_row.conrelid
    JOIN case_owned_tables parent_table ON parent_table.table_id = constraint_row.confrelid
    WHERE constraint_row.contype = 'f'
      AND constraint_row.conrelid <> 'public.onboarding_cases'::regclass
      AND constraint_row.confdeltype = 'a'
    ORDER BY child_table.table_id::regclass::text, constraint_row.conname
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', selected_constraint.child_table,
      selected_constraint.conname);
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s ON DELETE CASCADE',
      selected_constraint.child_table, selected_constraint.conname, selected_constraint.definition);
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION case_purge_row_is_scoped(p_row jsonb, p_table oid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  purge_case_id text := current_setting('jeen.case_purge_id', true);
  analysis_run_ids jsonb;
  coordinator_run_ids jsonb;
BEGIN
  IF purge_case_id IS NULL OR purge_case_id = '' THEN
    RETURN false;
  END IF;

  IF p_row ? 'case_id' AND p_row ->> 'case_id' = purge_case_id THEN
    RETURN true;
  END IF;

  IF p_row ? 'analysis_run_id' THEN
    analysis_run_ids := NULLIF(current_setting('jeen.case_purge_analysis_run_ids', true), '')::jsonb;
    IF analysis_run_ids @> jsonb_build_array(p_row ->> 'analysis_run_id') THEN
      RETURN true;
    END IF;
  END IF;

  IF p_table = 'public.coordinator_v3_human_decisions'::regclass::oid
    AND p_row ? 'run_id' THEN
    coordinator_run_ids := NULLIF(current_setting('jeen.case_purge_coordinator_run_ids', true), '')::jsonb;
    IF coordinator_run_ids @> jsonb_build_array(p_row ->> 'run_id') THEN
      RETURN true;
    END IF;
  END IF;

  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION reject_snapshot_row_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND case_purge_row_is_scoped(to_jsonb(OLD), TG_RELID) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME;
END;
$$;

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
    SELECT 1
    FROM analysis_run_documents snapshot
    WHERE snapshot.document_id = target_document_id
  ) THEN
    RAISE EXCEPTION 'pinned document % is immutable', target_document_id;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION protect_pinned_document_chunk()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  previous_document_id uuid := CASE WHEN TG_OP <> 'INSERT' THEN OLD.document_id END;
  next_document_id uuid := CASE WHEN TG_OP <> 'DELETE' THEN NEW.document_id END;
BEGIN
  IF TG_OP = 'DELETE' AND case_purge_row_is_scoped(to_jsonb(OLD), TG_RELID) THEN
    RETURN OLD;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM analysis_run_documents snapshot
    WHERE snapshot.document_id IN (previous_document_id, next_document_id)
  ) THEN
    RAISE EXCEPTION 'chunks for a pinned document are immutable';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION reject_case_final_decision_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND case_purge_row_is_scoped(to_jsonb(OLD), TG_RELID) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'case final decisions are immutable' USING ERRCODE = '55000';
END;
$$;

CREATE OR REPLACE FUNCTION immutable_coordinator_v3_final_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND case_purge_row_is_scoped(to_jsonb(OLD), TG_RELID) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'coordinator v3 final snapshots are immutable' USING ERRCODE = '55000';
END;
$$;

CREATE OR REPLACE FUNCTION guard_archived_case_purge()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  purge_case_id text := current_setting('jeen.case_purge_id', true);
BEGIN
  IF OLD.archived_at IS NULL OR purge_case_id IS DISTINCT FROM OLD.id::text THEN
    RAISE EXCEPTION 'only the archived case selected for purge may be deleted' USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1 FROM analysis_runs run
    WHERE run.case_id = OLD.id AND run.status IN ('queued', 'running')
  ) OR EXISTS (
    SELECT 1 FROM coordinator_v3_runs run
    WHERE run.case_id = OLD.id AND run.phase = 'running'
  ) THEN
    RAISE EXCEPTION 'an active case cannot be deleted' USING ERRCODE = '55000';
  END IF;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS guard_archived_case_purge_trigger ON onboarding_cases;
CREATE TRIGGER guard_archived_case_purge_trigger
BEFORE DELETE ON onboarding_cases
FOR EACH ROW EXECUTE FUNCTION guard_archived_case_purge();

COMMIT;
