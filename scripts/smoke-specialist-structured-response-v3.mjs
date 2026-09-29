import fs from "node:fs";

const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8")
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => {
      const index = line.indexOf("=");
      return [line.slice(0, index), line.slice(index + 1)];
    }),
);
const server = env.LANGFLOW_SERVER_URL;
const apiKey = env.LANGFLOW_API_KEY;
if (!server || !apiKey) throw new Error("LANGFLOW_SERVER_URL and LANGFLOW_API_KEY are required in .env.local");
const headers = { "x-api-key": apiKey, "content-type": "application/json" };

function contribution(body) {
  const text = body.outputs?.[0]?.outputs?.[0]?.results?.message?.data?.text;
  if (typeof text !== "string") throw new Error("Langflow response has no final message text");
  return JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
}

async function run(flowId, request) {
  const response = await fetch(`${server}/api/v1/run/${flowId}`, {
    method: "POST",
    headers,
    body: JSON.stringify(request),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`flow ${flowId} failed: ${response.status} ${body.detail || "unknown error"}`);
  return contribution(body);
}

const policy = await run("623b5639-b4be-4e2e-bba3-65e5a3158a6d", {
  input_value: JSON.stringify({
    analysis_run_id: "a2000000-0000-4000-8000-000000000031",
    task_id: `policy-structured-smoke-${Date.now()}`,
    context_id: `policy-structured-smoke-context-${Date.now()}`,
    case_id: "31000000-0000-0000-0000-000000000031",
  }),
  input_type: "chat",
  output_type: "chat",
});

const nonce = Date.now();
const publicResearch = await run("eaccfa78-adb0-4119-810a-ab141417dafb", {
  input_request: {
    input_value: JSON.stringify({
      operation_mode: "propose_research",
      analysis_run_id: "a3000000-0000-4000-8000-000000000041",
      task_id: `public-research-structured-smoke-${nonce}`,
      context_id: `public-research-structured-smoke-context-${nonce}`,
      case_id: "32000000-0000-0000-0000-000000000041",
      evidence_gap_id: "b3000000-0000-4000-8000-000000000041",
    }),
    input_type: "chat",
    output_type: "chat",
    session_id: `public-research-structured-smoke-${nonce}`,
  },
});

for (const [name, value] of [["policy", policy], ["public_research", publicResearch]]) {
  if (value?.deterministic_validation?.outcome !== "accepted") {
    throw new Error(`${name} contribution was not deterministically accepted`);
  }
  console.log(JSON.stringify({
    specialist: name,
    contribution_id: value.contribution_id,
    status: value.status,
    validation: value.deterministic_validation.outcome,
  }));
}
