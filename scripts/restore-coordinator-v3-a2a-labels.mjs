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

const labels = {
  "A2AAgent-Mycq1": ["run_entity_agent · KYB Entity V3", "run_entity_agent", "RunEntityAgentA2A", "Call the internal KYB Entity V3 specialist with the exact persisted task envelope."],
  "A2AAgent-S6rQk": ["run_ownership_agent · KYB Ownership V3", "run_ownership_agent", "RunOwnershipAgentA2A", "Call the internal KYB Ownership V3 specialist with the exact persisted task envelope."],
  "A2AAgent-miSab": ["run_policy_agent · KYB Policy V3", "run_policy_agent", "RunPolicyAgentA2A", "Call the internal KYB Policy V3 specialist with the exact persisted task envelope."],
  "A2AAgent-Oqn3O": ["run_public_research_agent · KYB Public Research V3", "run_public_research_agent", "RunPublicResearchAgentA2A", "Call the internal KYB Public Research V3 specialist only with accepted immutable research results."],
};

for (const node of flow.data.nodes) {
  const configuration = labels[node.id];
  if (!configuration) continue;
  const [displayName, toolName, componentName, description] = configuration;
  node.data.node.display_name = displayName;
  const codeField = node.data.node.template?.code;
  if (codeField) {
    let code = codeField.value;
    code = code
      .replace(/display_name = "(?:A2A Agent|run_[^"]+ · KYB [^"]+ V3)"/, `display_name = "${displayName}"`)
      .replace(/name = "(?:A2AAgent|Run\w+AgentA2A)"/, `name = "${componentName}"`)
      .replace('method="send_to_agent"', `method="${toolName}"`)
      .replace('async def send_to_agent(self)', `async def ${toolName}(self)`);
    const methodMarker = `    async def ${toolName}(self) -> Message:`;
    if (!code.includes("async def to_toolkit(self):") && code.includes(methodMarker)) {
      code = code.replace(
        methodMarker,
        `    async def to_toolkit(self):\n        \"\"\"Expose code-derived tool names; each specialist remains unambiguous.\"\"\"\n        return await self._get_tools()\n\n${methodMarker}`,
      );
    }
    codeField.value = code;
  }
  const metadata = node.data.node.template?.tools_metadata;
  if (metadata) {
    metadata.value = [{
      name: toolName,
      description,
      tags: [toolName],
      status: true,
      approval_actions: [],
      display_name: toolName,
      display_description: description,
      readonly: false,
      args: {
        input_value: {
          description: "The exact persisted specialist task envelope as JSON.",
          title: "Input Value",
          type: "string",
        },
      },
    }];
  }
}

const update = await fetch(`${server}/api/v1/flows/${flowId}`, {
  method: "PUT",
  headers,
  body: JSON.stringify(flow),
});
if (!update.ok) throw new Error(`update flow failed: ${update.status}`);
const saved = await update.json();
console.log(JSON.stringify({
  flow_id: saved.id,
  labels: saved.data.nodes
    .filter((node) => labels[node.id])
    .map((node) => ({ id: node.id, display_name: node.data.node.display_name })),
}));
