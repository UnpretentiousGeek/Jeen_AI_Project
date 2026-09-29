import { z } from "zod";
import { type AgentCard } from "@a2a-js/sdk";

const agentCardSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  supportedInterfaces: z.array(z.object({
    url: z.url(),
    protocolBinding: z.string().min(1),
    tenant: z.string(),
    protocolVersion: z.string().min(1),
  })).min(1),
  provider: z.object({
    url: z.url(),
    organization: z.string().min(1),
  }).optional(),
  version: z.string().min(1),
  documentationUrl: z.url().optional(),
  capabilities: z.object({
    streaming: z.boolean().optional(),
    pushNotifications: z.boolean().optional(),
    extensions: z.array(z.unknown()),
    extendedAgentCard: z.boolean().optional(),
  }),
  securitySchemes: z.record(z.string(), z.unknown()),
  securityRequirements: z.array(z.unknown()),
  defaultInputModes: z.array(z.string().min(1)).min(1),
  defaultOutputModes: z.array(z.string().min(1)).min(1),
  skills: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    tags: z.array(z.string()),
    examples: z.array(z.string()),
    inputModes: z.array(z.string()),
    outputModes: z.array(z.string()),
    securityRequirements: z.array(z.unknown()),
  })).min(1),
  signatures: z.array(z.unknown()),
  iconUrl: z.url().optional(),
});

export interface AllowedAgent {
  name: string;
  version: string;
  cardUrl: string;
  endpointUrl: string;
  skillId: string;
}

export type ValidatedAgentCard = AgentCard;

interface ResolveAgentOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxCardBytes?: number;
}

export async function resolveAllowlistedAgent(
  allowed: AllowedAgent,
  options: ResolveAgentOptions = {},
): Promise<ValidatedAgentCard> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(allowed.cardUrl, {
    headers: { "A2A-Version": "1.0" },
    signal: AbortSignal.timeout(options.timeoutMs ?? 2_000),
  });

  if (!response.ok) {
    throw new Error(`agent card request failed with HTTP ${response.status}`);
  }

  const text = await response.text();
  if (Buffer.byteLength(text) > (options.maxCardBytes ?? 64 * 1024)) {
    throw new Error("agent card exceeds the configured size limit");
  }

  const card = agentCardSchema.parse(JSON.parse(text));
  if (card.name !== allowed.name || card.version !== allowed.version) {
    throw new Error("agent card identity is not allowlisted");
  }

  const compatibleInterface = card.supportedInterfaces.find((candidate) =>
    candidate.url === allowed.endpointUrl
    && candidate.protocolBinding === "JSONRPC"
    && candidate.protocolVersion === "1.0"
  );
  if (compatibleInterface === undefined) {
    throw new Error("agent card does not expose the allowlisted A2A v1 JSON-RPC endpoint");
  }

  if (!card.skills.some((skill) => skill.id === allowed.skillId)) {
    throw new Error(`agent card does not provide required skill ${allowed.skillId}`);
  }

  return card as AgentCard;
}
