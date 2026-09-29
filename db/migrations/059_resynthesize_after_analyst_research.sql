BEGIN;

-- Web evidence cited by final findings must be analyst-accepted and analyzed by
-- Public Research. The legacy A2A path records that in specialist_artifacts; the
-- durable coordinator records it as a validated Public Research contribution
-- whose citations include the evidence.
CREATE OR REPLACE FUNCTION coordinator_v3_web_citation_permitted(
  p_analysis_run_id uuid,
  p_case_id uuid,
  p_evidence_id uuid,
  p_agent_task_id text,
  p_agent_artifact_id text
) RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM external_web_evidence evidence
    JOIN web_result_review_items review_item
      ON review_item.external_web_evidence_id = evidence.id
     AND review_item.review_state = 'accepted'
    WHERE evidence.id = p_evidence_id
      AND evidence.analysis_run_id = p_analysis_run_id
      AND evidence.case_id = p_case_id
      AND (
        EXISTS (
          SELECT 1 FROM specialist_artifacts artifact
          WHERE artifact.task_id = p_agent_task_id
            AND artifact.artifact_id = p_agent_artifact_id
            AND artifact.analysis_run_id = p_analysis_run_id
            AND artifact.specialty = 'public_research'
        )
        OR EXISTS (
          SELECT 1 FROM coordinator_v3_contributions contribution
          WHERE contribution.task_id = p_agent_task_id
            AND contribution.analysis_run_id = p_analysis_run_id
            AND contribution.specialty = 'public_research'
            AND contribution.payload->>'contribution_id' = p_agent_artifact_id
            AND contribution.payload->'citations' @> jsonb_build_array(
              jsonb_build_object('immutable_result_id', p_evidence_id::text)
            )
        )
      )
  );
$$;

