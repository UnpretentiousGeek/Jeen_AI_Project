BEGIN;

CREATE INDEX IF NOT EXISTS audit_events_case_created_idx
  ON audit_events (case_id, created_at DESC, id DESC);

DROP TRIGGER IF EXISTS immutable_audit_events ON audit_events;
CREATE TRIGGER immutable_audit_events
BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION reject_snapshot_row_mutation();

DROP TRIGGER IF EXISTS immutable_coordinator_v3_task_events ON coordinator_v3_task_events;
CREATE TRIGGER immutable_coordinator_v3_task_events
BEFORE UPDATE OR DELETE ON coordinator_v3_task_events
FOR EACH ROW EXECUTE FUNCTION reject_snapshot_row_mutation();

DROP TRIGGER IF EXISTS immutable_coordinator_v3_events ON coordinator_v3_events;
CREATE TRIGGER immutable_coordinator_v3_events
BEFORE UPDATE OR DELETE ON coordinator_v3_events
FOR EACH ROW EXECUTE FUNCTION reject_snapshot_row_mutation();

DROP TRIGGER IF EXISTS immutable_coordinator_v3_human_decisions ON coordinator_v3_human_decisions;
CREATE TRIGGER immutable_coordinator_v3_human_decisions
BEFORE UPDATE OR DELETE ON coordinator_v3_human_decisions
FOR EACH ROW EXECUTE FUNCTION reject_snapshot_row_mutation();

CREATE OR REPLACE FUNCTION record_case_timeline_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'case_documents' THEN
    INSERT INTO audit_events (case_id, event_type, actor_type, payload)
    VALUES (NEW.case_id, 'document.ingestion_' || NEW.ingestion_status, 'system',
      jsonb_build_object('document_id', NEW.id, 'filename', NEW.original_filename,
                         'from', OLD.ingestion_status, 'to', NEW.ingestion_status,
                         'error', NEW.ingestion_error));
  ELSIF TG_TABLE_NAME = 'analysis_runs' THEN
    INSERT INTO audit_events (case_id, analysis_run_id, event_type, actor_type, payload)
    VALUES (NEW.case_id, NEW.id, 'analysis.' || NEW.status, 'system',
      jsonb_build_object('from', OLD.status, 'to', NEW.status));
  ELSE
    INSERT INTO audit_events (case_id, analysis_run_id, event_type, actor_type, payload)
    VALUES (NEW.id, NEW.active_analysis_run_id, 'case.status_changed', 'system',
      jsonb_build_object('from', OLD.status, 'to', NEW.status));
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS timeline_document_ingestion ON case_documents;
CREATE TRIGGER timeline_document_ingestion
AFTER UPDATE OF ingestion_status ON case_documents
FOR EACH ROW WHEN (OLD.ingestion_status IS DISTINCT FROM NEW.ingestion_status)
EXECUTE FUNCTION record_case_timeline_transition();

DROP TRIGGER IF EXISTS timeline_analysis_status ON analysis_runs;
CREATE TRIGGER timeline_analysis_status
AFTER UPDATE OF status ON analysis_runs
FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION record_case_timeline_transition();

DROP TRIGGER IF EXISTS timeline_case_status ON onboarding_cases;
CREATE TRIGGER timeline_case_status
AFTER UPDATE OF status ON onboarding_cases
FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION record_case_timeline_transition();

COMMIT;
