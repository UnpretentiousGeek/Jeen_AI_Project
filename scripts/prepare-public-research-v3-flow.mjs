import fs from "node:fs";

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  throw new Error("usage: node scripts/prepare-public-research-v3-flow.mjs INPUT OUTPUT");
}

const flow = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const scopeCode = fs.readFileSync("langflow/components/public_research_scope_v3.py", "utf8");
const validatorCode = fs.readFileSync("langflow/components/public_research_validator_v3.py", "utf8");
const agentPrompt = fs.readFileSync("langflow/prompts/public_research_agent_v3.md", "utf8");

const old = Object.fromEntries(flow.data.nodes.map((node) => [node.id, node]));
const chatInput = old["ChatInput-OwnershipV3"];
const scope = old["CustomComponent-OwnershipEvidenceV3"];
const agent = old["Agent-OwnershipV3"];
const structured = old["CustomComponent-PolicyStructuredOutputV3"];
const validator = old["CustomComponent-OwnershipValidatorV3"];
const chatOutput = old["ChatOutput-OwnershipV3"];
if (![chatInput, scope, agent, validator, chatOutput].every(Boolean)) {
  throw new Error("Policy V3 shell is missing an expected component");
}

const rename = (node, id) => {
  node.id = id;
  node.data.id = id;
};
rename(chatInput, "ChatInput-PublicResearchV3");
rename(scope, "CustomComponent-PublicResearchScopeV3");
rename(agent, "Agent-PublicResearchV3");
rename(validator, "CustomComponent-PublicResearchValidatorV3");
rename(chatOutput, "ChatOutput-PublicResearchV3");
flow.data.nodes = flow.data.nodes.filter((node) => node !== structured);

flow.name = "KYB Public Research V3";
flow.description = "Public Research Specialist Contribution v3.3: documented-gap proposals and claim-specific analysis of immutable analyst-accepted web results with deterministic scope and citation validation.";
flow.flow_type = "agent";
flow.a2a_enabled = true;
flow.a2a_card_overrides = {
  description: "Produces bounded public-research proposals or analyzes separately accepted immutable web results. It never executes unrestricted search or makes review decisions.",
  tags: ["kyb", "public-research", "accepted-web-evidence"],
  examples: [
    "Propose an exact official-domain query for a documented licensing evidence gap.",
    "Assess a licensing claim using only immutable analyst-accepted results.",
  ],
};
delete flow.id;
delete flow.user_id;
delete flow.updated_at;

chatInput.position = { x: 0, y: 0 };
chatInput.data.node.template.input_value.value = JSON.stringify({
  operation_mode: "propose_research",
  analysis_run_id: "a3000000-0000-4000-8000-000000000041",
  task_id: "public-research-proposal-41",
  context_id: "public-research-context-41",
  case_id: "32000000-0000-0000-0000-000000000041",
  evidence_gap_id: "b3000000-0000-4000-8000-000000000041",
});
chatInput.data.node.template.should_store_message.value = false;

scope.position = { x: 480, y: 0 };
scope.data.type = "KybPublicResearchScope";
scope.data.node.display_name = "Scope Public Research Operation";
scope.data.node.description = "Validates task/case/run/mode, then reads one documented gap or separately reviewed immutable results within the exact approved plan.";
scope.data.node.icon = "search-check";
scope.data.node.output_types = ["Message"];
scope.data.node.outputs = [{
  types: ["Message"], selected: "Message", name: "research_context", hidden: null,
  display_name: "Validated Research Envelope", method: "prepare", value: "__UNDEFINED__",
  cache: true, required_inputs: null, allows_loop: false, loop_types: null,
  group_outputs: false, options: null, tool_mode: true,
}];
scope.data.node.template.code.value = scopeCode;
scope.data.node.template.input_value.display_name = "Public Research Task";
scope.data.node.template.input_value.info = "JSON with operation_mode, analysis_run_id, task_id, context_id, case_id, and the mode-specific reference.";
scope.data.node.template.database_url.info = "Private PostgreSQL connection used for gap, approval, immutable result, and review-state validation.";

