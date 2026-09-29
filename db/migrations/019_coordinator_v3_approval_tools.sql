BEGIN;

CREATE TABLE IF NOT EXISTS coordinator_v3_search_candidates (
  id uuid PRIMARY KEY,
  analysis_run_id uuid NOT NULL REFERENCES analysis_runs(id),
  case_id uuid NOT NULL REFERENCES onboarding_cases(id),
  langflow_job_id text NOT NULL,
  search_execution_id uuid NOT NULL,
  rank integer NOT NULL CHECK (rank BETWEEN 1 AND 10),
  url text NOT NULL CHECK (url ~ '^https://'),
  canonical_url text NOT NULL CHECK (canonical_url ~ '^https://'),
  title text NOT NULL,
  site_name text NOT NULL,
  snippet text NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (search_execution_id, analysis_run_id, case_id)
    REFERENCES web_search_executions(id, analysis_run_id, case_id),
  UNIQUE (search_execution_id, rank),
  UNIQUE (search_execution_id, canonical_url),
  FOREIGN KEY (analysis_run_id, case_id) REFERENCES analysis_runs(id, case_id)
);

CREATE TRIGGER immutable_coordinator_v3_search_candidates
BEFORE UPDATE OR DELETE ON coordinator_v3_search_candidates
FOR EACH ROW EXECUTE FUNCTION reject_snapshot_row_mutation();

COMMIT;
