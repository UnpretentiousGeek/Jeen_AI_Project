import { readFile } from "node:fs/promises";
import { posix as posixPath } from "node:path";
import { z } from "zod";

const workflowStatusSchema = z.enum([
  "queued",
  "in_progress",
  "suspended",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

/** Job ended without completing; the owning analysis run must stop. */
export const TERMINAL_UNSUCCESSFUL_JOB_STATUSES: ReadonlySet<string> = new Set([
  "failed",
  "cancelled",
  "timed_out",
]);

const backgroundJobSchema = z.object({
  flow_id: z.string().min(1),
  job_id: z.string().min(1),
  object: z.literal("job"),
  status: workflowStatusSchema,
  links: z.object({
    status: z.string().min(1),
    events: z.string().min(1),
    stop: z.string().min(1),
  }),
}).passthrough();

const workflowStatusResponseSchema = z.object({
  flow_id: z.string().min(1),
  job_id: z.string().min(1),
  object: z.enum(["job", "response"]),
  status: workflowStatusSchema,
  failure_reason: z.string().max(240).nullable().optional(),
}).passthrough();

function safeFailureReason(value: unknown): string {
  if (typeof value !== "string") return "Langflow workflow execution failed.";
  if (/EasyOCR is not installed/i.test(value)) {
    return "Langflow's document reader needs EasyOCR, or OCR must be disabled for text-based files.";
  }
  if (/Policy contribution content differs from the deterministically retrieved matrix/i.test(value)) {
    return "Policy specialist output did not match the retrieved policy matrix.";
  }
  if (/Error building Component Validate Policy Contribution/i.test(value)) {
    return "Policy specialist output could not be validated.";
  }
  if (/No module named ['"]docling|cannot import docling/i.test(value)) {
    return "Langflow document reader is missing Docling.";
  }
  if (/IndentationError|SyntaxError|Invalid Python code/i.test(value)) {
    return "A Langflow component has invalid Python code.";
  }
  if (/citation references (?:case|policy) evidence outside the analysis run|final citations are out of scope/i
    .test(value)) {
    return "Coordinator cited evidence that is outside this analysis run.";
  }
  // Our own PostgreSQL guards raise fixed plain-word messages; anything carrying
  // digits, quotes, paths, or identifiers is not ours and stays hidden.
  const guard = /\(psycopg2\.errors\.[A-Za-z]+\) ([A-Za-z][A-Za-z ,_-]{4,160}?)\s*$/.exec(value);
  if (guard) {
    return `Database rejected a workflow update: ${guard[1]}.`;
  }
  if (/Expecting value: line 1 column 1|not valid JSON|JSONDecodeError/i.test(value)) {
    return "A connected Langflow tool returned invalid JSON.";
  }
  const tool = /^tool ([a-z][a-z0-9_]{0,63}) response (?:failed|returned invalid JSON)/.exec(value);
  if (tool) {
    return `Langflow tool ${tool[1]} failed.`;
  }
  return "Langflow workflow execution failed.";
}

function isSimplePathSegment(value: string): boolean {
  return value.length > 0
    && value !== "."
    && value !== ".."
    && posixPath.basename(value) === value
    && !/[\\/\u0000-\u001f\u007f]/u.test(value);
}

function langflowCachedFilename(flowId: string, storagePath: string): string {
  if (!isSimplePathSegment(flowId)) {
    throw new Error("Langflow flow id must be a simple path segment");
  }
  if (!posixPath.isAbsolute(storagePath)
    || storagePath.includes("\\")
    || posixPath.normalize(storagePath) !== storagePath) {
    throw new Error("Langflow file path must be an absolute normalized path");
  }

  const [cacheRoot, cacheDirectory, cachedFlowId, filename] = storagePath.split("/").slice(-4);
  if (cacheRoot !== ".langflow"
    || cacheDirectory !== "cache"
    || cachedFlowId !== flowId
    || typeof filename !== "string"
    || !isSimplePathSegment(filename)) {
    throw new Error("Langflow file path must identify a file in the specified flow cache");
  }
  return filename;
}

const resumeResponseSchema = z.object({
  job_id: z.string().min(1),
  message: z.string(),
  status: z.string().min(1),
}).passthrough();

const pendingWorkflowSchema = z.object({
  job_id: z.string().min(1),
  flow_id: z.string().min(1),
  session_id: z.string().min(1).nullable(),
  request_id: z.string().min(1),
  kind: z.string().min(1),
  prompt: z.string().nullable(),
  options: z.array(z.object({
    action_id: z.string().min(1),
    label: z.string().min(1),
  }).passthrough()),
  allowed_decisions: z.array(z.string().min(1)),
}).passthrough();

export type LangflowBackgroundJob = z.infer<typeof backgroundJobSchema>;
export type LangflowWorkflowStatus = z.infer<typeof workflowStatusResponseSchema>;
export type LangflowResumeResponse = z.infer<typeof resumeResponseSchema>;
export type LangflowPendingWorkflow = z.infer<typeof pendingWorkflowSchema>;

export interface WorkflowCheckpointClient {
  resume(input: {
    jobId: string;
    requestId: string;
    actionId: string;
  }): Promise<LangflowResumeResponse>;
}

export interface WorkflowProgressClient extends WorkflowCheckpointClient {
  status(jobId: string): Promise<LangflowWorkflowStatus>;
  pending(flowId: string): Promise<LangflowPendingWorkflow[]>;
}

/** Langflow answered, but refused the request; carries its status and reason for the analyst. */
export class WorkflowRejectedError extends Error {
  constructor(readonly status: number, readonly detail: string) {
    super(`Langflow Workflow API request failed with HTTP ${status}${detail ? `: ${detail}` : ""}`);
    this.name = "WorkflowRejectedError";
  }
}

export class LangflowWorkflowClient implements WorkflowCheckpointClient {
  private readonly baseUrl: string;

  constructor(private readonly options: {
    serverUrl: string;
    apiKey: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  }) {
    const url = new URL(options.serverUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Langflow server URL must use HTTP or HTTPS");
    }
    this.baseUrl = url.href.replace(/\/$/, "");
  }

  /** Every Langflow call goes through here, so an unreachable or unresponsive server is reported
   * as `workflow_unavailable` instead of a raw network error. */
  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await (this.options.fetchImpl ?? fetch)(url, {
        ...init,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 60_000),
      });
    } catch {
      throw new Error("workflow_unavailable");
    }
  }

  private fetchResponse(path: string, init: RequestInit): Promise<Response> {
    return this.send(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        "x-api-key": this.options.apiKey,
        ...init.headers,
      },
    });
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const response = await this.fetchResponse(path, init);
    if (!response.ok) {
      // Keep Langflow's own reason: without it, a refused request is indistinguishable from a crash.
      const detail = (await response.text().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 300);
      throw new WorkflowRejectedError(response.status, detail);
    }
    return response.json();
  }

  async uploadFile(input: {
    flowId: string;
    storagePath: string;
    filename: string;
    mimeType: string;
  }): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([await readFile(input.storagePath)], {
      type: input.mimeType,
    }), input.filename);
    const response = await this.send(
      `${this.baseUrl}/api/v1/files/upload/${encodeURIComponent(input.flowId)}`,
      { method: "POST", headers: { "x-api-key": this.options.apiKey }, body: form },
    );
    if (!response.ok) {
      throw new Error(`Langflow file upload failed with HTTP ${response.status}`);
    }
    return z.object({ file_path: z.string().min(1) }).parse(await response.json()).file_path;
  }

  async deleteFile(input: {
    flowId: string;
    storagePath: string;
  }): Promise<void> {
    const filename = langflowCachedFilename(input.flowId, input.storagePath);
    const response = await this.send(
      `${this.baseUrl}/api/v1/files/delete/${encodeURIComponent(input.flowId)}/${encodeURIComponent(filename)}`,
      { method: "DELETE", headers: { "x-api-key": this.options.apiKey } },
    );
    if (response.status === 404) return;
    if (!response.ok) {
      throw new Error(`Langflow file deletion failed with HTTP ${response.status}`);
    }
  }

  async startBackground(input: {
    flowId: string;
    inputValue: string;
    sessionId: string;
    tweaks?: Record<string, unknown>;
    idempotencyKey?: string;
  }): Promise<LangflowBackgroundJob> {
    const body = await this.request("/api/v2/workflows", {
      method: "POST",
      body: JSON.stringify({
        flow_id: input.flowId,
        input_value: input.inputValue,
        session_id: input.sessionId,
        mode: "background",
        ...(input.idempotencyKey === undefined
          ? {}
          : { idempotency_key: input.idempotencyKey }),
        ...(input.tweaks === undefined ? {} : { tweaks: input.tweaks }),
      }),
    });
    return backgroundJobSchema.parse(body);
  }

  async status(jobId: string): Promise<LangflowWorkflowStatus> {
    const response = await this.fetchResponse(
      `/api/v2/workflows?job_id=${encodeURIComponent(jobId)}`,
      { method: "GET" },
    );
    if (response.status === 500) {
      const body = await response.json().catch(() => null);
      const detail = body && typeof body === "object" && "detail" in body ? body.detail : null;
      if (detail && typeof detail === "object" && "code" in detail
        && detail.code === "JOB_FAILED" && "job_id" in detail && detail.job_id === jobId) {
        const errorDetail = "error_detail" in detail ? detail.error_detail : null;
        const data = errorDetail && typeof errorDetail === "object" && "data" in errorDetail
          ? errorDetail.data : null;
        const flowId = data && typeof data === "object" && "flow_id" in data
          ? data.flow_id : null;
        const errorText = data && typeof data === "object" && "text" in data
          ? data.text : null;
        if (typeof flowId === "string" && flowId) {
          return workflowStatusResponseSchema.parse({
            flow_id: flowId, job_id: jobId, object: "job", status: "failed",
            failure_reason: safeFailureReason(errorText),
          });
        }
      }
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 300);
      throw new WorkflowRejectedError(response.status, detail);
    }
    return workflowStatusResponseSchema.parse(await response.json());
  }

  async pending(flowId: string): Promise<LangflowPendingWorkflow[]> {
    const body = await this.request(
      `/api/v2/workflows/pending?flow_id=${encodeURIComponent(flowId)}`,
      { method: "GET" },
    );
    return z.array(pendingWorkflowSchema).parse(body);
  }

  async resume(input: {
    jobId: string;
    requestId: string;
    actionId: string;
  }): Promise<LangflowResumeResponse> {
    const body = await this.request(
      `/api/v2/workflows/${encodeURIComponent(input.jobId)}/resume`,
      {
        method: "POST",
        body: JSON.stringify({
          request_id: input.requestId,
          decision: { action_id: input.actionId },
        }),
      },
    );
    return resumeResponseSchema.parse(body);
  }
}
