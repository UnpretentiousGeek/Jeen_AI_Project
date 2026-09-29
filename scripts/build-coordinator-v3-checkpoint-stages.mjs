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

const stages = {
  "CustomComponent-049fQ": "langflow/components/kyb_human_checkpoint_v3.py",
  "CustomComponent-Lqlq7": "langflow/components/kyb_final_snapshot_validator_v3.py",
};
const stageLabels = {
  "CustomComponent-049fQ": "4 · Human Checkpoint Tools V3",
  "CustomComponent-Lqlq7": "7 · Final Snapshot Validator V3",
};

for (const [componentId, sourcePath] of Object.entries(stages)) {
  const node = flow.data.nodes.find((candidate) => candidate.id === componentId);
  if (!node) throw new Error(`component not found: ${componentId}`);

  const code = await readFile(sourcePath, "utf8");
  const buildResponse = await fetch(`${server}/api/v1/custom_component`, {
    method: "POST",
    headers,
    body: JSON.stringify({ code, frontend_node: node.data.node }),
  });
  const built = await buildResponse.json();
  if (!buildResponse.ok) {
    throw new Error(`build ${componentId} failed: ${buildResponse.status} ${JSON.stringify(built)}`);
  }

  node.data.node = built.data;
  node.data.type = built.type;
  node.data.node.display_name = stageLabels[componentId];
}

const supervisor = flow.data.nodes.find((node) => node.id === "Agent-HEJJh");
if (!supervisor) throw new Error("Coordinator Supervisor component not found");
supervisor.data.id = "Agent-HEJJh";
supervisor.data.node.display_name = "2 · Coordinator Supervisor";
supervisor.data.node.template.system_prompt.value = await readFile(
  "langflow/prompts/coordinator_supervisor_v3.md",
  "utf8",
);
supervisor.data.node.template.max_iterations.value = 16;
const supervisorSchema = supervisor.data.node.template.output_schema.value;
for (const field of supervisorSchema) {
  if (field.name === "active_human_checkpoint") {
    field.description = (
      "Exact requested checkpoint object. If the task objective explicitly requests a checkpoint, "
      + "this must contain checkpoint_kind, request_id, and prompt; otherwise use an empty object."
    );
  } else if (field.name === "human_checkpoint_result") {
    field.description = "Exact persisted human checkpoint result, or an empty object before a decision.";
  } else if (field.name === "review_decision") {
    field.description = (
      "Must be an empty string. This transport value is canonicalized to null because the coordinator "
      + "cannot make the Review Decision."
    );
  }
}
const structuredResponse = supervisor.data.node.outputs.find(
  (output) => output.name === "structured_response",
);
if (!structuredResponse) throw new Error("Coordinator Supervisor structured output not found");
structuredResponse.allows_loop = false;

const context = flow.data.nodes.find((node) => node.id === "CustomComponent-OckSC");
const human = flow.data.nodes.find((node) => node.id === "CustomComponent-049fQ");
const finalValidator = flow.data.nodes.find((node) => node.id === "CustomComponent-Lqlq7");
if (!context || !human || !finalValidator) throw new Error("checkpoint components not found");

const resumeSupervisorId = "Agent-ResumeV3";
flow.data.nodes = flow.data.nodes.filter(
  (node) =>
    !["CustomComponent-jJ4bS", "CustomComponent-uwKai", resumeSupervisorId].includes(node.id),
);
const resumeSupervisor = structuredClone(supervisor);
resumeSupervisor.id = resumeSupervisorId;
resumeSupervisor.data.id = resumeSupervisorId;
resumeSupervisor.position = {
  x: supervisor.position.x + 420,
  y: supervisor.position.y + 420,
};
resumeSupervisor.data.node.display_name = "2b · Coordinator Resume Supervisor";
resumeSupervisor.data.node.description = (
  "Consumes a persisted human-checkpoint result and produces the post-resume structured snapshot."
);
resumeSupervisor.data.node.template.system_prompt.value = await readFile(
  "langflow/prompts/coordinator_resume_supervisor_v3.md",
  "utf8",
);
// Langflow's no-tool Agent path sends nested output schemas to the model's native
// response_format API, which rejects the generated schema. The initial Supervisor
// keeps its structured output; this resume-only pass emits one JSON Message that the
// persisted-state validator checks field-by-field.
resumeSupervisor.data.node.template.output_schema.value = [];
resumeSupervisor.data.selected_output = "response";
flow.data.nodes.push(resumeSupervisor);

