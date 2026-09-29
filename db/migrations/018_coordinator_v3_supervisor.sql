BEGIN;

ALTER TABLE coordinator_v3_runs
  DROP CONSTRAINT IF EXISTS coordinator_v3_runs_scenario_check;
ALTER TABLE coordinator_v3_runs
  ALTER COLUMN scenario SET DEFAULT 'supervisor';

CREATE TABLE IF NOT EXISTS coordinator_v3_reconciliation_events (
  id bigserial PRIMARY KEY,
  analysis_run_id uuid NOT NULL REFERENCES analysis_runs(id),
  case_id uuid NOT NULL REFERENCES onboarding_cases(id),
  langflow_job_id text NOT NULL,
  iteration integer NOT NULL CHECK (iteration BETWEEN 0 AND 12),
  event_type text NOT NULL,
  requesting_specialty text CHECK (
    requesting_specialty IS NULL OR requesting_specialty IN ('entity', 'ownership', 'policy', 'public_research')
  ),
  task_id text,
  checkpoint_id text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (langflow_job_id, event_type, payload_hash)
);

CREATE INDEX IF NOT EXISTS coordinator_v3_reconciliation_events_job_time
  ON coordinator_v3_reconciliation_events (langflow_job_id, occurred_at);

COMMIT;
