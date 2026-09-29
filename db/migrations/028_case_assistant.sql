BEGIN;

CREATE TABLE case_assistant_conversations (
  case_id uuid PRIMARY KEY REFERENCES onboarding_cases(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE case_assistant_turns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES case_assistant_conversations(case_id),
  actor_id text NOT NULL CHECK (length(trim(actor_id)) > 0),
  idempotency_key text NOT NULL CHECK (length(trim(idempotency_key)) >= 8),
  question text NOT NULL CHECK (length(trim(question)) > 0),
  answer text,
  analysis_run_id uuid,
  source_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(source_refs) = 'array'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
  claim_token uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (case_id, idempotency_key),
  FOREIGN KEY (analysis_run_id, case_id) REFERENCES analysis_runs(id, case_id),
  CHECK ((status = 'completed') = (answer IS NOT NULL AND length(trim(answer)) > 0))
);

CREATE UNIQUE INDEX one_pending_case_assistant_turn_idx
  ON case_assistant_turns (case_id) WHERE status = 'pending';

CREATE INDEX case_assistant_turns_case_created_idx
  ON case_assistant_turns (case_id, created_at, id);

COMMIT;