CREATE OR REPLACE FUNCTION save_simple_coordinator_v3_findings(
  p_run_id uuid,
  p_payload jsonb,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  coordinator coordinator_v3_runs%ROWTYPE;
  payload_hash text := encode(digest(COALESCE(p_payload, '{}'::jsonb)::text, 'sha256'), 'hex');
  item jsonb;
  citation jsonb;
  finding_ids jsonb := '[]'::jsonb;
BEGIN
  IF jsonb_typeof(p_payload) <> 'object'
     OR jsonb_typeof(p_payload->'findings') <> 'array'
     OR jsonb_typeof(p_payload->'evidence_gaps') <> 'array'
     OR jsonb_typeof(p_payload->'conflicts') <> 'array'
     OR NULLIF(trim(p_idempotency_key), '') IS NULL THEN
    RAISE EXCEPTION 'final findings payload is invalid' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO coordinator FROM coordinator_v3_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND OR coordinator.phase NOT IN ('running', 'ready_for_review') THEN
    RAISE EXCEPTION 'coordinator run cannot accept final findings' USING ERRCODE = '55000';
  END IF;
  IF coordinator.state->>'final_findings_idempotency_key' IS NOT NULL THEN
    IF coordinator.state->>'final_findings_idempotency_key' = p_idempotency_key
       AND coordinator.state->>'final_findings_payload_hash' = payload_hash THEN
      RETURN jsonb_build_object('status', 'duplicate_suppressed', 'payload_hash', payload_hash);
    END IF;
    RAISE EXCEPTION 'final findings replay conflicts with persisted output' USING ERRCODE = '23P01';
  END IF;

  FOR item IN SELECT value FROM jsonb_array_elements(p_payload->'findings') LOOP
    IF NULLIF(item->>'id', '') IS NULL
       OR NULLIF(trim(item->>'requirement_code'), '') IS NULL
       OR item->>'outcome' NOT IN ('met', 'not_met', 'uncertain')
       OR NULLIF(trim(item->>'summary'), '') IS NULL
       OR NULLIF(trim(item->>'rationale'), '') IS NULL
       OR jsonb_typeof(item->'citations') <> 'array'
       OR jsonb_array_length(item->'citations') = 0 THEN
      RAISE EXCEPTION 'each final finding requires identity, assessment, and citations' USING ERRCODE = '22023';
    END IF;
    INSERT INTO findings(id, analysis_run_id, requirement_code, outcome, summary, rationale, confidence)
    VALUES (
      (item->>'id')::uuid, coordinator.analysis_run_id, item->>'requirement_code', item->>'outcome',
      item->>'summary', item->>'rationale', NULLIF(item->>'confidence', '')::numeric
    );
    finding_ids := finding_ids || jsonb_build_array(item->>'id');

    FOR citation IN SELECT value FROM jsonb_array_elements(item->'citations') LOOP
      IF citation->>'source_kind' = 'case_document' THEN
        IF NOT EXISTS (
          SELECT 1
          FROM analysis_run_documents snapshot
          JOIN document_chunks chunk ON chunk.document_id = snapshot.document_id
          WHERE snapshot.analysis_run_id = coordinator.analysis_run_id
            AND chunk.id = (citation->>'document_chunk_id')::uuid
        ) THEN
          RAISE EXCEPTION 'citation references case evidence outside the analysis run' USING ERRCODE = '42501';
        END IF;
        INSERT INTO citations(
          id, analysis_run_id, finding_id, source_kind, document_chunk_id, locator, excerpt
        ) VALUES (
          (citation->>'id')::uuid, coordinator.analysis_run_id, (item->>'id')::uuid,
          'case_document', (citation->>'document_chunk_id')::uuid,
          citation->>'locator', citation->>'excerpt'
        );
      ELSIF citation->>'source_kind' = 'policy' THEN
        IF NOT EXISTS (
          SELECT 1
          FROM analysis_run_policy_versions snapshot
          JOIN policy_chunks chunk ON chunk.policy_version_id = snapshot.policy_version_id
          WHERE snapshot.analysis_run_id = coordinator.analysis_run_id
            AND chunk.id = (citation->>'policy_chunk_id')::uuid
        ) THEN
          RAISE EXCEPTION 'citation references policy evidence outside the analysis run' USING ERRCODE = '42501';
        END IF;
        INSERT INTO citations(
          id, analysis_run_id, finding_id, source_kind, policy_chunk_id, locator, excerpt
        ) VALUES (
          (citation->>'id')::uuid, coordinator.analysis_run_id, (item->>'id')::uuid,
          'policy', (citation->>'policy_chunk_id')::uuid,
          citation->>'locator', citation->>'excerpt'
        );
      ELSIF citation->>'source_kind' = 'human_input' THEN
        IF NOT EXISTS (
          SELECT 1
          FROM human_input_requests request
          WHERE request.id = (citation->>'human_input_request_id')::uuid
            AND request.analysis_run_id = coordinator.analysis_run_id
            AND request.status = 'answered'
        ) THEN
          RAISE EXCEPTION 'citation references unavailable human input' USING ERRCODE = '42501';
        END IF;
        INSERT INTO citations(
          id, analysis_run_id, finding_id, source_kind, human_input_request_id, locator, excerpt
        ) VALUES (
          (citation->>'id')::uuid, coordinator.analysis_run_id, (item->>'id')::uuid,
          'human_input', (citation->>'human_input_request_id')::uuid,
          citation->>'locator', citation->>'excerpt'
        );
      ELSIF citation->>'source_kind' = 'external_web' THEN
        IF NOT coordinator_v3_web_citation_permitted(
          coordinator.analysis_run_id, coordinator.case_id,
          (citation->>'external_web_evidence_id')::uuid,
          citation->>'agent_task_id', citation->>'agent_artifact_id'
        ) THEN
          RAISE EXCEPTION 'citation references unaccepted or unscoped web evidence' USING ERRCODE = '42501';
        END IF;
        INSERT INTO citations(
          id, analysis_run_id, finding_id, source_kind, external_web_evidence_id,
          agent_task_id, agent_artifact_id, locator, excerpt
        ) VALUES (
          (citation->>'id')::uuid, coordinator.analysis_run_id, (item->>'id')::uuid,
          'external_web', (citation->>'external_web_evidence_id')::uuid,
          citation->>'agent_task_id', citation->>'agent_artifact_id',
          citation->>'locator', citation->>'excerpt'
        );
      ELSE
        RAISE EXCEPTION 'unsupported final citation source_kind' USING ERRCODE = '22023';
      END IF;
    END LOOP;
  END LOOP;

  FOR item IN SELECT value FROM jsonb_array_elements(p_payload->'evidence_gaps') LOOP
    INSERT INTO evidence_gaps(id, analysis_run_id, requirement_code, description, requested_evidence)
    VALUES ((item->>'id')::uuid, coordinator.analysis_run_id, item->>'requirement_code',
            item->>'description', item->>'requested_evidence');
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(p_payload->'conflicts') LOOP
    INSERT INTO conflicts(id, analysis_run_id, subject, description)
    VALUES ((item->>'id')::uuid, coordinator.analysis_run_id, item->>'subject', item->>'description');
  END LOOP;

  UPDATE coordinator_v3_runs
  SET state = state || jsonb_build_object(
        'latest_findings', finding_ids,
        'final_findings_idempotency_key', p_idempotency_key,
        'final_findings_payload_hash', payload_hash,
        'next_action', NULL,
        'next_action_idempotency_key', NULL,
        'updated_at', clock_timestamp()
      ),
      state_version = state_version + 1,
      updated_at = clock_timestamp()
  WHERE id = coordinator.id;
  RETURN jsonb_build_object('status', 'stored', 'payload_hash', payload_hash, 'finding_ids', finding_ids);
END;
$$;

-- An analyst revision that produced new analyzed evidence replaces the run's
-- findings. The prior set is preserved verbatim in the audit trail first.
CREATE OR REPLACE FUNCTION supersede_coordinator_v3_findings(
  p_run_id uuid,
  p_revision_request_id text,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  coordinator coordinator_v3_runs%ROWTYPE;
  prior jsonb;
BEGIN
  IF NULLIF(trim(p_revision_request_id), '') IS NULL OR NULLIF(trim(p_idempotency_key), '') IS NULL THEN
    RAISE EXCEPTION 'findings supersession is invalid' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO coordinator FROM coordinator_v3_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'simple coordinator run does not exist' USING ERRCODE = '23503';
  END IF;
  IF coordinator.state->>'findings_superseded_for' = p_revision_request_id THEN
    RETURN jsonb_build_object('status', 'duplicate_suppressed');
  END IF;
  IF coordinator.phase <> 'running'
     OR COALESCE(coordinator.state->'next_action', 'null'::jsonb) <> 'null'::jsonb
     OR coordinator.state->'analyst_research'->>'request_id' IS DISTINCT FROM p_revision_request_id
     OR jsonb_typeof(coordinator.state->'latest_findings') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'findings can only be superseded for the pending analyst revision' USING ERRCODE = '40001';
  END IF;
  SELECT jsonb_build_object(
    'findings', COALESCE((
      SELECT jsonb_agg(to_jsonb(finding) || jsonb_build_object('citations', COALESCE((
        SELECT jsonb_agg(to_jsonb(citation) ORDER BY citation.id)
        FROM citations citation WHERE citation.finding_id = finding.id
      ), '[]'::jsonb)) ORDER BY finding.id)
      FROM findings finding WHERE finding.analysis_run_id = coordinator.analysis_run_id
    ), '[]'::jsonb),
    'evidence_gaps', COALESCE((
      SELECT jsonb_agg(to_jsonb(gap) ORDER BY gap.id)
      FROM evidence_gaps gap WHERE gap.analysis_run_id = coordinator.analysis_run_id
    ), '[]'::jsonb),
    'conflicts', COALESCE((
      SELECT jsonb_agg(to_jsonb(conflict) ORDER BY conflict.id)
      FROM conflicts conflict WHERE conflict.analysis_run_id = coordinator.analysis_run_id
    ), '[]'::jsonb)
  ) INTO prior;
  INSERT INTO audit_events (case_id, analysis_run_id, event_type, actor_type, actor_id, payload)
  VALUES (
    coordinator.case_id, coordinator.analysis_run_id, 'findings_superseded', 'workflow', 'coordinator-v3',
    jsonb_build_object(
      'revision_request_id', p_revision_request_id,
      'final_findings_payload_hash', coordinator.state->>'final_findings_payload_hash',
      'prior', prior
    )
  );
  -- Citations cascade from their finding, gap, or conflict.
  DELETE FROM findings WHERE analysis_run_id = coordinator.analysis_run_id;
  DELETE FROM evidence_gaps WHERE analysis_run_id = coordinator.analysis_run_id;
  DELETE FROM conflicts WHERE analysis_run_id = coordinator.analysis_run_id;
  UPDATE coordinator_v3_runs
  SET state_version = state_version + 1,
      state = (state - 'latest_findings' - 'final_findings_idempotency_key' - 'final_findings_payload_hash')
        || jsonb_build_object(
          'findings_superseded_for', p_revision_request_id,
          'findings_superseded_key', p_idempotency_key,
          'updated_at', clock_timestamp()
        ),
      updated_at = clock_timestamp()
  WHERE id = p_run_id;
  RETURN jsonb_build_object('status', 'superseded', 'prior_finding_count', jsonb_array_length(prior->'findings'));
END;
$$;

COMMIT;
