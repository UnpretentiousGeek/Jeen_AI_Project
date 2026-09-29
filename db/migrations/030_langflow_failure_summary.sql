BEGIN;

ALTER TABLE api_langflow_invocations
  ADD COLUMN IF NOT EXISTS failure_summary text;

ALTER TABLE api_langflow_invocations
  DROP CONSTRAINT IF EXISTS api_langflow_invocations_failure_summary_length;
ALTER TABLE api_langflow_invocations
  ADD CONSTRAINT api_langflow_invocations_failure_summary_length
  CHECK (failure_summary IS NULL OR length(failure_summary) BETWEEN 1 AND 240);

COMMIT;
