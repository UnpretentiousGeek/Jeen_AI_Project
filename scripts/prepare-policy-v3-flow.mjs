import fs from "node:fs";

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  throw new Error("usage: node scripts/prepare-policy-v3-flow.mjs INPUT OUTPUT");
}

const flow = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const retrievalCode = fs.readFileSync("langflow/components/policy_retrieval_v3.py", "utf8");
const validatorCode = fs.readFileSync("langflow/components/policy_validator_v3.py", "utf8");
const policyPrompt = fs.readFileSync("langflow/prompts/policy_agent_v3.md", "utf8");

const nodes = Object.fromEntries(flow.data.nodes.map((node) => [node.id, node]));
const chatInput = nodes["ChatInput-OwnershipV3"];
const retrieval = nodes["CustomComponent-OwnershipEvidenceV3"];
const agent = nodes["Agent-OwnershipV3"];
const validator = nodes["CustomComponent-OwnershipValidatorV3"];
const chatOutput = nodes["ChatOutput-OwnershipV3"];
if (![chatInput, retrieval, agent, validator, chatOutput].every(Boolean)) {
  throw new Error("duplicated Ownership V3 shell is missing an expected component");
}

flow.name = "KYB Policy V3";
flow.description = "Policy Specialist Contribution v3.2: run-pinned context/effective-date retrieval, requirement-to-evidence mapping, exception/conflict handling, and deterministic citation validation.";

chatInput.position = { x: 0, y: 0 };
chatInput.data.node.template.input_value.value = JSON.stringify({
  analysis_run_id: "a2000000-0000-4000-8000-000000000031",
  task_id: "policy-demo-31",
  context_id: "policy-demo-context-31",
  case_id: "31000000-0000-0000-0000-000000000031",
});
chatInput.data.node.template.should_store_message.value = false;

retrieval.position = { x: 480, y: 0 };
retrieval.data.type = "KybPolicyRetrieval";
retrieval.data.node.display_name = "Retrieve Applicable Policy";
retrieval.data.node.description = "Loads only run-pinned policy versions, applies context and effective-date filters, and prepares a deterministic requirement-to-evidence matrix.";
retrieval.data.node.icon = "book-open-check";
retrieval.data.node.output_types = ["Message"];
retrieval.data.node.outputs = [{
  types: ["Message"], selected: "Message", name: "policy_context", hidden: null,
  display_name: "Applicable Policy Envelope", method: "retrieve", value: "__UNDEFINED__",
  cache: true, required_inputs: null, allows_loop: false, loop_types: null,
  group_outputs: false, options: null, tool_mode: true,
}];
retrieval.data.node.template.code.value = retrievalCode;
retrieval.data.node.template.input_value.display_name = "Policy Task Reference";
retrieval.data.node.template.input_value.info = "JSON with analysis_run_id, task_id, context_id, and optional case_id.";
retrieval.data.node.template.database_url.info = "Private PostgreSQL connection used for pinned policy and case-evidence retrieval.";

agent.position = { x: 960, y: 0 };
agent.data.node.display_name = "Policy Agent — Structured Output";
agent.data.node.description = "Produces the versioned Policy Specialist Contribution with the Agent's built-in Structured Response output.";
agent.data.selected_output = "structured_response";
agent.data.node.template.system_prompt.value = policyPrompt;
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

flow.data.nodes = flow.data.nodes.filter((node) => node.id !== "CustomComponent-PolicyStructuredOutputV3");
validator.position = { x: 1440, y: 0 };
validator.data.type = "KybPolicyContributionValidator";
validator.data.node.display_name = "Validate Policy Contribution";
validator.data.node.description = "Independently verifies case/run scope, pinned versions, applicability, matrix integrity, exceptions, conflicts, locators, excerpts, and citation references.";
validator.data.node.icon = "shield-check";
validator.data.node.output_types = ["JSON"];
validator.data.node.outputs = [{
  types: ["JSON"], selected: "JSON", name: "validated", hidden: null,
  display_name: "Validated Policy Contribution", method: "validate", value: "__UNDEFINED__",
  cache: true, required_inputs: null, allows_loop: false, loop_types: null,
  group_outputs: false, options: null, tool_mode: true,
}];
validator.data.node.template.code.value = validatorCode;
validator.data.node.template.artifact.display_name = "Policy Specialist Contribution";
validator.data.node.template.database_url.info = "Private PostgreSQL connection used to independently verify the pinned run snapshot.";

chatOutput.position = { x: 1920, y: 0 };

const handle = (value) => `{${Object.entries(value).map(([key, item]) => {
  if (Array.isArray(item)) return `œ${key}œ:[${item.map((v) => `œ${v}œ`).join(",")}]`;
  return `œ${key}œ:œ${item}œ`;
}).join(",")}}`;

flow.data.edges = flow.data.edges.filter((edge) =>
  edge.source !== "CustomComponent-PolicyStructuredOutputV3"
  && edge.target !== "CustomComponent-PolicyStructuredOutputV3"
  && !(edge.source === agent.id && edge.target === validator.id)
);
for (const edge of flow.data.edges) {
  if (edge.source === retrieval.id && edge.target === agent.id) {
    const source = { dataType: "KybPolicyRetrieval", id: retrieval.id, name: "policy_context", output_types: ["Message"] };
    edge.data.sourceHandle = source;
    edge.sourceHandle = handle(source);
  }
  if (edge.source === validator.id && edge.target === chatOutput.id) {
    const source = { dataType: "KybPolicyContributionValidator", id: validator.id, name: "validated", output_types: ["JSON"] };
    edge.data.sourceHandle = source;
    edge.sourceHandle = handle(source);
  }
}

if (!flow.data.edges.some((edge) => edge.source === retrieval.id && edge.target === agent.id)) {
  const retrievalSource = { dataType: "KybPolicyRetrieval", id: retrieval.id, name: "policy_context", output_types: ["Message"] };
  const agentTarget = { fieldName: "input_value", id: agent.id, inputTypes: ["Message"], type: "str" };
  flow.data.edges.push({
    animated: false, className: "", selected: false,
    id: "edge-policy-retrieval-agent",
    source: retrieval.id, target: agent.id,
    sourceHandle: handle(retrievalSource), targetHandle: handle(agentTarget),
    data: { sourceHandle: retrievalSource, targetHandle: agentTarget },
  });
}

const agentSource = { dataType: "Agent", id: agent.id, name: "structured_response", output_types: ["Data", "JSON"] };
const validatorTarget = { fieldName: "artifact", id: validator.id, inputTypes: ["Data", "JSON", "Message"], type: "other" };
flow.data.edges.push({
  animated: false, className: "", selected: false,
  id: "edge-policy-agent-validator",
  source: agent.id, target: validator.id,
  sourceHandle: handle(agentSource), targetHandle: handle(validatorTarget),
  data: { sourceHandle: agentSource, targetHandle: validatorTarget },
});

fs.writeFileSync(outputPath, JSON.stringify(flow));
