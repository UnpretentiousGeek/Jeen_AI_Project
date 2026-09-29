BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE applicants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name text NOT NULL,
  jurisdiction text NOT NULL,
  business_type text NOT NULL,
  product text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id uuid NOT NULL REFERENCES applicants(id),
  submitted_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, applicant_id)
);

CREATE TABLE onboarding_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL UNIQUE,
  applicant_id uuid NOT NULL,
  reference text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'processing', 'awaiting_information', 'ready_for_review',
    'under_review', 'awaiting_approval', 'enhanced_review', 'completed',
    'attention_required'
  )),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (application_id, applicant_id) REFERENCES applications(id, applicant_id),
  UNIQUE (id, applicant_id)
);

CREATE TABLE evidence_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES onboarding_cases(id),
  submission_number integer NOT NULL CHECK (submission_number > 0),
  submitted_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (case_id, submission_number),
  UNIQUE (id, case_id)
);

CREATE TABLE case_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evidence_submission_id uuid NOT NULL,
  case_id uuid NOT NULL,
  applicant_id uuid NOT NULL REFERENCES applicants(id),
  document_type text NOT NULL,
  original_filename text NOT NULL,
  mime_type text NOT NULL,
  checksum_sha256 text NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  storage_path text NOT NULL,
  ingestion_status text NOT NULL DEFAULT 'pending' CHECK (ingestion_status IN (
    'pending', 'parsing', 'ready', 'failed'
  )),
  parsed_text text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (evidence_submission_id, case_id)
    REFERENCES evidence_submissions(id, case_id),
  FOREIGN KEY (case_id, applicant_id)
    REFERENCES onboarding_cases(id, applicant_id),
  UNIQUE (id, case_id),
  UNIQUE (id, case_id, applicant_id, evidence_submission_id)
);

CREATE TABLE document_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL,
  case_id uuid NOT NULL,
  applicant_id uuid NOT NULL REFERENCES applicants(id),
  evidence_submission_id uuid NOT NULL REFERENCES evidence_submissions(id),
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  content text NOT NULL,
  page_number integer CHECK (page_number > 0),
  section_locator text NOT NULL,
  embedding vector,
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (document_id, case_id, applicant_id, evidence_submission_id)
    REFERENCES case_documents(id, case_id, applicant_id, evidence_submission_id),
  UNIQUE (document_id, chunk_index)
);

CREATE INDEX document_chunks_case_id_idx ON document_chunks(case_id);
CREATE INDEX document_chunks_search_vector_idx ON document_chunks USING gin(search_vector);

CREATE TABLE policy_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  title text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE policy_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_document_id uuid NOT NULL REFERENCES policy_documents(id),
  version text NOT NULL,
  approved_at date NOT NULL,
  effective_from date NOT NULL,
  effective_to date,
  superseded boolean NOT NULL DEFAULT false,
  source_path text NOT NULL,
  checksum_sha256 text NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  UNIQUE (policy_document_id, version)
);

CREATE TABLE policy_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_version_id uuid NOT NULL REFERENCES policy_versions(id),
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  content text NOT NULL,
  section_locator text NOT NULL,
  jurisdictions text[] NOT NULL DEFAULT ARRAY['*']::text[],
  products text[] NOT NULL DEFAULT ARRAY['*']::text[],
  business_types text[] NOT NULL DEFAULT ARRAY['*']::text[],
  embedding vector,
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (policy_version_id, chunk_index)
);

CREATE INDEX policy_chunks_search_vector_idx ON policy_chunks USING gin(search_vector);
CREATE INDEX policy_chunks_context_idx ON policy_chunks USING gin(jurisdictions, products, business_types);

CREATE TABLE analysis_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES onboarding_cases(id),
  session_id text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued', 'running', 'suspended', 'succeeded', 'failed', 'timed_out',
    'cancelled'
  )),
  output_schema_version text NOT NULL DEFAULT '1.0',
  analyst_instructions text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, case_id)
);

CREATE UNIQUE INDEX one_active_analysis_run_per_case_idx
  ON analysis_runs(case_id)
  WHERE status IN ('queued', 'running', 'suspended');

ALTER TABLE onboarding_cases
  ADD COLUMN active_analysis_run_id uuid,
  ADD CONSTRAINT onboarding_cases_active_run_fk
    FOREIGN KEY (active_analysis_run_id, id) REFERENCES analysis_runs(id, case_id);

CREATE TABLE analysis_run_documents (
  analysis_run_id uuid NOT NULL,
  case_id uuid NOT NULL,
  document_id uuid NOT NULL,
  PRIMARY KEY (analysis_run_id, document_id),
  FOREIGN KEY (analysis_run_id, case_id) REFERENCES analysis_runs(id, case_id),
  FOREIGN KEY (document_id, case_id) REFERENCES case_documents(id, case_id)
);

