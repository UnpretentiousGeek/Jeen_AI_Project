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

const analysisRunId = "9f000000-0000-0000-0000-000000000014";
const caseId = "30000000-0000-0000-0000-000000000014";
const sessionId = "ownership-v3-conflict-source";
const inputValue = JSON.stringify({
  schema_version: "1.0",
  analysis_run_id: analysisRunId,
  case_id: caseId,
  session_id: sessionId,
  task_objective: [
    "Run only the Entity specialist.",
    "Validate and persist its cited entity reconciliation contribution.",
    "Return control to the Coordinator and summarize the updated persisted state.",
    "Do not call Ownership, Policy, or Public Research.",
  ].join(" "),
});

const client = new LangflowWorkflowClient({
  serverUrl,
  apiKey,
  timeoutMs: 60_000,
});

const job = await client.startBackground({
  flowId,
  inputValue,
  sessionId,
  idempotencyKey: `coordinator-v3-entity-slice:${analysisRunId}:v9`,
  tweaks: {
    "ChatInput-KHUxC": { should_store_message: false },
    "ChatOutput-y3qVv": { should_store_message: false },
  },
});

console.log(JSON.stringify({ event: "started", flow_id: job.flow_id, job_id: job.job_id, status: job.status }));

for (let attempt = 0; attempt < 45; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const status = await client.status(job.job_id);
  if (["completed", "failed", "cancelled", "timed_out", "suspended"].includes(status.status)) {
    console.log(JSON.stringify({
      event: "terminal_or_suspended",
      job_id: job.job_id,
      status: status.status,
      errors: "errors" in status ? status.errors : undefined,
      output: "output" in status ? status.output : undefined,
    }));
    if (status.status === "suspended") {
      const pending = await client.pending(flowId);
      console.log(JSON.stringify({
        event: "pending",
        requests: pending.filter((item) => item.job_id === job.job_id),
      }));
    }
    process.exit(status.status === "completed" || status.status === "suspended" ? 0 : 1);
  }
}

throw new Error(`Timed out waiting for Langflow job ${job.job_id}`);