agent.position = { x: 960, y: 0 };
agent.data.node.display_name = "Public Research Agent — Structured Contribution";
agent.data.node.description = "Produces one versioned specialist contribution with the Agent's built-in Structured Response output.";
agent.data.selected_output = "structured_response";
agent.data.node.template.system_prompt.value = agentPrompt;
agent.data.node.template.add_calculator_tool.value = false;
agent.data.node.template.add_current_date_tool.value = false;
agent.data.node.template.max_iterations.value = 3;
agent.data.node.template.output_schema.show = true;
agent.data.node.template.output_schema.value = [{
  name: "contribution_json",
  description: "JSON-serialized copy of the complete expected_contribution object, preserving every field and value exactly.",
  type: "str",
  multiple: false,
}];
agent.data.node.template.format_instructions.show = true;
agent.data.node.template.format_instructions.value = "Return exactly one structured record. Set contribution_json to a JSON-serialized copy of expected_contribution. Preserve every field and value exactly; do not summarize, omit, rename, or add fields.";
const nativePreference = "prefer_native=not has_tools,";
if (agent.data.node.template.code.value.includes(nativePreference)) {
  agent.data.node.template.code.value = agent.data.node.template.code.value.replace(
    nativePreference,
    "prefer_native=False,  # Langflow 1.12.2 emits an OpenAI-invalid strict schema.",
  );
} else if (!agent.data.node.template.code.value.includes("prefer_native=False,")) {
  throw new Error("Agent code no longer exposes the Structured Response strategy selector");
}

validator.position = { x: 1440, y: 0 };
validator.data.type = "KybPublicResearchContributionValidator";
validator.data.node.display_name = "Validate Public Research Contribution";
validator.data.node.description = "Independently rejects cross-run scope, altered plans, unaccepted results, and fabricated or altered public-web citations.";
validator.data.node.icon = "shield-check";
validator.data.node.output_types = ["JSON"];
validator.data.node.outputs = [{
  types: ["JSON"], selected: "JSON", name: "validated", hidden: null,
  display_name: "Validated Public Research Contribution", method: "validate", value: "__UNDEFINED__",
  cache: true, required_inputs: null, allows_loop: false, loop_types: null,
  group_outputs: false, options: null, tool_mode: true,
}];
validator.data.node.template.code.value = validatorCode;
validator.data.node.template.artifact.display_name = "Public Research Specialist Contribution";
validator.data.node.template.database_url.info = "Private PostgreSQL connection used to independently verify case/run scope, result review, and exact citations.";

chatOutput.position = { x: 1920, y: 0 };

const handle = (value) => `{${Object.entries(value).map(([key, item]) => {
  if (Array.isArray(item)) return `œ${key}œ:[${item.map((v) => `œ${v}œ`).join(",")}]`;
  return `œ${key}œ:œ${item}œ`;
}).join(",")}}`;
const edge = (id, sourceNode, targetNode, source, target) => ({
  animated: false, className: "", selected: false, id,
  source: sourceNode.id, target: targetNode.id,
  sourceHandle: handle(source), targetHandle: handle(target),
  data: { sourceHandle: source, targetHandle: target },
});

const inputSource = { dataType: "ChatInput", id: chatInput.id, name: "message", output_types: ["Message"] };
const scopeTarget = { fieldName: "input_value", id: scope.id, inputTypes: ["Message"], type: "str" };
const scopeSource = { dataType: "KybPublicResearchScope", id: scope.id, name: "research_context", output_types: ["Message"] };
const agentTarget = { fieldName: "input_value", id: agent.id, inputTypes: ["Message"], type: "str" };
const agentSource = { dataType: "Agent", id: agent.id, name: "structured_response", output_types: ["Data", "JSON"] };
const validatorTarget = { fieldName: "artifact", id: validator.id, inputTypes: ["Data", "JSON", "Message"], type: "other" };
const validatorSource = { dataType: "KybPublicResearchContributionValidator", id: validator.id, name: "validated", output_types: ["JSON"] };
const outputTarget = { fieldName: "input_value", id: chatOutput.id, inputTypes: ["Data", "Message", "DataFrame", "Any"], type: "other" };
const scopeAgentEdge = edge("edge-public-research-scope-agent", scope, agent, scopeSource, agentTarget);
scopeAgentEdge.id = `reactflow__edge-${scope.id}${scopeAgentEdge.sourceHandle}-${agent.id}${scopeAgentEdge.targetHandle}`;
flow.data.edges = [
  edge("edge-public-research-input-scope", chatInput, scope, inputSource, scopeTarget),
  scopeAgentEdge,
  edge("edge-public-research-agent-validator", agent, validator, agentSource, validatorTarget),
  edge("edge-public-research-validator-output", validator, chatOutput, validatorSource, outputTarget),
];

fs.writeFileSync(outputPath, JSON.stringify(flow));