const routedPairs = new Set([
  "CustomComponent-OckSC:Agent-HEJJh",
  "CustomComponent-049fQ:Agent-HEJJh",
  "CustomComponent-049fQ:CustomComponent-Lqlq7",
  `CustomComponent-049fQ:${resumeSupervisorId}`,
  `${resumeSupervisorId}:CustomComponent-Lqlq7`,
]);
flow.data.edges = flow.data.edges.filter(
  (edge) =>
    !routedPairs.has(`${edge.source}:${edge.target}`)
    && !["CustomComponent-jJ4bS", "CustomComponent-uwKai", resumeSupervisorId].includes(edge.source)
    && !["CustomComponent-jJ4bS", "CustomComponent-uwKai", resumeSupervisorId].includes(edge.target),
);

function encodedHandle(value) {
  return JSON.stringify(value).replaceAll('"', "œ");
}

function addEdge(sourceId, sourceOutput, targetId, targetInput) {
  const sourceNode = flow.data.nodes.find((node) => node.id === sourceId);
  const targetNode = flow.data.nodes.find((node) => node.id === targetId);
  const output = sourceNode?.data.node.outputs.find((candidate) => candidate.name === sourceOutput);
  const input = targetNode?.data.node.template[targetInput];
  if (!sourceNode || !targetNode || !output || !input) {
    throw new Error(`cannot connect ${sourceId}.${sourceOutput} -> ${targetId}.${targetInput}`);
  }
  const sourceHandle = {
    dataType: sourceNode.data.type,
    id: sourceId,
    name: sourceOutput,
    output_types: output.types,
  };
  const targetHandle = {
    fieldName: targetInput,
    id: targetId,
    inputTypes: input.input_types,
    type: input.type,
  };
  const encodedSourceHandle = encodedHandle(sourceHandle);
  const encodedTargetHandle = encodedHandle(targetHandle);
  flow.data.edges.push({
    source: sourceId,
    sourceHandle: encodedSourceHandle,
    target: targetId,
    targetHandle: encodedTargetHandle,
    data: { sourceHandle, targetHandle },
    id: `reactflow__edge-${sourceId}${encodedSourceHandle}-${targetId}${encodedTargetHandle}`,
    selected: false,
    animated: false,
    className: "",
  });
}

addEdge("CustomComponent-OckSC", "run_state", "Agent-HEJJh", "input_value");
addEdge("CustomComponent-049fQ", "resume_to_supervisor", resumeSupervisorId, "input_value");
addEdge(resumeSupervisorId, "response", "CustomComponent-Lqlq7", "input_value");

const directEdge = flow.data.edges.find(
  (edge) =>
    edge.source === "Agent-HEJJh" &&
    edge.target === "ChatOutput-y3qVv",
);
if (directEdge) throw new Error("temporary Agent-to-Chat Output edge still exists");

const update = await fetch(`${server}/api/v1/flows/${flowId}`, {
  method: "PUT",
  headers,
  body: JSON.stringify(flow),
});
const saved = await update.json();
if (!update.ok) throw new Error(`update flow failed: ${update.status} ${JSON.stringify(saved)}`);

console.log(
  JSON.stringify({
    flow_id: saved.id,
    stages: saved.data.nodes
      .filter((node) => stages[node.id] || node.id === resumeSupervisorId)
      .map((node) => ({
        id: node.id,
        type: node.data.type,
        display_name: node.data.node.display_name,
        inputs: Object.keys(node.data.node.template).filter((key) => key !== "code" && key !== "_type"),
        outputs: node.data.node.outputs.map((output) => output.name),
      })),
  }),
);
