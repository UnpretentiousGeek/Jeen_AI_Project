import { readFile } from "node:fs/promises";

const server = process.env.LANGFLOW_SERVER_URL;
const apiKey = process.env.LANGFLOW_API_KEY;
const flowId = process.argv[2];
if (!server || !apiKey || !flowId) {
  throw new Error("LANGFLOW_SERVER_URL, LANGFLOW_API_KEY, and flow id are required");
}

const headers = { "x-api-key": apiKey, "content-type": "application/json" };
const response = await fetch(`${server}/api/v1/flows/${flowId}`, { headers });
const flow = await response.json();
if (!response.ok) throw new Error(`read flow failed: ${response.status}`);

const components = {
  "CustomComponent-049fQ": ["langflow/components/kyb_human_checkpoint_v3.py", "4 · Human Checkpoint Tools V3"],
  "CustomComponent-Lqlq7": ["langflow/components/kyb_final_snapshot_validator_v3.py", "7 · Final Snapshot Validator V3"],
  "CustomComponent-Ff3Bj": ["langflow/components/kyb_tinyfish_search_v3.py", "5a · TinyFish Search V3"],
  "CustomComponent-R3wPw": ["langflow/components/kyb_tinyfish_fetch_v3.py", "5b · TinyFish Fetch V3"],
  "CustomComponent-VktU7": ["langflow/components/kyb_approved_action_executor_v3.py", "6 · Approved Action Executor V3"],
  "CustomComponent-kamRp": ["langflow/components/kyb_specialist_contribution_gate_v3.py", "3b · Specialist Contribution Gate V3"],
};

for (const [componentId, [sourcePath, label]] of Object.entries(components)) {
  const node = flow.data.nodes.find((candidate) => candidate.id === componentId);
  if (!node) throw new Error(`component not found: ${componentId}`);
  const code = await readFile(sourcePath, "utf8");
  const builtResponse = await fetch(`${server}/api/v1/custom_component`, {
    method: "POST",
    headers,
    body: JSON.stringify({ code, frontend_node: node.data.node }),
  });
  const built = await builtResponse.json();
  if (!builtResponse.ok) {
    throw new Error(`build ${componentId} failed: ${builtResponse.status} ${JSON.stringify(built)}`);
  }
  node.data.node = built.data;
  node.data.type = built.type;
  node.data.node.display_name = label;
  for (const [field, variable] of [["database_url", "DATABASE_URL"], ["tinyfish_key", "TINY_FISH_KEY"]]) {
    if (node.data.node.template[field]) {
      node.data.node.template[field].value = variable;
      node.data.node.template[field].load_from_db = true;
    }
  }
}

const initial = flow.data.nodes.find((node) => node.id === "Agent-HEJJh");
const resume = flow.data.nodes.find((node) => node.id === "Agent-ResumeV3");
if (!initial || !resume || resume.data.id !== "Agent-ResumeV3") {
  throw new Error("Supervisor identities do not match the repaired live graph");
}
initial.data.node.template.system_prompt.value = await readFile("langflow/prompts/coordinator_supervisor_v3.md", "utf8");
initial.data.node.template.output_schema.value = [
  { name: "schema_version", description: "Coordinator snapshot schema version.", type: "str", multiple: false },
  { name: "analysis_run_id", description: "Exact persisted Analysis Run ID.", type: "str", multiple: false },
  { name: "case_id", description: "Exact persisted case ID.", type: "str", multiple: false },
  { name: "coordinator_status", description: "Exact persisted coordinator status.", type: "str", multiple: false },
  { name: "iteration", description: "Exact persisted coordinator iteration.", type: "int", multiple: false },
  { name: "coordinator_plan", description: "Exact persisted Coordinator Plan object.", type: "dict", multiple: false },
  {
    name: "selected_specialist_and_reason",
    description: "Selected specialist and concise reason, or an empty object.",
    type: "dict",
    multiple: false,
  },
  {
    name: "validated_contributions",
    description: "Only specialist contributions accepted by the contribution gate.",
    type: "dict",
    multiple: true,
  },
  { name: "evidence_gaps", description: "Persisted or validated evidence gaps.", type: "dict", multiple: true },
  { name: "conflicts", description: "Persisted or validated conflicts.", type: "dict", multiple: true },
  {
    name: "active_human_checkpoint",
    description: (
      "Exact requested checkpoint object. If the task objective explicitly requests a checkpoint, "
      + "this must contain checkpoint_kind, request_id, and prompt; otherwise use an empty object."
    ),
    type: "dict",
    multiple: false,
  },
  {
    name: "human_checkpoint_result",
    description: "Exact persisted human checkpoint result, or an empty object before a decision.",
    type: "dict",
    multiple: false,
  },
  { name: "proposed_action", description: "Bounded proposed action, or an empty object.", type: "dict", multiple: false },
  {
    name: "review_decision",
    description: "Must be an empty string; the coordinator cannot make the Review Decision.",
    type: "str",
    multiple: false,
  },
  { name: "terminal", description: "Exact persisted terminal flag.", type: "bool", multiple: false },
];
initial.data.selected_output = "structured_response";
resume.data.node.template.system_prompt.value = await readFile("langflow/prompts/coordinator_resume_supervisor_v3.md", "utf8");
resume.data.node.template.max_iterations.value = 24;
resume.data.node.template.output_schema.value = [];
resume.data.selected_output = "response";

// Both Human Checkpoint outputs previously fed separate downstream branches that
// reconverged at the final validator. On resume, Langflow could start the Agent
// branch while the checkpoint vertex was still rebuilding. Keep one routed path:
// Human Checkpoint -> Resume Supervisor -> Final Validator.
flow.data.edges = flow.data.edges.filter((edge) => !(
  edge.source === "CustomComponent-049fQ"
  && edge.data?.sourceHandle?.name === "continue_to_final"
  && edge.target === "CustomComponent-Lqlq7"
));

const requiredEdges = [
  ["CustomComponent-049fQ", "resume_to_supervisor", "Agent-ResumeV3", "input_value"],
  ["Agent-ResumeV3", "response", "CustomComponent-Lqlq7", "input_value"],
];
for (const [source, output, target, input] of requiredEdges) {
  const found = flow.data.edges.some((edge) =>
    edge.source === source && edge.target === target
    && edge.data?.sourceHandle?.name === output && edge.data?.targetHandle?.fieldName === input);
  if (!found) throw new Error(`required repaired edge is missing: ${source}.${output} -> ${target}.${input}`);
}

const update = await fetch(`${server}/api/v1/flows/${flowId}`, {
  method: "PUT",
  headers,
  body: JSON.stringify(flow),
});
const saved = await update.json();
if (!update.ok) throw new Error(`update flow failed: ${update.status} ${JSON.stringify(saved)}`);

console.log(JSON.stringify({
  flow_id: saved.id,
  components: saved.data.nodes.filter((node) => components[node.id]).map((node) => ({
    id: node.id,
    type: node.data.type,
    display_name: node.data.node.display_name,
    outputs: node.data.node.outputs.map((output) => output.name),
  })),
  repaired_edges_preserved: requiredEdges,
}, null, 2));