CREATE TABLE analysis_run_policy_versions (
  analysis_run_id uuid NOT NULL REFERENCES analysis_runs(id),
  policy_version_id uuid NOT NULL REFERENCES policy_versions(id),
  PRIMARY KEY (analysis_run_id, policy_version_id)
);

CREATE TABLE findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_run_id uuid NOT NULL REFERENCES analysis_runs(id),
  requirement_code text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('met', 'not_met', 'uncertain')),
  summary text NOT NULL,
  rationale text NOT NULL,
  confidence numeric(4,3) CHECK (confidence >= 0 AND confidence <= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, analysis_run_id)
);

CREATE TABLE evidence_gaps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_run_id uuid NOT NULL REFERENCES analysis_runs(id),
  requirement_code text NOT NULL,
  description text NOT NULL,
  requested_evidence text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, analysis_run_id)
);

CREATE TABLE conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_run_id uuid NOT NULL REFERENCES analysis_runs(id),
  subject text NOT NULL,
  description text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, analysis_run_id)
);

CREATE TABLE citations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_run_id uuid NOT NULL REFERENCES analysis_runs(id),
  finding_id uuid,
  evidence_gap_id uuid,
  conflict_id uuid,
  source_kind text NOT NULL CHECK (source_kind IN ('case_document', 'policy')),
  document_chunk_id uuid REFERENCES document_chunks(id),
  policy_chunk_id uuid REFERENCES policy_chunks(id),
  locator text NOT NULL,
  excerpt text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (finding_id, analysis_run_id) REFERENCES findings(id, analysis_run_id),
  FOREIGN KEY (evidence_gap_id, analysis_run_id) REFERENCES evidence_gaps(id, analysis_run_id),
  FOREIGN KEY (conflict_id, analysis_run_id) REFERENCES conflicts(id, analysis_run_id),
  CHECK (
    (source_kind = 'case_document' AND document_chunk_id IS NOT NULL AND policy_chunk_id IS NULL)
    OR
    (source_kind = 'policy' AND policy_chunk_id IS NOT NULL AND document_chunk_id IS NULL)
  ),
  CHECK (num_nonnulls(finding_id, evidence_gap_id, conflict_id) = 1)
);

CREATE TABLE human_input_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_run_id uuid NOT NULL REFERENCES analysis_runs(id),
  request_type text NOT NULL CHECK (request_type IN ('clarification', 'approval')),
  question text NOT NULL,
  reason text NOT NULL,
  input_type text NOT NULL CHECK (input_type IN ('text', 'choice', 'document')),
  allowed_choices jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'answered', 'expired', 'cancelled'
  )),
  response jsonb,
  responded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((input_type = 'choice') = (allowed_choices IS NOT NULL)),
  CHECK ((status = 'answered') = (response IS NOT NULL AND responded_at IS NOT NULL))
);

CREATE TABLE proposed_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_run_id uuid NOT NULL,
  case_id uuid NOT NULL,
  action_type text NOT NULL CHECK (action_type IN (
    'record_information_request', 'mark_ready_for_review',
    'create_enhanced_review_task', 'close_case'
  )),
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'approved', 'rejected', 'executed', 'failed'
  )),
  idempotency_key text NOT NULL UNIQUE,
  execution_result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (analysis_run_id, case_id) REFERENCES analysis_runs(id, case_id)
);

CREATE TABLE approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposed_action_id uuid NOT NULL UNIQUE REFERENCES proposed_actions(id),
  decision text NOT NULL CHECK (decision IN ('approved', 'rejected', 'changes_requested')),
  decided_by text NOT NULL,
  rationale text,
  decided_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid REFERENCES onboarding_cases(id),
  analysis_run_id uuid REFERENCES analysis_runs(id),
  event_type text NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('system', 'analyst', 'applicant', 'workflow')),
  actor_id text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION protect_pinned_document_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM analysis_run_documents snapshot
    WHERE snapshot.document_id = OLD.id
  ) THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'document % is pinned to an analysis run', OLD.id;
    END IF;

    IF NEW.evidence_submission_id IS DISTINCT FROM OLD.evidence_submission_id
      OR NEW.case_id IS DISTINCT FROM OLD.case_id
      OR NEW.applicant_id IS DISTINCT FROM OLD.applicant_id
      OR NEW.original_filename IS DISTINCT FROM OLD.original_filename
      OR NEW.mime_type IS DISTINCT FROM OLD.mime_type
      OR NEW.checksum_sha256 IS DISTINCT FROM OLD.checksum_sha256
      OR NEW.storage_path IS DISTINCT FROM OLD.storage_path
    THEN
      RAISE EXCEPTION 'source identity for pinned document % is immutable', OLD.id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER protect_pinned_document_identity_trigger
BEFORE UPDATE OR DELETE ON case_documents
FOR EACH ROW EXECUTE FUNCTION protect_pinned_document_identity();

COMMIT;
