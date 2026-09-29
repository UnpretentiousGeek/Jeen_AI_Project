import { createServer, type IncomingMessage } from "node:http";
import path from "node:path";

import { Pool } from "pg";
import { createModelClient } from "./model-client.ts";

import { LangflowWorkflowClient } from "../workflow/langflow-client.ts";
import { OpenAICaseAssistantAgent } from "./assistant-agent.ts";
import { PostgresAssistantRepository } from "./assistant-repository.ts";
import { CohereRetrievalClient } from "./cohere-retrieval.ts";
import { CaseAssistantService } from "./assistant-service.ts";
import { createApiHandler } from "./http.ts";
import { PostgresCaseRepository } from "./repository.ts";
import { CaseApiService } from "./service.ts";
import { PostgresAssessmentRepository } from "../policy/assessment-repository.ts";
import { PolicyAssessmentService } from "../policy/assessment-service.ts";
import { OpenAIPolicyAssessmentExtractor } from "../policy/openai-extractor.ts";
import { DocumentFactService, OpenAIDocumentFactExtractor } from "../facts/extraction-service.ts";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.API_HOST ?? "127.0.0.1";
const databaseUrl = process.env.DATABASE_URL ?? "postgresql://jeen:jeen_dev@localhost:5432/jeen";
const langflowUrl = process.env.LANGFLOW_SERVER_URL ?? "http://localhost:7860";
const langflowApiKey = process.env.LANGFLOW_API_KEY ?? "";
const coordinatorFlowId = process.env.LANGFLOW_COORDINATOR_FLOW_ID ?? process.env.LANGFLOW_FLOW_ID ?? "";
const legacyCoordinatorFlowId = process.env.LANGFLOW_LEGACY_COORDINATOR_FLOW_ID;
const ingestionFlowId = process.env.LANGFLOW_INGESTION_FLOW_ID;
const ingestionFileNodeId = process.env.LANGFLOW_INGESTION_FILE_NODE_ID;
const ingestionGuardNodeId = process.env.LANGFLOW_INGESTION_GUARD_NODE_ID;
const storageRoot = path.resolve(process.env.EVIDENCE_STORAGE_DIR ?? "data/evidence");

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
const handleApi = createApiHandler({ service, assistant, policyAssessments, documentFacts, storageRoot });

async function readBody(request: IncomingMessage, maxBytes = 25 * 1024 * 1024): Promise<Buffer> {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (declared > maxBytes) throw new Error("request_too_large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new Error("request_too_large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

const server = createServer(async (incoming, outgoing) => {
  try {
    const url = new URL(incoming.url ?? "/", `http://${incoming.headers.host ?? `localhost:${port}`}`);
    if (url.pathname.startsWith("/api/")) {
      const body = incoming.method === "GET" || incoming.method === "HEAD"
        ? undefined
        : await readBody(incoming);
      const requestInit: RequestInit = {
        method: incoming.method ?? "GET",
        headers: incoming.headers as HeadersInit,
      };
      if (body) requestInit.body = Uint8Array.from(body).buffer;
      const request = new Request(url, requestInit);
      const response = await handleApi(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    outgoing.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    outgoing.end(JSON.stringify({
      error: { code: "not_found", message: "Endpoint not found." },
    }));
  } catch (error) {
    const status = error instanceof Error && error.message === "request_too_large" ? 413 : 500;
    outgoing.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    outgoing.end(JSON.stringify({
      error: {
        code: status === 413 ? "request_too_large" : "internal_error",
        message: status === 413
          ? "The upload is too large. Upload no more than 25 MB at once."
          : "Unable to serve the request.",
      },
    }));
  }
});

server.listen(port, host, () => {
  process.stdout.write(`Jeen API listening on http://${host}:${port}\n`);
});

async function shutdown(): Promise<void> {
  server.close();
  await pool.end();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
