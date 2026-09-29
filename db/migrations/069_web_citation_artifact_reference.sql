BEGIN;

-- A web citation names the Public Research output that analyzed its evidence. The legacy A2A
-- path stores that output in specialist_artifacts; the durable coordinator stores it as a
-- validated Public Research contribution (migration 059 taught the citation permission check
-- both). The foreign key from 011 still accepted only specialist_artifacts, so every finding
-- citing durable Public Research evidence was refused. A trigger enforces the same rule as
-- coordinator_v3_web_citation_permitted for every write path instead.
ALTER TABLE citations DROP CONSTRAINT citations_public_research_artifact_fk;

CREATE OR REPLACE FUNCTION validate_citation_public_research_reference()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.agent_task_id IS NULL AND NEW.agent_artifact_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM specialist_artifacts artifact
    WHERE artifact.task_id = NEW.agent_task_id
      AND artifact.artifact_id = NEW.agent_artifact_id
  ) AND NOT EXISTS (
    SELECT 1 FROM coordinator_v3_contributions contribution
    WHERE contribution.task_id = NEW.agent_task_id
      AND contribution.analysis_run_id = NEW.analysis_run_id
      AND contribution.specialty = 'public_research'
      AND contribution.payload->>'contribution_id' = NEW.agent_artifact_id
  ) THEN
    RAISE EXCEPTION 'citation references no Public Research output of this run'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER citations_public_research_reference_guard
BEFORE INSERT OR UPDATE OF agent_task_id, agent_artifact_id, analysis_run_id ON citations
FOR EACH ROW EXECUTE FUNCTION validate_citation_public_research_reference();

COMMIT;
