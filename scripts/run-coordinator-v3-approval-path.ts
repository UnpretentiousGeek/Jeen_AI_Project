import { randomUUID } from "node:crypto";
import pg from "pg";

import { LangflowWorkflowClient } from "../src/workflow/langflow-client.js";

const serverUrl = process.env.LANGFLOW_SERVER_URL;
const apiKey = process.env.LANGFLOW_API_KEY;
const flowId = process.argv[2] ?? "475ec98e-7bbf-41b3-a769-866608299598";
if (!serverUrl || !apiKey) throw new Error("LANGFLOW_SERVER_URL and LANGFLOW_API_KEY are required");

const db = new pg.Client({ connectionString: "postgresql://jeen:jeen_dev@127.0.0.1:5432/jeen" });
await db.connect();
const runId = randomUUID();
const applicantId = randomUUID();
const applicationId = randomUUID();
const caseId = randomUUID();
const submissionId = randomUUID();
const documentId = randomUUID();
const chunkId = randomUUID();
const seedRunId = "a4000000-0000-4000-8000-000000000055";
const gapId = randomUUID();
const sessionId = `coord-v3-approval-${randomUUID()}`;

await db.query("BEGIN");
try {
  await db.query(`INSERT INTO applicants(id,legal_name,jurisdiction,business_type,product)
    SELECT $1::uuid,legal_name,jurisdiction,business_type,product FROM applicants
    WHERE id='12000000-0000-0000-0000-000000000055'::uuid`, [applicantId]);
  await db.query(`INSERT INTO applications(id,applicant_id,submitted_payload)
    SELECT $1::uuid,$2::uuid,submitted_payload FROM applications
    WHERE id='22000000-0000-0000-0000-000000000055'::uuid`, [applicationId, applicantId]);
  await db.query(`INSERT INTO onboarding_cases(id,application_id,applicant_id,reference,status)
    VALUES($1::uuid,$2::uuid,$3::uuid,$4,'processing')`, [caseId, applicationId, applicantId, `KYB-COORD-V3-APPROVAL-${runId.slice(0, 8)}`]);
  await db.query(`INSERT INTO evidence_submissions(id,case_id,submission_number,submitted_by)
    VALUES($1::uuid,$2::uuid,1,'coordinator_v3_approval_harness')`, [submissionId, caseId]);
  await db.query(`INSERT INTO case_documents(id,evidence_submission_id,case_id,applicant_id,document_type,
      original_filename,mime_type,checksum_sha256,storage_path,ingestion_status,parsed_text)
    SELECT $1::uuid,$2::uuid,$3::uuid,$4::uuid,document_type,original_filename,mime_type,
      checksum_sha256,storage_path,'ready',parsed_text FROM case_documents
    WHERE id='52000000-0000-0000-0000-000000000055'::uuid`, [documentId, submissionId, caseId, applicantId]);
  await db.query(`INSERT INTO document_chunks(id,document_id,case_id,applicant_id,evidence_submission_id,chunk_index,content,page_number,section_locator,embedding)
    SELECT $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,chunk_index,content,page_number,section_locator,embedding
    FROM document_chunks WHERE id='62000000-0000-0000-0000-000000000055'::uuid`, [chunkId, documentId, caseId, applicantId, submissionId]);
  await db.query(`INSERT INTO analysis_runs(
      id,case_id,session_id,status,output_schema_version,analyst_instructions,
      policy_effective_on,case_snapshot,started_at
    ) SELECT $1::uuid,$2::uuid,$3,'queued',output_schema_version,analyst_instructions,
      policy_effective_on,jsonb_set(case_snapshot,'{applicant,id}',to_jsonb($4::text)),NULL
      FROM analysis_runs WHERE id=$5::uuid`, [runId, caseId, sessionId, applicantId, seedRunId]);
  await db.query(`INSERT INTO analysis_run_documents(analysis_run_id,case_id,document_id)
    VALUES($1::uuid,$2::uuid,$3::uuid)`, [runId, caseId, documentId]);
  await db.query(`INSERT INTO analysis_run_policy_versions(analysis_run_id,policy_version_id)
    SELECT $1::uuid,policy_version_id FROM analysis_run_policy_versions WHERE analysis_run_id=$2::uuid`, [runId, seedRunId]);
  await db.query(`INSERT INTO evidence_gaps(id,analysis_run_id,requirement_code,description,requested_evidence)
    SELECT $1::uuid,$2::uuid,requirement_code,description,requested_evidence
    FROM evidence_gaps WHERE id='b4000000-0000-4000-8000-000000000055'::uuid`, [gapId, runId]);
  await db.query("UPDATE onboarding_cases SET active_analysis_run_id=$1::uuid,updated_at=clock_timestamp() WHERE id=$2::uuid", [runId, caseId]);
  await db.query("COMMIT");
} catch (error) {
  await db.query("ROLLBACK");
  throw error;
}

