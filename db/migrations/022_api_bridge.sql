BEGIN;

-- The API records Langflow launches for observability only. Workflow ownership,
-- coordinator state, checkpoint decisions, and replay protection remain in the
-- existing analysis/coordinator tables and functions.
CREATE TABLE IF NOT EXISTS api_langflow_invocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES onboarding_cases(id),
  analysis_run_id uuid REFERENCES analysis_runs(id),
  evidence_submission_id uuid REFERENCES evidence_submissions(id),
  purpose text NOT NULL CHECK (purpose IN ('evidence_ingestion', 'analysis_start', 'analysis_resume')),
  flow_id text NOT NULL,
  job_id text NOT NULL UNIQUE,
  session_id text NOT NULL,
  status text NOT NULL CHECK (status IN (
    'queued', 'in_progress', 'suspended', 'completed', 'failed',
    'cancelled', 'timed_out'
  )),
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (analysis_run_id, case_id) REFERENCES analysis_runs(id, case_id),
  CONSTRAINT api_langflow_invocations_target_check CHECK (
    (purpose = 'evidence_ingestion' AND analysis_run_id IS NULL)
    OR (purpose IN ('analysis_start', 'analysis_resume') AND analysis_run_id IS NOT NULL)
  )
);

-- Replace the unnamed constraint created by the first local Phase 3 draft.
ALTER TABLE api_langflow_invocations
  DROP CONSTRAINT IF EXISTS api_langflow_invocations_check;
ALTER TABLE api_langflow_invocations
  DROP CONSTRAINT IF EXISTS api_langflow_invocations_target_check;
ALTER TABLE api_langflow_invocations
  ADD CONSTRAINT api_langflow_invocations_target_check CHECK (
    (purpose = 'evidence_ingestion' AND analysis_run_id IS NULL)
    OR (purpose IN ('analysis_start', 'analysis_resume') AND analysis_run_id IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS api_langflow_invocations_run_created_idx
  ON api_langflow_invocations (analysis_run_id, created_at DESC)
  WHERE analysis_run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS api_langflow_invocations_case_created_idx
  ON api_langflow_invocations (case_id, created_at DESC);

COMMIT;
