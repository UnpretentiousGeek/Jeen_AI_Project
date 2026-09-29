BEGIN;

CREATE OR REPLACE FUNCTION case_evidence_readiness(p_case_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  has_documents boolean;
  has_jobs boolean;
  has_ready boolean;
  has_processing boolean;
  has_failed boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM case_documents WHERE case_id = p_case_id),
         EXISTS (SELECT 1 FROM api_langflow_invocations
                 WHERE case_id = p_case_id AND purpose = 'evidence_ingestion')
    INTO has_documents, has_jobs;

  IF NOT has_documents AND NOT has_jobs THEN
    RETURN 'empty';
  END IF;

  SELECT
    COALESCE(bool_or(document.ingestion_status = 'ready'), false),
    COALESCE(bool_or(document.ingestion_status IN ('pending', 'parsing')), false),
    COALESCE(bool_or(document.ingestion_status = 'failed'), false)
  INTO has_ready, has_processing, has_failed
  FROM case_documents document
  WHERE document.case_id = p_case_id;

  -- Only the latest invocation for each known checksum represents the current
  -- attempt. Null-checksum legacy jobs are retained as independent jobs.
  WITH ranked_jobs AS (
    SELECT invocation.*,
           row_number() OVER (
             PARTITION BY COALESCE(invocation.evidence_checksum_sha256, invocation.id::text)
             ORDER BY invocation.created_at DESC, invocation.id DESC
           ) AS attempt_rank
    FROM api_langflow_invocations invocation
    WHERE invocation.case_id = p_case_id
      AND invocation.purpose = 'evidence_ingestion'
  )
  SELECT
    has_processing OR COALESCE(bool_or(job.status IN ('queued', 'in_progress', 'suspended')), false),
    has_failed OR COALESCE(bool_or(
      (job.status IN ('failed', 'cancelled', 'timed_out') AND NOT EXISTS (
        SELECT 1 FROM case_documents recovered
        WHERE recovered.case_id = p_case_id
          AND recovered.checksum_sha256 = job.evidence_checksum_sha256
          AND recovered.ingestion_status = 'ready'
          AND recovered.source_metadata #>> '{fact_extraction,status}' = 'completed'
          AND COALESCE((recovered.source_metadata #>> '{fact_extraction,schema_version}')::integer, 0) >= 2
      ))
      OR (job.status = 'completed' AND (
        job.evidence_checksum_sha256 IS NULL OR NOT EXISTS (
          SELECT 1 FROM case_documents document
          WHERE document.case_id = p_case_id
            AND document.checksum_sha256 = job.evidence_checksum_sha256
            AND document.ingestion_status = 'ready'
        )
      ))
    ), false)
  INTO has_processing, has_failed
  FROM ranked_jobs job
  WHERE job.attempt_rank = 1;

  IF has_processing THEN
    RETURN 'processing';
  END IF;
  IF has_failed THEN
    RETURN 'failed';
  END IF;
  IF has_ready THEN
    RETURN 'ready';
  END IF;
  RETURN 'failed';
END;
$$;

COMMIT;
