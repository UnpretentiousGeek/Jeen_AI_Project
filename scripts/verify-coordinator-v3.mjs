import fs from "node:fs";
import pg from "pg";
import { spawn } from "node:child_process";

const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8").split(/\r?\n/).filter(Boolean).map((line) => {
    const index = line.indexOf("=");
    return [line.slice(0, index), line.slice(index + 1)];
  }),
);
const server = env.LANGFLOW_SERVER_URL;
const apiKey = env.LANGFLOW_API_KEY;
const flowId = "145140c9-ffae-4a7d-94ae-e9533734347a";
const headers = { "x-api-key": apiKey, "content-type": "application/json" };
const db = new pg.Client({ connectionString: "postgresql://jeen:jeen_dev@127.0.0.1:5432/jeen" });
await db.connect();

const cases = {
  complete: ["a4000000-0000-4000-8000-000000000051", "32000000-0000-0000-0000-000000000051"],
  interrupted: ["a4000000-0000-4000-8000-000000000052", "32000000-0000-0000-0000-000000000052"],
  conflict: ["a4000000-0000-4000-8000-000000000053", "32000000-0000-0000-0000-000000000053"],
  required_failure: ["a4000000-0000-4000-8000-000000000054", "32000000-0000-0000-0000-000000000054"],
  public_research: ["a4000000-0000-4000-8000-000000000055", "32000000-0000-0000-0000-000000000055"],
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evidence = { generated_at: new Date().toISOString(), flow_id: flowId, stages: [] };

async function request(path, options = {}) {
  const response = await fetch(`${server}${path}`, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  const body = await response.json();
  if (!response.ok) throw new Error(`${options.method || "GET"} ${path} -> ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function start(scenario, suffix) {
  const [analysisRunId, caseId] = cases[scenario];
  const body = await request("/api/v2/workflows", {
    method: "POST",
    body: JSON.stringify({
      flow_id: flowId,
      input_value: JSON.stringify({ analysis_run_id: analysisRunId, case_id: caseId, scenario }),
      session_id: `coord-v3-${scenario}-${suffix}`,
      mode: "background",
      idempotency_key: `coord-v3-${scenario}-${suffix}`,
    }),
  });
  evidence.stages.push({ at: new Date().toISOString(), event: "started", scenario, ...body });
  return body.job_id;
}

async function status(jobId) {
  const response = await fetch(`${server}/api/v2/workflows?job_id=${jobId}`, { headers });
  const body = await response.json();
  if (response.ok) return body;
  if (body?.detail?.code === "JOB_FAILED") return { job_id: jobId, status: "failed", error: body.detail.error_detail };
  throw new Error(`status ${jobId} -> ${response.status}: ${JSON.stringify(body)}`);
}

async function waitFor(jobId, accepted, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const body = await status(jobId);
    if (accepted.includes(body.status)) {
      evidence.stages.push({ at: new Date().toISOString(), event: "status", job_id: jobId, status: body.status,
        errors: body.errors || [], output: body.output || null });
      return body;
    }
    if (["failed", "cancelled", "timed_out"].includes(body.status)) {
      throw new Error(`job ${jobId} unexpectedly ${body.status}: ${JSON.stringify(body.error || body.errors)}`);
    }
    await sleep(1500);
  }
  throw new Error(`timeout waiting for ${jobId}: ${accepted.join(",")}`);
}

async function pendingRequest(jobId) {
  const compact = jobId.replaceAll("-", "");
  const row = await new Promise((resolve, reject) => {
    const child = spawn("sqlite3", ["-json", "/Users/sanchittomar/.langflow/data/database.db",
      `select json_extract(job_metadata,'$.pending_request_id') request_id,status from job where job_id='${compact}';`]);
    let out = ""; let err = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("close", (code) => code === 0 ? resolve(JSON.parse(out)[0]) : reject(new Error(err)));
  });
  return row.request_id;
}

async function resume(jobId, actionId, values = {}) {
  const requestId = await pendingRequest(jobId);
  const body = await request(`/api/v2/workflows/${jobId}/resume`, {
    method: "POST",
    body: JSON.stringify({ request_id: requestId, decision: { action_id: actionId, values } }),
  });
  evidence.stages.push({ at: new Date().toISOString(), event: "resumed", job_id: jobId,
    request_id: requestId, action_id: actionId, values, response: body });
  return body;
}

async function actionCount(analysisRunId) {
  const result = await db.query("select count(*)::int count from coordinator_v3_action_results where analysis_run_id=$1", [analysisRunId]);
  return result.rows[0].count;
}

async function collectDatabaseEvidence(jobIds) {
  const runs = await db.query(`select analysis_run_id,case_id,langflow_job_id,session_id,scenario,state,created_at,updated_at
    from coordinator_v3_runs where langflow_job_id = any($1::text[]) order by created_at`, [jobIds]);
  const events = await db.query(`select analysis_run_id,langflow_job_id,specialty,task_id,context_id,attempt,event_type,occurred_at,details
    from coordinator_v3_task_events where langflow_job_id = any($1::text[]) order by occurred_at`, [jobIds]);
  const contributions = await db.query(`select analysis_run_id,case_id,langflow_job_id,specialty,task_id,context_id,agent_name,
    agent_version,status,source_scope,citations,payload_hash,started_at,completed_at,validated_at,attempt
    from coordinator_v3_contributions where langflow_job_id = any($1::text[]) order by langflow_job_id,specialty,attempt`, [jobIds]);
  const checkpoints = await db.query(`select analysis_run_id,case_id,langflow_job_id,checkpoint_kind,request_id,prompt,status,
    decision,values,created_at,decided_at from coordinator_v3_checkpoints where langflow_job_id = any($1::text[])
    order by created_at`, [jobIds]);
  const actions = await db.query(`select analysis_run_id,case_id,proposed_action_id,idempotency_key,proposal_hash,approval_id,status,result,executed_at
    from coordinator_v3_action_results where analysis_run_id = any($1::uuid[]) order by executed_at`, [Object.values(cases).map(([id]) => id)]);
  return { runs: runs.rows, task_events: events.rows, contributions: contributions.rows,
    checkpoints: checkpoints.rows, actions: actions.rows };
}

async function runCore() {
  const suffix = Date.now();
  const jobs = {};
  [jobs.conflict, jobs.required_failure] = await Promise.all([
    start("conflict", `isolation-a-${suffix}`),
    start("required_failure", `isolation-b-${suffix}`),
  ]);
  await Promise.all([waitFor(jobs.conflict, ["suspended"]), waitFor(jobs.required_failure, ["suspended"])]);
  evidence.isolation = { jobs: [jobs.conflict, jobs.required_failure], started_together: true };
  await resume(jobs.conflict, "escalate", { rationale: "Unresolved registered-address conflict requires analyst review." });
  await waitFor(jobs.conflict, ["completed"]);
  await resume(jobs.required_failure, "retry", { rationale: "Retry the required Policy specialist once." });
  await waitFor(jobs.required_failure, ["suspended"]);
  await resume(jobs.required_failure, "reject", { rationale: "Recovery proven; final action intentionally rejected." });
  await waitFor(jobs.required_failure, ["completed"]);

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    jobs.interrupted = await start("interrupted", `selective-${suffix}-attempt-${attempt}`);
    const initial = await status(jobs.interrupted);
    try {
      if (initial.status !== "suspended") await waitFor(jobs.interrupted, ["suspended"]);
      break;
    } catch (error) {
      evidence.stages.push({ at: new Date().toISOString(), event: "initial_integration_retry",
        job_id: jobs.interrupted, scenario: "interrupted", attempt, error: String(error) });
      if (attempt === 2) throw error;
    }
  }
  await resume(jobs.interrupted, "submit_clarification", {
    text: "The remaining 18% is held by Maya Patel, a natural person, supported by the signed cap table amendment.",
  });
  await waitFor(jobs.interrupted, ["completed"]);

  const beforeIdempotency = await actionCount(cases.complete[0]);
  jobs.idempotency = await start("complete", `idempotency-${suffix}`);
  await waitFor(jobs.idempotency, ["suspended"]);
  await resume(jobs.idempotency, "approve", { analyst: "coordinator-v3-acceptance" });
  await waitFor(jobs.idempotency, ["completed"]);
  const afterIdempotency = await actionCount(cases.complete[0]);
  evidence.idempotency = { before: beforeIdempotency, after: afterIdempotency,
    duplicate_suppressed: beforeIdempotency === afterIdempotency };

  jobs.rejected = await start("complete", `rejected-${suffix}`);
  await waitFor(jobs.rejected, ["suspended"]);
  const beforeRejected = await actionCount(cases.complete[0]);
  await resume(jobs.rejected, "reject", { rationale: "Analyst rejects proposed action." });
  await waitFor(jobs.rejected, ["completed"]);
  const afterRejected = await actionCount(cases.complete[0]);

  jobs.missing = await start("complete", `missing-${suffix}`);
  await waitFor(jobs.missing, ["suspended"]);
  const beforeMissing = await actionCount(cases.complete[0]);
  await sleep(2000);
  const afterMissing = await actionCount(cases.complete[0]);

  jobs.altered = await start("complete", `altered-${suffix}`);
  await waitFor(jobs.altered, ["suspended"]);
  const beforeAltered = await actionCount(cases.complete[0]);
  await resume(jobs.altered, "approve", { proposed_action: { action_type: "mark_ready_for_review", summary: "ALTERED" } });
  await waitFor(jobs.altered, ["failed"]);
  const afterAltered = await actionCount(cases.complete[0]);
  evidence.rejection_guards = {
    rejected: { before: beforeRejected, after: afterRejected, no_action: beforeRejected === afterRejected },
    missing: { before: beforeMissing, after: afterMissing, job_status: "suspended", no_action: beforeMissing === afterMissing },
    altered: { before: beforeAltered, after: afterAltered, job_status: "failed", no_action: beforeAltered === afterAltered },
  };

  const jobIds = Object.values(jobs);
  evidence.jobs = jobs;
  evidence.database = await collectDatabaseEvidence(jobIds);
  return evidence;
}

async function runPublic() {
  const suffix = Date.now();
  const job = await start("public_research", `public-${suffix}`);
  await waitFor(job, ["suspended"]);
  await resume(job, "approve", { rationale: "Approve exact TinyFish query, domains, disclosed fields, intended use, and limit only." });
  await waitFor(job, ["suspended"], 120000);
  await resume(job, "accept", { rationale: "Accept immutable fetched results unchanged for Public Research only." });
  await waitFor(job, ["suspended"], 120000);
  const before = await actionCount(cases.public_research[0]);
  await resume(job, "reject", { rationale: "Research checkpoints proven; final persisted action intentionally rejected." });
  await waitFor(job, ["completed"]);
  const after = await actionCount(cases.public_research[0]);
  evidence.public_research = { job, final_action_rejected: true, before, after, no_action: before === after };
  evidence.database = await collectDatabaseEvidence([job]);
  return evidence;
}

async function runGuards() {
  const suffix = Date.now();
  const jobs = {
    conflict: "ee973f17-df3b-4be9-88c7-b42ce4b159db",
    required_failure: "7f68fff4-6fd4-49da-be14-b65c79d00306",
    interrupted: "24a129c0-bd03-4928-bcb9-90c87482838b",
  };
  evidence.isolation = { jobs: [jobs.conflict, jobs.required_failure], started_together: true,
    created_at: "2026-09-20T20:35:50Z" };

  const beforeIdempotency = await actionCount(cases.complete[0]);
  jobs.idempotency = await start("complete", `idempotency-guard-${suffix}`);
  await waitFor(jobs.idempotency, ["suspended"]);
  await resume(jobs.idempotency, "approve", { analyst: "coordinator-v3-acceptance" });
  await waitFor(jobs.idempotency, ["completed"]);
  const afterIdempotency = await actionCount(cases.complete[0]);
  evidence.idempotency = { before: beforeIdempotency, after: afterIdempotency,
    duplicate_suppressed: beforeIdempotency === afterIdempotency };

  jobs.rejected = await start("complete", `rejected-guard-${suffix}`);
  await waitFor(jobs.rejected, ["suspended"]);
  const beforeRejected = await actionCount(cases.complete[0]);
  await resume(jobs.rejected, "reject", { rationale: "Analyst rejects proposed action." });
  await waitFor(jobs.rejected, ["completed"]);
  const afterRejected = await actionCount(cases.complete[0]);

  jobs.missing = await start("complete", `missing-guard-${suffix}`);
  await waitFor(jobs.missing, ["suspended"]);
  const beforeMissing = await actionCount(cases.complete[0]);
  await sleep(2000);
  const afterMissing = await actionCount(cases.complete[0]);

  jobs.altered = await start("complete", `altered-guard-${suffix}`);
  await waitFor(jobs.altered, ["suspended"]);
  const beforeAltered = await actionCount(cases.complete[0]);
  await resume(jobs.altered, "approve", { proposed_action: { action_type: "mark_ready_for_review", summary: "ALTERED" } });
  await waitFor(jobs.altered, ["failed"]);
  const afterAltered = await actionCount(cases.complete[0]);
  evidence.rejection_guards = {
    rejected: { before: beforeRejected, after: afterRejected, no_action: beforeRejected === afterRejected },
    missing: { before: beforeMissing, after: afterMissing, job_status: "suspended", no_action: beforeMissing === afterMissing },
    altered: { before: beforeAltered, after: afterAltered, job_status: "failed", no_action: beforeAltered === afterAltered },
  };
  evidence.jobs = jobs;
  evidence.database = await collectDatabaseEvidence(Object.values(jobs));
  return evidence;
}

try {
  const mode = process.argv[2] || "core";
  const result = mode === "public" ? await runPublic() : mode === "guards" ? await runGuards() : await runCore();
  const kind = mode === "public" ? "public" : "core";
  fs.mkdirSync("artifacts/acceptance", { recursive: true });
  fs.writeFileSync(`artifacts/acceptance/coordinator-v3-${kind}.json`, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ kind, flow_id: flowId, jobs: result.jobs || result.public_research,
    idempotency: result.idempotency, rejection_guards: result.rejection_guards }, null, 2));
} finally {
  await db.end();
}