const inputValue = JSON.stringify({
  schema_version: "1.0",
  analysis_run_id: runId,
  case_id: caseId,
  session_id: sessionId,
  task_objective: [
    "Use only the Public Research specialist in propose_research mode for documented evidence gap",
    `${gapId}. Validate and persist its bounded proposal without network access.`,
    "Then request search_execution_approval. The checkpoint prompt must be exactly one JSON object with approved_scope copied unchanged from the validated research_proposal:",
    "evidence_gap_id, claim_id, claim, query, allowed_domains, disclosed_applicant_fields, result_limit, and rationale.",
    "Do not call Entity, Ownership, or Policy. Search approval is not result acceptance.",
  ].join(" "),
});

const client = new LangflowWorkflowClient({ serverUrl, apiKey, timeoutMs: 60_000 });
const job = await client.startBackground({
  flowId,
  inputValue,
  sessionId,
  idempotencyKey: `coordinator-v3-approval:${runId}`,
  tweaks: {
    "ChatInput-KHUxC": { session_id: sessionId, should_store_message: false },
    "ChatOutput-y3qVv": { should_store_message: false },
  },
});
console.log(JSON.stringify({ event: "started", run_id: runId, job_id: job.job_id }));

async function waitFor(expected: Set<string>, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const state = await client.status(job.job_id);
    if (expected.has(state.status)) return state;
    if (["failed", "cancelled", "timed_out"].includes(state.status)) {
      throw new Error(`job ${job.job_id} ${state.status}: ${JSON.stringify(state)}`);
    }
  }
  throw new Error(`timeout waiting for ${[...expected].join(",")}`);
}

async function approve(expectedLabel: string, actionId: string) {
  const state = await waitFor(new Set(["suspended"]));
  const pending = (await client.pending(flowId)).filter((item) => item.job_id === job.job_id);
  if (pending.length !== 1) throw new Error(`Expected one ${expectedLabel} checkpoint, received ${pending.length}`);
  const request = pending[0];
  if (!request.allowed_decisions.includes(actionId)) throw new Error(`${expectedLabel} does not allow ${actionId}`);
  console.log(JSON.stringify({ event: "checkpoint", label: expectedLabel, request_id: request.request_id, prompt: request.prompt }));
  await client.resume({ jobId: job.job_id, requestId: request.request_id, actionId });
  return state;
}

await approve("search_execution_approval", "approve");
await approve("web_result_review", "accept");
await approve("analyst_approval", "approve");
const completed = await waitFor(new Set(["completed"]));

const counts = await db.query(`
  SELECT
    (SELECT count(*)::int FROM coordinator_v3_task_events WHERE langflow_job_id=$1) AS task_events,
    (SELECT count(*)::int FROM coordinator_v3_contributions WHERE langflow_job_id=$1) AS contributions,
    (SELECT count(*)::int FROM coordinator_v3_checkpoints WHERE langflow_job_id=$1) AS checkpoints,
    (SELECT count(*)::int FROM coordinator_v3_search_candidates WHERE langflow_job_id=$1) AS search_candidates,
    (SELECT count(*)::int FROM web_search_executions WHERE analysis_run_id=$2::uuid) AS search_executions,
    (SELECT count(*)::int FROM external_web_evidence WHERE analysis_run_id=$2::uuid) AS web_evidence,
    (SELECT count(*)::int FROM web_result_reviews WHERE analysis_run_id=$2::uuid) AS web_reviews,
    (SELECT count(*)::int FROM coordinator_v3_action_results WHERE analysis_run_id=$2::uuid) AS actions,
    (SELECT count(*)::int FROM coordinator_v3_reconciliation_events WHERE langflow_job_id=$1) AS reconciliation_events
`, [job.job_id, runId]);
const rows = await db.query(`SELECT checkpoint_kind,status,decision FROM coordinator_v3_checkpoints
  WHERE langflow_job_id=$1 ORDER BY created_at`, [job.job_id]);
console.log(JSON.stringify({ event: "completed", status: completed.status, run_id: runId, job_id: job.job_id,
  counts: counts.rows[0], checkpoints: rows.rows, output: "output" in completed ? completed.output : null }, null, 2));
await db.end();
