import path from "node:path";

import { Pool } from "pg";
import { createModelClient } from "@/src/api/model-client";

import { LangflowWorkflowClient } from "@/src/workflow/langflow-client";
import { OpenAICaseAssistantAgent } from "@/src/api/assistant-agent";
import { PostgresAssistantRepository } from "@/src/api/assistant-repository";
import { CohereRetrievalClient } from "@/src/api/cohere-retrieval";
import { CaseAssistantService } from "@/src/api/assistant-service";
import { createApiHandler } from "@/src/api/http";
import { PostgresCaseRepository } from "@/src/api/repository";
import { CaseApiService } from "@/src/api/service";
import { PostgresAssessmentRepository } from "@/src/policy/assessment-repository";
import { PolicyAssessmentService } from "@/src/policy/assessment-service";
import { OpenAIPolicyAssessmentExtractor } from "@/src/policy/openai-extractor";
import { DocumentFactService, OpenAIDocumentFactExtractor } from "@/src/facts/extraction-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ApiRuntime = {
  version: 23;
  handler: ReturnType<typeof createApiHandler>;
};

const globalRuntime = globalThis as typeof globalThis & {
  jeenApiRuntime?: ApiRuntime;
};

function createRuntime(): ApiRuntime {
  const databaseUrl = process.env.DATABASE_URL ?? "postgresql://jeen:jeen_dev@localhost:5432/jeen";
  const langflowUrl = process.env.LANGFLOW_SERVER_URL ?? "http://localhost:7860";
  const langflowApiKey = process.env.LANGFLOW_API_KEY ?? "";
  const coordinatorFlowId = process.env.LANGFLOW_COORDINATOR_FLOW_ID ?? process.env.LANGFLOW_FLOW_ID ?? "";
  const legacyCoordinatorFlowId = process.env.LANGFLOW_LEGACY_COORDINATOR_FLOW_ID;
  const ingestionFlowId = process.env.LANGFLOW_INGESTION_FLOW_ID;
  const ingestionFileNodeId = process.env.LANGFLOW_INGESTION_FILE_NODE_ID;
  const ingestionGuardNodeId = process.env.LANGFLOW_INGESTION_GUARD_NODE_ID;

  if (!langflowApiKey || !coordinatorFlowId) {
    throw new Error("LANGFLOW_API_KEY and LANGFLOW_COORDINATOR_FLOW_ID (or LANGFLOW_FLOW_ID) are required");
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 10 });
  const assistantRepository = new PostgresAssistantRepository(pool);
  const assistantModel = process.env.OPENAI_ASSISTANT_MODEL;
  const cohereRetrieval = process.env.COHERE_API_KEY
    ? new CohereRetrievalClient(process.env.COHERE_API_KEY)
    : undefined;
  const assistantAgent = process.env.OPENAI_API_KEY && assistantModel
    ? new OpenAICaseAssistantAgent(
      createModelClient(process.env.OPENAI_API_KEY),
      assistantModel,
      assistantRepository,
      cohereRetrieval,
    )
    : null;
  const assistant = new CaseAssistantService(assistantRepository, assistantAgent);
  const policyModel = process.env.OPENAI_POLICY_MODEL;
  const policyExtractor = process.env.OPENAI_API_KEY && policyModel
    ? new OpenAIPolicyAssessmentExtractor(
      createModelClient(process.env.OPENAI_API_KEY),
      policyModel,
    )
    : null;
  const policyAssessments = new PolicyAssessmentService(
    new PostgresAssessmentRepository(pool),
    policyExtractor,
  );
  const factModel = process.env.OPENAI_FACT_MODEL ?? policyModel;
  const factExtractor = process.env.OPENAI_API_KEY && factModel
    ? new OpenAIDocumentFactExtractor(
      createModelClient(process.env.OPENAI_API_KEY),
      factModel,
    )
    : null;
  const documentFacts = new DocumentFactService(pool, factExtractor);
  const workflow = new LangflowWorkflowClient({
    serverUrl: langflowUrl,
    apiKey: langflowApiKey,
    timeoutMs: 60_000,
  });
  const repository = new PostgresCaseRepository(pool);
  const service = new CaseApiService(repository, workflow, {
    coordinatorFlowId,
    ...(legacyCoordinatorFlowId ? { legacyCoordinatorFlowId } : {}),
    ...(ingestionFlowId ? { ingestionFlowId } : {}),
    ...(ingestionFileNodeId ? { ingestionFileNodeId } : {}),
    ...(ingestionGuardNodeId ? { ingestionGuardNodeId } : {}),
  });
  return {
    version: 23,
    handler: createApiHandler({
      service,
      assistant,
      policyAssessments,
      documentFacts,
      storageRoot: path.resolve(process.env.EVIDENCE_STORAGE_DIR ?? "data/evidence"),
    }),
  };
}

function apiHandler(request: Request): Promise<Response> {
  const runtime = globalRuntime.jeenApiRuntime?.version === 23
    ? globalRuntime.jeenApiRuntime
    : createRuntime();
  globalRuntime.jeenApiRuntime = runtime;
  return runtime.handler(request);
}

export {
  apiHandler as GET,
  apiHandler as POST,
  apiHandler as PUT,
  apiHandler as PATCH,
  apiHandler as DELETE,
};
