import { randomUUID } from "node:crypto";

import { LangflowWorkflowClient } from "../src/workflow/langflow-client.js";

const serverUrl = process.env.LANGFLOW_SERVER_URL;
const apiKey = process.env.LANGFLOW_API_KEY;
const flowId = process.argv[2];

if (!serverUrl || !apiKey) {
  throw new Error("LANGFLOW_SERVER_URL and LANGFLOW_API_KEY are required");
}
if (!flowId) {
  throw new Error("Pass the KYB Coordinator V3 flow id as the first argument");
}

const analysisRunId = process.argv[3] ?? "a4000000-0000-4000-8000-000000000055";
const caseId = process.argv[4] ?? "32000000-0000-0000-0000-000000000055";
const sessionId = process.argv[5] ?? "coordinator-v3-fixture-55";
const inputValue = JSON.stringify({
  schema_version: "1.0",
  analysis_run_id: analysisRunId,
  case_id: caseId,
  session_id: sessionId,
  task_objective: [
    "Run only the Entity specialist and validate its contribution.",
    `Then request an analyst_approval checkpoint with request_id entity-slice-review-${analysisRunId.slice(-8)} and ask whether the validated entity slice should be accepted for this test.`,
    "After the human decision is received, do not recreate that checkpoint or call any specialist again.",
    "Return the latest persisted state with the exact human_checkpoint_result; use an empty object for no active_human_checkpoint and an empty string for review_decision so the final validator can canonicalize both to null.",
  ].join(" "),
});

const client = new LangflowWorkflowClient({
  serverUrl,
  apiKey,
  timeoutMs: 60_000,
});

async function waitFor(
  jobId: string,
  expected: ReadonlySet<string>,
  maxAttempts = 300,
) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const status = await client.status(jobId);
    if (expected.has(status.status)) return status;
    if (["completed", "failed", "cancelled", "timed_out"].includes(status.status)) return status;
  }
  throw new Error(`Timed out waiting for Langflow job ${jobId}`);
}

const job = await client.startBackground({
  flowId,
  inputValue,
  sessionId,
  idempotencyKey: `coordinator-v3-checkpoint-loop:${analysisRunId}:${randomUUID()}`,
  tweaks: {
    "ChatInput-KHUxC": { session_id: sessionId, should_store_message: false },
    "ChatOutput-y3qVv": { should_store_message: false },
  },
});

console.log(JSON.stringify({ event: "started", job_id: job.job_id, status: job.status }));

const suspended = await waitFor(job.job_id, new Set(["suspended"]));
if (suspended.status !== "suspended") {
  console.log(JSON.stringify({ event: "failed_before_checkpoint", status: suspended }));
  process.exit(1);
}

const pending = (await client.pending(flowId)).filter((item) => item.job_id === job.job_id);
if (pending.length !== 1) {
  throw new Error(`Expected one pending checkpoint for ${job.job_id}, received ${pending.length}`);
}
const request = pending[0];
if (!request.allowed_decisions.includes("reject")) {
  throw new Error("Checkpoint does not allow the deterministic reject decision");
}

console.log(JSON.stringify({
  event: "suspended",
  job_id: job.job_id,
  request_id: request.request_id,
  kind: request.kind,
  allowed_decisions: request.allowed_decisions,
}));

const resumed = await client.resume({
  jobId: job.job_id,
  requestId: request.request_id,
  actionId: "reject",
});
console.log(JSON.stringify({ event: "resumed", job_id: job.job_id, status: resumed.status }));

const completed = await waitFor(job.job_id, new Set(["completed", "suspended"]));
console.log(JSON.stringify({
  event: "terminal",
  job_id: job.job_id,
  status: completed.status,
  errors: "errors" in completed ? completed.errors : undefined,
  output: "output" in completed ? completed.output : undefined,
}));

process.exit(completed.status === "completed" ? 0 : 1);
