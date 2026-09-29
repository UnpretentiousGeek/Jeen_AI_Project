BEGIN;

CREATE TABLE IF NOT EXISTS coordinator_v3_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_run_id uuid NOT NULL REFERENCES analysis_runs(id),
  case_id uuid NOT NULL REFERENCES onboarding_cases(id),
  langflow_job_id text NOT NULL UNIQUE,
  session_id text NOT NULL UNIQUE,
  scenario text NOT NULL CHECK (scenario IN (
    'complete', 'interrupted', 'conflict', 'required_failure', 'public_research'
  )),
  route text,
  state jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (analysis_run_id, langflow_job_id),
  FOREIGN KEY (analysis_run_id, case_id) REFERENCES analysis_runs(id, case_id)
);

CREATE TABLE IF NOT EXISTS coordinator_v3_task_events (
  id bigserial PRIMARY KEY,
  analysis_run_id uuid NOT NULL REFERENCES analysis_runs(id),
  langflow_job_id text NOT NULL,
  specialty text NOT NULL CHECK (specialty IN ('entity', 'ownership', 'policy', 'public_research')),
  task_id text NOT NULL,
  context_id text NOT NULL,
  attempt integer NOT NULL CHECK (attempt BETWEEN 1 AND 3),
  event_type text NOT NULL CHECK (event_type IN ('dispatched', 'completed', 'failed', 'validated', 'preserved')),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (langflow_job_id, task_id, event_type)
);

CREATE TABLE IF NOT EXISTS coordinator_v3_contributions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_run_id uuid NOT NULL REFERENCES analysis_runs(id),
  case_id uuid NOT NULL REFERENCES onboarding_cases(id),
  langflow_job_id text NOT NULL,
  specialty text NOT NULL CHECK (specialty IN ('entity', 'ownership', 'policy', 'public_research')),
  task_id text NOT NULL,
  context_id text NOT NULL,
  agent_name text NOT NULL,
  agent_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('completed', 'partial', 'failed')),
  source_scope jsonb NOT NULL,
  citations jsonb NOT NULL,
  payload jsonb NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  validated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempt integer NOT NULL CHECK (attempt BETWEEN 1 AND 3),
  UNIQUE (langflow_job_id, specialty, attempt),
  UNIQUE (task_id),
  FOREIGN KEY (analysis_run_id, case_id) REFERENCES analysis_runs(id, case_id),
  CHECK (completed_at >= started_at)
);

CREATE TABLE IF NOT EXISTS coordinator_v3_checkpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_run_id uuid NOT NULL REFERENCES analysis_runs(id),
  case_id uuid NOT NULL REFERENCES onboarding_cases(id),
  langflow_job_id text NOT NULL,
  checkpoint_kind text NOT NULL CHECK (checkpoint_kind IN (
    'information_request', 'conflict_review', 'specialist_recovery',
    'search_execution_approval', 'web_result_review', 'analyst_approval'
  )),
  request_id text NOT NULL,
  prompt text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'submitted', 'expired')),
  decision text,
  values jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_at timestamptz,
  UNIQUE (langflow_job_id, checkpoint_kind, request_id),
  FOREIGN KEY (analysis_run_id, case_id) REFERENCES analysis_runs(id, case_id),
  CHECK ((status = 'pending') = (decided_at IS NULL))
);

CREATE TABLE IF NOT EXISTS coordinator_v3_action_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_run_id uuid NOT NULL REFERENCES analysis_runs(id),
  case_id uuid NOT NULL REFERENCES onboarding_cases(id),
  proposed_action_id uuid NOT NULL REFERENCES proposed_actions(id),
  idempotency_key text NOT NULL UNIQUE,
  proposal_hash text NOT NULL CHECK (proposal_hash ~ '^[0-9a-f]{64}$'),
  approval_id uuid NOT NULL REFERENCES approvals(id),
  status text NOT NULL CHECK (status IN ('executed', 'rejected')),
  result jsonb NOT NULL,
  executed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (analysis_run_id, proposed_action_id),
  FOREIGN KEY (analysis_run_id, case_id) REFERENCES analysis_runs(id, case_id)
);

CREATE TRIGGER immutable_coordinator_v3_contributions
BEFORE UPDATE OR DELETE ON coordinator_v3_contributions
FOR EACH ROW EXECUTE FUNCTION reject_snapshot_row_mutation();

CREATE TRIGGER immutable_coordinator_v3_action_results
BEFORE UPDATE OR DELETE ON coordinator_v3_action_results
FOR EACH ROW EXECUTE FUNCTION reject_snapshot_row_mutation();

COMMIT;
