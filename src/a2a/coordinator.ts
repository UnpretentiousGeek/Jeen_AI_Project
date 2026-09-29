import {
  type SendMessageResult,
  type Task,
  Role,
  TaskState,
} from "@a2a-js/sdk";
import { ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { type ZodType } from "zod";

import {
  type SpecialistArtifact,
  parseSpecialistArtifact,
} from "../contracts/specialist-artifact.js";
import {
  type AllowedAgent,
  resolveAllowlistedAgent,
} from "./agent-card.js";
import { type EntityTaskInput, entityTaskInputSchema } from "./entity-contract.js";
import { type OwnershipTaskInput, ownershipTaskInputSchema } from "./ownership-contract.js";
import { type PolicyTaskInput, policyTaskInputSchema } from "./policy-contract.js";
import {
  type PublicResearchTaskInput,
  publicResearchTaskInputSchema,
} from "./public-research-contract.js";
import { type EvidenceScopedTaskInput } from "./task-contract.js";

export type InternalSpecialty = "entity" | "ownership" | "policy";
export type SpecialistSpecialty = InternalSpecialty | "public_research";

function isTask(result: SendMessageResult): result is Task {
  return "artifacts" in result && "status" in result;
}

function artifactData(task: Task): unknown {
  const dataPart = task.artifacts
    .flatMap((artifact) => artifact.parts)
    .find((part) => part.content?.$case === "data");

  if (dataPart?.content?.$case !== "data") {
    throw new Error("A2A task completed without a structured artifact");
  }

  return dataPart.content.value;
}

export function validateSpecialistArtifactScope(
  artifact: SpecialistArtifact,
  input: EvidenceScopedTaskInput,
  task: Task,
  allowedAgent: AllowedAgent,
  expectedSpecialty: InternalSpecialty,
): void {
  if (artifact.analysis_run_id !== input.analysis_run_id) {
    throw new Error("specialist artifact references a different analysis run");
  }
  if (artifact.task_id !== task.id || artifact.context_id !== task.contextId) {
    throw new Error("specialist artifact task provenance does not match the A2A task");
  }
  if (artifact.agent.name !== allowedAgent.name || artifact.agent.version !== allowedAgent.version) {
    throw new Error("specialist artifact agent identity does not match the allowlisted card");
  }
  if (artifact.specialty !== expectedSpecialty) {
    throw new Error(`specialist artifact returned ${artifact.specialty} for ${expectedSpecialty} dispatch`);
  }

  const allowedSources = new Set([
    ...input.case_evidence.map((citation) => `case_document:${citation.source_id}:${citation.chunk_id}`),
    ...input.policy_evidence.map((citation) => `policy:${citation.source_id}:${citation.chunk_id}`),
    ...(input.human_input_evidence ?? []).map((citation) => `human_input:${citation.source_id}`),
  ]);
  for (const citation of artifact.citations) {
    if (citation.source_kind === "external_web") {
      throw new Error(`${expectedSpecialty} specialist cannot return external-web evidence`);
    }

    const key = citation.source_kind === "human_input"
      ? `human_input:${citation.source_id}`
      : `${citation.source_kind}:${citation.source_id}:${citation.chunk_id}`;
    if (!allowedSources.has(key)) {
      throw new Error(`specialist artifact citation is outside the pinned run snapshot: ${key}`);
    }
  }
}

export function validateOwnershipArtifactScope(
  artifact: SpecialistArtifact,
  input: OwnershipTaskInput,
  task: Task,
  allowedAgent: AllowedAgent,
): void {
  validateSpecialistArtifactScope(artifact, input, task, allowedAgent, "ownership");
}

export function validatePublicResearchArtifactScope(
  artifact: SpecialistArtifact,
  input: PublicResearchTaskInput,
  task: Task,
  allowedAgent: AllowedAgent,
): void {
  if (artifact.analysis_run_id !== input.analysis_run_id) {
    throw new Error("public-research artifact references a different analysis run");
  }
  if (artifact.task_id !== task.id || artifact.context_id !== task.contextId) {
    throw new Error("public-research artifact task provenance does not match the A2A task");
  }
  if (artifact.agent.name !== allowedAgent.name || artifact.agent.version !== allowedAgent.version) {
    throw new Error("public-research artifact agent identity does not match the allowlisted card");
  }
  if (artifact.specialty !== "public_research") {
    throw new Error(`public-research dispatch received ${artifact.specialty}`);
  }

  const allowedEvidence = new Set(input.web_evidence.map((evidence) =>
    `${evidence.search_execution_id}:${evidence.canonical_url}:${evidence.content_hash}`));
  for (const citation of artifact.citations) {
    if (citation.source_kind !== "external_web") {
      throw new Error("public-research specialist may only cite stored external-web evidence");
    }
    const key = `${citation.search_execution_id}:${citation.canonical_url}:${citation.content_hash}`;
    if (!allowedEvidence.has(key)) {
      throw new Error(`public-research citation is outside the approved stored evidence: ${key}`);
    }
  }
}

export interface SpecialistDispatchRequest<T> {
  allowedAgent: AllowedAgent;
  input: T;
  correlationId: string;
  messageId: string;
  authorizationToken: string;
  timeoutMs?: number;
  maxAttempts?: number;
  fetchImpl?: typeof fetch;
}

export type OwnershipDispatchRequest = SpecialistDispatchRequest<OwnershipTaskInput>;
export type EntityDispatchRequest = SpecialistDispatchRequest<EntityTaskInput>;
export type PolicyDispatchRequest = SpecialistDispatchRequest<PolicyTaskInput>;
export type PublicResearchDispatchRequest = SpecialistDispatchRequest<PublicResearchTaskInput>;

export interface SpecialistDispatchResult {
  taskId: string;
  contextId: string;
  correlationId: string;
  messageId: string;
  attempts: number;
  artifact: SpecialistArtifact;
}

export type OwnershipDispatchResult = SpecialistDispatchResult;

export class SpecialistDispatchError extends Error {
  readonly specialty: SpecialistSpecialty;
  readonly attempts: number;
  readonly taskId: string;
  readonly contextId: string;

  constructor(input: {
    specialty: SpecialistSpecialty;
    attempts: number;
    messageId: string;
    taskId?: string;
    contextId?: string;
    cause: unknown;
  }) {
    super(`${input.specialty} specialist failed after ${input.attempts} attempts`, {
      cause: input.cause,
    });
    this.name = "SpecialistDispatchError";
    this.specialty = input.specialty;
    this.attempts = input.attempts;
    this.taskId = input.taskId ?? `failed-dispatch:${input.messageId}`;
    this.contextId = input.contextId ?? `failed-context:${input.messageId}`;
  }
}

async function dispatchSpecialistTask<T>(
  request: SpecialistDispatchRequest<T>,
  inputSchema: ZodType<T>,
  specialty: SpecialistSpecialty,
  validateScope: (
    artifact: SpecialistArtifact,
    input: T,
    task: Task,
    allowedAgent: AllowedAgent,
  ) => void,
): Promise<SpecialistDispatchResult> {
  const input = inputSchema.parse(request.input);
  const timeoutMs = request.timeoutMs ?? 2_000;
  const maxAttempts = request.maxAttempts ?? 2;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) {
    throw new Error("maxAttempts must be an integer from 1 to 3");
  }

  const fetchImpl = request.fetchImpl ?? fetch;
  const agentCard = await resolveAllowlistedAgent(request.allowedAgent, {
    fetchImpl,
    timeoutMs,
  });
  const client = await new ClientFactory({
    transports: [new JsonRpcTransportFactory({ fetchImpl })],
    preferredTransports: ["JSONRPC"],
  }).createFromAgentCard(agentCard);
  const sendRequest = {
    tenant: "",
    message: {
      messageId: request.messageId,
      contextId: "",
      taskId: "",
      role: Role.ROLE_USER,
      parts: [{
        content: { $case: "data" as const, value: input },
        metadata: { schema_version: "1.0" },
        filename: "",
        mediaType: "application/json",
      }],
      metadata: { correlation_id: request.correlationId },
      extensions: [],
      referenceTaskIds: [],
    },
    configuration: {
      acceptedOutputModes: ["application/json"],
      taskPushNotificationConfig: undefined,
      returnImmediately: false,
    },
    metadata: { correlation_id: request.correlationId },
  };

  let lastError: unknown;
  let lastTaskId: string | undefined;
  let lastContextId: string | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await client.sendMessage(sendRequest, {
        signal: AbortSignal.timeout(timeoutMs),
        serviceParameters: {
          Authorization: `Bearer ${request.authorizationToken}`,
        },
      });
      if (!isTask(result)) {
        throw new Error("specialist returned a message instead of a stateful A2A task");
      }
      lastTaskId = result.id;
      lastContextId = result.contextId;
      if (result.status?.state !== TaskState.TASK_STATE_COMPLETED) {
        throw new Error(`specialist task did not complete: ${result.status?.state ?? "missing status"}`);
      }

      const artifact = parseSpecialistArtifact(artifactData(result));
      validateScope(artifact, input, result, request.allowedAgent);
      return {
        taskId: result.id,
        contextId: result.contextId,
        correlationId: request.correlationId,
        messageId: request.messageId,
        attempts: attempt,
        artifact,
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw new SpecialistDispatchError({
    specialty,
    attempts: maxAttempts,
    messageId: request.messageId,
    ...(lastTaskId === undefined ? {} : { taskId: lastTaskId }),
    ...(lastContextId === undefined ? {} : { contextId: lastContextId }),
    cause: lastError,
  });
}

export function dispatchOwnershipTask(
  request: OwnershipDispatchRequest,
): Promise<SpecialistDispatchResult> {
  return dispatchSpecialistTask(request, ownershipTaskInputSchema, "ownership", validateOwnershipArtifactScope);
}

export function dispatchEntityTask(
  request: EntityDispatchRequest,
): Promise<SpecialistDispatchResult> {
  return dispatchSpecialistTask(request, entityTaskInputSchema, "entity", (artifact, input, task, agent) =>
    validateSpecialistArtifactScope(artifact, input, task, agent, "entity"));
}

export function dispatchPolicyTask(
  request: PolicyDispatchRequest,
): Promise<SpecialistDispatchResult> {
  return dispatchSpecialistTask(request, policyTaskInputSchema, "policy", (artifact, input, task, agent) =>
    validateSpecialistArtifactScope(artifact, input, task, agent, "policy"));
}

export function dispatchPublicResearchTask(
  request: PublicResearchDispatchRequest,
): Promise<SpecialistDispatchResult> {
  return dispatchSpecialistTask(
    request,
    publicResearchTaskInputSchema,
    "public_research",
    validatePublicResearchArtifactScope,
  );
}

export class ArtifactIngestor {
  private readonly acceptedByDispatch = new Map<string, string>();

  ingest(dispatchId: string, artifact: SpecialistArtifact): "stored" | "duplicate" {
    const serialized = JSON.stringify(artifact);
    const accepted = this.acceptedByDispatch.get(dispatchId);
    if (accepted === undefined) {
      this.acceptedByDispatch.set(dispatchId, serialized);
      return "stored";
    }
    if (accepted === serialized) {
      return "duplicate";
    }

    throw new Error(`dispatch ${dispatchId} produced conflicting artifacts`);
  }
}
