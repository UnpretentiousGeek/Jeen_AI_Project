const server = process.env.LANGFLOW_SERVER_URL;
const apiKey = process.env.LANGFLOW_API_KEY;
const flowId = process.argv[2];

if (!server || !apiKey || !flowId) {
  throw new Error("LANGFLOW_SERVER_URL, LANGFLOW_API_KEY, and candidate flow id are required");
}

const headers = { "x-api-key": apiKey };
const response = await fetch(`${server}/api/v1/flows/${flowId}`, { headers });
const flow = await response.json();
if (!response.ok) throw new Error(`read flow failed: ${response.status}`);

const expectedNodes = new Set([
  "ChatInput-KHUxC",
  "CustomComponent-OckSC",
  "ChatOutput-y3qVv",
  "A2AAgent-miSab",
  "A2AAgent-Oqn3O",
  "A2AAgent-S6rQk",
  "A2AAgent-Mycq1",
  "CustomComponent-VktU7",
  "CustomComponent-Ff3Bj",
  "CustomComponent-R3wPw",
  "CustomComponent-Lqlq7",
  "CustomComponent-J52gM",
  "CustomComponent-V3wbU",
  "CustomComponent-j8peu",
  "CustomComponent-vbhrl",
  "CustomComponent-BPDV8",
  "CustomComponent-5y8kY",
  "CustomComponent-RUAEL",
  "ext:openai:OpenAIModelComponent@official-Rb4F8",
  "CustomComponent-ZZ7rq",
]);

const expectedEdges = new Set([
  "ChatInput-KHUxC.message->CustomComponent-OckSC.request",
  "CustomComponent-OckSC.run_state->CustomComponent-J52gM.input_value",
  "CustomComponent-OckSC.run_state->CustomComponent-RUAEL.run_state",
  "ext:openai:OpenAIModelComponent@official-Rb4F8.model_output->CustomComponent-J52gM.language_model",
  "A2AAgent-Mycq1.component_as_tool->CustomComponent-J52gM.specialist_tools",
  "A2AAgent-S6rQk.component_as_tool->CustomComponent-J52gM.specialist_tools",
  "A2AAgent-miSab.component_as_tool->CustomComponent-J52gM.specialist_tools",
  "A2AAgent-Oqn3O.component_as_tool->CustomComponent-J52gM.specialist_tools",
  "CustomComponent-V3wbU.component_as_tool->CustomComponent-J52gM.operation_tools",
  "CustomComponent-j8peu.component_as_tool->CustomComponent-J52gM.operation_tools",
  "CustomComponent-vbhrl.component_as_tool->CustomComponent-J52gM.operation_tools",
  "CustomComponent-BPDV8.component_as_tool->CustomComponent-J52gM.operation_tools",
  "CustomComponent-ZZ7rq.component_as_tool->CustomComponent-J52gM.operation_tools",
  "CustomComponent-Ff3Bj.component_as_tool->CustomComponent-J52gM.operation_tools",
  "CustomComponent-R3wPw.component_as_tool->CustomComponent-J52gM.operation_tools",
  "CustomComponent-5y8kY.component_as_tool->CustomComponent-J52gM.operation_tools",
  "CustomComponent-VktU7.component_as_tool->CustomComponent-J52gM.operation_tools",
  "CustomComponent-J52gM.final_token->CustomComponent-Lqlq7.input_value",
  "CustomComponent-Lqlq7.validated_snapshot->ChatOutput-y3qVv.input_value",
]);

const actualNodes = new Set(flow.data.nodes.map((node) => node.id));
const missingNodes = [...expectedNodes].filter((id) => !actualNodes.has(id));
const unexpectedNodes = [...actualNodes].filter((id) => !expectedNodes.has(id));

const edgeKey = (edge) => {
  const sourceOutput = edge.data?.sourceHandle?.name;
  const targetInput = edge.data?.targetHandle?.fieldName;
  return `${edge.source}.${sourceOutput}->${edge.target}.${targetInput}`;
};
const actualEdges = new Set(flow.data.edges.map(edgeKey));
const missingEdges = [...expectedEdges].filter((edge) => !actualEdges.has(edge));
const unexpectedEdges = [...actualEdges].filter((edge) => !expectedEdges.has(edge));

const agents = flow.data.nodes.filter((node) => node.data?.type === "Agent").map((node) => node.id);
const loops = flow.data.nodes.filter((node) => node.data?.type === "KybDurableCoordinatorV3");
const loop = flow.data.nodes.find((node) => node.id === "CustomComponent-J52gM");
const model = flow.data.nodes.find((node) => node.id === "ext:openai:OpenAIModelComponent@official-Rb4F8");
const memory = flow.data.nodes.find((node) => node.id === "CustomComponent-RUAEL");
const failures = [];

if (missingNodes.length) failures.push(`missing nodes: ${missingNodes.join(", ")}`);
if (unexpectedNodes.length) failures.push(`unexpected nodes: ${unexpectedNodes.join(", ")}`);
if (missingEdges.length) failures.push(`missing edges: ${missingEdges.join(", ")}`);
if (unexpectedEdges.length) failures.push(`unexpected edges: ${unexpectedEdges.join(", ")}`);
if (agents.length) failures.push(`Agent nodes remain: ${agents.join(", ")}`);
if (flow.data.edges.length !== 19) failures.push(`expected 19 edges, found ${flow.data.edges.length}`);
if (loops.length !== 1) failures.push(`expected one durable coordinator, found ${loops.length}`);
if (loop?.data?.type !== "KybDurableCoordinatorV3") failures.push("durable coordinator component type is missing");
if (!model) failures.push("dedicated Coordinator model component is missing");
if (memory?.data?.type !== "KybPostgresqlChatMemoryV3") failures.push("context-only PostgreSQL memory component is missing");
if (flow.data.edges.some((edge) => edge.source === "CustomComponent-RUAEL")) {
  failures.push("future chat-memory extension point must remain disconnected in Phase 2");
}
if (actualNodes.has("Agent-HEJJh") || actualNodes.has("Agent-ResumeV3")) failures.push("legacy Supervisor Agent node remains");

if (failures.length) {
  throw new Error(`Durable-loop graph verification failed:\n- ${failures.join("\n- ")}`);
}

console.log(JSON.stringify({
  flow_id: flow.id,
  name: flow.name,
  node_count: flow.data.nodes.length,
  edge_count: flow.data.edges.length,
  coordinator: loop.data.node.display_name,
}, null, 2));
